import { describe, expect, it } from "vitest";
import { isLightColor, normalizeHex } from "./colors";

describe("isLightColor", () => {
  it.each([
    ["#000000", false],
    ["#1a1d29", false],
    ["#282a36", false],
    ["#002b36", false],
    ["#ffffff", true],
    ["#fafafa", true],
    ["#fdf6e3", true],
  ])("%s 는 밝은 색이 %s", (hex, light) => {
    expect(isLightColor(hex)).toBe(light);
  });
});

describe("normalizeHex", () => {
  it.each([
    ["#FFAA00", "#ffaa00"],
    ["ffaa00", "#ffaa00"],
    ["#fa0", "#ffaa00"],
    ["  #123456 ", "#123456"],
  ])("올바른 값 %s 는 정규화한다", (input, expected) => {
    expect(normalizeHex(input)).toBe(expected);
  });

  it.each(["", "#12345", "#1234567", "#gggggg", "red", "rgb(1,2,3)", "#12 456"])("잘못된 값 %j 는 거부한다", (input) => {
    expect(normalizeHex(input)).toBeNull();
  });
});
