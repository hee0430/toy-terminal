/**
 * 터미널에 붙여넣을 글에서 제어 문자를 지운다 (탭, 줄바꿈은 남긴다).
 * xterm은 붙여넣는 글을 `ESC[200~ … ESC[201~`로 감싸기만 하고 거르지 않는다. 글 안에 `ESC[201~`가 있으면
 * 감싸기가 거기서 끝나고 그 뒤의 글이 "직접 친 것"처럼 실행된다(pastejacking). 화면에서는 ESC가 보이지 않으므로
 * 눈으로 확인할 수 없다. ESC를 포함한 C0/C1 제어 문자와 DEL을 모두 지우면 이 탈출이 불가능하다.
 */
export function sanitizePaste(text: string): string {
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}
