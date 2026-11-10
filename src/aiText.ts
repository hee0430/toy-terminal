export type Block = { type: "text"; content: string } | { type: "code"; content: string; lang: string; closed: boolean };

/**
 * 답을 일반 글과 코드 블록(```)으로 나눈다. 스트리밍 중에는 아직 닫히지 않은 블록이 있을 수 있어서
 * 닫는 ```가 없으면 끝까지를 코드로 보고 closed=false로 표시한다.
 */
export function splitBlocks(text: string): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("```", i);
    if (open < 0) {
      out.push({ type: "text", content: text.slice(i) });
      break;
    }
    if (open > i) out.push({ type: "text", content: text.slice(i, open) });
    const nl = text.indexOf("\n", open + 3);
    // 줄바꿈이 아직 안 왔으면 언어 이름을 쓰는 중이다.
    const head = nl < 0 ? text.slice(open + 3) : text.slice(open + 3, nl);
    const bodyStart = nl < 0 ? text.length : nl + 1;
    const close = text.indexOf("```", bodyStart);
    const body = close < 0 ? text.slice(bodyStart) : text.slice(bodyStart, close);
    out.push({ type: "code", content: body.replace(/\n$/, ""), lang: head.trim(), closed: close >= 0 });
    if (close < 0) break;
    i = close + 3;
  }
  return out;
}

/**
 * 입력이 "/명령 인자" 모양이면 나눠서 돌려준다. 명령 이름은 영문자뿐이어야 한다.
 * "/etc/hosts 가 뭐야?"처럼 경로로 시작하는 질문은 이름 뒤에 글자가 더 이어지므로 명령이 아니다(null).
 */
export function parseSlash(text: string): { name: string; args: string[] } | null {
  const m = /^\/([A-Za-z]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] ?? "").split(/\s+/).filter(Boolean) };
}
