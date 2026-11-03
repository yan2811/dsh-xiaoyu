import OpenAI from "openai";
import fs from "node:fs";
import path from "node:path";

let client = null;

// ==================== 用量记账 ====================
// 每次调用都记一笔，落盘到 data/usage.json，按天累计。
// 想看某天花了多少：node scripts/usage-report.js
const USAGE_FILE = path.join(process.cwd(), "data", "usage.json");

// ==================== 计费 ====================
// DeepSeek 2026-08 官方价（美元 / 百万 token，非高峰）。
// 高峰时段（北京时间工作日 9-12、14-18）官方按 2 倍计费。
// 价格会变，可用环境变量覆盖。
const PRICE = {
  inputMiss: Number(process.env.DEEPSEEK_PRICE_INPUT_MISS || 0.22),
  inputHit: Number(process.env.DEEPSEEK_PRICE_INPUT_HIT || 0.007),
  output: Number(process.env.DEEPSEEK_PRICE_OUTPUT || 0.66),
};
const USD_CNY = Number(process.env.DEEPSEEK_USD_CNY || 7.2);

function isPeakTime() {
  const bj = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  const day = bj.getDay(); // 0=周日
  const h = bj.getHours() + bj.getMinutes() / 60;
  return day >= 1 && day <= 5 && ((h >= 9 && h < 12) || (h >= 14 && h < 18));
}

function estimateCost(usage) {
  const hit = usage.prompt_cache_hit_tokens || 0;
  const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, (usage.prompt_tokens || 0) - hit);
  const out = usage.completion_tokens || 0;
  const mult = isPeakTime() ? 2 : 1;
  const usd = ((hit * PRICE.inputHit + miss * PRICE.inputMiss + out * PRICE.output) / 1e6) * mult;
  return usd * USD_CNY;
}

function todayKey() {
  // 用北京时间的日期做 key，和服务器时区无关
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

function recordUsage(usage, label) {
  if (!usage) return;
  const pin = usage.prompt_tokens || 0;
  const pout = usage.completion_tokens || 0;
  // DeepSeek 的上下文缓存：命中部分便宜得多，不分开记会算贵
  const hit = usage.prompt_cache_hit_tokens || 0;
  const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, pin - hit);
  const cost = estimateCost(usage);
  const peak = isPeakTime() ? " 高峰" : "";

  console.log(`[用量] ${label} 输入=${pin}(命中${hit}/未命中${miss}) 输出=${pout} 费用≈¥${cost.toFixed(6)}${peak}`);

  try {
    let all = {};
    if (fs.existsSync(USAGE_FILE)) {
      all = JSON.parse(fs.readFileSync(USAGE_FILE, "utf-8"));
    }
    const day = all[todayKey()] || { calls: 0, in: 0, out: 0, hit: 0, cost: 0 };
    day.calls += 1;
    day.in += pin;
    day.out += pout;
    day.hit += hit;
    day.cost = (day.cost || 0) + cost;
    all[todayKey()] = day;

    fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
    fs.writeFileSync(USAGE_FILE, JSON.stringify(all, null, 2));
  } catch (e) {
    console.error("[用量] 记账失败:", e.message);
  }
}

export function getClient() {
  if (!client) {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey || apiKey === "sk-your-deepseek-api-key") {
      throw new Error(
        "请先设置 DEEPSEEK_API_KEY 环境变量，或复制 .env.example 为 .env 并填入你的 API Key"
      );
    }
    client = new OpenAI({
      apiKey,
      baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com/v1",
    });
  }
  return client;
}

export async function chat(systemPrompt, messages, options = {}) {
  const client = getClient();
  const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";
  const maxTokens = options.maxTokens || 512;

  const response = await client.chat.completions.create({
    model,
    max_tokens: maxTokens,
    temperature: options.temperature ?? 0.85,
    messages: [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
    ],
  });

  // label 用于区分是哪种调用（聊天 / 摘要 / 提取事实），
  // 这三者成本差别很大，混在一起就查不出钱花在哪了
  recordUsage(response.usage, options.label || "chat");

  return response.choices[0]?.message?.content || "";
}
