/** xterm 버퍼에서 필요한 부분만 본 모양 (테스트에서 흉내 내기 쉽게) */
export interface BufLine {
  isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}
export interface BufLike {
  length: number;
  getLine(y: number): BufLine | undefined;
}

export const DEFAULT_SAVE_LINES = 1000;

/**
 * 버퍼(스크롤백 + 화면)를 텍스트로 뽑는다. 창 너비 때문에 꺾인 줄은 다시 한 줄로 합치고,
 * 끝의 빈 줄은 버린다. lines가 숫자면 마지막 그 줄 수만, null이면 전부.
 */
export function bufferToText(buf: BufLike, lines: number | null): string {
  const out = bufferLines(buf);
  const picked = lines === null ? out : out.slice(-Math.max(1, lines));
  return picked.length ? picked.join("\n") + "\n" : "";
}

/** 저장 대상이 되는 실제 줄 수 (화면 아래의 빈 줄은 세지 않는다) */
export function countLines(buf: BufLike): number {
  return bufferLines(buf).length;
}

function bufferLines(buf: BufLike): string[] {
  const out: string[] = [];
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && out.length) out[out.length - 1] += text;
    else out.push(text);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/** 입력칸 값을 줄 수로. 양의 정수가 아니면 null(잘못된 값) */
export function parseLineCount(s: string): number | null {
  const n = Number(s.trim());
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** 파일 이름으로 못 쓰는 글자를 바꾼다 */
export function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim() || "terminal";
}

export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
