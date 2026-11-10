# ToyTerm

Windows와 macOS용 SSH/로컬 셸 터미널입니다. 여러 서버를 탭과 분할 화면으로 열고, SFTP로 파일을 주고받고, 필요하면 AI 도우미에게 물어볼 수 있습니다. (Tauri + xterm.js + Rust)

## 다운로드

**[최신 버전 받기 (Releases)](https://github.com/hee0430/toy-terminal/releases/latest)**

| 파일 | 설명 |
| --- | --- |
| `ToyTerm_<버전>_x64-setup.exe` | 설치 파일 |
| `ToyTerm_<버전>_x64_portable.exe` | 설치 없이 바로 실행 |
| `ToyTerm_<버전>_universal.dmg` | macOS용 (Apple Silicon, Intel 공용) |

**Windows**

* Windows 10/11 (64비트)용입니다.
* 코드 서명이 없어서 Windows SmartScreen이 "알 수 없는 게시자" 경고를 띄울 수 있습니다. "추가 정보 → 실행"을 누르면 됩니다.

**macOS**

* dmg를 열어 ToyTerm을 Applications로 옮깁니다.
* 코드 서명과 공증이 없어서 처음 실행할 때 막힐 수 있습니다. 앱을 우클릭 → 열기로 승인하세요. "손상되었다"고 나오면 터미널에서 `xattr -cr /Applications/ToyTerm.app`을 실행합니다.
* 로컬 탭은 사용자의 기본 셸(zsh 등)로 열립니다. PowerShell, cmd, 관리자 권한 실행은 Windows 전용입니다.

## 주요 기능

**접속과 세션**

* SSH와 로컬 셸 탭 (Windows: PowerShell 7, Windows PowerShell, cmd, 관리자 권한 / macOS: 기본 셸)
* 폴더로 정리하는 세션 목록, 끌어서 옮기기
* 이 PC의 `~/.ssh/config`를 "로컬 세션" 폴더에 읽기 전용으로 표시
* 비밀번호 저장: 마스터 비밀번호로 암호화 (Argon2id + AES-256-GCM)
* 키 파일 인증, 키 암호는 필요할 때만 입력
* 포트 포워딩(로컬/원격), 연결 유지(keepalive) 설정
* 끊어진 세션 다시 연결

**화면**

* 분할 화면(최대 4개, 경계를 끌어 크기 조절)과 동시 입력
* 탭 이름 바꾸기, 끌어서 순서 바꾸기, 다른 탭에 새 출력이 오면 파란 점
* 터미널 내 검색(Ctrl+F), 스크롤백 줄 수 설정, Ctrl+마우스 휠로 글꼴 크기 조절
* 색상 구성 900여 개, 다크/화이트 모드, 글꼴 선택(JetBrains Mono, Cascadia Mono, D2Coding 포함)
* 한국어, 영어

**파일과 도우미**

* SFTP 패널: 업로드(탐색기에서 끌어 놓기), 폴더 다운로드, 파일 편집
* AI 도우미: OpenAI 호환 서버를 연결해 질문하고 명령을 제안받습니다. SSH 탭에서는 명령 실행도 켤 수 있고, 읽기 전용 명령만 자동 실행하며 나머지는 승인을 받습니다.
  * 질문과 터미널 내용은 사용자가 지정한 서버로 전송됩니다. 처음 연결하는 서버 주소마다 동의를 받습니다.
  * API 키는 `settings.json`에 평문으로 저장됩니다. 직접 운영하는 서버에서 쓰는 것을 전제로 합니다.

## 저장되는 파일

Windows는 실행 파일과 같은 폴더에, macOS는 `~/Library/Application Support/com.toy.terminal/`에 저장됩니다.

| 파일 | 내용 |
| --- | --- |
| `profiles.json` | 세션 목록 (비밀번호는 들어 있지 않음) |
| `settings.json` | 설정 |
| `known_hosts.json` | 접속한 서버의 지문 |
| `secrets.json` | 마스터 비밀번호로 암호화한 저장 비밀번호 |
| `logs/` | AI 기록, 명령 실행 감사 기록 |

마스터 비밀번호는 어디에도 저장되지 않습니다. 잊으면 저장된 비밀번호를 복구할 수 없고, 설정 > 일반에서 전체 삭제 후 새로 정해야 합니다.

## 개발

필요한 것: Node.js, Rust. Windows는 MSVC 툴체인과 WebView2, macOS는 Xcode Command Line Tools

```bash
npm install
npm run tauri dev      # 개발 모드로 실행
npm test               # 프런트 단위 테스트
npm run i18n:check     # 화면 문구 키 검사
npm run release        # (Windows) 설치 파일과 portable 실행 파일을 release/ 에 만든다
```

Rust 테스트는 `src-tauri` 폴더에서 `cargo test --bin toyterm`으로 돌립니다. 키 파일 읽기 테스트는 `ssh-keygen`이 필요합니다.

## 라이선스

[MIT License](LICENSE)입니다. 누구나 자유롭게 사용, 수정, 배포할 수 있고, 상업적 이용도 허용됩니다.

포함된 오픈소스 라이브러리의 라이선스는 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md), 글꼴·아이콘·색상 구성의 고지는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 있습니다.
