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

/// 사용자의 기본 셸. macOS/Linux는 `$SHELL`, 없으면 zsh. (Windows는 쓰지 않지만 컴파일을 위해 둔다)
#[cfg(not(windows))]
fn default_shell() -> String {
    std::env::var("SHELL").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "/bin/zsh".into())
}
#[cfg(windows)]
fn default_shell() -> String {
    "powershell.exe".into()
}

/// 셸에 줄 환경변수. Finder로 연 앱은 TERM·LANG이 비어 있어, TERM이 없으면 zsh가 커서 이동을 못 해
/// 글자가 겹쳐 보이고 한글이 `?`로 나온다. `is_set`은 해당 변수가 이미 있는지 알려 준다.
#[cfg_attr(windows, allow(dead_code))]
fn term_env(is_set: impl Fn(&str) -> bool) -> Vec<(&'static str, &'static str)> {
    let mut env = vec![("TERM", "xterm-256color"), ("COLORTERM", "truecolor")];
    if !["LANG", "LC_ALL", "LC_CTYPE"].iter().any(|k| is_set(k)) {
        env.push(("LANG", "en_US.UTF-8"));
    }
    env
}

fn program_for(shell: &str) -> String {
    match shell {
        "pwsh" => "pwsh.exe".into(),
        "powershell" => "powershell.exe".into(),
        "cmd" => "cmd.exe".into(),
        "shell" => default_shell(),
        other => other.into(),
    }
}

/// shell: "pwsh" | "powershell" | "cmd" | "shell"(기본 셸) 또는 실행 파일 경로.
/// 일반 실행(open_local)과 관리자 도우미(admin::run_helper)가 함께 쓴다.
pub fn spawn(shell: &str, cols: u16, rows: u16) -> Result<(PtySession, Box<dyn Read + Send>), String> {
    let program = program_for(shell);

    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&program);
    #[cfg(not(windows))]
    for (k, v) in term_env(|k| std::env::var_os(k).is_some_and(|v| !v.is_empty())) {
        cmd.env(k, v);
    }
    // 로그인 셸로 띄워야 Finder에서 연 앱에서도 터미널.앱처럼 PATH가 잡힌다.
    #[cfg(not(windows))]
    if shell == "shell" {
        cmd.arg("-l");
    }
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

#[cfg(test)]
mod tests {
    use super::program_for;

    #[test]
    fn 셸_환경변수는_term을_항상_넣고_lang은_비었을_때만_넣는다() {
        let none = super::term_env(|_| false);
        assert!(none.contains(&("TERM", "xterm-256color")));
        assert!(none.contains(&("LANG", "en_US.UTF-8")));
        let has_lang = super::term_env(|k| k == "LC_ALL");
        assert!(has_lang.contains(&("TERM", "xterm-256color")));
        assert!(!has_lang.iter().any(|(k, _)| *k == "LANG"));
    }

    #[test]
    fn 셸_이름을_실행_파일로_바꾼다() {
        assert_eq!(program_for("pwsh"), "pwsh.exe");
        assert_eq!(program_for("powershell"), "powershell.exe");
        assert_eq!(program_for("cmd"), "cmd.exe");
        assert_eq!(program_for("/opt/bin/mysh"), "/opt/bin/mysh");
    }

    #[test]
    fn 기본_셸은_비어_있지_않다() {
        assert!(!program_for("shell").is_empty());
    }
}
