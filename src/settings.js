import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================
//  运行设置：面板和命令共用，改完立即生效，不需要重启
// ============================================================

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dir, "..", "data", "growth", "settings.json");

export const DEFAULTS = {
  sticker: {
    strongChance: 1,      // 强情绪触发概率 0~1
    weakChance: 0.7,      // 普通情绪触发概率
    cooldownMs: 5000,     // 同一会话冷却
  },
  proactive: {
    enabled: true,
    minMinutes: 30,
    maxMinutes: 60,
    startHour: 8,
    endHour: 23,
  },
  evolution: {
    enabled: true,
    everyMessages: 30,
    maxTraitDelta: 3,
  },
  group: {
    willingness: 0.65,   // 群聊自动接话的意愿 0~1
  },
  style: {
    enabled: true,
    minMessages: 8,
    maxPhrases: 12,
  },
  voice: {
    provider: "qwen",      // qwen（千问 TTS）| cosyvoice（CosyVoice v3.5）| breeze（BreezeBlue）
    mode: "auto",          // 私聊默认模式 off | auto | on
    groupMode: "off",      // 群聊默认模式
    voiceId: "Maia",       // 千问预设音色：Chelsie / Serena / Momo / Vivian / Bella / Cherry / Maia
    cosyVoiceId: "",       // CosyVoice 设计/复刻音色 ID（cosyvoice-v3.5-flash-vd-...）
    cosyModel: "cosyvoice-v3.5-flash",
    baseInstruction: "语速中等，声音清亮自然，像和熟人聊天",
    rate: 1,               // CosyVoice 语速 0.5~2.0
    breezeVoiceId: "voc_8yud7hz7c9q2", // 大肥鱼（迷糊版）
    breezeModel: "breeze-tts-2",
    breezeSpeed: 1,        // Breeze 语速 0.5~2.0
    breezeBaseInstruction: "自然口语，像和熟人聊天，语速中等，带一点笑意",
    breezeDailyBudget: 350, // 每天最多用多少 Breeze 积分，0 = 不用
    cooldownMs: 180000,    // auto 模式下两条语音的最小间隔
    autoMinEmotionLevel: 6,
    autoMaxChars: 60,      // auto 模式语音最长字数
    maxChars: 75,          // on 模式语音最长字数（约 15 秒）
    proactiveChance: 0.4,
  },
};

function merge(base, extra) {
  if (!extra || typeof extra !== "object") return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = v && typeof v === "object" && !Array.isArray(v) ? merge(base[k] || {}, v) : v;
  }
  return out;
}

export function getSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    return merge(DEFAULTS, raw);
  } catch {
    return { ...DEFAULTS, sticker: { ...DEFAULTS.sticker }, proactive: { ...DEFAULTS.proactive }, evolution: { ...DEFAULTS.evolution } };
  }
}

export function saveSettings(next) {
  const merged = merge(DEFAULTS, next);
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(merged, null, 2));
  return merged;
}

export function updateSettings(patch) {
  return saveSettings(merge(getSettings(), patch));
}
