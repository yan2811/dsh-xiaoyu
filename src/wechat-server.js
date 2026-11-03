import "dotenv/config";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import { handleMessage } from "./agent.js";
import { getCharacterName, getUserNickname, buildCharacterPrompt } from "./personality.js";
import { generateProactiveMessage } from "./proactive.js";
import { getFacts } from "./memory.js";
import { getDB, seedCharacters, getAllCharacters, createUser, getUserByUsername, migrateJSONtoDB } from "./db.js";
import { handleWebRequest, handleFormLogin, handleFormRegister, getWxCharPreference, setWxCharPreference, clearWxCharPreference } from "./web-router.js";
import { describeImage } from "./vision.js";
import { transcribeAudio } from "./asr.js";
import { synthesize } from "./tts.js";
import { wavToVideo } from "./video.js";

// ============================================================
// 蓝小梦 微信桥接 v3 (服务器版)
// - HTTP 网页显示二维码，远程扫码
// - 24h 在线，无需本地终端
// - 主动消息 + 联网搜索
// ============================================================

const PORT = process.env.PORT || 3721;
const ILINK_BASE = "https://ilinkai.weixin.qq.com";
const CHARACTER = getCharacterName();
const AUTO_MIN_MS = 30 * 60 * 1000; // 最短30分钟
const AUTO_MAX_MS = 60 * 60 * 1000; // 最长60分钟
const AUTO_START_HOUR = 8;
const AUTO_END_HOUR = 23;

function randomInterval() {
  return AUTO_MIN_MS + Math.random() * (AUTO_MAX_MS - AUTO_MIN_MS);
}

let sdk = null;
let botInstance = null;
let botAbortController = null;
let proactiveEnabled = true; // 扫码连接后自动开启
let lastActivityTime = Date.now();
let lastUserMsg = "";
let proactiveTimer = null;
let nextProactiveTime = 0; // 下次主动消息触发时间
let hasReceivedMsg = false;
let proactiveUserId = null;
const conversationStates = new Map(); // conversationId → { lastUserMsg, lastActivity }

// 语音回复模式，按会话开关。用 /voice 切换。
const voiceMode = new Set();

// ==================== HTTP 服务器 ====================
let qrCodeUrl = null;      // 二维码 URL
let loginStatus = "idle";  // idle | waiting | scanned | confirmed | failed
let loginMessage = "";
let accountId = null;
let wasConnected = false;  // 当前二维码是否会踢掉上一个用户

// 媒体清理：图片和语音都只保留最近 5 个，否则小磁盘会慢慢被塞满
const IMAGE_DIR = "/tmp/weixin-images";
const MEDIA_EXT = {
  图片: /\.(jpg|jpeg|png|gif|webp|bmp)$/i,
  语音: /\.(wav|mp3|m4a|aac|ogg|amr|silk|flac)$/i,
};
const MAX_MEDIA = 5;

