import { invoke } from "@tauri-apps/api/core";
import { normalizeHex } from "./colors";
import { clampSize, DEFAULT_SIZE } from "./fonts";
import { clampSidebar, DEFAULT_SIDEBAR } from "./layout";
import { clampScrollback, DEFAULT_SCROLLBACK } from "./scrollback";
import { clampKeepalive, DEFAULT_KEEPALIVE } from "./keepalive";
import { t, type LangPref } from "./i18n";
import { AUTO, type Scheme } from "./schemes";
import { showStatus } from "./profiles";

export type ThemePref = "dark" | "light" | "system";
export type DblClick = "edit-download" | "edit" | "none";

/** AI 도우미(OpenAI 호환 서버). API 키는 직접 운영하는 서버 전제로 settings.json에 그대로 저장한다. */
export type AiSettings = { url: string; model: string; apiKey: string; system: string; consent: string; /** 질문할 때마다 활성 터미널의 최근 출력을 자동으로 함께 보낸다 */ autoScreen: boolean; /** 질문·답·터미널에 입력한 명령을 logs 폴더에 파일로 기록한다 */ log: boolean; /** false면 AI 도우미(사이드바 [AI] 탭)를 쓰지 않는다 */ enabled: boolean; /** AI가 SSH 서버에서 명령을 실행하게 한다 (읽기 전용은 바로, 나머지는 승인) */ exec: boolean; /** 서버가 OpenAI 도구 호출(tools)을 지원한다. 아니면 ```run 코드 블록 방식으로 요청한다 */ tools: boolean };
const AI_DEFAULT: AiSettings = { url: "", model: "", apiKey: "", system: "", consent: "", autoScreen: false, log: false, enabled: true, exec: false, tools: false };

export type Settings = {
  theme: ThemePref;
  lang: LangPref;
  /** "auto" | "custom" | 번들 스킴 이름 */
  scheme: string;
  /** 사용자가 직접 만든 색상 구성 */
  custom: Scheme | null;
  /** SFTP 파일 편집에 쓸 프로그램 경로. 비어 있으면 Windows 기본 편집 프로그램 */
  editor: string;
  /** SFTP 목록에서 파일을 더블클릭할 때: 편집 가능하면 편집 + 아니면 다운로드 / 편집 가능한 것만 편집 / 아무 동작 없음 */
  dblclick: DblClick;
  /** 터미널 글꼴 이름. 비어 있으면 기본 글꼴 */
  fontFamily: string;
  fontSize: number;
  /** 터미널 스크롤백 줄 수 (탭마다) */
  scrollback: number;
  /** SSH 연결 유지 신호 간격(초). 0이면 보내지 않는다 */
  keepalive: number;
  /** 왼쪽 사이드바 패널 폭(px) */
  sidebarWidth: number;
  ai: AiSettings;
};

const DEFAULTS: Settings = { theme: "system", lang: "system", scheme: AUTO, custom: null, editor: "", dblclick: "edit-download", fontFamily: "", fontSize: DEFAULT_SIZE, scrollback: DEFAULT_SCROLLBACK, keepalive: DEFAULT_KEEPALIVE, sidebarWidth: DEFAULT_SIDEBAR, ai: { ...AI_DEFAULT } };
let current: Settings = { ...DEFAULTS };

/** 파일에서 읽은 값을 믿지 않고 항목별로 검사한다. 틀린 항목은 기본값으로 둔다. */
function sanitize(raw: unknown): Settings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const s = { ...DEFAULTS };
  if (r.theme === "dark" || r.theme === "light" || r.theme === "system") s.theme = r.theme;
  if (r.lang === "system" || r.lang === "ko" || r.lang === "en-US") s.lang = r.lang;
  if (typeof r.scheme === "string" && r.scheme) s.scheme = r.scheme;
  if (typeof r.editor === "string" && r.editor.length <= 500) s.editor = r.editor.trim();
  if (r.dblclick === "edit-download" || r.dblclick === "edit" || r.dblclick === "none") s.dblclick = r.dblclick;
  if (typeof r.fontFamily === "string" && r.fontFamily.length <= 100) s.fontFamily = r.fontFamily.trim();
  if (typeof r.fontSize === "number") s.fontSize = clampSize(r.fontSize);
  if (typeof r.scrollback === "number") s.scrollback = clampScrollback(r.scrollback);
  if (typeof r.keepalive === "number") s.keepalive = clampKeepalive(r.keepalive);
  if (typeof r.sidebarWidth === "number") s.sidebarWidth = clampSidebar(r.sidebarWidth, window.innerWidth);
  const ai = r.ai as Partial<Record<keyof AiSettings, unknown>> | undefined;
  if (ai && typeof ai === "object") {
    const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : "");
    s.ai = { url: str(ai.url, 300).trim(), model: str(ai.model, 200).trim(), apiKey: str(ai.apiKey, 500).trim(), system: str(ai.system, 2000), consent: str(ai.consent, 300), autoScreen: ai.autoScreen === true, log: ai.log === true, enabled: ai.enabled !== false, exec: ai.exec === true, tools: ai.tools === true };
  }
  const c = r.custom as Partial<Scheme> | null | undefined;
  if (c && typeof c === "object" && Array.isArray(c.a) && c.a.length === 16) {
    const b = normalizeHex(String(c.b));
    const f = normalizeHex(String(c.f));
    const cur = normalizeHex(String(c.c));
    const sel = c.s ? normalizeHex(String(c.s)) : "";
    const a = c.a.map((x) => normalizeHex(String(x)));
    if (b && f && cur && sel !== null && a.every((x) => x)) s.custom = { n: "custom", b, f, c: cur, s: sel, a: a as string[] };
  }
  return s;
}

export async function loadSettings(): Promise<void> {
  try {
    const json = await invoke<string | null>("settings_load");
    if (json) current = sanitize(JSON.parse(json));
  } catch (e) {
    showStatus(t("settings.saveFailed", { error: String(e) }));
  }
}

export const getSettings = (): Settings => current;

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  invoke("settings_save", { json: JSON.stringify(current, null, 2) }).catch((e) => showStatus(t("settings.saveFailed", { error: String(e) })));
}
