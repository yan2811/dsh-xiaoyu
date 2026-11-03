import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { handleMessage, stripEmoji } from "./agent.js";
import { buildCharacterPrompt } from "./personality.js";
import {
  seedCharacters, getAllCharacters, createUser, getUserByUsername,
  upsertGlossary, getGlossary, deleteGlossary, listGlossary,
} from "./db.js";
import { lookupTerms, formatGlossaryEntry } from "./glossary.js";
import { describeImage } from "./vision.js";
import { transcribeAudio } from "./asr.js";
import { synthesize, buildVoiceInstruction } from "./tts.js";
import {
  estimateBreezeCredits, canSpendBreeze, recordBreezeUsage, getBreezeBudgetSummary,
} from "./breeze-budget.js";
import { generateProactiveMessage } from "./proactive.js";
import {
  getMemories, saveMemory, deleteMemory, getMemoryCounts,
  MEMORY_CATEGORY_LABELS,
} from "./memory.js";
import { maybeEvolve, forceEvolve } from "./evolution.js";
import {
  getEvolutionSummary, rollback, buildGrowthContext, markOwner,
  loadPersona, loadRelation, updatePersona, updateRelation,
  addMilestone, removeMilestone, RELATION_STAGES,
} from "./growth.js";
import { formatMilestones } from "./milestones.js";
import { addPending, getPending, resolvePending, formatPendingList } from "./owner.js";
import {
  getGroupAuto, setGroupAuto, getGroupSettings, setGroupSettings,
} from "./group-settings.js";
import { recordGroupMessage, getGroupContext } from "./group-context.js";
import { getSettings, updateSettings } from "./settings.js";
import { getRole, addFriend, removeFriend, listFriends } from "./permissions.js";
import { startControlPanel } from "./control-panel.js";
import { getMood, getMoodText, getEmotionLadderText, setMood, EMOTION_LABELS, emotionLevel } from "./mood.js";
import { getStyleSummary, getStyleContext, clearStyle, addManualPhrase, removeManualPhrase } from "./style.js";
import { getRecentDiaryBrief, writeDiaryNow } from "./diary.js";
import { maybePostQzone, getRecentPosts, setPaused, generateQzoneDraft } from "./qzone.js";

// ============================================================
//  蓝小梦 — QQ 适配器（OneBot 11 / NapCat）
//  - 私聊：直接回复
//  - 群聊：只有被 @ 时才回复
//  - 图片：下载后交给千问视觉描述
//  - 语音：下载后交给千问 ASR 转文字
// ============================================================

const WS_URL = process.env.QQ_WS_URL || "ws://127.0.0.1:3001";
const ACCESS_TOKEN = process.env.QQ_ACCESS_TOKEN || "";
const OWNER_ID = Number(process.env.QQ_OWNER_ID || 2811534319);
const DEFAULT_CHAR_ID = Number(process.env.QQ_DEFAULT_CHAR_ID || 25);

// 非主人提到这些，先报给主人审批
const SENSITIVE_RE = /((看看|看一下|瞧瞧|访问|逛逛).{0,8}(空间|说说|相册))|((空间|说说|相册).{0,8}(看看|看一下|瞧瞧|访问|逛逛))|加.{0,4}好友|好友.{0,4}加|能加你|加个好友|同意一下/;

// 群聊自动回复白名单：这些群不用 @ 也会接话
const AUTO_GROUP_IDS = new Set(
  String(process.env.QQ_GROUP_AUTO || "").split(",").map(s => s.trim()).filter(Boolean)
);
const MEDIA_DIR = path.join(process.cwd(), "data", "qq-media");
const MAX_MEDIA = 20;

// 表情包
const STICKER_DIR = path.join(process.cwd(), "data", "stickers");
const STICKER_MANIFEST = loadStickerManifest();
const STICKER_INTENSITY = loadStickerIntensity();

const IMAGE_MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp" };
const AUDIO_MIME = { ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".amr": "audio/amr", ".flac": "audio/flac", ".silk": "audio/silk" };

let ws = null;
let selfId = 0;
let echoSeq = 0;
const pending = new Map();
const charPref = new Map(); // QQ号 → { characterId, characterPath }
const lastStickerAt = new Map(); // QQ号 → 上次发表情的时间
const lastVoiceAt = new Map();   // 会话 → 上次发语音的时间

// 按会话保存语音模式：/voice on 只影响当前私聊或当前群
const VOICE_MODES_FILE = path.join(process.cwd(), "data", "growth", "voice-modes.json");
function loadVoiceModes() {
  try { return JSON.parse(fs.readFileSync(VOICE_MODES_FILE, "utf-8")); }
  catch { return {}; }
}
const voiceModes = new Map(Object.entries(loadVoiceModes()));
function saveVoiceModes() {
  try {
    fs.mkdirSync(path.dirname(VOICE_MODES_FILE), { recursive: true });
    fs.writeFileSync(VOICE_MODES_FILE, JSON.stringify(Object.fromEntries(voiceModes), null, 2));
  } catch (e) {
    console.error("[语音] 保存模式失败:", e.message);
  }
}
function convKey(ev) {
  return ev.message_type === "group" ? `group:${ev.group_id}` : `private:${ev.user_id}`;
}
function getVoiceMode(ev) {
  const mode = voiceModes.get(convKey(ev));
  if (mode) return mode;
  const st = getSettings().voice;
  return ev.message_type === "group" ? (st.groupMode || "off") : (st.mode || "auto");
}
function setVoiceMode(ev, mode) {
  voiceModes.set(convKey(ev), mode);
  saveVoiceModes();
  lastVoiceAt.delete(voiceKey(ev));
}
let reconnectTimer = null;

let lastPrivateUser = OWNER_ID; // 默认回退到主人，重启后也能主动发
let lastUserText = "";
let nextProactiveAt = Date.now() + randomProactiveDelay();

// ---------------- 连接 ----------------

function wsUrl() {
  if (!ACCESS_TOKEN) return WS_URL;
  const sep = WS_URL.includes("?") ? "&" : "?";
  return `${WS_URL}${sep}access_token=${encodeURIComponent(ACCESS_TOKEN)}`;
}

function connect() {
  console.log("[QQ] 连接 NapCat:", WS_URL);
  ws = new WebSocket(wsUrl());

  ws.onopen = () => {
    console.log("[QQ] WebSocket 已连接");
    call("get_login_info", {}).then((r) => {
      selfId = Number(r?.user_id || 0);
      console.log(`[QQ] 登录账号: ${r?.nickname || "?"} (${selfId})`);
      initOwner();
    }).catch(() => {});
  };

  ws.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(String(e.data)); } catch { return; }
    handleEvent(ev).catch((err) => console.error("[QQ] 事件处理失败:", err.message));
  };

  ws.onerror = (e) => console.error("[QQ] WebSocket 错误:", e.message || "unknown");

  ws.onclose = () => {
    console.log("[QQ] 连接断开，3 秒后重连…");
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 3000);
  };
}

function call(action, params = {}, timeoutMs = 15000) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("WebSocket 未连接"));
  }
  const echo = "e" + (++echoSeq);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(echo);
      reject(new Error(`调用 ${action} 超时`));
    }, timeoutMs);
    pending.set(echo, { resolve, reject, timer });
    ws.send(JSON.stringify({ action, params, echo }));
  });
}

// ---------------- 事件处理 ----------------

