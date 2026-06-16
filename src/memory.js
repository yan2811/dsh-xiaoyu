import { getRecentMessages as dbGetRecent, getMessageCount as dbMsgCount,
  getMessagesForSummarization as dbGetForSummary, trimMessages as dbTrim,
  saveFact as dbSaveFact, getFacts as dbGetFacts,
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

// ==================== L3: 用户事实 ====================

export function saveFact(userId, characterId, key, value) {
  dbSaveFact(userId, characterId, key, value);
}

export function getFacts(userId, characterId) {
  const facts = dbGetFacts(userId, characterId, 30);
  return facts.map(f => ({ key: f.key, value: f.value, time: f.time }));
}

// ==================== 综合上下文构建 ====================

export function buildContext(userId, characterId) {
  const l1Messages = getRecentMessages(userId, characterId, 40);
  const l2Summaries = getSummaries(userId, characterId);
  const l3Facts = getFacts(userId, characterId);

  let contextParts = [];

  if (l3Facts.length > 0) {
    const factStr = l3Facts
      .slice(0, 15)
      .map(f => `[${f.key}]: ${f.value}`)
      .join("\n");
    contextParts.push(`## 关于对方，你记住这些\n${factStr}`);
  }

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
