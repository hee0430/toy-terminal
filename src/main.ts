import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import "@fortawesome/fontawesome-free/css/all.min.css";
import "./fonts.css";
import "./style.css";
import { ask, choose, confirmBox, shieldIcon, showConnecting, showMenu } from "./ui";
import { initProfiles, rerenderProfiles, showStatus, type Profile } from "./profiles";
import { parseForward } from "./sshForward";
import { hasSecret, readSecret } from "./vault";
import { applyStatic, joinList, onLangChange, resolveLang, setLang, t } from "./i18n";
import { iconNode, type ProfileIcon } from "./icons";
import { getSettings, loadSettings, updateSettings } from "./settings";
import { clampSidebar, DEFAULT_SIDEBAR } from "./layout";
import { APP_NAME, APP_VERSION } from "./version";
import { applyAppearance, getTermTheme, onTermTheme } from "./theme";
import { openSettings } from "./settingsUi";
import { applyFont, ensureFontLoaded, getTermFont, onScrollback, onTermFont } from "./termFont";
import { clampSize } from "./fonts";
import { sanitizePaste } from "./paste";
import { closeChat, initAi, refreshAi } from "./ai";
import { createPendingOutput } from "./pendingOutput";

type Tab = {
  id: string;
  title: string;
  kind: "local" | "ssh";
  term: Terminal;
  fit: FitAddon;
  search: SearchAddon;
  el: HTMLElement;
  tabEl: HTMLElement;
  dead: boolean;
  sftpPath: string;
  /** 셸이 OSC 7로 알려 준 마지막 작업 디렉터리 */
  cwd: string;
  /** SFTP 패널이 터미널 위치를 따라가는가 */
  follow: boolean;
  /** 셸에 위치 알림 훅을 이미 넣었는가 (탭당 한 번만) */
  hooked: boolean;
  /** 전체 화면 프로그램이 끝나면 훅을 넣으려고 기다리는 중인가 */
  pendingHook: boolean;
  /** 마지막 Enter 이후 입력하던 글자가 있다고 추정되는가 (화살표 기록·자동완성은 추정일 뿐) */
  typed: boolean;
  /** AI 도우미에게 알려 줄 설명 (셸 종류, 접속 대상) */
  context: string;
  /** 이 탭을 연 프로필. 끊어진 세션을 다시 연결할 때 쓴다 */
  profile?: Profile;
};

type Entry = { name: string; is_dir: boolean; size: number; modified: number };
type Listing = { path: string; entries: Entry[] };

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const tabs = new Map<string, Tab>();
let active: Tab | null = null;

// ---------- 터미널 / 탭 ----------

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
/** 접속을 시작하고 탭이 등록되기 전에 온 출력(첫 프롬프트 등)을 잠시 모아 둔다. */
const pending = createPendingOutput();

/** 붙여넣기. 줄바꿈이 있으면 줄마다 명령이 실행될 수 있으므로 먼저 물어본다. */
async function pasteText(term: Terminal, raw: string) {
  const text = sanitizePaste(raw); // 우클릭·Ctrl+V·AI 명령 입력 모두 여기를 거친다
  if (!text) return;
  if (/[\r\n]/.test(text)) {
    const lines = text.replace(/(\r\n|\r|\n)+$/, "").split(/\r\n|\r|\n/).length;
    if (!(await confirmBox(t("terminal.pasteMultiline", { count: lines }), t("terminal.paste")))) {
      term.focus();
      return;
    }
  }
  term.paste(text);
  term.clearSelection(); // 붙여넣은 뒤에는 블록 선택을 풀어 둔다
  // 마우스 버튼을 떼는 이벤트가 선택을 다시 만들 수 있어 한 프레임 뒤에 한 번 더 푼다.
  requestAnimationFrame(() => term.clearSelection());
  term.focus();
}

/** 드래그로 선택하면 복사, 우클릭은 붙여넣기. Ctrl+V 붙여넣기도 같은 확인을 거친다. */
function setupClipboard(term: Terminal, el: HTMLElement) {
  let timer: number | undefined;
  term.onSelectionChange(() => {
    // 드래그 중에는 계속 바뀌므로 멈춘 뒤에 한 번만 복사한다.
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (term.hasSelection()) writeText(term.getSelection()).catch(() => {});
    }, 200);
  });
  el.addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    // 블록이 선택돼 있어도 우클릭 한 번에 바로 붙여넣는다. 복사가 아직 안 됐을 수 있으니(위 지연) 먼저 복사해 두고,
    // 선택은 붙여넣기를 기다리는 동안에도 남지 않게 바로 푼다.
    if (term.hasSelection()) {
      const selected = term.getSelection();
      term.clearSelection();
      await writeText(selected).catch(() => {});
    }
    pasteText(term, await readText().catch(() => ""));
  });
  // xterm이 직접 처리하기 전에 가로채서 확인을 거친다.
  el.addEventListener(
    "paste",
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      pasteText(term, e.clipboardData?.getData("text/plain") ?? "");
    },
    true,
  );
}

/** Ctrl+마우스 휠로 글꼴 크기를 바꾼다. 설정의 글자 크기와 같은 값이라 모든 터미널에 적용되고 저장된다. */
function setupZoom(el: HTMLElement) {
  el.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      const cur = getSettings().fontSize;
      const next = clampSize(cur + (e.deltaY < 0 ? 1 : -1));
      if (next === cur) return;
      updateSettings({ fontSize: next });
      applyFont();
    },
    { passive: false, capture: true },
  );
}

async function createTab(
  title: string,
  kind: Tab["kind"],
  start: (cols: number, rows: number) => Promise<string>,
  admin = false,
  icon?: ProfileIcon,
  context = "",
  profile?: Profile,
): Promise<Tab> {
  // 백엔드가 id를 돌려주기 전에 크기를 알아야 하므로, 먼저 DOM에 붙여서 fit 한다.
  const el = document.createElement("div");
  el.className = "term";
  $("#terms").appendChild(el);

  const term = new Terminal({
    ...getTermFont(),
    cursorBlink: true,
    rightClickSelectsWord: false, // 우클릭이 선택을 바꾸지 않게 한다 (우클릭은 붙여넣기)
    theme: getTermTheme(),
    scrollback: getSettings().scrollback,
    allowProposedApi: true, // 검색 결과 강조(decorations)가 필요로 한다
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const search = new SearchAddon();
  term.loadAddon(search);
  // Ctrl+F는 셸로 보내지 않고 검색줄을 연다.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === "keydown" && e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      openSearch();
      return false;
    }
    return true;
  });
  term.open(el);
  setupClipboard(term, el);
  setupZoom(el);
  el.classList.add("active");
  fit.fit();

  let id: string;
  pending.begin();
  try {
    id = await start(term.cols, term.rows);
  } catch (e) {
    pending.end();
    el.remove();
    term.dispose();
    throw e;
  }

  const tabEl = document.createElement("div");
  tabEl.className = "tab";
  tabEl.innerHTML = `<span class="label"></span><span class="x">✕</span>`;
  const label = tabEl.querySelector(".label") as HTMLElement;
  // 탭 폭은 고정이라 긴 이름은 잘리므로, 이름은 따로 두어 말줄임하고 방패는 항상 보이게 한다.
  const nameEl = document.createElement("span");
  nameEl.className = "tname";
  nameEl.textContent = title;
  label.append(nameEl);
  if (admin) label.append(shieldIcon());
  tabEl.title = title;
  if (icon) tabEl.insertBefore(iconNode(icon, ""), label);
  tabEl.addEventListener("click", () => !tabJustDragged && activate(tab)); // 끌어서 놓은 직후의 클릭은 탭 선택으로 보지 않는다
  tabEl.addEventListener("contextmenu", (e) => tabMenu(e, tab));
  tabEl.addEventListener("pointerdown", (e) => startTabDrag(e, tab));
  tabEl.querySelector(".x")!.addEventListener("click", (ev) => {
    ev.stopPropagation();
    requestClose(tab);
  });
  $("#tabs").appendChild(tabEl);

  const tab: Tab = { id, title, kind, term, fit, search, el, tabEl, dead: false, sftpPath: "", cwd: "", follow: false, hooked: false, pendingHook: false, typed: false, context, profile };
  tabs.set(id, tab);
  // 분할 화면에서 칸을 누르면 그 세션이 현재 세션이 된다.
  el.addEventListener("mousedown", () => active !== tab && activate(tab));

  // 셸이 프롬프트마다 보내는 현재 위치(OSC 7: file://host/path)
  term.parser.registerOscHandler(7, (data) => {
    const p = parseOsc7(data);
    if (p) onShellCwd(tab, p);
    return true;
  });

  // vim 같은 전체 화면 프로그램이 끝나 일반 화면으로 돌아오면, 기다리던 위치 훅을 넣는다.
  term.buffer.onBufferChange((b) => {
    if (b.type === "normal" && tab.pendingHook) {
      tab.pendingHook = false;
      injectHook(tab);
    }
  });

  term.onData((d) => {
    trackTyping(tab, d);
    // 동시 입력이 켜져 있으면 같은 묶음의 살아 있는 모든 세션에 보낸다.
    const targets = broadcast && group.includes(tab) ? group.filter((x) => !x.dead || x === tab) : [tab];
    for (const x of targets) invoke("term_write", { id: x.id, data: d }).catch(() => {});
  });
  term.onResize(({ cols, rows }) => invoke("term_resize", { id, cols, rows }).catch(() => {}));
  // 탭이 등록되기 전에 도착해 모아 둔 출력을 먼저 쓴다.
  const early = pending.take(id);
  pending.end();
  early?.chunks.forEach((c) => writeOutput(tab, c));
  if (early?.closed) markClosed(tab);
  activate(tab);
  return tab;
}

