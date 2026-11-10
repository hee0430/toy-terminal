// 빌드 결과를 버전이 들어간 이름으로 release/ 폴더에 모은다. `npm run release`가 tauri build 뒤에 부른다.
//  - 설치 파일(NSIS)은 Tauri가 이미 버전을 넣은 이름으로 만든다: ToyTerm_0.8.0_x64-setup.exe (MSI는 만들지 않는다)
//  - 실행 파일(toyterm.exe)은 이름에 버전이 없어서 ToyTerm_0.8.0_x64_portable.exe 로 복사한다.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const target = join(root, "src-tauri", "target", "release");
const out = join(root, "release");
mkdirSync(out, { recursive: true });

const copied = [];
const copy = (from, name) => {
  if (!existsSync(from)) throw new Error(`빌드 결과가 없습니다: ${from}`);
  copyFileSync(from, join(out, name));
  copied.push(name);
};

copy(join(target, "toyterm.exe"), `ToyTerm_${version}_x64_portable.exe`);
// 설치 파일은 현재 버전으로 만들어진 것만 가져온다 (이전 버전 파일이 남아 있어도 섞이지 않게).
for (const [dir, ext] of [["nsis", ".exe"]]) {
  const folder = join(target, "bundle", dir);
  const files = existsSync(folder) ? readdirSync(folder).filter((f) => f.endsWith(ext) && f.includes(`_${version}_`)) : [];
  if (!files.length) throw new Error(`${dir} 설치 파일(버전 ${version})이 없습니다: ${folder}`);
  for (const f of files) copy(join(folder, f), f);
}
console.log(`버전 ${version} 결과물을 ${out} 에 모았습니다:\n  ${copied.join("\n  ")}`);
