import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSystemPrompt, buildCharacterPrompt } from "./personality.js";
import { chat } from "./ai-client.js";
import { buildGrowthContext, loadPersona } from "./growth.js";
import { buildTraitDirective } from "./persona-style.js";
import { getMoodText, getEmotionLadderText } from "./mood.js";
import { getRecentDiaryBrief } from "./diary.js";
import { observe } from "./evolution.js";
import { observeUserMessage, getStyleContext } from "./style.js";
import { observeMilestone } from "./milestones.js";
import { lookupTerms, buildGlossaryContext } from "./glossary.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));

// 聊天回复里不要 emoji，情绪交给表情包
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu;
export function stripEmoji(text) {
  return String(text || "").replace(EMOJI_RE, "").replace(/[ \t]{2,}/g, " ").trim();
}

// 关键词触发式 Lore 注入
function loadLore(profilePath, userMessage) {
  if (!profilePath) return "";
  try {
    const lorePath = path.join(__dir, "..", profilePath.replace(".json", "-lore.json"));
    if (!fs.existsSync(lorePath)) return "";
    const lore = JSON.parse(fs.readFileSync(lorePath, "utf-8"));
    const msg = userMessage.toLowerCase();
    const matched = [];
    for (const s of lore.sections || []) {
      const hit = s.keywords.some(k => msg.includes(k));
      if (hit) matched.push(s.text);
    }
    if (matched.length > 0) {
      return "\n\n## 关于你自己的详细记忆（被问到了，自然融入回答）\n" + matched.join("\n\n");
    }
  } catch {}
  return "";
}
import {
  saveMessage, getMessageCount, getRecentMessages,
  needsSummarization, saveSummary, trimMessages, getMessagesForSummarization,
  saveMemory, getMemories, buildContext,
} from "./memory.js";
import { shouldSearch, searchWeb } from "./search.js";

// 跟踪上次提取事实的消息数
const factExtractCounter = new Map();

