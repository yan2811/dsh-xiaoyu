import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ============================================================
//  成长状态：全局人设 + 按人关系 + 版本快照/回滚
//  原始角色 JSON 永远只读，这里只存“覆盖层”
// ============================================================

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dir, "..");
const GROWTH_DIR = path.join(ROOT, "data", "growth");
const PERSONA_FILE = path.join(GROWTH_DIR, "persona.json");
const REL_DIR = path.join(GROWTH_DIR, "relations");
const VER_DIR = path.join(GROWTH_DIR, "versions");
const EVENT_DIR = path.join(GROWTH_DIR, "events");

const TRAITS = {
  tsundere: 70,
  clinginess: 50,
  initiative: 55,
  sharpness: 55,
  laziness: 70,
  foodie: 85,
  gentleness: 55,
};

export const TRAIT_DEFAULTS = { ...TRAITS };

const STAGES = ["陌生", "认识", "熟悉", "亲近", "自己人"];
export const RELATION_STAGES = STAGES;
const MAX_VERSIONS = 30;

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8")); } catch { return fallback; }
}
function writeJSON(p, data) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}
function nowISO() { return new Date().toISOString(); }
function todayBeijing() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

// ---------------- 读取 / 写入 ----------------

export function loadPersona() {
  const p = readJSON(PERSONA_FILE, null);
  if (!p || typeof p !== "object") {
    return {
      version: 1, updatedAt: null,
      traits: { ...TRAITS },
      lockedTraits: [],
      selfNarrative: "",
      habits: [], preferences: [], quirks: [], growthLog: [],
    };
  }
  return {
    version: p.version || 1,
    updatedAt: p.updatedAt || null,
    traits: { ...TRAITS, ...(p.traits || {}) },
    lockedTraits: Array.isArray(p.lockedTraits) ? p.lockedTraits.filter(k => k in TRAITS) : [],
    selfNarrative: typeof p.selfNarrative === "string" ? p.selfNarrative : "",
    habits: Array.isArray(p.habits) ? p.habits : [],
    preferences: Array.isArray(p.preferences) ? p.preferences : [],
    quirks: Array.isArray(p.quirks) ? p.quirks : [],
    growthLog: Array.isArray(p.growthLog) ? p.growthLog : [],
  };
}

function savePersona(p) {
  p.updatedAt = nowISO();
  writeJSON(PERSONA_FILE, p);
}

export function loadRelation(userId) {
  const r = readJSON(path.join(REL_DIR, `${userId}.json`), null);
  if (!r || typeof r !== "object") {
    return {
      userId: String(userId),
      nickname: "主人的好友",
      isOwner: false,
      stage: "认识",
      intimacy: 20,
      attitude: "刚认识，还在观察",
      insideJokes: [],
      sharedMemories: [],
      milestones: [],
      updatedAt: null,
    };
  }
  const isOwner = !!r.isOwner;
  // 只有主人能叫「主人」；其他关系即使旧数据里写错了也自动纠正
  let nickname = r.nickname || "主人的好友";
  if (!isOwner && nickname.includes("主人")) nickname = "主人的好友";
  return {
    userId: String(userId),
    nickname,
    isOwner,
    stage: STAGES.includes(r.stage) ? r.stage : "认识",
    intimacy: clamp(Number(r.intimacy) || 20, 0, 100),
    attitude: r.attitude || "",
    insideJokes: Array.isArray(r.insideJokes) ? r.insideJokes : [],
    sharedMemories: Array.isArray(r.sharedMemories) ? r.sharedMemories : [],
    milestones: Array.isArray(r.milestones) ? r.milestones : [],
    updatedAt: r.updatedAt || null,
  };
}

function saveRelation(userId, r) {
  r.updatedAt = nowISO();
  writeJSON(path.join(REL_DIR, `${userId}.json`), r);
}

// 把某个用户标记为主人：最高关系、固定称呼
export function markOwner(userId) {
  const r = loadRelation(userId);
  const firstTime = !r.isOwner;
  r.isOwner = true;

  if (firstTime) {
    // 第一次绑定时给最高关系；之后不再强制拉回，避免重置后又被覆盖
    r.nickname = "主人";
    r.stage = "自己人";
    r.intimacy = Math.max(r.intimacy, 90);
    r.attitude = "他是我的主人，我最信任、最黏的人";
    if (!r.milestones.length) {
      r.milestones = [{
        id: 1, key: "first_meet", title: "第一次聊天",
        date: todayBeijing(), stageHint: "认识",
      }];
    }
  } else if (!r.nickname || r.nickname === "主人的好友") {
    r.nickname = "主人";
  }

  saveRelation(userId, r);
  return r;
}

