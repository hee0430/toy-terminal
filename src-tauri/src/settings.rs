use std::path::PathBuf;

/// 실행 파일과 같은 폴더의 settings.json. 내용(JSON)은 프론트가 소유하고 백엔드는 읽고 쓰기만 한다.
fn path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("실행 파일 위치를 알 수 없습니다: {e}"))?;
    Ok(exe.with_file_name("settings.json"))
}

#[tauri::command]
pub fn settings_load() -> Result<Option<String>, String> {
    match std::fs::read_to_string(path()?) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("설정을 읽을 수 없습니다: {e}")),
    }
}

#[tauri::command]
pub fn settings_save(json: String) -> Result<(), String> {
    // 깨진 JSON으로 기존 파일을 덮어쓰지 않도록 먼저 검증한다.
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| e.to_string())?;
    let p = path()?;
    let tmp = p.with_extension("json.tmp");
    let werr = |e: std::io::Error| format!("설정을 저장할 수 없습니다 ({}): {e}", p.display());
    std::fs::write(&tmp, json).map_err(werr)?;
    std::fs::rename(&tmp, &p).map_err(werr)
}
