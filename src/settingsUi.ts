import { isLightColor, mixHex, normalizeHex } from "./colors";
import { visibleRange } from "./virtual";
import { BUNDLED_FONTS, clampSize, DEFAULT_SIZE, MAX_SIZE, MIN_SIZE, WINDOWS_FONTS } from "./fonts";
import { applyFont, applyScrollback, getTermFont } from "./termFont";
import { askNewMaster, vaultStatus } from "./vault";
import { clampKeepalive, DEFAULT_KEEPALIVE, MAX_KEEPALIVE, MIN_KEEPALIVE } from "./keepalive";
import { clampScrollback, DEFAULT_SCROLLBACK, MAX_SCROLLBACK, MIN_SCROLLBACK } from "./scrollback";
import { resolveLang, setLang, t, type LangPref } from "./i18n";
import { AUTO, CUSTOM, loadSchemes, type Scheme } from "./schemes";
import { getSettings, updateSettings, type DblClick, type ThemePref } from "./settings";
import { applyAppearance, effectiveTheme, getTermTheme, resolveScheme } from "./theme";
import { ask, confirmBox, modal, pickExecutable } from "./ui";
import { invoke } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { refreshAi } from "./ai";
import { APP_NAME, APP_VERSION } from "./version";

export type Page = "general" | "colors" | "font" | "editor" | "ai" | "language" | "help" | "about";
const PAGES: { id: Page; key: string }[] = [
  { id: "general", key: "settings.menu.general" },
  { id: "colors", key: "settings.menu.colors" },
  { id: "font", key: "settings.menu.font" },
  { id: "editor", key: "settings.menu.editor" },
  { id: "ai", key: "settings.menu.ai" },
  { id: "language", key: "settings.menu.language" },
  { id: "help", key: "settings.menu.help" },
  { id: "about", key: "settings.menu.about" },
];

/** 스킴의 ANSI 16색 순서. 문구 키는 settings.ansi.<이름> */
const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "purple", "cyan", "white", "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightPurple", "brightCyan", "brightWhite"];
const CHUNK = 40;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
};

export function openSettings(start: Page = "general") {
  let page: Page = start;
  const dlg = modal((d) => {
    d.className = "settings";
    d.innerHTML = `<div class="shead"><h3></h3><button type="button" class="sclose">✕</button></div>
      <div class="sbody"><nav class="smenu"></nav><section class="spage"></section></div>`;
  });
  const menu = dlg.querySelector(".smenu") as HTMLElement;
  const pageEl = dlg.querySelector(".spage") as HTMLElement;
  dlg.querySelector(".sclose")!.addEventListener("click", () => dlg.close());

  const renderMenu = () =>
    menu.replaceChildren(
      ...PAGES.map((p) => {
        const b = el("button", p.id === page ? "active" : "", t(p.key));
        b.type = "button";
        b.addEventListener("click", () => {
          page = p.id;
          renderAll();
        });
        return b;
      }),
    );

  const renderPage = () => {
    pageEl.replaceChildren();
    if (page === "general") generalPage(pageEl);
    else if (page === "language") languagePage(pageEl, renderAll);
    else if (page === "editor") editorPage(pageEl);
    else if (page === "font") fontPage(pageEl);
    else if (page === "help") helpPage(pageEl);
    else if (page === "about") aboutPage(pageEl);
    else if (page === "ai") aiPage(pageEl);
    else colorsPage(pageEl, renderPage);
  };

  function renderAll() {
    (dlg.querySelector("h3") as HTMLElement).textContent = t("settings.title");
    (dlg.querySelector(".sclose") as HTMLElement).title = t("common.close");
    renderMenu();
    renderPage();
  }
  renderAll();
}

function radios(name: string, options: { value: string; label: string }[], value: string, onChange: (v: string) => void): HTMLElement {
  const box = el("div", "radios");
  for (const o of options) {
    const label = el("label", "radio");
    const input = el("input");
    input.type = "radio";
    input.name = name;
    input.checked = o.value === value;
    input.addEventListener("change", () => input.checked && onChange(o.value));
    label.append(input, el("span", "", o.label));
    box.appendChild(label);
  }
  return box;
}