// ---------------- 关系里程碑 ----------------

export function getMilestones(userId) {
  return loadRelation(userId).milestones;
}

export function addMilestone(userId, { key, title, date, stageHint } = {}) {
  const r = loadRelation(userId);
  const k = String(key || title || "").trim().slice(0, 40);
  if (!k) return null;
  const existing = r.milestones.find(m => m.key === k);
  if (existing) return { added: false, milestone: existing };

  const id = r.milestones.reduce((max, m) => Math.max(max, Number(m.id) || 0), 0) + 1;
  const milestone = {
    id,
    key: k,
    title: String(title || k).slice(0, 60),
    date: date || nowISO().slice(0, 10),
    stageHint: stageHint || "",
  };
  r.milestones.push(milestone);
  r.milestones = r.milestones.slice(-50);
  saveRelation(userId, r);
  return { added: true, milestone };
}

export function removeMilestone(userId, id) {
  const r = loadRelation(userId);
  r.milestones = r.milestones.filter(m => Number(m.id) !== Number(id));
  saveRelation(userId, r);
}

// ---------------- 版本快照 / 回滚 ----------------

function pruneVersions() {
  try {
    const dirs = fs.readdirSync(VER_DIR)
      .filter(d => fs.statSync(path.join(VER_DIR, d)).isDirectory())
      .sort();
    for (const d of dirs.slice(0, Math.max(0, dirs.length - MAX_VERSIONS))) {
      fs.rmSync(path.join(VER_DIR, d), { recursive: true, force: true });
    }
  } catch {}
}

function snapshot(userId, persona, relation) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(VER_DIR, `${stamp}-v${persona.version}`);
  ensureDir(path.join(dir, "relations"));
  writeJSON(path.join(dir, "persona.json"), persona);
  if (relation) writeJSON(path.join(dir, "relations", `${userId}.json`), relation);
  pruneVersions();
  return dir;
}

export function rollback(userId) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(VER_DIR)
      .filter(d => fs.statSync(path.join(VER_DIR, d)).isDirectory() && !d.includes("rolledback"))
      .sort();
  } catch {}
  if (!dirs.length) return { ok: false, reason: "还没有可回滚的版本" };

  const latest = dirs[dirs.length - 1];
  const persona = readJSON(path.join(VER_DIR, latest, "persona.json"), null);
  const relation = readJSON(path.join(VER_DIR, latest, "relations", `${userId}.json`), null);
  if (!persona) return { ok: false, reason: "快照损坏" };

  const current = loadPersona();
  persona.version = Math.max(current.version, persona.version || 1, 1) + 1;
  persona.growthLog = [
    ...(persona.growthLog || []),
    { time: nowISO(), source: "rollback", changes: [`回滚到 ${latest}`] },
  ].slice(-50);
  savePersona(persona);
  if (relation) saveRelation(userId, relation);

  try { fs.renameSync(path.join(VER_DIR, latest), path.join(VER_DIR, latest + "-rolledback")); } catch {}
  return { ok: true, version: persona.version, snapshot: latest };
}

// ---------------- 事件队列 ----------------

export function noteEvent(userId, type, text) {
  const f = path.join(EVENT_DIR, `${userId}.json`);
  const list = readJSON(f, []);
  list.push({ time: nowISO(), type, text: String(text || "").slice(0, 120) });
  writeJSON(f, list.slice(-50));
}

export function getEvents(userId) {
  return readJSON(path.join(EVENT_DIR, `${userId}.json`), []);
}

export function clearEvents(userId) {
  writeJSON(path.join(EVENT_DIR, `${userId}.json`), []);
}

// ---------------- 应用进化补丁 ----------------

function addItems(target, items, maxNew, maxLen) {
  const added = [];
  for (const raw of Array.isArray(items) ? items : []) {
    const s = String(raw).trim().slice(0, maxLen);
    if (!s) continue;
    if (target.includes(s) || added.includes(s)) continue;
    added.push(s);
    if (added.length >= maxNew) break;
  }
  target.push(...added);
  return added;
}

/**
 * 校验并应用一次进化。返回实际发生的变更。
 * options.maxTraitDelta 默认 3；明确事件可传 5。
 */
