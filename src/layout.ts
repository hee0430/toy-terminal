export const DEFAULT_SIDEBAR = 260;
export const MIN_SIDEBAR = 160;
const MAX_SIDEBAR = 700;

/** 사이드바 패널 폭을 허용 범위로 맞춘다. 창 폭의 60%를 넘지 않게 해서 터미널이 사라지지 않게 한다. 숫자가 아니면 기본값. */
export function clampSidebar(width: number, windowWidth: number): number {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR;
  const max = Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, Math.floor(windowWidth * 0.6)));
  return Math.min(max, Math.max(MIN_SIDEBAR, Math.round(width)));
}
