import ko from "./messages/ko.json";
import en from "./messages/en-US.json";

export type Lang = "ko" | "en-US";
export type LangPref = "system" | Lang;

type Tree = { [k: string]: string | Tree };

/** 중첩 JSON을 "a.b.c" 키의 평평한 맵으로 바꾼다. */
function flatten(obj: Tree, prefix = "", out: Record<string, string> = {}): Record<string, string> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out[key] = v;
    else flatten(v, key, out);
  }
  return out;
}

const dicts: Record<Lang, Record<string, string>> = { ko: flatten(ko), "en-US": flatten(en) };
let current: Lang = "ko";
const listeners = new Set<() => void>();

export function resolveLang(pref: LangPref): Lang {
  if (pref !== "system") return pref;
  return navigator.language.toLowerCase().startsWith("ko") ? "ko" : "en-US";
}

/** 문구를 돌려준다. 값의 {변수}를 vars로 채운다. 없는 키는 한국어, 그래도 없으면 키 그대로. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const s = dicts[current][key] ?? dicts.ko[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** 여러 조각을 언어에 맞는 구분으로 잇는다 (문장을 문자열 연결로 만들지 않기 위함). */
export function joinList(items: string[]): string {
  return new Intl.ListFormat(current, { style: "narrow", type: "unit" }).format(items);
}

/** data-i18n(글자), data-i18n-title(툴팁), data-i18n-placeholder 속성이 붙은 요소를 번역한다. */
export function applyStatic(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n!)));
  root.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((el) => (el.title = t(el.dataset.i18nTitle!)));
  root.querySelectorAll<HTMLInputElement>("[data-i18n-placeholder]").forEach((el) => (el.placeholder = t(el.dataset.i18nPlaceholder!)));
}

export function setLang(lang: Lang) {
  current = lang;
  document.documentElement.lang = lang === "ko" ? "ko" : "en";
  applyStatic();
  listeners.forEach((f) => f());
}

export const onLangChange = (fn: () => void) => void listeners.add(fn);
