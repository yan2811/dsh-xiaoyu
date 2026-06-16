// 蓝小梦主动消息 — 角色感知版本

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function getHourPeriod() {
  const hour = new Date().getHours();
  if (hour >= 8 && hour < 11) return "morning";
  if (hour >= 11 && hour < 14) return "noon";
  if (hour >= 14 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 20) return "evening";
  return "night";
}

// ============ 蓝小梦 ============
const LM_MORNING = ["早呀~ 刚睡醒 你今天几点起的","早上好！你今天那边忙不忙","醒了 但不想起…你今天有安排吗","做了个梦 梦到找不着你了 赶紧看看手机","早~ 今天外面天气好好 适合翘班"];

const LM_NOON = ["中午了！你吃了没 我点了外卖","好饿好饿 你吃饭了吗 不许说还没吃","中午休息下不 别一直盯着屏幕","今天中午吃麻辣烫 真贵 以前才20多"];

const LM_AFTERNOON = ["下午好困…你是不是也困","好无聊哦 你在干嘛 给我讲讲","刚刷到一个视频笑死 发你了 [动画表情]","今天下午喝了奶茶 你别说我胖 已经喝了"];

const LM_EVENING = ["天快黑了 你今天过得咋样","好想你啊 你忙完记得找我~","突然好想吃火锅 咱俩啥时候去吃一顿","今天面试凉了呜呜 快安慰我[苦涩]"];

const LM_NIGHT = ["洗完澡躺床上了 你也赶紧的","在刷剧 看到男女主吵架 气死了","不早了哦 明天还要起吧 早点休息","我今天好累 但是不想睡 陪我聊会儿~"];

const LM_ALL = ["突然想到一个好笑的梗 算了不说了","今天下楼看到猫了 好粘人 跟你一样","在想你 没什么事 就是想你了","好烦 今天被我妈念叨了","看到别人遛狗 好可爱 以后我们也养一只"];

// ============ 知性姐姐 ============
const ZJ_MORNING = ["早，今天天气不错，记得吃早餐","刚煮了杯咖啡，新的一天开始了😊","早上好，昨晚睡得好吗","今天有什么计划吗，加油哦"];

const ZJ_NOON = ["到午饭时间了，别忙得忘记吃","今天食堂有糖醋排骨，忍不住多要了份","休息一下，午饭后走走对身体好","工作要紧但身体更重要，记得吃饭"];

const ZJ_AFTERNOON = ["下午了，困的话喝点茶","我在看一本很有意思的书，推荐给你","今天过得顺利吗，有什么烦心事可以说给我听","忙完了吗，适当摸鱼有益健康"];

const ZJ_EVENING = ["下班了，今天很累吧，辛苦了","晚上记得吃点好的犒劳自己","今天加班吗？别太拼了","回家路上注意安全"];

const ZJ_NIGHT = ["不早了，还在忙吗","早点休息，明天又是新的一天","睡前看书比看手机好入眠哦","晚安，愿你有个好梦🌙"];

const ZJ_ALL = ["看到一句话，很适合你：'万物皆有裂痕，那是光照进来的地方'","今天收到了学妹寄的手作饼干，好幸福","泡了杯蜂蜜柚子茶，心情都好了","加班真的能提升生产力吗？我觉得不能😅","音乐节要来了，想去看看"];

// ============ 搞笑闺蜜 ============
const GM_MORNING = ["我的天我睡到刚才 迟到了哈哈哈哈","早！昨天晚上刷视频刷到三点 我感觉快死了🤣","醒了醒了 别喊了 已经在以0.5倍速起床了","今天闹钟响了我以为是在做梦 梦里还有工资呢"];

const GM_NOON = ["饿死我了我真的好饿 你带吃的没给我们姐妹俩","我点了个外卖 打开发现是某人的照片 真下头[裂开]","中午了姐妹们 该吃吃该喝喝 反正下午继续摸鱼","刚被领导cue了 说我上周只干了三件事 我看了一下 居然是真的🤡"];

