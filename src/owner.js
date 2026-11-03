import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================
//  主人审批队列：好友申请 / 群邀请 / 空间等权限申请
//  所有申请先报给主人，主人 /approve 或 /deny
// ============================================================

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dir, "..", "data", "owner", "pending.json");
const MAX_ITEMS = 100;

function load() {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function save(list) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list.slice(-MAX_ITEMS), null, 2));
}

export function addPending(item) {
  const list = load();
  const id = list.reduce((m, x) => Math.max(m, Number(x.id) || 0), 0) + 1;
  const entry = {
    id,
    status: "pending",
    time: new Date().toISOString(),
    ...item,
  };
  list.push(entry);
  save(list);
  return entry;
}

export function listPending() {
  return load().filter(x => x.status === "pending");
}

export function getPending(id) {
  return load().find(x => x.status === "pending" && Number(x.id) === Number(id)) || null;
}

export function resolvePending(id, status) {
  const list = load();
  const item = list.find(x => Number(x.id) === Number(id));
  if (!item) return null;
  item.status = status;
  item.resolvedAt = new Date().toISOString();
  save(list);
  return item;
}

export function formatPendingList() {
  const items = listPending();
  if (!items.length) return "现在没有待处理的申请。";
  return items.map(x =>
    `#${x.id} [${x.label || x.type}] ${x.fromName || x.from}（${x.from}）${x.comment ? "：" + x.comment : ""}`
  ).join("\n") + "\n\n回复 /approve 编号 或 /deny 编号";
}