export async function handleMessage(userId, characterId, userMessage, characterProfilePath, imageDesc, extraContext = "") {
  saveMessage(userId, characterId, "user", userMessage);

  // 学对方的表达风格（只记用词/句长/标点，不存原话）
  observeUserMessage(userId, userMessage);

  // 梗/网络词：先查本地库，查不到再用 Bing 补全搜索，搜到后写回本地库
  let glossary = { entries: [], unknown: [] };
  try {
    glossary = await lookupTerms(userMessage, { userId });
  } catch (e) {
    console.error("[梗] 查询失败:", e.message);
  }

  // 联网搜索检测（梗已经查到时不再重复搜整句话）
  let searchResult = null;
  if (!glossary.entries.length && shouldSearch(userMessage)) {
    const keywords = extractSearchKeywords(userMessage);
    if (keywords) {
      console.log("[Agent] 搜索:", keywords);
      searchResult = await searchWeb(keywords);
      if (searchResult) {
        console.log("[Agent] 搜索结果:", searchResult.slice(0, 80) + "...");
      }
    }
  }

  // 检查是否需要压缩摘要
  if (needsSummarization(userId, characterId)) {
    await trySummarize(userId, characterId);
  }

  // 构建上下文
  const { contextText, l1Messages } = buildContext(userId, characterId, userMessage);
  let systemPrompt;
  if (characterProfilePath) {
    systemPrompt = buildCharacterPrompt(characterProfilePath);
  } else {
    systemPrompt = buildSystemPrompt();
  }

  // 性格坐标转成高优先级行为指令，放在基础人设之前
  try {
    const traitDirective = buildTraitDirective(loadPersona().traits);
    if (traitDirective) systemPrompt = traitDirective + "\n\n" + systemPrompt;
  } catch (e) {
    console.error("[Agent] 性格指令生成失败:", e.message);
  }

  // 成长覆盖层：性格漂移、习惯、关系、心情、日记
  try {
    const growthText = buildGrowthContext(userId, {
      moodText: getMoodText(),
      ladderText: getEmotionLadderText(),
      diaryText: getRecentDiaryBrief(2),
      styleText: getStyleContext(userId),
    });
    if (growthText) systemPrompt += "\n\n" + growthText;
  } catch (e) {
    console.error("[Agent] 成长上下文加载失败:", e.message);
  }

  // 群聊短期上下文（群里刚才别人说了什么）
  if (extraContext) systemPrompt += "\n\n" + extraContext;

  // 注入北京时间（紧接人设，在上下文之前，确保 AI 重视）
  const now = new Date();
  const beijingTime = now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  systemPrompt += `\n\n## 当前真实时间（精确到秒）\n现在的时间是 ${beijingTime}。这不是大概时间，是精确的北京时间。用户问"现在几点""今天几号""星期几"时，直接引用这里的时间回答，不要估读或四舍五入。\n根据时间调整你的语气和话题（早上慵懒、中午问吃饭、晚上催休息等）。`;

  if (contextText) {
    systemPrompt += "\n\n" + contextText;
  }
  if (searchResult) {
    systemPrompt += `\n\n## 关于对方刚才提到的话题，你联网查到的信息\n${searchResult}\n\n用这些信息自然地回应，不要说"根据搜索结果"，就像你本来就知道一样。`;
  }
  const glossaryText = buildGlossaryContext(glossary.entries, glossary.unknown);
  if (glossaryText) systemPrompt += "\n\n" + glossaryText;
  if (imageDesc) {
    systemPrompt += `\n\n## 对方刚刚发了一张图片\n图片内容: ${imageDesc}\n\n请自然地回应这张图片，就像你真的看到了它一样。可以直接点评图片内容、吐槽、关心等。`;
  }
  // 关键词触发式 Lore：只在提到相关话题时加载
  const lore = loadLore(characterProfilePath, userMessage);
  if (lore) systemPrompt += lore;

  // 构建消息列表
  const messages = l1Messages.map(m => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  // 调用 AI
  const rawReply = await chat(systemPrompt, messages);
  const reply = stripEmoji(rawReply);

  // 控制标记（表情包/语音）只给适配器用，不进对话历史
  const hasVoice = /\[\[voice\]\]/i.test(reply);
  const cleanReply = reply
    .replace(/\[\[sticker:[a-zA-Z_]+\]\]/gi, "")
    .replace(/\[\[voice\]\]/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim() || (hasVoice ? "[语音]" : "[表情]");
  saveMessage(userId, characterId, "assistant", cleanReply);

  // 观察这条消息：更新心情、记录偏好/冲突事件（纯规则，不调模型）
  observe(userId, userMessage, reply);
  // 关系里程碑：第一次见面、表白、吵架和好、生日等
  observeMilestone(userId, userMessage);

  // 提到承诺/约定时立即提取一次，避免因为没到 20 条漏掉
  if (/(答应|约好|说好|约定|纪念日|生日)/.test(userMessage)) {
    tryExtractFacts(userId, characterId).catch(() => {});
  }

  // 智能事实提取（每 20 条触发）
  const counterKey = `${userId}_${characterId}`;
  const currentCount = getMessageCount(userId, characterId);
  const lastExtracted = factExtractCounter.get(counterKey) || 0;
  if (currentCount - lastExtracted >= 20) {
    await tryExtractFacts(userId, characterId);
    factExtractCounter.set(counterKey, currentCount);
  }

  return reply;
}

async function trySummarize(userId, characterId) {
  const raw = getMessagesForSummarization(userId, characterId);
  if (!raw || raw.length < 100) return;

  const prompt = `你是一个摘要助手。把下面的对话历史压缩成一段 150-250 字的中文摘要。重点保留：对方提到的个人信息、重要事件和约定、互动亮点、对方情绪状态。\n\n对话：\n${raw.slice(-3000)}\n\n只输出摘要文本，不要其他内容。`;

  try {
    const summary = await chat(
      "你是一个摘要助手。输出纯文本，不要任何格式。",
      [{ role: "user", content: prompt }],
      { maxTokens: 400, label: "summarize" }
    );
    if (summary && summary.length > 20) {
      saveSummary(userId, characterId, summary);
      trimMessages(userId, characterId, 20);
      console.log("[Agent] 摘要已生成:", summary.slice(0, 60) + "...");
    }
  } catch (err) {
    console.error("[Agent] 摘要生成失败:", err.message);
  }
}

function extractSearchKeywords(text) {
  return text
    .replace(/[？?！!。.，,~～]+/g, " ")
    .replace(/(帮我|请|搜一下|查一下|搜索|什么是|什么叫|怎么样|为什么|是什么)/g, "")
    .trim()
    .slice(0, 120);
}

export async function tryExtractFacts(userId, characterId) {
  const recent = getRecentMessages(userId, characterId, 40);
  const existing = getMemories(userId, characterId, 40);

  const historyStr = recent
    .map(m => `${m.role === "user" ? "对方" : "助手"}: ${m.content.slice(0, 200)}`)
    .join("\n");

  const existingStr = existing.length > 0
    ? "已有记忆：\n" + existing.map(m => `- [${m.category}] ${m.key}: ${m.value}`).join("\n")
    : "";

  const prompt = `分析对话，提取关于对方（用户）的长期信息，以及你答应对方的事。
${existingStr}
最近对话（“对方”=用户，“助手”=你）：
${historyStr.slice(-4000)}

返回 JSON 数组，每个条目格式：
{"category":"event|preference|emotion|relationship|daily|promise","key":"简短标签","value":"具体内容","importance":0-100}

规则：
- 只提取关于对方的信息，以及“你答应对方”的承诺；不要提取你的角色设定、自称、外貌、口头禅、AI 身份
- 不要提取你自己的一般行为（摸鱼、吃饭、发动态失败等），除非那是你答应对方的具体承诺
- key 用 4~12 字标签；value 用一句具体的话，尽量带时间、对象、细节
- 没有新信息返回 []

分类说明：
- promise：你答应对方的事、约定、纪念日、生日
- relationship：你和对方的关系变化、称呼、亲密度相关
- event：对方经历或你们共同经历的重要事件
- preference：对方的喜好、厌恶、习惯
- emotion：对方当时的情绪或情绪触发点
- daily：对方的日常琐事、吃了什么、去了哪里

示例：
{"category":"promise","key":"周六吃饭","value":"你答应周六下午陪对方吃饭","importance":90}
{"category":"preference","key":"喜欢猫","value":"对方喜欢猫，家里养了一只橘猫","importance":60}

重要度参考：承诺 80-100，关系 70-90，事件 60-80，偏好 50-70，情绪 40-60，日常 20-40。
只输出 JSON 数组。`;

  try {
    const result = await chat(
      "你是一个只输出 JSON 数组的信息提取助手，不输出其他内容。",
      [{ role: "user", content: prompt }],
      { maxTokens: 700, temperature: 0.2, label: "extract-memory" }
    );
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      let added = 0;
      for (const item of parsed) {
        if (!item?.key || !item?.value) continue;
        saveMemory({
          userId, characterId,
          category: item.category,
          key: item.key,
          value: item.value,
          importance: item.importance,
          source: "chat",
        });
        added++;
      }
      if (added > 0) console.log(`[记忆] 新增/更新 ${added} 条`);
    }
  } catch {
    // 静默忽略
  }
}
