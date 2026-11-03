#!/usr/bin/env node
/**
 * 用量与成本报表。
 *
 * 数据来自 data/usage.json —— ai-client.js 每次调 DeepSeek 时累计。
 *
 * 用法:
 *   node scripts/usage-report.js            今天
 *   node scripts/usage-report.js --all      所有有记录的日子
 *   node scripts/usage-report.js 2026-09-27 指定日期
 *
 * 价格可用环境变量覆盖，避免哪天调价了这个脚本悄悄算错：
 *   PRICE_IN_MISS / PRICE_IN_HIT / PRICE_OUT   （单位：元/百万 token）
 */
import fs from "node:fs";
import path from "node:path";

// DeepSeek deepseek-chat（即 V4-Flash）闲时价，元/百万 token。
// 高峰时段（周一至周五 9:00-12:00、14:00-18:00）是闲时的 2 倍。
const PRICE = {
  命中: Number(process.env.PRICE_IN_HIT || 0.02),
  未命中: Number(process.env.PRICE_IN_MISS || 1),
  输出: Number(process.env.PRICE_OUT || 4),
};

// 阿里云 qwen3-asr-flash，元/秒（每月前 36000 秒免费，这里不扣减，只报原价）
const ASR_PER_SEC = 0.00022;

const USAGE_FILE = path.join(process.cwd(), "data", "usage.json");
const ASR_FILE = path.join(process.cwd(), "data", "asr-usage.json");

function load(file) {
  try {
    if (!fs.existsSync(file)) return {};
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (e) {
    console.error(`读取 ${file} 失败: ${e.message}`);
    return {};
  }
}

function money(day, asrSeconds) {
  const hit = day.hit || 0;
  const miss = Math.max(0, (day.in || 0) - hit);
  const cIn = (hit / 1e6) * PRICE.命中 + (miss / 1e6) * PRICE.未命中;
  const cOut = ((day.out || 0) / 1e6) * PRICE.输出;
  const cAsr = (asrSeconds || 0) * ASR_PER_SEC;
  return { cIn, cOut, cAsr, total: cIn + cOut + cAsr };
}

function fmt(n) {
  return "¥" + n.toFixed(6);
}

function reportDay(date, day, asrSeconds) {
  const m = money(day, asrSeconds);
  const calls = day.calls || 0;
  console.log(`\n📅 ${date}`);
  console.log(`   调用次数   ${calls}`);
  console.log(`   输入 token ${day.in || 0}  (缓存命中 ${day.hit || 0})`);
  console.log(`   输出 token ${day.out || 0}`);
  if (asrSeconds) console.log(`   语音时长   ${asrSeconds.toFixed(1)} 秒`);
  console.log(`   输入费用   ${fmt(m.cIn)}`);
  console.log(`   输出费用   ${fmt(m.cOut)}`);
  if (m.cAsr > 0) console.log(`   语音费用   ${fmt(m.cAsr)}`);
  console.log(`   合计       ${fmt(m.total)}`);
  if (calls > 0) console.log(`   单次平均   ${fmt(m.total / calls)}`);
  return m;
}

const args = process.argv.slice(2);
const all = load(USAGE_FILE);
const asrAll = load(ASR_FILE);

if (Object.keys(all).length === 0) {
  console.log("还没有用量记录。");
  console.log("说明：埋点写在 src/ai-client.js 里，需要部署到服务器并产生对话后才有数据。");
  process.exit(0);
}

const dates = args.includes("--all")
  ? Object.keys(all).sort()
  : args.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
if (dates.length === 0) {
  dates.push(new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }));
}

console.log("=".repeat(46));
console.log("蓝小梦 用量报表");
console.log(`计价假设: 输入未命中 ${PRICE.未命中} / 命中 ${PRICE.命中} / 输出 ${PRICE.输出} 元每百万 token`);
console.log(`          (DeepSeek 闲时价；高峰时段×2。语音 ${ASR_PER_SEC} 元/秒，每月前 36000 秒免费)`);
console.log("=".repeat(46));

let sum = 0;
for (const d of dates) {
  if (!all[d]) {
    console.log(`\n📅 ${d}\n   （无记录）`);
    continue;
  }
  sum += reportDay(d, all[d], asrAll[d]?.seconds).total;
}

if (dates.length > 1) {
  console.log("\n" + "=".repeat(46));
  console.log(`合计 ${fmt(sum)}`);
}
