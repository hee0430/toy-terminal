// 포트 포워딩 입력(ssh 문법)을 읽고 검사한다.
//   -L 8080:localhost:80           이 PC의 8080 → (서버에서 본) localhost:80, 이 PC에서만 접속 가능
//   -L 0.0.0.0:8080:localhost:80   위와 같지만 같은 네트워크의 다른 PC도 접속 가능 (모든 주소에 연다)
//   -R 9000:localhost:3000         서버의 9000 → (이 PC에서 본) localhost:3000

export type Forward = { remote: boolean; listen_port: number; host: string; port: number; /** 로컬(-L)만: 모든 주소에서 접속을 받는다 */ all: boolean };

const validPort = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;
const ALL_ADDRS = new Set(["0.0.0.0", "*"]);
const LOOPBACK = new Set(["127.0.0.1", "localhost"]);

/** 한 줄을 읽는다. 형식이 틀리면 null. */
export function parseForward(line: string): Forward | null {
  const m = /^-([LR])\s+(?:([^\s:]+):)?(\d+):([^\s:]+):(\d+)$/.exec(line.trim());
  if (!m) return null;
  const remote = m[1] === "R";
  const bind = m[2];
  if (bind && !ALL_ADDRS.has(bind) && !LOOPBACK.has(bind)) return null; // 그 밖의 주소(특정 NIC)는 지원하지 않는다
  const listen_port = Number(m[3]);
  const port = Number(m[5]);
  if (!validPort(listen_port) || !validPort(port)) return null;
  return { remote, listen_port, host: m[4], port, all: !remote && !!bind && ALL_ADDRS.has(bind) };
}

/** 여러 줄 입력. 빈 줄은 건너뛰고, 틀리거나 같은 쪽 포트가 겹친 줄이 있으면 그 줄 번호(1부터)를 돌려준다. */
export function parseForwards(text: string): { forwards: Forward[] } | { badLine: number } {
  const forwards: Forward[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const f = parseForward(lines[i]);
    const key = f && `${f.remote}:${f.listen_port}`;
    if (!f || seen.has(key!)) return { badLine: i + 1 };
    seen.add(key!);
    forwards.push(f);
  }
  return { forwards };
}

/** 저장용 한 줄 문법으로 되돌린다. */
export const formatForward = (f: Forward) => `-${f.remote ? "R" : "L"} ${f.all && !f.remote ? "0.0.0.0:" : ""}${f.listen_port}:${f.host}:${f.port}`;
