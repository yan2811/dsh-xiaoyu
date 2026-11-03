import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chat } from "./ai-client.js";
import { buildCharacterPrompt } from "./personality.js";
import { buildGrowthContext } from "./growth.js";
import { getMoodText } from "./mood.js";
import { getRecentMessages } from "./memory.js";

// ============================================================
//  日记：每天最多一篇，或情绪波动明显时写
// ============================================================

const __dir = path.dirname(fileURLToPath(import.meta.url));
const DIARY_DIR = path.join(__dir, "..", "data", "growth", "diary");

function todayKey() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

function ensureDir() { fs.mkdirSync(DIARY_DIR, { recursive: true }); }

export function hasDiaryToday() {
  try { return fs.existsSync(path.join(DIARY_DIR, `${todayKey()}.md`)); } catch { return false; }
}

export function saveDiary(text) {
  ensureDir();
  const body = String(text || "").trim();
  if (!body) return null;
  const file = path.join(DIARY_DIR, `${todayKey()}.md`);
  fs.writeFileSync(file, `# ${todayKey()}\n\n${body}\n`, "utf-8");
  return file;
}

export function getRecentDiaryBrief(n = 2) {
  try {
    ensureDir();
    const files = fs.readdirSync(DIARY_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort()
      .slice(-n)
      .reverse();
    return files.map(f => {
      const body = fs.readFileSync(path.join(DIARY_DIR, f), "utf-8")
        .replace(/^#.*$/m, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 80);
      return `${f.slice(5, 10)} ${body}`;
    }).join("；");
  } catch {
    return "";
  }
}

export async function writeDiaryNow({ userId, characterId, profilePath, force = false }) {
  if (!force && hasDiaryToday()) return null;

  const persona = buildCharacterPrompt(profilePath);
  const growth = buildGrowthContext(userId, { moodText: getMoodText() });
  const recent = getRecentMessages(userId, characterId, 30)
    .map(m => `${m.role === "user" ? "对方" : "我"}：${String(m.content).slice(0, 120)}`)
    .join("\n");

  const prompt = `${persona}\n\n${growth}\n\n## 今天聊过的内容\n${recent || "（今天没怎么聊）"}\n\n【任务】用第一人称写一篇很短的日记，1~3 句话，记录今天发生的事和你的感受。\n要求：\n- 用「蓝色大肥鱼」的语气，短、脆、有点小吐槽，但不要表演\n- 可以提到对方，但不要泄露隐私信息\n- 不要加标题、日期、引号或任何前缀\n- 直接输出日记正文`;

  try {
    const text = await chat(
      "你是一个只输出日记正文的写作助手，不要任何解释、标题或格式。",
      [{ role: "user", content: prompt }],
      { maxTokens: 180, temperature: 0.9, label: "diary" }
    );
    const clean = String(text || "").replace(/^["“]|["”]$/g, "").trim();
    if (!clean) return null;
    const file = saveDiary(clean);
    console.log("[日记] 已写:", clean.slice(0, 50));
    return { file, text: clean };
  } catch (e) {
    console.error("[日记] 生成失败:", e.message);
    return null;
  }
}
