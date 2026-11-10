// AI 명령 도우미. OpenAI 호환 서버에 질문하고, 답 안의 명령을 터미널에 "입력만" 해 준다 (실행은 사용자가 Enter로 직접 한다).
// 대화는 세션(탭)마다 따로 가진다. 다른 세션으로 옮기면 그 세션의 대화가 보이고, 진행 중이던 답과 명령 실행은 뒤에서 계속된다.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import type { Terminal } from "@xterm/xterm";
import { extractRunCommands, formatResult, parseToolCall, TOOLS, trimHistory, type Outcome, type ToolCall } from "./agent";
import { formatDate, formatStamp, logAi } from "./aiLog";
import { buildSystemPrompt, type PromptMode } from "./aiPrompt";
import { parseSlash, splitBlocks, type Block } from "./aiText";
import { t } from "./i18n";
import { redact } from "./redact";
import { getSettings, updateSettings } from "./settings";
import { confirmBox, modal } from "./ui";

/** AI가 명령을 실행할 수 있는 대상: SSH 탭 하나. cwd는 셸이 알려 준 현재 폴더(모르면 빈 글자). */
export type ExecTarget = { id: string; cwd: () => string; label: string };

export type AiDeps = {
  /** 터미널(id가 없으면 지금 보고 있는 것)과, 모델에게 알려 줄 설명(셸 종류, 접속 대상), SSH 탭이면 명령을 실행할 대상. 닫힌 탭이면 null */
  terminal: (id?: string) => { id: string; term: Terminal; context: string; exec: ExecTarget | null } | null;
  /** 터미널에 붙여넣기 (여러 줄이면 확인을 거친다) */
  paste: (term: Terminal, text: string) => void;
  openSettings: () => void;
  /** AI 패널을 닫고 다른 패널(세션)로 돌아간다 */
  closePanel: () => void;
};

