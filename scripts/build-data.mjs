// 번들용 데이터 생성: 터미널 색상 구성(스킴)과 Font Awesome 아이콘 목록.
// 사용법: node scripts/build-data.mjs <iTerm2-Color-Schemes 저장소 경로>
// 저장소는 Windows에서 체크아웃이 안 되는 파일 이름이 있어서 git 객체에서 직접 읽는다 (git ls-tree / git show).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = process.argv[2];
if (!repo) {
  console.error("사용법: node scripts/build-data.mjs <iTerm2-Color-Schemes 저장소 경로>");
  process.exit(1);
}
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
const out = join(root, "src", "data");
mkdirSync(out, { recursive: true });

// ---------- 색상 구성 ----------
const HEX = /^#[0-9a-fA-F]{6}$/;
const ANSI = ["black", "red", "green", "yellow", "blue", "purple", "cyan", "white",
  "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightPurple", "brightCyan", "brightWhite"];

const files = git("ls-tree", "-r", "-z", "--name-only", "HEAD", "windowsterminal").split("\0").filter((f) => f.endsWith(".json"));
const schemes = [];
const bad = [];
for (const f of files) {
  const j = JSON.parse(git("show", `HEAD:${f}`));
  const colors = ANSI.map((k) => j[k]);
  const need = [j.name, j.background, j.foreground, ...colors];
  if (need.some((v) => typeof v !== "string" || !v) || ![j.background, j.foreground, ...colors].every((c) => HEX.test(c))) {
    bad.push(f);
    continue;
  }
  const cursor = HEX.test(j.cursorColor ?? "") ? j.cursorColor : j.foreground;
  const sel = HEX.test(j.selectionBackground ?? "") ? j.selectionBackground : "";
  schemes.push({ n: j.name, b: j.background.toLowerCase(), f: j.foreground.toLowerCase(), c: cursor.toLowerCase(), s: sel.toLowerCase(), a: colors.map((c) => c.toLowerCase()) });
}
schemes.sort((a, b) => a.n.localeCompare(b.n, "en", { sensitivity: "base" }));
writeFileSync(join(out, "schemes.json"), JSON.stringify(schemes));
writeFileSync(join(out, "schemes-LICENSE.txt"), git("show", "HEAD:LICENSE") + "\n----\n" + git("show", "HEAD:CREDITS.md"));
console.log(`스킴 ${schemes.length}개, 제외 ${bad.length}개${bad.length ? ": " + bad.join(", ") : ""}`);

// ---------- Font Awesome 무료 아이콘 ----------
const STYLE_CLASS = { solid: "fas", regular: "far", brands: "fab" };
const fam = JSON.parse(readFileSync(join(root, "node_modules/@fortawesome/fontawesome-free/metadata/icon-families.json"), "utf8"));
const icons = [];
for (const [name, v] of Object.entries(fam)) {
  const styles = Object.keys(v.svgs?.classic ?? {}).filter((s) => STYLE_CLASS[s]);
  if (!styles.length) continue;
  // [이름, 스타일 접두사들, 검색어]
  icons.push([name, styles.map((s) => STYLE_CLASS[s]).join(","), [v.label ?? "", ...(v.search?.terms ?? [])].join(" ").toLowerCase()]);
}
icons.sort((a, b) => a[0].localeCompare(b[0]));
writeFileSync(join(out, "fa-icons.json"), JSON.stringify(icons));
console.log(`아이콘 ${icons.length}개`);
