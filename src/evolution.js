import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chat } from "./ai-client.js";
import { buildCharacterPrompt } from "./personality.js";
import {
  loadPersona, loadRelation, applyEvolution,
  noteEvent, getEvents, clearEvents,
} from "./growth.js";
import { getMoodText, applyMoodDelta, reactToMessage } from "./mood.js";
import { getRecentMessages, getSummaries, getMemories } from "./memory.js";
import { getSettings } from "./settings.js";

// ============================================================
//  自我进化：观察 → 事件队列 → 定期回顾 → 校验写入
// ============================================================

const __dir = path.dirname(fileURLToPath(import.meta.url));
const COUNTER_DIR = path.join(__dir, "..", "data", "growth", "counters");

const EVENT_TRIGGER = 5;
const DAILY_MIN = 20;
const locks = new Set();

const EVENT_RULES = [
  { type: "preference", re: /我喜欢|我不喜欢|最爱|讨厌|以后叫我|别叫我|不要叫我|记住/ },
  { type: "feedback", re: /你好可爱|你好烦|别说了|换个说法|正经点|别演了|有点东西/ },
  { type: "conflict", re: /生气|吵架|对不起|没事了|原谅|不理你/ },
  { type: "important", re: /第一次|约定|纪念日|以后都/ },
  { type: "food", re: /投喂|小鱼干|蛋糕|奶茶|团子|吃饭|外卖/ },
];

function counterFile(userId) { return path.join(COUNTER_DIR, `${userId}.json`); }

function loadCounter(userId) {
  try {
    const c = JSON.parse(fs.readFileSync(counterFile(userId), "utf-8"));
    return {
      total: Number(c.total) || 0,
      sinceReview: Number(c.sinceReview) || 0,
      lastReviewAt: c.lastReviewAt || null,
    };
  } catch {
    return { total: 0, sinceReview: 0, lastReviewAt: null };
  }
}

function saveCounter(userId, c) {
  fs.mkdirSync(COUNTER_DIR, { recursive: true });
  fs.writeFileSync(counterFile(userId), JSON.stringify(c, null, 2));
}

// ---------------- 观察 ----------------

export function observe(userId, userText, replyText) {
  try {
    const c = loadCounter(userId);
    c.total += 1;
    c.sinceReview += 1;
    saveCounter(userId, c);

    reactToMessage(userText);

    const t = String(userText || "");
    for (const rule of EVENT_RULES) {
      if (rule.re.test(t)) {
        noteEvent(userId, rule.type, t.slice(0, 100));
        break;
      }
    }
  } catch (e) {
    console.error("[进化] 观察失败:", e.message);
  }
}

// ---------------- 定期回顾 ----------------

