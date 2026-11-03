import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSettings } from "./settings.js";

// ============================================================
//  表达学习：学对方的用词、句长、标点习惯
//  只学风格，不存原话，不复读内容
// ============================================================

const __dir = path.dirname(fileURLToPath(import.meta.url));
const STYLE_DIR = path.join(__dir, "..", "data", "growth", "style");

const SLANG = [
  "笑死", "离谱", "有点东西", "好家伙", "我靠", "卧槽", "绝了", "绷不住", "破防",
  "救命", "真的服", "不是吧", "咋回事", "啥意思", "行吧", "好吧", "可以可以",
  "呜呜", "哭死", "爱了", "无语", "麻了", "摆烂", "摸鱼", "吃瓜", "破大防",
  "你小子", "别急", "逆天", "抽象", "小丑", "牛", "强", "稳", "寄", "典",
  "急了", "孝", "赢", "麻", "乐", "绷", "6", "233", "hhh", "哈哈哈",
  "确实", "有一说一", "说真的", "不是", "反正", "算了", "随便", "真的假的",
  "太真实了", "笑不活了", "难绷", "蚌埠住了", "绷不住了", "什么鬼", "离谱他妈",
];

const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;

function fileFor(userId) {
  return path.join(STYLE_DIR, `${userId}.json`);
}

function ensureDir() { fs.mkdirSync(STYLE_DIR, { recursive: true }); }

function defaults(userId) {
  return {
    userId: String(userId),
    updatedAt: null,
    messages: 0,
    phrases: [],          // [{text, count}]
    manual: [],           // 手动添加的口头禅
    stats: {
      count: 0,
      totalLen: 0,
      short: 0,
      question: 0,
      ellipsis: 0,
      exclamation: 0,
      emoji: 0,
    },
  };
}

export function loadStyle(userId) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileFor(userId), "utf-8"));
    const d = defaults(userId);
    return {
      ...d,
      ...raw,
      phrases: Array.isArray(raw.phrases) ? raw.phrases : [],
      manual: Array.isArray(raw.manual) ? raw.manual : [],
      stats: { ...d.stats, ...(raw.stats || {}) },
    };
  } catch {
    return defaults(userId);
  }
}

function saveStyle(p) {
  ensureDir();
  p.updatedAt = new Date().toISOString();
  p.phrases = (p.phrases || []).slice(0, 20);
  p.manual = [...new Set((p.manual || []).filter(Boolean).map(s => String(s).slice(0, 12)))].slice(0, 10);
  fs.writeFileSync(fileFor(p.userId), JSON.stringify(p, null, 2));
}

function dedupePhrases(list) {
  const sorted = [...list].filter(Boolean).sort((a, b) => b.length - a.length);
  const out = [];
  for (const p of sorted) {
    if (out.some(k => k.includes(p) || p.includes(k))) continue;
    out.push(p);
  }
  return out;
}

function ratios(p) {
  const n = Math.max(1, p.stats.count);
  return {
    avgLen: p.stats.count ? p.stats.totalLen / p.stats.count : 0,
    shortPct: p.stats.short / n,
    questionPct: p.stats.question / n,
    ellipsisPct: p.stats.ellipsis / n,
    exclamationPct: p.stats.exclamation / n,
    emojiPct: p.stats.emoji / n,
  };
}

export function observeUserMessage(userId, text) {
  try {
    if (!getSettings().style?.enabled) return;
    const t = String(text || "").trim();
    if (!t || t.startsWith("/") || t.length < 2) return;
    if (/^\[(图片|表情|语音)\]$/.test(t)) return;

    const p = loadStyle(userId);
    p.messages += 1;

    const s = p.stats;
    s.count += 1;
    s.totalLen += t.length;
    if (t.length <= 10) s.short += 1;
    if (/[?？]/.test(t)) s.question += 1;
    if (/…|\.{3,}/.test(t)) s.ellipsis += 1;
    if (/[!！]/.test(t)) s.exclamation += 1;
    if (EMOJI_RE.test(t)) s.emoji += 1;
    EMOJI_RE.lastIndex = 0;

    for (const term of SLANG) {
      if (!t.includes(term)) continue;
      const hit = p.phrases.find(x => x.text === term);
      if (hit) hit.count += 1;
      else p.phrases.push({ text: term, count: 1 });
    }
    p.phrases.sort((a, b) => b.count - a.count);

    saveStyle(p);
  } catch (e) {
    console.error("[表达] 学习失败:", e.message);
  }
}

