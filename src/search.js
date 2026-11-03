// 联网搜索模块
// DuckDuckGo 在服务器上不稳定，改用 Bing（HTML + 自动补全），无需 API Key
// 自动检测需要搜索的场景：新闻、梗、事实性问题

const cache = new Map(); // key → { results, time }
const CACHE_TTL = 6 * 60 * 60 * 1000; // 缓存 6 小时
const SEARCH_TIMEOUT = 8000;
const SUGGEST_TIMEOUT = 4000;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// 触发搜索的信号词/模式
const SEARCH_TRIGGERS = [
  // 直接请求搜索
  /(搜索|查一下|搜一下|帮我找|帮我查)/,
  // 事实性提问
  /(什么是|什么叫|是谁|是什么|什么梗|指的是|是什么梗)/,
  // 为什么提问
  /为什么.*(会|要|能|出现|发生|这样)/,
  // 新闻/时事
  /(今天|最近|最新).*(怎么样|发生了什么|有什么|新闻|消息|热点|瓜|八卦|大事)/,
  /(新闻|消息|热搜|热榜|头条|八卦|大瓜)/,
  // 天气/比分/股价等实时数据
  /(天气|温度|股价|汇率|比赛|比分|赛事|赢了|输了|夺冠)/,
  // 最近/有没有模式
  /(最近.*有什么|有没有.*(消息|新闻|新.*(梗|说法|玩法)))/,
  // 全球/国内大事
  /(全球|国内|世上|中国|美国|日本).*(大事|发生|情况)/,
  // 网络梗/流行语
  /(梗|meme|网络流行语|什么来头|怎么火的|哪来的|出处)/i,
  // “你知道 X 吗”这种问法
  /(知道|认识|听说过).{1,12}(吗|不|么|嘛)/,
];

export function shouldSearch(text) {
  if (!text || text.length < 2) return false;
  for (const pattern of SEARCH_TRIGGERS) {
    if (pattern.test(text)) return true;
  }
  return false;
}

function extractKeywords(text) {
  // 去掉语气词和废话，提取关键搜索词
  return text
    .replace(/[「」“”"'『』《》【】()（）]/g, " ")
    .replace(/[？?！!。.，,~～]+/g, " ")
    .replace(/(帮我|请|搜一下|查一下|搜索|什么是|什么叫|怎么样|为什么|是什么|什么梗|什么意思|是谁|这个|那个|一个|什么|怎么|就是|真的|有点)/g, "")
    .trim()
    .slice(0, 120);
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;|&ensp;|&emsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripTags(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

function parseBing(html) {
  const items = [];
  const blocks = String(html || "").split(/<li[^>]*class="[^"]*\bb_algo\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    const h2 = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    if (!h2) continue;

    const title = stripTags(h2[1])
      .replace(/^\d{4}年\d{1,2}月\d{1,2}日\s*/, "")
      .trim();
    const href = (h2[1].match(/href="([^"]+)"/i) || [])[1] || "";
    const p = block.match(/<p[^>]*class="[^"]*\bb_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
      || block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    let snippet = p ? stripTags(p[1].replace(/<a[\s\S]*?<\/a>/gi, " ")) : "";
    snippet = snippet
      .replace(/^\d{4}年\d{1,2}月\d{1,2}日\s*/, "")
      .replace(/\s*阅读更多\s*$/, "")
      .trim();

    if (!title || !snippet) continue;
    items.push({ title, snippet, url: decodeEntities(href) });
    if (items.length >= 5) break;
  }
  return items;
}

async function fetchText(url, timeoutMs = SEARCH_TIMEOUT) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      "Accept": "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) return "";
  return await resp.text();
}

export async function searchBing(query) {
  const q = String(query || "").trim();
  if (!q) return [];

  const urls = [
    `https://cn.bing.com/search?q=${encodeURIComponent(q)}&mkt=zh-CN`,
    `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN&cc=CN`,
  ];
  for (const url of urls) {
    try {
      const html = await fetchText(url);
      if (!html) continue;
      const items = parseBing(html);
      if (items.length) return items;
    } catch {}
  }
  return [];
}

/**
 * Bing 自动补全：把「塔菲」补成「塔菲喵是什么梗」这种可搜的问法。
 */
export async function bingSuggest(term) {
  const q = String(term || "").trim();
  if (!q) return [];
  try {
    const resp = await fetch(
      `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(q)}&market=zh-CN`,
      {
        headers: { "User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9" },
        signal: AbortSignal.timeout(SUGGEST_TIMEOUT),
      }
    );
    if (!resp.ok) return [];
    const data = await resp.json();
    return Array.isArray(data?.[1]) ? data[1].map(String).filter(Boolean).slice(0, 12) : [];
  } catch {
    return [];
  }
}

/**
 * 查一个梗/网络词：先补全，再搜相关问法，过滤掉不相关结果。
 */
export async function searchMeme(term) {
  const clean = String(term || "").trim().slice(0, 30);
  if (!clean) return { term: clean, query: "", items: [] };

  const suggestions = await bingSuggest(clean);
  const goodSuggestions = suggestions.filter(s =>
    s.includes(clean) && /(梗|意思|是谁|什么|出处|来头)/.test(s)
  );
  const queries = [];
  if (goodSuggestions[0]) queries.push(goodSuggestions[0]);
  // 有些词（尊嘟假嘟）加“什么意思”反而被 Bing 拆开，单独加引号最稳
  queries.push(`"${clean}"`);
  queries.push(`${clean} 梗 意思`);

  const seen = new Set();
  for (const q of queries.slice(0, 3)) {
    if (seen.has(q)) continue;
    seen.add(q);
    const items = await searchBing(q);
    const needle = clean.toLowerCase();
    const relevant = items.filter(item => {
      const hay = `${item.title} ${item.snippet}`.toLowerCase();
      return hay.includes(needle);
    });
    if (relevant.length) {
      return { term: clean, query: q, items: relevant.slice(0, 4) };
    }
  }

  return { term: clean, query: queries[0] || clean, items: [] };
}

export async function searchWeb(query) {
  if (!query || query.length < 2) return null;

  const key = query.toLowerCase().trim();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return cached.results;
  }

  let results = null;
  try {
    const items = await searchBing(query);
    if (items.length) {
      results = items.slice(0, 3)
        .map(i => `${i.title}：${i.snippet}`)
        .join(" | ")
        .slice(0, 1200);
    }
  } catch {
    // 搜索失败，静默返回
  }

  if (results) {
    cache.set(key, { results, time: Date.now() });
  }

  return results;
}

// 清理过期缓存（每隔一段时间调用）
export function cleanCache() {
  const now = Date.now();
  for (const [key, val] of cache) {
    if (now - val.time > CACHE_TTL * 2) {
      cache.delete(key);
    }
  }
}

// 定时清理
setInterval(cleanCache, 30 * 60 * 1000);
