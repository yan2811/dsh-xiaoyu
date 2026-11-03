// ============================================================
//  群聊短期上下文：记住群里最近几条消息
//  只存在内存里，重启就清空；不写数据库，不占长期记忆
// ============================================================

const MAX_MESSAGES = 20;
const MAX_TEXT = 120;
const store = new Map(); // groupId -> [{userId,name,text,isBot,time}]

export function recordGroupMessage(groupId, { userId, name, text, isBot = false } = {}) {
  const gid = String(groupId || "");
  if (!gid) return;
  const t = String(text || "").trim().slice(0, MAX_TEXT);
  if (!t) return;
  // 群命令不进上下文
  if (!isBot && t.startsWith("/")) return;

  const arr = store.get(gid) || [];
  arr.push({
    userId: String(userId || ""),
    name: String(name || "").slice(0, 20),
    text: t,
    isBot: !!isBot,
    time: Date.now(),
  });
  if (arr.length > MAX_MESSAGES) arr.splice(0, arr.length - MAX_MESSAGES);
  store.set(gid, arr);
}

export function getGroupContext(groupId, limit = 10) {
  const arr = store.get(String(groupId || "")) || [];
  const recent = arr.slice(-Math.max(1, Math.min(MAX_MESSAGES, limit)));
  if (!recent.length) return "";
  return "## 群里刚才在聊什么（只作参考，不要逐条复述）\n" +
    recent.map(m => `- ${m.name || m.userId}：${m.text}`).join("\n");
}

export function clearGroupContext(groupId) {
  store.delete(String(groupId || ""));
}
