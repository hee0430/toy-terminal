export const DEFAULT_SCROLLBACK = 10000;
export const MIN_SCROLLBACK = 1000;
export const MAX_SCROLLBACK = 50000;

/** 탭마다 메모리에 쌓이므로 범위를 제한한다. 숫자가 아니면 기본값. */
export function clampScrollback(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SCROLLBACK;
  return Math.min(MAX_SCROLLBACK, Math.max(MIN_SCROLLBACK, Math.round(n)));
}
