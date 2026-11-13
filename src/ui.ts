// WebView2에서 window.prompt/confirm이 막힐 수 있어서 자체 모달을 쓴다.
import { t } from "./i18n";

function modal(build: (dlg: HTMLDialogElement) => void): HTMLDialogElement {
  const dlg = document.createElement("dialog");
  build(dlg);
  document.body.appendChild(dlg);
  dlg.addEventListener("close", () => dlg.remove());
  dlg.showModal();
  return dlg;
}

/** 한 줄 입력. 취소하면 null */
export function ask(title: string, label: string, opts: { password?: boolean; value?: string; /** 긴 설명이 입력칸 위에 오게 한다 */ stacked?: boolean; /** 입력칸 아래에 항목으로 나열할 안내 */ notes?: string[]; /** 입력칸 아래에 빨갛게 보일 오류 */ error?: string } = {}): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const dlg = modal((d) => {
      d.innerHTML = `<form method="dialog"><h3></h3><label><span class="lbl"></span><input /></label>
        <div class="row"><button type="button" class="cancel"></button><button type="submit" class="ok"></button></div></form>`;
      d.querySelector(".cancel")!.textContent = t("common.cancel");
      d.querySelector("button[type=submit]")!.textContent = t("common.confirm");
      d.querySelector("h3")!.textContent = title;
      d.querySelector(".lbl")!.textContent = label;
      d.querySelector("label")!.classList.toggle("col", !!opts.stacked);
      const row = d.querySelector(".row")!;
      if (opts.error) {
        const p = document.createElement("p");
        p.className = "err";
        p.textContent = opts.error;
        row.before(p);
      }
      if (opts.notes?.length) {
        const ul = document.createElement("ul");
        ul.className = "notes";
        for (const n of opts.notes) ul.append(Object.assign(document.createElement("li"), { textContent: n }));
        row.before(ul);
      }
      const input = d.querySelector("input")!;
      input.type = opts.password ? "password" : "text";
      input.value = opts.value ?? "";
      d.querySelector("form")!.addEventListener("submit", () => (result = input.value));
      d.querySelector(".cancel")!.addEventListener("click", () => d.close());
    });
    dlg.addEventListener("close", () => resolve(result));
    dlg.querySelector("input")!.focus();
  });
}

export function confirmBox(message: string, okLabel = t("common.delete")): Promise<boolean> {
  return new Promise((resolve) => {
    let ok = false;
    const dlg = modal((d) => {
      d.innerHTML = `<form method="dialog"><p class="msg"></p>
        <div class="row"><button type="button" class="cancel"></button><button type="submit" class="ok"></button></div></form>`;
      d.querySelector(".cancel")!.textContent = t("common.cancel");
      d.querySelector(".msg")!.textContent = message;
      d.querySelector(".ok")!.textContent = okLabel;
      // 삭제는 초록(확인)이 아니라 빨강으로 보여 되돌릴 수 없는 동작임을 드러낸다.
      if (okLabel === t("common.delete")) d.querySelector(".ok")!.classList.add("danger");
      d.querySelector("form")!.addEventListener("submit", () => (ok = true));
      d.querySelector(".cancel")!.addEventListener("click", () => d.close());
    });
    dlg.addEventListener("close", () => resolve(ok));
  });
}

/** 접속 중임을 알리고 다른 조작을 막는 모달. Esc로는 닫히지 않고, 취소 버튼을 누르면 onCancel을 부른다. 돌려준 함수로 닫는다. */
export function showConnecting(name: string, onCancel: () => void): () => void {
  const dlg = modal((d) => {
    d.classList.add("connectingdlg");
    d.innerHTML = `<form method="dialog"><div class="spinner"></div><p class="msg"></p>
      <div class="row"><button type="button" class="cancel"></button></div></form>`;
    d.querySelector(".msg")!.textContent = t("connect.progress", { name });
    d.querySelector(".cancel")!.textContent = t("common.cancel");
    d.addEventListener("cancel", (e) => e.preventDefault()); // Esc
    d.querySelector(".cancel")!.addEventListener("click", () => {
      d.close();
      onCancel();
    });
  });
  return () => dlg.open && dlg.close();
}

