use std::path::{Path, PathBuf};
use std::sync::Arc;

use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::{AppState, Session};

#[derive(Serialize)]
pub struct Entry {
    name: String,
    is_dir: bool,
    size: u64,
    /// unix epoch 초
    modified: u64,
}

#[derive(Serialize)]
pub struct Listing {
    /// 서버가 해석한 절대 경로
    path: String,
    entries: Vec<Entry>,
}

/// '.', '..', 중복 '/'만 정리한다. 심볼릭 링크는 풀지 않는다.
fn normalize(path: &str) -> String {
    let mut parts: Vec<&str> = vec![];
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    format!("/{}", parts.join("/"))
}

/// SSH 탭의 연결 위에서 SFTP 서브시스템을 처음 쓸 때 열고, 이후 재사용한다.
pub(crate) async fn get(state: &AppState, id: &str) -> Result<Arc<SftpSession>, String> {
    if let Some(s) = state.sftps.lock().await.get(id) {
        return Ok(s.clone());
    }
    let handle = {
        let map = state.sessions.lock().unwrap();
        match map.get(id) {
            Some(Session::Ssh(s)) => s.handle.clone(),
            _ => return Err("SFTP는 SSH 탭에서만 사용할 수 있습니다".into()),
        }
    };
    let channel = handle.channel_open_session().await.map_err(|e| e.to_string())?;
    channel.request_subsystem(true, "sftp").await.map_err(|e| e.to_string())?;
    let sftp = Arc::new(SftpSession::new(channel.into_stream()).await.map_err(|e| e.to_string())?);
    state.sftps.lock().await.insert(id.to_string(), sftp.clone());
    Ok(sftp)
}

#[tauri::command]
pub async fn sftp_list(state: State<'_, AppState>, id: String, path: String) -> Result<Listing, String> {
    let sftp = get(&state, &id).await?;
    // 절대 경로는 심볼릭 링크를 풀지 않고 그대로 보여 준다(셸의 cd 경로와 같은 방식).
    // 비어 있거나 상대 경로일 때만 서버에 물어 홈 디렉터리 등을 알아낸다.
    let path = if path.starts_with('/') {
        normalize(&path)
    } else {
        sftp.canonicalize(if path.is_empty() { "." } else { &path }).await.map_err(|e| e.to_string())?
    };
    let mut entries: Vec<Entry> = vec![];
    for e in sftp.read_dir(path.clone()).await.map_err(|e| e.to_string())? {
        let name = e.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let m = e.metadata();
        let mut is_dir = e.file_type().is_dir();
        // 폴더를 가리키는 심볼릭 링크는 폴더로 보여 줘야 들어갈 수 있다.
        if e.file_type().is_symlink() {
            let full = format!("{}/{}", path.trim_end_matches('/'), name);
            if let Ok(target) = sftp.metadata(full).await {
                is_dir = target.file_type().is_dir();
            }
        }
        entries.push(Entry { name, is_dir, size: m.size.unwrap_or(0), modified: m.mtime.unwrap_or(0) as u64 });
    }
    // 폴더 먼저, 이름순
    entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(Listing { path, entries })
}

#[derive(Deserialize)]
pub struct RemoteItem {
    path: String,
    name: String,
    is_dir: bool,
}

#[derive(Serialize)]
pub struct PlanFile {
    remote: String,
    local: String,
    /// 저장할 위치에 같은 이름의 파일이 이미 있는가
    exists: bool,
}

#[derive(Serialize)]
pub struct DownloadPlan {
    files: Vec<PlanFile>,
    /// 만들어야 할 로컬 폴더 (빈 폴더 포함)
    dirs: Vec<String>,
    /// 이름이 안전하지 않아 제외한 항목 수
    skipped: usize,
}

/// Windows가 파일이 아니라 장치로 다루는 이름 (확장자가 붙어도 같다: `CON.txt`, `nul.log`).
const RESERVED: [&str; 4] = ["CON", "PRN", "AUX", "NUL"];

