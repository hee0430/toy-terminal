import { invoke } from "@tauri-apps/api/core";
import { applyStatic, t } from "./i18n";
import { pickIcon } from "./iconPicker";
import { iconNode, type ProfileIcon } from "./icons";
import { ask, confirmBox, modal, pickKeyFile, shieldIcon, showMenu } from "./ui";
import { parseSshConfig } from "./sshConfig";
import { parseForward, parseForwards, type Forward } from "./sshForward";
import { deleteSecrets, hasSecret, saveSecret, vaultStatus } from "./vault";

export type Kind = "pwsh" | "powershell" | "cmd" | "ssh";

export type Profile = {
  id: string;
  type: "profile";
  name: string;
  kind: Kind;
  // 로컬 셸 전용. true면 UAC 승인 후 관리자 권한으로 실행한다.
  admin?: boolean;
  // ssh 전용. 비밀번호는 이 파일에 쓰지 않는다 (저장하면 secrets.json에 마스터 비밀번호로 암호화해 둔다).
  host?: string;
  port?: number;
  user?: string;
  key_path?: string;
  /** true면 키 파일로, false면 비밀번호로 인증. 없으면 key_path 유무로 판단(구버전 호환). */
  use_key?: boolean;
  /** 사용자가 고른 아이콘. 없으면 종류별 기본 이모지. */
  icon?: ProfileIcon;
  /** ssh 전용. 포트 포워딩, 한 줄에 하나 (예: "-L 8080:localhost:80") */
  forwards?: string[];
};

export type Folder = { id: string; type: "folder"; name: string; open: boolean; children: TreeNode[] };
export type TreeNode = Profile | Folder;

const uid = () => crypto.randomUUID();
// 제품 이름이라 번역하지 않는다.
const KIND_LABEL: Record<Kind, string> = { pwsh: "PowerShell 7", powershell: "Windows PowerShell", cmd: "cmd", ssh: "SSH" };
const defaultEmoji = (kind: Kind) => (kind === "ssh" ? "🔐" : "💻");

let root: Folder = { id: "root", type: "folder", name: "", open: true, children: [] };
let onConnect: (p: Profile) => void = () => {};

const treeEl = () => document.querySelector("#ptree") as HTMLElement;

export function showStatus(msg: string) {
  (document.querySelector("#pstatus") as HTMLElement).textContent = msg;
}

/** 언어가 바뀌면 툴팁 같은 문구를 다시 그린다. */
export const rerenderProfiles = () => render();

// ---------- 트리 조작 ----------

function find(folder: Folder, id: string): { parent: Folder; index: number } | null {
  for (let i = 0; i < folder.children.length; i++) {
    const n = folder.children[i];
    if (n.id === id) return { parent: folder, index: i };
    if (n.type === "folder") {
      const r = find(n, id);
      if (r) return r;
    }
  }
  return null;
}

const getNode = (id: string) => {
  const loc = find(root, id);
  return loc ? loc.parent.children[loc.index] : null;
};

/** folder 자신 또는 그 하위에 id가 있는가 */
function contains(folder: Folder, id: string): boolean {
  return folder.id === id || folder.children.some((c) => (c.type === "folder" ? contains(c, id) : c.id === id));
}

/** 기준 노드의 앞이나 뒤로 옮긴다. 기준 노드가 있는 폴더 안의 같은 줄로 들어간다. */
function moveRelative(id: string, refId: string, pos: "before" | "after") {
  const ref = find(root, refId);
  if (!ref || id === refId) return;
  const siblings = ref.parent.children;
  const i = siblings.findIndex((c) => c.id === refId);
  // "뒤"는 기준 노드의 다음 형제 앞이다. 다음 형제가 없으면 맨 끝.
  move(id, ref.parent, pos === "before" ? refId : siblings[i + 1]?.id);
}

