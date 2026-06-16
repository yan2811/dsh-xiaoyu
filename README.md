# 蓝小梦 — 多角色 AI 聊天平台

支持 **网页聊天** 和 **微信扫码接入** 的 AI 伴侣平台，可自由切换多个角色。

---

## 功能

| 功能 | 说明 |
|------|------|
| 多角色 | 蓝小梦 / 知性姐姐 / 搞笑闺蜜 / 顾昀迟，可扩展 |
| 多用户 | Web 注册登录，每人独立对话，数据隔离 |
| 微信接入 | 扫码即连，支持长句拆分、主动消息 |
| 图片识别 | 微信发图自动调用千问视觉模型识别 |
| SQLite 存储 | 用户、对话、记忆全部入库 |
| 主动消息 | 15-45 分钟随机间隔自动发消息 |
| 长句拆分 | 回复自动拆成短消息，模拟真人打字 |

---

## 预设角色

| 角色 | 风格 | 场景 |
|------|------|------|
| 蓝小梦 | 随性大四女生，吐槽撒娇 | 女友型聊天 |
| 知性姐姐 | 温柔成熟，善于倾听 | 治愈陪伴 |
| 搞笑闺蜜 | 话多沙雕，上班族嘴替 | 损友互怼 |
| 顾昀迟 | 毒舌偏执，外冷内柔 | 《囚于永夜》同人 |

---

## 快速部署

### 环境要求

- Node.js >= 22
- DeepSeek API Key
- 千问 DashScope API Key（图片识别，可选）

### 部署

```bash
git clone https://github.com/yan2811/lan-xiao-meng.git
cd lan-xiao-meng
npm install
cp .env.example .env
# 编辑 .env 填入 API Key
npm run server
```

### 环境变量

```env
# 必填
DEEPSEEK_API_KEY=sk-your-key
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1

# 可选：图片识别
DASHSCOPE_API_KEY=sk-your-key
```

### PM2 守护

```bash
npm install -g pm2
pm2 start npm --name "lan-xiao-meng" -- run server
pm2 save && pm2 startup
```

开放 3721 端口后，访问 `http://服务器IP:3721` 扫码连接微信，或访问 `/web` 注册网页聊天。

---

## 项目结构

```
src/
├── wechat-server.js    # 主服务（HTTP + 微信桥接）
├── web-router.js       # Web 前端 + API
├── agent.js            # 核心对话引擎
├── personality.js      # 角色 System Prompt
├── memory.js           # 三层记忆（SQLite）
├── ai-client.js        # DeepSeek API
├── vision.js           # 千问图片识别
├── search.js           # 联网搜索
├── proactive.js        # 主动消息（角色感知）
├── db.js               # 数据库初始化 + CRUD
├── chat-cli.js         # CLI 聊天
└── wechat-bridge.js    # 本地微信桥接

config/
├── lanmeng-profile.json
└── characters/         # 各角色配置
    ├── lan-xiao-meng.json
    ├── zhi-xing-jie-jie.json
    ├── gao-xiao-gui-mi.json
    └── gu-yun-chi.json
```

---

## 微信命令

| 命令 | 作用 |
|------|------|
| `/wake` | 开启主动消息 |
| `/sleep` | 关闭主动消息 |
| `/ping` | 检查在线 |
| `/chars` | 查看角色列表 |
| `/char 数字` | 切换角色 |

---

## License

仅供个人学习娱乐使用，请勿用于商业用途。
