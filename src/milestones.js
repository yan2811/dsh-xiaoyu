import {
  addMilestone, getMilestones, loadRelation, updateRelation,
  RELATION_STAGES,
} from "./growth.js";

// ============================================================
//  关系里程碑：第一次见面、表白、吵架和好、生日、纪念日……
//  里程碑可以推动关系阶段，但一次只前进一档
// ============================================================

const RULES = [
  { key: "first_meet", title: "第一次见面", re: /第一次(见面|见你|碰面)/ },
  { key: "first_deep_talk", title: "第一次聊到心里话", re: /第一次(聊这么深|说这么多|掏心窝)/, stageHint: "熟悉", minIntimacy: 30 },
  { key: "confession", title: "第一次表白", re: /(我喜欢你|我爱你|喜欢你|表白|告白|在一起吧)/, stageHint: "亲近", minIntimacy: 50 },
  { key: "first_fight", title: "第一次吵架", re: /(吵架|吵起来|闹别扭|不理你|生气了)/ },
  { key: "reconcile", title: "吵架后和好", re: /(对不起|和好|原谅|不生气了|没事了)/, stageHint: "自己人", minIntimacy: 80 },
  { key: "birthday", title: "对方的生日", re: /(今天|明天|后天).{0,4}生日|生日是/ },
  { key: "anniversary", title: "纪念日", re: /纪念日/ },
  { key: "first_gift", title: "第一次送礼物", re: /(送你|给你的礼物|礼物)/ },
  { key: "first_call", title: "第一次打电话", re: /(打电话|语音通话|电话里)/ },
];

function today() {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

function maybeAdvance(userId, stageHint, minIntimacy = 0) {
  const r = loadRelation(userId);
  if (r.intimacy < minIntimacy) return false;

  const cur = RELATION_STAGES.indexOf(r.stage);
  const target = RELATION_STAGES.indexOf(stageHint);
  if (cur < 0 || target < 0 || target <= cur) return false;

  const next = RELATION_STAGES[Math.min(cur + 1, target)];
  if (next === r.stage) return false;
  updateRelation(userId, { stage: next });
  return true;
}

export function observeMilestone(userId, text) {
  const t = String(text || "").trim();
  if (!t) return [];
  const added = [];

  for (const rule of RULES) {
    if (!rule.re.test(t)) continue;
    const res = addMilestone(userId, {
      key: rule.key,
      title: rule.title,
      date: today(),
      stageHint: rule.stageHint || "",
    });
    if (!res?.added) continue;
    added.push(res.milestone);
    if (rule.stageHint) maybeAdvance(userId, rule.stageHint, rule.minIntimacy || 0);
  }

  if (added.length) {
    console.log(`[里程碑] ${added.map(m => m.title).join("、")}`);
  }
  return added;
}

export function formatMilestones(userId) {
  const ms = getMilestones(userId);
  if (!ms.length) return "还没有里程碑。";
  return ms
    .map(m => `#${m.id} ${m.title}（${m.date}）${m.stageHint ? ` → ${m.stageHint}` : ""}`)
    .join("\n");
}

export function getMilestonesForPanel(userId) {
  return getMilestones(userId);
}
