#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod admin;
mod edit;
mod exec;
mod hostkeys;
mod icons;
mod llm;
mod logs;
mod paths;
mod policy;
mod redact;
mod secrets;
mod local;
mod profiles;
mod settings;
mod sftp;
mod ssh;

use std::collections::HashMap;
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// 터미널 한 개(탭 한 개)에 대한 입력 채널. 로컬 PTY와 SSH를 같은 인터페이스로 다룬다.
pub enum Session {
    Pty(local::PtySession),
    Admin(admin::AdminSession),
    Ssh(ssh::SshSession),
}

#[derive(Default)]
pub struct AppState {
    pub sessions: Mutex<HashMap<String, Session>>,
    pub sftps: tokio::sync::Mutex<HashMap<String, Arc<russh_sftp::client::SftpSession>>>,
    pub next_id: AtomicU64,
    /// 호스트 키 확인 창의 응답을 기다리는 접속들 (요청 번호 → 응답 채널)
    pub hostkey_waiters: Mutex<HashMap<u64, tokio::sync::oneshot::Sender<String>>>,
    /// 탭별로 편집 중인 SFTP 파일들 (탭을 닫으면 감시를 멈춘다)
    pub edits: Mutex<HashMap<String, Vec<edit::EditHandle>>>,
    /// 편집 중 서버 파일이 바뀌었을 때 덮어쓸지 묻는 창의 응답을 기다리는 업로드들
    pub edit_waiters: Mutex<HashMap<u64, tokio::sync::oneshot::Sender<String>>>,
    /// 진행 중인 AI 응답의 중지 신호 (요청 번호 → 신호)
    pub llm_stops: Mutex<HashMap<u64, Arc<tokio::sync::Notify>>>,
    /// AI가 요청한 명령의 사용자 승인을 기다리는 실행들 (요청 번호 → 답)
    pub agent_waiters: Mutex<HashMap<u64, tokio::sync::oneshot::Sender<bool>>>,
    /// 탭에서 실행 중인 AI 명령을 중단시키는 신호 (탭 id → 신호). 탭을 닫으면 보낸다.
    pub agent_stops: Mutex<HashMap<String, Arc<tokio::sync::Notify>>>,
}

#[derive(Clone, Serialize)]
struct OutputEvent {
    id: String,
    /// 바이트를 base64로 보낸다. UTF-8 문자가 청크 경계에서 잘려도 xterm이 이어 붙이도록 하기 위함.
    data: String,
}

pub fn emit_output(app: &AppHandle, id: &str, bytes: &[u8]) {
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    let _ = app.emit("term-output", OutputEvent { id: id.to_string(), data });
}

pub fn emit_closed(app: &AppHandle, id: &str) {
    let _ = app.emit("term-closed", id.to_string());
}

#[tauri::command]
fn term_write(state: tauri::State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    let mut map = state.sessions.lock().unwrap();
    match map.get_mut(&id) {
        Some(Session::Pty(p)) => p.write(data.as_bytes()).map_err(|e| e.to_string()),
        Some(Session::Admin(s)) => s.write(data.into_bytes()),
        Some(Session::Ssh(s)) => s.write(data.into_bytes()),
        None => Err("no such session".into()),
    }
}

#[tauri::command]
fn term_resize(state: tauri::State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<(), String> {
    let map = state.sessions.lock().unwrap();
    match map.get(&id) {
        Some(Session::Pty(p)) => p.resize(cols, rows).map_err(|e| e.to_string()),
        Some(Session::Admin(s)) => s.resize(cols, rows),
        Some(Session::Ssh(s)) => s.resize(cols, rows),
        None => Ok(()),
    }
}

#[tauri::command]
async fn term_close(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    state.sftps.lock().await.remove(&id);
    edit::stop_tab(&state, &id);
    exec::stop_tab(&state, &id); // 실행 중인 AI 명령도 끊는다
    // Drop 시 PTY 자식 프로세스 종료 / SSH 채널 종료 신호가 전달된다.
    state.sessions.lock().unwrap().remove(&id);
    Ok(())
}

fn main() {
    // 관리자 도우미로 실행된 경우 창 없이 셸 중계만 하고 끝난다.
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--admin-helper") {
        std::process::exit(admin::run_helper(&args));
    }

    edit::cleanup_stale();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState::default())
        .manage(secrets::SecretsState::default())
        .invoke_handler(tauri::generate_handler![
            term_write,
            term_resize,
            term_close,
            profiles::profiles_load,
            profiles::profiles_save,
            profiles::ssh_config_load,
            secrets::secrets_status,
            secrets::secrets_setup,
            secrets::secrets_unlock,
            secrets::secrets_save,
            secrets::secrets_get,
            secrets::secrets_delete,
            secrets::secrets_change_master,
            secrets::secrets_reset,
            settings::settings_load,
            settings::settings_save,
            icons::icon_download,
            icons::icon_read,
            local::open_local,
            admin::open_local_admin,
            ssh::open_ssh,
            hostkeys::host_key_answer,
            sftp::sftp_list,
            sftp::sftp_download,
            sftp::sftp_plan_download,
            sftp::local_mkdirs,
            sftp::sftp_plan_upload,
            sftp::sftp_mkdirs,
            llm::llm_stream,
            llm::llm_cancel,
            logs::log_append,
            exec::agent_run,
            exec::agent_answer,
            edit::sftp_edit,
            edit::edit_answer,
            sftp::sftp_upload,
            sftp::sftp_mkdir,
            sftp::sftp_remove,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            // 탭을 닫지 않고 앱을 끝내도(편집기를 열어 둔 채 종료 등) 임시 편집 파일이 남지 않게 한다.
            if let tauri::RunEvent::Exit = event {
                edit::cleanup_stale();
            }
        });
}