type ToolCallMsg = { id: string; type: "function"; function: { name: string; arguments: string } };
type Msg = { role: "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCallMsg[]; tool_call_id?: string };
type Attachment = { label: string; text: string };
/** 모델이 요청한 명령 하나. error가 있으면 형식이 틀려 실행하지 않는다. */
type Req = { id: string; name: string; args: string; command?: string; error?: string };
type ExecCard = { command: string; setApproval: (req: number, answer: (approve: boolean) => void) => void; done: (o: Outcome) => void; fail: (msg: string) => void };
/** 지금 진행 중인 질문의 명령 실행 상태. 새 대화(/clear)를 하면 세대(gen)가 바뀌어 옛 작업이 기록에 끼어들지 못한다. */
type Agent = { gen: number; mode: PromptMode; step: number; stopped: boolean; nudged?: boolean; target: ExecTarget | null; pendingApproval: number | null; card: ExecCard | null };

/** 세션(탭) 하나의 대화 */
type Chat = {
  id: string;
  /** 이 대화의 말풍선들이 들어가는 칸. 세션을 바꾸면 이 칸이 통째로 교체된다. */
  el: HTMLElement;
  history: Msg[];
  attachments: Attachment[];
  busy: { req: number; text: string; el: HTMLElement; queued: boolean; calls: ToolCall[] } | null;
  /** 질문 하나가 끝날 때까지 true. 모델 답을 받는 중이거나 명령을 실행·승인 대기 중인 동안 포함한다. */
  running: boolean;
  agent: Agent | null;
  gen: number;
};

const LAST_LINES = 50;
const MAX_HISTORY = 20; // 서버로 보내는 최근 대화 수 (너무 길어지지 않게)
const MAX_STEPS = 8; // 질문 하나에서 "명령 실행 → 결과로 다시 묻기"를 되풀이하는 상한
const MAX_CALLS_PER_ROUND = 3; // 모델이 한 번에 여러 명령을 요청해도 이만큼만 처리한다

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

let deps: AiDeps;
const chats = new Map<string, Chat>();
/** 지금 화면에 보이는 대화 (열린 세션이 없으면 null) */
let cur: Chat | null = null;
let reqSeq = 0;
let noteTimer: number | undefined;

const configured = () => {
  const ai = getSettings().ai;
  return !!(ai.url && ai.model);
};

function chatFor(id: string): Chat {
  let c = chats.get(id);
  if (!c) {
    const el = document.createElement("div");
    el.className = "aichat";
    c = { id, el, history: [], attachments: [], busy: null, running: false, agent: null, gen: 0 };
    chats.set(id, c);
  }
  return c;
}

/** 화면에 보일 대화를 바꾼다 */
function switchChat(id: string | null) {
  const next = id ? chatFor(id) : null;
  if (next === cur) return;
  cur = next;
  $("#ai-msgs").replaceChildren(...(cur ? [cur.el] : []));
  renderAttachments();
  syncBusy();
  scrollDown(cur);
}

/** 세션이 닫혔을 때: 그 대화를 멈추고 버린다 */
export function closeChat(id: string) {
  const c = chats.get(id);
  if (!c) return;
  cancel(c);
  c.gen++;
  chats.delete(id);
  if (cur === c) {
    cur = null;
    $("#ai-msgs").replaceChildren();
    renderAttachments();
    syncBusy();
  }
}

/** 설정이나 열린 세션이 바뀌었을 때: 탭, 설정 안내, 입력칸, 보이는 대화를 맞춘다. */
export function refreshAi() {
  // 쓸 수 없는 상태(미사용이거나 서버 주소·모델이 비어 있음)면 탭을 숨긴다. 보고 있던 패널이면 닫고, 진행 중인 답은 멈춘다.
  const ok = configured();
  const enabled = getSettings().ai.enabled;
  const term = deps?.terminal() ?? null; // 열린 세션이 없으면 질문할 터미널이 없다
  const usable = enabled && ok && !!term;
  $<HTMLElement>('.stab[data-pane="ai"]').hidden = !usable;
  if (!enabled || !ok) chats.forEach((c) => cancel(c));
  if (!usable && !$("#ai").hidden) deps.closePanel();
  switchChat(term?.id ?? null);
  $("#ai-hint").hidden = ok;
  $<HTMLTextAreaElement>("#ai-input").disabled = !ok;
  $<HTMLButtonElement>("#ai-send").disabled = !ok;
  $("#ai-tip").hidden = !ok || (cur?.history.length ?? 0) > 0;
  $<HTMLInputElement>("#ai-auto").checked = getSettings().ai.autoScreen;
  $<HTMLButtonElement>("#ai-explain").disabled = !ok;
}

function note(msg: string) {
  clearTimeout(noteTimer);
  $("#ai-note").textContent = msg;
  noteTimer = window.setTimeout(() => ($("#ai-note").textContent = ""), 4000);
}

/** 기록 파일에 쓰지 못했을 때(처음 한 번만) 알린다. 대화는 계속된다. */
function logFailed(message: string) {
  note(t("ai.logFailed", { error: message }));
}

/** 보이는 대화일 때만 맨 아래로 내린다 */
function scrollDown(c: Chat | null) {
  if (!c || c !== cur) return;
  const m = $("#ai-msgs");
  m.scrollTop = m.scrollHeight;
}

// ---------- 화면 만들기 ----------

function bubble(c: Chat, kind: "user" | "assistant" | "error" | "info"): HTMLElement {
  const el = document.createElement("div");
  el.className = `aimsg ${kind}`;
  c.el.appendChild(el);
  return el;
}

function codeBlock(b: Extract<Block, { type: "code" }>): HTMLElement {
  const box = document.createElement("div");
  box.className = "aicode";
  const head = document.createElement("div");
  head.className = "aicode-head";
  const lang = document.createElement("span");
  lang.textContent = b.lang;
  head.appendChild(lang);
  // 끝까지 받은 블록에만 버튼을 둔다 (쓰는 중인 명령을 터미널에 넣지 않게).
  if (b.closed) {
    const toTerm = document.createElement("button");
    toTerm.textContent = t("ai.toTerminal");
    toTerm.className = "ok";
    toTerm.addEventListener("click", () => {
      // 이 대화가 속한 세션에 넣는다 (보이는 대화는 항상 지금 활성 세션의 것이다).
      const c = deps.terminal();
      if (!c) return note(t("ai.noTerminal"));
      // 마지막 줄바꿈은 지워서, 입력만 되고 실행은 되지 않게 한다.
      const command = b.content.replace(/[\r\n]+$/, "");
      logAi({ event: "insert", context: c.context, command }, logFailed);
      deps.paste(c.term, command);
    });
    const copy = document.createElement("button");
    copy.textContent = t("ai.copy");
    copy.addEventListener("click", async () => {
      await writeText(b.content).catch(() => {});
      copy.textContent = t("ai.copied");
      setTimeout(() => (copy.textContent = t("ai.copy")), 1500);
    });
    head.append(toTerm, copy);
  }
  const pre = document.createElement("pre");
  pre.textContent = b.content;
  box.append(head, pre);
  return box;
}

function renderAssistant(el: HTMLElement, text: string) {
  el.replaceChildren(
    ...splitBlocks(text).map((b) => {
      if (b.type === "code") return codeBlock(b);
      const d = document.createElement("div");
      d.className = "aitext";
      d.textContent = b.content.replace(/^\n+|\n+$/g, "");
      return d;
    }),
  );
}

/** 활성 터미널의 최근 출력(가림 처리 후). 터미널이 없거나 비어 있으면 null */
function captureLast(): { text: string; lines: number } | null {
  const c = deps.terminal();
  if (!c) return null;
  const buf = c.term.buffer.active;
  const line = (i: number) => buf.getLine(i)?.translateToString(true) ?? "";
  let last = buf.length - 1;
  while (last >= 0 && !line(last).trim()) last--; // 아래쪽 빈 줄은 건너뛴다
  if (last < 0) return null;
  const first = Math.max(0, last - LAST_LINES + 1);
  const lines: string[] = [];
  for (let i = first; i <= last; i++) lines.push(line(i));
  const text = redact(lines.join("\n")).trim();
  return text ? { text, lines: lines.length } : null;
}

function renderAttachments() {
  const box = $("#ai-attach");
  const chips: HTMLElement[] = [];
  // 화면 자동 포함이 켜져 있으면 항상 보이는 칩. 누르면 지금 보낼 내용을 보여 주고, ✕는 이 기능을 끈다.
  if (getSettings().ai.autoScreen) {
    const chip = document.createElement("span");
    chip.className = "chip auto";
    const label = document.createElement("button");
    label.textContent = t("ai.chipAuto", { lines: LAST_LINES });
    label.title = t("ai.previewTitle");
    label.addEventListener("click", () => {
      const s = captureLast();
      preview({ label: label.textContent ?? "", text: s ? s.text : t("ai.noOutput") });
    });
    const x = document.createElement("button");
    x.textContent = "✕";
    x.addEventListener("click", () => setAutoScreen(false));
    chip.append(label, x);
    chips.push(chip);
  }
  const list = cur?.attachments ?? [];
  box.replaceChildren(
    ...chips,
    ...list.map((a, i) => {
      const chip = document.createElement("span");
      chip.className = "chip";
      const label = document.createElement("button");
      label.textContent = a.label;
      label.title = t("ai.previewTitle");
      label.addEventListener("click", () => preview(a));
      const x = document.createElement("button");
      x.textContent = "✕";
      x.addEventListener("click", () => {
        list.splice(i, 1);
        renderAttachments();
      });
      chip.append(label, x);
      return chip;
    }),
  );
}

/** 첨부 내용(가림 처리 후 실제로 보내질 글)을 보여 준다 */
function preview(a: Attachment) {
  modal((d) => {
    d.className = "aipreview";
    d.innerHTML = `<form method="dialog"><h3></h3><textarea readonly spellcheck="false"></textarea><div class="row"><span></span><button type="submit" class="ok"></button></div></form>`;
    d.querySelector("h3")!.textContent = t("ai.previewTitle");
    (d.querySelector("textarea") as HTMLTextAreaElement).value = a.text;
    d.querySelector("button")!.textContent = t("common.close");
  });
}

// ---------- 첨부 ----------

function attach(label: string, text: string) {
  const red = redact(text).trim();
  if (red && cur) {
    cur.attachments.push({ label, text: red });
    renderAttachments();
  }
}

function attachSelection() {
  const c = deps.terminal();
  if (!c) return note(t("ai.noTerminal"));
  const s = c.term.getSelection();
  if (!s.trim()) return note(t("ai.noSelection"));
  attach(t("ai.chipSelection", { lines: s.split(/\r?\n/).length }), s);
}

function attachLast() {
  if (!deps.terminal() || !cur) return note(t("ai.noTerminal"));
  const s = captureLast();
  if (!s) return note(t("ai.noOutput"));
  cur.attachments.push({ label: t("ai.chipLast", { lines: s.lines }), text: s.text });
  renderAttachments();
}

/** 화면 자동 포함을 켜고 끈다. 켤 때는 질문마다 터미널 내용이 서버로 나간다는 것을 먼저 확인받는다. */
async function setAutoScreen(on: boolean) {
  if (on && !(await confirmBox(t("ai.autoScreenConfirm", { lines: LAST_LINES }), t("ai.autoScreenOn")))) {
    refreshAi(); // 체크박스를 원래대로 되돌린다
    return;
  }
  updateSettings({ ai: { ...getSettings().ai, autoScreen: on } });
  refreshAi();
  renderAttachments();
}

/** 선택한 출력을 첨부해 "설명해 달라"고 바로 묻는다 */
async function explainSelection() {
  const c = deps.terminal();
  if (!c) return note(t("ai.noTerminal"));
  const sel = c.term.getSelection();
  if (!sel.trim()) return note(t("ai.noSelection"));
  if (!cur || cur.running || !configured()) return;
  attach(t("ai.chipSelection", { lines: sel.split(/\r?\n/).length }), sel);
  $<HTMLTextAreaElement>("#ai-input").value = t("ai.explainPrompt");
  await send();
}

// ---------- 보내기 ----------

/** 보내기 버튼을 보이는 대화의 상태에 맞춘다 */
function syncBusy() {
  const on = !!cur?.running;
  const btn = $<HTMLButtonElement>("#ai-send");
  // 진행 중에는 돌아가는 아이콘, 마우스를 올리면 정지 아이콘(누르면 중지)
  btn.innerHTML = on ? '<i class="fas fa-spinner fa-spin"></i><i class="fas fa-stop"></i>' : '<i class="fas fa-paper-plane"></i>';
  btn.title = on ? t("ai.stop") : t("ai.send");
  btn.classList.toggle("stop", on);
}

// ---------- 명령 실행 (SSH 탭) ----------

/** 대화 안의 실행 카드: 명령, 상태, (승인 대기라면 [승인]/[거절]), 접을 수 있는 결과 */
function execCard(c: Chat, command: string): ExecCard {
  const el = document.createElement("div");
  el.className = "aiexec";
  const head = document.createElement("div");
  head.className = "aiexec-head";
  const cmd = document.createElement("code");
  cmd.textContent = `$ ${command}`;
  const status = document.createElement("span");
  status.className = "status";
  status.textContent = t("ai.execRunning");
  head.append(cmd, status);
  const actions = document.createElement("div");
  actions.className = "aiexec-actions";
  const details = document.createElement("details");
  details.hidden = true;
  const summary = document.createElement("summary");
  summary.textContent = t("ai.execResult");
  const pre = document.createElement("pre");
  details.append(summary, pre);
  el.append(head, actions, details);
  c.el.appendChild(el);
  scrollDown(c);

  const set = (text: string, cls: string) => {
    status.textContent = text;
    status.className = `status ${cls}`;
  };
  return {
    command,
    setApproval(_req, answer) {
      set(t("ai.execWaiting"), "wait");
      const approve = document.createElement("button");
      approve.textContent = t("ai.execApprove");
      approve.className = "ok";
      const reject = document.createElement("button");
      reject.textContent = t("ai.execReject");
      reject.className = "cancel";
      const choose = (v: boolean) => {
        actions.replaceChildren();
        set(t(v ? "ai.execRunning" : "ai.execDenied"), v ? "" : "bad");
        answer(v);
      };
      approve.addEventListener("click", () => choose(true));
      reject.addEventListener("click", () => choose(false));
      actions.replaceChildren(reject, approve);
      scrollDown(c);
    },
    done(o) {
      actions.replaceChildren();
      const label = { auto: t("ai.execAuto"), approved: t("ai.execApproved"), denied: t("ai.execDenied"), blocked: t("ai.execBlocked", { reason: o.reason ?? "" }) }[o.decision];
      set(label, o.decision === "blocked" || o.decision === "denied" ? "bad" : "ok");
      if (o.decision === "auto" || o.decision === "approved") {
        pre.textContent = formatResult(o);
        details.hidden = false;
        details.open = (o.exit ?? 0) !== 0 || !!o.timed_out; // 실패했을 때는 결과를 펼쳐 둔다
      }
      scrollDown(c);
    },
    fail(msg) {
      actions.replaceChildren();
      set(t("ai.execError", { error: msg }), "bad");
    },
  };
}

/** 모델의 요청(도구 호출, 또는 ```run 코드 블록)을 명령 목록으로 읽는다 */
function readRequests(mode: PromptMode, text: string, calls: ToolCall[]): Req[] {
  if (mode === "tools") {
    return calls.map((c) => {
      const r = parseToolCall(c);
      return "command" in r ? { id: c.id, name: c.name, args: c.arguments, command: r.command } : { id: c.id, name: c.name, args: c.arguments, error: r.error };
    });
  }
  return extractRunCommands(text).map((r, i) => {
    const args = JSON.stringify("command" in r ? { command: r.command } : {});
    return "command" in r ? { id: `run_${i}`, name: "run_command", args, command: r.command } : { id: `run_${i}`, name: "run_command", args, error: r.error };
  });
}

/** 명령 하나를 실행하고 모델에게 돌려줄 글을 만든다 */
async function runOne(c: Chat, a: Agent, r: Req): Promise<string> {
  if (!r.command) {
    execCard(c, r.args).fail(r.error ?? "");
    return `실행하지 않았습니다: ${r.error}`;
  }
  const card = execCard(c, r.command);
  if (!a.target) {
    card.fail(t("ai.execNoSsh"));
    return "이 탭에서는 명령을 실행할 수 없습니다 (SSH 탭에서만 가능합니다).";
  }
  a.card = card;
  try {
    const now = new Date();
    const o = await invoke<Outcome>("agent_run", {
      id: a.target.id,
      command: r.command,
      cwd: a.target.cwd() || null,
      context: a.target.label,
      stamp: formatStamp(now),
      date: formatDate(now),
    });
    card.done(o);
    return formatResult(o);
  } catch (e) {
    card.fail(String(e));
    return `실행 오류: ${e}`;
  } finally {
    a.card = null;
  }
}

/** 모델이 요청한 명령들을 실행하고, 결과를 대화에 넣어 모델에게 다시 묻는다 */
async function runCalls(c: Chat, a: Agent, b: NonNullable<Chat["busy"]>, requests: Req[]) {
  a.step++;
  const used = requests.slice(0, MAX_CALLS_PER_ROUND);
  // 도구 호출은 "요청"과 "결과"가 짝이어야 서버가 받아들이므로, 처리하는 요청만 대화에 남긴다.
  if (a.mode === "tools") {
    c.history.push({ role: "assistant", content: b.text || null, tool_calls: used.map((r) => ({ id: r.id, type: "function", function: { name: r.name, arguments: r.args } })) });
  } else {
    c.history.push({ role: "assistant", content: b.text });
  }
  const results: string[] = [];
  for (const r of used) {
    if (a.stopped || a.gen !== c.gen) {
      results.push("사용자가 중지했습니다.");
      continue;
    }
    results.push(await runOne(c, a, r));
  }
  if (a.gen !== c.gen) return; // 그 사이에 새 대화로 지워졌다. 옛 결과를 새 대화에 섞지 않는다.
  if (a.mode === "tools") used.forEach((r, i) => c.history.push({ role: "tool", tool_call_id: r.id, content: results[i] }));
  else c.history.push({ role: "user", content: `[실행 결과]\n${used.map((r, i) => `$ ${r.command ?? r.args}\n${results[i]}`).join("\n\n")}` });
  if (a.stopped) return endRun(c);
  await startRound(c);
}

function endRun(c: Chat) {
  c.running = false;
  c.agent = null;
  if (c === cur) syncBusy();
  scrollDown(c);
}

async function finish(c: Chat, error?: string) {
  const b = c.busy;
  if (!b) return;
  c.busy = null;
  renderAssistant(b.el, b.text);
  logAi({ event: "answer", text: b.text, ...(error ? { error } : {}) }, logFailed);
  const a = c.agent;
  // 명령 실행 요청이 있으면 실행하고 결과로 다시 묻는다 (오류 없이 끝났고, 중지되지 않았고, 단계 상한 안일 때)
  if (!error && a && a.mode !== "suggest" && !a.stopped && a.gen === c.gen) {
    const requests = readRequests(a.mode, b.text, b.calls);
    if (requests.length) {
      if (a.step >= MAX_STEPS) {
        if (b.text) c.history.push({ role: "assistant", content: b.text });
        bubble(c, "info").textContent = t("ai.maxSteps", { n: MAX_STEPS });
        return endRun(c);
      }
      if (!b.text) b.el.remove(); // 명령만 요청한 단계의 빈 말풍선
      return void (await runCalls(c, a, b, requests));
    }
  }
  if (b.text) c.history.push({ role: "assistant", content: b.text });
  else b.el.remove();
  // 명령 결과를 받고도 모델이 빈 답을 주면 결과가 사용자에게 전달되지 않는다. 한 번만 정리해 달라고 다시 요청한다.
  if (!error && !b.text && a && a.step > 0 && !a.nudged && !a.stopped && a.gen === c.gen) {
    a.nudged = true;
    c.history.push({ role: "user", content: "위 실행 결과를 바탕으로 사용자 질문에 대한 답을 정리해서 알려 주세요. 더 실행할 명령이 없으면 명령을 요청하지 마세요." });
    return void (await startRound(c));
  }
  if (error) bubble(c, "error").textContent = t("ai.error", { error });
  else if (!b.text && a && a.step > 0) bubble(c, "info").textContent = t("ai.emptyAnswer");
  endRun(c);
}

/** 지금까지의 대화로 모델에게 묻는다. 답은 이벤트(llm-chunk, llm-tools, llm-done)로 온다. */
async function startRound(c: Chat) {
  const a = c.agent;
  if (!a) return;
  const ai = getSettings().ai;
  // 시스템 프롬프트는 소스 코드의 고정 규칙(aiPrompt.ts) + 사용자의 추가 지시문. 고정 규칙은 설정으로 바꿀 수 없다.
  const system = buildSystemPrompt(deps.terminal(c.id)?.context || "unknown", ai.system, a.mode);
  const messages = [{ role: "system", content: system }, ...trimHistory(c.history, MAX_HISTORY)];
  const req = ++reqSeq;
  c.busy = { req, text: "", el: bubble(c, "assistant"), queued: false, calls: [] };
  if (c === cur) syncBusy();
  scrollDown(c);
  try {
    await invoke("llm_stream", { req, url: ai.url, model: ai.model, apiKey: ai.apiKey, messages, tools: a.mode === "tools" ? TOOLS : null });
  } catch (e) {
    await finish(c, String(e));
  }
}

async function send() {
  const c = cur;
  const input = $<HTMLTextAreaElement>("#ai-input");
  const text = input.value.trim();
  const slash = parseSlash(text);
  if (slash) {
    input.value = "";
    return void (await runCommand(slash.name, slash.args));
  }
  if (!c || !text || c.running || !configured()) return;
  const ai = getSettings().ai;

  // 처음 쓰거나 서버 주소를 바꿨으면, 내용이 어디로 가는지 확인받는다.
  if (ai.consent !== ai.url) {
    if (!(await confirmBox(t("ai.consentBody", { url: ai.url }), t("ai.consentOk")))) return;
    updateSettings({ ai: { ...getSettings().ai, consent: ai.url } });
  }
  if (c !== cur || c.running) return; // 확인창이 떠 있는 사이에 세션을 바꾸거나 이미 시작됐다

  // 화면 자동 포함: 보내는 순간의 최근 출력을 가장 먼저 붙인다.
  const screen = ai.autoScreen ? captureLast() : null;
  const all: Attachment[] = [...(screen ? [{ label: t("ai.chipAuto", { lines: screen.lines }), text: screen.text }] : []), ...c.attachments];
  const attached = all.map((a) => `[${a.label}]\n\`\`\`\n${a.text}\n\`\`\``).join("\n\n");
  const content = attached ? `${text}\n\n${attached}` : text;
  c.history.push({ role: "user", content });
  const term = deps.terminal(c.id);
  logAi({ event: "question", context: term?.context ?? "", model: ai.model, text, attachments: all }, logFailed);
  const shown = bubble(c, "user");
  shown.textContent = all.length ? `${text}\n${all.map((a) => `📎 ${a.label}`).join("\n")}` : text;
  c.attachments = [];
  renderAttachments();
  input.value = "";
  $("#ai-tip").hidden = true;

  // 명령 실행은 설정이 켜져 있고 이 대화의 세션이 SSH일 때만 한다. 그 밖에는 지금까지처럼 제안만 한다.
  const target = term?.exec ?? null;
  const mode: PromptMode = ai.exec && target ? (ai.tools ? "tools" : "fence") : "suggest";
  if (ai.exec && !target) {
    bubble(c, "info").textContent = t("ai.execNoSsh");
  }
  c.running = true;
  c.agent = { gen: c.gen, mode, step: 0, stopped: false, target, pendingApproval: null, card: null };
  await startRound(c);
}

/** 중지: 받는 중인 답을 끊고, 승인을 기다리는 명령은 거절하고, 이어질 단계를 멈춘다 */
function cancel(c: Chat | null) {
  if (!c) return;
  if (c.agent) {
    c.agent.stopped = true;
    if (c.agent.pendingApproval !== null) {
      invoke("agent_answer", { req: c.agent.pendingApproval, approve: false }).catch(() => {});
      c.agent.pendingApproval = null;
    }
  }
  if (c.busy) invoke("llm_cancel", { req: c.busy.req }).catch(() => {});
}

/** 채팅창에서 쓰는 /명령. 서버로 보내지 않고 앱 안에서만 처리한다. */
const COMMANDS: Record<string, { help: string; run: (args: string[]) => void | Promise<void> }> = {
  clear: { help: "ai.cmdClear", run: () => newChat() },
  help: { help: "ai.cmdHelp", run: () => showHelp() },
  screen: {
    help: "ai.cmdScreen",
    run: async (args) => {
      const now = getSettings().ai.autoScreen;
      const want = args[0] === "on" ? true : args[0] === "off" ? false : !now; // 인자가 없으면 반대로
      if (want !== now) await setAutoScreen(want);
      if (!cur) return;
      bubble(cur, "info").textContent = t(getSettings().ai.autoScreen ? "ai.screenIsOn" : "ai.screenIsOff");
      scrollDown(cur);
    },
  },
  selection: { help: "ai.cmdSelection", run: () => attachSelection() },
  recent: { help: "ai.cmdRecent", run: () => attachLast() },
  explain: { help: "ai.cmdExplain", run: () => explainSelection() },
};

function showHelp() {
  if (!cur) return;
  bubble(cur, "info").textContent = [t("ai.cmdHelpTitle"), ...Object.entries(COMMANDS).map(([name, c]) => `/${name} — ${t(c.help)}`)].join("\n");
  scrollDown(cur);
}

async function runCommand(name: string, args: string[]) {
  const cmd = COMMANDS[name];
  if (!cmd) {
    if (cur) {
      bubble(cur, "info").textContent = t("ai.cmdUnknown", { name });
      scrollDown(cur);
    }
    return;
  }
  $("#ai-tip").hidden = true;
  await cmd.run(args);
}

/** 지금 보이는 대화를 지우고 새로 시작한다 (다른 세션의 대화는 그대로) */
function newChat() {
  const c = cur;
  if (!c) return;
  cancel(c);
  c.gen++; // 진행 중이던 작업의 뒤늦은 결과가 새 대화에 끼어들지 못하게 한다
  c.running = false;
  c.agent = null;
  c.busy = null;
  c.history.length = 0;
  c.attachments = [];
  c.el.replaceChildren();
  syncBusy();
  renderAttachments();
  refreshAi();
}

const byReq = (req: number) => [...chats.values()].find((c) => c.busy?.req === req);

export function initAi(d: AiDeps) {
  deps = d;
  const input = $<HTMLTextAreaElement>("#ai-input");
  $("#ai-send").addEventListener("click", () => (cur?.running ? cancel(cur) : send()));
  $("#ai-new").addEventListener("click", newChat);
  $("#ai-attach-sel").addEventListener("click", attachSelection);
  $("#ai-attach-last").addEventListener("click", attachLast);
  $("#ai-auto").addEventListener("change", (e) => setAutoScreen((e.target as HTMLInputElement).checked));
  $("#ai-explain").addEventListener("click", explainSelection);
  $("#ai-open-settings").addEventListener("click", () => deps.openSettings());
  // Enter는 전송, Shift+Enter는 줄바꿈. 한글 조합 중의 Enter(글자 확정)는 전송으로 보지 않는다.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  // 답은 조각으로 오므로, 화면 갱신은 프레임마다 한 번만 한다.
  listen<{ req: number; text: string }>("llm-chunk", (e) => {
    const c = byReq(e.payload.req);
    const b = c?.busy;
    if (!c || !b) return;
    b.text += e.payload.text;
    if (!b.queued) {
      b.queued = true;
      requestAnimationFrame(() => {
        b.queued = false;
        if (c.busy !== b) return;
        renderAssistant(b.el, b.text);
        scrollDown(c);
      });
    }
  }).catch(() => {});
  listen<{ req: number; calls: ToolCall[] }>("llm-tools", (e) => {
    const b = byReq(e.payload.req)?.busy;
    if (b) b.calls = e.payload.calls;
  }).catch(() => {});
  // 승인이 필요한 명령: 그 명령을 실행 중인 대화의 카드에 [승인]/[거절]을 띄운다. 보여 주는 명령은 백엔드가 실제로 실행할 글 그대로다.
  listen<{ req: number; command: string }>("agent-approve", (e) => {
    const c = [...chats.values()].find((x) => x.agent?.card && x.agent.pendingApproval === null && x.agent.card.command === e.payload.command);
    const a = c?.agent;
    const card = a?.card;
    if (!c || !a || !card) {
      invoke("agent_answer", { req: e.payload.req, approve: false }).catch(() => {});
      return;
    }
    a.pendingApproval = e.payload.req;
    card.setApproval(e.payload.req, (ok) => {
      a.pendingApproval = null;
      invoke("agent_answer", { req: e.payload.req, approve: ok }).catch(() => {});
    });
  }).catch(() => {});
  listen<{ req: number }>("llm-done", (e) => {
    const c = byReq(e.payload.req);
    if (c) void finish(c);
  }).catch(() => {});
  listen<{ req: number; error: string }>("llm-error", (e) => {
    const c = byReq(e.payload.req);
    if (c) void finish(c, e.payload.error);
  }).catch(() => {});

  syncBusy();
  refreshAi();
  renderAttachments();
}
