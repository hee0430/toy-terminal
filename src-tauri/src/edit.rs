//! SFTP 파일 편집: 임시 폴더에 내려받아 편집기로 열고, 저장하면 자동으로 서버에 올린다.
//! 임시 파일은 `%TEMP%\toyterm-edit\<탭 id>\<난수>\<파일 이름>`에 두고, 탭을 닫거나 앱을 시작할 때 지운다.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::oneshot;

use crate::{sftp, AppState};

const MAX_EDIT_BYTES: u64 = 5 * 1024 * 1024;
const POLL: Duration = Duration::from_secs(1);

/// 탭 하나에서 편집 중인 파일 하나. 탭을 닫으면 감시를 멈추고 임시 폴더를 지운다.
pub struct EditHandle {
    cancel: Arc<AtomicBool>,
}

fn root_dir() -> PathBuf {
    std::env::temp_dir().join("toyterm-edit")
}

/// 임시 편집 파일을 모두 지운다. 앱을 시작할 때(지난번에 남은 것)와 끝낼 때(편집기를 열어 둔 채 종료한 경우) 부른다.
/// 편집기가 파일을 잡고 있으면 Windows가 지우지 못하는데, 그런 파일은 다음 시작 때 다시 지운다.
pub fn cleanup_stale() {
    let _ = std::fs::remove_dir_all(root_dir());
}

/// 탭 id는 앱이 만드는 `t숫자` 모양만 받는다. 화면이 보낸 값으로 경로를 만들어 폴더를 지우므로,
/// `..`이나 `C:\` 같은 값이 오면 임시 폴더 밖의 엉뚱한 곳을 지울 수 있기 때문이다.
fn valid_tab_id(id: &str) -> bool {
    id.strip_prefix('t').is_some_and(|n| !n.is_empty() && n.len() <= 20 && n.bytes().all(|b| b.is_ascii_digit()))
}

/// 탭을 닫을 때: 감시를 멈추고 그 탭의 임시 파일을 지운다 (편집기가 잡고 있으면 지우지 못해도 무시).
pub fn stop_tab(state: &AppState, id: &str) {
    if !valid_tab_id(id) {
        return; // 앱이 만든 id가 아니다. 경로로 쓰지 않는다.
    }
    if let Some(list) = state.edits.lock().unwrap().remove(id) {
        for h in list {
            h.cancel.store(true, Ordering::SeqCst);
        }
    }
    let _ = std::fs::remove_dir_all(root_dir().join(id));
}

type Stamp = (SystemTime, u64);

fn stamp(p: &Path) -> Option<Stamp> {
    let m = std::fs::metadata(p).ok()?;
    Some((m.modified().ok()?, m.len()))
}

#[derive(Debug, PartialEq)]
enum Step {
    /// 바뀐 것이 없다
    Idle,
    /// 바뀌었다. 한 번 더 같은 값이면(저장이 끝났다는 뜻) 올린다.
    Wait(Stamp),
    Upload(Stamp),
}

/// 편집기는 저장 도중(임시 파일 쓰기, 이름 바꾸기)에 파일이 여러 번 바뀐다. 값이 한 번 더 같아야 올린다.
fn decide(last: Stamp, pending: Option<Stamp>, cur: Stamp) -> Step {
    if cur == last {
        Step::Idle
    } else if pending == Some(cur) {
        Step::Upload(cur)
    } else {
        Step::Wait(cur)
    }
}

/// 앞부분에 NUL 바이트가 없으면 텍스트로 본다 (이진 파일은 거의 항상 NUL을 포함한다).
fn is_text_head(head: &[u8]) -> bool {
    !head.contains(&0)
}

#[derive(Clone, Serialize)]
struct StatusEvent {
    name: String,
    /// 실패하면 원인 (한국어 원문)
    error: Option<String>,
}

#[derive(Clone, Serialize)]
struct ConfirmEvent {
    req: u64,
    name: String,
    /// 내려받은 뒤 서버 파일이 바뀌었는가 (덮어쓰기 경고를 함께 보여 준다)
    conflict: bool,
}

/// 저장이 끝난 파일을 올릴지 화면에 묻는다. 서버 파일이 그사이 바뀌었으면 그 경고를 같이 보여 준다.
async fn ask_upload(app: &AppHandle, name: &str, conflict: bool) -> bool {
    let state = app.state::<AppState>();
    let req = state.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel::<String>();
    state.edit_waiters.lock().unwrap().insert(req, tx);
    if app.emit("sftp-edit-confirm", ConfirmEvent { req, name: name.into(), conflict }).is_err() {
        state.edit_waiters.lock().unwrap().remove(&req);
        return false;
    }
    rx.await.map(|c| c == "upload").unwrap_or(false)
}