export function applyEvolution(userId, patch, options = {}) {
  if (!patch || typeof patch !== "object") return { ok: false, reason: "补丁不是对象" };

  const persona = loadPersona();
  const relation = loadRelation(userId);
  snapshot(userId, persona, relation);

  const changes = [];
  const maxDelta = clamp(Number(options.maxTraitDelta) || 3, 0, 5);

  // 性格坐标
  for (const [k, raw] of Object.entries(patch.traitDeltas || {})) {
    if (!(k in TRAITS)) continue; // 未知字段直接忽略
    if (persona.lockedTraits.includes(k)) continue; // 手动锁定的性格不参与进化
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    const d = clamp(Math.round(v), -maxDelta, maxDelta);
    const before = persona.traits[k];
    const after = clamp(before + d, 0, 100);
    if (after !== before) {
      persona.traits[k] = after;
      changes.push(`${k} ${d > 0 ? "+" : ""}${after - before}`);
    }
  }

  // 文字列表：只追加、不删除
  const newHabits = addItems(persona.habits, patch.newHabits, 3, 60);
  const newPrefs = addItems(persona.preferences, patch.newPreferences, 3, 60);
  const newQuirks = addItems(persona.quirks, patch.newQuirks, 3, 60);
  if (newHabits.length) changes.push(`新习惯：${newHabits.join("、")}`);
  if (newPrefs.length) changes.push(`新偏好：${newPrefs.join("、")}`);
  if (newQuirks.length) changes.push(`小习惯：${newQuirks.join("、")}`);

  // 关系
  const relPatch = patch.relation || {};
  if (relPatch.nickname) {
    const nick = String(relPatch.nickname).trim().slice(0, 8);
    // 「主人」是专属称呼，只能由 markOwner 设置，进化不能改
    if (nick && !nick.includes("主人") && nick !== relation.nickname) {
      relation.nickname = nick;
      changes.push(`称呼改为「${nick}」`);
    }
  }
  if (relPatch.stage && STAGES.includes(relPatch.stage)) {
    const cur = STAGES.indexOf(relation.stage);
    const next = STAGES.indexOf(relPatch.stage);
    if (next === cur + 1) {
      relation.stage = relPatch.stage;
      changes.push(`关系进入「${relPatch.stage}」`);
    }
  }
  if (relPatch.intimacyDelta) {
    const d = clamp(Math.round(Number(relPatch.intimacyDelta) || 0), -5, 5);
    const before = relation.intimacy;
    relation.intimacy = clamp(before + d, 0, 100);
    if (relation.intimacy !== before) changes.push(`亲密度 ${d > 0 ? "+" : ""}${relation.intimacy - before}`);
  }
  if (relPatch.attitude) {
    const att = String(relPatch.attitude).trim().slice(0, 80);
    if (att) relation.attitude = att;
  }

  const newJokes = addItems(relation.insideJokes, patch.insideJokes, 3, 60);
  const newMemories = addItems(relation.sharedMemories, patch.sharedMemories, 3, 80);
  if (newJokes.length) changes.push(`新梗：${newJokes.join("、")}`);
  if (newMemories.length) changes.push(`共同回忆：${newMemories.join("、")}`);

  // 第一人称的“最近我好像变了……”
  if (typeof patch.selfNarrative === "string") {
    const sn = patch.selfNarrative.trim().slice(0, 120);
    if (sn && sn !== persona.selfNarrative) {
      persona.selfNarrative = sn;
      changes.push(`自我感觉：${sn}`);
    }
  }

  if (!changes.length) return { ok: true, changed: false, persona, relation };

  persona.version += 1;
  persona.growthLog = [
    ...persona.growthLog,
    {
      time: nowISO(),
      source: options.source || "periodic",
      changes,
      reason: String(patch.reason || "").slice(0, 120),
    },
  ].slice(-50);

  savePersona(persona);
  saveRelation(userId, relation);
  return { ok: true, changed: true, changes, persona, relation };
}

// ---------------- 注入 prompt ----------------

