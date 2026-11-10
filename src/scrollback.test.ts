import { describe, expect, it } from "vitest";
import { clampScrollback, DEFAULT_SCROLLBACK, MAX_SCROLLBACK, MIN_SCROLLBACK } from "./scrollback";

describe("clampScrollback", () => {
  it.each([
    [20000, 20000],
    [1e6, MAX_SCROLLBACK],
    [0, MIN_SCROLLBACK],
    [NaN, DEFAULT_SCROLLBACK],
  ])("%s → %s", (input, expected) => expect(clampScrollback(input)).toBe(expected));
});
