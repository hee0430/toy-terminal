import { describe, expect, it } from "vitest";
import { parseSlash, splitBlocks } from "./aiText";

describe("splitBlocks", () => {
  it("글과 코드 블록을 나눈다", () => {
    expect(splitBlocks("먼저 실행:\n```bash\nls -al\n```\n그다음 확인하세요")).toEqual([
      { type: "text", content: "먼저 실행:\n" },
      { type: "code", content: "ls -al", lang: "bash", closed: true },
      { type: "text", content: "\n그다음 확인하세요" },
    ]);
  });

  it("코드 블록이 여러 개여도 순서대로 나눈다", () => {
    const blocks = splitBlocks("```\na\n```\n```sh\nb\nc\n```");
    expect(blocks.filter((b) => b.type === "code").map((b) => (b as { content: string }).content)).toEqual(["a", "b\nc"]);
  });

  it("스트리밍 도중 닫히지 않은 블록은 끝까지를 코드로 본다", () => {
    expect(splitBlocks("실행:\n```bash\nls -")).toEqual([
      { type: "text", content: "실행:\n" },
      { type: "code", content: "ls -", lang: "bash", closed: false },
    ]);
  });

  it("언어 이름을 쓰는 중에 끊겨도 깨지지 않는다", () => {
    expect(splitBlocks("```ba")).toEqual([{ type: "code", content: "", lang: "ba", closed: false }]);
  });

  it("코드 블록이 없으면 글 하나이고, 빈 글은 빈 목록이다", () => {
    expect(splitBlocks("그냥 설명")).toEqual([{ type: "text", content: "그냥 설명" }]);
    expect(splitBlocks("")).toEqual([]);
  });
});

describe("parseSlash", () => {
  it.each([
    ["/clear", { name: "clear", args: [] }],
    ["  /Clear  ", { name: "clear", args: [] }],
    ["/screen on", { name: "screen", args: ["on"] }],
    ["/screen   off  ", { name: "screen", args: ["off"] }],
  ])("%j 는 명령이다", (input, expected) => {
    expect(parseSlash(input)).toEqual(expected);
  });

  it.each(["/etc/hosts 가 뭐야?", "/var/log/syslog", "hello /clear", "/ clear", "/123", "", "/"])("%j 는 명령이 아니라 질문이다", (input) => {
    expect(parseSlash(input)).toBeNull();
  });
});
