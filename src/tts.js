import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY || "";
const QWEN_ENDPOINT =
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
const COSY_ENDPOINT =
  "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer";
const QWEN_MODEL = process.env.TTS_MODEL || "qwen3-tts-flash";
const QWEN_VOICE = process.env.TTS_VOICE || "Maia";
const COSY_MODEL = process.env.COSYVOICE_MODEL || "cosyvoice-v3.5-flash";
const COSY_VOICE = process.env.COSYVOICE_VOICE || "";
const BREEZE_ENDPOINT = (process.env.BREEZE_BASE_URL || "https://api.breeze.blue/v1").replace(/\/+$/, "");
const BREEZE_KEY = process.env.BREEZE_API_KEY || "";
const BREEZE_MODEL = process.env.BREEZE_MODEL || "breeze-tts-2";
const VOICE_DIR = path.join(__dir, "..", "data", "voice");

if (BREEZE_KEY) console.log("[TTS] BreezeBlue 已配置");
else console.log("[TTS] 未配置 BREEZE_API_KEY（Breeze 不可用）");

// 接口对单次合成的文本长度有限制，超了会报错，先截断
const MAX_CHARS = 400;
const MAX_FILES = 30;

// 8 维情绪 → CosyVoice 语气指令。低等级用 mild，高等级用 strong。
const EMOTION_INSTRUCTIONS = {
  happy:   { mild: "语气轻快，带一点笑意", strong: "语气很轻快，带笑意，声音明亮上扬" },
  angry:   { mild: "语气有点冲，带一点不满", strong: "语气压着火，咬字重，语速稍快" },
  sad:     { mild: "声音有点低落", strong: "声音低落，语速偏慢，带一点鼻音" },
  shy:     { mild: "声音轻一点，带一点犹豫", strong: "声音很轻，带一点害羞，停顿多一点" },
  proud:   { mild: "语气自信一点", strong: "语气得意，声音上扬" },
  tired:   { mild: "声音有点慵懒", strong: "声音很疲惫，语速偏慢" },
  jealous: { mild: "语气有点酸", strong: "语气酸酸的，带一点不满" },
  clingy:  { mild: "声音软一点", strong: "声音很软，带一点撒娇" },
};

/**
 * 把当前情绪拼进基础语气指令。
 * base 是日常基线，emotion/level 决定往上叠多少情绪。
 */
export function buildVoiceInstruction({ emotion, level = 0, base = "" } = {}) {
  const b = String(base || "").trim();
  const e = EMOTION_INSTRUCTIONS[emotion];
  if (!e) return b;

  const lv = Math.max(0, Math.min(10, Number(level) || 0));
  if (lv < 2) return b;
  const clause = lv >= 7 ? e.strong : e.mild;
  return b ? `${b}；${clause}` : clause;
}

