import { describe, expect, it } from "vitest";
import { clampSidebar, DEFAULT_SIDEBAR, MIN_SIDEBAR } from "./layout";

describe("clampSidebar", () => {
  it.each([
    [300, 1600, 300],
    [50, 1600, MIN_SIDEBAR],
    [5000, 1600, 700],
    [900, 800, 480], // 좁은 창에서는 창 폭의 60%까지만
    [200.4, 1600, 200],
    [NaN, 1600, DEFAULT_SIDEBAR],
  ])("폭 %s (창 %s) 는 %s 로 맞춘다", (width, win, expected) => {
    expect(clampSidebar(width, win)).toBe(expected);
  });

  it("아주 좁은 창에서도 최소 폭 밑으로는 내려가지 않는다", () => {
    expect(clampSidebar(500, 200)).toBe(MIN_SIDEBAR);
  });
});