/// 화면이 업로드 확인 창에서 고른 값을 돌려준다: "upload" / "cancel"
#[tauri::command]
pub fn edit_answer(state: State<'_, AppState>, req: u64, choice: String) {
    if let Some(tx) = state.edit_waiters.lock().unwrap().remove(&req) {
        let _ = tx.send(choice);
    }
}

/// 임시 파일을 서버에 올린다. Ok(false)는 사용자가 업로드를 거절한 경우.
async fn upload(app: &AppHandle, sftp: &SftpSession, remote: &str, local: &Path, name: &str, baseline: &mut Option<u32>) -> Result<bool, String> {
    let conflict = matches!(sftp.metadata(remote.to_string()).await, Ok(m) if m.mtime != *baseline);
    if !ask_upload(app, name, conflict).await {
        return Ok(false);
    }
    let mut src = tokio::fs::File::open(local).await.map_err(|e| format!("임시 파일을 읽을 수 없습니다: {e}"))?;
    // 지우고 새로 만들지 않고 기존 파일을 덮어써서 서버의 권한과 소유자를 유지한다.
    let mut dst = sftp.create(remote.to_string()).await.map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = src.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
    }
    dst.shutdown().await.map_err(|e| e.to_string())?;
    if let Ok(m) = sftp.metadata(remote.to_string()).await {
        *baseline = m.mtime;
    }
    Ok(true)
}

async fn watch(app: AppHandle, sftp: Arc<SftpSession>, remote: String, local: PathBuf, name: String, mut baseline: Option<u32>, cancel: Arc<AtomicBool>) {
    let Some(mut last) = stamp(&local) else { return };
    let mut pending: Option<Stamp> = None;
    loop {
        tokio::time::sleep(POLL).await;
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        // 편집기가 이름을 바꿔 저장하는 순간에는 파일이 잠깐 없을 수 있다.
        let Some(cur) = stamp(&local) else { continue };
        match decide(last, pending, cur) {
            Step::Idle => pending = None,
            Step::Wait(s) => pending = Some(s),
            Step::Upload(s) => {
                pending = None;
                last = s;
                match upload(&app, &sftp, &remote, &local, &name, &mut baseline).await {
                    Ok(true) => {
                        let _ = app.emit("sftp-edit-status", StatusEvent { name: name.clone(), error: None });
                    }
                    Ok(false) => {}
                    Err(e) => {
                        let _ = app.emit("sftp-edit-status", StatusEvent { name: name.clone(), error: Some(e) });
                    }
                }
            }
        }
    }
}

#[cfg(windows)]
fn hide_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}
#[cfg(not(windows))]
fn hide_window(_cmd: &mut Command) {}

/// 편집기로 연다. 지정한 편집기가 있으면 그것으로, 없으면 Windows가 이 파일 형식의 "편집" 동작에 지정한 프로그램으로,
/// 그것도 없으면 메모장으로 연다. "열기"가 아니라 "편집" 동작만 쓰므로 .bat 같은 파일이 실행되지는 않는다.
async fn open_editor(path: &Path, editor: Option<&str>) -> Result<(), String> {
    let editor = editor.map(str::trim).filter(|s| !s.is_empty());
    if let Some(e) = editor {
        let mut cmd = Command::new(e);
        cmd.arg(path);
        hide_window(&mut cmd);
        return cmd.spawn().map(|_| ()).map_err(|err| format!("편집기를 실행할 수 없습니다 ({e}): {err}"));
    }
    let p = path.to_path_buf();
    let opened = tokio::task::spawn_blocking(move || {
        let mut cmd = Command::new("powershell.exe");
        // 경로는 환경 변수로 넘겨 따옴표 등이 명령으로 해석되지 않게 한다.
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "try { Start-Process -FilePath $env:TOYTERM_EDIT_PATH -Verb Edit -ErrorAction Stop } catch { exit 1 }",
        ])
        .env("TOYTERM_EDIT_PATH", &p);
        hide_window(&mut cmd);
        cmd.status().map(|s| s.success()).unwrap_or(false)
    })
    .await
    .unwrap_or(false);
    if opened {
        return Ok(());
    }
    Command::new("notepad.exe").arg(path).spawn().map(|_| ()).map_err(|e| format!("메모장을 실행할 수 없습니다: {e}"))
}

