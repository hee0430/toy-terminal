/** "#RRGGBB", "RRGGBB", "#RGB" 를 소문자 "#rrggbb"로 바꾼다. 형식이 틀리면 null. */
export function normalizeHex(v: string): string | null {
  const s = v.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(s)) return "#" + [...s].map((c) => c + c).join("").toLowerCase();
  if (/^[0-9a-fA-F]{6}$/.test(s)) return "#" + s.toLowerCase();
  return null;
}

/** 배경색이 밝은 색인가. WCAG 상대 휘도가 0.179(흰 글자와 검은 글자의 대비가 같아지는 값)보다 크면 밝다. 입력은 "#rrggbb". */
export function isLightColor(hex: string): boolean {
  const lin = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(0) + 0.7152 * lin(1) + 0.0722 * lin(2) > 0.179;
}

/** a와 b를 섞는다. ratio 0이면 a, 1이면 b. 입력은 "#rrggbb". */
export function mixHex(a: string, b: string, ratio: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  const m = (i: number) => Math.round(ch(a, i) * (1 - ratio) + ch(b, i) * ratio);
  return "#" + [0, 1, 2].map((i) => m(i).toString(16).padStart(2, "0")).join("");
}