/** target 폴더 안으로 옮긴다. beforeId가 있으면 그 노드 앞에, 없으면 맨 끝에. */
function move(id: string, target: Folder, beforeId?: string) {
  const node = getNode(id);
  if (!node || id === beforeId) return;
  // 폴더를 자기 자신이나 자기 하위로 옮기면 트리가 끊긴다.
  if (node.type === "folder" && contains(node, target.id)) return;
  const loc = find(root, id)!;
  loc.parent.children.splice(loc.index, 1);
  const idx = beforeId ? target.children.findIndex((c) => c.id === beforeId) : -1;
  if (idx >= 0) target.children.splice(idx, 0, node);
  else target.children.push(node);
  target.open = true;
  persist();
}

async function remove(id: string) {
  const loc = find(root, id);
  if (!loc) return;
  const n = loc.parent.children[loc.index];
  const msg =
    n.type === "folder" && n.children.length
      ? t("delete.confirmWithChildren", { name: n.name, count: countProfiles(n) })
      : t("delete.confirm", { name: n.name });
  if (!(await confirmBox(msg))) return;
  loc.parent.children.splice(loc.index, 1);
  persist();
  deleteSecrets(profileIds(n));
}

/** 노드 안(폴더면 하위 전부)의 프로필 id */
function profileIds(n: TreeNode): string[] {
  return n.type === "folder" ? n.children.flatMap(profileIds) : [n.id];
}

function countProfiles(f: Folder): number {
  return f.children.reduce((s, c) => s + (c.type === "folder" ? countProfiles(c) : 1), 0);
}

// ---------- 저장 / 불러오기 ----------

function persist() {
  render();
  invoke("profiles_save", { json: JSON.stringify(root, null, 2) }).catch((e) => showStatus(t("profile.saveFailed", { error: String(e) })));
}

function defaultTree(): Folder {
  const mk = (name: string, kind: Kind): Profile => ({ id: uid(), type: "profile", name, kind });
  return {
    id: "root",
    type: "folder",
    name: "",
    open: true,
    children: [
      {
        id: uid(),
        type: "folder",
        name: "Local",
        open: true,
        children: [mk("PowerShell 7", "pwsh"), mk("Windows PowerShell", "powershell"), mk("cmd", "cmd")],
      },
    ],
  };
}

// ---------- 편집 다이얼로그 ----------

/** 편집 결과. secret은 새로 저장할 비밀번호(비어 있으면 없음), clearSecret은 저장된 비밀번호 삭제 */
type EditResult = { profile: Profile; secret: string; clearSecret: boolean };

