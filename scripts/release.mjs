// `npm run release`: tauri build 후 결과물을 release/ 에 모은다.
// 빌드 PC의 홈 폴더 경로(사용자 이름 포함)가 exe의 패닉 메시지에 박히지 않도록 `~` 로 바꿔서 빌드한다.
// 자동 업데이트용 서명 키: 환경변수가 없으면 ~/.tauri/toyterm.key를 쓰고, 암호는 터미널에서 직접 물어본다.
// 암호는 이 빌드 프로세스의 환경에만 넣고 어디에도 저장하지 않는다.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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

/** 작은 파일에 서명해 보고 키와 암호가 맞는지 본다 (빌드는 맨 끝에서야 서명하므로, 틀린 암호를 몇 분 뒤에 알게 되지 않도록). */
function checkSigningKey(keyPath, password) {
  const dir = mkdtempSync(join(tmpdir(), "toyterm-sign-"));
  try {
    const file = join(dir, "check.txt");
    writeFileSync(file, "check");
    // signer sign은 TAURI_SIGNING_PRIVATE_KEY를 경로가 아니라 키 내용으로 읽으므로, 경로는 _PATH 변수로 넘긴다.
    const checkEnv = { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PATH: keyPath, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password };
    delete checkEnv.TAURI_SIGNING_PRIVATE_KEY;
    const r = spawnSync("npm", ["run", "tauri", "--", "signer", "sign", file], { shell: true, encoding: "utf8", env: checkEnv });
    const output = `${r.stdout}${r.stderr}`;
    return { ok: r.status === 0, wrongPassword: output.includes("Wrong password"), output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const defaultKey = join(homedir(), ".tauri", "toyterm.key");
if (!env.TAURI_SIGNING_PRIVATE_KEY && existsSync(defaultKey)) env.TAURI_SIGNING_PRIVATE_KEY = defaultKey;
const keyIsFile = !!env.TAURI_SIGNING_PRIVATE_KEY && existsSync(env.TAURI_SIGNING_PRIVATE_KEY);
// 암호 변수가 아예 없을 때만 묻는다 (빈 문자열로 넣어 두었으면 암호 없는 키로 보고 묻지 않는다).
// 묻는 경우에는 빌드 전에 암호를 확인해서 틀리면 다시 묻는다 (3번까지).
if (env.TAURI_SIGNING_PRIVATE_KEY && env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const pw = await askHidden("서명 키 암호 (없으면 Enter): ");
    if (pw === undefined) break;
    if (!keyIsFile) {
      env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = pw;
      break;
    }
    const c = checkSigningKey(env.TAURI_SIGNING_PRIVATE_KEY, pw);
    if (c.ok) {
      env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = pw;
      console.log("암호 확인됨.");
      break;
    }
    if (!c.wrongPassword) {
      console.error(c.output);
      process.exit(1);
    }
    console.error(attempt < 3 ? "암호가 틀렸습니다. 영문 입력 상태인지 확인하고 다시 입력하세요." : "암호가 3번 틀렸습니다.");
    if (attempt === 3) process.exit(1);
  }
} else if (keyIsFile && env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD !== undefined) {
  // 환경변수로 받은 암호도 빌드 전에 확인한다.
  const c = checkSigningKey(env.TAURI_SIGNING_PRIVATE_KEY, env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD);
  if (!c.ok) {
    console.error(c.wrongPassword ? "TAURI_SIGNING_PRIVATE_KEY_PASSWORD의 암호가 키와 맞지 않습니다. (이 창에 이전에 넣은 값이 남아 있을 수 있습니다.)" : c.output);
    process.exit(1);
  }
}

const r = spawnSync("npm", ["run", "tauri", "--", "build"], { stdio: "inherit", shell: true, env });
if (r.status !== 0) process.exit(r.status ?? 1);
await import("./collect-release.mjs");
