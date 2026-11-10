//! AI가 요청한 명령을 열려 있는 SSH 연결의 별도 실행 채널로 실행한다 (사용자의 터미널 화면에는 아무것도 찍히지 않는다).
//! 실행할지는 `policy::classify`가 정한다: 자동(읽기 전용 허용 목록), 사람 승인, 거절.
//! 화면이 보내는 것은 "어느 탭에서 어떤 명령"뿐이고, 판단·승인 대기·시간 제한·출력 상한은 모두 여기서 한다.
//! 모든 시도는 `logs/audit-날짜.jsonl`에 남긴다 (끌 수 없다).

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use russh::client::Handle;
use russh::ChannelMsg;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

use crate::policy::{self, Decision};
use crate::ssh::Client;
use crate::{logs, redact, AppState, Session};

const EXEC_TIMEOUT: Duration = Duration::from_secs(20);
const OUTPUT_CAP: usize = 20 * 1024;
const AUDIT_OUTPUT_CAP: usize = 4 * 1024;

#[derive(Serialize, Default)]
pub struct ExecOutput {
    stdout: String,
    stderr: String,
    exit: Option<u32>,
    /// 출력이 상한을 넘어 잘렸다
    truncated: bool,
    timed_out: bool,
}

#[derive(Serialize)]
pub struct AgentOutcome {
    /// "auto"(바로 실행) | "approved"(승인 뒤 실행) | "denied"(사용자가 거절) | "blocked"(정책이 거절)
    decision: &'static str,
    reason: Option<String>,
    #[serde(flatten)]
    output: ExecOutput,
}

