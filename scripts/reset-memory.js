import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDB } from "../src/db.js";

// ============================================================
//  清空对话与记忆，保留人设/角色/设置/表情包
//  用法：node scripts/reset-memory.js --yes
// ============================================================

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const GROWTH = path.join(DATA, "growth");
const OWNER_QQ = process.env.QQ_OWNER_ID || "2811534319";

if (!process.argv.includes("--yes")) {
  console.log("这会清空对话、记忆、表达学习、日记和情绪。");
  console.log("确认请运行：node scripts/reset-memory.js --yes");
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backup = path.join(DATA, "backups", `reset-${stamp}`);
fs.mkdirSync(backup, { recursive: true });

for (const f of ["chat.db", "chat.db-wal", "chat.db-shm"]) {
  const src = path.join(DATA, f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(backup, f));
}
if (fs.existsSync(GROWTH)) {
  fs.cpSync(GROWTH, path.join(backup, "growth"), { recursive: true });
}
console.log("备份:", backup);

const db = getDB();
db.exec(`
  DELETE FROM messages;
  DELETE FROM summaries;
  DELETE FROM facts;
  DELETE FROM memories;
`);
try { db.exec("VACUUM"); } catch {}

fs.mkdirSync(GROWTH, { recursive: true });
fs.writeFileSync(path.join(GROWTH, "mood.json"), JSON.stringify({
  value: 0,
  energy: 70,
  emotions: { happy: 0, angry: 0, sad: 0, shy: 0, proud: 0, tired: 0, jealous: 0, clingy: 0 },
  causes: {},
  updatedAt: new Date().toISOString(),
}, null, 2));

for (const dir of ["style", "diary", "counters", "events"]) {
  const d = path.join(GROWTH, dir);
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (fs.statSync(p).isFile()) fs.unlinkSync(p);
  }
}

const relDir = path.join(GROWTH, "relations");
fs.mkdirSync(relDir, { recursive: true });
const owner = db.prepare("SELECT id FROM users WHERE username = ?").get(`qq_${OWNER_QQ}`);
const ownerId = owner ? owner.id : null;

for (const f of fs.readdirSync(relDir)) {
  if (!f.endsWith(".json")) continue;
  const p = path.join(relDir, f);
  if (ownerId && f === `${ownerId}.json`) {
    fs.writeFileSync(p, JSON.stringify({
      userId: String(ownerId),
      nickname: "主人",
      isOwner: true,
      stage: "认识",
      intimacy: 20,
      attitude: "重新开始，慢慢认识",
      insideJokes: [],
      sharedMemories: [],
      milestones: [],
      updatedAt: new Date().toISOString(),
    }, null, 2));
  } else {
    fs.unlinkSync(p);
  }
}

if (ownerId && !fs.existsSync(path.join(relDir, `${ownerId}.json`))) {
  fs.writeFileSync(path.join(relDir, `${ownerId}.json`), JSON.stringify({
    userId: String(ownerId),
    nickname: "主人",
    isOwner: true,
    stage: "认识",
    intimacy: 20,
    attitude: "重新开始，慢慢认识",
    insideJokes: [],
    sharedMemories: [],
    milestones: [],
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

const qzone = path.join(GROWTH, "actions", "qzone.json");
if (fs.existsSync(qzone)) {
  fs.writeFileSync(qzone, JSON.stringify({
    paused: false,
    today: new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }),
    countToday: 0,
    lastPostAt: null,
    posts: [],
  }, null, 2));
}

console.log("已清空：messages / summaries / facts / memories / style / diary / counters / events");
console.log("已重置：mood、主人关系（阶段=认识，亲密度=20）、说说计数");
console.log("保留：用户、角色、人设、settings、表情包、进化版本");
