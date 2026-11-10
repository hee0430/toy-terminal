// 저장된 비밀번호(secrets.rs)의 화면 쪽 흐름: 마스터 비밀번호 정하기·잠금 풀기, 저장·읽기·삭제.
// 암호화는 모두 백엔드가 한다. 여기서는 마스터 비밀번호를 물어서 넘길 뿐 저장하지 않는다.
import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";
import { ask } from "./ui";

export type VaultStatus = { exists: boolean; unlocked: boolean; ids: string[] };

let savedIds = new Set<string>();

export async function vaultStatus(): Promise<VaultStatus> {
  const s = await invoke<VaultStatus>("secrets_status");
  savedIds = new Set(s.ids);
  return s;
}

/** 이 프로필에 저장된 비밀번호가 있는가 (vaultStatus를 한 번 불러온 뒤의 값) */
export const hasSecret = (id: string) => savedIds.has(id);

/** 마스터 비밀번호를 새로 정한다 (두 번 입력). 취소하면 null. 두 입력이 다르면 오류를 보이고 다시 묻는다. error는 처음부터 보일 오류. */
export async function askNewMaster(error = "", title = t("vault.setupTitle")): Promise<string | null> {
  let err = error;
  for (;;) {
    const pw = await ask(title, t("vault.masterLabel"), { password: true, stacked: true, notes: [t("vault.noteLength"), t("vault.noteLost")], error: err });
    if (pw === null) return null;
    const again = await ask(title, t("vault.confirmLabel"), { password: true, stacked: true });
    if (again === null) return null;
    if (pw === again) return pw;
    err = t("vault.mismatch");
  }
}

/** 잠금이 풀린 상태로 만든다. 마스터 비밀번호가 없으면 새로 정하고, 있으면 맞을 때까지 묻는다. 사용자가 취소하면 false. */
export async function ensureUnlocked(): Promise<boolean> {
  const s = await vaultStatus();
  if (s.unlocked) return true;
  if (!s.exists) {
    let err = "";
    for (;;) {
      const pw = await askNewMaster(err);
      if (pw === null) return false;
      try {
        await invoke("secrets_setup", { master: pw });
        return true;
      } catch (e) {
        err = t("vault.failed", { error: String(e) }); // 8자 미만 같은 입력 오류
      }
    }
  }
  let err = "";
  for (;;) {
    const pw = await ask(t("vault.unlockTitle"), t("vault.masterLabel"), { password: true, stacked: true, notes: [t("vault.unlockNote")], error: err });
    if (pw === null) return false;
    try {
      await invoke("secrets_unlock", { master: pw });
      return true;
    } catch (e) {
      err = t("vault.failed", { error: String(e) });
    }
  }
}

/** 잠금을 풀고 저장한다. 마스터 비밀번호 입력을 취소하면 false. */
export async function saveSecret(id: string, secret: string): Promise<boolean> {
  if (!(await ensureUnlocked())) return false;
  await invoke("secrets_save", { id, secret });
  await vaultStatus();
  return true;
}

/** 저장된 비밀번호를 읽는다. 없거나 잠금 해제를 취소했거나 읽지 못하면 null (호출한 쪽이 직접 묻는다). */
export async function readSecret(id: string): Promise<string | null> {
  try {
    if (!(await ensureUnlocked())) return null;
    return await invoke<string | null>("secrets_get", { id });
  } catch {
    return null;
  }
}

export async function deleteSecrets(ids: string[]): Promise<void> {
  for (const id of ids) if (savedIds.has(id)) await invoke("secrets_delete", { id }).catch(() => {});
  await vaultStatus().catch(() => {});
}
