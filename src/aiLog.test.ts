import { describe, expect, it } from "vitest";
import { formatDate, formatStamp } from "./aiLog";

describe("기록 시각 표기", () => {
  it("한 자리 월·일·시·분·초는 0을 채운다 (로컬 시간 기준)", () => {
    const d = new Date(2026, 0, 5, 3, 4, 9);
    expect(formatDate(d)).toBe("2026-01-05");
    expect(formatStamp(d)).toBe("2026-01-05 03:04:09");
  });

  it("날짜 형식은 백엔드가 받아들이는 YYYY-MM-DD와 같다", () => {
    expect(formatDate(new Date(2026, 10, 30))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