// ---------- 터미널 내 검색 ----------

const searchBar = $("#termsearch");
const searchInput = $<HTMLInputElement>("#ts-input");
const searchCase = $("#ts-case");
const SEARCH_DECO = { matchBackground: "#5a4a00", matchOverviewRuler: "#c9a400", activeMatchBackground: "#c9a400", activeMatchColorOverviewRuler: "#ffd84d" };

function findInTerm(forward: boolean) {
  if (!active) return;
  const opts = { caseSensitive: searchCase.classList.contains("on"), decorations: SEARCH_DECO };
  if (!searchInput.value) {
    active.search.clearDecorations();
    return;
  }
  if (forward) active.search.findNext(searchInput.value, opts);
  else active.search.findPrevious(searchInput.value, opts);
}

function openSearch() {
  searchBar.hidden = false;
  searchInput.focus();
  searchInput.select();
}

function closeSearch() {
  searchBar.hidden = true;
  active?.search.clearDecorations();
  active?.term.focus();
}

searchInput.addEventListener("input", () => findInTerm(true));
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    findInTerm(!e.shiftKey);
  } else if (e.key === "Escape") closeSearch();
});
$("#ts-next").addEventListener("click", () => findInTerm(true));
$("#ts-prev").addEventListener("click", () => findInTerm(false));
$("#ts-close").addEventListener("click", closeSearch);
searchCase.addEventListener("click", () => {
  searchCase.classList.toggle("on");
  findInTerm(true);
});

// ---------- 분할 화면 ----------
// 열린 탭 중 2~4개를 한 화면에 격자로 묶는다. 묶음은 하나뿐이고, 묶음에 없는 탭을 고르면 그 탭만 보인다 (묶음은 기억한다).

const MAX_SPLIT = 4;
let group: Tab[] = [];
let splitRows = false; // 2~3개일 때 위아래로 쌓을지 (기본은 좌우)
/** 켜면 보고 있는 묶음의 한 칸에 친 입력이 묶음 전체로 간다. 묶음이 없어지면 꺼진다. */
let broadcast = false;

/** 첫 열의 너비, 첫 행의 높이가 차지하는 비율. 칸 사이 경계를 끌어서 바꾼다. */
let colRatio = 0.5;
let rowRatio = 0.5;
const MIN_RATIO = 0.15;
const clampRatio = (r: number) => Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, r));
const resetRatios = () => ((colRatio = 0.5), (rowRatio = 0.5));

const visibleTabs = (): Tab[] => (active && group.includes(active) ? group : active ? [active] : []);
const fitVisible = () => visibleTabs().forEach((tb) => tb.fit.fit());
let fitQueued = false;
/** 끄는 동안 이벤트마다 맞추지 않고 프레임당 한 번만 맞춘다 */
const queueFit = () => {
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => {
    fitQueued = false;
    fitVisible();
  });
};

// 칸 사이 경계(끌어서 크기 조절). 세로선은 열 사이, 가로선은 행 사이.
const gutterV = document.createElement("div");
gutterV.className = "gutter gv";
const gutterH = document.createElement("div");
gutterH.className = "gutter gh";
$("#terms").append(gutterV, gutterH);

function dragGutter(g: HTMLElement, axis: "x" | "y") {
  g.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    g.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const r = $("#terms").getBoundingClientRect();
      if (axis === "x") colRatio = clampRatio((ev.clientX - r.left) / r.width);
      else rowRatio = clampRatio((ev.clientY - r.top) / r.height);
      applyLayout();
    };
    const up = () => {
      g.removeEventListener("pointermove", move);
      g.removeEventListener("pointerup", up);
      g.removeEventListener("pointercancel", up);
    };
    g.addEventListener("pointermove", move);
    g.addEventListener("pointerup", up);
    g.addEventListener("pointercancel", up);
  });
  g.addEventListener("dblclick", () => {
    if (axis === "x") colRatio = 0.5;
    else rowRatio = 0.5;
    applyLayout();
  });
}
dragGutter(gutterV, "x");
dragGutter(gutterH, "y");

/** 보이는 탭 수와 방향에 따른 격자. cells는 칸별 [grid-column, grid-row] 값 */
function gridFor(n: number, rows: boolean): { cols: number; rows: number; cells: [string, string][] } {
  if (n === 2) return rows ? { cols: 1, rows: 2, cells: [["1", "1"], ["1", "2"]] } : { cols: 2, rows: 1, cells: [["1", "1"], ["2", "1"]] };
  if (n === 3) return rows ? { cols: 2, rows: 2, cells: [["1", "1 / -1"], ["2", "1"], ["2", "2"]] } : { cols: 2, rows: 2, cells: [["1", "1"], ["2", "1"], ["1 / -1", "2"]] };
  return { cols: 2, rows: 2, cells: [["1", "1"], ["2", "1"], ["1", "2"], ["2", "2"]] };
}

function applyLayout() {
  const vis = visibleTabs();
  const split = vis.length > 1;
  const terms = $("#terms");
  terms.classList.toggle("split", split);
  const g = split ? gridFor(vis.length, splitRows) : null;
  terms.style.gridTemplateColumns = g ? (g.cols === 2 ? `minmax(0, ${colRatio}fr) minmax(0, ${1 - colRatio}fr)` : "minmax(0, 1fr)") : "";
  terms.style.gridTemplateRows = g ? (g.rows === 2 ? `minmax(0, ${rowRatio}fr) minmax(0, ${1 - rowRatio}fr)` : "minmax(0, 1fr)") : "";
  updateGutters(g, vis.length);
  for (const tb of tabs.values()) {
    const i = vis.indexOf(tb);
    tb.el.classList.toggle("active", i >= 0);
    tb.el.classList.toggle("focus", split && tb === active);
    tb.el.style.gridColumn = g && i >= 0 ? g.cells[i][0] : "";
    tb.el.style.gridRow = g && i >= 0 ? g.cells[i][1] : "";
    tb.tabEl.classList.toggle("grouped", group.includes(tb));
    const bc = broadcast && group.includes(tb);
    tb.el.classList.toggle("bcast", bc && split);
    tb.tabEl.classList.toggle("bcast", bc);
  }
  queueFit(); // 칸 크기가 바뀌었으므로 다시 맞춘다
}