function editProfile(p?: Profile): Promise<EditResult | null> {
  return new Promise((resolve) => {
    let result: EditResult | null = null;
    const dlg = modal((d) => {
      d.innerHTML = `<form method="dialog"><h3></h3>
        <label><span data-i18n="profile.field.name"></span> <input name="name" required /></label>
        <label><span data-i18n="profile.field.kind"></span> <select name="kind">${(Object.keys(KIND_LABEL) as Kind[])
          .map((k) => `<option value="${k}">${KIND_LABEL[k]}</option>`)
          .join("")}</select></label>
        <div class="iconrow"><span data-i18n="profile.field.icon"></span>
          <span class="pick"><span class="icoprev"></span><button type="button" class="ico-change" data-i18n="common.change"></button></span>
        </div>
        <div class="local-only">
          <label class="chk"><input name="admin" type="checkbox" /> <span data-i18n="profile.field.admin"></span></label>
        </div>
        <div class="ssh-only">
          <label><span data-i18n="profile.field.host"></span> <input name="host" /></label>
          <label><span data-i18n="profile.field.port"></span> <input name="port" type="number" value="22" /></label>
          <label class="chk"><input name="save_user" type="checkbox" checked /> <span data-i18n="profile.field.saveUser"></span></label>
          <div class="user-box">
            <label><span data-i18n="profile.field.user"></span> <input name="user" /></label>
          </div>
          <label><span class="secret-label" data-i18n="profile.field.secret"></span> <input name="secret" type="password" autocomplete="new-password" /></label>
          <p class="hint secret-hint"></p>
          <label class="chk secret-clear" hidden><input name="clear_secret" type="checkbox" /> <span data-i18n="profile.secretClear"></span></label>
          <label class="chk"><input name="use_key" type="checkbox" /> <span data-i18n="profile.field.useKey"></span></label>
          <div class="key-box" hidden>
            <label><span data-i18n="profile.field.keyFile"></span>
              <span class="pick"><input name="key_path" data-i18n-placeholder="profile.keyPlaceholder" /><button type="button" class="browse" data-i18n="profile.browse"></button></span>
            </label>
          </div>
          <div class="fieldhead"><span data-i18n="profile.field.forwards"></span><button type="button" class="help" data-i18n-title="profile.helpTitle">?</button><button type="button" class="fw-add" data-i18n="profile.forwardAdd"></button></div>
          <p class="hint forwards-help" data-i18n="profile.forwardsHint" hidden></p>
          <div class="fw-list"></div>
        </div>
        <p class="err"></p>
        <div class="row"><button type="button" class="cancel" data-i18n="common.cancel"></button><button type="submit" class="ok" data-i18n="common.save"></button></div></form>`;
      applyStatic(d);
      d.querySelector("h3")!.textContent = p ? t("profile.editTitle") : t("profile.newTitle");
      const form = d.querySelector("form")!;
      const f = (n: string) => form.elements.namedItem(n) as HTMLInputElement;
      d.classList.add("profiledlg");
      const fwList = d.querySelector(".fw-list") as HTMLElement;
      const addForwardRow = (fw?: Forward) => {
        const row = document.createElement("div");
        row.className = "fw-row";
        const kind = document.createElement("select");
        kind.className = "fw-kind";
        kind.add(new Option(t("profile.forwardLocal"), "L"));
        kind.add(new Option(t("profile.forwardRemote"), "R"));
        kind.value = fw?.remote ? "R" : "L";
        const input = (cls: string, type: string, placeholder: string, value: string) => {
          const i = document.createElement("input");
          i.className = cls;
          i.type = type;
          i.placeholder = placeholder;
          i.value = value;
          i.spellcheck = false;
          return i;
        };
        const allLabel = document.createElement("label");
        allLabel.className = "chk fw-all";
        const allBox = document.createElement("input");
        allBox.type = "checkbox";
        allBox.className = "fw-allbox";
        allBox.checked = !!fw?.all;
        allLabel.append(allBox, document.createTextNode(" " + t("profile.forwardAll")));
        // 서버 쪽 접속 범위는 서버 설정이 정하므로 원격 행에서는 이 옵션을 보이지 않는다.
        const syncAll = () => {
          allLabel.hidden = kind.value === "R";
          if (allLabel.hidden) allBox.checked = false;
        };
        kind.addEventListener("change", syncAll);
        syncAll();
        const del = document.createElement("button");
        del.type = "button";
        del.className = "fw-del";
        del.textContent = "✕";
        del.title = t("common.delete");
        del.addEventListener("click", () => row.remove());
        row.append(
          kind,
          input("fw-listen", "number", t("profile.forwardListen"), fw ? String(fw.listen_port) : ""),
          document.createTextNode("→"),
          input("fw-host", "text", t("profile.forwardHost"), fw?.host ?? "localhost"),
          document.createTextNode(":"),
          input("fw-port", "number", t("profile.forwardPort"), fw ? String(fw.port) : ""),
          del,
          allLabel,
        );
        fwList.append(row);
      };
      for (const l of p?.forwards ?? []) {
        const fw = parseForward(l);
        if (fw) addForwardRow(fw);
      }
      d.querySelector(".fw-add")!.addEventListener("click", () => addForwardRow());
      const forwardsHelp = d.querySelector(".forwards-help") as HTMLElement;
      d.querySelector(".help")!.addEventListener("click", () => (forwardsHelp.hidden = !forwardsHelp.hidden)); // 긴 설명은 ? 를 눌렀을 때만 보인다
      const saved = !!p && hasSecret(p.id);
      (d.querySelector(".secret-hint") as HTMLElement).textContent = saved ? t("profile.secretSaved") : t("profile.secretHint");
      (d.querySelector(".secret-clear") as HTMLElement).hidden = !saved;
      const sshBox = d.querySelector(".ssh-only") as HTMLElement;
      const localBox = d.querySelector(".local-only") as HTMLElement;
      const iconPrev = d.querySelector(".icoprev") as HTMLElement;
      let icon: ProfileIcon | undefined = p?.icon;
      const refreshIcon = () => iconPrev.replaceChildren(iconNode(icon, defaultEmoji(f("kind").value as Kind)));
      const sync = () => {
        const ssh = f("kind").value === "ssh";
        sshBox.hidden = !ssh;
        localBox.hidden = ssh;
        refreshIcon();
      };

      if (p) {
        f("name").value = p.name;
        f("kind").value = p.kind;
        f("admin").checked = !!p.admin;
        f("host").value = p.host ?? "";
        f("port").value = String(p.port ?? 22);
        f("user").value = p.user ?? "";
        f("save_user").checked = !!p.user; // 계정이 없던 프로필은 접속할 때 묻는 쪽으로 보여 준다
        f("key_path").value = p.key_path ?? "";
        // 예전에 저장된 프로필은 use_key가 없으므로 키 경로 유무로 판단한다.
        f("use_key").checked = p.use_key ?? !!p.key_path;
        // 이미 만든 프로필은 종류를 바꿀 수 없다 (종류마다 필요한 항목이 달라 값이 섞이기 때문).
        f("kind").disabled = true;
      } else {
        f("kind").value = "ssh";
      }
      const keyBox = d.querySelector(".key-box") as HTMLElement;
      const secretLabel = d.querySelector(".secret-label") as HTMLElement;
      const syncKey = () => {
        const useKey = f("use_key").checked;
        keyBox.hidden = !useKey;
        secretLabel.textContent = useKey ? t("profile.field.secretKey") : t("profile.field.secret"); // 키를 쓰면 이 칸은 키 파일 암호
      };
      const userBox = d.querySelector(".user-box") as HTMLElement;
      const syncUser = () => (userBox.hidden = !f("save_user").checked);
      sync();
      syncKey();
      syncUser();
      f("save_user").addEventListener("change", syncUser);
      f("kind").addEventListener("change", sync);
      f("use_key").addEventListener("change", syncKey);
      d.querySelector(".ico-change")!.addEventListener("click", async () => {
        const r = await pickIcon();
        if (!r) return;
        icon = r.icon ?? undefined;
        refreshIcon();
      });
      d.querySelector(".browse")!.addEventListener("click", async () => {
        const path = await pickKeyFile();
        if (path) f("key_path").value = path;
      });
      d.querySelector(".cancel")!.addEventListener("click", () => d.close());

      form.addEventListener("submit", (ev) => {
        const kind = f("kind").value as Kind;
        if (kind === "ssh" && (!f("host").value.trim() || (f("save_user").checked && !f("user").value.trim()))) {
          ev.preventDefault();
          (d.querySelector(".err") as HTMLElement).textContent = t("profile.err.sshNeeds");
          return;
        }
        if (kind === "ssh" && f("use_key").checked && !f("key_path").value.trim()) {
          ev.preventDefault();
          (d.querySelector(".err") as HTMLElement).textContent = t("profile.err.keyNeeds");
          return;
        }
        // 아무것도 안 적은 행은 건너뛰고, 나머지는 한 줄 문법으로 바꿔 검사한다.
        const forwardLines: string[] = [];
        if (kind === "ssh") {
          for (const row of Array.from(fwList.querySelectorAll<HTMLElement>(".fw-row"))) {
            const v = (c: string) => row.querySelector<HTMLInputElement>(c)!.value.trim();
            if (!v(".fw-listen") && !v(".fw-port")) continue;
            const all = row.querySelector<HTMLInputElement>(".fw-allbox")!.checked ? "0.0.0.0:" : "";
            forwardLines.push(`-${row.querySelector<HTMLSelectElement>(".fw-kind")!.value} ${all}${v(".fw-listen")}:${v(".fw-host")}:${v(".fw-port")}`);
          }
          const fw = parseForwards(forwardLines.join("\n"));
          if ("badLine" in fw) {
            ev.preventDefault();
            (d.querySelector(".err") as HTMLElement).textContent = t("profile.err.forwardLine", { line: fw.badLine });
            return;
          }
        }
        const profile: Profile = {
          id: p?.id ?? uid(),
          type: "profile",
          name: f("name").value.trim(),
          kind,
          ...(icon ? { icon } : {}),
          ...(kind !== "ssh" && f("admin").checked ? { admin: true } : {}),
          ...(kind === "ssh"
            ? {
                host: f("host").value.trim(),
                port: Number(f("port").value) || 22,
                // 체크를 끄면 계정은 저장하지 않고 접속할 때 묻는다.
                user: f("save_user").checked ? f("user").value.trim() : undefined,
                use_key: f("use_key").checked,
                // 체크를 꺼도 경로는 남겨 두어 다시 켤 때 재선택하지 않게 한다.
                key_path: f("key_path").value.trim() || undefined,
                forwards: forwardLines.length ? forwardLines : undefined,
              }
            : {}),
        };
        result = { profile, secret: kind === "ssh" ? f("secret").value : "", clearSecret: f("clear_secret").checked };
      });
    });
    dlg.addEventListener("close", () => resolve(result));
  });
}

