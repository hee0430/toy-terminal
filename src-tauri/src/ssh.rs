use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use russh::client::{self, Handle};
use russh::keys::{decode_secret_key, PrivateKey, PrivateKeyWithHashAlg};
use russh::ChannelMsg;
use serde::Deserialize;
use tauri::{AppHandle, State};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

use crate::{emit_closed, emit_output, AppState, Session};

pub enum Input {
    Data(Vec<u8>),
    Resize(u16, u16),
}

pub struct SshSession {
    tx: UnboundedSender<Input>,
    /// SFTP 채널을 같은 연결 위에 추가로 열기 위해 보관한다.
    pub handle: Arc<Handle<Client>>,
    /// 포트 포워딩 태스크. 세션이 사라지면 함께 멈춘다.
    tasks: Vec<tauri::async_runtime::JoinHandle<()>>,
}

impl Drop for SshSession {
    fn drop(&mut self) {
        for t in &self.tasks {
            t.abort();
        }
    }
}

impl SshSession {
    pub fn write(&self, data: Vec<u8>) -> Result<(), String> {
        self.tx.send(Input::Data(data)).map_err(|e| e.to_string())
    }
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.tx.send(Input::Resize(cols, rows)).map_err(|e| e.to_string())
    }
}

/// 서버가 열어 준 원격 포워딩(-R)의 서버 쪽 포트 → 이 PC에서 연결할 곳
type RemoteForwards = Arc<Mutex<HashMap<u32, (String, u16)>>>;

pub struct Client {
    app: AppHandle,
    host: String,
    port: u16,
    remote_forwards: RemoteForwards,
}

impl client::Handler for Client {
    type Error = russh::Error;

    // 서버가 -R 포트로 들어온 연결을 넘겨 주면, 이 PC의 목적지에 연결해 양쪽을 이어 준다.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        _connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let target = self.remote_forwards.lock().unwrap().get(&connected_port).cloned();
        let Some((host, port)) = target else {
            reply.reject(russh::ChannelOpenFailure::AdministrativelyProhibited).await;
            return Ok(());
        };
        match tokio::net::TcpStream::connect((host.as_str(), port)).await {
            Ok(mut sock) => {
                reply.accept().await;
                let mut stream = channel.into_stream();
                tauri::async_runtime::spawn(async move {
                    let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
                });
            }
            Err(_) => reply.reject(russh::ChannelOpenFailure::ConnectFailed).await,
        }
        Ok(())
    }

    // 지문을 저장된 값과 비교하고, 처음이거나 달라졌으면 화면에서 사용자에게 묻는다.
    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        use russh::keys::{HashAlg, PublicKeyOrCertificate as K};
        let (algorithm, fingerprint) = match key {
            K::PublicKey { key, .. } => (key.algorithm().to_string(), key.fingerprint(HashAlg::Sha256).to_string()),
            K::Certificate(c) => (c.algorithm().to_string(), c.public_key().fingerprint(HashAlg::Sha256).to_string()),
        };
        crate::hostkeys::verify(&self.app, &self.host, self.port, algorithm, fingerprint)
            .await
            .map_err(|e| russh::Error::IO(std::io::Error::other(e)))
    }
}

#[derive(Deserialize)]
pub struct SshParams {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    /// 개인키 파일 경로 (비밀번호 대신 사용)
    pub key_path: Option<String>,
    pub passphrase: Option<String>,
    pub cols: u16,
    pub rows: u16,
    #[serde(default)]
    pub forwards: Vec<Forward>,
    /// 연결 유지 신호 간격(초). 0이면 보내지 않는다
    #[serde(default)]
    pub keepalive_secs: u64,
}

/// 포트 포워딩 한 건. remote=false는 -L(이 PC에서 열고 서버 쪽 목적지로), true는 -R(서버에서 열고 이 PC 쪽 목적지로).
#[derive(Deserialize, Clone)]
pub struct Forward {
    pub remote: bool,
    pub listen_port: u16,
    pub host: String,
    pub port: u16,
    /// -L만: true면 모든 주소(0.0.0.0)에서 접속을 받는다. 기본은 이 PC(127.0.0.1)에서만.
    #[serde(default)]
    pub all: bool,
}

