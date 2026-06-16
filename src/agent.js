import { buildSystemPrompt, buildCharacterPrompt } from "./personality.js";
import { chat } from "./ai-client.js";
import {
  saveMessage, getMessageCount, getRecentMessages,
  needsSummarization, saveSummary, trimMessages, getMessagesForSummarization,
  saveFact, getFacts, buildContext,
} from "./memory.js";
import { shouldSearch, searchWeb } from "./search.js";

// 跟踪上次提取事实的消息数
const factExtractCounter = new Map();

export async function handleMessage(userId, characterId, userMessage, characterProfilePath, imageDesc) {
  saveMessage(userId, characterId, "user", userMessage);

  // 联网搜索检测
  let searchResult = null;
  if (shouldSearch(userMessage)) {
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
  const { contextText, l1Messages } = buildContext(userId, characterId);
  let systemPrompt;
  if (characterProfilePath) {
    systemPrompt = buildCharacterPrompt(characterProfilePath);
  } else {
    systemPrompt = buildSystemPrompt();
  }
  if (contextText) {
    systemPrompt += "\n\n" + contextText;
  }
  if (searchResult) {
    systemPrompt += `\n\n## 关于对方刚才提到的话题，你联网查到的信息\n${searchResult}\n\n用这些信息自然地回应，不要说"根据搜索结果"，就像你本来就知道一样。`;
  }
  if (imageDesc) {
    systemPrompt += `\n\n## 对方刚刚发了一张图片\n图片内容: ${imageDesc}\n\n请自然地回应这张图片，就像你真的看到了它一样。可以直接点评图片内容、吐槽、关心等。`;
  }

  // 构建消息列表
  const messages = l1Messages.map(m => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: m.content,
  }));

  // 调用 AI
  const reply = await chat(systemPrompt, messages);

  saveMessage(userId, characterId, "assistant", reply);

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
      { maxTokens: 400 }
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

async function tryExtractFacts(userId, characterId) {
  const recent = getRecentMessages(userId, characterId, 30);
  const existingFacts = getFacts(userId, characterId);

  const historyStr = recent
    .map(m => `${m.role === "user" ? "对方" : "助手"}: ${m.content.slice(0, 200)}`)
    .join("\n");

  const existingStr = existingFacts.length > 0
    ? "已知信息：\n" + existingFacts.map(f => `- ${f.key}: ${f.value}`).join("\n")
    : "";

  const prompt = `分析对话，提取关于对方的新信息或更新的信息。\n${existingStr}\n最近对话：\n${historyStr.slice(-3000)}\n返回 JSON 数组。每个条目格式：{"key": "分类", "value": "具体内容"}。如果没有新信息，返回空数组 []。只输出 JSON 数组。`;

  try {
    const result = await chat(
      "你是一个信息提取助手。只输出 JSON 数组，不输出其他内容。",
      [{ role: "user", content: prompt }],
      { maxTokens: 300 }
    );
    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      for (const fact of parsed) {
        if (fact.key && fact.value) {
          saveFact(userId, characterId, fact.key, fact.value);
        }
      }
      if (parsed.length > 0) {
        console.log(`[Agent] 记住 ${parsed.length} 条新信息`);
      }
    }
  } catch {
    // 静默忽略
  }
}