/** 경계 막대를 칸 사이 틈(2px) 위에 놓는다. 3개일 때는 경계가 한 줄 전체가 아니라 한쪽 칸 사이에만 있다. */
function updateGutters(g: ReturnType<typeof gridFor> | null, n: number) {
  const showV = !!g && g.cols === 2;
  const showH = !!g && g.rows === 2;
  gutterV.hidden = !showV;
  gutterH.hidden = !showH;
  if (showV) {
    gutterV.style.left = `calc((100% - 2px) * ${colRatio})`;
    gutterV.style.height = n === 3 && !splitRows ? `calc((100% - 2px) * ${rowRatio})` : "100%"; // 3개 좌우 배열: 아래 칸은 가로로 이어져 있다
  }
  if (showH) {
    gutterH.style.top = `calc((100% - 2px) * ${rowRatio})`;
    gutterH.style.left = n === 3 && splitRows ? `calc((100% - 2px) * ${colRatio} + 2px)` : "0"; // 3개 위아래 배열: 왼쪽 칸은 세로로 이어져 있다
  }
}

function leaveSplit(tab: Tab) {
  group = group.filter((x) => x !== tab);
  if (group.length < 2) {
    group = [];
    broadcast = false;
    resetRatios();
  }
}

function tabMenu(e: MouseEvent, tab: Tab) {
  e.preventDefault();
  const items: { label: string; fn: () => void; sep?: boolean }[] = [{ label: t("tab.rename"), fn: () => renameTab(tab) }];
  if (tab.dead && tab.profile) items.push({ label: t("tab.reconnect"), fn: () => reconnect(tab) });
  const groupStart = items.length;
  const inGroup = group.includes(tab);
  if (!inGroup && active && active !== tab && (!group.length || (group.includes(active) && group.length < MAX_SPLIT))) {
    items.push({
      label: t("tab.splitAdd"),
      fn: () => {
        if (!group.length) resetRatios();
        group = group.length ? [...group, tab] : [active!, tab];
        applyLayout();
      },
    });
  }
  if (inGroup) {
    items.push({ label: t("tab.splitRemove"), fn: () => (leaveSplit(tab), applyLayout()) });
    items.push({ label: t("tab.splitClear"), fn: () => ((group = []), (broadcast = false), resetRatios(), applyLayout()) });
    items.push({ label: broadcast ? t("tab.broadcastOff") : t("tab.broadcastOn"), fn: () => ((broadcast = !broadcast), applyLayout()) });
    if (group.length < MAX_SPLIT) items.push({ label: t("tab.splitFlip"), fn: () => ((splitRows = !splitRows), applyLayout()) });
  }
  if (items.length > groupStart) items[groupStart].sep = true; // 분할 항목은 구분선 아래에
  items.push({ label: t("tab.closeAll"), fn: closeAllTabs, sep: true }); // 되돌릴 수 없는 동작이라 따로 구분한다
  showMenu(e.clientX, e.clientY, items);
}

async function renameTab(tab: Tab) {
  const name = (await ask(t("tab.renameTitle"), t("tab.renameLabel"), { value: tab.title }))?.trim();
  if (!name) return;
  tab.title = name;
  tab.tabEl.querySelector(".tname")!.textContent = name;
  tab.tabEl.title = name;
}

/** 끊어진 세션을 같은 프로필로 다시 연다. 끝난 탭은 확인 없이 닫는다. 저장된 비밀번호가 있으면 그대로 쓰인다. */
async function reconnect(tab: Tab) {
  const p = tab.profile;
  if (!p) return;
  await closeTab(tab);
  await connectProfile(p);
}

// ---------- 탭 순서 바꾸기 (끌어서 옮기기) ----------
// 파일 드롭 처리를 켜 두면 HTML5 드래그앤드롭이 동작하지 않아서, 세션 트리처럼 포인터 이벤트로 직접 구현한다.
// 끌기 시작하면 탭이 떠올라 포인터를 따라다니고, 다른 탭의 중심을 넘으면 그 탭이 자리를 비켜 준다 (미끄러지는 애니메이션).
// 놓으면 떠 있던 탭이 제 자리로 내려앉는다.

type TabDrag = { tab: Tab; x: number; grab: number; tx: number; active: boolean; origNext: ChildNode | null };
let tabDrag: TabDrag | null = null;
let tabJustDragged = false;

/** DOM 순서를 바꾸는 동작(mutate)을 하면서, 탭들(except 제외)이 옛 자리에서 새 자리로 부드럽게 이동하게 한다. */
function animateTabs(mutate: () => void, except?: HTMLElement) {
  const els = Array.from(document.querySelectorAll<HTMLElement>("#tabs .tab")).filter((e) => e !== except);
  const before = new Map(els.map((e) => [e, e.getBoundingClientRect().left]));
  mutate();
  for (const e of els) {
    const dx = before.get(e)! - e.getBoundingClientRect().left;
    if (!dx) continue;
    e.style.transition = "none";
    e.style.transform = `translateX(${dx}px)`;
    void e.offsetWidth; // 옛 자리에서 시작하도록 먼저 적용시킨다
    e.style.transition = "transform 150ms ease";
    e.style.transform = "";
    e.addEventListener("transitionend", () => (e.style.transition = ""), { once: true });
  }
}

function startTabDrag(e: PointerEvent, tab: Tab) {
  if (e.button !== 0 || (e.target as HTMLElement).closest(".x")) return;
  tabDrag = { tab, x: e.clientX, grab: e.clientX - tab.tabEl.getBoundingClientRect().left, tx: 0, active: false, origNext: tab.tabEl.nextSibling };
}

/** 끌고 있는 탭이 포인터에 붙어 있도록, 지금 자리(slot)와 포인터 위치의 차이만큼 옮긴다. */
function followPointer(d: TabDrag, clientX: number) {
  const me = d.tab.tabEl;
  const slot = me.getBoundingClientRect().left - d.tx;
  d.tx = clientX - d.grab - slot;
  me.style.transform = `translateX(${d.tx}px) scale(1.04)`;
}

/** 끌기를 끝낸다. cancel이면 끌기 전 순서로 되돌린다. 떠 있던 탭은 눈에 보이던 위치에서 자리로 내려앉는다. */
function finishTabDrag(cancel: boolean) {
  const d = tabDrag;
  tabDrag = null;
  document.body.classList.remove("dragging-tab");
  if (!d?.active) return;
  const me = d.tab.tabEl;
  const visual = me.getBoundingClientRect().left;
  if (cancel) animateTabs(() => me.parentElement?.insertBefore(me, d.origNext), me);
  const tx = visual - (me.getBoundingClientRect().left - d.tx); // 자리가 바뀌었어도 눈에 보이는 위치는 그대로
  me.style.transition = "none";
  me.style.transform = `translateX(${tx}px) scale(1.04)`;
  void me.offsetWidth;
  me.style.transition = "transform 170ms ease";
  me.style.transform = "";
  const done = () => {
    me.style.transition = "";
    me.classList.remove("dragging");
  };
  me.addEventListener("transitionend", done, { once: true });
  setTimeout(done, 260); // transitionend가 오지 않아도 정리한다
}