/// -L: 127.0.0.1(all이면 0.0.0.0)에서 기다리다가 들어온 연결마다 서버를 거쳐 목적지로 이어 준다.
/// 포트가 이미 사용 중이면(같은 프로필을 여러 번 연 경우 등) 접속을 막지 않고 None으로 건너뛴다. 그 밖의 오류는 실패.
async fn start_local_forward(handle: Arc<Handle<Client>>, f: &Forward) -> Result<Option<tauri::async_runtime::JoinHandle<()>>, String> {
    let bind_addr = if f.all { "0.0.0.0" } else { "127.0.0.1" };
    let listener = match tokio::net::TcpListener::bind((bind_addr, f.listen_port)).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => return Ok(None),
        Err(e) => return Err(format!("로컬 포트 {}을(를) 열 수 없습니다: {e}", f.listen_port)),
    };
    let (host, port) = (f.host.clone(), f.port);
    Ok(Some(tauri::async_runtime::spawn(async move {
        loop {
            let Ok((mut sock, peer)) = listener.accept().await else { break };
            let (handle, host) = (handle.clone(), host.clone());
            tauri::async_runtime::spawn(async move {
                let Ok(channel) = handle.channel_open_direct_tcpip(host, port as u32, peer.ip().to_string(), peer.port() as u32).await else { return };
                let mut stream = channel.into_stream();
                let _ = tokio::io::copy_bidirectional(&mut sock, &mut stream).await;
            });
        }
    })))
}

#[tauri::command]
pub async fn open_ssh(
    app: AppHandle,
    state: State<'_, AppState>,
    params: SshParams,
) -> Result<String, String> {
    let remote_forwards: RemoteForwards = Arc::new(Mutex::new(HashMap::new()));
    let handle = connect(&app, &params, remote_forwards.clone()).await.map_err(|e| format!("{e:#}"))?;
    let handle = Arc::new(handle);

    // 포워딩을 먼저 연다. 하나라도 실패하면 접속 전체를 실패로 알린다 (이미 연 것은 태스크가 drop되며 멈춘다).
    let mut tasks = Vec::new();
    let mut skipped_ports = Vec::new();
    let result: Result<(), String> = async {
        for f in &params.forwards {
            if f.remote {
                handle.tcpip_forward("127.0.0.1", f.listen_port as u32).await.map_err(|e| format!("서버가 원격 포트 {} 포워딩을 거절했습니다: {e}", f.listen_port))?;
                remote_forwards.lock().unwrap().insert(f.listen_port as u32, (f.host.clone(), f.port));
            } else {
                match start_local_forward(handle.clone(), f).await? {
                    Some(t) => tasks.push(t),
                    None => skipped_ports.push(f.listen_port),
                }
            }
        }
        Ok(())
    }
    .await;
    if let Err(e) = result {
        tasks.iter().for_each(|t| t.abort());
        return Err(e);
    }

    let mut channel = handle.channel_open_session().await.map_err(|e| e.to_string())?;
    channel
        .request_pty(true, "xterm-256color", params.cols as u32, params.rows as u32, 0, 0, &[])
        .await
        .map_err(|e| e.to_string())?;
    channel.request_shell(true).await.map_err(|e| e.to_string())?;

    let id = format!("t{}", state.next_id.fetch_add(1, Ordering::SeqCst));
    let (tx, mut rx) = unbounded_channel::<Input>();
    state
        .sessions
        .lock()
        .unwrap()
        .insert(id.clone(), Session::Ssh(SshSession { tx, handle, tasks }));

    if !skipped_ports.is_empty() {
        let ports = skipped_ports.iter().map(u16::to_string).collect::<Vec<_>>().join(", ");
        emit_output(&app, &id, format!("\x1b[33m[ToyTerm] 로컬 포트 {ports}이(가) 이미 사용 중이라 포워딩을 건너뛰었습니다.\x1b[0m\r\n").as_bytes());
    }

    let (app2, id2) = (app.clone(), id.clone());
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::select! {
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { data }) => emit_output(&app2, &id2, &data),
                    Some(ChannelMsg::ExtendedData { data, .. }) => emit_output(&app2, &id2, &data),
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    _ => {}
                },
                input = rx.recv() => match input {
                    Some(Input::Data(d)) => { if channel.data_bytes(d).await.is_err() { break; } }
                    Some(Input::Resize(c, r)) => { let _ = channel.window_change(c as u32, r as u32, 0, 0).await; }
                    // 세션이 맵에서 제거되면 tx가 drop되어 여기로 온다.
                    None => { let _ = channel.close().await; break; }
                },
            }
        }
        emit_closed(&app2, &id2);
    });

    Ok(id)
}

