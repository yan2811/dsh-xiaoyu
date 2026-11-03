import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadPersona, loadRelation, updatePersona, updateRelation,
  getEvolutionSummary, TRAIT_DEFAULTS,
  getMilestones, addMilestone, removeMilestone,
} from "./growth.js";
import { getMood, setMood } from "./mood.js";
import { getSettings, updateSettings } from "./settings.js";
import { getStyleForPanel, clearStyle, addManualPhrase, removeManualPhrase } from "./style.js";
import { getMemories, saveMemory, deleteMemory, getMemoryCounts } from "./memory.js";
import { getUserByUsername, getAllCharacters } from "./db.js";

// ============================================================
//  可视化控制面板：只监听 127.0.0.1，通过 SSH 隧道访问
// ============================================================

const __dir = path.dirname(fileURLToPath(import.meta.url));
const PANEL_HTML = fs.readFileSync(path.join(__dir, "panel.html"), "utf-8");
const OWNER_QQ = Number(process.env.QQ_OWNER_ID || 2811534319);
const HOST = process.env.PANEL_HOST || "127.0.0.1";
const PORT = Number(process.env.PANEL_PORT || 3722);
const TOKEN = process.env.PANEL_TOKEN || "";

function ownerUserId() {
  const user = getUserByUsername("qq_" + OWNER_QQ);
  return user ? user.id : 1;
}

function characterId() {
  const c = getAllCharacters().find(x => x.name === "蓝色大肥鱼");
  return c ? c.id : 17;
}

function authorized(req, url) {
  if (!TOKEN) return true;
  return req.headers["x-panel-token"] === TOKEN || url.searchParams.get("token") === TOKEN;
}

function json(res, data, code = 200) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) { reject(new Error("请求体过大")); req.destroy(); return; }
      body += chunk;
    });
    req.on("end", () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

async function handler(req, res) {
  const url = new URL(req.url, "http://127.0.0.1");

  // 页面本身放行，前端会提示输入口令；API 才校验
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(PANEL_HTML);
  }

  if (!authorized(req, url)) return json(res, { error: "unauthorized" }, 401);

  if (req.method === "GET" && url.pathname === "/api/state") {
    const uid = ownerUserId();
    const cid = characterId();
    return json(res, {
      persona: loadPersona(),
      relation: loadRelation(uid),
      mood: getMood(),
      settings: getSettings(),
      style: getStyleForPanel(uid),
      memories: getMemories(uid, cid, 30),
      memoryCounts: getMemoryCounts(uid, cid),
      milestones: getMilestones(uid),
      summary: getEvolutionSummary(uid),
      owner: { qq: OWNER_QQ, userId: uid },
    });
  }

  if (req.method === "POST") {
    let body;
    try { body = await readBody(req); }
    catch (e) { return json(res, { error: e.message }, 400); }

    const uid = ownerUserId();
    if (url.pathname === "/api/persona") return json(res, updatePersona(body));
    if (url.pathname === "/api/mood") return json(res, setMood(body));
    if (url.pathname === "/api/relation") return json(res, updateRelation(uid, body));
    if (url.pathname === "/api/settings") return json(res, updateSettings(body));
    if (url.pathname === "/api/style") {
      if (body.enabled !== undefined) updateSettings({ style: { enabled: !!body.enabled } });
      if (body.add) addManualPhrase(uid, body.add);
      if (body.remove) removeManualPhrase(uid, body.remove);
      if (body.clear) clearStyle(uid);
      return json(res, getStyleForPanel(uid));
    }
    if (url.pathname === "/api/memory") {
      const cid = characterId();
      if (body.add) {
        const a = body.add;
        saveMemory({
          userId: uid, characterId: cid,
          category: a.category, key: a.key, value: a.value,
          importance: a.importance, source: "manual",
        });
      }
      if (body.delete) deleteMemory(body.delete);
      return json(res, {
        memories: getMemories(uid, cid, 30),
        counts: getMemoryCounts(uid, cid),
      });
    }
    if (url.pathname === "/api/milestone") {
      if (body.add) {
        const a = body.add;
        addMilestone(uid, {
          key: a.title, title: a.title,
          date: a.date, stageHint: a.stageHint,
        });
      }
      if (body.delete) removeMilestone(uid, body.delete);
      return json(res, { milestones: getMilestones(uid) });
    }
    if (url.pathname === "/api/reset") {
      return json(res, updatePersona({ traits: TRAIT_DEFAULTS, lockedTraits: [] }));
    }
  }

  return json(res, { error: "not found" }, 404);
}

export function startControlPanel() {
  const server = http.createServer((req, res) => {
    handler(req, res).catch(e => {
      console.error("[面板]", e.message);
      try { json(res, { error: e.message }, 500); } catch {}
    });
  });
  server.on("error", e => console.error("[面板] 启动失败:", e.message));
  server.listen(PORT, HOST, () => {
    console.log(`[面板] http://${HOST}:${PORT}${TOKEN ? "（需要口令）" : ""}`);
  });
  return server;
}