async function handleEvent(ev) {
  if (ev.post_type === "meta_event") {
    if (ev.meta_event_type === "lifecycle" && ev.self_id) {
      selfId = Number(ev.self_id);
      console.log("[QQ] lifecycle connect, self_id =", selfId);
    }
    return;
  }

  // OneBot 的 API 响应
  if (ev.echo && pending.has(ev.echo)) {
    const p = pending.get(ev.echo);
    pending.delete(ev.echo);
    clearTimeout(p.timer);
    if (ev.status === "ok" || ev.retcode === 0) p.resolve(ev.data);
    else p.reject(new Error(ev.message || ev.wording || "调用失败"));
    return;
  }

  if (ev.post_type === "request") {
    return handleRequest(ev);
  }

  if (ev.post_type !== "message") return;
  if (ev.user_id && ev.user_id === selfId) return; // 忽略自己

  const isGroup = ev.message_type === "group";
  const groupId = String(ev.group_id || "");
  const gs = isGroup ? getGroupSettings(groupId) : null;
  const setting = gs ? gs.autoReply : null;
  const groupAuto = isGroup && (setting === null ? AUTO_GROUP_IDS.has(groupId) : setting);
  const addressed = isMentioned(ev.message) || isCalledByName(ev.message);
  const rawText = (ev.message || [])
    .filter(seg => seg.type === "text")
    .map(seg => seg.data?.text || "")
    .join("")
    .trim();
  // 群控制命令不受“没叫我”限制，否则 /quit 之后没法 /join
  const isGroupCmd = isGroup && (rawText === "/quit" || rawText === "/join");
  const isOwnerCommand = isGroup && isOwner(ev.user_id) && rawText.startsWith("/");

  // 群聊短期上下文：即使这次不接话，也先记下来
  if (isGroup) {
    const senderName = ev.sender?.card || ev.sender?.nickname || String(ev.user_id);
    recordGroupMessage(groupId, {
      userId: ev.user_id,
      name: senderName,
      text: rawText || "[图片/表情]",
      isBot: false,
    });
  }

  // 默认群里只接 @、叫名字或主人的命令；自动模式群则什么都接
  if (isGroup && !groupAuto && !addressed && !isGroupCmd && !isOwnerCommand) return;

  // 自动模式也要看“想不想接话”，不是每条都回
  if (isGroup && groupAuto && !addressed && !isGroupCmd) {
    const base = Number(gs?.willingness ?? getSettings().group?.willingness ?? 0.65);
    const m = getMood();
    let w = Math.max(0, Math.min(1, base));
    w += (m.emotions.happy + m.emotions.clingy) / 400;
    w -= (m.emotions.tired + m.emotions.angry + m.emotions.sad) / 400;
    if (m.energy < 30) w -= 0.15;
    if (isOwner(ev.user_id)) w += 0.1;
    if (rawText.length < 4) w -= 0.1;
    w = Math.max(0, Math.min(1, w));
    if (Math.random() > w) {
      console.log(`[QQ] 群 ${groupId} 意愿不足，跳过`);
      return;
    }
  }

  const textParts = [];
  let imageDesc = null;
  let hasAudio = false;
  let hasFace = false;
  let userSentVoice = false;

  for (const seg of ev.message || []) {
    if (seg.type === "text") {
      textParts.push(seg.data?.text || "");
    } else if (seg.type === "at") {
      if (Number(seg.data?.qq) !== selfId && seg.data?.qq !== "all") {
        textParts.push("@" + (seg.data?.name || seg.data?.qq || ""));
      }
    } else if (seg.type === "image") {
      console.log("[QQ] 收到图片:", JSON.stringify(seg.data || {}).slice(0, 300));
      const file = await downloadSegment(seg.data, "image");
      if (file) {
        const desc = await describeImage(file, getCharName(ev.user_id));
        if (desc) imageDesc = desc.length > 300 ? desc.slice(0, 300) + "..." : desc;
      }
      if (!imageDesc) textParts.push("[图片]");
    } else if (seg.type === "mface") {
      console.log("[QQ] 收到商城表情:", JSON.stringify(seg.data || {}).slice(0, 300));
      let file = null;
      if (seg.data?.url || seg.data?.file) file = await downloadSegment(seg.data, "image");
      if (file) {
        const desc = await describeImage(file, getCharName(ev.user_id));
        if (desc) imageDesc = desc;
      }
      if (!imageDesc) hasFace = true;
    } else if (seg.type === "face") {
      hasFace = true;
    } else if (seg.type === "record") {
      hasAudio = true;
      userSentVoice = true;
      const qqText = seg.data?.text || seg.data?.transcription || "";
      if (qqText) {
        textParts.push(qqText);
        console.log("[语音] QQ 转写:", String(qqText).slice(0, 60));
      } else if (!textParts.some(t => t.trim())) {
        // QQ 没给转写时才用 ASR 兜底
        console.log("[语音] segment:", JSON.stringify(seg.data || {}).slice(0, 300));
        const file = await downloadSegment(seg.data, "audio");
        if (file) {
          const heard = await transcribeAudio(file);
          if (heard) textParts.push(heard);
        }
      }
      if (!textParts.some(t => t.trim())) textParts.push("[语音]");
    }
  }

  let text = textParts.join("").trim();
  if (!text && imageDesc) text = "[图片]";
  if (!text && hasFace) text = "[表情]";
  if (!text) return;

  // 记录最近的私聊对象，用于主动消息
  if (!isGroup) {
    lastPrivateUser = ev.user_id;
    lastUserText = text;
    nextProactiveAt = Date.now() + randomProactiveDelay();
  }

  // 命令
  let cmd = text.trim();
  const role = getRole(ev.user_id, OWNER_ID);

  // /admin：主人高级命令入口；旧命令保留兼容但不放进帮助
  if (cmd === "/admin" || cmd.startsWith("/admin ")) {
    if (role !== "owner") return reply(ev, "只有主人能用 /admin。");
    const sub = cmd.slice(6).trim();
    const [head, ...rest] = sub.split(/\s+/);
    const map = {
      qzone: "/qzone", grow: "/grow", rollback: "/rollback",
      diary: "/diary", evolution: "/evolution", wake: "/wake",
      sleep: "/sleep", pending: "/pending", approve: "/approve", deny: "/deny",
    };
    if (!head || !map[head]) {
      return reply(ev, "用法：/admin qzone|grow|rollback|diary|evolution|wake|sleep|pending|approve|deny");
    }
    cmd = `${map[head]}${rest.length ? " " + rest.join(" ") : ""}`;
  }

  if (cmd === "/friend" || cmd.startsWith("/friend ")) {
    if (role !== "owner") return reply(ev, "只有主人能管好友权限。");
    if (isGroup) return reply(ev, "好友权限请私聊设置。");
    return reply(ev, handleFriendCommand(cmd));
  }

  if (cmd === "/me" || cmd.startsWith("/me ")) {
    if (isGroup && role !== "owner") return reply(ev, "这个私聊我。");
    return reply(ev, handleMeCommand(ev, cmd, role));
  }

  // 群聊设置：/group 查看/调整本群风格、意愿、自动接话；只有主人能用
  if (isGroup && (cmd === "/group" || cmd.startsWith("/group "))) {
    if (!isOwner(ev.user_id)) return reply(ev, "只有主人能调群设置。");
    return reply(ev, handleGroupCommand(groupId, cmd));
  }

  // 群聊开关：/quit 切成“叫名字或 @ 才回”，/join 恢复自动接话；只有主人能用
  if (isGroup && (cmd === "/quit" || cmd === "/join")) {
    if (!isOwner(ev.user_id)) return reply(ev, "只有主人能让我闭嘴。");
    setGroupAuto(groupId, cmd === "/join");
    return reply(ev, cmd === "/quit"
      ? "好，我闭嘴。要找我记得 @ 我或者叫我名字。"
      : "好，我继续在群里待着。");
  }

  // 主人命令：只在私聊响应，避免在群里暴露审批信息
  if (!isGroup && isOwner(ev.user_id)) {
    const ownerReply = await handleOwnerCommand(ev, cmd);
    if (ownerReply) return ownerReply;
  }

  // 非主人的空间/好友类请求：先报给主人，不直接答应
  if (!isOwner(ev.user_id) && !cmd.startsWith("/") && SENSITIVE_RE.test(text)) {
    const item = addPending({
      type: "chat",
      label: "权限申请",
      from: ev.user_id,
      fromName: ev.sender?.card || ev.sender?.nickname || String(ev.user_id),
      comment: text.slice(0, 100),
      messageType: ev.message_type,
      groupId: ev.group_id || null,
    });
    await reportToOwner(
      `【权限申请 #${item.id}】\n${item.fromName}（${item.from}）说：${text.slice(0, 100)}\n\n回复 /approve ${item.id} 同意，/deny ${item.id} 拒绝`
    );
    return reply(ev, "这个我得先问问主人。");
  }

  if (cmd === "/ping") return reply(ev, "pong~ 蓝小梦在 QQ 这边也活着呢");
  if (cmd === "/help" || cmd === "/帮助") return reply(ev, helpText(ev.user_id));
  if (cmd === "/status") {
    if (!isOwner(ev.user_id)) return reply(ev, "这个只有主人能看。");
    const st = getSettings();
    const m = getMood();
    const next = Math.max(0, Math.round((nextProactiveAt - Date.now()) / 60000));
    const top = Object.entries(m.emotions)
      .filter(([, v]) => v >= 15)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${EMOTION_LABELS[k]} ${Math.round(v)}`)
      .join("、");
    return reply(ev, [
      `主动消息：${st.proactive.enabled ? "开" : "关"}，${st.proactive.minMinutes}~${st.proactive.maxMinutes} 分钟，窗口 ${st.proactive.startHour}:00-${st.proactive.endHour}:00，下次约 ${next} 分钟后`,
      `表情包：强 ${Math.round(st.sticker.strongChance * 100)}% / 普通 ${Math.round(st.sticker.weakChance * 100)}%，冷却 ${Math.round(st.sticker.cooldownMs / 1000)} 秒`,
      `进化：${st.evolution.enabled ? "开" : "关"}，每 ${st.evolution.everyMessages} 条，最大 ±${st.evolution.maxTraitDelta}`,
      `群聊意愿：${Math.round((st.group?.willingness ?? 0.65) * 100)}%`,
      `表达学习：${st.style?.enabled ? "开" : "关"}`,
      `心情：${m.value.toFixed(0)}/100，精力 ${m.energy.toFixed(0)}/100`,
      `情绪：${top || "平静"}`,
    ].join("\n"));
  }
  if (cmd === "/panel") {
    if (!isOwner(ev.user_id)) return reply(ev, "只有主人能调。");
    if (isGroup) return reply(ev, "面板口令只在私聊发，私聊我。");
    const url = process.env.PANEL_PUBLIC_URL || "";
    const token = process.env.PANEL_TOKEN || "";
    if (url) {
      return reply(ev, `控制面板：${url}${token ? `\n口令：${token}` : ""}\n手机浏览器直接打开。`);
    }
    return reply(ev, "调整面板在服务器的 127.0.0.1:3722。\n需要 SSH 隧道：\nssh -L 3722:127.0.0.1:3722 root@121.40.231.237\n然后浏览器打开 http://127.0.0.1:3722");
  }
  if (cmd.startsWith("/set ")) {
    if (!isOwner(ev.user_id)) return reply(ev, "只有主人能调。");
    return reply(ev, handleSetCommand(ev.user_id, cmd));
  }
  if (cmd.startsWith("/lock ") || cmd.startsWith("/unlock ")) {
    if (!isOwner(ev.user_id)) return reply(ev, "只有主人能锁。");
    return reply(ev, handleLockCommand(cmd));
  }
  if (cmd === "/sleep") {
    if (role !== "owner") return reply(ev, "只有主人能让我睡。");
    updateSettings({ proactive: { enabled: false } });
    return reply(ev, "好，本鱼去睡了，不主动烦你。");
  }
  if (cmd === "/wake" || cmd === "/wake now") {
    if (role !== "owner") return reply(ev, "只有主人能叫我起来。");
    updateSettings({ proactive: { enabled: true } });
    if (cmd === "/wake now") {
      if (isGroup) return reply(ev, "主动消息要私聊发，私聊我 /wake now。");
      const r = await sendProactiveNow({ force: true, target: OWNER_ID });
      return reply(ev, r.ok ? `发了：${r.text}` : `没发成：${r.reason}`);
    }
    nextProactiveAt = Date.now() + 90_000;
    return reply(ev, "醒了醒了。1~2 分钟后你要是没理我，我会主动来找你；继续聊会顺延。");
  }
  if (cmd === "/mood") {
    return reply(ev, getMoodText());
  }
  if (cmd === "/emo" || cmd.startsWith("/emo ")) {
    if (!isOwner(ev.user_id)) return reply(ev, "只有主人能调情绪。");
    return reply(ev, handleEmoCommand(cmd));
  }
  if (cmd === "/voice" || cmd.startsWith("/voice ")) {
    if (role === "guest") return reply(ev, "语音设置只对好友开放。");
    return reply(ev, await handleVoiceCommand(ev, cmd, { role }));
  }
  if (cmd === "/style" || cmd.startsWith("/style ")) {
    if (role === "guest") return reply(ev, "这个只对好友开放。");
    if (role === "friend" && isGroup) return reply(ev, "这个私聊我。");
    return reply(ev, handleStyleCommand(ev.user_id, cmd));
  }
  if (cmd === "/learn" || cmd.startsWith("/learn ")) {
    if (role !== "owner") return reply(ev, "只有主人能教新词。");
    return reply(ev, handleLearnCommand(cmd));
  }
  if (cmd === "/meme" || cmd.startsWith("/meme ")) {
    return reply(ev, await handleMemeCommand(cmd));
  }
  if (cmd === "/memory" || cmd.startsWith("/memory ")) {
    if (role === "guest") return reply(ev, "这个只对好友开放。");
    if (role === "friend" && isGroup) return reply(ev, "这个私聊我。");
    return reply(ev, handleMemoryCommand(ev.user_id, cmd));
  }
  if (cmd === "/milestone" || cmd.startsWith("/milestone ")) {
    if (role === "guest") return reply(ev, "这个只对好友开放。");
    if (role === "friend" && isGroup) return reply(ev, "这个私聊我。");
    return reply(ev, handleMilestoneCommand(ev.user_id, cmd));
  }
  if (cmd === "/diary") {
    if (role !== "owner") return reply(ev, "只有主人能看日记。");
    const d = getRecentDiaryBrief(3);
    return reply(ev, d ? `最近日记：\n${d}` : "本鱼还没写过日记呢。");
  }
  if (cmd === "/evolution") {
    if (role !== "owner") return reply(ev, "只有主人能看成长状态。");
    const uid = getOrCreateQQUser(ev.user_id);
    return reply(ev, getEvolutionSummary(uid));
  }
  if (cmd === "/rollback") {
    if (role !== "owner") return reply(ev, "只有主人能回滚。");
    const uid = getOrCreateQQUser(ev.user_id);
    const r = rollback(uid);
    return reply(ev, r.ok ? `回滚完成，现在是 v${r.version}。` : `回滚失败：${r.reason}`);
  }
  if (cmd === "/grow") {
    if (role !== "owner") return reply(ev, "只有主人能手动进化。");
    const uid = getOrCreateQQUser(ev.user_id);
    const c = defaultCharacter();
    await reply(ev, "本鱼去想想最近有啥变化……");
    const r = await forceEvolve(uid, { characterId: c.id, profilePath: c.profile_path });
    if (!r.ok) return reply(ev, `进化失败：${r.reason || "未知"}`);
    return reply(ev, r.changed ? `进化完成：${r.changes.join("；")}` : "这次没啥要变的。");
  }
  if (cmd === "/qzone" || cmd.startsWith("/qzone ")) {
    if (role !== "owner") return reply(ev, "只有主人能管说说。");
    const arg = cmd.slice(6).trim();
    if (arg === "pause") { setPaused(true); return reply(ev, "好，不发了。"); }
    if (arg === "resume") { setPaused(false); return reply(ev, "说说恢复。"); }
    if (arg === "draft") {
      const uid = getOrCreateQQUser(ev.user_id);
      const c = defaultCharacter();
      const text = await generateQzoneDraft({ userId: uid, characterId: c.id, profilePath: c.profile_path });
      return reply(ev, text ? `说说草稿：\n${text}` : "这次没憋出来。");
    }
    if (arg === "now") {
      const uid = getOrCreateQQUser(ev.user_id);
      const c = defaultCharacter();
      const r = await maybePostQzone({
        userId: uid, characterId: c.id, profilePath: c.profile_path, send: call, force: true,
      });
      return reply(ev, r.posted ? `发了：${r.content}` : `没发成：${r.reason}`);
    }
    const posts = getRecentPosts(5);
    return reply(ev, posts.length
      ? "最近说说：\n" + posts.map(p => `- ${p.content}`).join("\n")
      : "还没发过说说。");
  }
  if (cmd === "/chars") {
    if (role === "guest") return reply(ev, "角色切换只对好友开放。");
    const list = visibleCharacters().map(c => `${c.id}. ${c.name}`).join("\n");
    return reply(ev, `可选角色：\n${list}\n发送 /char 数字 切换`);
  }
  if (cmd.startsWith("/char")) {
    if (role === "guest") return reply(ev, "角色切换只对好友开放。");
    return reply(ev, handleCharCommand(ev.user_id, cmd));
  }

  if (!text) text = "[图片]";

  const pref = getPref(ev.user_id);
  // 角色 id 不能写死：本地新库的自增 id 和线上库不一致
  const char = pref
    ? { id: pref.characterId, profile_path: pref.characterPath }
    : defaultCharacter();

  console.log(`[QQ] ${isGroup ? "群" + ev.group_id : "私聊"} ${ev.user_id}: ${text.slice(0, 60)}`);

  try {
    const dbUserId = getOrCreateQQUser(ev.user_id);
    let extraContext = isGroup ? getGroupContext(groupId, 10) : "";
    const vm = getVoiceMode(ev);
    if (vm === "on" || (userSentVoice && vm !== "off")) {
      extraContext =
        "## 当前回复方式（语音）\n" +
        "这条回复会被读成语音。请写 35~60 个字的自然口语，像真的在发语音：" +
        "可以用语气词和短停顿，句子连贯；不要用 ||| 拆分，不要只回两三个字，也不要写成电报表。" +
        "不要提“语音条”或“TTS”。\n\n" + extraContext;
    }
    if (isGroup && gs?.tone) {
      extraContext = `## 本群风格\n在这个群里，你说话更${gs.tone}。\n\n` + extraContext;
    }
    const out = await handleMessage(dbUserId, char.id, text, char.profile_path, imageDesc, extraContext);
    const sticker = extractSticker(out);
    const voicePart = extractVoice(sticker.text);
    const answer = voicePart.text;
    const voiceRequested = voicePart.voice;
    let stickerEmotion = sticker.emotion;
    let stickerSource = sticker.emotion ? "ai" : "";
    if (!stickerEmotion) {
      const guess = guessEmotion(text, answer);
      if (guess) {
        const sc = getSettings().sticker;
        let chance = Math.max(0, Math.min(1, Number(guess.strong ? sc.strongChance : sc.weakChance)));
        const lvl = emotionLevel(getMood().emotions[guess.emotion] || 0);
        if (lvl >= 7) chance = Math.min(1, chance + 0.1);
        else if (lvl <= 2) chance = Math.max(0, chance - 0.1);
        if (Math.random() < chance) {
          stickerEmotion = guess.emotion;
          stickerSource = "auto";
        } else {
          console.log(`[QQ] 表情兜底未抽中 (${guess.emotion})`);
        }
      }
    }
    const stickerLevel = stickerEmotion ? emotionLevel(getMood().emotions[stickerEmotion] || 0) : 0;
    const maxEmotionLevel = Math.max(...Object.values(getMood().emotions).map(emotionLevel));
    const voiceLevel = stickerEmotion ? stickerLevel : maxEmotionLevel;

    let voiceSent = false;
    const joined = answer.replace(/\|\|\|/g, "，").trim();
    if (shouldSendVoice({
      ev, text: joined, level: voiceLevel,
      userSentVoice, requested: voiceRequested,
    })) {
      await sleep(400);
      voiceSent = await sendVoice(ev, joined, { emotionLevel: voiceLevel, emotion: stickerEmotion });
    }

    console.log(`[QQ] AI 回复: ${answer.slice(0, 80)}${stickerEmotion ? ` [表情:${stickerEmotion}/${stickerSource}/Lv.${stickerLevel}]` : ""}${voiceSent ? " [语音]" : ""}`);

    const parts = voiceSent ? [] : answer.split("|||").map(s => s.trim()).filter(Boolean);
    if (!voiceSent && parts.length === 0 && !stickerEmotion) return;

    if (!voiceSent && parts.length) {
      await reply(ev, parts[0]);
      for (const part of parts.slice(1)) {
        await sleep(800 + Math.random() * 1700);
        await reply(ev, part);
      }
    }

    if (stickerEmotion && (!voiceSent || stickerLevel >= 8)) {
      await sleep(600 + Math.random() * 900);
      await sendSticker(ev, stickerEmotion, stickerLevel);
    }

    // 后台检查是否到进化回顾点；不阻塞回复
    maybeEvolve(dbUserId, { characterId: char.id, profilePath: char.profile_path })
      .catch(e => console.error("[进化] 后台回顾失败:", e.message));
  } catch (err) {
    // 出错只记日志，不往聊天里发兜底话术
    console.error("[QQ] 回复失败:", err.message);
  }
}

