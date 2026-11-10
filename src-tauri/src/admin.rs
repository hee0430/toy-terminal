//! 관리자 권한으로 로컬 셸 실행.
//!
//! 일반 권한 프로세스는 자기 PTY를 승격할 수 없다. 그래서
//!   1) 앱이 127.0.0.1 임의 포트에 서버를 열고
//!   2) PowerShell `Start-Process -Verb RunAs`로 자기 자신(exe)을 `--admin-helper`로 승격 실행하면(UAC 창)
//!   3) 승격된 도우미가 서버로 접속해서 셸 PTY를 만들고 입출력을 프레임으로 중계한다.
//! 도우미가 클라이언트이므로, 다른 프로세스가 도우미 포트에 붙어 관리자 셸을 얻을 수 없다.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::atomic::Ordering;
use std::time::Duration;

use tauri::{AppHandle, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

use crate::{emit_closed, emit_output, AppState, Session};

const T_HELLO: u8 = 0;
const T_DATA: u8 = 1;
const T_RESIZE: u8 = 2;
const T_EXIT: u8 = 3;
const MAX_FRAME: usize = 1 << 20;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const ALLOWED_SHELLS: [&str; 3] = ["pwsh", "powershell", "cmd"];

pub enum Input {
    Data(Vec<u8>),
    Resize(u16, u16),
}

pub struct AdminSession {
    tx: UnboundedSender<Input>,
}

impl AdminSession {
    pub fn write(&self, data: Vec<u8>) -> Result<(), String> {
        self.tx.send(Input::Data(data)).map_err(|e| e.to_string())
    }
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.tx.send(Input::Resize(cols, rows)).map_err(|e| e.to_string())
    }
}

fn new_token() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("OS 난수 생성 실패");
    b.iter().map(|x| format!("{x:02x}")).collect()
}

// ---------- 프레임: [type u8][len u32 BE][payload] ----------

async fn read_frame(r: &mut (impl AsyncReadExt + Unpin)) -> std::io::Result<(u8, Vec<u8>)> {
    let mut h = [0u8; 5];
    r.read_exact(&mut h).await?;
    let len = u32::from_be_bytes([h[1], h[2], h[3], h[4]]) as usize;
    if len > MAX_FRAME {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut p = vec![0u8; len];
    r.read_exact(&mut p).await?;
    Ok((h[0], p))
}

async fn write_frame(w: &mut (impl AsyncWriteExt + Unpin), t: u8, p: &[u8]) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(5 + p.len());
    buf.push(t);
    buf.extend_from_slice(&(p.len() as u32).to_be_bytes());
    buf.extend_from_slice(p);
    w.write_all(&buf).await
}

fn read_frame_sync(r: &mut impl Read) -> std::io::Result<(u8, Vec<u8>)> {
    let mut h = [0u8; 5];
    r.read_exact(&mut h)?;
    let len = u32::from_be_bytes([h[1], h[2], h[3], h[4]]) as usize;
    if len > MAX_FRAME {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut p = vec![0u8; len];
    r.read_exact(&mut p)?;
    Ok((h[0], p))
}

fn write_frame_sync(w: &mut impl Write, t: u8, p: &[u8]) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(5 + p.len());
    buf.push(t);
    buf.extend_from_slice(&(p.len() as u32).to_be_bytes());
    buf.extend_from_slice(p);
    w.write_all(&buf)?;
    w.flush()
}

// ---------- 앱(서버) 쪽 ----------

