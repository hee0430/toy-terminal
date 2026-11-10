import { clampSize, fontStack } from "./fonts";
import { getSettings } from "./settings";

export type TermFont = { fontFamily: string; fontSize: number };

export const getTermFont = (): TermFont => ({ fontFamily: fontStack(getSettings().fontFamily), fontSize: clampSize(getSettings().fontSize) });

const listeners = new Set<(f: TermFont) => void>();
export const onTermFont = (fn: (f: TermFont) => void) => void listeners.add(fn);

const scrollbackListeners = new Set<(lines: number) => void>();
export const onScrollback = (fn: (lines: number) => void) => void scrollbackListeners.add(fn);
/** 설정의 스크롤백 줄 수를 열려 있는 모든 터미널에 적용한다. */
export const applyScrollback = () => scrollbackListeners.forEach((fn) => fn(getSettings().scrollback));

/** 앱에 포함된 글꼴은 처음 쓸 때 불러오므로, 터미널이 글자 칸 크기를 재기 전에 미리 불러온다 (안 그러면 칸이 어긋난다). */
export async function ensureFontLoaded(f: TermFont): Promise<void> {
  try {
    await Promise.all([document.fonts.load(`${f.fontSize}px ${f.fontFamily}`), document.fonts.load(`bold ${f.fontSize}px ${f.fontFamily}`)]);
  } catch {
    // 불러오지 못해도 다음 글꼴로 대신 표시되므로 계속 진행한다.
  }
}

/** 설정의 글꼴을 열려 있는 모든 터미널에 적용한다. */
export async function applyFont(): Promise<void> {
  const f = getTermFont();
  await ensureFontLoaded(f);
  listeners.forEach((fn) => fn(f));
}