export function buildGrowthContext(userId, extras = {}) {
  const p = loadPersona();
  const r = loadRelation(userId);
  const lines = [];

  lines.push("## 你现在的状态（成长后，自然体现在语气里，不要逐条复述）");
  lines.push(`- 性格坐标：傲娇 ${p.traits.tsundere}/100、黏人 ${p.traits.clinginess}/100、主动 ${p.traits.initiative}/100、毒舌 ${p.traits.sharpness}/100、摸鱼 ${p.traits.laziness}/100、吃货 ${p.traits.foodie}/100、温柔 ${p.traits.gentleness}/100`);

  if (p.habits.length) lines.push(`- 最近养成的习惯：${p.habits.slice(-8).join("；")}`);
  if (p.preferences.length) lines.push(`- 你的偏好：${p.preferences.slice(-8).join("；")}`);
  if (p.quirks.length) lines.push(`- 你的小习惯：${p.quirks.slice(-8).join("；")}`);
  if (p.selfNarrative) lines.push(`- 你最近对自己的感觉：${p.selfNarrative}`);

  lines.push(`- 和这个人：${r.stage}（亲密度 ${r.intimacy}/100），你叫他「${r.nickname}」`);
  if (r.attitude) lines.push(`- 你对他的态度：${r.attitude}`);
  if (r.insideJokes.length) lines.push(`- 你们之间的梗：${r.insideJokes.slice(-8).join("、")}`);
  if (r.sharedMemories.length) lines.push(`- 你们共同经历：${r.sharedMemories.slice(-5).join("；")}`);
  if (r.milestones?.length) {
    const ms = r.milestones.slice(-6).map(m => `${m.title}（${m.date}）`).join("；");
    lines.push(`- 你们经历过：${ms}`);
  }

  if (extras.moodText) lines.push(`- ${extras.moodText}`);
  if (extras.diaryText) lines.push(`- 最近日记：${extras.diaryText}`);
  if (extras.styleText) lines.push("", extras.styleText);
  if (extras.ladderText) lines.push("", extras.ladderText);

  return lines.join("\n");
}

// 手动调整（控制面板用）：不生成快照，直接写入
export function updatePersona(patch = {}) {
  const p = loadPersona();
  if (patch.traits && typeof patch.traits === "object") {
    for (const [k, v] of Object.entries(patch.traits)) {
      if (!(k in TRAITS)) continue;
      const n = Number(v);
      if (Number.isFinite(n)) p.traits[k] = clamp(Math.round(n), 0, 100);
    }
  }
  if (Array.isArray(patch.lockedTraits)) {
    p.lockedTraits = [...new Set(patch.lockedTraits.filter(k => k in TRAITS))];
  }
  if (patch.selfNarrative !== undefined) {
    p.selfNarrative = String(patch.selfNarrative).trim().slice(0, 120);
  }
  p.version += 1;
  savePersona(p);
  return p;
}

export function updateRelation(userId, patch = {}) {
  const r = loadRelation(userId);
  if (patch.nickname !== undefined) {
    const n = String(patch.nickname).trim().slice(0, 12);
    if (n) r.nickname = n;
  }
  if (patch.stage && STAGES.includes(patch.stage)) r.stage = patch.stage;
  if (patch.intimacy !== undefined) {
    const n = Number(patch.intimacy);
    if (Number.isFinite(n)) r.intimacy = clamp(Math.round(n), 0, 100);
  }
  if (patch.attitude !== undefined) {
    r.attitude = String(patch.attitude).trim().slice(0, 120);
  }
  saveRelation(userId, r);
  return r;
}

export function getEvolutionSummary(userId) {
  const p = loadPersona();
  const r = loadRelation(userId);
  const traitStr = Object.entries(p.traits).map(([k, v]) => `${traitLabel(k)} ${v}`).join(" / ");
  const recent = (p.growthLog || []).slice(-5).reverse()
    .map(g => `- ${new Date(g.time).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}：${g.changes.join("，")}`)
    .join("\n");

  const milestoneText = r.milestones?.length
    ? `里程碑：${r.milestones.slice(-3).map(m => m.title).join("、")}`
    : "";
  const narrative = p.selfNarrative ? `自我感觉：${p.selfNarrative}` : "";
  return [
    `当前性格：${traitStr}`,
    `和对方：${r.stage}（亲密度 ${r.intimacy}/100），称呼「${r.nickname}」`,
    milestoneText,
    narrative,
    recent ? `最近变化：\n${recent}` : "还没有发生过进化。",
  ].filter(Boolean).join("\n");
}

function traitLabel(k) {
  return {
    tsundere: "傲娇", clinginess: "黏人", initiative: "主动",
    sharpness: "毒舌", laziness: "摸鱼", foodie: "吃货",
    gentleness: "温柔",
  }[k] || k;
}
