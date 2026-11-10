//! 저장한 비밀번호(SSH 비밀번호, 키 암호). 사용자가 입력하는 마스터 비밀번호로 암호화하고, 마스터 비밀번호 자체는 어디에도 저장하지 않는다.
//!
//! - 키: 마스터 비밀번호 + 무작위 salt → Argon2id → 32바이트. 키도 디스크에 쓰지 않고, 잠금을 푼 뒤 앱이 켜져 있는 동안 메모리에만 둔다.
//! - 암호화: AES-256-GCM, 항목마다 무작위 nonce. 항목 id(프로필 id)를 추가 인증 데이터로 묶어서 항목끼리 바꿔치기할 수 없다.
//! - 마스터 비밀번호가 맞는지는 고정 문구를 암호화해 둔 검증값으로 확인한다.
//! - 마스터 비밀번호를 잊으면 복구할 수 없다. 그때는 전체 삭제(`secrets_reset`) 후 새로 정한다.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Mutex;

use aes_gcm::aead::{Aead, Generate, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::Argon2;
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::{Deserialize, Serialize};
use tauri::State;
use zeroize::Zeroizing;

const VERIFY_PLAIN: &[u8] = b"toyterm-vault-ok";
/// 검증값의 추가 인증 데이터. 프로필 id와 겹치지 않는 값
const VERIFY_AAD: &str = "\u{0}verify";
const MIN_MASTER_LEN: usize = 8;
const WRONG_MASTER: &str = "마스터 비밀번호가 틀렸습니다";

type Key = Zeroizing<[u8; 32]>;

#[derive(Serialize, Deserialize, Clone)]
pub struct Sealed {
    nonce: String,
    ct: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Vault {
    version: u32,
    salt: String,
    verifier: Sealed,
    entries: BTreeMap<String, Sealed>,
}

fn derive(master: &str, salt: &[u8]) -> Result<Key, String> {
    let mut key = Zeroizing::new([0u8; 32]);
    Argon2::default().hash_password_into(master.as_bytes(), salt, &mut *key).map_err(|e| format!("키를 만들 수 없습니다: {e}"))?;
    Ok(key)
}

fn seal(key: &Key, aad: &str, plain: &[u8]) -> Result<Sealed, String> {
    let cipher = Aes256Gcm::new_from_slice(&key[..]).map_err(|e| e.to_string())?;
    let nonce = Nonce::generate();
    let ct = cipher.encrypt(&nonce, Payload { msg: plain, aad: aad.as_bytes() }).map_err(|_| "암호화하지 못했습니다".to_string())?;
    Ok(Sealed { nonce: B64.encode(nonce.as_slice()), ct: B64.encode(ct) })
}

fn open(key: &Key, aad: &str, s: &Sealed) -> Result<Vec<u8>, String> {
    let cipher = Aes256Gcm::new_from_slice(&key[..]).map_err(|e| e.to_string())?;
    let nonce_bytes = B64.decode(&s.nonce).map_err(|_| "저장된 비밀번호 파일이 손상되었습니다".to_string())?;
    let nonce = Nonce::try_from(&nonce_bytes[..]).map_err(|_| "저장된 비밀번호 파일이 손상되었습니다".to_string())?;
    let ct = B64.decode(&s.ct).map_err(|_| "저장된 비밀번호 파일이 손상되었습니다".to_string())?;
    cipher.decrypt(&nonce, Payload { msg: &ct, aad: aad.as_bytes() }).map_err(|_| WRONG_MASTER.to_string())
}

fn check_master(master: &str) -> Result<(), String> {
    if master.chars().count() < MIN_MASTER_LEN {
        return Err(format!("마스터 비밀번호는 {MIN_MASTER_LEN}자 이상이어야 합니다"));
    }
    Ok(())
}

impl Vault {
    fn create(master: &str) -> Result<(Vault, Key), String> {
        check_master(master)?;
        let mut salt = [0u8; 16];
        getrandom::fill(&mut salt).map_err(|e| format!("난수를 만들 수 없습니다: {e}"))?;
        let key = derive(master, &salt)?;
        let verifier = seal(&key, VERIFY_AAD, VERIFY_PLAIN)?;
        Ok((Vault { version: 1, salt: B64.encode(salt), verifier, entries: BTreeMap::new() }, key))
    }

    fn unlock(&self, master: &str) -> Result<Key, String> {
        let salt = B64.decode(&self.salt).map_err(|_| "저장된 비밀번호 파일이 손상되었습니다".to_string())?;
        let key = derive(master, &salt)?;
        match open(&key, VERIFY_AAD, &self.verifier) {
            Ok(p) if p == VERIFY_PLAIN => Ok(key),
            _ => Err(WRONG_MASTER.to_string()),
        }
    }

    /// 새 마스터 비밀번호로 모든 항목을 다시 암호화한다. 새 salt를 쓴다.
    fn rekey(&self, old: &str, new: &str) -> Result<(Vault, Key), String> {
        let old_key = self.unlock(old)?;
        let (mut fresh, new_key) = Vault::create(new)?;
        for (id, s) in &self.entries {
            let plain = Zeroizing::new(open(&old_key, id, s)?);
            fresh.entries.insert(id.clone(), seal(&new_key, id, &plain)?);
        }
        Ok((fresh, new_key))
    }
}

// ---------- 파일과 명령 ----------

#[derive(Default)]
pub struct SecretsState {
    key: Mutex<Option<Key>>,
}

/// 실행 파일과 같은 폴더의 secrets.json (profiles.json과 같은 곳)
fn path() -> Result<PathBuf, String> {
    crate::paths::data_path("secrets.json")
}

fn load() -> Result<Option<Vault>, String> {
    match std::fs::read_to_string(path()?) {
        Ok(s) => serde_json::from_str(&s).map(Some).map_err(|_| "저장된 비밀번호 파일이 손상되었습니다".to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn store(v: &Vault) -> Result<(), String> {
    let p = path()?;
    let tmp = p.with_extension("json.tmp");
    let werr = |e: std::io::Error| format!("비밀번호를 저장할 수 없습니다 ({}): {e}", p.display());
    let json = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, json).map_err(werr)?;
    std::fs::rename(&tmp, &p).map_err(werr)
}

#[derive(Serialize)]
pub struct Status {
    /// 마스터 비밀번호가 이미 정해져 있는가
    exists: bool,
    unlocked: bool,
    /// 비밀번호가 저장된 프로필 id (잠겨 있어도 알 수 있다)
    ids: Vec<String>,
}

#[tauri::command]
pub fn secrets_status(state: State<'_, SecretsState>) -> Result<Status, String> {
    let unlocked = state.key.lock().unwrap().is_some();
    Ok(match load()? {
        Some(v) => Status { exists: true, unlocked, ids: v.entries.keys().cloned().collect() },
        None => Status { exists: false, unlocked: false, ids: vec![] },
    })
}

/// 처음 마스터 비밀번호를 정한다. 이미 있으면 거부한다 (바꾸려면 `secrets_change_master`).
#[tauri::command]
pub fn secrets_setup(state: State<'_, SecretsState>, master: String) -> Result<(), String> {
    if load()?.is_some() {
        return Err("마스터 비밀번호가 이미 있습니다".into());
    }
    let (vault, key) = Vault::create(&master)?;
    store(&vault)?;
    *state.key.lock().unwrap() = Some(key);
    Ok(())
}

#[tauri::command]
pub fn secrets_unlock(state: State<'_, SecretsState>, master: String) -> Result<(), String> {
    let vault = load()?.ok_or("마스터 비밀번호가 아직 없습니다")?;
    let key = vault.unlock(&master)?;
    *state.key.lock().unwrap() = Some(key);
    Ok(())
}

#[tauri::command]
pub fn secrets_save(state: State<'_, SecretsState>, id: String, secret: String) -> Result<(), String> {
    let guard = state.key.lock().unwrap();
    let key = guard.as_ref().ok_or("잠겨 있습니다. 마스터 비밀번호를 먼저 입력하세요")?;
    let mut vault = load()?.ok_or("마스터 비밀번호가 아직 없습니다")?;
    vault.entries.insert(id.clone(), seal(key, &id, secret.as_bytes())?);
    store(&vault)
}

#[tauri::command]
pub fn secrets_get(state: State<'_, SecretsState>, id: String) -> Result<Option<String>, String> {
    let guard = state.key.lock().unwrap();
    let key = guard.as_ref().ok_or("잠겨 있습니다. 마스터 비밀번호를 먼저 입력하세요")?;
    let Some(vault) = load()? else { return Ok(None) };
    let Some(s) = vault.entries.get(&id) else { return Ok(None) };
    let plain = Zeroizing::new(open(key, &id, s)?);
    String::from_utf8(plain.to_vec()).map(Some).map_err(|_| "저장된 비밀번호 파일이 손상되었습니다".to_string())
}

/// 항목 하나를 지운다. 지우는 데는 마스터 비밀번호가 필요 없다.
#[tauri::command]
pub fn secrets_delete(id: String) -> Result<(), String> {
    let Some(mut vault) = load()? else { return Ok(()) };
    if vault.entries.remove(&id).is_some() {
        store(&vault)?;
    }
    Ok(())
}

#[tauri::command]
pub fn secrets_change_master(state: State<'_, SecretsState>, old: String, new: String) -> Result<(), String> {
    let vault = load()?.ok_or("마스터 비밀번호가 아직 없습니다")?;
    let (fresh, key) = vault.rekey(&old, &new)?;
    store(&fresh)?;
    *state.key.lock().unwrap() = Some(key);
    Ok(())
}

/// 마스터 비밀번호를 잊었을 때: 저장된 비밀번호와 마스터 비밀번호를 모두 지운다. 되돌릴 수 없다.
#[tauri::command]
pub fn secrets_reset(state: State<'_, SecretsState>) -> Result<(), String> {
    match std::fs::remove_file(path()?) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.to_string()),
    }
    *state.key.lock().unwrap() = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vault_with(master: &str, items: &[(&str, &str)]) -> (Vault, Key) {
        let (mut v, key) = Vault::create(master).unwrap();
        for (id, secret) in items {
            v.entries.insert((*id).into(), seal(&key, id, secret.as_bytes()).unwrap());
        }
        (v, key)
    }

    #[test]
    fn right_master_opens_wrong_master_is_rejected() {
        let (v, key) = vault_with("correct horse", &[("a", "pw-a")]);
        let again = v.unlock("correct horse").unwrap();
        assert_eq!(open(&again, "a", &v.entries["a"]).unwrap(), b"pw-a");
        assert_eq!(v.unlock("wrong horse!").err().unwrap(), WRONG_MASTER);
        assert_eq!(key[..], again[..]);
    }

    #[test]
    fn short_master_is_refused() {
        assert!(Vault::create("short").is_err());
    }

    #[test]
    fn entry_cannot_be_moved_to_another_id() {
        let (v, key) = vault_with("correct horse", &[("a", "pw-a")]);
        assert!(open(&key, "b", &v.entries["a"]).is_err());
    }

    #[test]
    fn secrets_are_not_stored_in_plain_text() {
        let (v, _) = vault_with("correct horse", &[("a", "very-secret-pw")]);
        let json = serde_json::to_string(&v).unwrap();
        assert!(!json.contains("very-secret-pw"));
        assert!(!json.contains("correct horse"));
    }

    #[test]
    fn changing_master_keeps_entries_and_drops_the_old_master() {
        let (v, _) = vault_with("old master pw", &[("a", "pw-a"), ("b", "pw-b")]);
        let (fresh, key) = v.rekey("old master pw", "new master pw").unwrap();
        assert_eq!(open(&key, "b", &fresh.entries["b"]).unwrap(), b"pw-b");
        assert!(fresh.unlock("old master pw").is_err());
        assert!(fresh.unlock("new master pw").is_ok());
        assert!(v.rekey("not the master", "new master pw").is_err());
    }
}