export function getStyleContext(userId) {
  const st = getSettings().style || {};
  if (!st.enabled) return "";
  const p = loadStyle(userId);
  if (p.messages < (Number(st.minMessages) || 8)) return "";

  const max = Math.max(3, Math.min(20, Number(st.maxPhrases) || 12));
  const learned = dedupePhrases(p.phrases.filter(x => x.count >= 1).map(x => x.text));
  const phrases = dedupePhrases([...p.manual, ...learned]).slice(0, max);
  const r = ratios(p);

  const lines = ["## 对方的说话风格（只学语气，不要复读内容）"];
  if (phrases.length) lines.push(`- 常用口头禅：${phrases.join("、")}`);
  if (r.avgLen > 0) {
    const lenText = r.avgLen <= 12 ? "偏短" : r.avgLen >= 28 ? "偏长" : "中等";
    lines.push(`- 句子${lenText}（平均 ${Math.round(r.avgLen)} 字，${Math.round(r.shortPct * 100)}% 是短句）`);
  }
  if (r.questionPct >= 0.2) lines.push("- 经常用问号");
  if (r.ellipsisPct >= 0.15) lines.push("- 常用省略号，语气有停顿");
  if (r.exclamationPct >= 0.15) lines.push("- 语气比较外放，常用感叹号");
  lines.push("- 学他的节奏和用词习惯，但不要照抄原话，不要模仿错别字或隐私信息；你仍然是蓝色大肥鱼。");
  return lines.join("\n");
}

export function getStyleSummary(userId) {
  const st = getSettings().style || {};
  const p = loadStyle(userId);
  const r = ratios(p);
  const counts = new Map(p.phrases.map(x => [x.text, x.count]));
  const learned = dedupePhrases(p.phrases.filter(x => x.count >= 1).map(x => x.text));
  const phrases = dedupePhrases([...p.manual, ...learned]).slice(0, 12)
    .map(t => counts.has(t) ? `${t}(${counts.get(t)})` : t);

  const lines = [
    `表达学习：${st.enabled ? "开" : "关"}（已学习 ${p.messages} 条消息）`,
    phrases.length ? `口头禅：${phrases.join("、")}` : "口头禅：还没学够，再聊几句",
  ];
  if (p.stats.count) {
    lines.push(`习惯：平均 ${Math.round(r.avgLen)} 字，${Math.round(r.shortPct * 100)}% 短句，问号 ${Math.round(r.questionPct * 100)}%，省略号 ${Math.round(r.ellipsisPct * 100)}%`);
  }
  return lines.join("\n");
}

export function getStyleForPanel(userId) {
  const st = getSettings().style || {};
  const p = loadStyle(userId);
  const r = ratios(p);
  return {
    enabled: !!st.enabled,
    messages: p.messages,
    manual: p.manual,
    phrases: p.phrases.slice(0, 20),
    habits: {
      avgLen: Math.round(r.avgLen),
      shortPct: Math.round(r.shortPct * 100),
      questionPct: Math.round(r.questionPct * 100),
      ellipsisPct: Math.round(r.ellipsisPct * 100),
      exclamationPct: Math.round(r.exclamationPct * 100),
    },
    summary: getStyleSummary(userId),
  };
}

export function clearStyle(userId) {
  try { fs.unlinkSync(fileFor(userId)); } catch {}
}

export function addManualPhrase(userId, text) {
  const t = String(text || "").trim().slice(0, 12);
  if (!t) return null;
  const p = loadStyle(userId);
  if (!p.manual.includes(t)) p.manual.push(t);
  saveStyle(p);
  return t;
}

export function removeManualPhrase(userId, text) {
  const t = String(text || "").trim().slice(0, 12);
  const p = loadStyle(userId);
  p.manual = p.manual.filter(x => x !== t);
  p.phrases = p.phrases.filter(x => x.text !== t);
  saveStyle(p);
  return t;
}
