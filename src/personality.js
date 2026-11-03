import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultProfilePath = path.join(__dirname, "..", "config", "characters", "da-fei-yu.json");

let profile = null;

export function loadProfile() {
  if (!profile) {
    profile = JSON.parse(fs.readFileSync(defaultProfilePath, "utf-8"));
  }
  return profile;
}

export function buildSystemPrompt() {
  const p = loadProfile();
  return p.systemPrompt || "你是「蓝色大肥鱼」，DeepSeek 的二次创作鲸鱼娘，用自然、简短、有梗的 QQ 口吻聊天。";
}

// 加载指定角色的 system prompt（含原著记忆）
export function buildCharacterPrompt(profilePath) {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const fullPath = path.join(dir, "..", profilePath);
  try {
    const charProfile = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
    let prompt = charProfile.systemPrompt || buildSystemPrompt();
    if (charProfile.memories && charProfile.memories.length > 0) {
      prompt += "\n\n## 你的过去（自然融入对话，不要刻意背诵）\n";
      prompt += charProfile.memories.map(m => "- " + m).join("\n");
      prompt += "\n\n这些是你的真实经历。在相关话题中自然地提及，不要生硬地罗列。";
    }
    return prompt;
  } catch {
    return buildSystemPrompt();
  }
}

export function getUserNickname() {
  return loadProfile().relationship?.user_nickname || "主人";
}

export function getCharacterName() {
  return loadProfile().name || "蓝色大肥鱼";
}
