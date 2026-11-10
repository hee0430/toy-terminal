import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";
import type { ProfileIcon } from "./icons";
import { modal } from "./ui";

/** undefined: 닫음(변경 없음), icon: null: 기본값으로 되돌림 */
export type PickResult = { icon: ProfileIcon | null } | undefined;

type FaEntry = { cls: string; name: string; terms: string };
const CHUNK = 150;

/** 아이콘 선택 창. 기본 아이콘(Font Awesome)과 URL 내려받기 두 탭이 있다. */
export function pickIcon(): Promise<PickResult> {
  return new Promise((resolve) => {
    let result: PickResult;
    const dlg = modal((d) => {
      d.className = "iconpick";
      d.innerHTML = `<h3></h3>
        <div class="itabs"><button type="button" data-tab="fa"></button><button type="button" data-tab="url"></button></div>
        <div class="ipane"></div>
        <div class="row"><button type="button" class="reset"></button><button type="button" class="close"></button></div>`;
      d.querySelector("h3")!.textContent = t("icon.pickTitle");
      const tabs = d.querySelectorAll<HTMLElement>(".itabs button");
      tabs[0].textContent = t("icon.tabBuiltin");
      tabs[1].textContent = t("icon.tabUrl");
      d.querySelector(".reset")!.textContent = t("icon.reset");
      d.querySelector(".close")!.textContent = t("common.close");
      const pane = d.querySelector(".ipane") as HTMLElement;
      const choose = (icon: ProfileIcon | null) => {
        result = { icon };
        d.close();
      };

      const show = (tab: string) => {
        tabs.forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
        pane.replaceChildren();
        if (tab === "fa") buildBuiltin(pane, choose);
        else buildUrl(pane, choose);
      };
      tabs.forEach((b) => b.addEventListener("click", () => show(b.dataset.tab!)));
      d.querySelector(".reset")!.addEventListener("click", () => choose(null));
      d.querySelector(".close")!.addEventListener("click", () => d.close());
      show("fa");
    });
    dlg.addEventListener("close", () => resolve(result));
  });
}

function buildBuiltin(pane: HTMLElement, choose: (i: ProfileIcon) => void) {
  pane.innerHTML = `<input class="isearch" spellcheck="false" /><div class="igrid"></div><button type="button" class="more"></button>`;
  const search = pane.querySelector(".isearch") as HTMLInputElement;
  const grid = pane.querySelector(".igrid") as HTMLElement;
  const more = pane.querySelector(".more") as HTMLButtonElement;
  search.placeholder = t("icon.search");
  more.textContent = t("icon.more");

  let all: FaEntry[] = [];
  let shown: FaEntry[] = [];
  let count = 0;
  const renderMore = () => {
    for (const e of shown.slice(count, count + CHUNK)) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "icell";
      b.title = e.cls;
      b.innerHTML = `<i class="${e.cls}"></i>`;
      b.addEventListener("click", () => choose({ type: "fa", name: e.cls }));
      grid.appendChild(b);
    }
    count = Math.min(shown.length, count + CHUNK);
    more.hidden = count >= shown.length;
  };
  const filter = () => {
    const q = search.value.trim().toLowerCase();
    shown = q ? all.filter((e) => e.name.includes(q) || e.terms.includes(q)) : all;
    grid.replaceChildren();
    count = 0;
    renderMore();
  };
  search.addEventListener("input", filter);
  more.addEventListener("click", renderMore);

  more.hidden = true;
  import("./data/fa-icons.json").then((m) => {
    // [이름, "fas,far" 같은 스타일 접두사들, 검색어]
    all = (m.default as [string, string, string][]).flatMap(([name, styles, terms]) =>
      styles.split(",").map((s) => ({ cls: `${s} fa-${name}`, name, terms })),
    );
    filter();
  });
  search.focus();
}

function buildUrl(pane: HTMLElement, choose: (i: ProfileIcon) => void) {
  pane.innerHTML = `<label class="urlrow"><span></span><input class="iurl" placeholder="https://..." spellcheck="false" /></label>
    <p class="hint"></p><button type="button" class="idl"></button><p class="err"></p>`;
  (pane.querySelector("label span") as HTMLElement).textContent = t("icon.urlLabel");
  (pane.querySelector(".hint") as HTMLElement).textContent = t("icon.urlHint");
  const btn = pane.querySelector(".idl") as HTMLButtonElement;
  const err = pane.querySelector(".err") as HTMLElement;
  const input = pane.querySelector(".iurl") as HTMLInputElement;
  btn.textContent = t("icon.download");
  const go = async () => {
    if (!input.value.trim()) return;
    btn.disabled = true;
    err.textContent = t("icon.downloading");
    try {
      const file = await invoke<string>("icon_download", { url: input.value.trim() });
      choose({ type: "file", file });
    } catch (e) {
      err.textContent = t("icon.failed", { error: String(e) });
      btn.disabled = false;
    }
  };
  btn.addEventListener("click", go);
  input.addEventListener("keydown", (e) => e.key === "Enter" && go());
  input.focus();
}
