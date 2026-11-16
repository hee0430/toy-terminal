import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { t } from "./i18n";
import { confirmBox } from "./ui";

/**
 * 시작할 때 한 번 새 버전을 확인하고, 있으면 물어본 뒤 내려받아 설치한다.
 * 설치형만 대상이다 (포터블과 개발 실행은 uninstall.exe가 없어 is_installed가 false라 건너뛴다). 확인 단계의 실패(오프라인 등)는 조용히 넘기고,
 * 사용자가 설치를 승인한 뒤의 실패만 notify로 알린다.
 */
export async function checkForUpdate(notify: (msg: string) => void) {
  let update;
  try {
    if (!(await invoke<boolean>("is_installed"))) return;
    update = await check();
  } catch {
    return;
  }
  if (!update) return;
  if (!(await confirmBox(t("update.available", { version: update.version }), t("update.install")))) return;
  try {
    notify(t("update.downloading"));
    await update.downloadAndInstall(); // Windows는 설치 프로그램이 앱을 닫고 다시 실행한다
    await relaunch();
  } catch (e) {
    notify(t("update.failed", { error: String(e) }));
  }
}
