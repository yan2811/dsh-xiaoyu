import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 好友权限白名单：owner 永远最高，friends 里的 QQ 有“好友”权限，其余是 guest。
const __dir = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dir, "..", "data", "qq-friends.json");
const OWNER_ID = Number(process.env.QQ_OWNER_ID || 2811534319);

function normQq(qq) {
  return String(qq || "").replace(/[^\d]/g, "");
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    if (j && typeof j === "object" && j.friends && typeof j.friends === "object") return j;
  } catch {}
  return { friends: {} };
}

function save(j) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(j, null, 2));
}

export function getFriend(qq) {
  const id = normQq(qq);
  if (!id) return null;
  return load().friends[id] || null;
}

export function isFriend(qq) {
  return !!getFriend(qq);
}

export function getRole(qq, ownerId = OWNER_ID) {
  const id = normQq(qq);
  if (!id) return "guest";
  if (Number(id) === Number(ownerId)) return "owner";
  return getFriend(id) ? "friend" : "guest";
}

export function addFriend(qq, name = "") {
  const id = normQq(qq);
  if (!id || id.length < 5) return { ok: false, reason: "QQ 号不对" };
  if (Number(id) === OWNER_ID) return { ok: false, reason: "主人不用加自己" };

  const j = load();
  const existed = !!j.friends[id];
  j.friends[id] = {
    name: String(name || "").trim().slice(0, 30),
    addedAt: j.friends[id]?.addedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  save(j);
  return { ok: true, added: !existed, entry: { qq: id, ...j.friends[id] } };
}

export function removeFriend(qq) {
  const id = normQq(qq);
  const j = load();
  if (!j.friends[id]) return { ok: false, reason: "不在好友列表里" };
  delete j.friends[id];
  save(j);
  return { ok: true };
}

export function listFriends() {
  const j = load();
  return Object.entries(j.friends)
    .map(([qq, v]) => ({ qq, name: v.name || "", addedAt: v.addedAt || "" }))
    .sort((a, b) => String(a.addedAt).localeCompare(String(b.addedAt)));
}
