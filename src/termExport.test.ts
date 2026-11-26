import { describe, expect, it } from "vitest";
import { bufferToText, countLines, parseLineCount, safeFileName, type BufLike } from "./termExport";

function buf(rows: [string, boolean?][]): BufLike {
  return {
    length: rows.length,
    getLine: (y) => ({ isWrapped: !!rows[y][1], translateToString: () => rows[y][0] }),
  };
}

describe("bufferToText", () => {
  const b = buf([["a"], ["b"], ["c1", false], ["c2", true], [""], [""]]);
  it("꺾인 줄을 합치고 끝의 빈 줄을 버린다", () => {
    expect(bufferToText(b, null)).toBe("a\nb\nc1c2\n");
  });
  it("마지막 N줄만 뽑는다", () => {
    expect(bufferToText(b, 2)).toBe("b\nc1c2\n");
  });
  it("N이 더 크면 전부", () => {
    expect(bufferToText(b, 100)).toBe("a\nb\nc1c2\n");
  });
  it("빈 버퍼는 빈 문자열", () => {
    expect(bufferToText(buf([[""]]), null)).toBe("");
  });
});

describe("countLines", () => {
  it("화면 아래의 빈 줄은 세지 않는다", () => {
    expect(countLines(buf([["a"], ["b"], ["c1"], ["c2", true], [""], [""]]))).toBe(3);
  });
});

describe("parseLineCount", () => {
  it("양의 정수만 받는다", () => {
    expect(parseLineCount(" 500 ")).toBe(500);
    expect(parseLineCount("0")).toBeNull();
    expect(parseLineCount("1.5")).toBeNull();
    expect(parseLineCount("")).toBeNull();
    expect(parseLineCount("abc")).toBeNull();
  });
});

describe("safeFileName", () => {
  it("파일 이름에 못 쓰는 글자를 바꾼다", () => {
    expect(safeFileName("web:01/prod")).toBe("web_01_prod");
    expect(safeFileName("  ")).toBe("terminal");
  });
});
