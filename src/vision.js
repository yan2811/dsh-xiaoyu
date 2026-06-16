import fs from "node:fs";
import path from "node:path";

const DASHSCOPE_KEY = process.env.DASHSCOPE_API_KEY || "";
const BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const MODEL = "qwen-vl-max"; // 千问最强视觉模型

const MIME_MAP = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp",
};

export async function describeImage(imagePath, characterName) {
  if (!DASHSCOPE_KEY) {
    console.log("[Vision] DASHSCOPE_API_KEY 未配置");
    return null;
  }

  const ext = path.extname(imagePath).toLowerCase();
  const mimeType = MIME_MAP[ext] || "image/jpeg";

  let imageData;
  try { imageData = fs.readFileSync(imagePath); }
  catch (e) { console.error("[Vision] 读取失败:", e.message); return null; }

  const base64 = imageData.toString("base64");
  const dataUrl = `data:${mimeType};base64,${base64}`;

  const prompt = characterName === "顾昀迟"
    ? "用极简的中文描述这张图片，一句话，语气冷淡直接。"
    : "用自然的口语中文描述这张图片，2-3句话，像朋友聊天一样随意。直接描述画面内容，不要用'这张图片显示'之类的开头。";

  const body = {
    model: MODEL,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: dataUrl } },
      ],
    }],
    max_tokens: 200,
  };

  try {
    const resp = await fetch(BASE_URL + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + DASHSCOPE_KEY,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error("[Vision] API 错误:", resp.status, errText.slice(0, 200));
      return null;
    }

    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content;
    if (text) {
      console.log("[Vision] 识别: " + text.slice(0, 60) + "...");
      return text.trim();
    }
    return null;
  } catch (e) {
    console.error("[Vision] 请求失败:", e.message);
    return null;
  }
}
