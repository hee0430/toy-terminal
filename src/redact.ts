/**
 * 터미널 출력을 AI 서버로 보내기 전에 비밀처럼 보이는 문자열을 가린다.
 * 완벽하지 않다 — 알려진 모양(개인키, 비밀번호·토큰 대입, Bearer, 주소 안의 계정 정보, AWS·sk- 키)만 가린다.
 * 가린 자리는 LLM이 알아볼 수 있게 영어 표시를 쓴다.
 */
export function redact(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(Bearer)[ \t]+[A-Za-z0-9._~+/=-]{10,}/gi, "$1 ***")
    // password=값, token: "값" 처럼 이름 뒤에 값이 오는 모양. 줄바꿈을 넘어 다음 줄까지 가리지 않도록 가로 공백만 허용한다.
    // DB_PASSWORD, MY_API_KEY, client_secret 처럼 앞뒤에 글자가 붙은 이름도 잡도록 이름 전체(\w*)를 본다.
    .replace(/\b(\w*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key)\w*)([ \t]*[:=][ \t]*)("[^"\n]*"|'[^'\n]*'|[^\s"']+)/gi, "$1$2***")
    .replace(/(:\/\/[^\s:@/]+):[^\s@/]+@/g, "$1:***@")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "***")
    .replace(/\bsk-[A-Za-z0-9_-]{20,}/g, "***");
}