/// `~`와 `~\` 로 시작하는 경로를 홈 디렉터리로 확장한다.
fn expand_home(p: &str) -> std::path::PathBuf {
    if p == "~" || p.starts_with("~/") || p.starts_with("~\\") {
        if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
            return std::path::PathBuf::from(home).join(p[1..].trim_start_matches(['/', '\\']));
        }
    }
    std::path::PathBuf::from(p)
}

/// 개인키 파일을 읽고, 사용자가 원인을 알 수 있는 한글 오류로 바꿔 돌려준다.
pub fn load_key(path: &str, passphrase: Option<&str>) -> Result<PrivateKey, String> {
    let path = expand_home(path);
    let text = std::fs::read_to_string(&path).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => format!("키 파일을 찾을 수 없습니다: {}", path.display()),
        std::io::ErrorKind::InvalidData => "텍스트 형식의 개인키가 아닙니다 (PEM 또는 OpenSSH 형식이 필요합니다)".to_string(),
        _ => format!("키 파일을 읽을 수 없습니다 ({e}): {}", path.display()),
    })?;

    if text.starts_with("PuTTY-User-Key-File") {
        return Err("PuTTY .ppk 형식은 지원하지 않습니다. PuTTYgen의 'Conversions > Export OpenSSH key'로 변환하세요".into());
    }
    if !text.contains("PRIVATE KEY") {
        let t = text.trim_start();
        return Err(if t.starts_with("ssh-") || t.starts_with("ecdsa-") {
            "공개키(.pub) 파일입니다. 개인키 파일을 선택하세요".into()
        } else {
            "개인키 형식이 아닙니다 ('-----BEGIN ... PRIVATE KEY-----' 로 시작해야 합니다)".into()
        });
    }

    decode_secret_key(&text, passphrase).map_err(|e| match e {
        russh::keys::Error::KeyIsEncrypted => "키가 암호화되어 있습니다. 키 암호를 입력하세요".to_string(),
        russh::keys::Error::UnsupportedKeyType { key_type_string, .. } => format!("지원하지 않는 키 종류입니다: {key_type_string}"),
        e if passphrase.is_some() => format!("키를 읽지 못했습니다. 키 암호가 틀렸거나 지원하지 않는 암호화 방식일 수 있습니다 ({e})"),
        e => format!("키를 읽지 못했습니다. 파일이 손상되었거나 지원하지 않는 형식입니다 ({e})"),
    })
}