function cleanupOldMedia(kind, newPath) {
  try {
    const dir = path.dirname(newPath);
    if (!fs.existsSync(dir)) return;
    const re = MEDIA_EXT[kind];
    const files = fs.readdirSync(dir)
      .filter(f => re.test(f))
      .map(f => ({ name: f, path: path.join(dir, f), time: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.time - a.time); // 最新的在前
    if (files.length > MAX_MEDIA) {
      files.slice(MAX_MEDIA).forEach(f => {
        fs.unlinkSync(f.path);
        console.log(`[${kind}] 清理旧文件: ` + f.name);
      });
    }
  } catch {}
}

function cleanupOldImages(newImagePath) {
  cleanupOldMedia("图片", newImagePath);
}

// 微信用户自动注册到数据库
function getOrCreateWxUser(wxUid) {
  const username = "wx_" + wxUid.replace(/[^a-zA-Z0-9]/g, "_");
  let user = getUserByUsername(username);
  if (!user) {
    const hash = "wx:" + crypto.randomUUID();
    createUser(username, hash);
    user = getUserByUsername(username);
  }
  return user.id;
}

// 微信内切换角色命令 /char 1 /char 2 /char 3
function getVisibleCharacters() {
  return getAllCharacters();
}

function handleCharCommand(uid, text) {
  const parts = text.trim().split(/\s+/);
  const chars = getVisibleCharacters();
  if (parts.length < 2) {
    return { text: "用法：/char 数字\n" + chars.map(c => c.id + ". " + c.name).join("\n") };
  }
  const charId = parseInt(parts[1]);
  const found = chars.find(c => c.id === charId);
  if (!found) {
    return { text: "没有这个角色，可选：\n" + chars.map(c => c.id + ". " + c.name).join("\n") };
  }
  setWxCharPreference(uid, { characterId: found.id, characterPath: found.profile_path });
  return { text: "切换为 " + found.name + "！下次消息就用新角色回复你啦~" };
}

function getStatusPage() {
  const statusMap = {
    idle: { color: "#999", text: "等待启动", icon: "⏳" },
    waiting: { color: "#f0a500", text: "等待扫码", icon: "📱" },
    scanned: { color: "#4a90d9", text: "已扫码，微信上继续操作...", icon: "👀" },
    confirmed: { color: "#27ae60", text: "连接成功！", icon: "✅" },
    failed: { color: "#e74c3c", text: "登录失败", icon: "❌" },
  };
  const status = statusMap[loginStatus] || statusMap.idle;

  let body = "";
  if (qrCodeUrl && loginStatus === "waiting") {
    body = `
      <p style="font-size:18px;color:#333;margin:10px 0">请用微信扫描下方二维码</p>
      <img src="${qrCodeUrl}" alt="QR Code" style="width:280px;height:280px;border:3px solid #f0a500;border-radius:12px">
      <p style="color:#888;font-size:13px;margin-top:10px">微信 → ClawBot 插件 → 扫码授权</p>
      ${wasConnected ? '<p style="color:#e74c3c;font-weight:bold;margin-top:8px">⚠️ 当前 Bot 被占用，扫码将断开上一用户</p>' : ''}
      <p style="color:#aaa;font-size:12px">二维码每 5 分钟自动刷新</p>
      <script>setTimeout(()=>location.reload(), 120000)</script>
    `;
  } else if (loginStatus === "scanned") {
    body = `<p style="font-size:20px;color:#4a90d9">👀 已扫码！</p>
      <p style="color:#666">请在手机上确认授权...</p>
      ${wasConnected ? '<p style="color:#e74c3c;font-weight:bold">⚠️ 确认后将断开上一用户</p>' : ''}
      <script>setTimeout(()=>location.reload(), 2000)</script>`;
  } else if (loginStatus === "confirmed") {
    body = `<p style="font-size:20px;color:#27ae60">✅ Bot 运行中</p>
      <p style="color:#666">蓝小梦正在微信里聊天~</p>
      <p><a href="/login" style="color:#4a90d9;font-size:14px;text-decoration:none;padding:8px 16px;border:2px solid #4a90d9;border-radius:8px;display:inline-block;margin-top:12px">🔄 重新扫码连接</a></p>
      <p style="color:#999;font-size:12px;margin-top:8px">扫码后将断开当前用户并接入新设备</p>`;
  } else if (loginStatus === "failed") {
    body = `<p style="font-size:18px;color:#e74c3c">❌ ${loginMessage}</p>
      <p><a href="/" style="color:#4a90d9">重新开始</a></p>`;
  } else {
    body = `<p style="color:#888">准备就绪</p>
      <p><a href="/login" style="color:#4a90d9;font-size:16px;text-decoration:none;padding:10px 20px;border:2px solid #4a90d9;border-radius:8px">开始连接微信</a></p>`;
  }

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>蓝小梦 - 微信连接</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #f5f5f5; display:flex; justify-content:center; align-items:center; min-height:100vh; margin:0; }
  .card { background: #fff; border-radius: 16px; padding: 40px 30px; text-align: center; box-shadow: 0 4px 20px rgba(0,0,0,0.08); max-width: 380px; }
  h1 { margin: 0 0 5px; font-size: 22px; color: #333; }
  .subtitle { color: #999; font-size: 13px; margin-bottom: 20px; }
  .status { color: ${status.color}; font-weight: bold; }
</style></head>
<body><div class="card">
  <h1>🔮 ${CHARACTER}</h1>
  <p class="subtitle">微信 AI 伴侣 | 永劫无间·蓝梦</p>
  <p class="status">${status.icon} ${status.text}</p>
  ${body}
  ${botInstance ? '<p style="color:#27ae60;margin-top:20px">🟢 Bot 运行中</p>' : ''}
</div></body></html>`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Web 前端和 API 路由 → 交给 web-router
  if (url.pathname.startsWith("/web") || url.pathname.startsWith("/api/")) {
    // Form 表单提交（application/x-www-form-urlencoded）
    if (url.pathname === "/api/auth/login" && req.method === "POST" && !req.headers["content-type"]?.includes("json")) {
      return handleFormLogin(req, res);
    }
    if (url.pathname === "/api/auth/register" && req.method === "POST" && !req.headers["content-type"]?.includes("json")) {
      return handleFormRegister(req, res);
    }
    return handleWebRequest(req, res);
  }

  if (url.pathname === "/login" && loginStatus !== "waiting" && loginStatus !== "scanned") {
    // 触发登录：如果已有活跃 bot，先断开
    if (botInstance) {
      disconnectBot();
      wasConnected = true;
    }
    res.writeHead(302, { Location: "/" });
    res.end();
    startLogin();
    return;
  }

  if (url.pathname === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: loginStatus,
      message: loginMessage,
      connected: !!botInstance,
      proactive: proactiveEnabled,
    }));
    return;
  }

  // 默认返回微信扫码页面
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(getStatusPage());
});

function startHTTPServer() {
  server.listen(PORT, () => {
    console.log('🌐 管理页面: http://localhost:' + PORT);
    console.log('   外网访问: http://<服务器IP>:' + PORT);
  });
}

// ==================== 断开 Bot ====================
function disconnectBot() {
  if (proactiveTimer) {
    clearInterval(proactiveTimer);
    proactiveTimer = null;
  }
  if (botAbortController) {
    botAbortController.abort();
    botAbortController = null;
  }
  botInstance = null;
  proactiveEnabled = false;
  hasReceivedMsg = false;
  conversationStates.clear();
  console.log('[Bot] 已断开上一用户');
}

// ==================== 微信登录 (直接调 iLink API) ====================
// 登录失败后尝试用缓存凭证恢复连接
async function tryAutoReconnect() {
  try {
    // 已经连着就不用重连了
    if (botInstance) return true;

    if (!sdk) sdk = await import("weixin-agent-sdk");
    if (!sdk.isLoggedIn()) return false;

    const accountsFile = path.join(process.env.HOME || "~", ".openclaw", "openclaw-weixin", "accounts.json");
    if (!fs.existsSync(accountsFile)) return false;

    const ids = JSON.parse(fs.readFileSync(accountsFile, "utf-8"));
    if (!ids.length) return false;

    accountId = ids[0];
    const accountFile = path.join(
      process.env.HOME || "~", ".openclaw", "openclaw-weixin", "accounts",
      accountId.replace(/[@.]/g, "-") + ".json"
    );
    if (!fs.existsSync(accountFile)) return false;

    const account = JSON.parse(fs.readFileSync(accountFile, "utf-8"));
    // 先清理旧实例，防止重复 Bot
    disconnectBot();
    console.log("[登录] 尝试用缓存凭证恢复连接...");
    await startBot(accountId, account.baseUrl, account.token, account.userId);
    loginStatus = "confirmed";
    console.log("[登录] 缓存凭证恢复成功");
    return true;
  } catch (e) {
    console.log("[登录] 缓存凭证恢复失败:", e.message);
    return false;
  }
}

async function fetchJSON(url, opts = {}) {
  const resp = await fetch(url, {
    signal: AbortSignal.timeout(opts.timeout || 15000),
    ...opts,
  });
  if (!resp.ok) throw new Error('HTTP ' + resp.status);
  return resp.json();
}

async function startLogin() {
  // 如果有已连接的 bot，先断开
  if (botInstance) {
    disconnectBot();
    wasConnected = true;
  } else {
    wasConnected = false;
  }

  loginStatus = "waiting";
  loginMessage = "";

  try {
    // Step 1: 获取二维码
    console.log("[登录] 获取二维码...");
    const qrResp = await fetchJSON(ILINK_BASE + '/ilink/bot/get_bot_qrcode?bot_type=3');
    if (!qrResp.qrcode || !qrResp.qrcode_img_content) {
      loginStatus = "failed";
      loginMessage = qrResp.message || "获取二维码失败";
      console.error("[登录]", loginMessage);
      return;
    }

    qrCodeUrl = await QRCode.toDataURL(qrResp.qrcode_img_content);
    console.log("[登录] 二维码就绪" + (wasConnected ? "（将替换上一用户）" : ""));

    // Step 2: 轮询扫描状态
    let scannedLogged = false;
    let retries = 0;
    const maxRetries = 90; // 3 分钟（每 2 秒轮询）
    let qrRefreshCount = 0;
    const maxQrRefreshes = 3; // 最多刷新 3 次二维码

    while (retries < maxRetries) {
      await sleep(2000);
      retries++;

      try {
        const statusResp = await fetchJSON(
          ILINK_BASE + '/ilink/bot/get_qrcode_status?qrcode=' + encodeURIComponent(qrResp.qrcode),
          { timeout: 35000 }
        );

        switch (statusResp.status) {
          case "scaned":
            if (!scannedLogged) {
              loginStatus = "scanned";
              console.log("[登录] 已扫码");
              scannedLogged = true;
            }
            break;

          case "expired":
            qrRefreshCount++;
            if (qrRefreshCount > maxQrRefreshes) {
              console.log("[登录] 二维码刷新次数超限，停止等待");
              loginStatus = "idle";
              loginMessage = "";
              qrCodeUrl = null;
              await tryAutoReconnect();
              return;
            }
            console.log("[登录] 二维码过期，刷新(" + qrRefreshCount + "/" + maxQrRefreshes + ")...");
            const refreshResp = await fetchJSON(ILINK_BASE + '/ilink/bot/get_bot_qrcode?bot_type=3');
            qrCodeUrl = await QRCode.toDataURL(refreshResp.qrcode_img_content);
            qrResp.qrcode = refreshResp.qrcode;
            scannedLogged = false;
            loginStatus = "waiting";
            console.log("[登录] 新二维码就绪");
            break;

          case "confirmed":
            // 登录成功！
            console.log("[登录] 确认成功！");
            const token = statusResp.bot_token;
            accountId = statusResp.ilink_bot_id;
            const baseUrl = statusResp.baseurl || ILINK_BASE;
            const userId = statusResp.ilink_user_id;

            // 保存凭证（兼容 weixin-agent-sdk 格式）
            saveCredentials(accountId, token, baseUrl, userId);

            loginStatus = "confirmed";
            qrCodeUrl = null;
            wasConnected = false;

            // 启动 Bot
            await startBot(accountId, baseUrl, token, userId);
            return;

          case "scaned_but_redirect":
            // 重定向，但我们的轮询 URL 不变，继续
            break;

          default:
            // "wait" 或其他，继续轮询
            break;
        }
      } catch (pollErr) {
        // 轮询超时是正常的（长轮询 35s），继续
        if (pollErr.name === "TimeoutError" || pollErr.message?.includes("timeout")) {
          continue;
        }
        console.error("[登录] 轮询错误:", pollErr.message);
      }
    }

    loginStatus = "failed";
    loginMessage = "超时，请重新开始";
    wasConnected = false;
    await tryAutoReconnect();
  } catch (err) {
    loginStatus = "failed";
    loginMessage = err.message;
    wasConnected = false;
    console.error("[登录]", err.message);
    await tryAutoReconnect();
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ==================== 凭证管理 ====================
function saveCredentials(accountId, token, baseUrl, userId) {
  const stateDir = process.env.OPENCLAW_STATE_DIR || path.join(process.env.HOME || "~", ".openclaw");
  const wxDir = path.join(stateDir, "openclaw-weixin");
  const accountsDir = path.join(wxDir, "accounts");
  fs.mkdirSync(accountsDir, { recursive: true });

  // 保存账户文件
  const accountFile = path.join(accountsDir, accountId.replace(/[@.]/g, "-") + ".json");
  fs.writeFileSync(accountFile, JSON.stringify({
    token,
    baseUrl: baseUrl || ILINK_BASE,
    userId: userId || "",
    savedAt: new Date().toISOString(),
  }, null, 2));

  // 保存索引
  fs.writeFileSync(path.join(wxDir, "accounts.json"), JSON.stringify([accountId], null, 2));

  console.log("[凭证] 已保存");
}

// 发送后续拆分的消息（带随机延迟，模拟真人打字间隔）
async function sendRemainingMessages(parts) {
  for (const part of parts) {
    const delay = 800 + Math.random() * 1700;
    await new Promise(r => setTimeout(r, delay));
    try {
      if (botInstance) {
        await botInstance.sendMessage(part);
      }
    } catch (e) {
      console.error("[拆分消息] 发送失败:", e.message);
    }
  }
}

// 确保主动消息定时器在运行（/wake 或重连后可恢复）
function ensureProactiveTimer() {
  if (proactiveTimer) return;
  proactiveTimer = setInterval(async () => {
    const now = Date.now();
    const hour = new Date().getHours();
    if (!botInstance || !proactiveEnabled || !hasReceivedMsg) return;
    if (hour < AUTO_START_HOUR || hour > AUTO_END_HOUR) return;
    if (now < nextProactiveTime) return;

    try {
      // 找最近活跃的用户发主动消息（多用户支持）
      let wxUid = proactiveUserId || "wx-user";
      let userLastMsg = "";
      let latestActivity = 0;
      for (const [cid, state] of conversationStates) {
        if (state.lastActivity > latestActivity) {
          latestActivity = state.lastActivity;
          wxUid = cid;
          userLastMsg = state.lastUserMsg;
        }
      }
      proactiveUserId = wxUid;
      const dbUserId = getOrCreateWxUser(wxUid);
      const pref = getWxCharPreference(wxUid);
      const charId = pref ? pref.characterId : 25;
      const facts = getFacts(dbUserId, charId);
      const defChar = pref
        ? { id: pref.characterId, profile_path: pref.characterPath }
        : getAllCharacters().find(c => c.id === 25) || { id: 25, profile_path: "config/characters/gu-yun-chi.json" };
      const charPrompt = buildCharacterPrompt(defChar.profile_path);
      const msg = await generateProactiveMessage(userLastMsg, facts, pref, charPrompt);
      if (!msg) return;
      const parts = msg.split('|||').map(p => p.trim()).filter(p => p);
      await botInstance.sendMessage(parts[0]);
      if (parts.length > 1) {
        sendRemainingMessages(parts.slice(1));
      }
      console.log("[主动消息] 已发送: " + msg.slice(0, 40) + "...");
      nextProactiveTime = Date.now() + randomInterval();
    } catch (e) {
      console.log("[主动消息] 发送失败: " + e.message);
      nextProactiveTime = Date.now() + 2 * 60 * 1000;
    }
  }, 45_000);
}

// ==================== 启动 Bot ====================
async function startBot(accountId, baseUrl, token, userId) {
  // 防止多实例：先断开旧 Bot
  if (botInstance) disconnectBot();

  if (!sdk) {
    sdk = await import("weixin-agent-sdk");
  }

  const nickname = getUserNickname();

  const lanmengAgent = {
    async chat(req) {
      const uid = req.conversationId || userId || "wx-user";
      let text = (req.text || "").trim();

      resetActivityTimer();
      // 记录每个对话的状态（多用户支持）
      const conv = conversationStates.get(uid) || { lastUserMsg: "", lastActivity: 0 };
      if (text) conv.lastUserMsg = text;
      conv.lastActivity = Date.now();
      conversationStates.set(uid, conv);
      hasReceivedMsg = true;

      // 图片识别：用千问视觉模型描述图片内容
      let imageDesc = null; // 不存入对话历史，仅作 AI 上下文
      if (req.media && req.media.type === "image" && req.media.filePath) {
        const pref = getWxCharPreference(uid);
        const charName = pref ? (pref.characterPath.includes("gu-yun-chi") ? "顾昀迟" : "") : "";
        console.log("[图片] 收到图片, path=" + req.media.filePath.slice(-30));
        const rawDesc = await describeImage(req.media.filePath, charName);
        if (rawDesc) {
          imageDesc = rawDesc.length > 300 ? rawDesc.slice(0, 300) + "..." : rawDesc;
          if (!text) text = "[图片]"; // 纯图片消息
        } else if (!text) {
          return { text: "看到了，但没看清是什么。" };
        }
        // 清理旧图片，只保留最近 5 张
        cleanupOldImages(req.media.filePath);
      }

      // 语音识别：微信语音 → 文字，当作用户输入走后续流程
      // SDK 已把微信的 SILK 格式转码成 WAV 交过来（media.type === "audio"）
      if (req.media && req.media.type === "audio" && req.media.filePath) {
        console.log("[语音] 收到语音, path=" + req.media.filePath.slice(-30));
        const heard = await transcribeAudio(req.media.filePath);
        if (heard) {
          text = heard; // 自己识别的结果比微信自带转写更可控
        } else if (!text) {
          return { text: "听到了，但没听清你说啥，再说一遍~" };
        }
        // ASR 失败但微信自带转写非空时，保留原 text 继续往下走
        cleanupOldMedia("语音", req.media.filePath);
      }

      if (!text) return { text: nickname + '？你发了啥我怎么没看到~' };

      if (text === "/echo") return { text: "收到啦~ 蓝小梦在线中！" };
      if (text === "/ping") {
        const s = proactiveEnabled ? "开着呢~" : "关着呢，发 /wake 打开";
        return { text: 'pong~ 活着呢老板！自动聊天' + s };
      }
      if (text === "/sleep") {
        proactiveEnabled = false;
        return { text: "好嘞~ 我先睡啦💤" };
      }
      if (text === "/wake") {
        proactiveEnabled = true;
        resetActivityTimer();
        ensureProactiveTimer();
        return { text: "芜湖~ 睡醒了！半小时不理我我就来找你~" };
      }
      if (text.startsWith("/char")) {
        return handleCharCommand(uid, text);
      }
      if (text === "/chars") {
        const visible = getVisibleCharacters();
        return { text: visible.map(c => `${c.id}. ${c.name}`).join("\n") + "\n发送 /char 数字 切换角色" };
      }
      if (text === "/disconnect") {
        conversationStates.delete(uid);
        clearWxCharPreference(uid);
        return { text: "已断开。再发消息我会重新理你。" };
      }
      if (text === "/voice") {
        if (voiceMode.has(uid)) {
          voiceMode.delete(uid);
          return { text: "好，切回纯文字啦~" };
        }
        voiceMode.add(uid);
        return { text: "好呀，接下来我把想说的话录成音频发给你🎧 点开就能听～ 再发一次 /voice 切回文字" };
      }

      try {
        const dbUserId = getOrCreateWxUser(uid);
        // 检查该微信用户是否有偏好的角色
        const pref = getWxCharPreference(uid);
        // 默认角色：顾昀迟(25)，用户可自行切换
        const defChar = pref
          ? { id: pref.characterId, profile_path: pref.characterPath }
          : getAllCharacters().find(c => c.id === 25) || getAllCharacters().find(c => c.id !== 1) || { id: 25, profile_path: "config/characters/gu-yun-chi.json" };
        const reply = await handleMessage(dbUserId, defChar.id, text, defChar.profile_path, imageDesc);

        // 语音模式：整段合成一条音频，做成带波形的视频发出去，不按 ||| 拆句。
        //
        // 为什么不发语音条：微信的 iLink 机器人平台不接受机器人发语音。
        // 把包结构逐字段镜像真实入站语音、并采用参考实现的确切取值后，
        // API 依然返回 200 + message_id 却不在微信里渲染 —— 断在平台侧。
        // 但微信接受视频消息，所以做成视频：点开内联播放，有声音。
        if (voiceMode.has(uid)) {
          const spoken = reply.replace(/\|\|\|/g, "，");
          const wav = await synthesize(spoken);
          if (wav) {
            const mp4 = await wavToVideo(wav);
            if (mp4) {
              return { text: spoken, media: { type: "video", url: mp4 } };
            }
            // ffmpeg 挂了就退回文件卡片，至少声音能到你手上
            console.log("[语音] 视频合成失败，回退成文件发送");
            return { text: spoken, media: { type: "file", url: wav } };
          }
          console.log("[语音] 合成失败，回退成文字发送");
        }

        // 按 ||| 拆分为多条消息，模拟真人发微信
        const parts = reply.split('|||').map(p => p.trim()).filter(p => p);
        if (parts.length > 1) {
          sendRemainingMessages(parts.slice(1));
        }
        return { text: parts[0] };
      } catch (err) {
        console.error("[蓝小梦]", err.message);
        return { text: "哎呀出了点岔子…等下我缓缓重来😭" };
      }
    },
  };

  botAbortController = new AbortController();
  botInstance = sdk.start(lanmengAgent, { accountId, abortSignal: botAbortController.signal });

  console.log('✅ Bot 已启动 (accountId=' + accountId + ')');

  proactiveEnabled = true;
  hasReceivedMsg = false;
  proactiveUserId = userId || null;
  nextProactiveTime = Date.now() + randomInterval();
  ensureProactiveTimer();
}

function resetActivityTimer() {
  lastActivityTime = Date.now();
  nextProactiveTime = Date.now() + randomInterval(); // 有活动就重置触发时间
}

// ==================== 优雅退出 ====================
process.on("SIGINT", () => {
  console.log("");
  if (proactiveTimer) clearInterval(proactiveTimer);
  server.close();
  console.log(CHARACTER + ' > 拜拜了您内~');
  process.exit(0);
});

// ==================== 启动 ====================
console.log("");
console.log('╔═══════════════════════════════╗');
console.log('║  ' + CHARACTER + ' — 微信桥接 v3 (服务器版) ║');
console.log('╚═══════════════════════════════╝');
console.log("");

// 检查 API Key
if (!process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY.includes("your-key")) {
  console.log("❌ 请先配置 DEEPSEEK_API_KEY");
  process.exit(1);
}

// 初始化数据库
console.log("🗄️  初始化数据库...");
seedCharacters([
  { name: "蓝色大肥鱼", profile_path: "config/characters/da-fei-yu.json" },
  { name: "顾昀迟", profile_path: "config/characters/gu-yun-chi.json" },
  { name: "晏烬", profile_path: "config/characters/yan-jin.json" },
  { name: "紫零", profile_path: "config/characters/zi-ling.json" },
]);
// 迁移旧的 JSON 记忆数据
try { migrateJSONtoDB(); console.log("📦 旧数据已迁移到数据库"); } catch {}

startHTTPServer();
console.log("");
console.log("📋 使用步骤:");
console.log('  1. 打开浏览器访问 http://<服务器IP>:' + PORT);
console.log("  2. 点击「开始连接微信」");
console.log("  3. 手机微信扫描页面上的二维码");
console.log("  4. 授权后自动连接，开始聊天！");
console.log("");
console.log("💡 微信聊天命令: /wake 开主动消息  /sleep 关主动消息  /ping 在线检测");
console.log("");

// 自动检查是否已登录
try {
  sdk = await import("weixin-agent-sdk");
  if (sdk.isLoggedIn()) {
    console.log("📱 检测到已有微信登录凭证，自动启动 Bot...");
    const ids = JSON.parse(fs.readFileSync(
      path.join(process.env.HOME || "~", ".openclaw", "openclaw-weixin", "accounts.json"),
      "utf-8"
    ));
    if (ids.length > 0) {
      accountId = ids[0];
      const accountFile = path.join(
        process.env.HOME || "~", ".openclaw", "openclaw-weixin", "accounts",
        accountId.replace(/[@.]/g, "-") + ".json"
      );
      const account = JSON.parse(fs.readFileSync(accountFile, "utf-8"));
      await startBot(accountId, account.baseUrl, account.token, account.userId);
      loginStatus = "confirmed";
      console.log("✅ 自动启动成功！");
    }
  }
} catch {
  console.log("📱 未检测到登录凭证，请通过网页扫码登录");
}