const GM_AFTERNOON = ["下午好困 谁来拯救一下 或者给我发个搞笑视频也行","我刚刚在工位上面无表情地转动椅子 被同事问我还好吗","摸鱼摸到鱼都认识我了 这个班是一天都不想上了","刷到一个巨离谱的视频 我发你 你看了别笑出声"];

const GM_EVENING = ["下班了家人们 今天又是没被开除的一天 可喜可贺","我想吃火锅 吃炸鸡 吃冰淇淋 吃完再减肥 反正也没瘦过","我今天怎么又加班了 这个班到底什么时候才是个头","看了一个综艺 笑到我室友以为我在精神分裂🤣"];

const GM_NIGHT = ["不睡 今天不睡 明天不上班 后天也不上 我精神自由🤣","洗完澡了 感觉好困 但是还想刷一下手机 人生就是这样矛盾的","你快睡觉 别熬夜 虽然我还在看但我是为你好","晚安家人们 明天继续搬砖 或者被砖搬"];

const GM_ALL = ["救命 我刚刚干了一件纯纯蠢事 太尴尬了 我应该马上失忆","最近迷上了一件事：看地铁上的人 猜他们是什么星座 太有意思了","今天同事问我脖子酸不酸 我说酸啊 他说那你继续低头看手机 我：…","我的人生信条：遇到事情不要急，先拍照发社交网络"];

// ============ 顾昀迟 ============
const GYC_MORNING = ["起了没。","吃早饭。","今天有安排？","醒着就回一下。"];

const GYC_NOON = ["吃饭，别饿着。","午饭吃了什么。拍给我看。","不许吃泡面。"];

const GYC_AFTERNOON = ["在做什么。","发定位。","别太累。","……没事，就问问。"];

const GYC_EVENING = ["回来了吗。","到哪了，我去接你。","今天还行？"];

const GYC_NIGHT = ["睡了没。","别熬夜。","睡不着就数羊。","手机放下，闭眼。"];

const GYC_ALL = ["……","没事。就想确认你还活着。","想你了。别说出去。"];

// ============ 角色消息池 ============
const CHAR_POOLS = {
  "lan-xiao-meng": { morning: LM_MORNING, noon: LM_NOON, afternoon: LM_AFTERNOON, evening: LM_EVENING, night: LM_NIGHT, all: LM_ALL },
  "zhi-xing-jie-jie": { morning: ZJ_MORNING, noon: ZJ_NOON, afternoon: ZJ_AFTERNOON, evening: ZJ_EVENING, night: ZJ_NIGHT, all: ZJ_ALL },
  "gao-xiao-gui-mi": { morning: GM_MORNING, noon: GM_NOON, afternoon: GM_AFTERNOON, evening: GM_EVENING, night: GM_NIGHT, all: GM_ALL },
  "gu-yun-chi": { morning: GYC_MORNING, noon: GYC_NOON, afternoon: GYC_AFTERNOON, evening: GYC_EVENING, night: GYC_NIGHT, all: GYC_ALL },
};

export function generateProactiveMessage(lastUserMsg, facts, characterPref) {
  // 根据角色 ID 选消息池
  let charId = "lan-xiao-meng";
  if (characterPref && characterPref.characterPath) {
    const match = characterPref.characterPath.match(/config\/characters\/([^.]+)\.json/);
    if (match) charId = match[1];
  }
  const pools = CHAR_POOLS[charId] || CHAR_POOLS["lan-xiao-meng"];
  const period = getHourPeriod();
  const periodPool = pools[period] || pools.all;

  // 事实引用（20%概率）
  if (facts && facts.length > 0 && Math.random() < 0.2) {
    const fact = pickRandom(facts);
    const refs = [`上次你说${fact.value}…突然想起来，随便问问`];
    return pickRandom(refs);
  }

  // 时段消息 60% + 通用 40%
  if (Math.random() < 0.6 && periodPool.length > 0) {
    return pickRandom(periodPool);
  }
  return pickRandom(pools.all);
}