fn is_reserved_device_name(name: &str) -> bool {
    // 첫 '.' 앞이 이름이다. Windows는 이름 끝의 공백도 무시한다 (`CON .txt`).
    let stem = name.split('.').next().unwrap_or("").trim_end().to_ascii_uppercase();
    RESERVED.contains(&stem.as_str())
        || ["COM", "LPT"].iter().any(|p| stem.strip_prefix(p).is_some_and(|n| n.len() == 1 && matches!(n.as_bytes()[0], b'1'..=b'9')))
}

/// 서버가 준 이름이 로컬 경로를 벗어나거나 엉뚱한 곳에 쓰이지 못하도록 막는다.
/// - 경로를 벗어나는 이름: `..`, `a/b`, `..\..\x`, `C:x`
/// - Windows 장치 이름(`CON`, `NUL`, `COM1`…): 파일 대신 장치에 쓰게 된다
/// - 끝이 점이나 공백인 이름: Windows가 그 문자를 지워서 다른 파일과 같은 이름이 된다 (`a.txt.` → `a.txt`)
pub(crate) fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains(['/', '\\', ':', '\0'])
        && !name.ends_with(['.', ' '])
        && !is_reserved_device_name(name)
}

/// 선택한 파일·폴더를 하위까지 풀어서 내려받을 파일 목록을 만든다. 심볼릭 링크 폴더는 따라가지 않는다.
#[tauri::command]
pub async fn sftp_plan_download(
    state: State<'_, AppState>,
    id: String,
    items: Vec<RemoteItem>,
    dest: String,
) -> Result<DownloadPlan, String> {
    let sftp = get(&state, &id).await?;
    let dest = std::path::PathBuf::from(dest);
    let mut plan = DownloadPlan { files: vec![], dirs: vec![], skipped: 0 };
    let mut stack: Vec<(String, std::path::PathBuf)> = vec![];

    fn add_file(plan: &mut DownloadPlan, remote: String, local: std::path::PathBuf) {
        plan.files.push(PlanFile { remote, exists: local.exists(), local: local.to_string_lossy().into_owned() });
    }

    for it in items {
        if !safe_name(&it.name) {
            plan.skipped += 1;
            continue;
        }
        let local = dest.join(&it.name);
        if it.is_dir {
            stack.push((it.path, local));
        } else {
            add_file(&mut plan, it.path, local);
        }
    }
    while let Some((remote, local)) = stack.pop() {
        plan.dirs.push(local.to_string_lossy().into_owned());
        let entries = sftp.read_dir(remote.clone()).await.map_err(|e| format!("{remote}: {e}"))?;
        for e in entries {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            if !safe_name(&name) {
                plan.skipped += 1;
                continue;
            }
            let r = format!("{}/{}", remote.trim_end_matches('/'), name);
            let l = local.join(&name);
            if e.file_type().is_dir() {
                stack.push((r, l));
            } else {
                add_file(&mut plan, r, l);
            }
        }
    }
    Ok(plan)
}

