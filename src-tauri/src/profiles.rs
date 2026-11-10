use std::path::PathBuf;

use tauri::{AppHandle, Manager};

/// 실행 파일과 같은 폴더의 profiles.json. 폴더에 쓸 수 없으면 저장 시 오류가 난다.
fn path(app: &AppHandle) -> Result<PathBuf, String> {
    let new = crate::paths::data_path("profiles.json")?;
    // 예전 위치(%APPDATA%)에만 파일이 있으면 처음 한 번 복사해 온다. 원본은 지우지 않는다.
    if !new.exists() {
        if let Ok(old) = app.path().app_config_dir().map(|d| d.join("profiles.json")) {
            if old.exists() {
                let _ = std::fs::copy(&old, &new);
            }
        }
    }
    Ok(new)
}

/// 트리 구조는 프론트가 소유한다. 백엔드는 JSON 문자열을 그대로 읽고 쓰기만 한다.
#[tauri::command]
pub fn profiles_load(app: AppHandle) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path(&app)?) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// 이 PC의 OpenSSH 설정(~/.ssh/config)을 그대로 읽어 돌려준다. 파싱은 프론트가 한다. 파일이 없으면 None.
#[tauri::command]
pub fn ssh_config_load() -> Result<Option<String>, String> {
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) else {
        return Ok(None);
    };
    let p = PathBuf::from(home).join(".ssh").join("config");
    match std::fs::read_to_string(&p) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("{} 을(를) 읽을 수 없습니다: {e}", p.display())),
    }
}

#[tauri::command]
pub fn profiles_save(app: AppHandle, json: String) -> Result<(), String> {
    // 깨진 JSON으로 기존 파일을 덮어쓰지 않도록 먼저 검증한다.
    serde_json::from_str::<serde_json::Value>(&json).map_err(|e| e.to_string())?;
    let p = path(&app)?;
    // 임시 파일에 쓴 뒤 교체해서, 쓰는 도중 종료돼도 기존 파일이 남게 한다.
    let tmp = p.with_extension("json.tmp");
    let werr = |e: std::io::Error| format!("프로필을 저장할 수 없습니다 ({}): {e}", p.display());
    std::fs::write(&tmp, json).map_err(werr)?;
    std::fs::rename(&tmp, &p).map_err(werr)
}
