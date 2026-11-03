// 梗 / 网络词：本地库优先，查不到再用 Bing 补全搜索，搜到后写回本地库。
import {
  getGlossary, listGlossary, upsertGlossary, bumpGlossaryHit,
} from "./db.js";
import { searchMeme } from "./search.js";

// 这些词出现在候选里就不是梗，避免把普通句子拿去搜
const COMMON_WORDS = [
  "今天", "明天", "昨天", "现在", "最近", "刚才", "等会", "以后", "以前",
  "什么", "怎么", "为什么", "怎么样", "多少", "哪里", "哪个", "这个", "那个",
  "可以", "觉得", "认为", "希望", "想要", "准备", "发现", "看到", "听到",
  "告诉", "知道", "认识", "听说", "意思", "问题", "东西", "事情", "时候",
  "感觉", "喜欢", "讨厌", "开心", "难过", "生气", "睡觉", "吃饭", "上班",
  "下班", "学校", "公司", "朋友", "主人", "语音", "表情", "消息", "聊天",
  "手机", "电脑", "游戏", "视频", "音乐", "电影", "动漫", "小说", "天气",
  "时间", "名字", "一个", "没有", "就是", "真的", "有点", "还是", "但是",
  "因为", "所以", "如果", "然后", "而且", "或者", "不过", "已经", "可能",
  "应该", "需要", "开始", "结束", "东西", "地方", "样子", "自己", "大家",
  "我们", "你们", "他们", "她们", "它们", "不是", "还有", "没有", "什么",
  "为什么", "怎么样", "是不是", "能不能", "要不要", "会不会", "好不好",
  "我看", "我是", "你是", "他是", "她是", "好像", "笑死", "感觉", "真的",
];

// “什么是 X”也可能是正经概念（量子力学），只收像梗的短词
const DEFINITION_PATTERN = /(?:什么是|什么叫|啥是)\s*[「“"'『]?([一-龥A-Za-z0-9]{2,20})/g;
const DEFINITION_AFTER_PATTERN = /([一-龥A-Za-z0-9]{2,20})\s*(?:是什么|是啥)$/g;
const QUESTION_PATTERNS = [
  // 是谁 / 什么梗 / 什么意思
  /(?:是谁|什么梗|什么意思|啥意思|什么来头|怎么火的|哪来的|出处是)\s*[「“"'『]?([一-龥A-Za-z0-9]{2,20})/g,
  // “塔菲”是什么梗
  /[「“"'『]([^」”"'』]{2,20})[」”"'』]\s*(?:是什么|是谁|什么梗|什么意思|啥意思|吗|你懂|知道)/g,
  // 塔菲是谁 / 塔菲什么意思
  /([一-龥A-Za-z0-9]{2,20})\s*(?:是什么梗|是谁|什么意思|啥意思|什么来头|怎么火的|哪来的)/g,
  // 你知道塔菲吗 / 认识塔菲不
  /(?:知道|认识|听说过|懂)\s*[「“"'『]?([一-龥A-Za-z0-9]{2,20})[」”"'』]?\s*(?:吗|不|么|嘛)/g,
];

// 正经学科/技术词，别当梗塞进梗库
const NON_MEME_SUFFIX_RE = /(?:学|论|法|史|主义|效应|定理|公式|方程|反应|系统|技术|工程|经济|政治|文化|社会|心理|哲学|物理|化学|生物|数学|编程|语言|算法|数据|协议|模型|函数|接口|数据库|服务器|客户端|浏览器|操作系统|公司|城市|国家|大学|专业|课程|考试|工作|项目|产品|软件|硬件)$/;

const MARKER_RE = /(梗|笑死|哈哈|绷不住|难绷|抽象|离谱|典|急|孝|蚌|麻了|寄了|摆了|润了|awsl|yyds|xswl|u1s1|666|233|喵|草|乐|赢|输|地狱笑话|发疯文学|废话文学)/i;
const MARKERS = ["喵", "梗", "笑死", "哈哈", "绷不住", "难绷", "抽象", "离谱", "典", "急", "孝", "蚌", "麻了", "寄了", "摆了", "润了"];

// 每个用户最多 30 秒搜一次，避免刷屏时疯狂请求 Bing
const lastSearchAt = new Map();

function cleanCandidate(raw) {
  return String(raw || "")
    .trim()
    .replace(/^[「“"'『《【(（]+|[」”"'』》】)）]+$/g, "")
    .replace(/^(?:你)?(?:知道|认识|听说过|懂|这个|那个|一个|什么|啥|是|叫)+/g, "")
    .replace(/(?:是什么梗|是谁|什么意思|啥意思|什么来头|怎么火的|哪来的|吗|呢|啊|呀|嘛)$/g, "")
    .replace(/^[的地得]+|[的地得]+$/g, "")
    .trim();
}

function isLikelyTerm(s) {
  const t = String(s || "").trim();
  if (t.length < 2 || t.length > 20) return false;
  if (!/[一-龥A-Za-z]/.test(t)) return false;
  if (!/^[一-龥A-Za-z0-9·._-]+$/.test(t)) return false;
  if (COMMON_WORDS.some(w => t.includes(w))) return false;
  return true;
}

function isMemeLikeTerm(s) {
  const t = String(s || "").trim();
  return isLikelyTerm(t) && t.length <= 10 && !NON_MEME_SUFFIX_RE.test(t);
}

function addCandidate(set, raw) {
  const t = cleanCandidate(raw);
  if (isLikelyTerm(t)) set.add(t);
}

// “我看塔菲喵笑死”里取“塔菲”，而不是“我看塔菲”
function addBeforeMarkers(set, raw) {
  for (const marker of MARKERS) {
    let idx = raw.indexOf(marker);
    while (idx >= 0) {
      const before = raw.slice(Math.max(0, idx - 8), idx);
      let picked = "";
      for (let len = before.length; len >= 2; len--) {
        const t = cleanCandidate(before.slice(-len));
        if (!isLikelyTerm(t)) continue;
        if (/^[看听说讲笑我你他她它这那]/.test(t)) continue;
        picked = t;
        break;
      }
      if (picked) set.add(picked);
      idx = raw.indexOf(marker, idx + marker.length);
    }
  }
}

/**
 * 从一句话里抽可能的梗/人名/缩写。
 * 只抽“问法明确 + 引号 + 梗标记 + 整句很短”这几种，避免每句都搜。
 */
export function extractTermCandidates(text) {
  const raw = String(text || "").trim();
  const out = new Set();
  if (!raw) return [];

  for (const pattern of [DEFINITION_PATTERN, DEFINITION_AFTER_PATTERN]) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(raw)) !== null) {
      const t = cleanCandidate(m[1]);
      if (isMemeLikeTerm(t)) out.add(t);
    }
  }

  for (const pattern of QUESTION_PATTERNS) {
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(raw)) !== null) addCandidate(out, m[1]);
  }

  if (MARKER_RE.test(raw)) addBeforeMarkers(out, raw);

  // 用户只发一个词：“塔菲”
  if (raw.length >= 2 && raw.length <= 12 && !/[\s，。！？、,.!?;；:：]/.test(raw)) {
    const t = cleanCandidate(raw);
    if (isMemeLikeTerm(t)) out.add(t);
  }

  const all = [...out];
  const filtered = all.filter(t => !all.some(o => o !== t && o.length < t.length && t.includes(o)));
  return filtered.slice(0, 4);
}

