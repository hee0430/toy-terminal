// 다국어 메시지 검사: ko.json과 en-US.json의 키 일치, 코드에서 쓰는데 없는 키, 정의했는데 안 쓰는 키.
// 사용법: npm run i18n:check
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// t(`a.${x}`)처럼 조립해서 쓰는 키의 앞부분. 여기 등록하면 그 아래 키는 "안 쓰는 키"로 보지 않는다.
const DYNAMIC_PREFIXES = ["settings.ansi.", "settings.colors.filter."];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const load = (f) => JSON.parse(readFileSync(join(root, "src", "messages", f), "utf8"));
const flatten = (o, p = "", out = []) => {
  for (const [k, v] of Object.entries(o)) (typeof v === "string" ? out.push(p + k) : flatten(v, p + k + ".", out));
  return out;
};

const ko = new Set(flatten(load("ko.json")));
const en = new Set(flatten(load("en-US.json")));
const problems = [];
for (const k of ko) if (!en.has(k)) problems.push(`en-US.json에 없는 키: ${k}`);
for (const k of en) if (!ko.has(k)) problems.push(`ko.json에 없는 키: ${k}`);

// 소스 수집 (src 아래 .ts, 그리고 index.html). 생성 데이터와 메시지 파일은 제외한다.
const files = [join(root, "index.html")];
const walk = (d) => {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) {
      if (name !== "data" && name !== "messages") walk(p);
    } else if (p.endsWith(".ts")) files.push(p);
  }
};
walk(join(root, "src"));
const source = files.map((f) => readFileSync(f, "utf8")).join("\n");

// 1) t("키") 로 쓰는데 정의가 없는 키
for (const m of source.matchAll(/\bt\(\s*(["'])([\w.]+)\1/g)) if (!ko.has(m[2])) problems.push(`정의되지 않은 키: ${m[2]}`);
for (const m of source.matchAll(/data-i18n(?:-title|-placeholder)?="([\w.]+)"/g)) if (!ko.has(m[1])) problems.push(`정의되지 않은 키(HTML): ${m[1]}`);
// 2) 조립 키는 앞부분을 등록해야 한다
for (const m of source.matchAll(/\bt\(\s*`([\w.]*)\$\{/g)) if (!DYNAMIC_PREFIXES.includes(m[1])) problems.push(`DYNAMIC_PREFIXES에 등록되지 않은 조립 키: ${m[1]}`);
// 3) 정의했는데 안 쓰는 키: 따옴표로 감싼 문자열로 한 번이라도 나오는지 본다
for (const k of ko) {
  if (DYNAMIC_PREFIXES.some((p) => k.startsWith(p))) continue;
  if (!new RegExp(`["'\`]${k.replace(/\./g, "\\.")}["'\`]`).test(source)) problems.push(`안 쓰는 키: ${k}`);
}

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`i18n 검사 통과 (키 ${ko.size}개)`);