#[tauri::command]
pub async fn sftp_edit(app: AppHandle, state: State<'_, AppState>, id: String, remote: String, editor: Option<String>) -> Result<(), String> {
    let sftp = sftp::get(&state, &id).await?;
    let meta = sftp.metadata(remote.clone()).await.map_err(|e| e.to_string())?;
    if meta.file_type().is_dir() {
        return Err("폴더는 편집할 수 없습니다".into());
    }
    if meta.size.unwrap_or(0) > MAX_EDIT_BYTES {
        return Err(format!("파일이 너무 큽니다 (최대 {}MB)", MAX_EDIT_BYTES / 1024 / 1024));
    }
    let name = remote.rsplit('/').next().unwrap_or("").to_string();
    if !sftp::safe_name(&name) {
        return Err("파일 이름에 Windows에서 쓸 수 없는 문자가 있어 편집할 수 없습니다".into());
    }

    let mut rnd = [0u8; 8];
    getrandom::fill(&mut rnd).map_err(|e| e.to_string())?;
    let dir = root_dir().join(&id).join(rnd.iter().map(|b| format!("{b:02x}")).collect::<String>());
    tokio::fs::create_dir_all(&dir).await.map_err(|e| format!("임시 폴더를 만들 수 없습니다: {e}"))?;
    let local = dir.join(&name);

    let result: Result<(), String> = async {
        let mut src = sftp.open(remote.clone()).await.map_err(|e| e.to_string())?;
        let mut dst = tokio::fs::File::create(&local).await.map_err(|e| e.to_string())?;
        tokio::io::copy(&mut src, &mut dst).await.map_err(|e| e.to_string())?;
        dst.flush().await.map_err(|e| e.to_string())?;
        let mut head = vec![0u8; 8192];
        let n = tokio::fs::File::open(&local).await.map_err(|e| e.to_string())?.read(&mut head).await.map_err(|e| e.to_string())?;
        if !is_text_head(&head[..n]) {
            return Err("텍스트 파일이 아니라 편집할 수 없습니다".into());
        }
        Ok(())
    }
    .await;
    if let Err(e) = result {
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }

    let cancel = Arc::new(AtomicBool::new(false));
    state.edits.lock().unwrap().entry(id).or_default().push(EditHandle { cancel: cancel.clone() });
    tauri::async_runtime::spawn(watch(app, sftp.clone(), remote, local.clone(), name, meta.mtime, cancel.clone()));

    if let Err(e) = open_editor(&local, editor.as_deref()).await {
        cancel.store(true, Ordering::SeqCst);
        let _ = std::fs::remove_dir_all(&dir);
        return Err(e);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(secs: u64, len: u64) -> Stamp {
        (SystemTime::UNIX_EPOCH + Duration::from_secs(secs), len)
    }

    #[test]
    fn upload_only_after_the_file_settles() {
        let last = at(10, 100);
        // 바뀐 것이 없으면 아무것도 안 한다
        assert_eq!(decide(last, None, last), Step::Idle);
        // 처음 바뀐 것을 보면 기다린다 (편집기가 저장 도중일 수 있다)
        assert_eq!(decide(last, None, at(11, 120)), Step::Wait(at(11, 120)));
        // 저장 도중 또 바뀌면 다시 기다린다
        assert_eq!(decide(last, Some(at(11, 120)), at(11, 150)), Step::Wait(at(11, 150)));
        // 한 번 더 같은 값이면 올린다
        assert_eq!(decide(last, Some(at(11, 120)), at(11, 120)), Step::Upload(at(11, 120)));
    }

    #[test]
    fn tab_id_cannot_point_outside_the_temp_folder() {
        for ok in ["t0", "t1", "t42", "t1234567890"] {
            assert!(valid_tab_id(ok), "{ok:?}");
        }
        // 경로로 쓰이면 위험한 값들: 상위 폴더, 절대 경로, 구분자, 빈 값, 숫자가 아닌 것
        for bad in ["", "t", "..", "../x", "..\\..", "C:\\", "C:/Windows", "/", "\\\\server\\share", "t1/..", "t1\\x", "x1", "T1", "t-1", "t1 ", "t１"] {
            assert!(!valid_tab_id(bad), "{bad:?}");
        }
        assert!(!valid_tab_id(&format!("t{}", "9".repeat(21)))); // 너무 긴 숫자
    }

    #[test]
    fn binary_files_are_rejected() {
        assert!(is_text_head("echo 안녕\n".as_bytes()));
        assert!(is_text_head(b""));
        assert!(!is_text_head(b"MZ\x90\x00\x03"));
    }
}
