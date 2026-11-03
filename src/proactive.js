import { chat } from "./ai-client.js";

// AI 生成主动消息（基于角色人设 + 上下文 + 时间）
export async function generateProactiveMessage(lastUserMsg, facts, pref, systemPrompt) {
  const now = new Date();
  const beijingTime = now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", weekday: "long", hour: "2-digit", minute: "2-digit" });

  let context = `## 当前时间\n现在是${beijingTime}。`;
  if (facts && facts.length > 0) {
    context += `\n\n## 你记得关于对方的事\n${facts.map(f => `- ${f.key}: ${f.value}`).join("\n")}`;
  }
  if (lastUserMsg) {
    context += `\n\n## 对方最后发的内容\n"${lastUserMsg.slice(0, 60)}"`;
  }

  const prompt = `${systemPrompt}\n\n${context}\n\n【任务】你现在想主动给对方发一条消息。你已经有一阵子没和对方聊天了。\n要求：
- 像真人一样自然，是你主动找他/她聊天，不是在回复消息
- 符合你的性格和说话风格
- 可以分享你现在在干嘛、突然想到什么、或者关心一下对方
- 简短，1-3句话，不要写小作文
- 保持你的语气和用词习惯；不要使用任何 emoji，情绪用文字表达
- 如果是顾昀迟或晏烬这类话少的角色，保持极度简短
- 禁止使用|||拆分消息，这是一条单独的短消息，直接输出完整文本
- 直接输出消息内容，不要加任何前缀说明`;

  try {
    const msg = await chat("你是一个AI助手。只输出消息内容本身，不要加任何前缀、引号、说明。", [
      { role: "user", content: prompt }
    ], { maxTokens: 100 });
    if (msg && msg.trim()) {
      console.log("[主动消息] AI生成: " + msg.trim().slice(0, 50) + "...");
      return msg.trim();
    }
  } catch (e) {
    console.log("[主动消息] AI生成失败: " + e.message);
  }
  return null;
}
