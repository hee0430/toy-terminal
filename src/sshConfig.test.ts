import { describe, expect, it } from "vitest";
import { parseSshConfig } from "./sshConfig";

describe("parseSshConfig", () => {
  it("Host별 접속 정보를 읽고 HostName이 없으면 Host 이름을 주소로 쓴다", () => {
    const r = parseSshConfig(`
# 주석
Host web
  HostName 10.0.0.5
  User deploy
  Port=2222
  IdentityFile "~/.ssh/id web"

Host bare
`);
    expect(r).toEqual([
      { name: "web", host: "10.0.0.5", user: "deploy", port: 2222, keyPath: "~/.ssh/id web" },
      { name: "bare", host: "bare" },
    ]);
  });

  it("와일드카드 Host와 Match 블록의 옵션은 항목에 섞이지 않는다", () => {
    const r = parseSshConfig(`
Host *
  User everyone
Host a b *.corp
  HostName shared
Match host a
  User sneaky
`);
    expect(r).toEqual([
      { name: "a", host: "shared" },
      { name: "b", host: "shared" },
    ]);
  });

  it("같은 옵션이 여러 번이면 처음 값을 쓰고, 잘못된 포트는 버린다", () => {
    const r = parseSshConfig("Host x\n User first\n User second\n Port 99999\n");
    expect(r).toEqual([{ name: "x", host: "x", user: "first" }]);
  });
});
