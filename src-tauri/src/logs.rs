//! 기록 파일: 실행 파일 옆 `logs` 폴더에 `<종류>-<날짜>.jsonl` 로 한 줄씩 덧붙인다 (날마다 파일 하나).
//! 파일 이름은 화면이 보내 주지만, 경로를 벗어나지 못하도록 종류와 날짜 형식을 엄격히 검사한다.

use std::io::Write;
use std::path::{Path, PathBuf};

/// 기록할 수 있는 종류. 새 종류를 쓰려면 여기에 추가한다.
const KINDS: &[&str] = &["ai", "audit"];
const MAX_LINE_BYTES: usize = 1024 * 1024;

fn logs_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("실행 파일 위치를 알 수 없습니다: {e}"))?;
    Ok(exe.with_file_name("logs"))
}

/// `YYYY-MM-DD` 모양인가 (숫자와 '-'만, 길이 10)
fn valid_date(date: &str) -> bool {
    let b = date.as_bytes();
    b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

fn log_path(dir: &Path, kind: &str, date: &str) -> Result<PathBuf, String> {
    if !KINDS.contains(&kind) {
        return Err(format!("알 수 없는 기록 종류입니다: {kind}"));
    }
    if !valid_date(date) {
        return Err("날짜 형식이 올바르지 않습니다".into());
    }
    Ok(dir.join(format!("{kind}-{date}.jsonl")))
}

fn append(dir: &Path, kind: &str, date: &str, line: &str) -> Result<(), String> {
    if line.len() > MAX_LINE_BYTES {
        return Err("기록할 내용이 너무 큽니다".into());
    }
    let path = log_path(dir, kind, date)?;
    std::fs::create_dir_all(dir).map_err(|e| format!("logs 폴더를 만들 수 없습니다: {e}"))?;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&path).map_err(|e| format!("기록 파일을 열 수 없습니다 ({}): {e}", path.display()))?;
    // 줄 하나로 유지한다: 줄바꿈이 섞여 들어와도 한 기록이 여러 줄로 갈라지지 않게 공백으로 바꾼다.
    let one_line = line.replace(['\r', '\n'], " ");
    f.write_all(one_line.as_bytes()).and_then(|_| f.write_all(b"\n")).map_err(|e| format!("기록을 쓸 수 없습니다: {e}"))
}

/// 기록 한 줄을 덧붙인다. line은 화면이 만든 JSON 한 줄이다.
#[tauri::command]
pub fn log_append(kind: String, date: String, line: String) -> Result<(), String> {
    // 감사 기록(audit)은 화면이 쓸 수 없다. 백엔드가 `audit()`로만 남기므로 위조할 수 없다.
    if kind != "ai" {
        return Err(format!("화면에서 기록할 수 없는 종류입니다: {kind}"));
    }
    append(&logs_dir()?, &kind, &date, &line)
}

/// 명령 실행 감사 기록 (`logs/audit-날짜.jsonl`). 백엔드 전용이고 끌 수 없다.
pub fn audit(date: &str, line: &str) -> Result<(), String> {
    append(&logs_dir()?, "audit", date, line)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_is_limited_to_known_kind_and_date_format() {
        let d = Path::new("logs");
        assert_eq!(log_path(d, "ai", "2026-11-06").unwrap(), d.join("ai-2026-11-06.jsonl"));
        for (kind, date) in [("../x", "2026-11-06"), ("ai", "../../etc/x"), ("ai", "2026-11-6"), ("ai", "2026/11/06"), ("ai", ""), ("ai", "2026-11-06\\.."), ("other", "2026-11-06")] {
            assert!(log_path(d, kind, date).is_err(), "{kind} {date}");
        }
    }

    #[test]
    fn appends_one_line_per_record_even_if_text_contains_newlines() {
        let dir = std::env::temp_dir().join("toyterm-logs-test");
        let _ = std::fs::remove_dir_all(&dir);
        append(&dir, "ai", "2026-11-06", r#"{"a":1}"#).unwrap();
        append(&dir, "ai", "2026-11-06", "{\"b\":\"x\ny\"}").unwrap(); // 줄바꿈이 섞인 경우
        let text = std::fs::read_to_string(dir.join("ai-2026-11-06.jsonl")).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert!(text.ends_with('\n'));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_oversized_line() {
        let dir = std::env::temp_dir().join("toyterm-logs-test-big");
        assert!(append(&dir, "ai", "2026-11-06", &"a".repeat(MAX_LINE_BYTES + 1)).is_err());
        assert!(!dir.exists()); // 거절하면 폴더도 만들지 않는다
    }
}