#[derive(Clone, Serialize)]
struct ApproveEvent {
    req: u64,
    command: String,
    cwd: Option<String>,
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 작업 폴더가 있으면 앞에 `cd`를 붙인다. 폴더는 따옴표로 감싸서 어떤 글자가 들어 있어도 명령으로 해석되지 않게 한다.
fn build_command(cwd: Option<&str>, cmd: &str) -> String {
    match cwd {
        Some(c) => format!("cd -- {} && {}", shell_quote(c), cmd),
        None => cmd.to_string(),
    }
}

/// 절대 경로이고 제어 문자가 없는 짧은 경로만 쓴다 (원격 셸이 보낸 값이라 믿지 않는다).
fn valid_cwd(c: &str) -> bool {
    c.starts_with('/') && c.len() <= 1024 && !c.chars().any(|ch| ch.is_control())
}

/// 바이트 상한까지 자르고 글자로 바꾼다. 중간에 잘린 글자는 대체 문자가 된다.
fn limit(bytes: &[u8], cap: usize) -> (String, bool) {
    let cut = bytes.len() > cap;
    (String::from_utf8_lossy(&bytes[..bytes.len().min(cap)]).into_owned(), cut)
}

/// 탭을 닫을 때: 그 탭에서 실행 중인 AI 명령을 중단시킨다.
pub fn stop_tab(state: &AppState, id: &str) {
    if let Some(n) = state.agent_stops.lock().unwrap().remove(id) {
        n.notify_one();
    }
}

async fn run_ssh(handle: &Handle<Client>, command: &str, stop: &tokio::sync::Notify) -> Result<ExecOutput, String> {
    let mut ch = handle.channel_open_session().await.map_err(|e| format!("실행 채널을 열 수 없습니다: {e}"))?;
    ch.exec(true, command.as_bytes().to_vec()).await.map_err(|e| format!("명령을 보낼 수 없습니다: {e}"))?;

    let mut out = ExecOutput::default();
    let (mut so, mut se) = (Vec::<u8>::new(), Vec::<u8>::new());
    let read = async {
        loop {
            match ch.wait().await {
                Some(ChannelMsg::Data { data }) => so.extend_from_slice(&data),
                Some(ChannelMsg::ExtendedData { data, .. }) => se.extend_from_slice(&data),
                Some(ChannelMsg::ExitStatus { exit_status }) => out.exit = Some(exit_status),
                Some(ChannelMsg::Close) | None => break,
                _ => {} // Eof 뒤에 종료 코드가 오므로 Close까지 기다린다
            }
            if so.len() > OUTPUT_CAP || se.len() > OUTPUT_CAP {
                out.truncated = true; // 끝없이 출력하는 명령을 막는다
                break;
            }
        }
    };
    let mut cancelled = false;
    tokio::select! {
        r = tokio::time::timeout(EXEC_TIMEOUT, read) => {
            if r.is_err() {
                out.timed_out = true;
            }
        }
        _ = stop.notified() => cancelled = true,
    }
    let _ = ch.close().await; // 시간 초과, 출력 초과, 중단이면 채널을 닫아 서버 쪽 명령도 끊는다
    if cancelled {
        return Err("세션이 닫혀 명령을 중단했습니다".into());
    }
    let (stdout, cut1) = limit(&so, OUTPUT_CAP);
    let (stderr, cut2) = limit(&se, OUTPUT_CAP);
    out.stdout = stdout;
    out.stderr = stderr;
    out.truncated |= cut1 || cut2;
    Ok(out)
}

async fn ask_approval(app: &AppHandle, command: &str, cwd: Option<&str>) -> bool {
    let state = app.state::<AppState>();
    let req = state.next_id.fetch_add(1, Ordering::SeqCst);
    let (tx, rx) = oneshot::channel::<bool>();
    state.agent_waiters.lock().unwrap().insert(req, tx);
    let ev = ApproveEvent { req, command: command.to_string(), cwd: cwd.map(String::from) };
    if app.emit("agent-approve", ev).is_err() {
        state.agent_waiters.lock().unwrap().remove(&req);
        return false;
    }
    rx.await.unwrap_or(false) // 창이 닫혀서 답이 없으면 거절로 본다
}

/// 승인 카드에서 사용자가 누른 결과. 어떤 명령을 승인하는지는 백엔드가 이미 들고 있어서 화면이 바꿀 수 없다.
#[tauri::command]
pub fn agent_answer(state: State<'_, AppState>, req: u64, approve: bool) {
    if let Some(tx) = state.agent_waiters.lock().unwrap().remove(&req) {
        let _ = tx.send(approve);
    }
}

fn audit(date: &str, stamp: &str, tab: &str, context: &str, command: &str, decision: &str, reason: Option<&str>, out: Option<&ExecOutput>) {
    let cap = |s: &str| redact::redact(&limit(s.as_bytes(), AUDIT_OUTPUT_CAP).0);
    let record = serde_json::json!({
        "time": stamp.chars().take(40).collect::<String>(),
        "event": "exec",
        "tab": tab,
        "target": context.chars().take(200).collect::<String>(),
        "command": command,
        "decision": decision,
        "reason": reason,
        "exit": out.and_then(|o| o.exit),
        "timed_out": out.is_some_and(|o| o.timed_out),
        "truncated": out.is_some_and(|o| o.truncated),
        "stdout": out.map(|o| cap(&o.stdout)),
        "stderr": out.map(|o| cap(&o.stderr)),
    });
    // 기록에 실패해도 실행 결과는 돌려준다 (기록 실패가 화면에 보이지 않을 뿐이다).
    let _ = logs::audit(date, &record.to_string());
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn agent_run(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    command: String,
    cwd: Option<String>,
    context: String,
    stamp: String,
    date: String,
) -> Result<AgentOutcome, String> {
    let handle = match state.sessions.lock().unwrap().get(&id) {
        Some(Session::Ssh(s)) => s.handle.clone(),
        _ => return Err("SSH 탭에서만 실행할 수 있습니다".into()),
    };
    let cwd = cwd.filter(|c| valid_cwd(c));
    let blocked = |reason: String, decision: &'static str| {
        audit(&date, &stamp, &id, &context, &command, decision, Some(&reason), None);
        Ok(AgentOutcome { decision, reason: Some(reason), output: ExecOutput::default() })
    };

    let label = match policy::classify(&command) {
        Decision::Deny(reason) => return blocked(reason, "blocked"),
        Decision::Auto => "auto",
        Decision::Approve => {
            if !ask_approval(&app, &command, cwd.as_deref()).await {
                return blocked("사용자가 거절했습니다".into(), "denied");
            }
            "approved"
        }
    };

    let full = build_command(cwd.as_deref(), &command);
    let stop = Arc::new(tokio::sync::Notify::new());
    state.agent_stops.lock().unwrap().insert(id.clone(), stop.clone());
    let result = run_ssh(&handle, &full, &stop).await;
    state.agent_stops.lock().unwrap().remove(&id);
    match result {
        Ok(output) => {
            audit(&date, &stamp, &id, &context, &command, label, None, Some(&output));
            Ok(AgentOutcome { decision: label, reason: None, output })
        }
        Err(e) => {
            audit(&date, &stamp, &id, &context, &command, "error", Some(&e), None);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cwd_is_quoted_so_it_can_never_become_a_command() {
        assert_eq!(build_command(Some("/var/log"), "ls -l"), "cd -- '/var/log' && ls -l");
        assert_eq!(build_command(None, "ls"), "ls");
        // 따옴표, 세미콜론, 명령 치환이 들어 있어도 한 덩어리 글자로 남는다
        assert_eq!(build_command(Some("/a'b; rm -rf /"), "ls"), "cd -- '/a'\\''b; rm -rf /' && ls");
        assert_eq!(build_command(Some("/x$(id)`id`"), "ls"), "cd -- '/x$(id)`id`' && ls");
    }

    #[test]
    fn only_clean_absolute_paths_are_used_as_cwd() {
        assert!(valid_cwd("/home/u/work space"));
        for bad in ["", "relative/path", "~", "/a\nb", "/a\0b", "/a\x1b[31m", &format!("/{}", "a".repeat(1100))] {
            assert!(!valid_cwd(bad), "{bad:?}");
        }
    }

    #[test]
    fn output_is_cut_at_the_cap_and_flagged() {
        let (s, cut) = limit(b"hello", 10);
        assert_eq!((s.as_str(), cut), ("hello", false));
        let (s, cut) = limit(b"hello world", 5);
        assert_eq!((s.as_str(), cut), ("hello", true));
        // 한글 중간에서 잘려도 깨지지 않는다
        let (s, cut) = limit("가나다".as_bytes(), 4);
        assert!(cut && s.starts_with('가'));
    }
}