window.addEventListener("pointermove", (e) => {
  const d = tabDrag;
  if (!d) return;
  const me = d.tab.tabEl;
  if (!d.active) {
    if (Math.abs(e.clientX - d.x) < 6) return; // 클릭과 구분하려고 조금 움직인 뒤에 끌기로 본다
    d.active = true;
    me.classList.add("dragging"); // 탭이 떠오른다 (그림자, 살짝 커짐)
    document.body.classList.add("dragging-tab");
  }
  me.style.transition = "none"; // 포인터를 바로 따라간다
  followPointer(d, e.clientX);
  // 끌고 있는 탭의 중심이 다른 탭의 중심을 넘으면 자리를 바꾼다. 자리 판단은 애니메이션 중 위치가 아니라 배치상의 위치로 한다.
  const els = Array.from(me.parentElement!.querySelectorAll<HTMLElement>(":scope > .tab"));
  const others = els.filter((x) => x !== me);
  const center = me.offsetLeft + d.tx + me.offsetWidth / 2;
  const idx = others.filter((x) => x.offsetLeft + x.offsetWidth / 2 < center).length;
  if (els.indexOf(me) === idx) return;
  animateTabs(() => me.parentElement!.insertBefore(me, others[idx] ?? null), me);
  followPointer(d, e.clientX); // 자리가 바뀌었으니 포인터 위치에 다시 맞춘다
});
window.addEventListener("pointerup", () => {
  const active = tabDrag?.active;
  finishTabDrag(false);
  if (!active) return;
  tabJustDragged = true; // 이어서 오는 click이 탭 선택으로 처리되지 않게 한다
  setTimeout(() => (tabJustDragged = false), 0);
});
window.addEventListener("keydown", (e) => e.key === "Escape" && finishTabDrag(true));
window.addEventListener("blur", () => finishTabDrag(true));

function activate(tab: Tab) {
  if (active && active !== tab && !searchBar.hidden) {
    active.search.clearDecorations();
    searchBar.hidden = true; // 검색줄은 탭마다 따로 두지 않고 탭을 옮기면 닫는다
  }
  active = tab;
  for (const other of tabs.values()) other.tabEl.classList.toggle("active", other === tab);
  applyLayout();
  tab.tabEl.classList.remove("unread");
  tab.tabEl.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" }); // 탭이 많아 가려져 있어도 선택한 탭은 보이게
  requestAnimationFrame(() => {
    tab.fit.fit();
    tab.term.focus();
  });
  sftpTab.hidden = tab.kind !== "ssh"; // SFTP 탭은 SSH 탭에서만 보인다
  if (tab.kind === "ssh") {
    followBox.checked = tab.follow;
    // 다른 탭의 경로가 아니라 이 탭이 보던 경로(또는 터미널 위치)로 연다.
    if (!sftpEl.hidden) refreshSftp(tab.follow && tab.cwd ? tab.cwd : tab.sftpPath);
  } else if (!sftpEl.hidden) {
    showPane("sessions"); // SFTP를 보고 있었다면 세션으로. 세션·AI를 보는 중이면 그대로 둔다.
  }
  refreshAi(); // AI 탭은 열린 세션이 있을 때만 보인다
}

/** ✕ 버튼: 실행 중인 세션은 종료되므로 먼저 확인한다. 이미 끝난 세션은 바로 닫는다. */
async function requestClose(tab: Tab) {
  if (!tab.dead && !(await confirmBox(t("tab.closeConfirm", { name: tab.title }), t("common.close")))) {
    tab.term.focus();
    return;
  }
  closeTab(tab);
}

/** 모든 탭을 닫는다. 실행 중인 세션이 있으면 개수를 알리고 한 번만 확인한다. */
async function closeAllTabs() {
  const all = [...tabs.values()];
  const live = all.filter((x) => !x.dead).length;
  if (live && !(await confirmBox(t("tab.closeAllConfirm", { count: live }), t("common.close")))) {
    active?.term.focus();
    return;
  }
  for (const x of all) await closeTab(x);
}

async function closeTab(tab: Tab) {
  await invoke("term_close", { id: tab.id }).catch(() => {});
  tab.term.dispose();
  tab.el.remove();
  tab.tabEl.remove();
  tabs.delete(tab.id);
  leaveSplit(tab);
  closeChat(tab.id); // 이 세션의 AI 대화도 함께 정리한다
  if (active === tab) {
    active = null;
    const next = [...tabs.values()].pop();
    if (next) activate(next);
    else {
      sftpTab.hidden = true;
      if (!sftpEl.hidden) showPane("sessions");
      refreshAi();
      applyLayout();
    }
  } else applyLayout(); // 보고 있던 묶음에서 한 칸이 빠졌을 수 있다
}

function writeOutput(tab: Tab, bytes: Uint8Array) {
  tab.term.write(bytes);
  if (!visibleTabs().includes(tab)) tab.tabEl.classList.add("unread"); // 화면에 보이지 않는 탭의 새 출력
}
function markClosed(tab: Tab) {
  tab.dead = true;
  tab.tabEl.classList.add("dead");
  if (!visibleTabs().includes(tab)) tab.tabEl.classList.add("unread");
  tab.term.write(`\r\n\x1b[90m${t("tab.ended")}\x1b[0m\r\n`);
}
listen<{ id: string; data: string }>("term-output", (e) => {
  const bytes = b64ToBytes(e.payload.data);
  const tab = tabs.get(e.payload.id);
  if (tab) writeOutput(tab, bytes);
  else pending.add(e.payload.id, bytes);
});
listen<string>("term-closed", (e) => {
  const tab = tabs.get(e.payload);
  if (tab) markClosed(tab);
  else pending.close(e.payload);
});

// 탭이 창보다 많으면 스크롤 막대 대신 양끝의 ‹ › 버튼(한 번에 탭 하나)이나 마우스 휠로 좌우로 넘긴다.
const tabsEl = $("#tabs");
const navPrev = $<HTMLButtonElement>("#tabs-prev");
const navNext = $<HTMLButtonElement>("#tabs-next");
function updateTabNav() {
  const overflow = tabsEl.scrollWidth > tabsEl.clientWidth + 1;
  navPrev.hidden = navNext.hidden = !overflow;
  navPrev.disabled = tabsEl.scrollLeft <= 0;
  navNext.disabled = tabsEl.scrollLeft + tabsEl.clientWidth >= tabsEl.scrollWidth - 1;
}
const scrollTabs = (dir: number) => tabsEl.scrollBy({ left: dir * (tabsEl.querySelector<HTMLElement>(".tab")?.offsetWidth ?? 190), behavior: "smooth" });
navPrev.addEventListener("click", () => scrollTabs(-1));
navNext.addEventListener("click", () => scrollTabs(1));
tabsEl.addEventListener("scroll", updateTabNav);
new ResizeObserver(updateTabNav).observe(tabsEl);
new MutationObserver(updateTabNav).observe(tabsEl, { childList: true }); // 탭이 생기거나 없어질 때
tabsEl.addEventListener(
  "wheel",
  (e) => {
    if (!e.deltaY) return;
    e.preventDefault();
    tabsEl.scrollLeft += e.deltaY;
  },
  { passive: false },
);

window.addEventListener("resize", fitVisible);
new ResizeObserver(fitVisible).observe($("#terms"));

// 관리자 실행은 UAC 승인을 거치는 별도 명령을 쓴다.
function openLocalTab(title: string, shell: string, admin: boolean, icon?: ProfileIcon, profile?: Profile) {
  const cmd = admin ? "open_local_admin" : "open_local";
  const shellName = shell === "pwsh" ? "PowerShell 7" : shell === "powershell" ? "Windows PowerShell 5.1" : "cmd.exe";
  const context = shell === "shell" ? "Local shell: Terminal" : `Windows local shell: ${shellName}`;
  return createTab(title, "local", (cols, rows) => invoke<string>(cmd, { shell, cols, rows }), admin, icon, context, profile);
}

// 색상 구성이 바뀌면 열려 있는 모든 터미널에 바로 적용한다.
onTermTheme((theme) => tabs.forEach((tab) => (tab.term.options.theme = theme)));

// 글꼴이 바뀌면 열려 있는 터미널에 적용하고 칸 수를 다시 맞춘다 (보이지 않는 탭은 보일 때 맞춘다).
onTermFont((f) =>
  tabs.forEach((tab) => {
    tab.term.options.fontFamily = f.fontFamily;
    tab.term.options.fontSize = f.fontSize;
    if (visibleTabs().includes(tab)) tab.fit.fit();
  }),
);