// ---------- 테마 ----------

function themePage(root: HTMLElement) {
  root.append(
    el("h4", "", t("settings.theme.heading")),
    radios(
      "theme",
      [
        { value: "dark", label: t("settings.theme.dark") },
        { value: "light", label: t("settings.theme.light") },
        { value: "system", label: t("settings.theme.system") },
      ],
      getSettings().theme,
      (v) => {
        updateSettings({ theme: v as ThemePref });
        applyAppearance();
      },
    ),
  );
}

// ---------- AI ----------

function aiPage(root: HTMLElement) {
  const ai = getSettings().ai;
  const text = (value: string, placeholder: string, password = false) => {
    const i = el("input");
    i.value = value;
    i.placeholder = placeholder;
    i.spellcheck = false;
    if (password) i.type = "password";
    return i;
  };
  const url = text(ai.url, t("settings.ai.urlPlaceholder"));
  const model = text(ai.model, t("settings.ai.modelPlaceholder"));
  const key = text(ai.apiKey, t("settings.ai.keyPlaceholder"), true);
  const system = el("textarea", "aisystem");
  system.value = ai.system;
  system.placeholder = t("settings.ai.systemPlaceholder");
  system.spellcheck = false;

  // 서버 주소를 바꾸면 consent(동의한 주소)와 달라져서, 다음 전송 때 다시 동의를 받는다.
  const log = el("input");
  log.type = "checkbox";
  log.checked = ai.log;
  const commit = () => {
    updateSettings({ ai: { ...getSettings().ai, url: url.value.trim(), model: model.value.trim(), apiKey: key.value.trim(), system: system.value, log: log.checked } });
    refreshAi();
  };
  for (const i of [url, model, key, system, log]) i.addEventListener("change", commit);
  const logRow = el("label", "chk");
  logRow.append(log, el("span", "", t("settings.ai.log")));

  // 서버 명령 실행: 켤 때 무엇이 일어나는지 확인받는다. 도구 호출 지원 여부는 실행을 켠 경우에만 의미가 있다.
  const execBox = el("input");
  execBox.type = "checkbox";
  execBox.checked = ai.exec;
  const toolsBox = el("input");
  toolsBox.type = "checkbox";
  toolsBox.checked = ai.tools;
  toolsBox.disabled = !ai.exec;
  execBox.addEventListener("change", async () => {
    if (execBox.checked && !(await confirmBox(t("settings.ai.execConfirm"), t("settings.ai.execOn")))) {
      execBox.checked = false;
      return;
    }
    updateSettings({ ai: { ...getSettings().ai, exec: execBox.checked } });
    toolsBox.disabled = !execBox.checked;
    refreshAi();
  });
  toolsBox.addEventListener("change", () => updateSettings({ ai: { ...getSettings().ai, tools: toolsBox.checked } }));
  const execRow = el("label", "chk");
  execRow.append(execBox, el("span", "", t("settings.ai.exec")));
  const toolsRow = el("label", "chk");
  toolsRow.append(toolsBox, el("span", "", t("settings.ai.tools")));

  const row = (label: string, input: HTMLElement) => {
    const l = el("label", "fontrow");
    l.append(el("span", "", label), input);
    return l;
  };
  const fields = el("div", "aifields");
  fields.append(
    row(t("settings.ai.url"), url),
    row(t("settings.ai.model"), model),
    row(t("settings.ai.key"), key),
    el("div", "fontlabel", t("settings.ai.system")),
    system,
    execRow,
    toolsRow,
    el("p", "hint", t("settings.ai.execHint")),
    logRow,
    el("p", "hint", t("settings.ai.logHint")),
    el("p", "hint", t("settings.ai.hint")),
  );

  // 사용/미사용 토글. 미사용이면 [AI] 탭이 사라지고 설정 항목은 흐리게 보인다(값은 그대로 남는다).
  const toggle = el("button", "");
  toggle.type = "button";
  const showEnabled = () => {
    const on = getSettings().ai.enabled;
    toggle.textContent = t(on ? "settings.ai.on" : "settings.ai.off");
    toggle.className = `aitoggle ${on ? "on" : "off"}`;
    fields.classList.toggle("disabled", !on);
  };
  toggle.addEventListener("click", () => {
    updateSettings({ ai: { ...getSettings().ai, enabled: !getSettings().ai.enabled } });
    showEnabled();
    refreshAi();
  });
  showEnabled();
  const toggleRow = el("div", "aitogglerow");
  toggleRow.append(el("span", "", t("settings.ai.enabled")), toggle);

  root.append(el("h4", "", t("settings.ai.heading")), toggleRow, fields);
}

