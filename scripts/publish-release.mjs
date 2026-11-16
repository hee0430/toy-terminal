// `npm run publish-release`: release/ 의 결과물을 GitHub 릴리즈로 올린다. 커밋과 푸시는 하지 않는다.
//   npm run publish-release -- --notes "변경 내용"   릴리즈 설명 (없으면 기본 문구)
//   npm run publish-release -- --yes                  확인 질문 없이 진행
// 같은 버전의 릴리즈가 이미 있으면 파일만 덮어쓴다. 태그(v<버전>)는 origin/main 기준으로 만들어지므로
// 이 버전의 코드가 푸시되어 있어야 한다 (아니면 중단한다).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "release");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const tag = `v${version}`;

const args = process.argv.slice(2);
const yes = args.includes("--yes");
const notesIdx = args.indexOf("--notes");
const notes = notesIdx >= 0 ? args[notesIdx + 1] : undefined;
if (notesIdx >= 0 && !notes) fail("--notes 뒤에 설명을 적어 주세요.");

function fail(msg) {
  console.error(`중단: ${msg}`);
  process.exit(1);
}
const run = (cmd, a, opts = {}) => spawnSync(cmd, a, { cwd: root, encoding: "utf8", ...opts });

// 올릴 파일: 설치 파일, 포터블, latest.json은 필수. macOS dmg는 있을 때만 (맥에서 따로 빌드해 넣어 둔 경우).
const required = [`ToyTerm_${version}_x64-setup.exe`, `ToyTerm_${version}_x64_portable.exe`, "latest.json"];
const optional = [`ToyTerm_${version}_universal.dmg`];
for (const f of required) if (!existsSync(join(out, f))) fail(`release/${f}가 없습니다. 먼저 npm run release로 빌드하세요.`);
const files = [...required, ...optional.filter((f) => existsSync(join(out, f)))];

// 오래된 결과물을 올리지 않도록 latest.json의 버전을 확인한다.
const latest = JSON.parse(readFileSync(join(out, "latest.json"), "utf8"));
if (latest.version !== version) fail(`latest.json의 버전(${latest.version})이 package.json(${version})과 다릅니다. 다시 빌드하세요.`);

// 이 버전의 코드가 원격에 있어야 한다.
if (run("git", ["fetch", "origin", "main", "--quiet"]).status !== 0) fail("git fetch에 실패했습니다.");
const ahead = run("git", ["rev-list", "--count", "origin/main..HEAD"]).stdout.trim();
if (ahead !== "0") fail(`아직 푸시하지 않은 커밋이 ${ahead}개 있습니다. 먼저 git push 하세요.`);

const exists = run("gh", ["release", "view", tag]).status === 0;
console.log(`${exists ? "기존 릴리즈에 파일 덮어쓰기" : "새 릴리즈 만들기"}: ${tag}`);
files.forEach((f) => console.log(`  ${f}`));

if (!yes) {
  if (!process.stdin.isTTY) fail("터미널이 아니어서 확인할 수 없습니다. --yes를 붙여 실행하세요.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question("올릴까요? (y/N) ")).trim().toLowerCase();
  rl.close();
  if (answer !== "y") fail("취소했습니다.");
}

const paths = files.map((f) => join(out, f));
const gh = exists
  ? ["release", "upload", tag, ...paths, "--clobber"]
  : [
      "release", "create", tag, ...paths, "--target", "main", "--title", `ToyTerm ${version}`,
      "--notes", notes ?? `ToyTerm ${version}: Windows x64 설치 파일과 포터블 실행 파일.`,
    ];
const r = run("gh", gh, { stdio: "inherit", encoding: undefined });
if (r.status !== 0) fail("gh 실행에 실패했습니다. gh auth status로 로그인 상태를 확인하세요.");
console.log(`완료: https://github.com/hee0430/toy-terminal/releases/tag/${tag}`);