// 스크롤백 줄 수가 바뀌면 열려 있는 터미널에 적용한다.
onScrollback((lines) => tabs.forEach((tab) => (tab.term.options.scrollback = lines)));

// 설정 버튼
$("#settings-btn").addEventListener("click", () => openSettings());

// 세로 탭 맨 아래 버전 표시
$("#appver").textContent = `v${APP_VERSION}`;
$("#appver").title = `${APP_NAME} v${APP_VERSION}`;

// ---------- 사이드바 폭 조절 (경계를 끌면 바뀌고, 더블클릭하면 기본 폭) ----------

const applySidebarWidth = (w: number) => document.documentElement.style.setProperty("--side-w", `${w}px`);

$("#splitter").addEventListener("pointerdown", (down) => {
  const splitter = down.currentTarget as HTMLElement;
  down.preventDefault();
  splitter.setPointerCapture(down.pointerId);
  document.body.classList.add("resizing");
  // 패널 폭 = 마우스 x - 사이드바 왼쪽 - 세로 탭 폭(경계선 1px 포함)
  const origin = $("#sidebar").getBoundingClientRect().left + $("#sidetabs").offsetWidth + 1;
  let width = getSettings().sidebarWidth;
  const move = (e: PointerEvent) => {
    width = clampSidebar(e.clientX - origin, window.innerWidth);
    applySidebarWidth(width);
  };
  const up = () => {
    splitter.removeEventListener("pointermove", move);
    splitter.removeEventListener("pointerup", up);
    splitter.removeEventListener("pointercancel", up);
    document.body.classList.remove("resizing");
    updateSettings({ sidebarWidth: width });
  };
  splitter.addEventListener("pointermove", move);
  splitter.addEventListener("pointerup", up);
  splitter.addEventListener("pointercancel", up);
});
$("#splitter").addEventListener("dblclick", () => {
  applySidebarWidth(DEFAULT_SIDEBAR);
  updateSettings({ sidebarWidth: DEFAULT_SIDEBAR });
});

// ---------- 창 버튼 (기본 제목줄 대신 탭 줄 오른쪽에 직접 그린다) ----------

// Tauri 밖(브라우저에서 화면만 볼 때)에서는 창 객체가 없으므로 버튼을 아무 일도 안 하게 둔다.
const appWindow = (() => {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
})();
const maxBtn = $("#win-max");

function syncMaximized() {
  appWindow?.isMaximized().then((m) => {
    $("#winctl").classList.toggle("maximized", m);
    maxBtn.title = t(m ? "window.restore" : "window.maximize");
  });
}
$("#win-min").addEventListener("click", () => appWindow?.minimize());
maxBtn.addEventListener("click", () => appWindow?.toggleMaximize());
$("#win-close").addEventListener("click", () => appWindow?.close());
appWindow?.onResized(syncMaximized);
syncMaximized();


// ---------- SFTP 패널 ----------

const sftpEl = $("#sftp");
const sftpList = $("#sftp-list");
const sftpPath = $<HTMLInputElement>("#sftp-path");
const sftpMsg = $("#sftp-msg");

// 사이드바 세로 탭: 세션(프로필 트리) / SFTP / AI. SFTP 탭은 SSH 탭이 활성일 때만 보인다(activate()가 처리).
const sftpTab = $<HTMLButtonElement>('.stab[data-pane="sftp"]');
const sessionsEl = $("#profiles");

type Pane = "sessions" | "sftp" | "ai";
function showPane(pane: Pane) {
  if (pane === "sftp" && (!active || active.kind !== "ssh")) pane = "sessions";
  sessionsEl.hidden = pane !== "sessions";
  sftpEl.hidden = pane !== "sftp";
  $("#ai").hidden = pane !== "ai";
  document.querySelectorAll<HTMLElement>(".stab").forEach((b) => b.classList.toggle("active", b.dataset.pane === pane));
  if (pane === "sftp" && active) refreshSftp(active.follow && active.cwd ? active.cwd : active.sftpPath || "");
}
// 세로 탭을 누르면 그 패널을 보여 준다. 이미 보고 있는 탭을 다시 누르면 패널을 접고, 접힌 상태에서 누르면 펼친다.
document.querySelectorAll<HTMLElement>(".stab").forEach((b) =>
  b.addEventListener("click", () => {
    const collapsed = document.body.classList.contains("side-collapsed");
    if (!collapsed && b.classList.contains("active")) document.body.classList.add("side-collapsed");
    else {
      document.body.classList.remove("side-collapsed");
      showPane(b.dataset.pane as Pane);
    }
  }),
);

// ---- 터미널 위치 따라가기 ----

const followBox = $<HTMLInputElement>("#sftp-follow");

function parseOsc7(data: string): string | null {
  const m = /^file:\/\/[^/]*(\/.*)$/.exec(data);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1]; // 인코딩되지 않은 '%'가 들어 있으면 원문 그대로
  }
}

function onShellCwd(tab: Tab, path: string) {
  if (path === tab.cwd) return; // 프롬프트마다 오므로 바뀔 때만 처리
  tab.cwd = path;
  if (tab.follow && active === tab && !sftpEl.hidden) refreshSftp(path);
}

// bash(PROMPT_COMMAND)와 zsh(precmd)에서 프롬프트마다 OSC 7을 내보내게 하는 한 줄.
// 앞의 공백은 bash 기록(HISTCONTROL=ignorespace)에 남지 않게 하기 위함.
const CWD_HOOK =
  " __toy_cwd(){ printf '\\033]7;file://%s%s\\a' \"$HOSTNAME\" \"$PWD\"; }; " +
  'if [ -n "$ZSH_VERSION" ]; then precmd_functions+=(__toy_cwd); ' +
  'else PROMPT_COMMAND="__toy_cwd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"; fi; __toy_cwd\r';

/** 사용자가 입력하던 글자가 있는지 추정한다. Enter, Ctrl+C, Ctrl+U면 비었다고 보고, 글자·Tab·위아래 화살표(기록 불러오기)면 있다고 본다. */
function trackTyping(tab: Tab, data: string) {
  if (/[\r\n\x03\x15]/.test(data)) tab.typed = false;
  else if (data === "\x7f") return; // Backspace는 상태를 바꾸지 않는다
  else if (data === "\x1b[A" || data === "\x1b[B" || data === "\t" || !data.startsWith("\x1b")) tab.typed = true;
}

/** 위치 훅을 셸에 입력한다. 입력하던 줄이 있으면 Ctrl+U로 잘라 두었다가 Ctrl+Y로 되붙여 보존한다. */
function injectHook(tab: Tab) {
  tab.hooked = true;
  const data = tab.typed ? `\x15${CWD_HOOK}\x19` : CWD_HOOK;
  invoke("term_write", { id: tab.id, data }).catch(() => {});
}

followBox.addEventListener("change", async () => {
  const tab = active;
  if (!tab || tab.kind !== "ssh") return;
  if (!followBox.checked) {
    tab.follow = false;
    tab.pendingHook = false;
    return;
  }
  if (!tab.hooked && !tab.pendingHook) {
    // 전체 화면 프로그램(vim, less 등)이 떠 있으면 명령이 그 프로그램에 입력되므로, 끝난 뒤에 적용하도록 물어본다.
    if (tab.term.buffer.active.type === "alternate") {
      const c = await choose(
        t("sftp.altScreenTitle"),
        [t("sftp.altScreenBody")],
        [
          { label: t("common.cancel"), value: "cancel" },
          { label: t("sftp.waitApply"), value: "wait", cls: "ok" },
        ],
        "cancel",
      );
      if (c !== "wait") {
        followBox.checked = false;
        return;
      }
      // 묻는 동안 프로그램이 끝났을 수 있다.
      if (tab.term.buffer.active.type === "alternate") tab.pendingHook = true;
      else injectHook(tab);
    } else {
      injectHook(tab);
    }
  }
  tab.follow = true;
  if (tab.cwd) refreshSftp(tab.cwd);
});