function cleanup() {
  try {
    if (!fs.existsSync(VOICE_DIR)) return;
    const files = fs.readdirSync(VOICE_DIR)
      .filter(f => f.endsWith(".wav"))
      .map(f => ({ f, t: fs.statSync(path.join(VOICE_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(MAX_FILES)) {
      try { fs.unlinkSync(path.join(VOICE_DIR, f)); } catch {}
    }
  } catch {}
}

function prepareText(text) {
  let clean = String(text || "").trim();
  if (!clean) return "";
  if (clean.length > MAX_CHARS) {
    clean = clean.slice(0, MAX_CHARS);
    console.log(`[TTS] 文本过长，截断到 ${MAX_CHARS} 字`);
  }
  return clean;
}

function saveAudio(buf) {
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  const outPath = path.join(VOICE_DIR, `voice-${Date.now()}.wav`);
  fs.writeFileSync(outPath, buf);
  cleanup();
  console.log(`[TTS] 已生成 ${buf.length} 字节 -> ${outPath}`);
  return outPath;
}

async function downloadAudio(audioUrl) {
  const audioResp = await fetch(audioUrl, { signal: AbortSignal.timeout(60000) });
  if (!audioResp.ok) {
    console.error("[TTS] 下载音频失败:", audioResp.status);
    return null;
  }
  return Buffer.from(await audioResp.arrayBuffer());
}

/**
 * 千问 TTS：qwen3-tts-flash / qwen3-tts-instruct-flash。
 * 当前 key 没有 instruct 模型，所以 instructions 只在 instruct 模型下传。
 */
async function synthesizeQwen(clean, options = {}) {
  if (!DASHSCOPE_KEY) {
    console.error("[TTS] DASHSCOPE_API_KEY 未配置（千问 TTS）");
    return null;
  }
  const model = options.model || QWEN_MODEL;
  const voice = options.voice || QWEN_VOICE;
  const input = { text: clean, voice, format: "wav", sample_rate: 24000, language_type: "Chinese" };
  const instruction = options.instruction || options.instructions;
  if (instruction && /instruct/i.test(model)) {
    input.instructions = String(instruction).slice(0, 200);
  }

  const resp = await fetch(QWEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + DASHSCOPE_KEY,
    },
    body: JSON.stringify({ model, input }),
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error("[TTS] 千问 API 错误:", resp.status, errText.slice(0, 200));
    return null;
  }

  const data = await resp.json();
  const audioUrl = data.output?.audio?.url;
  if (!audioUrl) {
    console.error("[TTS] 千问响应里没有 audio.url:", JSON.stringify(data).slice(0, 200));
    return null;
  }
  if (data.usage?.characters) {
    console.log(`[TTS] 千问生成 ${data.usage.characters} 字 (${voice})`);
  }

  const buf = await downloadAudio(audioUrl);
  return buf ? saveAudio(buf) : null;
}

/**
 * CosyVoice v3.5：支持设计/复刻音色 + instruction 情绪/语速控制。
 * 需要 voice_id；系统音色在 v3.5 不可用。
 */
async function synthesizeCosyVoice(clean, options = {}) {
  if (!DASHSCOPE_KEY) {
    console.error("[TTS] DASHSCOPE_API_KEY 未配置（CosyVoice）");
    return null;
  }
  const model = options.model || COSY_MODEL;
  const voice = options.voice || COSY_VOICE;
  if (!voice) {
    console.error("[TTS] 未配置 CosyVoice voice_id（设置里 cosyVoiceId 为空）");
    return null;
  }

  const input = { text: clean, voice, format: "wav", sample_rate: 24000 };
  const instruction = options.instruction || options.instructions;
  if (instruction) input.instruction = String(instruction).slice(0, 500);

  const body = { model, input };
  const rate = Number(options.rate);
  if (Number.isFinite(rate) && rate >= 0.5 && rate <= 2) {
    body.parameters = { rate };
  }

  const resp = await fetch(COSY_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + DASHSCOPE_KEY,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error("[TTS] CosyVoice API 错误:", resp.status, errText.slice(0, 300));
    return null;
  }

  const data = await resp.json();
  const audioUrl = data.output?.audio?.url || data.output?.url;
  if (!audioUrl) {
    console.error("[TTS] CosyVoice 响应里没有音频 URL:", JSON.stringify(data).slice(0, 300));
    return null;
  }
  if (data.usage?.characters) {
    console.log(`[TTS] CosyVoice 生成 ${data.usage.characters} 字${instruction ? `，指令：${instruction.slice(0, 40)}` : ""}`);
  }

  const buf = await downloadAudio(audioUrl);
  return buf ? saveAudio(buf) : null;
}

/**
 * BreezeBlue：breeze-tts-2，支持 instructions + voice_settings.speed。
 * 返回的是音频二进制，不是 URL。
 */
async function synthesizeBreeze(clean, options = {}) {
  if (!BREEZE_KEY) {
    console.error("[TTS] BREEZE_API_KEY 未配置");
    return null;
  }
  const voice = options.voice;
  if (!voice || !String(voice).startsWith("voc_")) {
    console.error("[TTS] Breeze voice_id 必须以 voc_ 开头");
    return null;
  }

  const body = {
    text: clean,
    model_id: options.model || BREEZE_MODEL,
    language_code: options.language || "zh",
  };
  const instruction = options.instruction || options.instructions;
  if (instruction) body.instructions = String(instruction).slice(0, 1000);
  const speed = Number(options.speed);
  if (Number.isFinite(speed) && speed >= 0.5 && speed <= 2) {
    body.voice_settings = { speed };
  }

  const resp = await fetch(
    `${BREEZE_ENDPOINT}/text-to-speech/${encodeURIComponent(voice)}/stream?output_format=wav`,
    {
      method: "POST",
      headers: {
        "xi-api-key": BREEZE_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    }
  );

  if (!resp.ok) {
    const errText = await resp.text();
    console.error("[TTS] Breeze API 错误:", resp.status, errText.slice(0, 300));
    return null;
  }

  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length < 1000 || buf.subarray(0, 4).toString() !== "RIFF") {
    console.error("[TTS] Breeze 返回的不是有效 WAV:", buf.length, "字节");
    return null;
  }
  console.log(`[TTS] Breeze 生成 ${clean.length} 字 (${voice}${speed ? `, speed=${speed}` : ""})`);
  return saveAudio(buf);
}

/**
 * 文字转语音。返回 WAV 绝对路径，失败返回 null。
 * options.provider: "qwen" | "cosyvoice" | "breeze"
 * options.voice: 音色 ID（千问预设 / CosyVoice voice_id / Breeze voc_...）
 * options.instruction: CosyVoice/Breeze 情绪/语气指令
 * options.rate: CosyVoice 语速 0.5~2.0
 * options.speed: Breeze 语速 0.5~2.0
 */
export async function synthesize(text, options = {}) {
  const clean = prepareText(text);
  if (!clean) return null;

  const provider = options.provider || process.env.TTS_PROVIDER || "qwen";
  try {
    if (provider === "breeze") {
      return await synthesizeBreeze(clean, options);
    }
    if (provider === "cosyvoice") {
      return await synthesizeCosyVoice(clean, options);
    }
    return await synthesizeQwen(clean, options);
  } catch (e) {
    console.error("[TTS] 请求失败:", e.message);
    return null;
  }
}
