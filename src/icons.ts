import { invoke } from "@tauri-apps/api/core";

/** 세션에 지정한 아이콘. fa는 Font Awesome 클래스(예: "fas fa-desktop"), file은 icons 폴더의 파일 이름. */
export type ProfileIcon = { type: "fa"; name: string } | { type: "file"; file: string };

const FA_CLASS = /^(fas|far|fab) fa-[a-z0-9-]+$/;
const dataUrls = new Map<string, Promise<string>>();

function fileUrl(file: string): Promise<string> {
  let p = dataUrls.get(file);
  if (!p) {
    p = invoke<string>("icon_read", { file });
    dataUrls.set(file, p);
    p.catch(() => dataUrls.delete(file)); // 실패는 기억하지 않아 다시 시도할 수 있게 한다
  }
  return p;
}

/** 아이콘 요소. 아이콘이 없거나 읽지 못하면 fallback(이모지)을 보여 준다. 저장된 값은 믿지 않고 형식을 검사한다. */
export function iconNode(icon: ProfileIcon | undefined, fallback: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "ico";
  if (icon?.type === "fa" && FA_CLASS.test(icon.name)) {
    const i = document.createElement("i");
    i.className = icon.name;
    span.appendChild(i);
  } else if (icon?.type === "file") {
    span.textContent = fallback;
    fileUrl(icon.file)
      .then((url) => {
        const img = new Image();
        img.alt = "";
        img.className = "ico-img";
        img.src = url;
        span.replaceChildren(img);
      })
      .catch(() => {});
  } else {
    span.textContent = fallback;
  }
  return span;
}
