//! SSH 호스트 키 지문 확인. 처음 보는 서버는 사용자에게 묻고, 저장된 지문과 달라지면 경고한다.
//! 저장 위치는 실행 파일과 같은 폴더의 known_hosts.json (`호스트:포트` → `SHA256:...`).

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

use crate::AppState;

#[derive(Debug, PartialEq)]
pub enum Verdict {
    /// 저장된 지문과 같다
    Known,
    /// 처음 보는 서버
    New,
    /// 저장된 지문과 다르다 (값은 저장돼 있던 지문)
    Changed(String),
}

pub type Hosts = BTreeMap<String, String>;

pub fn judge(hosts: &Hosts, host_id: &str, fingerprint: &str) -> Verdict {
    match hosts.get(host_id) {
        None => Verdict::New,
        Some(saved) if saved == fingerprint => Verdict::Known,
        Some(saved) => Verdict::Changed(saved.clone()),
    }
}

fn default_path() -> Result<PathBuf, String> {
    crate::paths::data_path("known_hosts.json")
}

/// 파일이 없으면 빈 목록. 깨진 파일은 오류로 돌려준다 (조용히 비우면 지문 검증이 사라지기 때문).
pub fn load_from(path: &Path) -> Result<Hosts, String> {
    match std::fs::read_to_string(path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("known_hosts.json 형식이 올바르지 않습니다: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Hosts::new()),
        Err(e) => Err(format!("known_hosts.json을 읽을 수 없습니다: {e}")),
    }
}

pub fn save_to(path: &Path, hosts: &Hosts) -> Result<(), String> {
    let json = serde_json::to_string_pretty(hosts).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    let werr = |e: std::io::Error| format!("지문을 저장할 수 없습니다 ({}): {e}", path.display());
    std::fs::write(&tmp, json).map_err(werr)?;
    std::fs::rename(&tmp, path).map_err(werr)
}

pub fn load() -> Result<Hosts, String> {
    load_from(&default_path()?)
}

pub fn remember(host_id: &str, fingerprint: &str) -> Result<(), String> {
    let path = default_path()?;
    let mut hosts = load_from(&path)?;
    hosts.insert(host_id.to_string(), fingerprint.to_string());
    save_to(&path, &hosts)
}

#[derive(Clone, Serialize)]
struct PromptEvent {
    req: u64,
    host: String,
    port: u16,
    algorithm: String,
    fingerprint: String,
    /// 저장돼 있던 지문. 있으면 "지문이 달라짐" 경고다.
    old: Option<String>,
}

/// 접속 도중 호스트 키를 판단한다. true면 접속을 계속한다.
pub async fn verify(app: &AppHandle, host: &str, port: u16, algorithm: String, fingerprint: String) -> Result<bool, String> {
    let host_id = format!("{host}:{port}");
    let old = match judge(&load()?, &host_id, &fingerprint) {
        Verdict::Known => return Ok(true),
        Verdict::New => None,
        Verdict::Changed(old) => Some(old),
    };

    let state = app.state::<AppState>();
    let req = state.next_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let (tx, rx) = oneshot::channel::<String>();
    state.hostkey_waiters.lock().unwrap().insert(req, tx);
    app.emit("host-key-prompt", PromptEvent { req, host: host.into(), port, algorithm, fingerprint: fingerprint.clone(), old })
        .map_err(|e| e.to_string())?;

    // 창이 닫혀서 응답 채널이 사라지면 취소로 본다.
    let choice = rx.await.unwrap_or_else(|_| "cancel".into());
    match choice.as_str() {
        "trust" => {
            remember(&host_id, &fingerprint)?;
            Ok(true)
        }
        "once" => Ok(true),
        _ => Ok(false),
    }
}

/// 화면이 확인 창에서 고른 값을 돌려준다: "trust"(저장) / "once"(이번만) / "cancel"
#[tauri::command]
pub fn host_key_answer(state: State<'_, AppState>, req: u64, choice: String) {
    if let Some(tx) = state.hostkey_waiters.lock().unwrap().remove(&req) {
        let _ = tx.send(choice);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hosts() -> Hosts {
        Hosts::from([("a.example:22".to_string(), "SHA256:aaa".to_string())])
    }

    #[test]
    fn judge_cases() {
        assert_eq!(judge(&hosts(), "a.example:22", "SHA256:aaa"), Verdict::Known);
        assert_eq!(judge(&hosts(), "b.example:22", "SHA256:aaa"), Verdict::New);
        assert_eq!(judge(&hosts(), "a.example:22", "SHA256:bbb"), Verdict::Changed("SHA256:aaa".into()));
        // 포트가 다르면 다른 서버로 본다
        assert_eq!(judge(&hosts(), "a.example:2222", "SHA256:aaa"), Verdict::New);
    }

    #[test]
    fn save_and_load_roundtrip() {
        let dir = std::env::temp_dir().join("toyterm-hostkeys-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("known_hosts.json");
        let _ = std::fs::remove_file(&p);
        assert!(load_from(&p).unwrap().is_empty()); // 파일 없음 = 빈 목록
        save_to(&p, &hosts()).unwrap();
        assert_eq!(load_from(&p).unwrap(), hosts());
    }

    #[test]
    fn broken_file_is_an_error_not_empty() {
        let dir = std::env::temp_dir().join("toyterm-hostkeys-test");
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("broken.json");
        std::fs::write(&p, "{not json").unwrap();
        assert!(load_from(&p).unwrap_err().contains("올바르지 않습니다"));
    }
}