function isMentioned(message) {
  return (message || []).some(seg => seg.type === "at" && Number(seg.data?.qq) === selfId);
}

// 群里叫名字也算是在找她
const NAME_RE = /(大肥鱼|dsh-小鱼|鲸鱼娘|小肥鱼|鱼鱼)/;
function isCalledByName(message) {
  const t = (message || [])
    .filter(seg => seg.type === "text")
    .map(seg => seg.data?.text || "")
    .join("");
  return NAME_RE.test(t);
}

async function reply(ev, text) {
  text = stripEmoji(text);
  if (!text) return;
  const segs = [{ type: "text", data: { text } }];
  const target = ev.message_type === "group" ? ev.group_id : ev.user_id;
  try {
    let r;
    if (ev.message_type === "group") {
      // 群聊回复不 @ 人，直接说话；同时记入群上下文
      recordGroupMessage(ev.group_id, {
        userId: selfId,
        name: "蓝色大肥鱼",
        text,
        isBot: true,
      });
      r = await call("send_group_msg", { group_id: ev.group_id, message: segs });
    } else {
      r = await call("send_private_msg", { user_id: ev.user_id, message: segs });
    }
    console.log(`[QQ] 已发送 -> ${target}: ${text.slice(0, 60)} (msg_id=${r?.message_id ?? "?"})`);
    return r;
  } catch (e) {
    console.error(`[QQ] 发送失败 -> ${target}: ${e.message}`);
    throw e;
  }
}

// ---------------- 主人 / 审批 ----------------

function isOwner(userId) {
  return Number(userId) === OWNER_ID;
}

