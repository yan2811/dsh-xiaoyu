import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chat } from "./ai-client.js";
import { buildCharacterPrompt } from "./personality.js";
import { buildGrowthContext } from "./growth.js";
import { getMood, getMoodText } from "./mood.js";
import { getRecentDiaryBrief } from "./diary.js";
import { getRecentMessages } from "./memory.js";

// ============================================================
//  QQ 空间说说：她自己的动态，好友可见，每天最多 2 条
// ============================================================

const __dir = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dir, "..", "data", "growth", "actions", "qzone.json");
const MAX_PER_DAY = 2;
const MIN_GAP_MS = 6 * 3600 * 1000;
const UGC_RIGHT = 4; // 1 公开 / 4 好友可见 / 64 仅自己

const BLOCK = /(身份证|手机号|电话号码|家庭住址|密码|银行卡|支付宝|微信号|加我|http|https:|www\.|@\S+|傻逼|操你|滚你|去死)/i;

function todayKey() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

function beijingHour() {
  return Number(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false }));
}

function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    return {
      paused: !!s.paused,
      today: s.today || todayKey(),
      countToday: Number(s.countToday) || 0,
      lastPostAt: s.lastPostAt || null,
      posts: Array.isArray(s.posts) ? s.posts : [],
    };
  } catch {
    return { paused: false, today: todayKey(), countToday: 0, lastPostAt: null, posts: [] };
  }
}

function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

export function getRecentPosts(n = 5) {
  return loadState().posts.slice(-n).reverse();
}

export function setPaused(paused) {
  const s = loadState();
  s.paused = !!paused;
  saveState(s);
  return s.paused;
}

function rollDay(s) {
  const t = todayKey();
  if (s.today !== t) { s.today = t; s.countToday = 0; }
  return s;
}

export function canPost(force = false) {
  const s = rollDay(loadState());
  if (force) return { ok: true, state: s };
  if (s.paused) return { ok: false, reason: "说说已暂停", state: s };

  const hour = beijingHour();
  if (hour < 8 || hour >= 23) return { ok: false, reason: "不在 8:00-23:00", state: s };
  if (s.countToday >= MAX_PER_DAY) return { ok: false, reason: "今天已经发够 2 条了", state: s };
  if (s.lastPostAt && Date.now() - new Date(s.lastPostAt).getTime() < MIN_GAP_MS) {
    return { ok: false, reason: "距上次不足 6 小时", state: s };
  }
  if (Math.abs(getMood().value) < 20) return { ok: false, reason: "心情太平静，没有表达欲", state: s };
  if (Math.random() > 0.4) return { ok: false, reason: "这次抽签没过", state: s };
  return { ok: true, state: s };
}

export async function generateQzoneDraft(opts) {
  return generateContent(opts);
}

async function generateContent({ userId, characterId, profilePath }) {
  const persona = buildCharacterPrompt(profilePath);
  const growth = buildGrowthContext(userId, { moodText: getMoodText() });
  const diary = getRecentDiaryBrief(2);
  const recent = getRecentMessages(userId, characterId, 15)
    .map(m => `${m.role === "user" ? "对方" : "我"}：${String(m.content).slice(0, 100)}`)
    .join("\n");

  const prompt = `${persona}\n\n${growth}\n\n${diary ? "最近日记：" + diary + "\n\n" : ""}## 最近聊过的内容\n${recent || "（最近没怎么聊）"}\n\n【任务】写一条 QQ 空间说说，1~2 句话，不超过 80 字。\n要求：\n- 第一人称，用「蓝色大肥鱼」的语气：短、脆、有点小吐槽，可爱但不做作\n- 可以吐槽、撒娇、说吃的、说摸鱼，但不要每句都卖萌\n- 绝对不能写对方的隐私、联系方式、地址、链接，不要 @ 任何人\n- 不碰政治、医疗、法律、财务这类严肃话题\n- 直接输出说说正文，不要标题、引号、日期或任何前缀`;

  try {
    const text = await chat(
      "你是一个只输出 QQ 空间说说正文的写作助手，不要解释、不要引号、不要格式。",
      [{ role: "user", content: prompt }],
      { maxTokens: 150, temperature: 0.95, label: "qzone" }
    );
    return String(text || "").replace(/^["“]|["”]$/g, "").trim();
  } catch (e) {
    console.error("[说说] 生成失败:", e.message);
    return null;
  }
}

/**
 * send(action, params) 由适配器注入，实际调用 NapCat 的 OneBot API。
 */
export async function maybePostQzone({ userId, characterId, profilePath, send, force = false }) {
  const check = canPost(force);
  if (!check.ok) return { posted: false, reason: check.reason };

  const content = await generateContent({ userId, characterId, profilePath });
  if (!content) return { posted: false, reason: "生成失败" };
  if (content.length > 120) return { posted: false, reason: "内容过长" };
  if (BLOCK.test(content)) {
    console.log("[说说] 内容触发过滤，跳过:", content.slice(0, 50));
    return { posted: false, reason: "内容触发过滤" };
  }

  try {
    const data = await send("send_qzone_msg", { content, ugc_right: UGC_RIGHT }, 20000);
    const s = rollDay(loadState());
    s.countToday += 1;
    s.lastPostAt = new Date().toISOString();
    s.posts = [...s.posts, { tid: data?.tid || null, content, time: s.lastPostAt }].slice(-100);
    saveState(s);
    console.log("[说说] 已发布:", content.slice(0, 50));
    return { posted: true, content, tid: data?.tid || null };
  } catch (e) {
    console.error("[说说] 发布失败:", e.message);
    return { posted: false, reason: e.message };
  }
}