/** 여러 선택지 중 하나. 줄은 본문(한 줄씩), 닫거나 Esc면 첫 번째가 아니라 cancelValue를 돌려준다. */
export function choose(
  title: string,
  lines: string[],
  options: { label: string; value: string; cls?: string }[],
  cancelValue: string,
): Promise<string> {
  return new Promise((resolve) => {
    let result = cancelValue;
    const dlg = modal((d) => {
      d.innerHTML = `<form method="dialog"><h3></h3><div class="body"></div><div class="row"></div></form>`;
      d.querySelector("h3")!.textContent = title;
      const body = d.querySelector(".body")!;
      for (const l of lines) {
        const p = document.createElement("p");
        p.className = "msg";
        p.textContent = l;
        body.appendChild(p);
      }
      const row = d.querySelector(".row")!;
      for (const o of options) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = o.label;
        if (o.value === cancelValue) b.className = "cancel";
        else if (o.cls) b.className = o.cls;
        b.addEventListener("click", () => {
          result = o.value;
          d.close();
        });
        row.appendChild(b);
      }
    });
    dlg.addEventListener("close", () => resolve(result));
  });
}

/** 우클릭 메뉴. 바깥을 누르거나 Esc를 누르면 닫힌다. */
export function showMenu(x: number, y: number, items: { label: string; fn: () => void; /** 이 항목 위에 구분선 */ sep?: boolean }[]) {
  document.querySelector(".ctxmenu")?.remove();
  const m = document.createElement("div");
  m.className = "ctxmenu";
  const close = () => {
    m.remove();
    window.removeEventListener("pointerdown", onOutside, true);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("blur", close);
  };
  const onOutside = (e: Event) => {
    if (!m.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
  for (const it of items) {
    if (it.sep) {
      const hr = document.createElement("div");
      hr.className = "ctxsep";
      m.appendChild(hr);
    }
    const b = document.createElement("button");
    b.textContent = it.label;
    b.addEventListener("click", () => {
      close();
      it.fn();
    });
    m.appendChild(b);
  }
  document.body.appendChild(m);
  // 화면 밖으로 나가지 않게 조정
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.max(0, Math.min(x, window.innerWidth - r.width - 4))}px`;
  m.style.top = `${Math.max(0, Math.min(y, window.innerHeight - r.height - 4))}px`;
  window.addEventListener("pointerdown", onOutside, true);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("blur", close);
}

export { modal };

/** 개인키(PEM 등) 파일 선택. 취소하면 null */
export async function pickKeyFile(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [
      { name: t("key.filterPem"), extensions: ["pem", "key"] },
      { name: t("key.filterAll"), extensions: ["*"] },
    ],
  });
  return typeof picked === "string" ? picked : null;
}

/** 편집기 프로그램 파일 선택. 취소하면 null */
export async function pickExecutable(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [
      { name: t("settings.editor.filterExe"), extensions: ["exe", "cmd", "bat"] },
      { name: t("key.filterAll"), extensions: ["*"] },
    ],
  });
  return typeof picked === "string" ? picked : null;
}

/** 관리자 표시용 방패. 이모지가 아니라 SVG라서 글자색을 따라가고 폰트와 무관하게 보인다. */
export function shieldIcon(): HTMLElement {
  const s = document.createElement("span");
  s.className = "shield";
  s.title = t("tab.admin");
  s.innerHTML = `<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true"><path d="M8 1 2 3.4v4.3c0 3.2 2.3 5.9 6 7.3 3.7-1.4 6-4.1 6-7.3V3.4L8 1z"/></svg>`;
  return s;
}
