import { describe, expect, it } from "vitest";
import { clampSize, DEFAULT_SIZE, DEFAULT_STACK, fontStack } from "./fonts";

describe("clampSize", () => {
  it.each([
    [14, 14],
    [7, 8],
    [40, 32],
    [13.6, 14],
    [NaN, DEFAULT_SIZE],
    [Infinity, DEFAULT_SIZE],
  ])("%s 는 %s 로 맞춘다", (input, expected) => {
    expect(clampSize(input)).toBe(expected);
  });
});

describe("fontStack", () => {
  it("글꼴 이름 뒤에 기본 글꼴을 붙인다", () => {
    expect(fontStack("D2Coding")).toBe(`"D2Coding", ${DEFAULT_STACK}`);
  });

  it("비어 있으면 기본 글꼴만 쓴다", () => {
    expect(fontStack("   ")).toBe(DEFAULT_STACK);
  });

  it("따옴표나 쉼표로 다른 CSS 값이 끼어들지 못하게 한다", () => {
    const s = fontStack('Evil"; background: url(x); }');
    expect(s).not.toMatch(/[;{}]/);
    expect(s.startsWith('"Evil')).toBe(true);
    expect((s.match(/"/g) ?? []).length).toBe(4); // 입력 이름의 따옴표 2개 + 기본 글꼴의 따옴표 2개뿐
  });
});
