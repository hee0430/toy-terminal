import { describe, expect, it } from "vitest";
import { extractRunCommands, formatResult, parseToolCall, trimHistory, type Outcome } from "./agent";

const out = (o: Partial<Outcome>): Outcome => ({ decision: "auto", reason: null, stdout: "", stderr: "", exit: 0, truncated: false, timed_out: false, ...o });

describe("parseToolCall", () => {
  it("명령을 꺼낸다", () => {
    expect(parseToolCall({ id: "1", name: "run_command", arguments: '{"command":"ls -al /var/log"}' })).toEqual({ command: "ls -al /var/log" });
  });

  it.each([
    ["다른 이름의 도구", { id: "1", name: "delete_all", arguments: '{"command":"ls"}' }],
    ["JSON이 아님", { id: "1", name: "run_command", arguments: "{command: ls" }],
    ["command가 없음", { id: "1", name: "run_command", arguments: "{}" }],
    ["command가 문자열이 아님", { id: "1", name: "run_command", arguments: '{"command":["ls"]}' }],
    ["command가 비어 있음", { id: "1", name: "run_command", arguments: '{"command":"  "}' }],
    ["JSON이 null", { id: "1", name: "run_command", arguments: "null" }],
  ])("거절한다: %s", (_, call) => {
    expect(parseToolCall(call)).toHaveProperty("error");
  });
});

describe("extractRunCommands", () => {
  it("```run 블록 한 줄이 명령 하나다", () => {
    expect(extractRunCommands("확인합니다.\n```run\ndf -h\n```\n")).toEqual([{ command: "df -h" }]);
    expect(extractRunCommands("```run\nls\n```\n그리고\n```run\nuptime\n```")).toEqual([{ command: "ls" }, { command: "uptime" }]);
  });

  it("run이 아닌 블록과 닫히지 않은 블록은 실행 대상이 아니다", () => {
    expect(extractRunCommands("```bash\nrm -rf /\n```")).toEqual([]);
    expect(extractRunCommands("```run\nls")).toEqual([]); // 스트리밍이 끝나지 않은 블록
  });

  it("여러 줄이거나 빈 블록은 실행하지 않고 오류로 돌려준다", () => {
    const r = extractRunCommands("```run\nls\nrm x\n```\n```run\n\n```");
    expect(r).toHaveLength(2);
    expect(r.every((x) => "error" in x)).toBe(true);
  });
});

describe("formatResult", () => {
  it("실행 결과: 종료 코드와 출력, 비밀은 가린다", () => {
    const text = formatResult(out({ stdout: "DB_PASSWORD=hunter2\nok", exit: 0 }));
    expect(text).toContain("종료 코드: 0");
    expect(text).toContain("DB_PASSWORD=***");
    expect(text).not.toContain("hunter2");
  });

  it("오류 출력, 잘림, 시간 초과를 알린다", () => {
    const text = formatResult(out({ stderr: "boom", exit: 2, truncated: true, timed_out: true }));
    expect(text).toContain("[stderr]\nboom");
    expect(text).toContain("잘렸습니다");
    expect(text).toContain("시간 제한");
  });

  it("차단과 거절은 모델에게 우회하지 말라고 알린다", () => {
    expect(formatResult(out({ decision: "blocked", reason: "금지된 명령입니다 (reboot)" }))).toMatch(/실행하지 않았습니다.*reboot.*우회하지/s);
    expect(formatResult(out({ decision: "denied" }))).toContain("거절");
  });
});

describe("trimHistory", () => {
  const m = (role: string, n: number) => ({ role, n });

  it("최근 max개를 남기되 맨 앞은 항상 사용자 메시지다 (도구 호출·결과 짝이 깨지지 않게)", () => {
    const h = [m("user", 1), m("assistant", 2), m("tool", 3), m("assistant", 4), m("user", 5), m("assistant", 6)];
    expect(trimHistory(h, 5).map((x) => x.n)).toEqual([5, 6]); // 4개째부터 자르면 tool이 앞에 오므로 user까지 버린다
    expect(trimHistory(h, 10).map((x) => x.n)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(trimHistory(h, 2).map((x) => x.n)).toEqual([5, 6]);
  });

  it("사용자 메시지가 없으면 빈 목록", () => {
    expect(trimHistory([m("assistant", 1), m("tool", 2)], 5)).toEqual([]);
  });
});
