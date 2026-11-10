//! 세션 아이콘: URL의 이미지를 한 번 내려받아 실행 파일 옆 `icons/` 폴더에 저장하고, 화면에는 data URL로 돌려준다.
//! SVG는 지원하지 않는다 (스크립트를 담을 수 있으므로). 형식은 확장자나 Content-Type이 아니라 파일 앞부분 바이트로 판별한다.

use std::path::PathBuf;
use std::time::Duration;

const MAX_BYTES: usize = 1024 * 1024;

fn dir() -> Result<PathBuf, String> {
    crate::paths::data_path("icons")
}

/// (확장자, MIME). 지원하지 않는 형식이면 None.
fn sniff(b: &[u8]) -> Option<(&'static str, &'static str)> {
    if b.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some(("png", "image/png"))
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(("jpg", "image/jpeg"))
    } else if b.starts_with(b"GIF87a") || b.starts_with(b"GIF89a") {
        Some(("gif", "image/gif"))
    } else if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some(("webp", "image/webp"))
    } else if b.starts_with(&[0, 0, 1, 0]) {
        Some(("ico", "image/x-icon"))
    } else {
        None
    }
}

/// 화면이 보낸 파일 이름이 icons 폴더 밖을 가리키지 못하게 한다.
fn valid_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.contains("..")
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

fn check_url(url: &str) -> Result<(), String> {
    let lower = url.trim().to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        Ok(())
    } else {
        Err("http:// 또는 https:// 로 시작하는 주소만 사용할 수 있습니다".into())
    }
}

/// 주소의 이미지를 내려받아 저장하고 파일 이름을 돌려준다.
#[tauri::command]
pub async fn icon_download(url: String) -> Result<String, String> {
    check_url(&url)?;
    // reqwest는 암호 제공자를 직접 받으므로 ring을 한 번 등록한다 (이미 등록돼 있으면 무시).
    let _ = rustls::crypto::ring::default_provider().install_default();

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let mut resp = client
        .get(url.trim())
        .send()
        .await
        .map_err(|e| format!("아이콘을 내려받지 못했습니다: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("서버가 오류를 돌려줬습니다 (HTTP {})", resp.status().as_u16()));
    }
    if resp.content_length().is_some_and(|n| n as usize > MAX_BYTES) {
        return Err("아이콘이 너무 큽니다 (최대 1MB)".into());
    }
    // 길이를 알리지 않는 응답도 있으므로 받는 도중에도 한도를 지킨다.
    let mut bytes: Vec<u8> = vec![];
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("아이콘을 내려받지 못했습니다: {e}"))? {
        bytes.extend_from_slice(&chunk);
        if bytes.len() > MAX_BYTES {
            return Err("아이콘이 너무 큽니다 (최대 1MB)".into());
        }
    }
    let (ext, _) = sniff(&bytes).ok_or("지원하지 않는 형식입니다 (png, jpg, gif, webp, ico만 가능, SVG 불가)")?;

    let mut rnd = [0u8; 8];
    getrandom::fill(&mut rnd).map_err(|e| e.to_string())?;
    let name = format!("{}.{ext}", rnd.iter().map(|b| format!("{b:02x}")).collect::<String>());
    let dir = dir()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("icons 폴더를 만들 수 없습니다: {e}"))?;
    std::fs::write(dir.join(&name), &bytes).map_err(|e| format!("아이콘을 저장할 수 없습니다: {e}"))?;
    Ok(name)
}

/// 저장된 아이콘을 `data:` URL로 읽는다.
#[tauri::command]
pub fn icon_read(file: String) -> Result<String, String> {
    use base64::Engine;
    if !valid_file_name(&file) {
        return Err("올바르지 않은 아이콘 파일 이름입니다".into());
    }
    let bytes = std::fs::read(dir()?.join(&file)).map_err(|e| format!("아이콘을 읽을 수 없습니다 ({file}): {e}"))?;
    let (_, mime) = sniff(&bytes).ok_or("지원하지 않는 형식입니다")?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sniff_accepts_images_and_rejects_svg_and_html() {
        assert!(sniff(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0]).is_some());
        assert!(sniff(b"GIF89a....").is_some());
        assert!(sniff(b"RIFF\0\0\0\0WEBPVP8 ").is_some());
        // 확장자나 Content-Type을 속여도 내용으로 거른다
        assert!(sniff(b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>").is_none());
        assert!(sniff(b"<html><script>alert(1)</script>").is_none());
        assert!(sniff(b"").is_none());
    }

    #[test]
    fn file_name_cannot_escape_icons_dir() {
        assert!(valid_file_name("0a1b2c3d4e5f6071.png"));
        for bad in ["", "../x.png", "..\\x.png", "a/b.png", "C:x.png", "a b.png", &"a".repeat(65)] {
            assert!(!valid_file_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn url_scheme_is_limited_to_http() {
        assert!(check_url("https://example.com/a.png").is_ok());
        assert!(check_url(" HTTP://example.com/a.png").is_ok());
        for bad in ["file:///C:/x.png", "ftp://x/y.png", "javascript:alert(1)", "example.com/a.png", ""] {
            assert!(check_url(bad).is_err(), "{bad:?}");
        }
    }
}
