// `npm run release`: tauri build 후 결과물을 release/ 에 모은다.
// 빌드 PC의 홈 폴더 경로(사용자 이름 포함)가 exe의 패닉 메시지에 박히지 않도록 `~` 로 바꿔서 빌드한다.
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";

const flags = [process.env.RUSTFLAGS, `--remap-path-prefix=${homedir()}=~`].filter(Boolean).join(" ");
const r = spawnSync("npm", ["run", "tauri", "--", "build"], { stdio: "inherit", shell: true, env: { ...process.env, RUSTFLAGS: flags } });
if (r.status !== 0) process.exit(r.status ?? 1);
await import("./collect-release.mjs");