const joinPath = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);
const parentPath = (p: string) => p.replace(/\/[^/]*\/?$/, "") || "/";
let flashTimer: number | undefined;
/** 하단 메시지. ms를 주면 그 시간 뒤에 (그동안 다른 메시지로 바뀌지 않았다면) 지운다. */
function flash(m: string, ms = 0) {
  clearTimeout(flashTimer);
  sftpMsg.textContent = m;
  if (ms > 0) {
    flashTimer = window.setTimeout(() => {
      if (sftpMsg.textContent === m) sftpMsg.textContent = "";
    }, ms);
  }
}
const FLASH_MS = 4000;
const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

async function refreshSftp(path?: string) {
  const tab = active;
  if (!tab || tab.kind !== "ssh") return;
  try {
    const l = await invoke<Listing>("sftp_list", { id: tab.id, path: path ?? sftpPath.value });
    tab.sftpPath = l.path;
    sftpPath.value = l.path;
    curEntries = l.entries;
    selected.clear();
    anchor = -1;
    sftpList.replaceChildren(
      ...l.entries.map((e, i) => {
        const li = document.createElement("li");
        li.innerHTML = `<span>${e.is_dir ? "📁" : "📄"}</span><span class="name"></span><span class="size"></span>`;
        (li.querySelector(".name") as HTMLElement).textContent = e.name;
        (li.querySelector(".size") as HTMLElement).textContent = e.is_dir ? "" : fmtSize(e.size);
        const full = joinPath(l.path, e.name);
        li.addEventListener("click", (ev) => selectRow(i, ev));
        // 폴더는 항상 연다. 파일은 설정의 "더블클릭 동작"을 따른다:
        //  edit-download = 편집 가능하면 편집기, 아니면 다운로드(저장할 폴더를 묻는다) / edit = 편집 가능한 것만 / none = 아무 동작 없음
        // 텍스트 파일인데 너무 커서 편집이 안 되는 경우에는 (none이 아니면) 이유를 알려 준다.
        li.addEventListener("dblclick", () => {
          if (e.is_dir) return void refreshSftp(full);
          const mode = getSettings().dblclick;
          if (mode === "none") return;
          if (isEditable(e)) return void editRemote(tab, full, e.name);
          if (e.size > MAX_EDIT_BYTES && hasTextName(e.name)) {
            flash(t("sftp.edit.tooBig", { name: e.name, size: fmtSize(e.size), max: MAX_EDIT_BYTES / 1024 / 1024 }), FLASH_MS);
          }
          if (mode === "edit-download") downloadItems(tab, [e]);
        });
        // 우클릭: 선택 밖의 항목이면 그 항목만 선택하고, 선택 안의 항목이면 선택 전체에 적용한다.
        li.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          if (!selected.has(i)) selectRow(i, new MouseEvent("click"));
          const items = [...selected].sort((a, b) => a - b).map((k) => curEntries[k]);
          const menu: { label: string; fn: () => void }[] = [];
          if (items.length === 1 && isEditable(e)) menu.push({ label: t("sftp.menuEdit"), fn: () => editRemote(tab, full, e.name) });
          menu.push({ label: items.length > 1 ? t("sftp.downloadCount", { count: items.length }) : t("sftp.download"), fn: () => downloadItems(tab, items) });
          menu.push({ label: t("common.delete"), fn: () => removeEntries(tab, items) });
          showMenu(ev.clientX, ev.clientY, menu);
        });
        return li;
      }),
    );
    updateSelectionUi();
    flash(t("sftp.items", { count: l.entries.length }));
  } catch (e) {
    flash(t("sftp.error", { error: String(e) }));
  }
}

// ---- 파일 편집 (임시 폴더에 내려받아 편집기로 열고, 저장하면 자동 업로드) ----

const MAX_EDIT_BYTES = 5 * 1024 * 1024; // 백엔드(edit.rs)와 같은 값
// 텍스트로 보는 확장자. 확장자가 없거나 .bashrc 같은 점 파일도 편집 대상이다. 이진 파일은 백엔드가 내용으로 한 번 더 거른다.
const TEXT_EXT = new Set(
  ("txt md log json xml yml yaml ini conf cfg csv toml properties sh bash zsh fish py js mjs ts tsx jsx html htm css scss env service timer " +
    "sql rb pl php java c h cpp hpp cs go rs lua tf tfvars gradle kt swift r bat cmd ps1 vim list repo rules lock tpl j2 gitignore").split(" "),
);

/** 이름만 보고 텍스트 파일로 볼 수 있는가 (크기는 보지 않는다) */
function hasTextName(name: string): boolean {
  const dot = name.lastIndexOf(".");
  return dot <= 0 || TEXT_EXT.has(name.slice(dot + 1).toLowerCase());
}

function isEditable(e: Entry): boolean {
  return !e.is_dir && e.size <= MAX_EDIT_BYTES && hasTextName(e.name);
}

async function editRemote(tab: Tab, remote: string, name: string) {
  flash(t("sftp.edit.opening", { name }));
  try {
    await invoke("sftp_edit", { id: tab.id, remote, editor: getSettings().editor || null });
    flash(t("sftp.edit.opened", { name }), FLASH_MS);
  } catch (e) {
    flash(t("sftp.error", { error: String(e) }));
  }
}

listen<{ name: string; error: string | null }>("sftp-edit-status", (e) => {
  const { name, error } = e.payload;
  // 실패는 원인을 읽을 시간이 필요하므로 남겨 두고, 성공은 잠깐 보여 준 뒤 지운다.
  if (error) flash(t("sftp.edit.failed", { name, error }));
  else flash(t("sftp.edit.uploaded", { name }), FLASH_MS);
});

// 편집기에서 저장하면 올릴지 묻는다. 내려받은 뒤 서버 파일이 바뀌었으면 덮어쓰기 경고로 묻는다.
listen<{ req: number; name: string; conflict: boolean }>("sftp-edit-confirm", async (e) => {
  const { req, name, conflict } = e.payload;
  const choice = await choose(
    conflict ? t("sftp.edit.conflictTitle") : t("sftp.edit.confirmTitle"),
    [conflict ? t("sftp.edit.conflictBody", { name }) : t("sftp.edit.confirmBody", { name })],
    [
      { label: t("common.cancel"), value: "cancel" },
      { label: conflict ? t("sftp.overwrite") : t("sftp.upload"), value: "upload", cls: "ok" },
    ],
    "cancel",
  );
  if (choice !== "upload") flash(t("sftp.edit.skipped", { name }), FLASH_MS);
  invoke("edit_answer", { req, choice }).catch(() => {});
});

// ---- 다중 선택 (Ctrl+클릭: 토글, Shift+클릭: 범위) ----

let curEntries: Entry[] = [];
const selected = new Set<number>();
let anchor = -1;
const dlBtn = $<HTMLButtonElement>("#sftp-download");

function selectRow(i: number, ev: MouseEvent) {
  if (ev.shiftKey && anchor >= 0) {
    const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
    if (!ev.ctrlKey) selected.clear();
    for (let k = a; k <= b; k++) selected.add(k);
  } else if (ev.ctrlKey || ev.metaKey) {
    selected.has(i) ? selected.delete(i) : selected.add(i);
    anchor = i;
  } else {
    selected.clear();
    selected.add(i);
    anchor = i;
  }
  updateSelectionUi();
}

function updateSelectionUi() {
  Array.from(sftpList.children).forEach((li, i) => li.classList.toggle("sel", selected.has(i)));
  dlBtn.disabled = selected.size === 0;
  // 아이콘 버튼이라 글자는 없고, 여러 개를 골랐을 때만 개수를 옆에 작게 보여 준다.
  dlBtn.querySelector(".cnt")!.textContent = selected.size > 1 ? String(selected.size) : "";
  dlBtn.title = selected.size > 1 ? t("sftp.downloadCount", { count: selected.size }) : t("sftp.downloadTitle");
}