function helpText(userId) {
  const role = getRole(userId, OWNER_ID);
  const lines = [
    "可用指令：",
    "/help 指令列表",
    "/ping 在线检查",
    "/me 看你和她的关系、记忆、语音状态",
    "/mood 看心情和情绪",
    "/meme 词 查梗；/meme list",
  ];

  if (role === "friend" || role === "owner") {
    lines.push(
      "/voice off|auto|on 开关自己的私聊语音",
      "/char 看/切换角色",
      "/me memory|milestone|style 看自己的记忆/里程碑/表达"
    );
  }

  if (role === "owner") {
    lines.push(
      "",
      "主人指令：",
      "/status 运行状态",
      "/panel 面板地址和口令",
      "/friend add QQ 昵称 / /friend del QQ / /friend list",
      "/voice 完整语音设置；/voice test [文字]",
      "/voice on 123456 给某个好友开语音",
      "/group 群设置；/group 自动 开|关；/group 风格 活泼|安静|毒舌|温柔",
      "/learn 词=解释 教梗",
      "/admin qzone|grow|rollback|diary|evolution|wake|sleep|pending"
    );
  }

  return lines.join("\n");
}

const TRAIT_ALIASES = {
  傲娇: "tsundere", 黏人: "clinginess", 主动: "initiative",
  毒舌: "sharpness", 摸鱼: "laziness", 吃货: "foodie", 温柔: "gentleness",
  tsundere: "tsundere", clinginess: "clinginess", initiative: "initiative",
  sharpness: "sharpness", laziness: "laziness", foodie: "foodie", gentleness: "gentleness",
};

const EMOTION_ALIASES = {
  开心: "happy", 生气: "angry", 愤怒: "angry", 委屈: "sad", 伤心: "sad", 害羞: "shy",
  得意: "proud", 疲惫: "tired", 吃醋: "jealous", 黏人情绪: "clingy",
  happy: "happy", angry: "angry", sad: "sad", shy: "shy",
  proud: "proud", tired: "tired", jealous: "jealous", clingy: "clingy",
};

const MEMORY_ALIASES = {
  承诺: "promise", 约定: "promise", 关系: "relationship", 事件: "event",
  偏好: "preference", 喜好: "preference", 情绪: "emotion", 日常: "daily",
  promise: "promise", relationship: "relationship", event: "event",
  preference: "preference", emotion: "emotion", daily: "daily",
};

const MEMORY_DEFAULT_IMPORTANCE = {
  promise: 90, relationship: 80, event: 70,
  preference: 60, emotion: 50, daily: 30,
};

function handleFriendCommand(cmd) {
  const parts = cmd.trim().split(/\s+/);
  const sub = parts[1] || "";

  if (!sub || sub === "list" || sub === "列表") {
    const list = listFriends();
    if (!list.length) return "好友列表是空的。用法：/friend add QQ号 昵称";
    return "好友列表：\n" + list
      .map(f => `- ${f.qq}${f.name ? `（${f.name}）` : ""}`)
      .join("\n");
  }

  if (sub === "add" || sub === "添加") {
    const name = parts.slice(3).join(" ");
    const r = addFriend(parts[2], name);
    if (!r.ok) return `没加成：${r.reason}`;
    return `已${r.added ? "添加" : "更新"}好友：${r.entry.qq}${r.entry.name ? `（${r.entry.name}）` : ""}`;
  }

  if (sub === "del" || sub === "delete" || sub === "remove" || sub === "删除") {
    const r = removeFriend(parts[2]);
    return r.ok ? `已移除好友：${String(parts[2] || "").replace(/[^\d]/g, "")}` : `没移除：${r.reason}`;
  }

  return "用法：/friend add QQ号 昵称 / /friend del QQ号 / /friend list";
}

function handleMeCommand(ev, cmd, role = "guest") {
  const uid = getOrCreateQQUser(ev.user_id);
  const char = defaultCharacter();
  const parts = cmd.trim().split(/\s+/);
  const sub = parts[1] || "";
  const rest = parts.slice(2).join(" ");

  if (sub === "memory" || sub === "记忆") {
    return handleMemoryCommand(uid, "/memory" + (rest ? " " + rest : ""));
  }
  if (sub === "milestone" || sub === "里程碑") {
    return handleMilestoneCommand(uid, "/milestone" + (rest ? " " + rest : ""));
  }
  if (sub === "style" || sub === "表达") {
    return handleStyleCommand(uid, "/style" + (rest ? " " + rest : ""));
  }
  if (sub === "voice" || sub === "语音") {
    return `当前语音：${getVoiceMode(ev)}（/voice off|auto|on 切换）`;
  }

  const r = loadRelation(uid);
  const counts = getMemoryCounts(uid, char.id);
  const total = counts.reduce((n, c) => n + (Number(c.count) || 0), 0);
  const countText = counts.length
    ? counts.map(c => `${MEMORY_CATEGORY_LABELS[c.category] || c.category} ${c.count}`).join(" / ")
    : "还没有";
  const ms = Array.isArray(r.milestones) ? r.milestones.length : 0;
  const style = getStyleSummary(uid);
  const roleLabel = role === "owner" ? "主人" : role === "friend" ? "好友" : "陌生人";

  return [
    `你的身份：${roleLabel}`,
    `她对你：${r.stage}（亲密度 ${r.intimacy}/100），叫你「${r.nickname}」`,
    getMoodText(),
    `当前语音：${getVoiceMode(ev)}`,
    `长期记忆：${total} 条${total ? `（${countText}）` : ""}`,
    `关系里程碑：${ms} 个`,
    `表达风格：${style ? String(style).slice(0, 120) : "还没学够"}`,
    "可用：/voice off|auto|on  /meme 词  /char",
  ].join("\n");
}

async function handleVoiceCommand(ev, cmd, { role = "owner" } = {}) {
  const st = getSettings().voice;
  const parts = cmd.trim().split(/\s+/);

  const mode = getVoiceMode(ev);

  // 好友只能控制自己私聊的开关，不能碰引擎、音色、预算和群设置
  if (role !== "owner") {
    if (parts.length === 1) {
      return [
        `当前会话语音：${mode}（off / auto / on）`,
        "可用：/voice off / /voice auto / /voice on",
      ].join("\n");
    }
    const sub = parts[1];
    if (["off", "auto", "on"].includes(sub)) {
      if (ev.message_type === "group") return "群语音只有主人能调。";
      setVoiceMode(ev, sub);
      return `当前会话语音：${sub}`;
    }
    return "好友只能用 /voice off|auto|on 控制自己的私聊语音。";
  }

  if (parts.length === 1) {
    const engine = st.provider === "breeze"
      ? "BreezeBlue"
      : st.provider === "cosyvoice" ? "CosyVoice v3.5" : "千问 TTS";
    const voiceLabel = st.provider === "breeze"
      ? `${breezeVoiceName(st.breezeVoiceId)}（${st.breezeVoiceId || "未配置"}）`
      : st.provider === "cosyvoice"
        ? (st.cosyVoiceId ? `设计音色 …${String(st.cosyVoiceId).slice(-8)}` : "未配置 cosyVoiceId")
        : st.voiceId;
    const budget = getBreezeBudgetSummary(st.breezeDailyBudget);
    return [
      `当前会话语音：${mode}（off / auto / on）`,
      `引擎：${engine}`,
      `音色：${voiceLabel}`,
      `Breeze 今日：${budget.credits.toFixed(1)}/${budget.budget} 积分，${budget.calls} 条（约剩 ${budget.remaining.toFixed(1)}）`,
      `冷却：${Math.round(st.cooldownMs / 1000)} 秒（auto 模式）`,
      `自动触发：情绪 Lv.${st.autoMinEmotionLevel}+，不超过 ${st.autoMaxChars} 字`,
      `默认：私聊 ${st.mode} / 群聊 ${st.groupMode || "off"}`,
    ].join("\n");
  }

  const sub = parts[1];

  if (["off", "auto", "on"].includes(sub)) {
    const target = String(parts[2] || "").replace(/[^\d]/g, "");
    if (target && target.length >= 5) {
      setVoiceMode({ message_type: "private", user_id: Number(target) }, sub);
      return `已把 QQ ${target} 的私聊语音设为 ${sub}`;
    }
    setVoiceMode(ev, sub);
    return `当前会话语音：${sub}`;
  }

  if (sub === "voice" || sub === "音色") {
    const allowed = ["Chelsie", "Serena", "Momo", "Vivian", "Bella", "Cherry", "Maia"];
    const v = parts[2];
    if (!v || v === "list" || v === "列表") {
      return [
        "Breeze 音色：迷糊（大肥鱼）/ 机灵（大肥鱼）/ 香农 / 知绘 / 哈基米",
        "也可以直接发 voice_id：/voice voice voc_xxxxxxxx",
        "CosyVoice：/voice voice cosy",
        "千问：/voice voice Maia 或 /voice voice qwen",
      ].join("\n");
    }
    if (v.startsWith("voc_")) {
      updateSettings({ voice: { provider: "breeze", breezeVoiceId: v } });
      return `已切换到 Breeze 音色：${v}`;
    }
    const breezeId = BREEZE_VOICE_ALIASES[v];
    if (breezeId) {
      updateSettings({ voice: { provider: "breeze", breezeVoiceId: breezeId } });
      return `已切换到 Breeze 音色：${v}（${breezeId}）`;
    }
    if (v === "cosy" || v === "cosyvoice") {
      if (!st.cosyVoiceId) return "还没配置 CosyVoice 音色，先在面板里填 voice_id。";
      updateSettings({ voice: { provider: "cosyvoice" } });
      return `已切换到 CosyVoice 设计音色（…${String(st.cosyVoiceId).slice(-8)}）`;
    }
    if (v === "qwen") {
      updateSettings({ voice: { provider: "qwen" } });
      return `已切换到千问 TTS（${st.voiceId}）`;
    }
    if (!allowed.includes(v)) {
      return "可用：迷糊 / 机灵 / 香农 / 知绘 / 哈基米 / voc_... / cosy / qwen / " + allowed.join(" / ");
    }
    updateSettings({ voice: { provider: "qwen", voiceId: v } });
    return `音色：${v}`;
  }

  if (sub === "speed" || sub === "语速") {
    const n = Number(parts[2]);
    if (!Number.isFinite(n) || n < 0.5 || n > 2) return "Breeze 语速 0.5~2.0";
    updateSettings({ voice: { breezeSpeed: n } });
    return `Breeze 语速：${n}`;
  }

  if (sub === "budget" || sub === "预算") {
    const n = Number(parts[2]);
    if (!Number.isFinite(n) || n < 0 || n > 2000) return "Breeze 每日预算 0~2000 积分（0 = 不用 Breeze）";
    updateSettings({ voice: { breezeDailyBudget: n } });
    return `Breeze 每日预算：${n} 积分`;
  }

  if (sub === "cooldown") {
    const n = Number(parts[2]);
    if (!Number.isFinite(n) || n < 0 || n > 3600) return "冷却秒数 0~3600";
    updateSettings({ voice: { cooldownMs: n * 1000 } });
    return `语音冷却：${n} 秒`;
  }

  if (sub === "minlevel") {
    const n = Number(parts[2]);
    if (!Number.isFinite(n) || n < 0 || n > 10) return "等级 0~10";
    updateSettings({ voice: { autoMinEmotionLevel: n } });
    return `自动语音情绪等级：Lv.${n}`;
  }

  if (sub === "test") {
    if (ev.message_type === "group") return "测试语音请私聊我。";
    const text = parts.slice(2).join(" ").trim() || "测试语音条，能听到吗？我是蓝色大肥鱼。";
    const ok = await sendVoice(ev, text, { force: true });
    return ok ? "语音已发送。" : "语音发送失败，检查 TTS 日志。";
  }

  return "用法：/voice / /voice off|auto|on / /voice voice 迷糊|机灵|香农|知绘|哈基米|voc_...|cosy|qwen / /voice speed 1.0 / /voice budget 350 / /voice cooldown 180 / /voice minlevel 6 / /voice test [文字]";
}