/** 편집창에서 입력한 비밀번호를 저장하거나 지운다. 마스터 비밀번호 입력을 취소하면 프로필만 저장된 채 안내한다. */
async function applySecret(id: string, r: EditResult) {
  try {
    if (r.clearSecret) await deleteSecrets([id]);
    if (r.secret && !(await saveSecret(id, r.secret))) showStatus(t("vault.notSaved"));
  } catch (e) {
    showStatus(t("vault.saveFailed", { error: String(e) }));
  }
}

async function addProfile(parent: Folder) {
  const r = await editProfile();
  if (!r) return;
  parent.children.push(r.profile);
  parent.open = true;
  persist();
  await applySecret(r.profile.id, r);
}

async function addFolder(parent: Folder) {
  const name = await ask(t("folder.newTitle"), t("common.name"));
  if (!name?.trim()) return;
  parent.children.push({ id: uid(), type: "folder", name: name.trim(), open: true, children: [] });
  parent.open = true;
  persist();
}

async function edit(n: TreeNode) {
  if (n.type === "folder") {
    const name = await ask(t("folder.renameTitle"), t("common.name"), { value: n.name });
    if (!name?.trim()) return;
    n.name = name.trim();
  } else {
    const r = await editProfile(n);
    if (!r) return;
    Object.assign(n, { admin: undefined, host: undefined, port: undefined, user: undefined, key_path: undefined, use_key: undefined, icon: undefined, forwards: undefined }, r.profile);
    persist();
    await applySecret(n.id, r);
    return;
  }
  persist();
}

