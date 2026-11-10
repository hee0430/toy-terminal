export const DEFAULT_KEEPALIVE = 30;
export const MIN_KEEPALIVE = 10;
export const MAX_KEEPALIVE = 600;

/** SSH 연결 유지 신호 간격(초). 0 이하는 사용 안 함(0), 그 밖에는 범위 안으로. 숫자가 아니면 기본값. */
export function clampKeepalive(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_KEEPALIVE;
  if (n <= 0) return 0;
  return Math.min(MAX_KEEPALIVE, Math.max(MIN_KEEPALIVE, Math.round(n)));
}