// ---------- 정보 ----------

// ---------- 도움말 ----------

/** 항목마다 제목(settings.help.<이름>.title)과 줄 단위 본문(settings.help.<이름>.body)을 보여 준다. */
function helpPage(root: HTMLElement) {
  for (const s of ["connect", "tabs", "terminal", "sidebar", "tools", "data"]) {
    const ul = el("ul", "helplist");
    for (const line of t(`settings.help.${s}.body`).split("\n")) ul.append(el("li", "", line));
    root.append(el("h4", "", t(`settings.help.${s}.title`)), ul);
  }
}

function aboutPage(root: HTMLElement) {
  const copy = el("button", "", t("settings.about.copy"));
  copy.type = "button";
  copy.addEventListener("click", async () => {
    await writeText(`${APP_NAME} v${APP_VERSION}`).catch(() => {});
    copy.textContent = t("settings.about.copied");
    setTimeout(() => (copy.textContent = t("settings.about.copy")), 1500);
  });
  const row = el("div", "aboutrow");
  row.append(el("span", "", t("settings.about.version")), el("strong", "", `v${APP_VERSION}`), copy);
  // 포함된 오픈소스 목록: 읽기 전용 글상자 (줄마다 하나)
  const list = el("textarea", "osslist");
  list.readOnly = true;
  list.spellcheck = false;
  list.value = t("settings.about.componentsList");
  list.rows = list.value.split("\n").length; // 줄 수만큼의 높이로 고정
  root.append(el("h4", "", APP_NAME), row, el("div", "fontlabel", t("settings.about.components")), list);
}

// ---------- 일반 ----------

function generalPage(root: HTMLElement) {
  const scrollback = el("input");
  scrollback.type = "number";
  scrollback.min = String(MIN_SCROLLBACK);
  scrollback.max = String(MAX_SCROLLBACK);
  scrollback.step = "1000";
  scrollback.value = String(clampScrollback(getSettings().scrollback));
  // 바꾸면 열려 있는 모든 터미널에 바로 적용한다.
  scrollback.addEventListener("change", () => {
    const n = clampScrollback(Number(scrollback.value));
    scrollback.value = String(n);
    updateSettings({ scrollback: n });
    applyScrollback();
  });
  const keepalive = el("input");
  keepalive.type = "number";
  keepalive.min = "0";
  keepalive.max = String(MAX_KEEPALIVE);
  keepalive.value = String(clampKeepalive(getSettings().keepalive));
  // 새로 접속하는 SSH 탭부터 적용된다 (이미 열린 연결은 그대로).
  keepalive.addEventListener("change", () => {
    const n = clampKeepalive(Number(keepalive.value));
    keepalive.value = String(n);
    updateSettings({ keepalive: n });
  });
  const reset = el("button", "", t("settings.general.reset"));
  reset.type = "button";
  reset.addEventListener("click", () => {
    scrollback.value = String(DEFAULT_SCROLLBACK);
    updateSettings({ scrollback: DEFAULT_SCROLLBACK, keepalive: DEFAULT_KEEPALIVE });
    keepalive.value = String(DEFAULT_KEEPALIVE);
    applyScrollback();
  });
  const l = el("label", "fontrow");
  l.append(el("span", "", t("settings.general.scrollback")), scrollback);
  const k = el("label", "fontrow");
  k.append(el("span", "", t("settings.general.keepalive")), keepalive);
  root.append(el("h4", "", t("settings.general.heading")), l, el("p", "hint", t("settings.general.hint")), k, el("p", "hint", t("settings.general.keepaliveHint", { min: MIN_KEEPALIVE })), reset);
  vaultSection(root);
}