#[tauri::command]
pub async fn local_mkdirs(paths: Vec<String>) -> Result<(), String> {
    for p in paths {
        tokio::fs::create_dir_all(&p).await.map_err(|e| format!("폴더를 만들 수 없습니다 ({p}): {e}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_download(state: State<'_, AppState>, id: String, remote: String, local: String) -> Result<(), String> {
    let sftp = get(&state, &id).await?;
    let mut src = sftp.open(remote).await.map_err(|e| e.to_string())?;
    let mut dst = tokio::fs::File::create(local).await.map_err(|e| e.to_string())?;
    tokio::io::copy(&mut src, &mut dst).await.map_err(|e| e.to_string())?;
    dst.flush().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_upload(state: State<'_, AppState>, id: String, local: String, remote: String) -> Result<(), String> {
    let sftp = get(&state, &id).await?;
    let mut src = tokio::fs::File::open(local).await.map_err(|e| e.to_string())?;
    let mut dst = sftp.create(remote).await.map_err(|e| e.to_string())?;
    // 큰 파일도 메모리를 다 쓰지 않도록 청크 단위로 복사
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = src.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
    }
    dst.shutdown().await.map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct UploadFile {
    local: String,
    remote: String,
}

#[derive(Serialize)]
pub struct UploadPlan {
    files: Vec<UploadFile>,
    /// 만들어야 할 원격 폴더. 상위 폴더가 항상 먼저 온다.
    dirs: Vec<String>,
    /// 끌어다 놓은 항목 중 서버에 같은 이름이 이미 있는 수
    existing: usize,
    /// 심볼릭 링크처럼 올리지 않고 건너뛴 수
    skipped: usize,
}

const MAX_UPLOAD_ITEMS: usize = 20_000;

struct Walk {
    files: Vec<(PathBuf, String)>,
    dirs: Vec<String>,
    /// 최상위 항목의 원격 경로 (이미 있는지 확인용)
    tops: Vec<String>,
    skipped: usize,
}

/// 로컬 경로들을 하위까지 풀어 (올릴 파일, 만들 원격 폴더)를 만든다. 심볼릭 링크는 따라가지 않는다.
fn walk_local(paths: &[PathBuf], dest: &str) -> Result<Walk, String> {
    let base = dest.trim_end_matches('/');
    let mut w = Walk { files: vec![], dirs: vec![], tops: vec![], skipped: 0 };
    let mut stack: Vec<(PathBuf, String)> = vec![];
    let err = |p: &Path, e: std::io::Error| format!("{}: {e}", p.display());

    for p in paths {
        let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
            w.skipped += 1;
            continue;
        };
        let remote = format!("{base}/{name}");
        let ft = std::fs::symlink_metadata(p).map_err(|e| err(p, e))?.file_type();
        if ft.is_dir() {
            w.tops.push(remote.clone());
            stack.push((p.clone(), remote));
        } else if ft.is_file() {
            w.tops.push(remote.clone());
            w.files.push((p.clone(), remote));
        } else {
            w.skipped += 1; // 심볼릭 링크 등
        }
    }
    // 폴더는 꺼낼 때 dirs에 넣으므로, 자식은 항상 부모보다 뒤에 온다.
    while let Some((local, remote)) = stack.pop() {
        w.dirs.push(remote.clone());
        for entry in std::fs::read_dir(&local).map_err(|e| err(&local, e))? {
            let entry = entry.map_err(|e| err(&local, e))?;
            let ft = entry.file_type().map_err(|e| err(&entry.path(), e))?;
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                w.skipped += 1;
                continue;
            };
            let r = format!("{remote}/{name}");
            if ft.is_dir() {
                stack.push((entry.path(), r));
            } else if ft.is_file() {
                w.files.push((entry.path(), r));
            } else {
                w.skipped += 1;
            }
            if w.files.len() + w.dirs.len() > MAX_UPLOAD_ITEMS {
                return Err(format!("항목이 너무 많습니다 (최대 {MAX_UPLOAD_ITEMS}개)"));
            }
        }
    }
    Ok(w)
}

/// 탐색기에서 끌어다 놓은 파일·폴더를 하위까지 풀어서 올릴 목록을 만든다.
#[tauri::command]
pub async fn sftp_plan_upload(state: State<'_, AppState>, id: String, paths: Vec<String>, dest: String) -> Result<UploadPlan, String> {
    let sftp = get(&state, &id).await?;
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let dest2 = dest.clone();
    // 폴더가 크면 오래 걸리므로 화면이 멈추지 않게 따로 돌린다.
    let w = tokio::task::spawn_blocking(move || walk_local(&paths, &dest2)).await.map_err(|e| e.to_string())??;
    let mut existing = 0;
    for top in &w.tops {
        if sftp.metadata(top.clone()).await.is_ok() {
            existing += 1;
        }
    }
    Ok(UploadPlan {
        files: w.files.into_iter().map(|(l, r)| UploadFile { local: l.to_string_lossy().into_owned(), remote: r }).collect(),
        dirs: w.dirs,
        existing,
        skipped: w.skipped,
    })
}

/// 원격 폴더들을 만든다. 이미 있으면 넘어간다.
#[tauri::command]
pub async fn sftp_mkdirs(state: State<'_, AppState>, id: String, paths: Vec<String>) -> Result<(), String> {
    let sftp = get(&state, &id).await?;
    for p in paths {
        if sftp.metadata(p.clone()).await.is_ok() {
            continue;
        }
        sftp.create_dir(p.clone()).await.map_err(|e| format!("{p}: {e}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{normalize, safe_name, walk_local};
    use std::path::PathBuf;

    #[test]
    fn walk_local_lists_files_and_parents_first() {
        let root = std::env::temp_dir().join("toyterm-walk-test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("proj/sub")).unwrap();
        std::fs::write(root.join("proj/a.txt"), "a").unwrap();
        std::fs::write(root.join("proj/sub/b.txt"), "b").unwrap();
        std::fs::write(root.join("top.txt"), "t").unwrap();

        let w = walk_local(&[root.join("proj"), root.join("top.txt")], "/srv/").unwrap();
        let mut remotes: Vec<&str> = w.files.iter().map(|(_, r)| r.as_str()).collect();
        remotes.sort();
        assert_eq!(remotes, ["/srv/proj/a.txt", "/srv/proj/sub/b.txt", "/srv/top.txt"]);
        // 부모 폴더가 자식보다 먼저 만들어져야 한다
        let pos = |d: &str| w.dirs.iter().position(|x| x == d).unwrap();
        assert!(pos("/srv/proj") < pos("/srv/proj/sub"));
        assert_eq!(w.tops, ["/srv/proj", "/srv/top.txt"]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn walk_local_rejects_missing_path() {
        let missing = PathBuf::from("Z:/no/such/path/xyz");
        assert!(walk_local(&[missing], "/").is_err());
    }

    #[test]
    fn normalize_keeps_symlink_names() {
        assert_eq!(normalize("/data/link/../x//y/."), "/data/x/y");
        assert_eq!(normalize("/"), "/");
        assert_eq!(normalize("/a/../.."), "/");
    }

    #[test]
    fn safe_name_blocks_path_escape() {
        assert!(safe_name("file.txt"));
        assert!(safe_name("한글 폴더"));
        for bad in ["", ".", "..", "a/b", "..\\..\\x", "C:evil", "a\0b"] {
            assert!(!safe_name(bad), "{bad:?}");
        }
    }

    #[test]
    fn safe_name_blocks_windows_device_and_trailing_dot_names() {
        for bad in ["CON", "con", "Nul.txt", "AUX.tar.gz", "PRN", "COM1", "lpt9.log", "COM5.txt", "CON .txt", "a.txt.", "a.txt ", "name "] {
            assert!(!safe_name(bad), "{bad:?}");
        }
        // 비슷하지만 장치 이름이 아닌 것은 허용한다
        for ok in ["console.log", "COM", "COM0", "COM10", "LPT", "conf", "nulls.txt", "auxiliary", ".bashrc", "a.b"] {
            assert!(safe_name(ok), "{ok:?}");
        }
    }
}

#[tauri::command]
pub async fn sftp_mkdir(state: State<'_, AppState>, id: String, path: String) -> Result<(), String> {
    get(&state, &id).await?.create_dir(path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_remove(state: State<'_, AppState>, id: String, path: String, is_dir: bool) -> Result<(), String> {
    let sftp = get(&state, &id).await?;
    let r = if is_dir { sftp.remove_dir(path).await } else { sftp.remove_file(path).await };
    r.map_err(|e| e.to_string())
}