function handleGroupCommand(groupId, cmd) {
  const s = getGroupSettings(groupId);
  const parts = cmd.trim().split(/\s+/);
  const auto = s.autoReply === null
    ? (AUTO_GROUP_IDS.has(groupId) ? "开" : "关")
    : (s.autoReply ? "开" : "关");
  const willing = s.willingness === null ? "全局" : `${Math.round(s.willingness * 100)}%`;

  if (parts.length === 1) {
    return `本群设置：\n自动接话：${auto}\n意愿：${willing}\n风格：${s.tone || "默认"}`;
  }

  const key = parts[1];
  const val = parts.slice(2).join(" ").trim();

  if (key === "风格" || key === "tone") {
    const tone = ["活泼", "安静", "毒舌", "温柔"].includes(val) ? val : "";
    setGroupSettings(groupId, { tone });
    return `本群风格：${tone || "默认"}`;
  }
  if (key === "意愿" || key === "willing") {
    const n = Number(val);
    if (!Number.isFinite(n) || n < 0 || n > 100) return "意愿要 0~100";
    setGroupSettings(groupId, { willingness: n / 100 });
    return `本群意愿：${Math.round(n)}%`;
  }
  if (key === "自动" || key === "auto") {
    const on = /^(开|on|true|1|yes)$/i.test(val);
    setGroupSettings(groupId, { autoReply: on });
    return `本群自动接话：${on ? "开" : "关"}`;
  }
  return "用法：/group / /group 风格 活泼|安静|毒舌|温柔|默认 / /group 意愿 70 / /group 自动 开|关";
}

function handleMilestoneCommand(userId, cmd) {
  const parts = cmd.trim().split(/\s+/);
  const sub = parts[1] || "";

  if (!sub || sub === "list") return formatMilestones(userId);

  if (sub === "add") {
    const title = parts[2];
    const stage = parts[3] || "";
    if (!title) return "用法：/milestone add 第一次见面 [阶段]";
    const stageHint = RELATION_STAGES.includes(stage) ? stage : "";
    const r = addMilestone(userId, { key: title, title, stageHint });
    if (!r) return "添加失败。";
    return r.added
      ? `已记录里程碑：${title}${stageHint ? " → " + stageHint : ""}`
      : `已经有这个里程碑了：${title}`;
  }

  if (sub === "forget" || sub === "delete") {
    const id = Number(parts[2]);
    if (!Number.isFinite(id)) return "用法：/milestone forget 编号";
    removeMilestone(userId, id);
    return `已删除里程碑 #${id}`;
  }

  return "用法：/milestone / /milestone add 标题 [阶段] / /milestone forget 编号";
}

function handleMemoryCommand(userId, cmd) {
  const c = defaultCharacter();
  const parts = cmd.trim().split(/\s+/);
  const sub = parts[1] || "";

  if (!sub || sub === "list") {
    const items = getMemories(userId, c.id, 12);
    if (!items.length) return "还没有长期记忆。";
    return "最近的记忆：\n" + items
      .map(m => `#${m.id} [${MEMORY_CATEGORY_LABELS[m.category]}] ${m.key}：${m.value}`)
      .join("\n");
  }
  if (sub === "counts") {
    const counts = getMemoryCounts(userId, c.id);
    return counts.length
      ? counts.map(x => `${MEMORY_CATEGORY_LABELS[x.category] || x.category}：${x.count}`).join(" / ")
      : "还没有记忆。";
  }
  if (sub === "add") {
    const cat = MEMORY_ALIASES[parts[2]];
    const key = parts[3];
    const value = parts.slice(4).join(" ").trim();
    if (!cat || !key || !value) {
      return "用法：/memory add 承诺 周六吃饭 答应周六下午一起吃饭";
    }
    saveMemory({
      userId, characterId: c.id, category: cat, key, value,
      importance: MEMORY_DEFAULT_IMPORTANCE[cat] || 50, source: "manual",
    });
    return `记住了：[${MEMORY_CATEGORY_LABELS[cat]}] ${key}`;
  }
  if (sub === "forget" || sub === "delete") {
    const id = Number(parts[2]);
    if (!Number.isFinite(id)) return "用法：/memory forget 编号";
    deleteMemory(id);
    return `已删除 #${id}`;
  }
  if (sub === "search") {
    const q = parts.slice(2).join(" ").trim();
    if (!q) return "用法：/memory search 关键词";
    const items = getMemories(userId, c.id, 300)
      .filter(m => m.key.includes(q) || m.value.includes(q))
      .slice(0, 10);
    return items.length
      ? items.map(m => `#${m.id} [${MEMORY_CATEGORY_LABELS[m.category]}] ${m.key}：${m.value}`).join("\n")
      : "没找到。";
  }
  return "用法：/memory / /memory add 类别 标签 内容 / /memory forget 编号 / /memory search 关键词 / /memory counts";
}

function handleStyleCommand(userId, cmd) {
  const parts = cmd.trim().split(/\s+/);
  if (parts.length === 1) return getStyleSummary(userId);

  const action = parts[1];
  if (action === "on" || action === "off") {
    updateSettings({ style: { enabled: action === "on" } });
    return `表达学习${action === "on" ? "开" : "关"}`;
  }
  if (action === "clear" || action === "reset") {
    clearStyle(userId);
    return "表达学习记录已清空。";
  }
  if (action === "add") {
    const text = parts.slice(2).join(" ").trim();
    const r = addManualPhrase(userId, text);
    return r ? `已记住口头禅「${r}」` : "用法：/style add 笑死";
  }
  if (action === "remove" || action === "del") {
    const text = parts.slice(2).join(" ").trim();
    removeManualPhrase(userId, text);
    return `已移除「${text}」`;
  }
  return "用法：/style / /style on|off / /style add 口头禅 / /style remove 口头禅 / /style clear";
}

function handleLearnCommand(cmd) {
  const body = cmd.replace(/^\/learn\s*/i, "").trim();
  if (!body) return "用法：/learn 塔菲=永雏塔菲，B站虚拟主播，口头禅是关注塔菲喵";

  const eq = body.match(/^(.{1,30}?)\s*[=＝:：]\s*([\s\S]{2,500})$/);
  let term, meaning;
  if (eq) {
    term = eq[1].trim();
    meaning = eq[2].trim();
  } else {
    const parts = body.split(/\s+/);
    if (parts.length < 2) return "用法：/learn 塔菲=永雏塔菲，B站虚拟主播，口头禅是关注塔菲喵";
    term = parts[0];
    meaning = parts.slice(1).join(" ");
  }

  const entry = upsertGlossary({
    term,
    meaning,
    source: "manual",
    confidence: 90,
    category: "meme",
  });
  if (!entry) return "没记下来，词或解释太短了。";
  return `记住了：${entry.term}\n${entry.meaning}`;
}

async function handleMemeCommand(cmd) {
  const body = cmd.replace(/^\/meme\s*/i, "").trim();

  if (!body || body === "list" || body === "列表") {
    const list = listGlossary(20);
    if (!list.length) return "梗库还是空的。发 /learn 词=解释 教我。";
    return "最近学的词：\n" + list
      .map(e => `- ${e.term}：${String(e.meaning).slice(0, 50)}`)
      .join("\n");
  }

  const del = body.match(/^(?:del|delete|forget|删|删除)\s+(.+)$/i);
  if (del) {
    const n = deleteGlossary(del[1].trim());
    return n ? `已删除「${del[1].trim()}」` : `梗库里没有「${del[1].trim()}」`;
  }

  const term = body.replace(/^(?:查|查询|lookup)\s+/i, "").trim().slice(0, 30);
  if (!term) return "用法：/meme 塔菲 / /meme list / /meme del 塔菲";

  let entry = getGlossary(term);
  if (!entry) {
    const result = await lookupTerms(term, { userId: 0, limit: 1 });
    entry = result.entries[0] || null;
  }
  if (!entry) return `没查到「${term}」。可以 /learn ${term}=你知道的解释`;
  return formatGlossaryEntry(entry);
}

function handleEmoCommand(cmd) {
  const parts = cmd.trim().split(/\s+/);
  const m = getMood();

  if (parts.length === 1) {
    return "当前情绪：\n" + Object.entries(EMOTION_LABELS)
      .map(([k, label]) => {
        const v = m.emotions[k] || 0;
        return `${label} ${Math.round(v)}（Lv.${emotionLevel(v)}）`;
      })
      .join(" / ");
  }

  if (parts[1] === "reset") {
    const reset = {};
    for (const k of Object.keys(EMOTION_LABELS)) reset[k] = 0;
    setMood({ emotions: reset });
    return "情绪已清零。";
  }

  const key = EMOTION_ALIASES[parts[1]] || parts[1];
  if (!(key in EMOTION_LABELS)) {
    return "可用情绪：" + Object.values(EMOTION_LABELS).join(" / ");
  }
  const num = Number(parts[2]);
  if (!Number.isFinite(num) || num < 0 || num > 100) return "数值要在 0~100";

  setMood({ emotions: { [key]: num } });
  return `${EMOTION_LABELS[key]} 调到 ${Math.round(num)}`;
}

