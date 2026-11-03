import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createUser, getUserByUsername, getUserById, getAllCharacters,
  saveMessage as dbSaveMsg, getRecentMessages } from "./db.js";
import { handleMessage } from "./agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sessions = new Map(); // token → { userId, characterId, characterPath }
const wxCharMap = new Map(); // wxUserId → { characterId, characterPath }

// 供 wechat-server 调用：根据 wxUid 查找/设置该用户的角色偏好
export function getWxCharPreference(wxUid) {
  return wxCharMap.get(wxUid) || null;
}
export function setWxCharPreference(wxUid, pref) {
  wxCharMap.set(wxUid, pref);
}
export function clearWxCharPreference(wxUid) {
  wxCharMap.delete(wxUid);
}

function generateToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return salt + ":" + crypto.createHash("sha256").update(salt + password).digest("hex");
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  return crypto.createHash("sha256").update(salt + password).digest("hex") === hash;
}

function getSession(req) {
  const cookie = req.headers.cookie || "";
  const match = cookie.match(/token=([a-f0-9]+)/);
  if (!match) return null;
  return sessions.get(match[1]) || null;
}

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function html(res, body) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(body);
}

// ==================== 页面 ====================

function loginPage(error = "") {
  const errHtml = error ? `<p style="color:#e74c3c">${error}</p>` : "";
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>蓝小梦 - 登录</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #f5f5f5; display:flex; justify-content:center; align-items:center; min-height:100vh; margin:0; }
  .card { background: #fff; border-radius: 16px; padding: 40px 30px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); max-width: 360px; width:100%; text-align:center; }
  h1 { margin: 0 0 5px; font-size: 22px; color: #333; }
  .sub { color: #999; font-size: 13px; margin-bottom: 24px; }
  input { width:100%; padding:12px; margin:8px 0; border:1px solid #ddd; border-radius:8px; font-size:15px; box-sizing:border-box; }
  .btn { width:100%; padding:12px; margin-top:12px; border:none; border-radius:8px; font-size:16px; cursor:pointer; background:#6c5ce7; color:#fff; }
  .link { color:#999; margin-top:16px; font-size:13px; }
  .link a { color:#6c5ce7; text-decoration:none; }
</style></head>
<body><div class="card">
  <h1>🔮 AI 聊天</h1>
  <p class="sub">登录你的账号</p>
  ${errHtml}
  <form method="POST" action="/api/auth/login">
    <input name="username" placeholder="用户名" required>
    <input name="password" type="password" placeholder="密码" required>
    <button class="btn" type="submit">登录</button>
  </form>
  <p class="link">没有账号？<a href="/web?page=register">注册</a></p>
</div></body></html>`;
}

function registerPage(error = "") {
  const errHtml = error ? `<p style="color:#e74c3c">${error}</p>` : "";
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>蓝小梦 - 注册</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #f5f5f5; display:flex; justify-content:center; align-items:center; min-height:100vh; margin:0; }
  .card { background: #fff; border-radius: 16px; padding: 40px 30px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); max-width: 360px; width:100%; text-align:center; }
  h1 { margin: 0 0 5px; font-size: 22px; color: #333; }
  .sub { color: #999; font-size: 13px; margin-bottom: 24px; }
  input { width:100%; padding:12px; margin:8px 0; border:1px solid #ddd; border-radius:8px; font-size:15px; box-sizing:border-box; }
  .btn { width:100%; padding:12px; margin-top:12px; border:none; border-radius:8px; font-size:16px; cursor:pointer; background:#6c5ce7; color:#fff; }
  .link { color:#999; margin-top:16px; font-size:13px; }
  .link a { color:#6c5ce7; text-decoration:none; }
</style></head>
<body><div class="card">
  <h1>🔮 AI 聊天</h1>
  <p class="sub">创建新账号</p>
  ${errHtml}
  <form method="POST" action="/api/auth/register">
    <input name="username" placeholder="用户名" required>
    <input name="password" type="password" placeholder="密码" required>
    <button class="btn" type="submit">注册</button>
  </form>
  <p class="link">已有账号？<a href="/web">登录</a></p>
</div></body></html>`;
}

function characterSelectPage(characters) {
  const options = characters.map(c =>
    `<div class="char-card" style="border:2px solid #ddd;border-radius:12px;padding:16px;margin:10px 0;text-align:left">
      <h3 style="margin:0 0 4px">${c.name}</h3>
      <p style="margin:0 0 12px;color:#888;font-size:13px">${c.description || ''}</p>
      <div style="display:flex;gap:8px">
        <button onclick="selectAndGo(${c.id}, '${c.profile_path}', 'web')" style="flex:1;padding:10px;border:none;border-radius:8px;background:#6c5ce7;color:#fff;font-size:14px;cursor:pointer">💻 Web 聊天</button>
        <button onclick="selectAndGo(${c.id}, '${c.profile_path}', 'wx')" style="flex:1;padding:10px;border:2px solid #f0a500;border-radius:8px;background:#fff;color:#f0a500;font-size:14px;cursor:pointer">📱 微信连接</button>
      </div>
    </div>`).join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>选择角色</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #f5f5f5; display:flex; justify-content:center; align-items:center; min-height:100vh; margin:0; }
  .card { background: #fff; border-radius: 16px; padding: 40px 30px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); max-width: 380px; width:100%; }
  h1 { margin: 0 0 5px; font-size: 22px; color: #333; text-align:center; }
  .sub { color: #999; font-size: 13px; margin-bottom: 20px; text-align:center; }
</style></head>
<body><div class="card">
  <h1>选择一个角色</h1>
  <p class="sub">选择你今天想聊天的 AI 伙伴</p>
  ${options}
  <script>
    async function selectAndGo(id, path, mode) {
      const res = await fetch('/api/user/select-char', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ characterId: id, profilePath: path, connectWechat: mode === 'wx' })
      });
      if (res.ok) {
        if (mode === 'wx') {
          location.href = '/web?page=wxconnect';
        } else {
          location.href = '/web?page=chat';
        }
      }
    }
  </script>
</div></body></html>`;
}

function chatPage(characterName) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${characterName} - AI 聊天</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #f5f5f5; margin:0; display:flex; justify-content:center; align-items:center; min-height:100vh; }
  .wrap { max-width: 500px; width:100%; height:100vh; display:flex; flex-direction:column; background:#f5f5f5; }
  .header { padding:12px 16px; background:#fff; border-bottom:1px solid #eee; display:flex; justify-content:space-between; align-items:center; }
  .header h2 { margin:0; font-size:17px; }
  .header a { color:#999; text-decoration:none; font-size:13px; }
  .msgs { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:8px; }
  .msg { max-width:80%; padding:10px 14px; border-radius:16px; font-size:15px; line-height:1.5; word-break:break-word; }
  .user { align-self:flex-end; background:#6c5ce7; color:#fff; border-bottom-right-radius:4px; }
  .assistant { align-self:flex-start; background:#fff; border-bottom-left-radius:4px; }
  .input-area { padding:10px 16px; background:#fff; display:flex; gap:8px; border-top:1px solid #eee; }
  .input-area input { flex:1; padding:10px 14px; border:1px solid #ddd; border-radius:20px; font-size:15px; outline:none; }
  .input-area button { padding:10px 20px; border:none; border-radius:20px; background:#6c5ce7; color:#fff; font-size:15px; cursor:pointer; }
  .typing { color:#999; font-size:13px; padding:4px 16px; }
</style></head>
<body><div class="wrap">
  <div class="header">
    <h2>${characterName}</h2>
    <a href="/web?page=chars">换角色</a>
  </div>
  <div class="msgs" id="msgs"></div>
  <div class="input-area">
    <input id="input" placeholder="说点什么..." onkeydown="if(event.key==='Enter')send()">
    <button onclick="send()">发送</button>
  </div>
</div>
<script>
  async function loadHistory() {
    const res = await fetch('/api/chat/history');
    const data = await res.json();
    const msgs = document.getElementById('msgs');
    msgs.innerHTML = '';
    for (const m of data.messages || []) {
      const parts = m.content.split('|||').filter(p => p.trim());
      for (const p of parts) {
        const div = document.createElement('div');
        div.className = 'msg ' + m.role;
        div.textContent = p.trim();
        msgs.appendChild(div);
      }
    }
    msgs.scrollTop = msgs.scrollHeight;
  }

  async function send() {
    const input = document.getElementById('input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    // 显示用户消息
    const msgs = document.getElementById('msgs');
    const uDiv = document.createElement('div');
    uDiv.className = 'msg user';
    uDiv.textContent = text;
    msgs.appendChild(uDiv);
    msgs.scrollTop = msgs.scrollHeight;

    const res = await fetch('/api/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    });
    const data = await res.json();

    // 显示 AI 回复（拆分显示）
    const parts = data.reply.split('|||').filter(p => p.trim());
    for (let i = 0; i < parts.length; i++) {
      const div = document.createElement('div');
      div.className = 'msg assistant';
      div.textContent = parts[i].trim();
      msgs.appendChild(div);
      msgs.scrollTop = msgs.scrollHeight;
      if (i < parts.length - 1) {
        await new Promise(r => setTimeout(r, 400 + Math.random() * 600));
      }
    }
  }

  loadHistory();
</script>
</body></html>`;
}

// ==================== API 处理 ====================

async function handleRegister(body, res) {
  const { username, password } = body;
  if (!username || !password || username.length < 2 || password.length < 4) {
    return json(res, { error: "用户名至少2位，密码至少4位" }, 400);
  }
  const existing = getUserByUsername(username);
  if (existing) {
    return json(res, { error: "用户名已存在" }, 400);
  }
  // 只允许字母数字和下划线
  if (!/^[a-zA-Z0-9_一-龥]+$/.test(username)) {
    return json(res, { error: "用户名只能包含中英文、数字和下划线" }, 400);
  }
  const userId = createUser(username, hashPassword(password));
  const token = generateToken();
  const chars = getAllCharacters();
  const defaultChar = chars.find(c => c.id === 25) || chars.find(c => c.id !== 1) || { id: 25, profile_path: "config/characters/gu-yun-chi.json" };
  sessions.set(token, { userId, characterId: defaultChar.id, characterPath: defaultChar.profile_path });
  json(res, { ok: true, token, userId });
}

async function handleLogin(body, res) {
  const { username, password } = body;
  if (!username || !password) {
    return json(res, { error: "请输入用户名和密码" }, 400);
  }
  const user = getUserByUsername(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return json(res, { error: "用户名或密码错误" }, 401);
  }
  const token = generateToken();
  const chars = getAllCharacters();
  const defaultChar = chars.find(c => c.id === 25) || chars.find(c => c.id !== 1) || { id: 25, profile_path: "config/characters/gu-yun-chi.json" };
  sessions.set(token, { userId: user.id, characterId: defaultChar.id, characterPath: defaultChar.profile_path });
  json(res, { ok: true, token, userId: user.id });
}

async function handleSendMessage(body, res, session) {
  const { message } = body;
  if (!message || !message.trim()) {
    return json(res, { error: "消息不能为空" }, 400);
  }
  try {
    const reply = await handleMessage(
      session.userId, session.characterId, message.trim(), session.characterPath
    );
    json(res, { reply });
  } catch (err) {
    console.error("[Web Chat] error:", err.message);
    json(res, { error: "出错了，请重试" }, 500);
  }
}

function handleSelectChar(body, res, session) {
  const { characterId, profilePath, connectWechat } = body;
  if (!characterId || !profilePath) {
    return json(res, { error: "参数不完整" }, 400);
  }
  session.characterId = characterId;
  session.characterPath = profilePath;
  if (connectWechat) {
    session.pendingWxConnect = true;
  }
  json(res, { ok: true });
}

// 微信连接等待页：内嵌 iframe 显示主站的 QR 码
function wxConnectPage(characterName) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>微信连接 - ${characterName}</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #f5f5f5; display:flex; justify-content:center; align-items:center; min-height:100vh; margin:0; }
  .card { background: #fff; border-radius: 16px; padding: 40px 30px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); max-width: 380px; width:100%; text-align:center; }
  h1 { margin: 0 0 5px; font-size: 22px; color: #333; }
  .sub { color: #999; font-size: 13px; margin-bottom: 8px; }
  .note { color:#e67e22; font-size:13px; margin:12px 0; background:#fef9e7; padding:8px; border-radius:8px; }
  .btn { display:inline-block; padding:10px 24px; margin:8px 0; border:none; border-radius:8px; font-size:16px; cursor:pointer; background:#6c5ce7; color:#fff; text-decoration:none; }
  .qr-status { color:#888; font-size:13px; }
</style></head>
<body><div class="card">
  <h1>📱 连接微信</h1>
  <p class="sub">角色：${characterName}</p>
  <div class="note">⚠️ 扫码后微信将使用此角色聊天<br>如果已有其他人在用，会被断开</div>
  <p class="qr-status">请在新标签页打开下方链接扫码：</p>
  <a class="btn" href="/" target="_blank">打开微信扫码页</a>
  <p style="color:#999;font-size:12px;margin-top:12px">扫码连接后，回到微信聊天<br>在微信里发 /wake 开启自动消息</p>
  <p><a href="/web?page=chars" style="color:#6c5ce7;font-size:14px">← 换角色</a></p>
</div></body></html>`;
}

function handleChatHistory(res, session) {
  const msgs = getRecentMessages(session.userId, session.characterId, 50);
  json(res, { messages: msgs });
}

// ==================== 路由入口 ====================

export async function handleWebRequest(req, res) {
  const url = new URL(req.url, `http://localhost:3721`);
  const method = req.method;

  // ========== 页面路由 ==========
  if (url.pathname === "/web" || url.pathname === "/web/") {
    const session = getSession(req);
    if (!session) {
      const page = url.searchParams.get("page");
      if (page === "register") return html(res, registerPage());
      return html(res, loginPage());
    }
    const page = url.searchParams.get("page");
    if (page === "chars" || page === "select") {
      const chars = getAllCharacters();
      return html(res, characterSelectPage(chars));
    }
    if (page === "wxconnect") {
      try {
        const filePath = path.join(__dirname, "..", session.characterPath);
        const profile = JSON.parse(fs.readFileSync(filePath, "utf-8"));
        return html(res, wxConnectPage(profile.name));
      } catch {
        return html(res, wxConnectPage("AI 聊天"));
      }
    }
    // 加载角色名
    try {
      const filePath = path.join(__dirname, "..", session.characterPath);
      const profile = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      return html(res, chatPage(profile.name));
    } catch {
      return html(res, chatPage("AI 聊天"));
    }
  }

  // ========== API 路由 ==========

  // 解析 JSON body
  let body = {};
  if (method === "POST" && req.headers["content-type"]?.includes("json")) {
    body = await new Promise((resolve) => {
      let raw = "";
      req.on("data", c => raw += c);
      req.on("end", () => { try { resolve(JSON.parse(raw)); } catch { resolve({}); } });
    });
  }

  // 注册 / 登录（不需要 session）
  if (url.pathname === "/api/auth/register" && method === "POST") {
    return handleRegister(body, res);
  }
  if (url.pathname === "/api/auth/login" && method === "POST") {
    return handleLogin(body, res);
  }

  // 需要 session 的 API
  const session = getSession(req);
  if (!session) {
    return json(res, { error: "请先登录" }, 401);
  }

  if (url.pathname === "/api/chat/send" && method === "POST") {
    return handleSendMessage(body, res, session);
  }
  if (url.pathname === "/api/chat/history" && method === "GET") {
    return handleChatHistory(res, session);
  }
  if (url.pathname === "/api/characters" && method === "GET") {
    return json(res, getAllCharacters());
  }
  if (url.pathname === "/api/user/select-char" && method === "POST") {
    return handleSelectChar(body, res, session);
  }

  json(res, { error: "Not Found" }, 404);
}

// 导出 register/login API 供 HTML form 使用（需要解析 URL-encoded body）
export async function handleFormLogin(req, res) {
  const raw = await new Promise(r => { let d = ""; req.on("data", c => d += c); req.on("end", () => r(d)); });
  const params = new URLSearchParams(raw);
  const username = params.get("username");
  const password = params.get("password");
  if (!username || !password) {
    return html(res, loginPage("请填写用户名和密码"));
  }
  const user = getUserByUsername(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return html(res, loginPage("用户名或密码错误"));
  }
  const token = generateToken();
  const chars = getAllCharacters();
  const defaultChar = chars.find(c => c.id === 25) || chars.find(c => c.id !== 1) || { id: 25, profile_path: "config/characters/gu-yun-chi.json" };
  sessions.set(token, { userId: user.id, characterId: defaultChar.id, characterPath: defaultChar.profile_path });
  res.writeHead(302, { Location: "/web?page=chars", "Set-Cookie": `token=${token}; Path=/; HttpOnly` });
  res.end();
}

export async function handleFormRegister(req, res) {
  const raw = await new Promise(r => { let d = ""; req.on("data", c => d += c); req.on("end", () => r(d)); });
  const params = new URLSearchParams(raw);
  const username = params.get("username");
  const password = params.get("password");
  if (!username || !password || username.length < 2 || password.length < 4) {
    return html(res, registerPage("用户名至少2位，密码至少4位"));
  }
  if (getUserByUsername(username)) {
    return html(res, registerPage("用户名已存在"));
  }
  if (!/^[a-zA-Z0-9_一-龥]+$/.test(username)) {
    return html(res, registerPage("用户名只能包含中英文、数字和下划线"));
  }
  const userId = createUser(username, hashPassword(password));
  const token = generateToken();
  const chars = getAllCharacters();
  const defaultChar = chars.find(c => c.id === 25) || chars.find(c => c.id !== 1) || { id: 25, profile_path: "config/characters/gu-yun-chi.json" };
  sessions.set(token, { userId, characterId: defaultChar.id, characterPath: defaultChar.profile_path });
  res.writeHead(302, { Location: "/web?page=chars", "Set-Cookie": `token=${token}; Path=/; HttpOnly` });
  res.end();
}
