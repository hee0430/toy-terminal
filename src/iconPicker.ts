import { invoke } from "@tauri-apps/api/core";
import { t } from "./i18n";
import { iconNode, type ProfileIcon } from "./icons";
import { confirmBox, modal } from "./ui";

/**
 * undefined: 아무 일 없이 닫음.
 * icon: undefined면 선택 없음(삭제만 했을 수 있음), null이면 기본값으로 되돌림.
 * deleted: 창에서 지운 아이콘 파일 (호출한 쪽이 들고 있는 값이 이 파일이면 비워야 한다)
 */
export type PickResult = { icon?: ProfileIcon | null; deleted: string[] } | undefined;

/** 아이콘을 지울 때 세션 쪽 정리를 맡기는 함수들 (세션 트리는 profiles.ts가 가지고 있다) */
export type IconHooks = {
  usage: (file: string) => number;
  release: (file: string) => void;
};

type FaEntry = { cls: string; name: string; terms: string };
const CHUNK = 150;

/** 아이콘 선택 창. 기본 아이콘(Font Awesome), 받은 아이콘, URL 내려받기 세 탭이 있다. */
export function pickIcon(hooks: IconHooks): Promise<PickResult> {
  return new Promise((resolve) => {
    let picked: { icon: ProfileIcon | null } | undefined;
    const deleted: string[] = [];
    const dlg = modal((d) => {
      d.className = "iconpick";
      d.innerHTML = `<h3></h3>
        <div class="itabs"><button type="button" data-tab="fa"></button><button type="button" data-tab="saved"></button><button type="button" data-tab="url"></button></div>
        <div class="ipane"></div>
        <div class="row"><button type="button" class="reset"></button><button type="button" class="close"></button></div>`;
      d.querySelector("h3")!.textContent = t("icon.pickTitle");
      const tabs = d.querySelectorAll<HTMLElement>(".itabs button");
      tabs[0].textContent = t("icon.tabBuiltin");
      tabs[1].textContent = t("icon.tabSaved");
      tabs[2].textContent = t("icon.tabUrl");
      d.querySelector(".reset")!.textContent = t("icon.reset");
      d.querySelector(".close")!.textContent = t("common.close");
      const pane = d.querySelector(".ipane") as HTMLElement;
      const choose = (icon: ProfileIcon | null) => {
        picked = { icon };
        d.close();
      };

      const show = (tab: string) => {
        tabs.forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
        pane.replaceChildren();
        if (tab === "fa") buildBuiltin(pane, choose);
        else if (tab === "saved") buildSaved(pane, choose, hooks, deleted);
        else buildUrl(pane, choose);
      };
      tabs.forEach((b) => b.addEventListener("click", () => show(b.dataset.tab!)));
      d.querySelector(".reset")!.addEventListener("click", () => choose(null));
      d.querySelector(".close")!.addEventListener("click", () => d.close());
      show("fa");
    });
    dlg.addEventListener("close", () => resolve(picked || deleted.length ? { ...picked, deleted } : undefined));
  });
}

/** 이미 받아 둔 아이콘. 클릭하면 선택, ✕를 누르면 파일을 지운다. */
function buildSaved(pane: HTMLElement, choose: (i: ProfileIcon) => void, hooks: IconHooks, deleted: string[]) {
  pane.innerHTML = `<div class="igrid"></div><p class="hint empty" hidden></p><p class="err"></p>`;
  const grid = pane.querySelector(".igrid") as HTMLElement;
  const empty = pane.querySelector(".empty") as HTMLElement;
  const err = pane.querySelector(".err") as HTMLElement;
  empty.textContent = t("icon.savedEmpty");

  const remove = async (file: string, cell: HTMLElement) => {
    const n = hooks.usage(file);
    // 오클릭 방지로 항상 묻는다. 쓰는 세션이 있으면 그 세션의 아이콘이 기본값으로 바뀐다는 말도 함께.
    if (!(await confirmBox(n > 0 ? t("icon.deleteInUse", { count: n }) : t("icon.deleteConfirm")))) return;
    try {
      hooks.release(file); // 세션 정보를 먼저 정리한다. 파일을 먼저 지우고 실패하면 깨진 이미지가 남는다.
      await invoke("icon_delete", { file });
    } catch (e) {
      err.textContent = t("icon.failed", { error: String(e) });
      return;
    }
    deleted.push(file);
    cell.remove();
    empty.hidden = grid.children.length > 0;
  };

  invoke<string[]>("icon_list")
    .then((files) => {
      for (const file of files) {
        const cell = document.createElement("div");
        cell.className = "isaved";
        const pick = document.createElement("button");
        pick.type = "button";
        pick.className = "icell";
        pick.append(iconNode({ type: "file", file }, "…"));
        pick.addEventListener("click", () => choose({ type: "file", file }));
        const del = document.createElement("button");
        del.type = "button";
        del.className = "idel";
        del.textContent = "✕";
        del.title = t("icon.delete");
        del.addEventListener("click", () => remove(file, cell));
        cell.append(pick, del);
        grid.appendChild(cell);
      }
      empty.hidden = files.length > 0;
    })
    .catch((e) => (err.textContent = t("icon.failed", { error: String(e) })));
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
