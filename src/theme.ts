import type { ITheme } from "@xterm/xterm";
import { getSettings, type Settings } from "./settings";
import { AUTO, AUTO_DARK, AUTO_LIGHT_NAME, CUSTOM, loadSchemes, toXterm, type EffectiveTheme, type Scheme } from "./schemes";

const media = window.matchMedia("(prefers-color-scheme: light)");

export function effectiveTheme(pref: Settings["theme"] = getSettings().theme): EffectiveTheme {
  return pref === "system" ? (media.matches ? "light" : "dark") : pref;
}

/** 설정이 가리키는 색상 구성을 실제 값으로 바꾼다. 못 찾으면 앱 테마 기본값. */
export async function resolveScheme(s: Settings, eff: EffectiveTheme): Promise<Scheme> {
  const auto = async (): Promise<Scheme> => {
    if (eff === "dark") return AUTO_DARK;
    return (await loadSchemes()).find((x) => x.n === AUTO_LIGHT_NAME) ?? AUTO_DARK;
  };
  if (s.scheme === AUTO) return auto();
  if (s.scheme === CUSTOM) return s.custom ?? auto();
  return (await loadSchemes()).find((x) => x.n === s.scheme) ?? auto();
}

let termTheme: ITheme = toXterm(AUTO_DARK);
const listeners = new Set<(t: ITheme) => void>();
let seq = 0;

export const getTermTheme = () => termTheme;
export const onTermTheme = (fn: (t: ITheme) => void) => void listeners.add(fn);

/** 앱 테마(CSS)와 터미널 색상을 현재 설정대로 적용한다. */
export async function applyAppearance(): Promise<void> {
  const s = getSettings();
  const eff = effectiveTheme(s.theme);
  document.documentElement.dataset.theme = eff;
  const mine = ++seq;
  const scheme = await resolveScheme(s, eff);
  if (mine !== seq) return; // 더 최근의 적용이 있으면 이 결과는 버린다
  document.documentElement.style.setProperty("--term-bg", scheme.b);
  termTheme = toXterm(scheme);
  listeners.forEach((f) => f(termTheme));
}

// 시스템 설정을 따르는 중에 Windows의 모드가 바뀌면 같이 바꾼다.
media.addEventListener("change", () => {
  if (getSettings().theme === "system") applyAppearance();
});
