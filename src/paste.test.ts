import { describe, expect, it } from "vitest";
import { sanitizePaste } from "./paste";

describe("sanitizePaste", () => {
  it("붙여넣기 감싸기를 끝내는 ESC[201~ 와 그 뒤의 탈출 시도에서 ESC를 지운다", () => {
    const evil = "ls\x1b[201~\nrm -rf ~\n";
    const out = sanitizePaste(evil);
    expect(out).not.toContain("\x1b");
    expect(out).toBe("ls[201~\nrm -rf ~\n"); // 남은 "[201~"는 평범한 글자라 터미널이 해석하지 못한다
  });

  it.each([
    ["\x00\x01\x07\x08x", "x"], // 널, 제어 문자, 벨, 백스페이스
    ["a\x7fb", "ab"], // DEL
    ["a\u009bb", "ab"], // C1 CSI
    ["a\x03b\x1ac", "abc"], // Ctrl+C, Ctrl+Z 문자
  ])("제어 문자 %j 는 지운다", (input, expected) => {
    expect(sanitizePaste(input)).toBe(expected);
  });

  it("탭, 줄바꿈, 한글, 이모지는 그대로 둔다", () => {
    const text = "echo 안녕\t🙂\r\nls -al\n";
    expect(sanitizePaste(text)).toBe(text);
  });
});
