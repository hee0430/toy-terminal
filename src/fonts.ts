export const DEFAULT_STACK = '"Cascadia Mono", Consolas, monospace';
export const DEFAULT_SIZE = 14;
export const MIN_SIZE = 8;
export const MAX_SIZE = 32;

/** 글자 크기를 8~32의 정수로 맞춘다. 숫자가 아니면 기본값. */
export function clampSize(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SIZE;
  return Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(n)));
}

/** 사용자가 입력한 글꼴 이름으로 CSS font-family 값을 만든다. 따옴표·쉼표 등은 지워 다른 값이 끼어들지 못하게 하고, 뒤에 기본 글꼴을 붙여 없는 글꼴이어도 깨지지 않게 한다. */
export function fontStack(name: string): string {
  const clean = name.replace(/["';,\\{}]/g, "").trim().slice(0, 100);
  return clean ? `"${clean}", ${DEFAULT_STACK}` : DEFAULT_STACK;
}

/** 앱에 포함된 글꼴 (src/fonts.css). 어느 PC에서나 쓸 수 있다. */
export const BUNDLED_FONTS = ["D2Coding", "JetBrains Mono", "Cascadia Mono"];
/** Windows에 항상 들어 있는 글꼴. Microsoft 글꼴이라 앱에 담지 않고 PC의 것을 쓴다. */
export const WINDOWS_FONTS = ["Consolas", "Courier New"];