function handleSetCommand(userId, cmd) {
  const parts = cmd.trim().split(/\s+/);
  const key = parts[1];
  const val = parts.slice(2).join(" ").trim();
  if (!key || !val) return "用法：/set 傲娇 80";

  const num = Number(val);
  const inRange = (min, max) => Number.isFinite(num) && num >= min && num <= max;

  const trait = TRAIT_ALIASES[key];
  if (trait) {
    if (!inRange(0, 100)) return "数值要在 0~100";
    updatePersona({ traits: { [trait]: num } });
    return `${key} 调到 ${Math.round(num)}`;
  }
  if (key === "心情" || key === "mood") {
    if (!inRange(-100, 100)) return "心情要在 -100~100";
    setMood({ value: num });
    return `心情调到 ${Math.round(num)}`;
  }
  if (key === "精力" || key === "energy") {
    if (!inRange(0, 100)) return "精力要在 0~100";
    setMood({ energy: num });
    return `精力调到 ${Math.round(num)}`;
  }
  if (key === "亲密" || key === "intimacy") {
    if (!inRange(0, 100)) return "亲密度要在 0~100";
    updateRelation(userId, { intimacy: num });
    return `亲密度调到 ${Math.round(num)}`;
  }
  if (key === "称呼" || key === "nickname") {
    updateRelation(userId, { nickname: val });
    return `称呼改为「${val.slice(0, 12)}」`;
  }
  if (key === "阶段" || key === "stage") {
    updateRelation(userId, { stage: val });
    return `关系阶段改为「${val}」`;
  }
  if (key === "表情强" || key === "strong") {
    if (!inRange(0, 100)) return "概率要在 0~100";
    updateSettings({ sticker: { strongChance: num / 100 } });
    return `强情绪触发调到 ${Math.round(num)}%`;
  }
  if (key === "表情普通" || key === "weak") {
    if (!inRange(0, 100)) return "概率要在 0~100";
    updateSettings({ sticker: { weakChance: num / 100 } });
    return `普通情绪触发调到 ${Math.round(num)}%`;
  }
  if (key === "冷却" || key === "cooldown") {
    if (!inRange(0, 120)) return "冷却要在 0~120 秒";
    updateSettings({ sticker: { cooldownMs: num * 1000 } });
    return `表情冷却调到 ${Math.round(num)} 秒`;
  }
  if (key === "主动" || key === "proactive") {
    const on = /^(开|on|true|1|yes)$/i.test(val);
    updateSettings({ proactive: { enabled: on } });
    return `主动消息${on ? "开" : "关"}`;
  }
  if (key === "主动最短" || key === "pmin") {
    if (!inRange(1, 1440)) return "分钟数要在 1~1440";
    updateSettings({ proactive: { minMinutes: num } });
    return `主动最短间隔 ${Math.round(num)} 分钟`;
  }
  if (key === "主动最长" || key === "pmax") {
    if (!inRange(1, 1440)) return "分钟数要在 1~1440";
    updateSettings({ proactive: { maxMinutes: num } });
    return `主动最长间隔 ${Math.round(num)} 分钟`;
  }
  if (key === "进化" || key === "evolution") {
    const on = /^(开|on|true|1|yes)$/i.test(val);
    updateSettings({ evolution: { enabled: on } });
    return `自主进化${on ? "开" : "关"}`;
  }
  if (key === "进化频率" || key === "every") {
    if (!inRange(10, 200)) return "频率要在 10~200 条";
    updateSettings({ evolution: { everyMessages: num } });
    return `每 ${Math.round(num)} 条回顾一次`;
  }
  if (key === "进化幅度" || key === "delta") {
    if (!inRange(1, 5)) return "幅度要在 1~5";
    updateSettings({ evolution: { maxTraitDelta: num } });
    return `单次最大变化 ±${Math.round(num)}`;
  }
  if (key === "群聊意愿" || key === "willing") {
    if (!inRange(0, 100)) return "意愿要在 0~100";
    updateSettings({ group: { willingness: num / 100 } });
    return `群聊意愿调到 ${Math.round(num)}%`;
  }
  if (key === "表达学习" || key === "style") {
    const on = /^(开|on|true|1|yes)$/i.test(val);
    updateSettings({ style: { enabled: on } });
    return `表达学习${on ? "开" : "关"}`;
  }
  return "不认识的设置项。可用：傲娇/黏人/主动/毒舌/摸鱼/吃货/心情/精力/亲密/称呼/阶段/表情强/表情普通/冷却/主动/进化/进化频率/进化幅度/群聊意愿";
}

function handleLockCommand(cmd) {
  const parts = cmd.trim().split(/\s+/);
  const lock = parts[0] === "/lock";
  const name = parts[1] || "";
  const key = TRAIT_ALIASES[name] || name;
  if (!["tsundere", "clinginess", "initiative", "sharpness", "laziness", "foodie", "gentleness"].includes(key)) {
    return "不认识这个性格，可用：傲娇/黏人/主动/毒舌/摸鱼/吃货/温柔";
  }
  const p = loadPersona();
  const set = new Set(p.lockedTraits || []);
  if (lock) set.add(key); else set.delete(key);
  updatePersona({ lockedTraits: [...set] });
  return `${name} 已${lock ? "锁定" : "解锁"}`;
}

function initOwner() {
  if (!OWNER_ID) return;
  try {
    const uid = getOrCreateQQUser(OWNER_ID);
    const rel = markOwner(uid);
    console.log(`[主人] 已绑定 ${OWNER_ID}（当前关系：${rel.stage}）`);
  } catch (e) {
    console.error("[主人] 初始化关系失败:", e.message);
  }
  call("set_friend_remark", { user_id: OWNER_ID, remark: "主人" })
    .then(() => console.log("[主人] QQ 好友备注已设为「主人」"))
    .catch(e => console.log("[主人] 备注设置失败（不影响使用）:", e.message));
}

async function reportToOwner(text) {
  if (!OWNER_ID) return;
  try {
    await call("send_private_msg", {
      user_id: OWNER_ID,
      message: [{ type: "text", data: { text } }],
    });
  } catch (e) {
    console.error("[主人] 汇报失败:", e.message);
  }
}

async function handleOwnerCommand(ev, cmd) {
  if (cmd === "/pending") return reply(ev, formatPendingList());

  const m = cmd.match(/^\/(approve|deny)\s+(\d+)$/);
  if (!m) return null;

  const item = getPending(Number(m[2]));
  if (!item) return reply(ev, `没有 #${m[2]} 这个待处理申请。`);

  const approve = m[1] === "approve";
  try {
    if (item.type === "friend") {
      await call("set_friend_add_request", { flag: item.flag, approve });
    } else if (item.type === "group") {
      await call("set_group_add_request", { flag: item.flag, sub_type: item.subType, approve });
    } else if (item.type === "chat") {
      const text = approve ? "主人同意了。" : "主人说不行。";
      if (item.messageType === "group" && item.groupId) {
        await call("send_group_msg", {
          group_id: item.groupId,
          message: [
            { type: "at", data: { qq: String(item.from) } },
            { type: "text", data: { text: " " + text } },
          ],
        });
      } else {
        await call("send_private_msg", {
          user_id: item.from,
          message: [{ type: "text", data: { text } }],
        });
      }
    }
    resolvePending(item.id, approve ? "approved" : "denied");
    return reply(ev, `已${approve ? "同意" : "拒绝"} #${item.id}（${item.fromName || item.from}）。`);
  } catch (e) {
    return reply(ev, `操作失败：${e.message}`);
  }
}

async function handleRequest(ev) {
  if (Number(ev.user_id) === OWNER_ID) return;

  const isFriend = ev.request_type === "friend";
  const isInvite = ev.sub_type === "invite";
  const label = isFriend ? "好友申请" : isInvite ? "群邀请" : "入群申请";

  let name = String(ev.user_id);
  try {
    const info = await call("get_stranger_info", { user_id: ev.user_id });
    if (info?.nickname) name = info.nickname;
  } catch {}

  const item = addPending({
    type: isFriend ? "friend" : "group",
    label,
    from: ev.user_id,
    fromName: name,
    comment: ev.comment || "",
    flag: ev.flag,
    subType: ev.sub_type || "",
    groupId: ev.group_id || null,
  });

  await reportToOwner(
    `【${label} #${item.id}】\n昵称：${name}\nQQ：${ev.user_id}` +
    (ev.group_id ? `\n群：${ev.group_id}` : "") +
    `\n附言：${ev.comment || "（无）"}\n\n回复 /approve ${item.id} 同意，/deny ${item.id} 拒绝`
  );
}

// ---------------- 表情包 ----------------

function loadStickerManifest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(STICKER_DIR, "manifest.json"), "utf-8"));
  } catch (e) {
    console.error("[QQ] 表情包清单读取失败:", e.message);
    return {};
  }
}

function loadStickerIntensity() {
  try {
    return JSON.parse(fs.readFileSync(path.join(STICKER_DIR, "intensity.json"), "utf-8"));
  } catch {
    return {};
  }
}

// 模型没给标记时，按对话情绪兜底猜一个
function guessEmotion(userText, replyText) {
  const u = String(userText || "");
  const r = String(replyText || "");
  if (/胖|肥|减肥|体重/.test(u)) return { emotion: "angry", strong: true };
  if (/小鱼干|投喂|吃|奶茶|蛋糕|团子|饭|外卖/.test(u)) return { emotion: "eat", strong: true };
  if (/可爱|喜欢|爱你|夸|棒|厉害/.test(u)) return { emotion: "tsundere", strong: true };
  if (/累|困|睡|熬夜|加班/.test(u)) return { emotion: "sleepy", strong: true };
  if (/烦|滚|生气|讨厌|别理我/.test(u)) return { emotion: "sad", strong: true };
  if (/你好|在吗|早安|晚安|早上好/.test(u)) return { emotion: "greeting", strong: false };
  if (/哈哈|笑死|搞笑/.test(u)) return { emotion: "happy", strong: false };
  if (/为什么|啥意思|不懂|啊？/.test(u)) return { emotion: "confused", strong: false };
  if (/震惊|真的假的|卧槽|我靠/.test(u)) return { emotion: "shock", strong: false };
  if (/无语|随便|算了/.test(u)) return { emotion: "speechless", strong: false };
  if (/哼|才不是|嘴硬/.test(r)) return { emotion: "tsundere", strong: false };
  return null;
}

