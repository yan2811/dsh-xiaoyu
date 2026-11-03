import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================
//  情绪系统：8 维情绪向量 + 总体心情 + 精力
//  纯规则，不调模型；情绪会随时间衰减
// ============================================================

const __dir = path.dirname(fileURLToPath(import.meta.url));
const MOOD_FILE = path.join(__dir, "..", "data", "growth", "mood.json");

export const EMOTION_LABELS = {
  happy: "开心",
  angry: "愤怒",
  sad: "伤心",
  shy: "害羞",
  proud: "得意",
  tired: "疲惫",
  jealous: "吃醋",
  clingy: "黏人",
};

const DEFAULT_EMOTIONS = Object.fromEntries(Object.keys(EMOTION_LABELS).map(k => [k, 0]));

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function nowISO() { return new Date().toISOString(); }

function beijingHour() {
  return Number(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false }));
}

function normalize(raw) {
  const m = raw && typeof raw === "object" ? raw : {};
  const emotions = { ...DEFAULT_EMOTIONS };

  if (m.emotions && typeof m.emotions === "object") {
    for (const k of Object.keys(emotions)) {
      const n = Number(m.emotions[k]);
      if (Number.isFinite(n)) emotions[k] = clamp(n, 0, 100);
    }
  } else {
    // 兼容旧数据：把单一 value 映射成开心/委屈
    const v = Number(m.value) || 0;
    if (v > 0) emotions.happy = clamp(v, 0, 100);
    if (v < 0) emotions.sad = clamp(-v, 0, 100);
  }

  const causes = {};
  if (m.causes && typeof m.causes === "object") {
    for (const k of Object.keys(emotions)) {
      if (typeof m.causes[k] === "string") causes[k] = m.causes[k].slice(0, 40);
    }
  }

  return {
    value: clamp(Number(m.value) || 0, -100, 100),
    energy: clamp(Number(m.energy) || 70, 0, 100),
    emotions,
    causes,
    updatedAt: m.updatedAt || nowISO(),
  };
}

function read() {
  try { return normalize(JSON.parse(fs.readFileSync(MOOD_FILE, "utf-8"))); }
  catch { return normalize({}); }
}

function write(m) {
  fs.mkdirSync(path.dirname(MOOD_FILE), { recursive: true });
  fs.writeFileSync(MOOD_FILE, JSON.stringify(m, null, 2));
}

function deriveValue(e) {
  const pos = e.happy + e.shy + e.proud + e.clingy * 0.5;
  const neg = e.angry + e.sad + e.jealous + e.tired * 0.4;
  return clamp(pos - neg, -100, 100);
}

function applyElapsed(m) {
  const elapsedH = (Date.now() - new Date(m.updatedAt).getTime()) / 3600000;
  if (!(elapsedH > 0.05)) return m;

  const hour = beijingHour();
  const asleep = hour >= 23 || hour < 8;
  m.energy = clamp(m.energy + (asleep ? 8 : -1) * elapsedH, 0, 100);
  m.value = clamp(m.value * (1 - Math.min(1, elapsedH / 24)), -100, 100);

  // 情绪半衰期约 4 小时
  const decay = Math.pow(0.5, elapsedH / 4);
  for (const k of Object.keys(m.emotions)) {
    m.emotions[k] = clamp(m.emotions[k] * decay, 0, 100);
  }
  m.updatedAt = nowISO();
  return m;
}

export function getMood() {
  const m = applyElapsed(read());
  write(m);
  return m;
}

export function applyMoodDelta(delta, reason = "", cap = 8) {
  const m = getMood();
  const d = clamp(Number(delta) || 0, -cap, cap);
  if (!d) return m;

  m.value = clamp(m.value + d, -100, 100);
  if (d > 0) {
    m.emotions.happy = clamp(m.emotions.happy + d * 0.6, 0, 100);
    if (reason) m.causes.happy = reason.slice(0, 40);
  } else {
    m.emotions.sad = clamp(m.emotions.sad - d * 0.6, 0, 100);
    if (reason) m.causes.sad = reason.slice(0, 40);
  }
  m.updatedAt = nowISO();
  write(m);
  if (reason) console.log(`[情绪] ${d > 0 ? "+" : ""}${d.toFixed(1)}（${reason}）→ ${m.value.toFixed(0)}`);
  return m;
}

export function setMood(patch = {}) {
  const m = getMood();
  let emotionsChanged = false;

  if (patch.emotions && typeof patch.emotions === "object") {
    for (const [k, v] of Object.entries(patch.emotions)) {
      if (!(k in EMOTION_LABELS)) continue;
      const n = Number(v);
      if (Number.isFinite(n)) {
        m.emotions[k] = clamp(n, 0, 100);
        emotionsChanged = true;
      }
    }
  }

  if (patch.value !== undefined) {
    const n = Number(patch.value);
    if (Number.isFinite(n)) m.value = clamp(n, -100, 100);
  } else if (emotionsChanged) {
    m.value = deriveValue(m.emotions);
  }

  if (patch.energy !== undefined) {
    const n = Number(patch.energy);
    if (Number.isFinite(n)) m.energy = clamp(n, 0, 100);
  }

  m.updatedAt = nowISO();
  write(m);
  return m;
}

