# 저장 파일 위치

모두 **실행 파일과 같은 폴더**에 둔다 (개발 중에는 `src-tauri/target/debug/`, `cargo clean`하면 같이 지워짐). 폴더에 쓸 수 없으면 저장 시 오류만 표시하고 대체 경로는 없다.

- `profiles.json`: 프로필 트리. 비밀번호·키 암호는 저장하지 않는다. 예전 위치(`%APPDATA%\com.toy.terminal\`)에만 있으면 첫 실행에서 복사한다.
- `secrets.json`: 저장한 비밀번호·키 암호. 마스터 비밀번호(저장하지 않음)로 Argon2id 키를 만들어 AES-256-GCM으로 암호화하고, 항목 id를 추가 인증 데이터로 묶는다. 마스터 비밀번호가 맞는지는 고정 문구를 암호화한 검증값으로 확인한다. 잠금을 푼 키는 앱이 켜져 있는 동안 메모리에만 둔다(`secrets.rs`). 잊으면 복구할 수 없어 전체 삭제(`secrets_reset`)만 가능하다.
- `known_hosts.json`: SSH 호스트 지문. `{"호스트:포트": "SHA256:..."}`. 깨진 파일은 빈 목록으로 보지 않고 오류를 낸다(지문 검증이 조용히 꺼지는 것을 막기 위함).

- `settings.json`: 테마(dark/light/system), 언어(system/ko/en-US), 색상 구성 id(`auto`/`custom`/번들 스킴 이름), 사용자가 만든 `custom` 스킴. 읽을 때 항목별로 검사해서 틀린 값은 기본값으로 둔다(`src/settings.ts`).
- `icons/`: URL에서 내려받은 세션 아이콘 이미지(png/jpg/gif/webp/ico, 최대 1MB, SVG 불가). 프로필의 `icon` 필드가 파일 이름을 가리킨다. 프로필을 지우거나 아이콘을 바꿔도 파일은 지우지 않는다.

# 번들 데이터 다시 만들기

`src/data/schemes.json`(색상 구성 900여 개)과 `src/data/fa-icons.json`(Font Awesome 무료 아이콘 목록)은 생성 파일이다. `node scripts/build-data.mjs <iTerm2-Color-Schemes 저장소>`로 다시 만든다. 그 저장소는 Windows에서 체크아웃이 안 되는 파일 이름이 있어서 `git clone --no-checkout --depth 1`로 받고 스크립트가 git 객체를 직접 읽는다.

# 다국어

문구는 `src/messages/ko.json`, `en-US.json`에 같은 키로 두고 `t("ns.key", {변수})`로 쓴다. 고정 HTML은 `data-i18n`, `data-i18n-title`, `data-i18n-placeholder` 속성. 문구를 바꾸면 `npm run i18n:check`. `t(\`a.${x}\`)`처럼 조립하는 키는 `scripts/i18n-check.mjs`의 `DYNAMIC_PREFIXES`에 등록한다. 백엔드(Rust) 메시지는 번역하지 않고, 화면이 제목 키 뒤에 서버 원문을 `{error}`로 붙인다.

# 안전 점검에서 정한 규칙

- 터미널에 붙여넣는 모든 글(우클릭, Ctrl+V, AI의 [터미널에 입력])은 `pasteText()`에서 `sanitizePaste()`로 제어 문자(탭·줄바꿈 제외)를 지운다. xterm이 글을 거르지 않아 `ESC[201~`로 붙여넣기 감싸기를 끝내고 뒤의 명령을 실행시키는 pastejacking이 가능하기 때문이다. 새 붙여넣기 경로를 만들면 반드시 `pasteText()`를 거친다.
- 서버가 준 파일 이름은 `sftp.rs`의 `safe_name()`을 통과해야 로컬에 쓴다: 경로를 벗어나는 이름, Windows 장치 이름(`CON`, `NUL`, `COM1`… 확장자가 붙어도), 끝이 점·공백인 이름은 거절한다.
- 앱을 끝낼 때(`RunEvent::Exit`)도 임시 편집 파일을 지운다. 편집기가 잡고 있어 못 지운 파일은 다음 시작 때 다시 지운다.
- 탭 id는 `edit.rs`의 `valid_tab_id()`(`t숫자`만)를 통과해야 경로로 쓴다. `term_close`가 화면에서 받은 id로 임시 폴더를 지우므로, 이 검사가 없으면 `..`이나 `C:\` 같은 값으로 엉뚱한 폴더가 지워질 수 있다.
- 보안 정책(CSP)은 `tauri.conf.json`의 `csp`(운영)와 `devCsp`(개발, Vite 연결용 `ws://localhost:1420` 추가)에 있다. 스크립트는 `self`만(인라인·eval 불가), 스타일은 인라인 허용(코드가 `style` 속성을 많이 씀), 이미지·글꼴은 `data:` 허용(아이콘 data URL, 작은 글꼴 인라인), 연결은 `ipc: http://ipc.localhost`. 새로 외부 주소나 인라인 스크립트가 필요한 기능을 넣으면 여기를 같이 고쳐야 한다. 브라우저에서 CSP 헤더를 붙여 렌더링·지연 로딩 조각·스크립트 차단은 확인했지만 Tauri IPC 쪽은 앱에서 직접 확인이 필요하다.
- `cargo audit`는 설치되어 있지 않다.

# SFTP 파일 편집

SFTP 목록에서 편집 가능한 파일을 우클릭 → [편집]. `sftp_edit`(`edit.rs`)가 `%TEMP%\toyterm-edit\<탭 id>\<난수>\`에 내려받고(5MB 이하, 앞 8KB에 NUL이 있으면 이진 파일로 거절) 편집기를 연 뒤, 1초마다 임시 파일의 수정 시각·크기를 보다가 두 번 연속 같은 값이면(저장이 끝난 것) 서버에 덮어써서 올린다. 올리기 전에 항상 `sftp-edit-confirm` 이벤트로 "업로드할까요?"를 묻고(`edit_answer`로 응답, 취소하면 다음 저장 때 다시 묻는다), 서버 파일의 mtime이 내려받을 때와 다르면 `conflict: true`로 덮어쓰기 경고를 같이 보여 준다. 탭을 닫으면(`term_close`) 감시를 멈추고 임시 폴더를 지우며, 앱 시작 때도 남은 임시 폴더를 지운다. 편집기를 닫은 시점은 알 수 없어서 탭을 닫을 때까지 감시한다.
편집기는 설정의 `editor`(비어 있으면 PowerShell `Start-Process -Verb Edit`, 실패하면 메모장). "열기"가 아니라 "편집" 동작만 쓰는 것은 `.bat`, `.sh` 같은 파일이 연결 프로그램으로 실행되는 것을 막기 위함이다.

# 터미널 글꼴

설정 `fontFamily`(비면 기본), `fontSize`(8~32). CSS 값은 `fontStack()`이 `"이름", "Cascadia Mono", Consolas, monospace`로 만든다(따옴표·쉼표·중괄호는 지워 다른 CSS가 끼어들지 못하게 함). 앱에 포함한 글꼴은 `src/fonts.css`에서 woff2만 등록한다: JetBrains Mono, Cascadia Mono(라틴 범위, 400/700)와 D2Coding(한글 2350자 부분집합, 400/700). Consolas, Courier New는 Microsoft 글꼴이라 담지 않고 Windows의 것을 쓴다. 포함 글꼴은 처음 쓸 때 불러오므로 `ensureFontLoaded()`로 터미널이 글자 칸을 재기 전에 미리 불러온다. 글꼴을 추가하려면 `fonts.css`, `fonts.ts`의 목록, `fonts-LICENSE.txt`와 `THIRD_PARTY_NOTICES.md`를 함께 고친다.

# AI 도우미

OpenAI 호환 서버만 지원한다(직접 운영하는 서버 전제). 설정 `ai`: `url`(`/v1`까지만 적어도 `/chat/completions`를 붙임, http 허용), `model`, `apiKey`(**settings.json에 평문 저장** — 직접 운영하는 서버에서 쓰는 것을 전제로 정함, 비우면 인증 헤더 없음), `system`(추가 지시문), `consent`(전송에 동의한 서버 주소 — 주소가 바뀌면 다시 묻는다).
호출은 백엔드 `llm.rs`의 `llm_stream`이 reqwest로 하고(키가 화면 밖에서만 쓰임), 답을 `llm-chunk`/`llm-done`/`llm-error` 이벤트로 흘린다. `llm_cancel`로 중지. 스트림 해석(`SseBuffer`)은 줄·한글이 조각 경계에서 잘려도 안전하고, 로컬 가짜 서버를 띄운 통신 시험이 `llm.rs`에 있다.
화면은 `ai.ts`(사이드바 [AI] 탭). **AI는 명령을 제안만 한다**: 답 안의 코드 블록 [터미널에 입력]은 마지막 줄바꿈을 지우고 붙여넣기만 한다(Enter는 사용자). 첨부(선택한 출력, 최근 50줄)는 `redact.ts`로 비밀번호·토큰·개인키·주소 안 계정 정보 등을 가린 뒤 칩으로 미리 보여 주고 보낸다. 완벽한 가림은 아니다. `ai.autoScreen`(기본 꺼짐)을 켜면 질문마다 활성 터미널의 최근 50줄을 가림 처리 후 자동으로 붙이고(항상 보이는 칩, 누르면 보낼 내용 미리보기, ✕는 기능 끄기), 켤 때 전송 확인을 받는다. [선택한 출력 설명]은 선택 출력을 첨부해 "설명해 달라"는 고정 질문을 바로 보낸다. 대화는 메모리에만 두고 저장하지 않는다. 모델에게는 활성 탭의 설명(`Tab.context`: 셸 종류, SSH 접속 대상)을 시스템 지시문에 넣어 준다.

AI 시스템 프롬프트는 **소스 코드에만 있다**(`src/aiPrompt.ts`의 `SAFETY_PROMPT`). 설정이나 settings.json으로 바꿀 수 없고, `buildSystemPrompt()`가 항상 맨 앞에 넣는다. 설정의 "추가 지시문"은 그 뒤에 "안전 규칙을 바꿀 수 없음" 머리글과 함께 덧붙는다. 앱은 현재 명령을 실행하지 못하므로(제안만) 프롬프트 앞에 "실행은 제안으로 읽으라"는 설명(`modeNote`)을 붙였다. 프롬프트에는 고정된 작업 폴더(예전의 `/home/agent/workspace`)를 두지 않는다. 있으면 모델이 자기 작업 공간이 있다고 착각해서 없는 폴더를 만들거나 그곳으로 이동하려 했다. 대신 "요청한 경로에서만 작업하고, 모르면 물어본다"로 쓴다. 채팅창 `/명령`(`/clear /help /screen /selection /recent /explain`)은 `ai.ts`의 `COMMANDS`에서 서버로 보내지 않고 처리한다. `/etc/hosts`처럼 경로로 시작하는 질문은 명령이 아니라 질문으로 본다(`parseSlash`).

설정 > AI 맨 위의 [사용]/[미사용] 버튼(`ai.enabled`, 기본 사용, 값이 없으면 사용)으로 AI 도우미 전체를 끌 수 있다. 미사용이면 [AI] 세로 탭이 사라지고, 보고 있던 패널이면 세션으로 돌아가며, 진행 중인 답은 멈춘다. 서버 주소 등 입력값은 지우지 않고 그대로 둔다(`refreshAi()`가 처리).
AI 기록(`ai.log`, 기본 꺼짐)을 켜면 실행 파일 옆 `logs/ai-YYYY-MM-DD.jsonl`(로컬 날짜, 하루에 파일 하나)에 JSON 한 줄씩 덧붙인다: `question`(질문, 첨부 — 가림 처리 후 보낸 그대로, 모델, 터미널 설명), `answer`(답, 오류), `insert`([터미널에 입력]으로 넣은 명령). 쓰는 곳은 백엔드 `logs.rs`의 `log_append`이고, 종류(`ai`만 허용)와 날짜 형식을 엄격히 검사해 경로를 벗어나지 못하게 한다. 기록에 실패해도 대화는 계속되고 처음 한 번만 알린다. 파일은 자동으로 지우지 않는다. 같은 폴더의 `audit-*.jsonl`(명령 실행 감사 기록: 명령, 판정, 종료 코드, 출력 4KB, 가림 처리)은 끌 수 없고 백엔드(`logs::audit`)만 쓴다. 프런트의 `log_append`는 `ai`만 허용한다.

## AI 명령 실행 (SSH 탭, 읽기 전용 자동 실행)
설정 `ai.exec`(기본 꺼짐, 켤 때 확인)과 `ai.tools`(서버가 OpenAI 도구 호출을 지원함; 끄면 모델이 ` ```run ` 코드 블록으로 요청). 켜져 있고 활성 탭이 SSH일 때만 동작하고, 그 밖에는 제안만 한다. 흐름은 `ai.ts`의 `startRound → finish → runCalls → runOne → agent_run`(백엔드 `exec.rs`)이며 질문 하나당 최대 8단계, 한 번에 3개 명령, 명령당 20초·출력 20KB.
- 판정은 백엔드 `policy.rs`의 `classify()`가 한다: 읽기 전용 허용 목록은 바로 실행(`auto`), 그 밖은 사용자 승인(`approve`), 금지 목록·민감 파일·숨은 문자·포크 폭탄 등은 거절(`deny`). 승인 대기는 백엔드가 oneshot을 쥐고 `agent-approve` 이벤트를 보내므로 프런트가 명령을 바꿔치기할 수 없다. 허용 목록은 완벽한 보안 장치가 아니다. 서버 쪽 권한 제한 계정이 더 강하다.
- 명령은 SSH 연결의 별도 exec 채널로 실행하므로 사용자 터미널에는 찍히지 않는다. 결과는 `redact`로 가린 뒤 모델에 돌려준다(`redact.rs`와 `src/redact.ts`의 규칙은 같이 고친다).
- 대화는 세션(탭)마다 따로다(`ai.ts`의 `Chat`, 키는 탭 id). 탭을 바꾸면 그 세션의 대화 칸(`Chat.el`)이 교체되어 보이고, 다른 탭에서 진행 중이던 답·명령 실행은 뒤에서 계속된다. 탭을 닫으면 `closeChat()`가 그 대화를 멈추고 지운다. 이벤트는 `req`로 대화를 찾고, 승인 요청은 같은 명령을 실행 중인 대화의 카드에 붙는다. 대화 중인 세션이 보이지 않을 때 승인 대기가 생겨도 표시는 없다(그 세션으로 가야 보인다).
- AI 탭은 사용 설정이 켜져 있고 서버 주소·모델이 있고 열린 세션이 있을 때만 보인다(`refreshAi()`, 탭 활성화·닫기 때 호출).
- 새 대화(/clear)는 `gen`을 올려 진행 중이던 작업의 뒤늦은 결과가 섞이지 않게 한다. 로컬 셸 탭은 아직 지원하지 않는다.
- 실제 SSH exec와 사용자의 LLM 도구 호출은 단위 시험 밖이라 직접 확인이 필요하다.

# 버전

원본은 `package.json`의 `version` 하나다. 화면은 `src/version.ts`가 빌드 때 이 값을 코드로 가져와(`APP_VERSION`) 세로 탭 아래와 설정의 "정보"에 보여 주고, `tauri.conf.json`의 `version`은 `"../package.json"`을 가리켜 설치 파일 이름과 버전이 같은 값을 쓴다. 버전을 올릴 때는 `package.json`의 `version`(항상 `0.8.0`처럼 세 자리 semver)과 `src-tauri/Cargo.toml`의 `version`, 두 lock 파일(`package-lock.json`의 앞 두 곳, `Cargo.lock`의 `toyterm`)을 같이 고친다. 화면에는 파일 이름과 같게 `v0.8.0`으로 그대로 보여 준다.

빌드는 `npm run release`: `tauri build` 뒤 `scripts/collect-release.mjs`가 결과물을 `release/` 폴더에 버전이 들어간 이름으로 모은다 — `ToyTerm_0.8.0_x64_portable.exe`(실행 파일을 복사해 이름 변경), `ToyTerm_0.8.0_x64-setup.exe`(NSIS). MSI는 만들지 않는다(`tauri.conf.json`의 `bundle.targets`가 `["nsis"]`). 설치 파일 이름의 버전은 Tauri가 넣는다. 배포 파일에 빌드한 PC의 경로가 들어가지 않게 `RUSTFLAGS`에 `--remap-path-prefix`(프로젝트, `.cargo`, `.rustup`)와 `-Clink-arg=/PDBALTPATH:toyterm.pdb`를 주고 빌드한다. 배포는 GitHub Releases에 올리고(`release/`는 git에 넣지 않는다) README는 `releases/latest` 링크를 건다.

# 라이선스

프로젝트는 MIT(`LICENSE`, 저작권자 hee0430). 배포 파일에 들어가는 라이브러리의 라이선스 전문은 `THIRD_PARTY_LICENSES.md`이고 `npm run licenses`(`scripts/gen-licenses.mjs`)가 `cargo metadata`(Windows용, 빌드·개발 전용 제외)와 `node_modules`에서 뽑아 만든다. 의존성을 바꾸면 다시 만들어 커밋한다. 의존성을 추가했을 때는 만들어진 "라이선스 종류" 목록에 GPL, AGPL, LGPL 같은 강한 조건이 섞이지 않았는지 본다. 지금은 MPL-2.0(수정하지 않은 원본, 소스 주소를 파일에 적음)이 가장 강한 조건이다.

# 드래그앤드롭

탐색기 → SFTP 업로드는 Tauri의 창 단위 파일 드롭(`dragDropEnabled: true`, `onDragDropEvent`)을 쓴다. 이 기능을 켜면 Windows에서는 HTML5 드래그앤드롭이 동작하지 않으므로, 세션 트리 끌기는 포인터 이벤트로 직접 구현했다(`profiles.ts`의 `initTreeDrag`). 새로 HTML5 드래그(`draggable`, `dragstart`)를 쓰지 말 것. 이벤트 위치는 화면 픽셀이라 `devicePixelRatio`로 나눠 `elementFromPoint`에 쓴다. 업로드는 `sftp_plan_upload`가 로컬 폴더를 하위까지 풀고(심볼릭 링크 제외, 2만 개 상한), 최상위 항목이 서버에 이미 있으면 덮어쓸지 묻고, `sftp_mkdirs` 후 파일마다 `sftp_upload`를 부른다. SFTP → 탐색기로 끌어내는 다운로드는 만들지 않았다(Windows는 끌 때 로컬 파일이 이미 있어야 해서, 미리 받아 두는 방식이 필요함).

# SFTP 경로 표시

`sftp_list`는 `/`로 시작하는 경로를 서버에 물어 풀지 않고(심볼릭 링크 유지) 문자열로만 정리한다. 상대 경로나 빈 경로일 때만 서버의 `canonicalize`로 홈을 알아낸다. 폴더를 가리키는 심볼릭 링크는 `metadata`로 확인해 폴더로 표시한다.

# SSH 지문 확인 흐름

`ssh.rs`의 `check_server_key` → `hostkeys::verify` → 이벤트 `host-key-prompt`로 화면에 묻고, 화면은 `host_key_answer(req, choice)`로 답한다. choice: `trust`(저장) / `once`(이번만) / `cancel`. 지문이 달라진 경우에만 `once`를 선택지로 보여 준다.

# SFTP 폴더 다운로드

`sftp_plan_download`가 선택 항목을 하위까지 풀어 파일 목록을 만들고, 화면이 파일마다 `sftp_download`를 부른다. 서버가 준 이름이 `/ \ : ..` 를 포함하면 로컬 경로 탈출을 막으려고 제외한다. 심볼릭 링크 폴더는 따라가지 않는다.
