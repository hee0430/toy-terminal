import { describe, expect, it } from "vitest";
import { clampKeepalive, DEFAULT_KEEPALIVE, MAX_KEEPALIVE, MIN_KEEPALIVE } from "./keepalive";

describe("clampKeepalive", () => {
  it.each([
    [60, 60],
    [0, 0],
    [-5, 0],
    [3, MIN_KEEPALIVE],
    [99999, MAX_KEEPALIVE],
    [NaN, DEFAULT_KEEPALIVE],
  ])("%s → %s", (input, expected) => expect(clampKeepalive(input)).toBe(expected));
});
