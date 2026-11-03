import {
  getRecentMessages as dbGetRecent, getMessageCount as dbMsgCount,
  getMessagesForSummarization as dbGetForSummary, trimMessages as dbTrim,
  saveFact as dbSaveFact, getFacts as dbGetFacts,
  upsertMemory as dbUpsertMemory, getMemories as dbGetMemories,
  deleteMemory as dbDeleteMemory, archiveMemory as dbArchiveMemory,
  getMemoryCounts as dbGetMemoryCounts, markMemoryHit as dbMarkMemoryHit,
  saveSummary as dbSaveSummary, getSummaries as dbGetSummaries,
  getLastSummaryTime as dbLastSummary, needsSummarization as dbNeedsSummary,
} from "./db.js";
import { saveMessage as dbSaveMsg } from "./db.js";

const MAX_L1 = 60;
const SUMMARIZE_EVERY = 40;

// ==================== L1: 短期缓冲区 ====================

export function saveMessage(userId, characterId, role, content) {
  dbSaveMsg(userId, characterId, role, content);
}

export function getRecentMessages(userId, characterId, limit = 40) {
  return dbGetRecent(userId, characterId, limit);
}

export function getMessageCount(userId, characterId) {
  return dbMsgCount(userId, characterId);
}

export function needsSummarization(userId, characterId) {
  return dbNeedsSummary(userId, characterId);
}

export function trimMessages(userId, characterId, keepRecent = 20) {
  dbTrim(userId, characterId, keepRecent);
}

export function getMessagesForSummarization(userId, characterId, keepRecent = 20) {
  return dbGetForSummary(userId, characterId, keepRecent);
}

// ==================== L2: 对话摘要 ====================

export function getSummaries(userId, characterId) {
  return dbGetSummaries(userId, characterId);
}

export function saveSummary(userId, characterId, text) {
  dbSaveSummary(userId, characterId, text);
}

// ==================== L3: 六类长期记忆 ====================

export function saveFact(userId, characterId, key, value) {
  dbSaveFact(userId, characterId, key, value);
}

export function getFacts(userId, characterId) {
  const facts = dbGetFacts(userId, characterId, 30);
  return facts.map(f => ({ key: f.key, value: f.value, time: f.time }));
}

export function saveMemory(opts) {
  return dbUpsertMemory(opts);
}

export function getMemories(userId, characterId, limit = 200) {
  return dbGetMemories(userId, characterId, limit);
}

export function deleteMemory(id) {
  dbDeleteMemory(id);
}

export function archiveMemory(id) {
  dbArchiveMemory(id);
}

export function getMemoryCounts(userId, characterId) {
  return dbGetMemoryCounts(userId, characterId);
}

export const MEMORY_CATEGORY_LABELS = {
  promise: "承诺",
  relationship: "关系",
  event: "事件",
  preference: "偏好",
  emotion: "情绪",
  daily: "日常",
};

const CATEGORY_WEIGHT = {
  promise: 1.35,
  relationship: 1.2,
  event: 1.1,
  preference: 1.0,
  emotion: 0.9,
  daily: 0.6,
};

function relevance(mem, text) {
  const t = String(text || "");
  if (!t) return 0;
  const key = String(mem.key || "");
  const val = String(mem.value || "");
  let score = 0;
  if (key && t.includes(key)) score += 3;

  const grams = new Set();
  for (let i = 0; i < t.length - 1; i++) {
    const bg = t.slice(i, i + 2);
    if (/^[一-龥a-zA-Z0-9]{2}$/.test(bg)) grams.add(bg);
  }
  for (const bg of grams) {
    if (key.includes(bg)) score += 0.5;
    else if (val.includes(bg)) score += 0.2;
  }
  return Math.min(5, score);
}

/**
 * 按相关度 + 重要度 + 新鲜度挑记忆，按类别分组注入 prompt。
 */
export function buildMemoryContext(userId, characterId, userMessage = "", limit = 12) {
  const all = dbGetMemories(userId, characterId, 300);
  if (!all.length) return "";

  const now = Date.now();
  const scored = all.map(m => {
    const ageDays = Math.max(0, (now - (m.updated_at || m.created_at || now)) / 86400000);
    const recency = 1 / (1 + ageDays / 30);
    const rel = relevance(m, userMessage);
    const score = (m.importance / 100) * (CATEGORY_WEIGHT[m.category] || 0.7) * recency + rel;
    return { m, score, rel };
  }).sort((a, b) => b.score - a.score);

  const picked = [];
  let chars = 0;
  for (const { m, rel } of scored) {
    const line = `- ${m.key}：${m.value}`;
    if (chars + line.length > 1400) break;
    picked.push(m);
    chars += line.length;
    if (rel >= 1) dbMarkMemoryHit(m.id);
    if (picked.length >= limit) break;
  }

  const groups = {};
  for (const m of picked) (groups[m.category] ||= []).push(m);

  const lines = ["## 你记得的事（自然使用，不要逐条复述）"];
  for (const cat of ["promise", "relationship", "event", "preference", "emotion", "daily"]) {
    const items = groups[cat];
    if (!items || !items.length) continue;
    lines.push(`### ${MEMORY_CATEGORY_LABELS[cat]}`);
    for (const m of items) {
      const suffix = cat === "promise" ? "（答应过对方，别忘了）" : "";
      lines.push(`- ${m.key}：${m.value}${suffix}`);
    }
  }
  return lines.join("\n");
}

// ==================== 综合上下文构建 ====================

export function buildContext(userId, characterId, userMessage = "") {
  const l1Messages = getRecentMessages(userId, characterId, 40);
  const l2Summaries = getSummaries(userId, characterId);
  const memoryText = buildMemoryContext(userId, characterId, userMessage);

  let contextParts = [];
  if (memoryText) contextParts.push(memoryText);

  if (l2Summaries.length > 0) {
    const recentSummaries = l2Summaries.slice(-5);
    const summaryStr = recentSummaries.map(s => s.text).join("\n");
    if (summaryStr.trim()) {
      contextParts.push(`## 最近的对话历史摘要\n${summaryStr}`);
    }
  }

  return {
    contextText: contextParts.join("\n\n"),
    l1Messages,
  };
}