export function moodLabel(value) {
  if (value >= 60) return "开心到冒泡";
  if (value >= 20) return "心情不错";
  if (value > -20) return "平静";
  if (value > -60) return "有点低落";
  return "委屈巴巴";
}

export function emotionLevel(value) {
  return Math.max(0, Math.min(10, Math.round((Number(value) || 0) / 10)));
}

const LADDER_HINTS = {
  happy: ["心情平稳", "有点开心", "心情不错", "明显开心", "开心到冒泡"],
  angry: ["不怎么生气", "有点不爽", "语气变冲", "明显生气，带刺", "炸毛，可能不想聊"],
  sad: ["没怎么难过", "有点低落", "委屈", "很想哭/不想说话", "崩溃"],
  shy: ["不害羞", "有点害羞", "会结巴/转移话题", "脸红，说不出话", "羞到想钻地缝"],
  proud: ["不嘚瑟", "有点得意", "尾巴翘起来", "得意忘形", "尾巴翘上天"],
  tired: ["精力还行", "有点累", "想躺下", "很困，回复变短", "只想睡觉"],
  jealous: ["没吃醋", "有点在意", "阴阳怪气", "明显吃醋", "吃醋发难"],
  clingy: ["不黏人", "想找你", "主动找话题", "很黏", "黏着不放"],
};

function ladderHint(emotion, level) {
  const bucket = Math.min(4, Math.floor(level / 2));
  return (LADDER_HINTS[emotion] || [""])[bucket] || "";
}

/**
 * 把最强情绪转成 0~10 的等级 + 表现规则，注入 prompt。
 */
export function getEmotionLadderText() {
  const m = getMood();
  const top = Object.entries(m.emotions)
    .filter(([, v]) => v >= 25)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  if (!top.length) return "";

  const lines = ["## 你现在的情绪强度（按等级表现，不要越级）"];
  for (const [k, v] of top) {
    const lv = emotionLevel(v);
    lines.push(`- ${EMOTION_LABELS[k]} ${lv}/10：${ladderHint(k, lv)}`);
  }
  return lines.join("\n");
}

export function getMoodText() {
  const m = getMood();
  const top = Object.entries(m.emotions)
    .filter(([, v]) => v >= 15)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  let text = `现在心情：${moodLabel(m.value)}（${m.value.toFixed(0)}/100），精力 ${m.energy.toFixed(0)}/100`;
  if (top.length) {
    const detail = top.map(([k, v]) => {
      const cause = m.causes[k] ? `（${m.causes[k]}）` : "";
      return `${EMOTION_LABELS[k]} ${Math.round(v)}（Lv.${emotionLevel(v)}）${cause}`;
    }).join("、");
    text += `；情绪：${detail}`;
  }
  return text;
}

// ---------------- 根据消息更新情绪 ----------------

const RULES = [
  { re: /胖|肥|减肥|体重/, emotion: "angry", delta: 16, cause: "被说胖" },
  { re: /滚|烦死|闭嘴|讨厌你|生气|别说了|不理你/, emotion: "angry", delta: 20, cause: "被凶" },
  { re: /可爱|喜欢你|爱你|亲亲|抱抱|摸摸/, emotion: "shy", delta: 15, cause: "被夸/撒娇" },
  { re: /厉害|棒|牛|有点东西|真强/, emotion: "proud", delta: 15, cause: "被夸" },
  { re: /哈哈|笑死|开心|好玩|有趣/, emotion: "happy", delta: 12, cause: "聊得开心" },
  { re: /累|困|熬夜|加班|睡觉/, emotion: "tired", delta: 12, cause: "提到累/困" },
  { re: /别人|其他女生|豆包|别的模型|别的AI|其他人/, emotion: "jealous", delta: 14, cause: "提到别人" },
  { re: /想你|在吗|陪我|好久不见|理理我/, emotion: "clingy", delta: 12, cause: "被找" },
  { re: /小鱼干|投喂|吃|奶茶|蛋糕|团子|饭|外卖/, emotion: "happy", delta: 9, cause: "被投喂/聊吃的" },
  { re: /对不起|没事了|原谅|和好/, emotion: "angry", delta: -18, cause: "和好" },
  { re: /对不起|没事了|原谅|和好/, emotion: "sad", delta: -12, cause: "和好" },
];

const NEGATIVE_EMOTIONS = new Set(["angry", "sad", "jealous", "tired"]);

export function reactToMessage(userText) {
  const t = String(userText || "");
  const m = getMood();
  let valueDelta = 0;
  let touched = false;

  for (const rule of RULES) {
    if (!rule.re.test(t)) continue;
    const before = m.emotions[rule.emotion];
    // 情绪阶梯：单条消息最多跳 2~3 级，越高越难继续上涨
    let delta = rule.delta;
    if (delta > 0) delta = Math.min(delta, Math.max(4, 25 - before * 0.15));
    const after = clamp(before + delta, 0, 100);
    if (after !== before) {
      m.emotions[rule.emotion] = after;
      m.causes[rule.emotion] = rule.cause;
      const valence = NEGATIVE_EMOTIONS.has(rule.emotion) ? -1 : 1;
      valueDelta += (after - before) * 0.35 * valence;
      touched = true;
    }
  }

  if (touched) {
    m.value = clamp(m.value + clamp(valueDelta, -20, 20), -100, 100);
    m.updatedAt = nowISO();
    write(m);
  }
  return m;
}
