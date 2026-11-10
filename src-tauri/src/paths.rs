//! 앱 데이터(profiles.json, settings.json, secrets.json 등)를 두는 곳.
//!
//! Windows와 그 밖의 OS는 실행 파일과 같은 폴더(portable 실행을 위해).
//! macOS는 앱 번들(`ToyTerm.app`) 안에 쓸 수 없거나 쓰면 안 되므로
//! `~/Library/Application Support/com.toy.terminal/`에 둔다.

use std::path::{Path, PathBuf};

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn mac_data_dir(home: &Path) -> PathBuf {
    home.join("Library").join("Application Support").join("com.toy.terminal")
}

#[cfg(target_os = "macos")]
pub fn data_path(name: &str) -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or_else(|| "홈 폴더를 알 수 없습니다".to_string())?;
    let dir = mac_data_dir(Path::new(&home));
    std::fs::create_dir_all(&dir).map_err(|e| format!("데이터 폴더를 만들 수 없습니다: {e}"))?;
    Ok(dir.join(name))
}

#[cfg(not(target_os = "macos"))]
pub fn data_path(name: &str) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("실행 파일 위치를 알 수 없습니다: {e}"))?;
    Ok(exe.with_file_name(name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 맥_데이터_폴더는_홈_아래_application_support다() {
        assert_eq!(
            mac_data_dir(Path::new("/Users/me")),
            Path::new("/Users/me/Library/Application Support/com.toy.terminal")
        );
    }

    #[test]
    fn 파일_이름이_경로에_붙는다() {
        let p = data_path("settings.json").unwrap();
        assert_eq!(p.file_name().unwrap(), "settings.json");
    }
}