// ---------- 끌어서 옮기기 ----------
// Tauri의 파일 드롭(탐색기에서 SFTP로 업로드)을 쓰려면 창 단위 드롭 처리를 켜야 하고, 그러면 Windows에서는 HTML5 드래그앤드롭이
// 동작하지 않는다. 그래서 트리 끌기는 포인터 이벤트로 직접 구현한다.

type Zone = "before" | "inside" | "first" | "after";
type DropTarget = { kind: "row"; node: TreeNode; row: HTMLElement; zone: Zone } | { kind: "root" } | null;

let drag: { id: string; x: number; y: number; active: boolean; ghost: HTMLElement | null } | null = null;
let justDragged = false;

/** 행의 어디에 놓느냐로 결과가 달라진다: 위쪽 = 그 항목 앞, 아래쪽 = 그 항목 뒤, 폴더 가운데 = 폴더 안 맨 끝.
 *  펼쳐진 폴더의 아래쪽은 "뒤"가 아니라(자식들 아래가 되어 선 위치가 어긋남) 폴더 안 맨 앞("first")이다. */
function zoneFor(node: TreeNode, row: HTMLElement, clientY: number): Zone {
  const r = row.getBoundingClientRect();
  const f = (clientY - r.top) / r.height;
  if (node.type !== "folder") return f < 0.5 ? "before" : "after";
  if (f < 0.25) return "before";
  if (f > 0.75) return node.open && node.children.length ? "first" : "after";
  return "inside";
}

