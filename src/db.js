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

    CREATE INDEX IF NOT EXISTS idx_messages_user_char ON messages(user_id, character_id);
    CREATE INDEX IF NOT EXISTS idx_facts_user_char ON facts(user_id, character_id);
    CREATE INDEX IF NOT EXISTS idx_summaries_user_char ON summaries(user_id, character_id);
  `);
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
