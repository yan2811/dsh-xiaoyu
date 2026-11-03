import fs from "node:fs";
import path from "node:path";

const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY || "";
const DASHSCOPE_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const QWEN_MODEL = "qwen-vl-max";

const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1";
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || "deepseek-chat";

const MIME_MAP = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp",
};

function buildPrompt(characterName) {
  if (characterName === "顾昀迟") {
    return "用极简的中文描述这张图片，一句话，语气冷淡直接。";
  }
  if (characterName === "蓝色大肥鱼") {
    return "用自然、俏皮的中文描述这张图片，1-2 句话，像朋友聊天一样，可以带一点鱼/吃货的语气。直接说画面内容，不要用'这张图片显示'之类的开头。如果图里有文字，把文字也读出来。";
  }
  return "用自然的口语中文描述这张图片，2-3句话，像朋友聊天一样随意。直接描述画面内容，不要用'这张图片显示'之类的开头。如果图里有文字，把文字也读出来。";
}

/**
 * 图片描述：优先千问 qwen-vl-max（配了 DASHSCOPE_API_KEY 时），
 * 否则退回 DeepSeek 的多模态接口（deepseek-chat 已支持图片输入）。
 */
export async function describeImage(imagePath, characterName) {
  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = MIME_MAP[ext] || "image/jpeg";

  let imageData;
  try { imageData = fs.readFileSync(imagePath); }
  catch (e) { console.error("[Vision] 读取失败:", e.message); return null; }

  const dataUrl = `data:${mimeType};base64,${imageData.toString("base64")}`;
  const prompt = buildPrompt(characterName);

  if (DASHSCOPE_KEY) {
    const result = await callVision(DASHSCOPE_BASE, DASHSCOPE_KEY, QWEN_MODEL, dataUrl, prompt, "千问");
    if (result) return result;
    console.log("[Vision] 千问失败，降级到 DeepSeek 视觉");
  }
  if (DEEPSEEK_KEY) {
    return callVision(DEEPSEEK_BASE, DEEPSEEK_KEY, DEEPSEEK_MODEL, dataUrl, prompt, "DeepSeek");
  }
  console.log("[Vision] 没有可用的视觉 API Key");
  return null;
}

async function callVision(base, key, model, dataUrl, prompt, label) {
  const body = {
    model,
    max_tokens: 200,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    }],
  };

  try {
    const resp = await fetch(base + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + key,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`[Vision] ${label} API 错误:`, resp.status, errText.slice(0, 200));
      return null;
    }

    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content;
    if (text) {
      console.log(`[Vision] ${label} 识别: ` + text.slice(0, 60) + "...");
      return text.trim();
    }
    return null;
  } catch (e) {
    console.error(`[Vision] ${label} 请求失败:`, e.message);
    return null;
  }
}