/**
 * 扫本地库里已经有的词，用户哪怕只是提一嘴也能想起来。
 */
export function findKnownTerms(text) {
  const raw = String(text || "");
  if (!raw) return [];
  const lower = raw.toLowerCase();
  const found = [];
  for (const entry of listGlossary(500)) {
    const terms = [entry.term, ...String(entry.aliases || "").split(",")]
      .map(s => s.trim())
      .filter(s => s.length >= 2);
    if (terms.some(t => lower.includes(t.toLowerCase()))) {
      found.push(entry);
      if (found.length >= 3) break;
    }
  }
  return found;
}

function summarizeItems(items) {
  // 第一条通常是百科定义，后面几条经常是“为什么被黑”之类的八卦，容易带偏
  for (const item of items.slice(0, 2)) {
    const text = `${item.title}：${item.snippet}`.trim();
    if (text.length > 15) return text.slice(0, 350);
  }
  return "";
}

/**
 * 查一句话里的梗。
 * 返回 { entries: 本地/刚搜到的词条, unknown: 没查到的词 }
 */
export async function lookupTerms(text, { userId = 0, limit = 2, allowWeb = true } = {}) {
  const entries = [];
  const unknown = [];
  const seen = new Set();

  for (const entry of findKnownTerms(text)) {
    if (entries.length >= limit) break;
    if (seen.has(entry.term)) continue;
    seen.add(entry.term);
    entries.push(entry);
    bumpGlossaryHit(entry.id);
  }

  let webSearched = 0;
  for (const term of extractTermCandidates(text)) {
    if (entries.length >= limit) break;
    if (seen.has(term)) continue;
    seen.add(term);

    const local = getGlossary(term);
    if (local) {
      entries.push(local);
      bumpGlossaryHit(local.id);
      continue;
    }

    const last = lastSearchAt.get(userId) || 0;
    const canWeb = allowWeb && webSearched < 1 && Date.now() - last >= 30000;
    if (!canWeb) {
      unknown.push(term);
      continue;
    }

    webSearched++;
    lastSearchAt.set(userId, Date.now());
    try {
      const result = await searchMeme(term);
      const meaning = summarizeItems(result.items);
      if (meaning) {
        const saved = upsertGlossary({
          term,
          meaning,
          source: result.items[0]?.url || "",
          confidence: 60,
        });
        if (saved) {
          entries.push(saved);
          console.log(`[梗] 学到 ${term}: ${meaning.slice(0, 80)}`);
          continue;
        }
      }
    } catch (e) {
      console.error(`[梗] 查询 ${term} 失败:`, e.message);
    }
    unknown.push(term);
  }

  return { entries, unknown };
}

export function buildGlossaryContext(entries = [], unknown = []) {
  const lines = [];

  if (entries.length) {
    lines.push("## 你本来就认识的网络词/梗");
    for (const e of entries) {
      const aliases = String(e.aliases || "")
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
      const aliasText = aliases.length ? `（也叫 ${aliases.join("、")}）` : "";
      lines.push(`- ${e.term}${aliasText}：${e.meaning}`);
    }
    lines.push("用这些信息自然回应，就像你本来就知道；不要说“我查了一下”或“根据搜索”。");
  }

  if (unknown.length) {
    lines.push("## 你不太确定的词");
    lines.push(`对方提到了“${unknown.join("”“")}”，你不太确定它具体指什么。不要装懂或编解释；可以结合上下文自然地问一句，或者坦率说“这个梗我不太懂”。`);
  }

  return lines.join("\n");
}

export function formatGlossaryEntry(entry) {
  if (!entry) return "";
  const aliases = String(entry.aliases || "").split(",").filter(Boolean);
  return [
    `词条：${entry.term}${aliases.length ? `（也叫 ${aliases.join("、")}）` : ""}`,
    `解释：${entry.meaning}`,
    `来源：${entry.source || "手动添加"}`,
    `命中：${entry.hit_count || 0} 次`,
  ].join("\n");
}
