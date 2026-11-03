import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 群聊设置：autoReply=true 自动接话；false 只在被 @ 或叫名字时回
const __dir = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dir, "..", "data", "qq-groups.json");

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

function save(j) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(j, null, 2));
}

export function getGroupSettings(groupId) {
  const j = load();
  const s = j[String(groupId)] || {};
  return {
    autoReply: typeof s.autoReply === "boolean" ? s.autoReply : null,
    willingness: typeof s.willingness === "number" && Number.isFinite(s.willingness) ? s.willingness : null,
    tone: typeof s.tone === "string" ? s.tone : "",
  };
}

export function setGroupSettings(groupId, patch = {}) {
  const j = load();
  const key = String(groupId);
  j[key] = { ...(j[key] || {}), ...patch, updatedAt: new Date().toISOString() };
  save(j);
  return getGroupSettings(key);
}

export function getAllGroupSettings() {
  return load();
}

export function getGroupAuto(groupId) {
  return getGroupSettings(groupId).autoReply;
}

export function setGroupAuto(groupId, autoReply) {
  return setGroupSettings(groupId, { autoReply: !!autoReply });
}
