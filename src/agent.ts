// AI가 서버에서 명령을 실행하는 흐름의 순수한 부분: 도구 정의, 모델의 요청 읽기, 결과를 모델에게 돌려줄 글 만들기.
// 실행할지 말지의 판단은 여기 없다 — 백엔드(policy.rs)가 한다.
import { splitBlocks } from "./aiText";
import { redact } from "./redact";

/** 모델에게 알려 주는 도구. 인자는 명령 한 줄뿐이다. */
export const TOOLS = [
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "연결된 SSH 서버에서 셸 명령 한 줄을 실행하고 출력을 돌려받는다. 읽기 전용 명령은 바로 실행되고, 그 밖의 명령은 사용자가 승인해야 실행되며, 위험한 명령은 거절된다. 한 번에 한 명령만 보내고 ;, &&, $(), 리다이렉션 같은 연결 문자는 쓰지 않는다.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "실행할 명령 한 줄 (예: ls -al /var/log)" } },
        required: ["command"],
      },
    },
  },
] as const;

export type ToolCall = { id: string; name: string; arguments: string };

/** 백엔드(exec.rs)의 AgentOutcome */
export type Outcome = {
  decision: "auto" | "approved" | "denied" | "blocked";
  reason: string | null;
  stdout: string;
  stderr: string;
  exit: number | null;
  truncated: boolean;
  timed_out: boolean;
};

/** 모델이 보낸 도구 호출에서 명령을 꺼낸다. 형식이 틀리면 error. */
export function parseToolCall(call: ToolCall): { command: string } | { error: string } {
  if (call.name !== "run_command") return { error: `알 수 없는 도구입니다: ${call.name}` };
  let args: unknown;
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    return { error: "인자가 올바른 JSON이 아닙니다" };
  }
  const cmd = (args as { command?: unknown } | null)?.command;
  if (typeof cmd !== "string" || !cmd.trim()) return { error: "command(문자열)가 필요합니다" };
  return { command: cmd };
}

/**
 * 도구 호출을 안 쓰는 서버를 위한 글 방식: 답 안의 ```run 코드 블록 하나가 명령 하나다.
 * 블록이 한 줄이 아니면(여러 명령이 섞이면) 실행하지 않고 error로 돌려준다.
 */
export function extractRunCommands(text: string): ({ command: string } | { error: string })[] {
  return splitBlocks(text)
    .filter((b) => b.type === "code" && b.closed && b.lang.toLowerCase() === "run")
    .map((b) => {
      const lines = (b as { content: string }).content.split("\n").filter((l) => l.trim());
      if (lines.length === 1) return { command: lines[0].trim() };
      return { error: lines.length === 0 ? "run 블록이 비어 있습니다" : "run 블록에는 명령을 한 줄만 쓸 수 있습니다" };
    });
}

/** 모델에게 돌려줄 결과 글. 출력은 서버로 보내기 전에 비밀번호·토큰 등을 가린다. */
export function formatResult(o: Outcome): string {
  if (o.decision === "blocked") return `실행하지 않았습니다 (정책: ${o.reason ?? "금지"}). 우회하지 말고 사용자에게 알리세요.`;
  if (o.decision === "denied") return "사용자가 실행을 거절했습니다. 다시 시도하지 말고 이유를 묻거나 다른 방법을 제안하세요.";
  const parts = [`종료 코드: ${o.exit ?? "알 수 없음"}`];
  if (o.stdout) parts.push(`[stdout]\n${redact(o.stdout)}`);
  if (o.stderr) parts.push(`[stderr]\n${redact(o.stderr)}`);
  if (!o.stdout && !o.stderr) parts.push("(출력 없음)");
  if (o.truncated) parts.push("(출력이 길어 잘렸습니다)");
  if (o.timed_out) parts.push("(시간 제한으로 중단했습니다)");
  return parts.join("\n");
}

/**
 * 서버로 보낼 최근 대화를 고른다. 도구 호출은 "요청 → 결과"가 짝이라 중간에서 자르면 서버가 거절한다.
 * 그래서 마지막 max개를 취한 뒤, 맨 앞이 사용자 메시지가 될 때까지 앞을 버린다.
 */
export function trimHistory<T extends { role: string }>(history: T[], max: number): T[] {
  let out = history.slice(-max);
  while (out.length && out[0].role !== "user") out = out.slice(1);
  return out;
}