export async function maybeEvolve(userId, options = {}) {
  const { force = false, characterId, profilePath } = options;
  if (locks.has(String(userId))) return { skipped: true, reason: "正在回顾中" };
  if (!profilePath) return { skipped: true, reason: "缺少角色配置" };

  const st = getSettings().evolution;
  const reviewEvery = Math.max(10, Math.min(200, Number(st.everyMessages) || 50));
  const maxDelta = Math.max(1, Math.min(5, Number(st.maxTraitDelta) || 3));

  if (!st.enabled && !force) return { skipped: true, reason: "自动进化已关闭" };

  const c = loadCounter(userId);
  const events = getEvents(userId);
  const hours = c.lastReviewAt ? (Date.now() - new Date(c.lastReviewAt).getTime()) / 3600000 : 999;
  const due = c.sinceReview >= reviewEvery
    || events.length >= EVENT_TRIGGER
    || (hours >= 24 && c.sinceReview >= DAILY_MIN);

  if (!force && !due) return { skipped: true, reason: "还没到回顾点" };

  locks.add(String(userId));
  try {
    const persona = loadPersona();
    const relation = loadRelation(userId);
    const base = buildCharacterPrompt(profilePath);
    const recent = getRecentMessages(userId, characterId, 40)
      .map(m => `${m.role === "user" ? "对方" : "我"}：${String(m.content).slice(0, 180)}`)
      .join("\n");
    const summaries = getSummaries(userId, characterId).slice(-3).map(s => s.text).join("\n");
    const memories = getMemories(userId, characterId, 30)
      .map(m => `- [${m.category}] ${m.key}: ${m.value}`)
      .join("\n");

    const prompt = `${base}

## 当前成长状态（JSON）
${JSON.stringify({ traits: persona.traits, habits: persona.habits, preferences: persona.preferences, quirks: persona.quirks }, null, 2)}

## 当前关系（JSON）
${JSON.stringify(relation, null, 2)}

## 当前心情
${getMoodText()}

## 关于对方的长期记忆
${memories || "（无）"}

## 最近对话摘要
${summaries || "（无）"}

## 待处理的情绪/偏好事件
${events.length ? events.map(e => `- [${e.type}] ${e.text}`).join("\n") : "（无）"}

## 最近对话
${recent || "（无）"}

【任务】判断这段时间角色应该发生哪些缓慢变化。只输出 JSON，不要 markdown，不要解释。
JSON 结构：
{
  "traitDeltas": { "tsundere": 0, "clinginess": 0, "initiative": 0, "sharpness": 0, "laziness": 0, "foodie": 0, "gentleness": 0 },
  "newHabits": [],
  "newPreferences": [],
  "newQuirks": [],
  "relation": { "nickname": "", "stage": "当前阶段", "intimacyDelta": 0, "attitude": "" },
  "insideJokes": [],
  "sharedMemories": [],
  "moodDelta": 0,
  "selfNarrative": "",
  "reason": ""
}

规则：
- 没有足够证据就输出空数组/0，不要为了变化而编造
- traitDeltas 每一项范围 -${maxDelta} ~ ${maxDelta}，表示“缓慢变化”
- newHabits/newPreferences/newQuirks 每次最多 3 条，每条不超过 60 字
- relation.stage 只能前进一档（陌生→认识→熟悉→亲近→自己人），不能后退
- nickname 最多 8 个字；没有明确依据就留空
- insideJokes/sharedMemories 每次最多 3 条
- 不能改变名字、来历、物种、DeepSeek 鲸鱼娘身份
- selfNarrative：用第一人称写一句不超过 40 字的“最近我好像……”，描述你意识到的变化；没有变化就留空
- 不要输出任何隐私信息、联系方式或敏感内容
- 如果这次没有值得进化的东西，直接输出 {}`;

    const raw = await chat(
      "你是一个严格的角色成长评估器，只输出合法 JSON，不输出任何其他内容。",
      [{ role: "user", content: prompt }],
      { maxTokens: 600, temperature: 0.3, label: "evolve" }
    );

    const match = String(raw || "").match(/\{[\s\S]*\}/);
    if (!match) {
      console.log("[进化] 模型没有返回 JSON，跳过");
      return { ok: false, reason: "没有 JSON" };
    }

    let patch;
    try { patch = JSON.parse(match[0]); }
    catch (e) {
      console.log("[进化] JSON 解析失败:", e.message);
      return { ok: false, reason: "JSON 无效" };
    }

    const result = applyEvolution(userId, patch, {
      source: force ? "manual" : "periodic",
      maxTraitDelta: maxDelta,
    });

    if (patch.moodDelta) applyMoodDelta(Number(patch.moodDelta) || 0, "进化回顾", 8);

    c.sinceReview = 0;
    c.lastReviewAt = new Date().toISOString();
    saveCounter(userId, c);
    clearEvents(userId);

    if (result.changed) {
      console.log(`[进化] v${result.persona.version}: ${result.changes.join("；")}`);
    } else {
      console.log("[进化] 本次没有产生变化");
    }
    return {
      ok: true,
      changed: !!result.changed,
      changes: result.changes || [],
      version: result.persona?.version,
      reason: patch.reason || "",
    };
  } catch (e) {
    console.error("[进化] 回顾失败:", e.message);
    return { ok: false, reason: e.message };
  } finally {
    locks.delete(String(userId));
  }
}

export function forceEvolve(userId, options = {}) {
  return maybeEvolve(userId, { ...options, force: true });
}
