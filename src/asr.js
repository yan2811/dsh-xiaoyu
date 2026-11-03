import fs from "node:fs";
import path from "node:path";

const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY || "";
const BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const MODEL = "qwen3-asr-flash"; // 千问语音识别，支持 base64 直传，不需要公网 URL

const MIME_MAP = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".amr": "audio/amr",
  ".flac": "audio/flac",
  ".silk": "audio/silk",
};

// 接口限制单文件 ≤10MB，base64 会膨胀约 1/3，所以原始音频控制在 7MB 以内。
// 微信语音最长 60 秒，16kHz 单声道 WAV 约 1.9MB，远够用。
const MAX_RAW_BYTES = 7 * 1024 * 1024;

// 语音按时长计费，另存一份账本供 scripts/usage-report.js 统计
const ASR_USAGE_FILE = path.join(process.cwd(), "data", "asr-usage.json");

function recordAsrUsage(usage) {
  if (!usage) return;
  // 兼容不同的字段口径：多数是秒数，少数返回毫秒或纯 token
  let seconds = usage.duration ?? usage.seconds ?? 0;
  if (usage.duration_ms) seconds = usage.duration_ms / 1000;
  console.log(`[ASR] 用量: 时长 ${Number(seconds).toFixed(1)}s  费用 ¥${(seconds * 0.00022).toFixed(5)}`);
  if (!seconds) return;
  try {
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
    let all = {};
    if (fs.existsSync(ASR_USAGE_FILE)) all = JSON.parse(fs.readFileSync(ASR_USAGE_FILE, "utf-8"));
    const d = all[today] || { calls: 0, seconds: 0 };
    d.calls += 1;
    d.seconds += Number(seconds);
    all[today] = d;
    fs.mkdirSync(path.dirname(ASR_USAGE_FILE), { recursive: true });
    fs.writeFileSync(ASR_USAGE_FILE, JSON.stringify(all, null, 2));
  } catch (e) {
    console.error("[ASR] 记账失败:", e.message);
  }
}

/**
 * 把音频文件转成文字（微信语音 → 文本）。
 *
 * 走 DashScope 的 OpenAI 兼容端点，和 vision.js 同一个 base_url，
 * 复用同一个 DASHSCOPE_API_KEY。
 *
 * 两个坑：
 *  1. 内容块的字段名必须是 `input_audio`，写成 `audio` 会返回 400。
 *  2. 兼容模式只接受「公网 URL」或「base64 data URL」，不接受本地路径 ——
 *     这里用 base64，所以服务器不需要对外暴露文件。
 */
export async function transcribeAudio(audioPath) {
  if (!DASHSCOPE_KEY) {
    console.log("[ASR] DASHSCOPE_API_KEY 未配置");
    return null;
  }

  const ext = path.extname(audioPath).toLowerCase();
  const mimeType = MIME_MAP[ext] || "audio/wav";

  let audioData;
  try {
    audioData = fs.readFileSync(audioPath);
  } catch (e) {
    console.error("[ASR] 读取失败:", e.message);
    return null;
  }

  if (audioData.length > MAX_RAW_BYTES) {
    console.error(`[ASR] 音频过大 ${(audioData.length / 1048576).toFixed(1)}MB，跳过`);
    return null;
  }

  const dataUrl = `data:${mimeType};base64,${audioData.toString("base64")}`;

  const body = {
    model: MODEL,
    messages: [{
      role: "user",
      content: [{ type: "input_audio", input_audio: { data: dataUrl } }],
    }],
  };

  try {
    const resp = await fetch(BASE_URL + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + DASHSCOPE_KEY,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("[ASR] API 错误:", resp.status, errText.slice(0, 200));
      return null;
    }

    const data = await resp.json();
    recordAsrUsage(data.usage);
    const text = data.choices?.[0]?.message?.content;
    if (text) {
      console.log("[ASR] 识别: " + text.slice(0, 60));
      return text.trim();
    }
    return null;
  } catch (e) {
    console.error("[ASR] 请求失败:", e.message);
    return null;
  }
}
