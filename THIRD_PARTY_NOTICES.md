# 제3자 소프트웨어 고지

글꼴, 아이콘, 색상 구성의 고지입니다. 프로그램에 링크되는 라이브러리(Rust, npm)의 라이선스 목록과 전문은 [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)에 있습니다 (`npm run licenses`로 생성).

## Font Awesome Free (@fortawesome/fontawesome-free)
세션 아이콘 선택 목록과 설정 버튼에 쓰는 아이콘과 글꼴입니다.
- 아이콘: CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)
- 글꼴: SIL OFL 1.1
- 코드: MIT
- 출처: https://fontawesome.com/license/free

## 터미널 글꼴 (SIL Open Font License 1.1)
앱에 포함된 글꼴입니다. 각 글꼴의 저작권 표기와 라이선스 전문은 `src/data/fonts-LICENSE.txt`에 있습니다.
- JetBrains Mono — The JetBrains Mono Project Authors (npm `@fontsource/jetbrains-mono`, 라틴 문자 범위)
- Cascadia Mono — Microsoft Corporation (npm `@fontsource/cascadia-mono`, 라틴 문자 범위)
- D2Coding — NAVER Corporation (npm `d2coding`의 부분집합 파일: 한글 2350자와 기본 문자만 담음, 원본은 https://github.com/naver/d2codingfont)

Consolas와 Courier New는 Microsoft 글꼴이라 앱에 담지 않고 Windows에 설치된 것을 씁니다.

## iTerm2-Color-Schemes
설정의 터미널 색상 구성 목록은 https://github.com/mbadolato/iTerm2-Color-Schemes 의 Windows Terminal 형식 파일을 `scripts/build-data.mjs`로 변환한 것입니다. MIT 라이선스이며, 전체 라이선스와 각 색상 구성의 제작자 정보는 `src/data/schemes-LICENSE.txt`에 있습니다.
