// OpenSSH 클라이언트 설정(~/.ssh/config)에서 접속 정보만 읽는다. 순수 함수라 파일 읽기는 호출하는 쪽이 한다.
// 지원하는 것: Host(여러 이름 가능), HostName, Port, User, IdentityFile. 와일드카드 Host, Match, Include는 무시한다.

export type SshConfigEntry = { name: string; host: string; port?: number; user?: string; keyPath?: string };

/** `Key value`, `Key=value`, 따옴표 값을 읽는다. 주석·빈 줄은 null. */
function parseLine(line: string): [string, string] | null {
  const s = line.trim();
  if (!s || s.startsWith("#")) return null;
  const m = /^([A-Za-z]+)\s*(?:=\s*|\s+)(.*)$/.exec(s);
  if (!m) return null;
  let v = m[2].trim();
  if (v.startsWith('"') && v.indexOf('"', 1) > 0) v = v.slice(1, v.indexOf('"', 1));
  return [m[1].toLowerCase(), v];
}

const isPattern = (n: string) => /[*?!]/.test(n);

export function parseSshConfig(text: string): SshConfigEntry[] {
  const out: SshConfigEntry[] = [];
  let block: SshConfigEntry[] = []; // 지금 읽는 Host 줄이 만든 항목들 (같은 옵션을 함께 받는다)
  let inMatch = false;
  // OpenSSH는 같은 옵션이 여러 번이면 처음 값을 쓴다.
  const seen = new Set<string>();

  for (const line of text.split(/\r?\n/)) {
    const kv = parseLine(line);
    if (!kv) continue;
    const [key, value] = kv;
    if (key === "host") {
      inMatch = false;
      seen.clear();
      block = value
        .split(/\s+/)
        .filter((n) => n && !isPattern(n))
        .map((name) => ({ name, host: name }));
      out.push(...block);
      continue;
    }
    if (key === "match") {
      inMatch = true;
      block = [];
      continue;
    }
    if (inMatch || !block.length || seen.has(key)) continue;
    if (key === "hostname" && value) {
      seen.add(key);
      block.forEach((e) => (e.host = value));
    } else if (key === "user" && value) {
      seen.add(key);
      block.forEach((e) => (e.user = value));
    } else if (key === "port") {
      seen.add(key);
      const n = Number(value);
      if (Number.isInteger(n) && n > 0 && n < 65536) block.forEach((e) => (e.port = n));
    } else if (key === "identityfile" && value) {
      seen.add(key);
      block.forEach((e) => (e.keyPath = value));
    }
  }
  return out;
}
