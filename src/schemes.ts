import type { ITheme } from "@xterm/xterm";

/** 터미널 색상 구성. n 이름, b 배경, f 글자, c 커서, s 선택 영역(없으면 ""), a ANSI 16색 */
export type Scheme = { n: string; b: string; f: string; c: string; s: string; a: string[] };

export type EffectiveTheme = "dark" | "light";

/** 설정에 저장하는 id. 이 둘이 아니면 번들 스킴의 이름이다. */
export const AUTO = "auto";
export const CUSTOM = "custom";

/** xterm.js의 기본 ANSI 16색 (xterm.js 5.5 소스 기준). */
const XTERM_DEFAULT_ANSI = [
  "#2e3436", "#cc0000", "#4e9a06", "#c4a000", "#3465a4", "#75507b", "#06989a", "#d3d7cf",
  "#555753", "#ef2929", "#8ae234", "#fce94f", "#729fcf", "#ad7fa8", "#34e2e2", "#eeeeec",
];

/** 앱 다크 테마 배경에 맞춘 기본값. ANSI 색은 xterm 기본 그대로. */
export const AUTO_DARK: Scheme = { n: AUTO, b: "#1a1d29", f: "#d6d9e5", c: "#d6d9e5", s: "#3a4160", a: XTERM_DEFAULT_ANSI };
/** 화이트 모드 기본값은 번들 스킴 하나를 쓴다. */
export const AUTO_LIGHT_NAME = "One Half Light";

let cache: Scheme[] | null = null;

/** 번들된 스킴 전체(약 900개). 처음 쓸 때만 불러온다. */
export async function loadSchemes(): Promise<Scheme[]> {
  cache ??= (await import("./data/schemes.json")).default as Scheme[];
  return cache;
}

const XTERM_ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite"] as const;

export function toXterm(s: Scheme): ITheme {
  const theme: ITheme = { background: s.b, foreground: s.f, cursor: s.c, cursorAccent: s.b };
  if (s.s) theme.selectionBackground = s.s;
  if (s.a.length === 16) XTERM_ANSI.forEach((k, i) => (theme[k] = s.a[i]));
  return theme;
}