// ---------- 저장된 비밀번호 ----------

function vaultSection(root: HTMLElement) {
  const state = el("p", "hint");
  const msg = el("p", "hint");
  const change = el("button", "", t("settings.vault.change"));
  const reset = el("button", "", t("settings.vault.reset"));
  for (const b of [change, reset]) b.type = "button";

  const refresh = async () => {
    try {
      const s = await vaultStatus();
      change.disabled = reset.disabled = !s.exists;
      state.textContent = s.exists ? t("settings.vault.state", { count: s.ids.length, lock: t(s.unlocked ? "settings.vault.unlocked" : "settings.vault.locked") }) : t("settings.vault.none");
    } catch (e) {
      state.textContent = t("vault.failed", { error: String(e) });
    }
  };
  const run = async (fn: () => Promise<string | null>) => {
    try {
      msg.textContent = (await fn()) ?? "";
    } catch (e) {
      msg.textContent = t("vault.failed", { error: String(e) });
    }
    await refresh();
  };

  change.addEventListener("click", () =>
    run(async () => {
      const old = await ask(t("settings.vault.oldTitle"), t("settings.vault.oldLabel"), { password: true, stacked: true });
      if (old === null) return null;
      const fresh = await askNewMaster("", t("settings.vault.newTitle"));
      if (fresh === null) return null;
      await invoke("secrets_change_master", { old, new: fresh });
      return t("settings.vault.changed");
    }),
  );
  reset.addEventListener("click", () =>
    run(async () => {
      if (!(await confirmBox(t("settings.vault.resetConfirm"), t("settings.vault.reset")))) return null;
      await invoke("secrets_reset");
      return t("settings.vault.resetDone");
    }),
  );

  const buttons = el("div", "fontpresets");
  buttons.append(change, reset);
  root.append(el("h4", "", t("settings.vault.heading")), state, buttons, msg, el("p", "hint", t("settings.vault.hint")));
  refresh();
}

// ---------- 글꼴 ----------

function fontPage(root: HTMLElement) {
  const s = getSettings();
  const sample = el("div", "fontsample", t("settings.font.sample"));
  const family = el("input");
  family.value = s.fontFamily;
  family.placeholder = t("settings.font.placeholder");
  family.spellcheck = false;
  const size = el("input");
  size.type = "number";
  size.min = String(MIN_SIZE);
  size.max = String(MAX_SIZE);
  size.value = String(clampSize(s.fontSize));

  // 바꾸면 미리보기와 열려 있는 모든 터미널에 바로 적용한다.
  const commit = async () => {
    const fontSize = clampSize(Number(size.value));
    size.value = String(fontSize);
    updateSettings({ fontFamily: family.value.trim(), fontSize });
    await applyFont(); // 앱에 포함된 글꼴은 불러온 뒤에 적용해야 칸이 어긋나지 않는다
    refresh();
  };
  const refresh = () => {
    const f = getTermFont();
    sample.style.fontFamily = f.fontFamily;
    sample.style.fontSize = `${f.fontSize}px`;
    const theme = getTermTheme();
    sample.style.background = theme.background ?? "";
    sample.style.color = theme.foreground ?? "";
  };
  family.addEventListener("change", commit);
  size.addEventListener("change", commit);

  // 글꼴 이름 버튼들. 각 이름을 그 글꼴로 그려서 모양을 보고 고른다.
  const chips = (names: string[]) => {
    const box = el("div", "fontpresets");
    for (const name of names) {
      const b = el("button", "", name);
      b.type = "button";
      b.style.fontFamily = `"${name}", monospace`;
      b.addEventListener("click", () => {
        family.value = name;
        commit();
      });
      box.appendChild(b);
    }
    return box;
  };
  const reset = el("button", "", t("settings.font.reset"));
  reset.type = "button";
  reset.addEventListener("click", () => {
    family.value = "";
    size.value = String(DEFAULT_SIZE);
    commit();
  });

  const row = (label: string, input: HTMLElement) => {
    const l = el("label", "fontrow");
    l.append(el("span", "", label), input);
    return l;
  };
  root.append(
    el("h4", "", t("settings.font.heading")),
    el("div", "fontlabel first", t("settings.font.bundled")),
    chips([...BUNDLED_FONTS, ...WINDOWS_FONTS]),
    row(t("settings.font.family"), family),
    row(t("settings.font.size"), size),
    sample,
    el("p", "hint", t("settings.font.hint")),
    reset,
  );
  refresh();
}

