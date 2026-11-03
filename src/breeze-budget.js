import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// BreezeBlue 积分预算：按字数估算，避免一天把 400 积分聊爆。
// 实测约 0.184 积分/字，这里取 0.185 做保守估计。
const __dir = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(__dir, "..", "data", "growth", "breeze-usage.json");
const CREDITS_PER_CHAR = 0.185;
const KEEP_DAYS = 30;

function todayKey() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

function load() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, "utf-8"));
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

function save(all) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    for (const [day, v] of Object.entries(all)) {
      const t = Date.parse(day + "T00:00:00+08:00");
      if (Number.isFinite(t) && t < cutoff) delete all[day];
    }
    fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
  } catch (e) {
    console.error("[Breeze] 预算记录失败:", e.message);
  }
}

export function estimateBreezeCredits(chars) {
  const n = Math.max(1, Number(chars) || 0);
  return Math.max(0.1, Math.round(n * CREDITS_PER_CHAR * 10) / 10);
}

export function getBreezeUsage() {
  const all = load();
  const date = todayKey();
  const v = all[date] || {};
  return {
    date,
    credits: Number(v.credits) || 0,
    calls: Number(v.calls) || 0,
  };
}

export function canSpendBreeze(credits, budget) {
  const b = Number(budget);
  if (!Number.isFinite(b) || b <= 0) return false;
  const used = getBreezeUsage().credits;
  return used + Math.max(0, Number(credits) || 0) <= b;
}

export function recordBreezeUsage(credits) {
  const all = load();
  const date = todayKey();
  const v = all[date] || { credits: 0, calls: 0 };
  v.credits = Math.round((Number(v.credits) + Math.max(0, Number(credits) || 0)) * 10) / 10;
  v.calls = (Number(v.calls) || 0) + 1;
  all[date] = v;
  save(all);
  return { date, ...v };
}

export function getBreezeBudgetSummary(budget) {
  const usage = getBreezeUsage();
  const b = Number(budget);
  const remaining = Number.isFinite(b) && b > 0 ? Math.max(0, Math.round((b - usage.credits) * 10) / 10) : 0;
  return { ...usage, budget: Number.isFinite(b) ? b : 0, remaining };
}