// 从 AI 回复里抽出 [[sticker:happy]] 并去掉标记
function extractSticker(text) {
  let emotion = null;
  const cleaned = String(text || "").replace(/\[\[sticker:([a-zA-Z_]+)\]\]/gi, (_, e) => {
    emotion = e.toLowerCase();
    return "";
  }).replace(/\s{2,}/g, " ").trim();
  return { emotion, text: cleaned };
}

function toFileUrl(p) {
  const s = String(p).replace(/\\/g, "/");
  return s.startsWith("/") ? "file://" + s : "file:///" + s;
}

async function sendSticker(ev, emotion, level = 5) {
  if (!emotion) return;
  // 冷却按会话算，私聊和群聊互不影响
  const key = `${ev.message_type}:${ev.group_id || ""}:${ev.user_id}`;
  const now = Date.now();
  const cooldown = Math.max(0, Number(getSettings().sticker.cooldownMs) || 5000);
  if (now - (lastStickerAt.get(key) || 0) < cooldown) {
    console.log("[QQ] 表情包冷却中，跳过");
    return;
  }

  // 按情绪等级选表情：高等级优先“炸”的图，低等级优先温和的图
  const entry = STICKER_INTENSITY[emotion] || {};
  let list = STICKER_MANIFEST[emotion] || [];
  if (level >= 7 && Array.isArray(entry.strong) && entry.strong.length) list = entry.strong;
  else if (level <= 3 && Array.isArray(entry.mild) && entry.mild.length) list = entry.mild;
  if (!list.length) list = STICKER_MANIFEST[emotion] || STICKER_MANIFEST.happy || [];
  if (!list.length) return;

  const file = path.join(STICKER_DIR, list[Math.floor(Math.random() * list.length)]);
  if (!fs.existsSync(file)) return;

  lastStickerAt.set(key, now);
  const segs = [{ type: "image", data: { file: toFileUrl(file) } }];
  try {
    if (ev.message_type === "group") {
      recordGroupMessage(ev.group_id, {
        userId: selfId,
        name: "蓝色大肥鱼",
        text: "[表情包]",
        isBot: true,
      });
      await call("send_group_msg", { group_id: ev.group_id, message: segs });
    } else {
      await call("send_private_msg", { user_id: ev.user_id, message: segs });
    }
    console.log(`[QQ] 表情包 -> ${emotion}(Lv.${level}): ${path.basename(file)}`);
  } catch (e) {
    console.error("[QQ] 表情包发送失败:", e.message);
  }
}

// ---------------- 语音 ----------------

const BREEZE_VOICE_ALIASES = {
  "迷糊": "voc_8yud7hz7c9q2",
  "大肥鱼": "voc_8yud7hz7c9q2",
  "大肥鱼迷糊": "voc_8yud7hz7c9q2",
  "机灵": "voc_u3nxkd5578wc",
  "大肥鱼机灵": "voc_u3nxkd5578wc",
  "香农": "voc_b86bfwct4cjn",
  "香农小姐": "voc_b86bfwct4cjn",
  "知绘": "voc_rc894j8q2auu",
  "知绘小姐": "voc_rc894j8q2auu",
  "哈基米": "voc_rh6e8hdbraz6",
  "哈基米娘": "voc_rh6e8hdbraz6",
};

function breezeVoiceName(id) {
  const hit = Object.entries(BREEZE_VOICE_ALIASES).find(([, v]) => v === id);
  return hit ? hit[0] : String(id || "").slice(-8);
}

function voiceKey(ev) {
  return `${ev.message_type}:${ev.group_id || ""}:${ev.user_id}`;
}

function beijingHour() {
  return Number(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false }));
}

