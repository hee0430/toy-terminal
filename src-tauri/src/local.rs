use std::io::{Read, Write};
use std::sync::atomic::Ordering;

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
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
        s if is_wsl(s) => "wsl.exe".into(),
        other => other.into(),
    }
}

/// "wsl"(기본 배포판) 또는 "wsl:<배포판 이름>"
fn is_wsl(shell: &str) -> bool {
    shell == "wsl" || shell.starts_with("wsl:")
}

/// WSL 셸에 줄 인자. 리눅스 홈(`~`)에서 시작한다. 배포판 이름은 인자로만 넘기지만 글자, 숫자, `. _ -`만 허용한다.
fn wsl_args(shell: &str) -> Result<Vec<String>, String> {
    let mut args = vec![];
    if let Some(distro) = shell.strip_prefix("wsl:") {
        let ok = !distro.is_empty() && !distro.starts_with('-') && distro.len() <= 64 && distro.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
        if !ok {
            return Err("올바르지 않은 WSL 배포판 이름입니다".into());
        }
        args.extend(["-d".to_string(), distro.to_string()]);
    }
    args.extend(["--cd".to_string(), "~".to_string()]);
    Ok(args)
}

/// `wsl.exe -l -q`의 출력(UTF-16LE)에서 쓸 수 있는 배포판 이름들. docker-desktop 계열은 셸로 쓸 수 없어 뺀다.
fn parse_wsl_list(out: &[u8]) -> Vec<String> {
    let units: Vec<u16> = out.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect();
    String::from_utf16_lossy(&units)
        .lines()
        .map(|l| l.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}'))
        .filter(|l| !l.is_empty() && !l.starts_with("docker-desktop"))
        .map(String::from)
        .collect()
}

#[derive(Serialize)]
pub struct ShellStatus {
    /// PowerShell 7(pwsh.exe)이 설치돼 있는가. Windows PowerShell과 cmd는 항상 있다.
    pwsh: bool,
    /// 쓸 수 있는 WSL 배포판 이름들 (없으면 WSL 세션을 만들 수 없다)
    wsl: Vec<String>,
}

#[cfg(windows)]
fn pwsh_installed() -> bool {
    let in_path = std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d.join("pwsh.exe").exists()));
    in_path || std::path::Path::new(r"C:\Program Files\PowerShell\7\pwsh.exe").exists()
}
#[cfg(not(windows))]
fn pwsh_installed() -> bool {
    false
}

#[cfg(windows)]
async fn wsl_distros() -> Vec<String> {
    let mut cmd = tokio::process::Command::new("wsl.exe");
    cmd.args(["-l", "-q"]).creation_flags(0x0800_0000).stdin(std::process::Stdio::null()).kill_on_drop(true); // 0x08000000 = 콘솔 창 안 띄움
    match tokio::time::timeout(std::time::Duration::from_secs(3), cmd.output()).await {
        Ok(Ok(o)) if o.status.success() => parse_wsl_list(&o.stdout),
        _ => vec![],
    }
}
#[cfg(not(windows))]
async fn wsl_distros() -> Vec<String> {
    vec![]
}

/// 이 PC에 설치된 셸. 세션 종류 목록에 설치된 것만 보여 주는 데 쓴다.
#[tauri::command]
pub async fn shell_status() -> ShellStatus {
    ShellStatus { pwsh: pwsh_installed(), wsl: wsl_distros().await }
}

/// shell: "pwsh" | "powershell" | "cmd" | "wsl" | "wsl:<배포판>" | "shell"(기본 셸) 또는 실행 파일 경로.
/// 일반 실행(open_local)과 관리자 도우미(admin::run_helper)가 함께 쓴다.
pub fn spawn(shell: &str, cols: u16, rows: u16) -> Result<(PtySession, Box<dyn Read + Send>), String> {
    let program = program_for(shell);

    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&program);
    if is_wsl(shell) {
        for a in wsl_args(shell)? {
            cmd.arg(a);
        }
    }
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

    #[test]
    fn wsl은_배포판_이름과_홈에서_시작하는_인자를_만든다() {
        assert_eq!(program_for("wsl"), "wsl.exe");
        assert_eq!(program_for("wsl:Ubuntu-22.04"), "wsl.exe");
        assert_eq!(super::wsl_args("wsl").unwrap(), ["--cd", "~"]);
        assert_eq!(super::wsl_args("wsl:Ubuntu-22.04").unwrap(), ["-d", "Ubuntu-22.04", "--cd", "~"]);
        for bad in ["wsl:", "wsl:a b", "wsl:a;b", "wsl:-d", "wsl:a/b", &format!("wsl:{}", "a".repeat(65))] {
            assert!(super::wsl_args(bad).is_err(), "{bad:?}");
        }
    }

    fn utf16(s: &str) -> Vec<u8> {
        s.encode_utf16().flat_map(|u| u.to_le_bytes()).collect()
    }

    #[test]
    fn wsl_목록은_utf16을_읽고_docker_desktop과_빈_줄을_뺀다() {
        let out = utf16("\u{feff}Ubuntu-22.04\r\ndocker-desktop\r\n\r\nDebian\r\ndocker-desktop-data\r\n");
        assert_eq!(super::parse_wsl_list(&out), ["Ubuntu-22.04", "Debian"]);
        assert!(super::parse_wsl_list(&[]).is_empty());
    }
}