async fn connect(app: &AppHandle, p: &SshParams, remote_forwards: RemoteForwards) -> anyhow::Result<Handle<Client>> {
    // 키 파일 문제는 네트워크 접속 전에 먼저 알려준다.
    let key = match p.key_path.as_deref().filter(|s| !s.is_empty()) {
        Some(path) => Some(load_key(path, p.passphrase.as_deref().filter(|s| !s.is_empty())).map_err(anyhow::Error::msg)?),
        None => None,
    };

    // 서버가 조용한 채로 간격이 지나면 확인 신호를 보낸다. 공유기·방화벽이 놀고 있는 연결을 끊는 것을 막고,
    // 3번 응답이 없으면 연결을 닫아서 탭이 먹통으로 남지 않고 '세션 종료됨'으로 바뀐다.
    let keepalive_interval = (p.keepalive_secs > 0).then(|| std::time::Duration::from_secs(p.keepalive_secs));
    let config = Arc::new(client::Config { keepalive_interval, keepalive_max: 3, ..Default::default() });
    let handler = Client { app: app.clone(), host: p.host.clone(), port: p.port, remote_forwards };
    let mut session = client::connect(config, (p.host.as_str(), p.port), handler)
        .await
        .map_err(|e| match e {
            russh::Error::UnknownKey => anyhow::anyhow!("서버 지문을 신뢰하지 않아 접속을 취소했습니다"),
            e => anyhow::Error::from(e),
        })?;

    let ok = if let Some(key) = key {
        let hash = session.best_supported_rsa_hash().await?.flatten();
        session
            .authenticate_publickey(&p.user, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
            .await?
            .success()
    } else {
        session
            .authenticate_password(&p.user, p.password.clone().unwrap_or_default())
            .await?
            .success()
    };
    anyhow::ensure!(ok, "인증 실패 (사용자명/비밀번호/키 확인)");
    Ok(session)
}

#[cfg(test)]
mod tests {
    use super::load_key;
    use std::path::PathBuf;
    use std::process::Command;

    /// ssh-keygen으로 실제 키 파일을 만든다. extra: ["-t","rsa","-m","PEM"] 같은 옵션
    fn gen(name: &str, extra: &[&str], pass: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("toyterm-keytest");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(name);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("pub"));
        let st = Command::new("ssh-keygen")
            .args(["-q", "-N", pass, "-f"])
            .arg(&path)
            .args(extra)
            .status()
            .expect("ssh-keygen 실행 불가");
        assert!(st.success(), "ssh-keygen 실패: {name}");
        path
    }

    fn ok(p: &PathBuf, pass: Option<&str>) {
        load_key(p.to_str().unwrap(), pass).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
    }

    #[test]
    fn openssh_ed25519() {
        ok(&gen("ed", &["-t", "ed25519"], ""), None);
    }

    #[test]
    fn pem_rsa_pkcs1() {
        let p = gen("rsa_pem", &["-t", "rsa", "-b", "2048", "-m", "PEM"], "");
        assert!(std::fs::read_to_string(&p).unwrap().contains("BEGIN RSA PRIVATE KEY"));
        ok(&p, None);
    }

    #[test]
    fn pem_rsa_pkcs8() {
        let p = gen("rsa_p8", &["-t", "rsa", "-b", "2048", "-m", "PKCS8"], "");
        assert!(std::fs::read_to_string(&p).unwrap().contains("BEGIN PRIVATE KEY"));
        ok(&p, None);
    }

    #[test]
    fn pem_ecdsa() {
        let p = gen("ec_pem", &["-t", "ecdsa", "-m", "PEM"], "");
        ok(&p, None);
    }

    #[test]
    fn encrypted_openssh() {
        let p = gen("ed_enc", &["-t", "ed25519"], "secret");
        ok(&p, Some("secret"));
        let none = load_key(p.to_str().unwrap(), None).unwrap_err();
        assert!(none.contains("암호"), "{none}");
        let wrong = load_key(p.to_str().unwrap(), Some("nope")).unwrap_err();
        assert!(wrong.contains("암호가 틀렸"), "{wrong}");
    }

    #[test]
    fn encrypted_pem_rsa() {
        let p = gen("rsa_pem_enc", &["-t", "rsa", "-b", "2048", "-m", "PEM"], "secret");
        println!("legacy header: {}", std::fs::read_to_string(&p).unwrap().lines().nth(1).unwrap_or(""));
        ok(&p, Some("secret"));
    }

    #[test]
    fn encrypted_pkcs8() {
        let p = gen("rsa_p8_enc", &["-t", "rsa", "-b", "2048", "-m", "PKCS8"], "secret");
        ok(&p, Some("secret"));
    }

    #[test]
    fn friendly_errors() {
        let p = gen("for_pub", &["-t", "ed25519"], "");
        let pubf = p.with_extension("pub");
        assert!(load_key(pubf.to_str().unwrap(), None).unwrap_err().contains("공개키"));
        assert!(load_key("C:/no/such/key.pem", None).unwrap_err().contains("찾을 수 없습니다"));
        let ppk = std::env::temp_dir().join("toyterm-keytest").join("x.ppk");
        std::fs::write(&ppk, "PuTTY-User-Key-File-3: ssh-rsa\n").unwrap();
        assert!(load_key(ppk.to_str().unwrap(), None).unwrap_err().contains("ppk"));
    }

    #[test]
    fn tilde_expands() {
        let home = std::env::var("USERPROFILE").unwrap();
        let dir = PathBuf::from(&home).join(".toyterm-tilde-test");
        std::fs::create_dir_all(&dir).unwrap();
        let src = gen("tilde_src", &["-t", "ed25519"], "");
        std::fs::copy(&src, dir.join("k")).unwrap();
        let r = load_key("~/.toyterm-tilde-test/k", None);
        let _ = std::fs::remove_dir_all(&dir);
        r.unwrap();
    }
}