function isTechnicalText(text) {
  return /```|https?:\/\/|www\.|\d{3,}|代码|函数|报错|安装|命令|链接|接口|数据库/.test(String(text || ""));
}

function extractVoice(text) {
  let voice = false;
  const cleaned = String(text || "").replace(/\[\[voice\]\]/gi, () => {
    voice = true;
    return "";
  }).trim();
  return { voice, text: cleaned };
}

async function sendVoice(ev, text, { emotionLevel: level = 0, emotion = null, force = false } = {}) {
  const st = getSettings().voice;
  let provider = st?.provider === "breeze"
    ? "breeze"
    : st?.provider === "cosyvoice" ? "cosyvoice" : "qwen";
  let voice = provider === "breeze"
    ? st?.breezeVoiceId
    : provider === "cosyvoice" ? st?.cosyVoiceId : st?.voiceId;

  if (!voice) {
    if (provider === "breeze" && st?.cosyVoiceId) {
      provider = "cosyvoice";
      voice = st.cosyVoiceId;
    } else {
      console.log(`[语音] 未配置音色（provider=${provider}）`);
      return false;
    }
  }

  const clean = stripEmoji(text)
    .replace(/\|\|\|/g, "，")
    .replace(/\s+/g, " ")
    .trim();
  const maxLen = ev.message_type === "group" ? 60 : (Number(st.maxChars) || 75);
  if (!clean || clean.length > maxLen) return false;
  if (isTechnicalText(clean)) return false;

  const key = voiceKey(ev);
  const now = Date.now();

  // 没指定情绪时，用当前最强的那一维；低于 25 就当平静
  let voiceEmotion = emotion;
  let voiceLevel = Number(level) || 0;
  if (!voiceEmotion) {
    const m = getMood();
    const top = Object.entries(m.emotions).sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 25) {
      voiceEmotion = top[0];
      voiceLevel = Math.max(voiceLevel, emotionLevel(top[1]));
    }
  }

  const synthWith = async (p) => {
    if (p === "breeze") {
      return await synthesize(clean, {
        provider: "breeze",
        voice: st.breezeVoiceId,
        model: st.breezeModel || "breeze-tts-2",
        instruction: buildVoiceInstruction({
          emotion: voiceEmotion, level: voiceLevel, base: st.breezeBaseInstruction,
        }),
        speed: st.breezeSpeed ?? 1,
      });
    }
    if (p === "cosyvoice") {
      return await synthesize(clean, {
        provider: "cosyvoice",
        voice: st.cosyVoiceId,
        model: st.cosyModel,
        instruction: buildVoiceInstruction({
          emotion: voiceEmotion, level: voiceLevel, base: st.baseInstruction,
        }),
        rate: st.rate,
      });
    }
    return await synthesize(clean, { provider: "qwen", voice: st.voiceId });
  };

  let wav = null;
  if (provider === "breeze") {
    const estimate = estimateBreezeCredits(clean.length);
    if (!canSpendBreeze(estimate, st.breezeDailyBudget)) {
      const u = getBreezeBudgetSummary(st.breezeDailyBudget);
      console.log(`[语音] Breeze 预算不足（今日 ${u.credits}/${u.budget} 积分），改用 CosyVoice`);
      provider = st.cosyVoiceId ? "cosyvoice" : "qwen";
    } else {
      wav = await synthWith("breeze");
      if (wav) {
        const u = recordBreezeUsage(estimate);
        console.log(`[语音] Breeze 今日 ${u.credits}/${st.breezeDailyBudget} 积分（本次估 ${estimate}）`);
      } else {
        console.log("[语音] Breeze 生成失败，改用 CosyVoice");
        provider = st.cosyVoiceId ? "cosyvoice" : "qwen";
      }
    }
  }

  if (!wav) wav = await synthWith(provider);
  if (!wav && provider === "cosyvoice") {
    console.log("[语音] CosyVoice 生成失败，改用千问 TTS");
    wav = await synthWith("qwen");
  }
  if (!wav) return false;

  const segs = [{ type: "record", data: { file: toFileUrl(wav) } }];
  try {
    if (ev.message_type === "group") {
      recordGroupMessage(ev.group_id, {
        userId: selfId,
        name: "蓝色大肥鱼",
        text: "[语音]",
        isBot: true,
      });
      await call("send_group_msg", { group_id: ev.group_id, message: segs });
    } else {
      await call("send_private_msg", { user_id: ev.user_id, message: segs });
    }
    lastVoiceAt.set(key, now);
    console.log(`[语音] 已发送 -> ${ev.message_type === "group" ? ev.group_id : ev.user_id}: ${clean.slice(0, 40)}`);
    return true;
  } catch (e) {
    console.error("[语音] 发送失败:", e.message);
    return false;
  }
}

function shouldSendVoice({ ev, text, level = 0, userSentVoice = false, isProactive = false, requested = false }) {
  const st = getSettings().voice;
  const mode = getVoiceMode(ev);
  if (!st || mode === "off") return false;

  const isGroup = ev.message_type === "group";
  const clean = stripEmoji(text).replace(/\|\|\|/g, "，").trim();
  const maxLen = isGroup ? 60 : (mode === "on" ? (Number(st.maxChars) || 75) : (Number(st.autoMaxChars) || 60));
  if (!clean || clean.length > maxLen) return false;
  if (isTechnicalText(clean)) return false;

  const since = Date.now() - (lastVoiceAt.get(voiceKey(ev)) || 0);
  // on 模式、你发语音我回语音、AI 主动要求：完全不受冷却限制
  if (requested || userSentVoice || mode === "on") return true;

  if (since < (Number(st.cooldownMs) || 180000)) return false;
  if (level >= (Number(st.autoMinEmotionLevel) || 6)) return true;

  if (isProactive) {
    const hour = beijingHour();
    if ((hour >= 21 || hour < 10) && Math.random() < (Number(st.proactiveChance) || 0.4)) return true;
  }
  return false;
}

// ---------------- 主动消息 ----------------

function randomProactiveDelay() {
  const st = getSettings().proactive;
  const minMinutes = Math.max(1, Number(st.minMinutes) || 30);
  const maxMinutes = Math.max(minMinutes, Number(st.maxMinutes) || 60);
  return (minMinutes + Math.random() * (maxMinutes - minMinutes)) * 60000;
}

async function sendProactiveNow({ force = false, target = null } = {}) {
  const st = getSettings().proactive;
  if (!st.enabled && !force) return { ok: false, reason: "主动消息已关闭" };
  if (!ws || ws.readyState !== WebSocket.OPEN) return { ok: false, reason: "WebSocket 未连接" };

  const hour = Number(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai", hour: "2-digit", hour12: false }));
  if (!force && (hour < Number(st.startHour) || hour >= Number(st.endHour))) {
    return { ok: false, reason: `不在 ${st.startHour}:00-${st.endHour}:00` };
  }

  const to = target || lastPrivateUser || OWNER_ID;
  if (!to) return { ok: false, reason: "没有私聊目标" };

  try {
    const dbUserId = getOrCreateQQUser(to);
    const char = defaultCharacter();
    const memories = getMemories(dbUserId, char.id, 20)
      .map(m => ({ key: m.key, value: m.value }));
    let prompt = buildCharacterPrompt(char.profile_path);
    prompt += "\n\n" + buildGrowthContext(dbUserId, {
      moodText: getMoodText(),
      ladderText: getEmotionLadderText(),
      diaryText: getRecentDiaryBrief(2),
      styleText: getStyleContext(dbUserId),
    });
    const raw = await generateProactiveMessage(lastUserText, memories, null, prompt);
    if (!raw) return { ok: false, reason: "生成失败" };

    const sticker = extractSticker(raw);
    const voicePart = extractVoice(sticker.text);
    const answer = voicePart.text;
    const emotion = sticker.emotion;
    const maxLevel = Math.max(...Object.values(getMood().emotions).map(emotionLevel));
    const lv = emotion ? emotionLevel(getMood().emotions[emotion] || 0) : maxLevel;
    const voiceEv = { message_type: "private", user_id: to };
    const joined = answer.replace(/\|\|\|/g, "，").trim();

    let voiceSent = false;
    if (shouldSendVoice({
      ev: voiceEv, text: joined, level: lv,
      userSentVoice: false, isProactive: true, requested: voicePart.voice,
    })) {
      voiceSent = await sendVoice(voiceEv, joined, { emotionLevel: lv, emotion });
    }

    const clean = stripEmoji(answer) || "……";
    if (!voiceSent) {
      await call("send_private_msg", {
        user_id: to,
        message: [{ type: "text", data: { text: clean } }],
      });
    }
    if (emotion && (!voiceSent || lv >= 8)) {
      await sendSticker({ message_type: "private", user_id: to }, emotion, lv);
    }
    console.log("[QQ] 主动消息已发送 ->", to, voiceSent ? "[语音]" : ":", clean.slice(0, 50));
    nextProactiveAt = Date.now() + randomProactiveDelay();
    return { ok: true, text: clean };
  } catch (e) {
    console.error("[QQ] 主动消息失败:", e.message);
    nextProactiveAt = Date.now() + 10 * 60 * 1000;
    return { ok: false, reason: e.message };
  }
}

function startProactive() {
  setInterval(async () => {
    const st = getSettings().proactive;
    if (!st.enabled) return;
    if (Date.now() < nextProactiveAt) return;
    const r = await sendProactiveNow();
    if (!r.ok) {
      console.log("[主动消息] 跳过:", r.reason);
      nextProactiveAt = Date.now() + 10 * 60 * 1000;
    }
  }, 60_000);
  const st = getSettings().proactive;
  console.log(`[QQ] 主动消息${st.enabled ? "已开启" : "已关闭"}（${st.minMinutes}~${st.maxMinutes} 分钟，${st.startHour}:00-${st.endHour}:00）`);
}

// ---------------- 自主行为 ----------------

function startAutonomy() {
  // 心情/精力随时间衰减（每 10 分钟 tick 一次）
  setInterval(() => { try { getMoodText(); } catch {} }, 10 * 60 * 1000);

  // QQ 空间：每 30 分钟检查一次，内部限制 6 小时 / 每天 2 条 / 心情波动
  setInterval(async () => {
    if (!lastPrivateUser) return;
    const c = defaultCharacter();
    const uid = getOrCreateQQUser(lastPrivateUser);
    try {
      const r = await maybePostQzone({ userId: uid, characterId: c.id, profilePath: c.profile_path, send: call });
      if (r.posted) console.log("[自主] 说说已发:", r.content.slice(0, 40));
    } catch (e) {
      console.error("[自主] 说说失败:", e.message);
    }
  }, 30 * 60 * 1000);

  // 日记：23:00 之后写当天的一篇
  let diaryDoneFor = "";
  setInterval(async () => {
    if (!lastPrivateUser) return;
    const bj = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
    if (bj.getHours() < 23) return;
    const day = bj.toLocaleDateString("sv-SE");
    if (diaryDoneFor === day) return;

    const c = defaultCharacter();
    const uid = getOrCreateQQUser(lastPrivateUser);
    try {
      const r = await writeDiaryNow({ userId: uid, characterId: c.id, profilePath: c.profile_path });
      if (r) { diaryDoneFor = day; console.log("[自主] 日记已写"); }
    } catch (e) {
      console.error("[自主] 日记失败:", e.message);
    }
  }, 30 * 60 * 1000);

  console.log("[QQ] 自主行为已开启（心情 / 说说 / 日记）");
}

// ---------------- 媒体 ----------------

async function downloadSegment(data, kind) {
  try {
    fs.mkdirSync(MEDIA_DIR, { recursive: true });

    // NapCat 给的本地缓存路径优先用，省一次下载
    if (data?.path && fs.existsSync(data.path)) return data.path;

    let src = data?.url || data?.file;
    if (!src) return null;

    // 本地路径直接用；找不到就让 NapCat 把缓存文件交出来
    if (!/^https?:\/\//i.test(src)) {
      if (fs.existsSync(src)) return src;
      try {
        const action = kind === "image" ? "get_image" : "get_record";
        const info = await call(action, { file: src }, 10000);
        if (info?.file && fs.existsSync(info.file)) return info.file;
        if (info?.url) src = info.url;
        else return null;
      } catch (e) {
        console.error("[QQ] 取媒体缓存失败:", e.message);
        return null;
      }
    }

    const resp = await fetch(src, { signal: AbortSignal.timeout(20000) });
    if (!resp.ok) { console.error("[QQ] 下载媒体失败:", resp.status); return null; }
    const buf = Buffer.from(await resp.arrayBuffer());

    const ext = pickExt(src, kind, resp.headers.get("content-type"));
    const out = path.join(MEDIA_DIR, `${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    fs.writeFileSync(out, buf);
    cleanupMedia();
    return out;
  } catch (e) {
    console.error("[QQ] 下载媒体异常:", e.message);
    return null;
  }
}

function pickExt(src, kind, contentType) {
  const m = String(src).match(/\.([a-z0-9]{2,5})(?:\?|$)/i);
  if (m) {
    const ext = "." + m[1].toLowerCase();
    if ((kind === "image" ? IMAGE_MIME : AUDIO_MIME)[ext]) return ext;
  }
  const ct = String(contentType || "");
  const map = kind === "image" ? IMAGE_MIME : AUDIO_MIME;
  for (const [ext, mime] of Object.entries(map)) if (ct.includes(mime)) return ext;
  return kind === "image" ? ".jpg" : ".amr";
}

function cleanupMedia() {
  try {
    const files = fs.readdirSync(MEDIA_DIR)
      .map(f => ({ f, t: fs.statSync(path.join(MEDIA_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    files.slice(MAX_MEDIA).forEach(({ f }) => {
      try { fs.unlinkSync(path.join(MEDIA_DIR, f)); } catch {}
    });
  } catch {}
}

// ---------------- 用户 / 角色 ----------------

function getOrCreateQQUser(qq) {
  const username = "qq_" + String(qq).replace(/[^a-zA-Z0-9]/g, "_");
  let user = getUserByUsername(username);
  if (!user) {
    createUser(username, "qq:" + crypto.randomUUID());
    user = getUserByUsername(username);
  }
  return user.id;
}

function visibleCharacters() {
  return getAllCharacters();
}

function defaultCharacter() {
  const all = getAllCharacters();
  return all.find(c => c.name === "蓝色大肥鱼")
    || all.find(c => c.id === DEFAULT_CHAR_ID)
    || all.find(c => c.name === "顾昀迟")
    || all[0]
    || { id: 1, profile_path: "config/characters/da-fei-yu.json" };
}

function getPref(qq) {
  return charPref.get(String(qq)) || null;
}

function getCharName(qq) {
  const pref = getPref(qq);
  if (!pref) {
    const c = defaultCharacter();
    return c.name || "";
  }
  return getAllCharacters().find(c => c.id === pref.characterId)?.name || "";
}

function handleCharCommand(qq, text) {
  const parts = text.trim().split(/\s+/);
  const chars = visibleCharacters();
  if (parts.length < 2) {
    return "用法：/char 数字\n" + chars.map(c => `${c.id}. ${c.name}`).join("\n");
  }
  const id = Number(parts[1]);
  const found = chars.find(c => c.id === id);
  if (!found) return "没有这个角色，可选：\n" + chars.map(c => `${c.id}. ${c.name}`).join("\n");
  charPref.set(String(qq), { characterId: found.id, characterPath: found.profile_path });
  return `切换为 ${found.name}！下条消息就用新角色回你~`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------------- 启动 ----------------

seedCharacters([
  { name: "蓝色大肥鱼", profile_path: "config/characters/da-fei-yu.json" },
  { name: "顾昀迟", profile_path: "config/characters/gu-yun-chi.json" },
  { name: "晏烬", profile_path: "config/characters/yan-jin.json" },
  { name: "紫零", profile_path: "config/characters/zi-ling.json" },
]);

// 预编译一次 prompt，尽早暴露配置路径错误
try { buildCharacterPrompt(defaultCharacter().profile_path); } catch {}

console.log("╔════════════════════════════════╗");
console.log("║   蓝小梦 — QQ 适配器 (OneBot11) ║");
console.log("╚════════════════════════════════╝");
connect();
startProactive();
startAutonomy();
startControlPanel();

process.on("SIGINT", () => {
  console.log("\n[QQ] 正在退出…");
  try { ws?.close(); } catch {}
  process.exit(0);
});
