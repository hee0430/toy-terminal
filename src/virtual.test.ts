import { describe, expect, it } from "vitest";
import { visibleRange } from "./virtual";

describe("visibleRange", () => {
  it("맨 위에서는 보이는 행과 아래 여유만 만든다", () => {
    expect(visibleRange(0, 300, 100, 1000, 2)).toEqual([0, 5]);
  });

  it("중간으로 스크롤하면 위아래 여유를 더한다", () => {
    expect(visibleRange(1000, 300, 100, 1000, 2)).toEqual([8, 15]);
  });

  it("끝을 넘겨도 전체 개수를 넘지 않는다", () => {
    const [a, b] = visibleRange(999999, 300, 100, 50, 3);
    expect(b).toBe(50);
    expect(a).toBeLessThanOrEqual(b);
  });

  it.each([
    [0, 100],
    [10, 0],
    [10, -5],
  ])("행이 없거나 행 높이가 잘못되면 빈 범위 (total=%i, rowHeight=%i)", (total, rowHeight) => {
    expect(visibleRange(0, 300, rowHeight, total)).toEqual([0, 0]);
  });
});