// ---------- 편집기 ----------

function editorPage(root: HTMLElement) {
  const input = el("input");
  input.value = getSettings().editor;
  input.placeholder = t("settings.editor.placeholder");
  input.spellcheck = false;
  input.addEventListener("change", () => updateSettings({ editor: input.value.trim() }));
  const browse = el("button", "", t("profile.browse"));
  browse.type = "button";
  browse.addEventListener("click", async () => {
    const path = await pickExecutable();
    if (!path) return;
    input.value = path;
    updateSettings({ editor: path });
  });
  const row = el("div", "editorrow");
  row.append(input, browse);
  root.append(
    el("h4", "", t("settings.editor.heading")),
    row,
    el("p", "hint", t("settings.editor.hint")),
    el("div", "fontlabel", t("settings.editor.dblclick")),
    radios(
      "dblclick",
      [
        { value: "edit-download", label: t("settings.editor.dblEditDownload") },
        { value: "edit", label: t("settings.editor.dblEdit") },
        { value: "none", label: t("settings.editor.dblNone") },
      ],
      getSettings().dblclick,
      (v) => updateSettings({ dblclick: v as DblClick }),
    ),
  );
}

// ---------- 언어 ----------

function languagePage(root: HTMLElement, rerender: () => void) {
  root.append(
    el("h4", "", t("settings.language.heading")),
    radios(
      "lang",
      [
        { value: "system", label: t("settings.language.system") },
        { value: "ko", label: t("settings.language.ko") },
        { value: "en-US", label: t("settings.language.en") },
      ],
      getSettings().lang,
      (v) => {
        updateSettings({ lang: v as LangPref });
        setLang(resolveLang(v as LangPref));
        rerender(); // 열려 있는 설정 창의 문구도 바로 바꾼다
      },
    ),
  );
}

// ---------- 색상 구성 ----------

/** ls 출력 예시. 스킴의 배경, 글자, ANSI 색으로 그린다. */
function schemePreview(s: Scheme): HTMLElement {
  const pv = el("div", "pv");
  pv.style.background = s.b;
  pv.style.color = s.f;
  const span = (text: string, color?: string, bg?: string, bold = false) => {
    const e = el("span", "", text);
    if (color) e.style.color = color;
    if (bg) e.style.background = bg;
    if (bold) e.style.fontWeight = "bold";
    return e;
  };
  const line = (...parts: HTMLElement[]) => {
    const l = el("div", "pl");
    l.append(...parts);
    return l;
  };
  const cursor = span(" ", undefined, s.c);
  pv.append(
    line(span("john", s.a[2]), span("@"), span("doe-pc", s.a[4]), span("$", s.a[1]), span(" ls"), cursor),
    line(span("-rwxr-xr-x 1 root "), span("Documents", s.a[3], undefined, true)),
    line(span("-rwxr-xr-x 1 root "), span("Downloads", s.b, s.a[2], true)),
    line(span("-rwxr-xr-x 1 root "), span("Pictures", s.b, s.a[8], true)),
  );
  return pv;
}