function targetAt(x: number, y: number): DropTarget {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const tree = treeEl();
  const row = el?.closest<HTMLElement>(".prow");
  if (row && tree.contains(row)) {
    const node = getNode(row.dataset.id ?? "");
    if (node) return { kind: "row", node, row, zone: zoneFor(node, row, y) };
  }
  return el && tree.contains(el) ? { kind: "root" } : null; // 트리 빈 공간 = 최상위 맨 끝
}

function clearDropMarks() {
  const tree = treeEl();
  tree.querySelectorAll(".over, .drop-before, .drop-after").forEach((x) => x.classList.remove("over", "drop-before", "drop-after"));
  tree.classList.remove("over-root");
}

function markDrop(t: DropTarget) {
  clearDropMarks();
  if (!t) return;
  if (t.kind === "root") treeEl().classList.add("over-root");
  else t.row.classList.add(t.zone === "inside" ? "over" : t.zone === "before" ? "drop-before" : "drop-after"); // first도 헤더 바로 아래에 선
}

function applyDrop(id: string, t: DropTarget) {
  if (!t) return;
  if (t.kind === "root") move(id, root);
  else if (t.node.type === "folder" && t.zone === "inside") move(id, t.node);
  else if (t.node.type === "folder" && t.zone === "first") move(id, t.node, t.node.children[0].id);
  else moveRelative(id, t.node.id, t.zone === "after" ? "after" : "before");
}

function endDrag() {
  drag?.ghost?.remove();
  drag = null;
  document.body.classList.remove("dragging-tree");
  clearDropMarks();
}

let treeDragReady = false;
function initTreeDrag() {
  if (treeDragReady) return;
  treeDragReady = true;
  window.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (!drag.active) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return; // 클릭과 구분하려고 조금 움직인 뒤에 끌기로 본다
      const node = getNode(drag.id);
      if (!node) return endDrag();
      drag.active = true;
      drag.ghost = document.createElement("div");
      drag.ghost.className = "dragghost";
      drag.ghost.textContent = node.name;
      document.body.append(drag.ghost);
      document.body.classList.add("dragging-tree");
    }
    drag.ghost!.style.left = `${e.clientX}px`;
    drag.ghost!.style.top = `${e.clientY}px`;
    markDrop(targetAt(e.clientX, e.clientY));
  });
  window.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const { id, active } = drag;
    const t = active ? targetAt(e.clientX, e.clientY) : null;
    endDrag();
    if (!active) return;
    justDragged = true; // 이어서 오는 click이 폴더 열기/닫기로 처리되지 않게 한다
    setTimeout(() => (justDragged = false), 0);
    applyDrop(id, t);
  });
  window.addEventListener("keydown", (e) => e.key === "Escape" && endDrag());
  window.addEventListener("blur", endDrag);
}

// ---------- 렌더링 ----------

function renderNode(n: TreeNode): HTMLElement {
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "prow";
  row.dataset.id = n.id;

  const label = document.createElement("span");
  label.className = "pname";
  label.textContent = n.name;
  let icon: HTMLElement;
  if (n.type === "folder") {
    icon = document.createElement("span");
    icon.textContent = n.open ? "▾ 📂" : "▸ 📁";
  } else {
    icon = iconNode(n.icon, defaultEmoji(n.kind));
  }
  if (n.type === "profile" && n.admin) label.append(shieldIcon());
  row.append(icon, label);

  row.addEventListener("click", () => {
    if (justDragged) return; // 끌어서 놓은 직후의 클릭은 폴더 열기/닫기로 보지 않는다
    if (n.type === "folder") {
      n.open = !n.open;
      persist();
    }
  });
  row.addEventListener("dblclick", () => n.type === "profile" && onConnect(n));
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showMenu(
      e.clientX,
      e.clientY,
      n.type === "folder"
        ? [
            { label: t("tree.addSession"), fn: () => addProfile(n) },
            { label: t("tree.addFolder"), fn: () => addFolder(n) },
            { label: t("tree.edit"), fn: () => edit(n), sep: true },
            { label: t("tree.delete"), fn: () => remove(n.id), sep: true },
          ]
        : [
            { label: t("tree.connect"), fn: () => onConnect(n) },
            { label: t("tree.edit"), fn: () => edit(n), sep: true },
            { label: t("tree.delete"), fn: () => remove(n.id), sep: true },
          ],
    );
  });

  // 끌기 시작 후보. 실제 이동은 initTreeDrag()의 창 단위 포인터 이벤트가 처리한다.
  row.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = { id: n.id, x: e.clientX, y: e.clientY, active: false, ghost: null };
  });

  li.appendChild(row);
  if (n.type === "folder" && n.open) {
    const ul = document.createElement("ul");
    n.children.forEach((c) => ul.appendChild(renderNode(c)));
    li.appendChild(ul);
  }
  return li;
}

