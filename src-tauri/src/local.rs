use std::io::{Read, Write};
use std::sync::atomic::Ordering;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, State};

use crate::{emit_closed, emit_output, AppState, Session};

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl PtySession {
    pub fn write(&mut self, data: &[u8]) -> std::io::Result<()> {
        self.writer.write_all(data)?;
        self.writer.flush()
    }

    pub fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        self.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;
        Ok(())
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

/// shell: "pwsh" | "powershell" | "cmd" 또는 실행 파일 경로.
/// 일반 실행(open_local)과 관리자 도우미(admin::run_helper)가 함께 쓴다.
pub fn spawn(shell: &str, cols: u16, rows: u16) -> Result<(PtySession, Box<dyn Read + Send>), String> {
    let program = match shell {
        "pwsh" => "pwsh.exe",
        "powershell" => "powershell.exe",
        "cmd" => "cmd.exe",
        other => other,
    };

    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(program);
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) {
        cmd.cwd(home);
    }
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("'{program}' 실행 실패: {e}"))?;
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    Ok((PtySession { master: pair.master, writer, child }, reader))
}

#[tauri::command]
pub fn open_local(
    app: AppHandle,
    state: State<'_, AppState>,
    shell: String,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let (session, mut reader) = spawn(&shell, cols, rows)?;

    let id = format!("t{}", state.next_id.fetch_add(1, Ordering::SeqCst));
    state.sessions.lock().unwrap().insert(id.clone(), Session::Pty(session));

    let (app2, id2) = (app.clone(), id.clone());
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => emit_output(&app2, &id2, &buf[..n]),
            }
        }
        emit_closed(&app2, &id2);
    });

    Ok(id)
}
