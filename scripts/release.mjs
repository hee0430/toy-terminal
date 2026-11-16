// `npm run release`: tauri build 후 결과물을 release/ 에 모은다.
// 빌드 PC의 홈 폴더 경로(사용자 이름 포함)가 exe의 패닉 메시지에 박히지 않도록 `~` 로 바꿔서 빌드한다.
// 자동 업데이트용 서명 키: 환경변수가 없으면 ~/.tauri/toyterm.key를 쓰고, 암호는 터미널에서 직접 물어본다.
// 암호는 이 빌드 프로세스의 환경에만 넣고 어디에도 저장하지 않는다.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 입력이 화면에 보이지 않는 한 줄 입력. 터미널이 아니면 undefined. */
function askHidden(question) {
  const stdin = process.stdin;
  if (!stdin.isTTY) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    process.stdout.write(question);
    let text = "";
    const done = (value) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      resolve(value);
    };
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") return done(text);
        if (c === "\u0003") process.exit(130); // Ctrl+C
        else if (c === "\u007f" || c === "\b") text = text.slice(0, -1);
        else text += c;
      }
    };
    stdin.setEncoding("utf8");
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

const flags = [process.env.RUSTFLAGS, `--remap-path-prefix=${homedir()}=~`].filter(Boolean).join(" ");
const env = { ...process.env, RUSTFLAGS: flags };

const defaultKey = join(homedir(), ".tauri", "toyterm.key");
if (!env.TAURI_SIGNING_PRIVATE_KEY && existsSync(defaultKey)) env.TAURI_SIGNING_PRIVATE_KEY = defaultKey;
// 암호 변수가 아예 없을 때만 묻는다 (빈 문자열로 넣어 두었으면 암호 없는 키로 보고 묻지 않는다).
if (env.TAURI_SIGNING_PRIVATE_KEY && env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
  const pw = await askHidden("서명 키 암호 (없으면 Enter): ");
  if (pw !== undefined) env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = pw;
}

const r = spawnSync("npm", ["run", "tauri", "--", "build"], { stdio: "inherit", shell: true, env });
if (r.status !== 0) process.exit(r.status ?? 1);
await import("./collect-release.mjs");