#[tauri::command]
pub async fn open_local_admin(
    app: AppHandle,
    state: State<'_, AppState>,
    shell: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    if !ALLOWED_SHELLS.contains(&shell.as_str()) {
        return Err("관리자 실행은 pwsh / powershell / cmd 만 지원합니다".into());
    }

    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token = new_token();
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;

    // 모든 값이 공백 없는 토큰/숫자/허용목록 문자열이라 인용 문제가 없다. exe 경로만 따옴표 처리.
    let ps = format!(
        "Start-Process -FilePath '{}' -ArgumentList '--admin-helper','--port','{port}','--token','{token}','--shell','{shell}','--cols','{cols}','--rows','{rows}' -Verb RunAs -WindowStyle Hidden -ErrorAction Stop",
        exe.display().to_string().replace('\'', "''"),
    );
    let mut launcher = tokio::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
        .creation_flags(CREATE_NO_WINDOW)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("권한 상승 실행 실패: {e}"))?;

    // 토큰을 보낸 첫 연결만 도우미로 인정한다. 헬로를 안 보내는 연결이 막지 못하도록 5초 제한.
    let accept = async {
        loop {
            let (mut s, _) = listener.accept().await?;
            if let Ok(Ok((T_HELLO, p))) = tokio::time::timeout(Duration::from_secs(5), read_frame(&mut s)).await {
                if p == token.as_bytes() {
                    return std::io::Result::Ok(s);
                }
            }
        }
    };
    tokio::pin!(accept);
    let deadline = tokio::time::sleep(Duration::from_secs(120));
    tokio::pin!(deadline);

    let mut launcher_done = false;
    let stream = loop {
        tokio::select! {
            r = &mut accept => break r.map_err(|e| e.to_string())?,
            // Start-Process는 승격 프로세스를 띄운 직후 성공(0)으로 끝난다. 실패(UAC 취소 등)일 때만 중단.
            st = launcher.wait(), if !launcher_done => {
                launcher_done = true;
                if !st.map_err(|e| e.to_string())?.success() {
                    return Err("관리자 권한 승인이 취소되었거나 실행에 실패했습니다".into());
                }
            }
            _ = &mut deadline => return Err("관리자 셸 연결 시간 초과 (UAC 승인 대기 120초)".into()),
        }
    };

    let (mut rd, mut wr) = stream.into_split();
    let id = format!("t{}", state.next_id.fetch_add(1, Ordering::SeqCst));
    let (tx, mut rx) = unbounded_channel::<Input>();
    state.sessions.lock().unwrap().insert(id.clone(), Session::Admin(AdminSession { tx }));

    // 읽기/쓰기를 별도 task로 나눈다. read_exact는 select!에서 취소되면 프레임이 깨진다.
    let (app2, id2) = (app.clone(), id.clone());
    tauri::async_runtime::spawn(async move {
        loop {
            match read_frame(&mut rd).await {
                Ok((T_DATA, p)) => emit_output(&app2, &id2, &p),
                Ok((T_EXIT, _)) | Err(_) => break,
                Ok(_) => {}
            }
        }
        emit_closed(&app2, &id2);
    });
    tauri::async_runtime::spawn(async move {
        while let Some(input) = rx.recv().await {
            let r = match input {
                Input::Data(d) => write_frame(&mut wr, T_DATA, &d).await,
                Input::Resize(c, r) => {
                    let mut p = [0u8; 4];
                    p[..2].copy_from_slice(&c.to_be_bytes());
                    p[2..].copy_from_slice(&r.to_be_bytes());
                    write_frame(&mut wr, T_RESIZE, &p).await
                }
            };
            if r.is_err() {
                break;
            }
        }
        // 세션이 제거되면 여기로 온다. 소켓을 닫으면 도우미가 셸을 종료한다.
        let _ = wr.shutdown().await;
    });

    Ok(id)
}

// ---------- 승격된 도우미 쪽 (Tauri 없이 동작) ----------

pub fn run_helper(args: &[String]) -> i32 {
    let get = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let (Some(port), Some(token), Some(shell)) = (
        get("--port").and_then(|v| v.parse::<u16>().ok()),
        get("--token"),
        get("--shell"),
    ) else {
        return 2;
    };
    // 서버가 무엇을 보내도 허용 목록 밖의 프로그램은 실행하지 않는다.
    if !ALLOWED_SHELLS.contains(&shell.as_str()) {
        return 2;
    }
    let cols = get("--cols").and_then(|v| v.parse().ok()).unwrap_or(80);
    let rows = get("--rows").and_then(|v| v.parse().ok()).unwrap_or(24);

    let Ok(mut sock) = TcpStream::connect(("127.0.0.1", port)) else { return 3 };
    if write_frame_sync(&mut sock, T_HELLO, token.as_bytes()).is_err() {
        return 3;
    }
    let Ok((mut pty, mut reader)) = crate::local::spawn(&shell, cols, rows) else { return 4 };
    let Ok(mut out) = sock.try_clone() else { return 3 };

    // PTY 출력 -> 소켓. 셸이 끝나면 종료 프레임을 보내고 프로세스를 끝낸다.
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if write_frame_sync(&mut out, T_DATA, &buf[..n]).is_err() {
                        std::process::exit(0);
                    }
                }
            }
        }
        let _ = write_frame_sync(&mut out, T_EXIT, &[]);
        std::process::exit(0);
    });

    // 소켓 입력 -> PTY. 소켓이 닫히면(탭 종료/앱 종료) 반환하며 PTY가 drop되어 셸이 종료된다.
    while let Ok((t, p)) = read_frame_sync(&mut sock) {
        match t {
            T_DATA => {
                if pty.write(&p).is_err() {
                    break;
                }
            }
            T_RESIZE if p.len() == 4 => {
                let _ = pty.resize(u16::from_be_bytes([p[0], p[1]]), u16::from_be_bytes([p[2], p[3]]));
            }
            _ => {}
        }
    }
    0
}
