// 배포 파일에 실제로 들어가는 제3자 라이브러리의 라이선스 목록과 전문을 THIRD_PARTY_LICENSES.md로 만든다.
// MIT/BSD/Apache 같은 라이선스는 코드를 넣어 배포할 때 저작권 문구와 라이선스 전문을 함께 주도록 요구한다.
//  - Rust: `cargo metadata`로 Windows용 실행 파일에 링크되는(빌드·개발 전용 제외) 의존성만 모은다.
//  - npm: package.json의 dependencies와 그 하위 dependencies (devDependencies는 배포 파일에 들어가지 않으므로 제외).
// 의존성을 바꾸면 `npm run licenses`로 다시 만든다. 내용이 같은 전문은 한 번만 쓰고 해당 패키지를 나열한다.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const LICENSE_FILE = /^(licen[cs]e|copying|notice|unlicense)([-._].*)?$/i;

/** 폴더 맨 위의 라이선스·고지 파일 내용 */
function licenseTexts(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && LICENSE_FILE.test(e.name))
    .map((e) => readFileSync(join(dir, e.name), "utf8").replace(/\r\n/g, "\n").trim())
    .filter(Boolean);
}

const packages = []; // { eco, name, version, license, repo, texts }

// ---------- Rust ----------
const meta = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--offline", "--filter-platform", "x86_64-pc-windows-msvc"], {
    cwd: join(root, "src-tauri"),
    maxBuffer: 1 << 29,
  }).toString(),
);
const byId = new Map(meta.packages.map((p) => [p.id, p]));
const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
const seen = new Set();
const stack = [meta.resolve.root];
while (stack.length) {
  const id = stack.pop();
  if (seen.has(id)) continue;
  seen.add(id);
  for (const d of nodes.get(id).deps) if (d.dep_kinds.some((k) => k.kind === null)) stack.push(d.pkg); // kind가 null이면 일반(링크되는) 의존성
}
for (const id of seen) {
  if (id === meta.resolve.root) continue;
  const p = byId.get(id);
  packages.push({ eco: "Rust", name: p.name, version: p.version, license: p.license || (p.license_file ? `(파일: ${p.license_file})` : "표기 없음"), repo: p.repository || "", texts: licenseTexts(dirname(p.manifest_path)) });
}

// ---------- npm ----------
const pkgJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const npmSeen = new Map();
function visitNpm(name) {
  if (npmSeen.has(name)) return;
  const dir = join(root, "node_modules", name);
  const file = join(dir, "package.json");
  if (!existsSync(file)) throw new Error(`node_modules에 ${name}이(가) 없습니다. npm install 뒤에 다시 실행하세요.`);
  const p = JSON.parse(readFileSync(file, "utf8"));
  const lic = typeof p.license === "string" ? p.license : p.license?.type ?? (p.licenses ? p.licenses.map((l) => l.type).join(" OR ") : "표기 없음");
  const repo = typeof p.repository === "string" ? p.repository : p.repository?.url ?? "";
  npmSeen.set(name, { eco: "npm", name, version: p.version, license: lic, repo, texts: licenseTexts(dir) });
  for (const dep of Object.keys(p.dependencies ?? {})) visitNpm(dep);
}
for (const dep of Object.keys(pkgJson.dependencies ?? {})) visitNpm(dep);
packages.push(...npmSeen.values());

packages.sort((a, b) => a.eco.localeCompare(b.eco) || a.name.localeCompare(b.name));

// ---------- 출력 ----------
const byText = new Map(); // 전문 -> 그 전문을 쓰는 패키지들
const noText = [];
for (const p of packages) {
  if (!p.texts.length) noText.push(p);
  for (const t of p.texts) {
    if (!byText.has(t)) byText.set(t, []);
    byText.get(t).push(p);
  }
}
const licCount = new Map();
for (const p of packages) licCount.set(p.license, (licCount.get(p.license) ?? 0) + 1);

const out = [];
out.push("# 제3자 라이선스 전문", "");
out.push("이 파일은 `npm run licenses`(`scripts/gen-licenses.mjs`)가 만든 것으로, 직접 고치지 않습니다.");
out.push("ToyTerm 설치 파일과 실행 파일에 포함되는 라이브러리의 라이선스 목록과 전문입니다. 글꼴, Font Awesome, 색상 구성의 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 있습니다.", "");
out.push(`총 ${packages.length}개 (Rust ${packages.filter((p) => p.eco === "Rust").length}, npm ${packages.filter((p) => p.eco === "npm").length})`, "");
out.push("## 라이선스 종류", "");
for (const [lic, n] of [...licCount].sort((a, b) => b[1] - a[1])) out.push(`- ${lic}: ${n}개`);
out.push("", "## 패키지 목록", "", "| 구분 | 이름 | 버전 | 라이선스 |", "| --- | --- | --- | --- |");
for (const p of packages) out.push(`| ${p.eco} | ${p.name} | ${p.version} | ${p.license.replace(/\|/g, "\\|")} |`);
if (noText.length) {
  out.push("", "## 라이선스 파일이 따로 없는 패키지", "", "패키지 정보(Cargo.toml, package.json)의 라이선스 표기만 있는 경우입니다. 해당 라이선스의 표준 전문을 따릅니다.", "");
  for (const p of noText) out.push(`- ${p.name} ${p.version}: ${p.license}${p.repo ? ` (${p.repo})` : ""}`);
}
// MPL-2.0은 실행 파일로 배포할 때 소스 코드를 받을 수 있는 곳을 알려 주도록 요구한다 (수정하지 않은 원본을 쓴다).
const mpl = packages.filter((p) => /MPL/.test(p.license));
if (mpl.length) {
  out.push("", "## MPL-2.0 패키지의 소스 코드", "", "아래 패키지는 Mozilla Public License 2.0입니다. 수정하지 않은 원본 그대로 사용하며, 소스 코드는 다음 주소에서 받을 수 있습니다. 라이선스 전문: https://www.mozilla.org/MPL/2.0/", "");
  for (const p of mpl) out.push(`- ${p.name} ${p.version}: https://crates.io/crates/${p.name}/${p.version}${p.repo ? ` (${p.repo})` : ""}`);
}
out.push("", "## 라이선스 전문", "");
let n = 0;
for (const [text, pkgs] of [...byText].sort((a, b) => b[1].length - a[1].length)) {
  n++;
  out.push(`### ${n}. ${pkgs.map((p) => `${p.name} ${p.version}`).slice(0, 8).join(", ")}${pkgs.length > 8 ? ` 외 ${pkgs.length - 8}개` : ""}`, "");
  if (pkgs.length > 8) out.push(`<details><summary>이 전문을 쓰는 패키지 ${pkgs.length}개</summary>`, "", pkgs.map((p) => `${p.name} ${p.version}`).join(", "), "", "</details>", "");
  out.push("```text", text, "```", "");
}
writeFileSync(join(root, "THIRD_PARTY_LICENSES.md"), out.join("\n"));

console.log(`패키지 ${packages.length}개, 서로 다른 전문 ${byText.size}개, 라이선스 파일 없음 ${noText.length}개`);
console.log("라이선스 종류:");
for (const [lic, c] of [...licCount].sort((a, b) => b[1] - a[1])) console.log(`  ${c}\t${lic}`);
