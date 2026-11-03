import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, "..", "data", "chat.db");

let db = null;

export function getDB() {
  if (!db) {
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    initTables();
  }
  return db;
}

function initTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS characters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      profile_path TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      character_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL,
      time INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (character_id) REFERENCES characters(id)
    );

    CREATE TABLE IF NOT EXISTS facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      character_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      time INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (character_id) REFERENCES characters(id)
    );

    CREATE TABLE IF NOT EXISTS summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      character_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      time INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (character_id) REFERENCES characters(id)
    );

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      character_id INTEGER NOT NULL,
      category TEXT NOT NULL CHECK(category IN ('event','preference','emotion','relationship','daily','promise')),
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 50,
      source TEXT NOT NULL DEFAULT 'chat',
      hit_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      last_hit_at INTEGER,
      archived INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (character_id) REFERENCES characters(id)
    );

    CREATE TABLE IF NOT EXISTS glossary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      term TEXT NOT NULL UNIQUE,
      aliases TEXT NOT NULL DEFAULT '',
      meaning TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'meme',
      source TEXT NOT NULL DEFAULT '',
      confidence INTEGER NOT NULL DEFAULT 50,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000),
      hit_count INTEGER NOT NULL DEFAULT 0,
      last_hit_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_messages_user_char ON messages(user_id, character_id);
    CREATE INDEX IF NOT EXISTS idx_facts_user_char ON facts(user_id, character_id);
    CREATE INDEX IF NOT EXISTS idx_summaries_user_char ON summaries(user_id, character_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_unique ON memories(user_id, character_id, category, key);
    CREATE INDEX IF NOT EXISTS idx_memories_lookup ON memories(user_id, character_id, archived, importance);
    CREATE INDEX IF NOT EXISTS idx_glossary_term ON glossary(term);
    CREATE INDEX IF NOT EXISTS idx_glossary_updated ON glossary(updated_at);
  `);

  // 旧 facts 迁移到 memories（幂等）
  try {
    db.exec(`
      INSERT OR IGNORE INTO memories (user_id, character_id, category, key, value, importance, source)
      SELECT user_id, character_id, 'daily', key, value, 50, 'migrated' FROM facts;
    `);
  } catch {}
}

// ==================== 用户 ====================

export function createUser(username, passwordHash) {
  const stmt = getDB().prepare("INSERT INTO users (username, password_hash) VALUES (?, ?)");
  const result = stmt.run(username, passwordHash);
  return result.lastInsertRowid;
}

export function getUserByUsername(username) {
  return getDB().prepare("SELECT * FROM users WHERE username = ?").get(username);
}

export function getUserById(id) {
  return getDB().prepare("SELECT * FROM users WHERE id = ?").get(id);
}

// ==================== 角色 ====================

export function seedCharacters(characters) {
  const stmt = getDB().prepare("INSERT OR IGNORE INTO characters (name, profile_path) VALUES (?, ?)");
  const insertMany = getDB().transaction((chars) => {
    for (const c of chars) {
      stmt.run(c.name, c.profile_path);
    }
  });
  insertMany(characters);
}

export function getAllCharacters() {
  return getDB().prepare("SELECT * FROM characters ORDER BY id").all();
}

export function getCharacterById(id) {
  return getDB().prepare("SELECT * FROM characters WHERE id = ?").get(id);
}

// ==================== 消息 ====================

export function saveMessage(userId, characterId, role, content) {
  return getDB().prepare(
    "INSERT INTO messages (user_id, character_id, role, content, time) VALUES (?, ?, ?, ?, ?)"
  ).run(userId, characterId, role, content, Date.now());
}

export function getRecentMessages(userId, characterId, limit = 40) {
  return getDB().prepare(
    "SELECT role, content FROM messages WHERE user_id = ? AND character_id = ? ORDER BY id DESC LIMIT ?"
  ).all(userId, characterId, limit).reverse();
}

export function getMessageCount(userId, characterId) {
  const row = getDB().prepare(
    "SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND character_id = ?"
  ).get(userId, characterId);
  return row.count;
}

export function getMessagesForSummarization(userId, characterId, keepRecent = 20) {
  const msgs = getDB().prepare(
    "SELECT role, content FROM messages WHERE user_id = ? AND character_id = ? ORDER BY id"
  ).all(userId, characterId);
  if (msgs.length <= keepRecent) return "";
  return msgs.slice(0, msgs.length - keepRecent)
    .map(m => `${m.role === "user" ? "老板" : "助手"}: ${m.content.slice(0, 200)}`)
    .join("\n");
}

export function trimMessages(userId, characterId, keepRecent = 20) {
  const count = getMessageCount(userId, characterId);
  if (count <= keepRecent) return;
  const deleteCount = count - keepRecent;
  getDB().prepare(
    `DELETE FROM messages WHERE id IN (
      SELECT id FROM messages WHERE user_id = ? AND character_id = ? ORDER BY id LIMIT ?
    )`
  ).run(userId, characterId, deleteCount);
}

export function getOldMessagesCount(userId, characterId, keepRecent = 20) {
  const count = getMessageCount(userId, characterId);
  return Math.max(0, count - keepRecent);
}

// ==================== 事实 ====================

export function saveFact(userId, characterId, key, value) {
  const existing = getDB().prepare(
    "SELECT id FROM facts WHERE user_id = ? AND character_id = ? AND key = ?"
  ).get(userId, characterId, key);
  if (existing) {
    getDB().prepare("UPDATE facts SET value = ?, time = ? WHERE id = ?")
      .run(value, Date.now(), existing.id);
  } else {
    getDB().prepare("INSERT INTO facts (user_id, character_id, key, value, time) VALUES (?, ?, ?, ?, ?)")
      .run(userId, characterId, key, value, Date.now());
  }
}

export function getFacts(userId, characterId, limit = 30) {
  return getDB().prepare(
    "SELECT key, value, time FROM facts WHERE user_id = ? AND character_id = ? ORDER BY time DESC LIMIT ?"
  ).all(userId, characterId, limit);
}

// ==================== 六类长期记忆 ====================

export const MEMORY_CATEGORIES = ["event", "preference", "emotion", "relationship", "daily", "promise"];

export function upsertMemory({ userId, characterId, category, key, value, importance = 50, source = "chat" }) {
  const cat = MEMORY_CATEGORIES.includes(category) ? category : "daily";
  const k = String(key || "").trim().slice(0, 60);
  const v = String(value || "").trim().slice(0, 300);
  if (!k || !v) return null;
  const imp = Math.max(0, Math.min(100, Math.round(Number(importance) || 50)));
  const db = getDB();

  const existing = db.prepare(
    "SELECT id, importance FROM memories WHERE user_id = ? AND character_id = ? AND category = ? AND key = ?"
  ).get(userId, characterId, cat, k);

  if (existing) {
    db.prepare(
      "UPDATE memories SET value = ?, importance = MAX(importance, ?), updated_at = ?, archived = 0 WHERE id = ?"
    ).run(v, imp, Date.now(), existing.id);
    return db.prepare("SELECT * FROM memories WHERE id = ?").get(existing.id);
  }

  const info = db.prepare(
    "INSERT INTO memories (user_id, character_id, category, key, value, importance, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(userId, characterId, cat, k, v, imp, source, Date.now());
  return db.prepare("SELECT * FROM memories WHERE id = ?").get(info.lastInsertRowid);
}

export function getMemories(userId, characterId, limit = 200) {
  return getDB().prepare(
    "SELECT * FROM memories WHERE user_id = ? AND character_id = ? AND archived = 0 ORDER BY importance DESC, updated_at DESC LIMIT ?"
  ).all(userId, characterId, limit);
}

export function deleteMemory(id) {
  getDB().prepare("DELETE FROM memories WHERE id = ?").run(id);
}

export function archiveMemory(id) {
  getDB().prepare("UPDATE memories SET archived = 1, updated_at = ? WHERE id = ?").run(Date.now(), id);
}

export function markMemoryHit(id) {
  getDB().prepare("UPDATE memories SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?").run(Date.now(), id);
}

export function getMemoryCounts(userId, characterId) {
  return getDB().prepare(
    "SELECT category, COUNT(*) as count FROM memories WHERE user_id = ? AND character_id = ? AND archived = 0 GROUP BY category"
  ).all(userId, characterId);
}

// ==================== 梗 / 网络词 ====================

function normalizeAliases(aliases) {
  const arr = Array.isArray(aliases)
    ? aliases
    : String(aliases || "").split(/[,，、;；]/);
  return [...new Set(arr.map(s => String(s).trim()).filter(Boolean))].join(",");
}

export function upsertGlossary({ term, aliases = "", meaning, category = "meme", source = "", confidence = 50 }) {
  const t = String(term || "").trim().slice(0, 30);
  const m = String(meaning || "").trim().slice(0, 500);
  if (!t || !m) return null;

  const db = getDB();
  const a = normalizeAliases(aliases);
  const cat = String(category || "meme").slice(0, 20);
  const src = String(source || "").slice(0, 300);
  const conf = Math.max(0, Math.min(100, Math.round(Number(confidence) || 50)));
  const existing = db.prepare("SELECT id FROM glossary WHERE term = ? COLLATE NOCASE").get(t);

  if (existing) {
    db.prepare(
      "UPDATE glossary SET aliases = ?, meaning = ?, category = ?, source = ?, confidence = MAX(confidence, ?), updated_at = ? WHERE id = ?"
    ).run(a, m, cat, src, conf, Date.now(), existing.id);
    return db.prepare("SELECT * FROM glossary WHERE id = ?").get(existing.id);
  }

  const info = db.prepare(
    "INSERT INTO glossary (term, aliases, meaning, category, source, confidence, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(t, a, m, cat, src, conf, Date.now());
  return db.prepare("SELECT * FROM glossary WHERE id = ?").get(info.lastInsertRowid);
}

export function getGlossary(term) {
  const t = String(term || "").trim();
  if (!t) return null;
  return getDB().prepare(
    `SELECT * FROM glossary
     WHERE term = ? COLLATE NOCASE
        OR (',' || aliases || ',') LIKE ? ESCAPE '\\'
     ORDER BY confidence DESC, updated_at DESC
     LIMIT 1`
  ).get(t, `%,${t.replace(/[\\%_]/g, "\\$&")},%`) || null;
}

export function listGlossary(limit = 500) {
  return getDB().prepare(
    "SELECT * FROM glossary ORDER BY updated_at DESC, confidence DESC LIMIT ?"
  ).all(Math.max(1, Math.min(2000, Number(limit) || 500)));
}

export function deleteGlossary(idOrTerm) {
  const db = getDB();
  if (typeof idOrTerm === "number" || /^\d+$/.test(String(idOrTerm))) {
    return db.prepare("DELETE FROM glossary WHERE id = ?").run(Number(idOrTerm)).changes;
  }
  return db.prepare("DELETE FROM glossary WHERE term = ? COLLATE NOCASE").run(String(idOrTerm)).changes;
}

export function bumpGlossaryHit(id) {
  getDB().prepare(
    "UPDATE glossary SET hit_count = hit_count + 1, last_hit_at = ? WHERE id = ?"
  ).run(Date.now(), id);
}

export function getGlossaryCount() {
  return getDB().prepare("SELECT COUNT(*) as count FROM glossary").get().count;
}

// ==================== 摘要 ====================

export function saveSummary(userId, characterId, text) {
  getDB().prepare("INSERT INTO summaries (user_id, character_id, text, time) VALUES (?, ?, ?, ?)")
    .run(userId, characterId, text, Date.now());
  // 最多保留 10 条
  const rows = getDB().prepare(
    "SELECT COUNT(*) as count FROM summaries WHERE user_id = ? AND character_id = ?"
  ).get(userId, characterId);
  if (rows.count > 10) {
    getDB().prepare(
      `DELETE FROM summaries WHERE id IN (
        SELECT id FROM summaries WHERE user_id = ? AND character_id = ? ORDER BY id LIMIT ?
      )`
    ).run(userId, characterId, rows.count - 10);
  }
}

export function getSummaries(userId, characterId) {
  return getDB().prepare(
    "SELECT text, time FROM summaries WHERE user_id = ? AND character_id = ? ORDER BY id DESC LIMIT 5"
  ).all(userId, characterId).reverse();
}

export function getLastSummaryTime(userId, characterId) {
  const row = getDB().prepare(
    "SELECT MAX(time) as t FROM summaries WHERE user_id = ? AND character_id = ?"
  ).get(userId, characterId);
  return row.t || 0;
}

export function needsSummarization(userId, characterId) {
  const lastTime = getLastSummaryTime(userId, characterId);
  const newCount = getDB().prepare(
    "SELECT COUNT(*) as count FROM messages WHERE user_id = ? AND character_id = ? AND time > ?"
  ).get(userId, characterId, lastTime);
  return newCount.count >= 40;
}

// ==================== 旧数据迁移 ====================

export function migrateJSONtoDB() {
  const dataDir = path.join(__dirname, "..", "data", "memory");
  const msgFile = path.join(dataDir, "messages.json");
  const factFile = path.join(dataDir, "facts.json");
  const summaryFile = path.join(dataDir, "summaries.json");

  const users = getDB().prepare("SELECT id FROM users").all();
  if (users.length === 0) return;
  const userId = users[0].id;
  const chars = getAllCharacters();
  if (chars.length === 0) return;
  const charId = chars[0].id;

  try {
    const msgs = JSON.parse(fs.readFileSync(msgFile, "utf-8"));
    const insertMsg = getDB().prepare(
      "INSERT INTO messages (user_id, character_id, role, content, time) VALUES (?, ?, ?, ?, ?)"
    );
    getDB().transaction(() => {
      for (const [, arr] of Object.entries(msgs)) {
        for (const m of arr) {
          insertMsg.run(userId, charId, m.role, m.content, m.time || Date.now());
        }
      }
    })();
  } catch { /* 无旧数据 */ }

  try {
    const facts = JSON.parse(fs.readFileSync(factFile, "utf-8"));
    const insertFact = getDB().prepare(
      "INSERT OR IGNORE INTO facts (user_id, character_id, key, value, time) VALUES (?, ?, ?, ?, ?)"
    );
    getDB().transaction(() => {
      for (const [, obj] of Object.entries(facts)) {
        for (const [key, valObj] of Object.entries(obj)) {
          insertFact.run(userId, charId, key, valObj.value, valObj.time || Date.now());
        }
      }
    })();
  } catch {}

  try {
    const summaries = JSON.parse(fs.readFileSync(summaryFile, "utf-8"));
    const insertSum = getDB().prepare(
      "INSERT INTO summaries (user_id, character_id, text, time) VALUES (?, ?, ?, ?)"
    );
    getDB().transaction(() => {
      for (const [, arr] of Object.entries(summaries)) {
        for (const s of arr) {
          insertSum.run(userId, charId, s.text, s.time || Date.now());
        }
      }
    })();
  } catch {}
}