dlBtn.addEventListener("click", () => {
  if (active) downloadItems(active, [...selected].sort((a, b) => a - b).map((i) => curEntries[i]));
});

type DownloadPlan = { files: { remote: string; local: string; exists: boolean }[]; dirs: string[]; skipped: number };

/** 파일과 폴더(하위 전체)를 고른 로컬 폴더에 같은 구조로 내려받는다. */
async function downloadItems(tab: Tab, items: Entry[]) {
  if (!items.length) return;
  const dest = await openDialog({ directory: true, multiple: false, title: t("sftp.pickDest") });
  if (typeof dest !== "string") return;
  const base = tab.sftpPath;
  try {
    flash(t("sftp.listing"));
    const plan = await invoke<DownloadPlan>("sftp_plan_download", {
      id: tab.id,
      items: items.map((e) => ({ path: joinPath(base, e.name), name: e.name, is_dir: e.is_dir })),
      dest,
    });
    let skipExisting = false;
    const existing = plan.files.filter((f) => f.exists).length;
    if (existing) {
      const c = await choose(
        t("sftp.existsTitle"),
        [t("sftp.existsBody", { count: existing })],
        [
          { label: t("common.cancel"), value: "cancel" },
          { label: t("sftp.skip"), value: "skip" },
          { label: t("sftp.overwrite"), value: "overwrite", cls: "ok" },
        ],
        "cancel",
      );
      if (c === "cancel") return flash(t("sftp.cancelled"));
      skipExisting = c === "skip";
    }
    await invoke("local_mkdirs", { paths: plan.dirs }); // 빈 폴더도 만들어 둔다
    const todo = plan.files.filter((f) => !(skipExisting && f.exists));
    let ok = 0;
    let failed = 0;
    let lastErr = "";
    for (const [i, f] of todo.entries()) {
      flash(t("sftp.progress", { i: i + 1, n: todo.length }));
      try {
        await invoke("sftp_download", { id: tab.id, remote: f.remote, local: f.local });
        ok++;
      } catch (e) {
        failed++;
        lastErr = String(e);
      }
    }
    const parts = [t("sftp.done", { count: ok })];
    if (failed) parts.push(t("sftp.failed", { count: failed, error: lastErr }));
    if (skipExisting && existing) parts.push(t("sftp.skippedExisting", { count: existing }));
    if (plan.skipped) parts.push(t("sftp.unsafe", { count: plan.skipped }));
    flash(joinList(parts));
  } catch (e) {
    flash(t("sftp.error", { error: String(e) }));
  }
}

/** 선택한 항목들을 삭제한다. 하나라도 실패하면 거기서 멈추고 원인을 알린다. */
async function removeEntries(tab: Tab, items: Entry[]) {
  if (!items.length) return;
  const msg = items.length === 1 ? t("sftp.removeConfirm", { name: items[0].name }) : t("sftp.removeConfirmMany", { count: items.length });
  if (!(await confirmBox(msg))) return;
  try {
    for (const e of items) await invoke("sftp_remove", { id: tab.id, path: joinPath(tab.sftpPath, e.name), isDir: e.is_dir });
  } catch (e) {
    flash(t("sftp.error", { error: String(e) }));
  }
  refreshSftp(tab.sftpPath);
}

$("#sftp-up").addEventListener("click", () => refreshSftp(parentPath(sftpPath.value)));
$("#sftp-refresh").addEventListener("click", () => refreshSftp());
sftpPath.addEventListener("keydown", (e) => e.key === "Enter" && refreshSftp());

$("#sftp-upload").addEventListener("click", async () => {
  if (!active) return;
  const picked = await openDialog({ multiple: true });
  if (!picked) return;
  const files = Array.isArray(picked) ? picked : [picked];
  for (const local of files) {
    const name = local.split(/[\\/]/).pop()!;
    flash(t("sftp.uploading", { name }));
    try {
      await invoke("sftp_upload", { id: active.id, local, remote: joinPath(sftpPath.value, name) });
    } catch (e) {
      return flash(t("sftp.error", { error: String(e) }));
    }
  }
  flash(t("sftp.uploaded"), FLASH_MS);
  refreshSftp();
});

$("#sftp-mkdir").addEventListener("click", async () => {
  const name = await ask(t("sftp.mkdir"), t("sftp.mkdirLabel"));
  if (!name || !active) return;
  try {
    await invoke("sftp_mkdir", { id: active.id, path: joinPath(sftpPath.value, name) });
    refreshSftp();
  } catch (e) {
    flash(t("sftp.error", { error: String(e) }));
  }
});

// ---------- 탐색기에서 끌어다 놓아 업로드 ----------

type UploadPlan = { files: { local: string; remote: string }[]; dirs: string[]; existing: number; skipped: number };

/** 끌어다 놓은 위치가 SFTP 패널이면 올릴 폴더를 정한다. 폴더 행 위면 그 폴더 안, 아니면 지금 보는 폴더. */
function uploadTargetAt(pos: { x: number; y: number }): { tab: Tab; dest: string; li: HTMLElement | null } | null {
  if (sftpEl.hidden || !active || active.kind !== "ssh") return null;
  // 이벤트 위치는 화면 픽셀 단위라 CSS 픽셀로 바꿔서 요소를 찾는다.
  const el = document.elementFromPoint(pos.x / window.devicePixelRatio, pos.y / window.devicePixelRatio) as HTMLElement | null;
  if (!el || !sftpEl.contains(el)) return null;
  const li = el.closest<HTMLElement>("#sftp-list li");
  const entry = li ? curEntries[Array.from(sftpList.children).indexOf(li)] : undefined;
  if (li && entry?.is_dir) return { tab: active, dest: joinPath(active.sftpPath, entry.name), li };
  return { tab: active, dest: active.sftpPath, li: null };
}

function markUpload(target: ReturnType<typeof uploadTargetAt>) {
  sftpEl.classList.toggle("dropping", !!target);
  if (target) sftpEl.dataset.drop = t("sftp.dropHere");
  sftpList.querySelectorAll(".dropto").forEach((x) => x.classList.remove("dropto"));
  target?.li?.classList.add("dropto");
}

/** 파일과 폴더(하위 전체)를 서버의 dest 폴더로 올린다. */
async function uploadPaths(tab: Tab, paths: string[], dest: string) {
  try {
    flash(t("sftp.listing"));
    const plan = await invoke<UploadPlan>("sftp_plan_upload", { id: tab.id, paths, dest });
    if (!plan.files.length && !plan.dirs.length) return flash(t("sftp.upNothing"), FLASH_MS);
    if (plan.existing) {
      const c = await choose(
        t("sftp.upExistsTitle"),
        [t("sftp.upExistsBody", { count: plan.existing })],
        [
          { label: t("common.cancel"), value: "cancel" },
          { label: t("sftp.overwrite"), value: "overwrite", cls: "ok" },
        ],
        "cancel",
      );
      if (c !== "overwrite") return flash(t("sftp.cancelled"), FLASH_MS);
    }
    await invoke("sftp_mkdirs", { id: tab.id, paths: plan.dirs }); // 빈 폴더도 만든다
    let ok = 0;
    let failed = 0;
    let lastErr = "";
    for (const [i, f] of plan.files.entries()) {
      flash(t("sftp.upProgress", { i: i + 1, n: plan.files.length }));
      try {
        await invoke("sftp_upload", { id: tab.id, local: f.local, remote: f.remote });
        ok++;
      } catch (e) {
        failed++;
        lastErr = String(e);
      }
    }
    if (active === tab) await refreshSftp(tab.sftpPath);
    const parts = [t("sftp.upDone", { count: ok })];
    if (failed) parts.push(t("sftp.failed", { count: failed, error: lastErr }));
    if (plan.skipped) parts.push(t("sftp.upSkipped", { count: plan.skipped }));
    flash(joinList(parts), failed ? 0 : FLASH_MS);
  } catch (e) {
    flash(t("sftp.error", { error: String(e) }));
  }
}

