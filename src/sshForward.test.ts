import { describe, expect, it } from "vitest";
import { formatForward, parseForwards } from "./sshForward";

describe("parseForwards", () => {
  it("-L/-R 줄을 읽고 빈 줄은 건너뛴다", () => {
    expect(parseForwards("-L 8080:localhost:80\n\n-R 9000:127.0.0.1:3000")).toEqual({
      forwards: [
        { remote: false, listen_port: 8080, host: "localhost", port: 80, all: false },
        { remote: true, listen_port: 9000, host: "127.0.0.1", port: 3000, all: false },
      ],
    });
  });

  it("로컬은 0.0.0.0을 앞에 붙이면 모든 주소에서 접속을 받는다 (그 밖의 주소는 거부)", () => {
    expect(parseForwards("-L 0.0.0.0:8080:a:80")).toEqual({ forwards: [{ remote: false, listen_port: 8080, host: "a", port: 80, all: true }] });
    expect(parseForwards("-L 127.0.0.1:8080:a:80")).toEqual({ forwards: [{ remote: false, listen_port: 8080, host: "a", port: 80, all: false }] });
    expect(parseForwards("-L 192.168.0.5:8080:a:80")).toEqual({ badLine: 1 });
  });

  it.each([
    ["형식 오류", "8080:localhost:80", 1],
    ["포트 범위 밖", "-L 8080:localhost:70000", 1],
    ["같은 쪽 포트 중복", "-L 8080:a:1\n-L 0.0.0.0:8080:b:2", 2],
    ["-D(동적)는 지원하지 않는다", "-D 1080", 1],
  ])("%s → 줄 번호를 돌려준다", (_name, text, badLine) => {
    expect(parseForwards(text)).toEqual({ badLine });
  });

  it("로컬과 원격은 같은 포트 번호를 써도 된다", () => {
    expect("forwards" in parseForwards("-L 8080:a:1\n-R 8080:b:2")).toBe(true);
  });

  it("저장용 문법으로 되돌려도 같은 값이 나온다", () => {
    const line = "-L 0.0.0.0:8080:localhost:80";
    const r = parseForwards(line);
    expect("forwards" in r && formatForward(r.forwards[0])).toBe(line);
  });
});