type Entry = { id: string; name: string; scheme: Scheme | null; /** 번들 스킴이 아니라 맨 위에 고정된 항목(앱 테마에 맞춤, 내 색상 구성) */ special: boolean; light: boolean };
type Mode = "all" | "dark" | "light";
/** 목록 한 행의 높이(px). 가상 스크롤이 이 값으로 위치를 계산한다. */
const ROW_H = 136;

async function colorsPage(root: HTMLElement, rerender: () => void) {
  themePage(root); // 화면 모드(다크/화이트/시스템)는 색상 페이지 맨 위에 둔다
  root.append(el("h4", "", t("settings.colors.heading")));

  const s = getSettings();
  const eff = effectiveTheme(s.theme);
  // 처음에는 선택된 색상 구성이 보이는 쪽(없으면 지금 앱 모드)만 보여 준다.
  const picked = s.scheme === AUTO || s.scheme === CUSTOM ? undefined : (await loadSchemes().catch(() => [] as Scheme[])).find((x) => x.n === s.scheme);
  let mode: Mode = picked ? (isLightColor(picked.b) ? "light" : "dark") : eff;
  const modeBar = el("div", "cfilter");
  const modeBtns = (["all", "dark", "light"] as Mode[]).map((m) => {
    const b = el("button", "", t(`settings.colors.filter.${m}`));
    b.type = "button";
    b.addEventListener("click", () => {
      mode = m;
      markModes();
      filter(true);
    });
    modeBar.appendChild(b);
    return { m, b };
  });
  const markModes = () => modeBtns.forEach(({ m, b }) => b.classList.toggle("active", m === mode));
  markModes();

  const search = el("input", "csearch");
  search.placeholder = t("settings.colors.search");
  search.spellcheck = false;
  const list = el("div", "clist");
  const sizer = el("div", "vsizer");
  list.appendChild(sizer);
  root.append(modeBar, search, list);

  let all: Scheme[];
  try {
    all = await loadSchemes();
  } catch (e) {
    list.textContent = t("settings.colors.loadFailed", { error: String(e) });
    return;
  }
  const auto = await resolveScheme({ ...s, scheme: AUTO }, eff);
  const entries: Entry[] = [
    { id: AUTO, name: t("settings.colors.auto"), scheme: auto, special: true, light: false },
    { id: CUSTOM, name: t("settings.colors.custom"), scheme: s.custom, special: true, light: false },
    ...all.map((x) => ({ id: x.n, name: x.n, scheme: x, special: false, light: isLightColor(x.b) })),
  ];

  let shown: Entry[] = [];
  let start = -1;
  let end = -1;

  const markSelected = () => {
    const cur = getSettings().scheme;
    sizer.querySelectorAll<HTMLElement>(".crow").forEach((r) => r.classList.toggle("sel", r.dataset.id === cur));
  };

  const openEditor = async () => {
    const cur = getSettings();
    const base = cur.custom ?? (await resolveScheme(cur, effectiveTheme(cur.theme)));
    editor(root, base, rerender);
  };

  const row = (e: Entry): HTMLElement => {
    const r = el("div", "crow");
    r.dataset.id = e.id;
    r.style.height = `${ROW_H}px`;
    const head = el("div", "chead");
    head.append(el("span", "check", "✓"), el("span", "cname", e.name));
    if (e.id === CUSTOM) {
      const b = el("button", "", e.scheme ? t("settings.colors.edit") : t("settings.colors.createCustom"));
      b.type = "button";
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openEditor();
      });
      head.appendChild(b);
    }
    r.appendChild(head);
    if (e.scheme) r.appendChild(schemePreview(e.scheme));
    r.addEventListener("click", () => {
      if (!e.scheme) return; // 아직 만들지 않은 내 색상 구성
      updateSettings({ scheme: e.id });
      applyAppearance();
      markSelected();
    });
    return r;
  };

  // 약 900개를 모두 만들면 느리므로 화면에 보이는 행(과 위아래 여유)만 만든다.
  const render = (force = false) => {
    const [a, b] = visibleRange(list.scrollTop, list.clientHeight, ROW_H, shown.length);
    if (!force && a === start && b === end) return;
    start = a;
    end = b;
    sizer.replaceChildren(
      ...shown.slice(a, b).map((e, i) => {
        const r = row(e);
        r.style.top = `${(a + i) * ROW_H}px`;
        return r;
      }),
    );
    markSelected();
  };

  const filter = (toSelected = false) => {
    const q = search.value.trim().toLowerCase();
    shown = entries.filter((e) => (e.special || mode === "all" || (mode === "light") === e.light) && (!q || e.name.toLowerCase().includes(q)));
    list.scrollTop = 0;
    if (!shown.length) {
      start = end = -1;
      sizer.style.height = "auto";
      sizer.textContent = t("settings.colors.noResult");
      return;
    }
    sizer.style.height = `${shown.length * ROW_H}px`;
    // 처음 열 때는 선택된 항목이 화면 가운데에 오게 스크롤한다.
    const at = toSelected ? shown.findIndex((e) => e.id === getSettings().scheme) : -1;
    if (at >= 0) list.scrollTop = Math.max(0, at * ROW_H - (list.clientHeight - ROW_H) / 2);
    render(true);
  };
  search.addEventListener("input", () => filter());
  list.addEventListener("scroll", () => render());
  filter(true);
}

