/**
 * 높이가 같은 행으로 된 긴 목록에서 지금 만들어야 할 행의 범위 [시작, 끝)을 구한다.
 * 화면에 보이는 행에 위아래 여유(buffer)행을 더한다.
 */
export function visibleRange(scrollTop: number, viewport: number, rowHeight: number, total: number, buffer = 3): [number, number] {
  if (total <= 0 || rowHeight <= 0) return [0, 0];
  const first = Math.min(Math.max(0, Math.floor(scrollTop / rowHeight) - buffer), total);
  const last = Math.min(total, Math.ceil((scrollTop + viewport) / rowHeight) + buffer);
  return [first, Math.max(first, last)];
}
