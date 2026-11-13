import { describe, expect, it } from "vitest";
import { createPendingOutput } from "./pendingOutput";

const b = (...n: number[]) => new Uint8Array(n);

describe("pendingOutput", () => {
  it("접속 시작 중에 온 출력과 종료를 모았다가 한 번만 꺼낸다", () => {
    const p = createPendingOutput();
    p.begin();
    expect(p.add("t1", b(1, 2))).toBe(true);
    expect(p.close("t1")).toBe(true);
    expect(p.take("t1")).toEqual({ chunks: [b(1, 2)], closed: true });
    expect(p.take("t1")).toBeUndefined();
  });

  it("접속 시작 중이 아니거나 끝난 뒤의 출력은 쌓지 않는다", () => {
    const p = createPendingOutput();
    expect(p.add("t1", b(1))).toBe(false);
    p.begin();
    p.add("stray", b(1));
    p.end();
    p.begin();
    expect(p.take("stray")).toBeUndefined();
  });

  it("상한을 넘는 출력은 버린다", () => {
    const p = createPendingOutput(3);
    p.begin();
    p.add("t1", b(1, 2));
    p.add("t1", b(3, 4));
    expect(p.take("t1")?.chunks).toEqual([b(1, 2)]);
  });
});