/** 내 색상 구성 편집: 배경, 글자, 커서, 선택 영역, ANSI 16색을 #RRGGBB로 입력한다. */
function editor(root: HTMLElement, base: Scheme, back: () => void) {
  root.replaceChildren(el("h4", "", t("settings.colors.editorTitle")));
  const fields: { label: string; value: string }[] = [
    { label: t("settings.colors.field.background"), value: base.b },
    { label: t("settings.colors.field.foreground"), value: base.f },
    { label: t("settings.colors.field.cursor"), value: base.c },
    { label: t("settings.colors.field.selection"), value: base.s || mixHex(base.b, base.f, 0.3) },
    ...ANSI_NAMES.map((n, i) => ({ label: t(`settings.ansi.${n}`), value: base.a[i] })),
  ];

  const previewBox = el("div", "pvbox");
  const grid = el("div", "egrid");
  const hexes: HTMLInputElement[] = [];
  const read = (): Scheme | null => {
    const v = hexes.map((h) => normalizeHex(h.value));
    if (v.some((x) => !x)) return null;
    const c = v as string[];
    return { n: CUSTOM, b: c[0], f: c[1], c: c[2], s: c[3], a: c.slice(4) };
  };
  const refreshPreview = () => {
    const s = read();
    if (s) previewBox.replaceChildren(schemePreview(s));
  };

  for (const f of fields) {
    const label = el("label", "erow");
    const picker = el("input");
    picker.type = "color";
    picker.value = f.value;
    const hex = el("input", "hex");
    hex.value = f.value;
    hex.spellcheck = false;
    picker.addEventListener("input", () => {
      hex.value = picker.value;
      hex.classList.remove("bad");
      refreshPreview();
    });
    hex.addEventListener("input", () => {
      const n = normalizeHex(hex.value);
      hex.classList.toggle("bad", !n);
      if (n) picker.value = n;
      refreshPreview();
    });
    hexes.push(hex);
    label.append(picker, el("span", "", f.label), hex);
    grid.appendChild(label);
  }
  refreshPreview();

  const err = el("p", "err");
  const row = el("div", "row");
  const cancel = el("button", "cancel", t("common.cancel"));
  cancel.type = "button";
  cancel.addEventListener("click", back);
  const save = el("button", "ok", t("common.save"));
  save.type = "button";
  save.addEventListener("click", () => {
    const s = read();
    if (!s) {
      hexes.forEach((h) => h.classList.toggle("bad", !normalizeHex(h.value)));
      err.textContent = t("settings.colors.invalidHex");
      return;
    }
    updateSettings({ custom: s, scheme: CUSTOM });
    applyAppearance();
    back();
  });
  row.append(cancel, save);
  root.append(previewBox, grid, err, row);
}