// ---------- 로컬 세션 (~/.ssh/config) ----------
// 이 PC의 OpenSSH 설정을 읽기 전용으로 보여 준다. 프로필 파일에는 저장하지 않고, 편집·삭제·끌기도 되지 않는다.

let localSessions: Profile[] = [];
let localOpen = true;

async function loadLocalSessions() {
  try {
    const text = await invoke<string | null>("ssh_config_load");
    localSessions = parseSshConfig(text ?? "").map((e) => ({
      id: `sshconfig:${e.name}`,
      type: "profile",
      name: e.name,
      kind: "ssh",
      host: e.host,
      port: e.port,
      user: e.user,
      key_path: e.keyPath,
      use_key: !!e.keyPath,
    }));
  } catch (e) {
    localSessions = [];
    showStatus(t("profile.sshConfigFailed", { error: String(e) }));
  }
  render();
}

function renderLocalSessions(): HTMLElement | null {
  if (!localSessions.length) return null;
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "prow";
  const icon = document.createElement("span");
  icon.textContent = localOpen ? "▾ 📂" : "▸ 📁";
  const label = document.createElement("span");
  label.className = "pname";
  label.textContent = t("tree.localSessions");
  row.append(icon, label);
  row.addEventListener("click", () => {
    localOpen = !localOpen;
    render();
  });
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showMenu(e.clientX, e.clientY, [{ label: t("tree.refresh"), fn: () => loadLocalSessions() }]);
  });
  li.appendChild(row);
  if (localOpen) {
    const ul = document.createElement("ul");
    for (const p of localSessions) {
      const item = document.createElement("li");
      const r = document.createElement("div");
      r.className = "prow";
      const name = document.createElement("span");
      name.className = "pname";
      name.textContent = p.name;
      name.title = `${p.user ? p.user + "@" : ""}${p.host}${p.port ? ":" + p.port : ""}`;
      r.append(iconNode(undefined, defaultEmoji("ssh")), name);
      r.addEventListener("dblclick", () => onConnect(p));
      r.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        showMenu(e.clientX, e.clientY, [{ label: t("tree.connect"), fn: () => onConnect(p) }]);
      });
      item.appendChild(r);
      ul.appendChild(item);
    }
    li.appendChild(ul);
  }
  return li;
}

function render() {
  const local = renderLocalSessions();
  treeEl().replaceChildren(...root.children.map(renderNode), ...(local ? [local] : []));
}

// ---------- 초기화 ----------

export async function initProfiles(connect: (p: Profile) => void) {
  onConnect = connect;

  try {
    const json = await invoke<string | null>("profiles_load");
    root = json ? (JSON.parse(json) as Folder) : defaultTree();
    if (!json) persist();
  } catch (e) {
    showStatus(t("profile.loadFailed", { error: String(e) }));
    root = defaultTree();
  }
  render();
  loadLocalSessions();
  vaultStatus().catch(() => {});

  // 트리 빈 공간 우클릭은 최상위에 추가
  const tree = treeEl();
  tree.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showMenu(e.clientX, e.clientY, [
      { label: t("tree.addSession"), fn: () => addProfile(root) },
      { label: t("tree.addFolder"), fn: () => addFolder(root) },
    ]);
  });

  initTreeDrag();
}