// Tauri 밖(브라우저에서 화면만 볼 때)에서는 파일 드롭 이벤트가 없다.
try {
  getCurrentWebview()
    .onDragDropEvent((ev) => {
      const p = ev.payload;
      if (p.type === "leave") return markUpload(null);
      const target = uploadTargetAt(p.position);
      if (p.type === "drop") {
        markUpload(null);
        if (target && p.paths.length) uploadPaths(target.tab, p.paths, target.dest);
      } else {
        markUpload(target);
      }
    })
    .catch(() => {});
} catch {
  // 무시
}

// ---------- SSH 호스트 지문 확인 ----------

type HostKeyPrompt = { req: number; host: string; port: number; algorithm: string; fingerprint: string; old: string | null };

listen<HostKeyPrompt>("host-key-prompt", async (e) => {
  const p = e.payload;
  const where = `${p.host}:${p.port} (${p.algorithm})`;
  const choice = p.old
    ? await choose(
        t("hostkey.changedTitle"),
        [
          where,
          t("hostkey.changedWarn"),
          t("hostkey.savedFingerprint", { value: p.old }),
          t("hostkey.currentFingerprint", { value: p.fingerprint }),
        ],
        [
          { label: t("common.cancel"), value: "cancel" },
          { label: t("hostkey.once"), value: "once" },
          { label: t("hostkey.replace"), value: "trust", cls: "ok" },
        ],
        "cancel",
      )
    : await choose(
        t("hostkey.newTitle"),
        [where, t("hostkey.fingerprint", { value: p.fingerprint }), t("hostkey.newGuide")],
        [
          { label: t("common.cancel"), value: "cancel" },
          { label: t("hostkey.trust"), value: "trust", cls: "ok" },
        ],
        "cancel",
      );
  invoke("host_key_answer", { req: p.req, choice }).catch(() => {});
});

// ---------- 프로필에서 접속 ----------

/** 백엔드(ssh.rs)의 Hop */
type SshHop = { host: string; port: number; user: string; password: string | null; key_path: string | null; passphrase: string | null };

/** 한 서버에 접속하는 데 필요한 계정과 비밀번호(또는 키 암호)를 묻는다. 취소하면 null. */
async function askHop(p: Profile): Promise<SshHop | null> {
  // 계정이 저장돼 있지 않으면 가장 먼저 묻는다.
  let user = p.user?.trim() ?? "";
  if (!user) {
    const v = (await ask(t("connect.userTitle"), t("connect.userLabel", { host: p.host ?? "" })))?.trim();
    if (!v) return null;
    user = v;
  }
  // 저장된 비밀번호가 있으면 마스터 비밀번호로 잠금을 풀어 쓴다. 풀지 않거나(취소) 읽지 못하면 직접 묻는다.
  let password: string | null = null;
  let passphrase: string | null = null;
  const useKey = (p.use_key ?? !!p.key_path) && !!p.key_path;
  const saved = hasSecret(p.id) ? await readSecret(p.id) : null;
  if (saved !== null) {
    if (useKey) passphrase = saved || null;
    else password = saved;
  } else if (!useKey) {
    const v = await ask(t("connect.passwordTitle"), `${user}@${p.host}`, { password: true });
    if (v === null) return null;
    password = v;
  }
  return { host: p.host ?? "", port: p.port ?? 22, user, password, key_path: useKey ? (p.key_path ?? null) : null, passphrase };
}

/** 접속 시도를 '접속 중' 모달로 감싼다. 취소하면 null을 돌려주고, 취소 뒤에 늦게 성공한 탭은 닫는다. */
function withConnecting(name: string, run: () => Promise<Tab>): Promise<Tab | null> {
  return new Promise((resolve, reject) => {
    let cancelled = false;
    const close = showConnecting(name, () => {
      cancelled = true;
      resolve(null);
    });
    run().then(
      (tab) => {
        close();
        if (cancelled) void closeTab(tab);
        else resolve(tab);
      },
      (e) => {
        close();
        if (!cancelled) reject(e);
      },
    );
  });
}

let connecting = false; // 접속 중에 같은 접속을 또 시작하지 못하게 한다

async function connectProfile(p: Profile) {
  if (connecting) return;
  connecting = true;
  showStatus("");
  try {
    if (p.kind !== "ssh") {
      if (p.admin) {
        showStatus(t("connect.uac"));
        await withConnecting(p.name, () => openLocalTab(p.name, p.kind, true, p.icon, p));
      } else await openLocalTab(p.name, p.kind, false, p.icon, p);
      showStatus("");
      return;
    }
    const target = await askHop(p);
    if (!target) return;
    const { user } = target;
    const forwards = (p.forwards ?? []).flatMap((l) => parseForward(l) ?? []);
    showStatus(t("connect.connecting"));
    const open = () =>
      createTab(p.name, "ssh", (cols, rows) =>
        invoke<string>("open_ssh", { params: { ...target, forwards, keepalive_secs: getSettings().keepalive, cols, rows } }),
        false,
        p.icon,
        `remote server over SSH (${user}@${p.host}); assume a Unix-like shell such as bash`,
        p,
      );
    for (;;) {
      try {
        await withConnecting(p.name, open);
        break;
      } catch (e) {
        // 키에 암호가 걸려 있을 때만 그 암호를 묻고 다시 시도한다 (암호 없는 키는 묻지 않는다).
        // 문구는 백엔드 ssh.rs load_key의 오류와 맞춰 둔다 (그쪽 테스트가 문구를 확인한다).
        const err = String(e);
        if (!target.key_path || !(err.includes("암호화되어 있습니다") || err.includes("암호가 틀렸"))) throw e;
        const v = await ask(t("connect.keyPassTitle"), t("connect.keyPassLabel", { name: p.name }), { password: true });
        if (v === null) {
          showStatus("");
          return;
        }
        target.passphrase = v || null;
        showStatus(t("connect.connecting"));
      }
    }
    showStatus("");
  } catch (e) {
    showStatus(t("connect.failed", { error: String(e) }));
  } finally {
    connecting = false;
  }
}

// ---------- 시작 ----------

// 언어가 바뀌면 코드로 만든 문구를 다시 그린다 (고정 문구는 setLang이 처리).
onLangChange(() => {
  rerenderProfiles();
  updateSelectionUi();
  syncMaximized(); // 최대화 버튼의 툴팁은 상태에 따라 달라서 고정 문구 변환이 덮어쓴다
});

// 웹뷰(크롬)의 입력칸 자동완성 목록을 모든 입력칸에서 끈다. 칸마다 속성을 달지 않으려고 포커스될 때 붙인다.
document.addEventListener("focusin", (e) => {
  const el = e.target;
  if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !el.hasAttribute("autocomplete")) {
    el.setAttribute("autocomplete", el instanceof HTMLInputElement && el.type === "password" ? "new-password" : "off");
  }
});

(async () => {
  await loadSettings();
  applySidebarWidth(getSettings().sidebarWidth);
  await ensureFontLoaded(getTermFont());
  setLang(resolveLang(getSettings().lang));
  applyStatic();
  await applyAppearance();
  initAi({
    terminal: (id) => {
      const tab = id ? tabs.get(id) : active; // id가 있으면 그 세션(보고 있지 않아도), 없으면 지금 보는 세션
      return tab ? { id: tab.id, term: tab.term, context: tab.context, exec: tab.kind === "ssh" ? { id: tab.id, cwd: () => tab.cwd, label: tab.context } : null } : null;
    },
    paste: (term, text) => void pasteText(term, text),
    openSettings: () => openSettings("ai"),
    closePanel: () => showPane("sessions"),
  });
  await initProfiles(connectProfile);
})();
