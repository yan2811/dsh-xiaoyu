# dsh-小鱼 — 多角色 AI 聊天平台

基于 DeepSeek + 千问视觉 + 微信桥接的 AI 伴侣平台。支持**微信扫码聊天**和**网页聊天**，多角色可切换，SQLite 存储。

---

## 目录

1. [功能概览](#功能概览)
2. [项目结构](#项目结构)
3. [服务器部署](#服务器部署)
4. [环境变量](#环境变量)
5. [数据库](#数据库)
6. [角色系统](#角色系统)
7. [记忆系统](#记忆系统)
8. [图片识别](#图片识别)
9. [主动消息](#主动消息)
10. [微信命令](#微信命令)
11. [PM2 管理](#pm2-管理)
12. [GitHub 仓库](#github-仓库)
13. [费用参考](#费用参考)
14. [故障排查](#故障排查)

---

## 功能概览

| 功能 | 说明 |
|------|------|
| 多角色 | 顾昀迟、晏烬、阮怡婷（隐藏），可扩展 |
| 微信接入 | 扫码即连，支持图片识别、长句拆分 |
| Web 聊天 | 注册/登录/选角色，浏览器直接聊 |
| SQLite 存储 | 用户、对话、记忆、摘要全部入库 |
| 三层记忆 | L1 短期缓冲 + L2 对话摘要 + L3 用户事实 |
| 图片识别 | 千问 qwen-vl-max 自动描述微信发来的图片 |
| 主动消息 | 30-60 分钟随机间隔，AI 根据上下文生成 |
| 长句拆分 | 回复用 `\|\|\|` 拆成多条短消息发出 |
| 联网搜索 | DuckDuckGo 免费 API，检测需要时自动触发 |
| Lore 系统 | 角色原著记忆按关键词触发注入，平时不占 token |

---

## 项目结构

```
dsh-小鱼/
├── README.md
├── package.json
├── .env                        # 环境变量（不入 Git）
├── .env.example                # 环境变量模板
├── .gitignore                  # 排除 .env / node_modules / data
├── config/
│   ├── lanmeng-profile.json    # 阮怡婷人设（旧版兼容）
│   └── characters/             # 角色配置
│       ├── lan-xiao-meng.json  # 阮怡婷（id=1，隐藏，密码 5201314）
│       ├── gu-yun-chi.json     # 顾昀迟（id=25，默认）
│       ├── gu-yun-chi-lore.json# 顾昀迟原著记忆库
│       ├── yan-jin.json        # 晏烬（id=78）
│       └── yan-jin-lore.json   # 晏烬原著记忆库
├── src/
│   ├── wechat-server.js        # ★ 主服务入口（HTTP + 微信桥接）
│   ├── web-router.js           # Web 前端（注册/登录/角色选择/聊天）+ API
│   ├── agent.js                # 核心对话引擎（上下文构建 + AI 调用）
│   ├── personality.js          # System Prompt 构建（含角色记忆注入）
│   ├── memory.js               # 三层记忆（封装 db.js）
│   ├── ai-client.js            # DeepSeek API 客户端（OpenAI 兼容）
│   ├── vision.js               # 千问图片识别（qwen-vl-max）
│   ├── search.js               # 联网搜索（DuckDuckGo）
│   ├── proactive.js            # 主动消息生成（AI 驱动）
│   ├── db.js                   # SQLite 数据库初始化 + CRUD + 迁移
│   ├── chat-cli.js             # CLI 聊天（终端）
│   └── wechat-bridge.js        # 本地微信桥接（终端二维码）
└── data/
    ├── chat.db                 # SQLite 数据库（不入 Git）
    └── memory/                 # 旧 JSON 记忆（已迁移到 SQLite）
```

### 核心数据流

```
用户消息（微信 / Web）
    ↓
wechat-server.js / web-router.js
    ↓
agent.js（handleMessage）
    ├── personality.js → 构建 System Prompt（角色人设 + 时间 + Lore）
    ├── memory.js → 读取上下文（最近消息 + 摘要 + 事实）
    ├── search.js → 联网搜索（检测到需要时触发）
    ├── vision.js → 图片识别（检测到图片时触发）
    └── ai-client.js → 调用 DeepSeek API
    ↓
返回回复 → 拆分 ||| → 逐条发送
    ↓
memory.js → 保存消息 + 自动压缩摘要 + 提取事实到 SQLite
```

---

## 服务器部署

### 服务器信息

| 项目 | 详情 |
|------|------|
| 服务器 | 阿里云轻量应用服务器 Ubuntu 24.04 |
| 公网 IP | YOUR_SERVER_IP |
| SSH 登录 | `ssh root@YOUR_SERVER_IP` |
| 项目路径 | `/root/lan-xiao-meng` |
| 服务端口 | 3721 |
| 进程管理 | PM2（进程名：lanmeng） |

### 部署步骤

```bash
# 1. SSH 连接（使用你自己的密钥或密码）
ssh root@YOUR_SERVER_IP

# 2. 安装 Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs git

# 3. 拉取项目
cd /root
git clone https://github.com/yan2811/dsh-xiaoyu.git
cd dsh-xiaoyu

# 4. 安装依赖
npm install

# 5. 配置环境变量
cp .env.example .env
nano .env  # 填入 DEEPSEEK_API_KEY 和 DASHSCOPE_API_KEY

# 6. 安装 PM2 并启动
npm install -g pm2
pm2 start npm --name "lanmeng" -- run server
pm2 save
pm2 startup

# 7. 开放防火墙端口
# 阿里云控制台 → 轻量服务器 → 防火墙 → 添加规则
# 端口: 3721, 协议: TCP, 来源: 0.0.0.0/0
```

---

## 环境变量

编辑 `/root/lan-xiao-meng/.env`：

```env
# DeepSeek API（必填）
DEEPSEEK_API_KEY=sk-your-key
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_BASE_URL=https://api.deepseek.com/v1

# 千问视觉 API（可选，用于图片识别）
DASHSCOPE_API_KEY=sk-your-key
```

> `.env` 文件不入 Git，已加入 `.gitignore`。服务器上当前已配置好，无需修改。

---

## 数据库

### 数据库文件

`/root/lan-xiao-meng/data/chat.db`（SQLite）

### 表结构

```sql
users (id, username, password_hash, created_at)
characters (id, name, profile_path, created_at)
messages (id, user_id, character_id, role, content, time)
facts (id, user_id, character_id, key, value, time)
summaries (id, user_id, character_id, text, time)
```

### 查看对话记录

```bash
ssh root@YOUR_SERVER_IP
cd /root/lan-xiao-meng
node -e "
const D=require('better-sqlite3');const db=new D('data/chat.db');
const ms=db.prepare('SELECT u.username,c.name,m.role,m.content,datetime(m.time/1000,\"unixepoch\",\"localtime\") as t FROM messages m JOIN users u ON m.user_id=u.id JOIN characters c ON m.character_id=c.id ORDER BY m.id').all();
ms.forEach(m=>console.log('['+m.t.slice(5)+']',m.username+'/'+m.name,m.role==='user'?'→':'←',m.content.slice(0,120)));
db.close();
"
```

### 清理对话

```bash
cd /root/lan-xiao-meng
node -e "const D=require('better-sqlite3');const db=new D('data/chat.db');db.exec('DELETE FROM messages WHERE user_id=X');db.close();"
```

---

## 角色系统

### 角色列表

| ID | 角色 | 状态 | 切换方式 | 风格 |
|----|------|------|---------|------|
| 1 | 阮怡婷 | **隐藏** | `/char 5201314` | 随性大四女生，撒娇吐槽 |
| 25 | 顾昀迟 | **默认** | `/char 25` | 毒舌偏执上校，外冷内柔 |
| 78 | 晏烬 | 可见 | `/char 78` | 寡言剑客，路痴甜食控 |

### 角色配置

每个角色有 3 层配置：

1. **角色 Profile**（`config/characters/xxx.json`）：
   - `name`、`description`、`personality`：基本描述
   - `systemPrompt`：完整的 System Prompt 文本
   - `memories`：精简记忆 bullet points（常驻，≈150 token）

2. **Lore 文件**（`config/characters/xxx-lore.json`）：
   - 按关键词触发的详细记忆
   - 只在用户消息匹配关键词时注入 system prompt
   - 不消耗日常 token

3. **数据库注册**：`src/wechat-server.js` 中的 `seedCharacters()` 调用

### 添加新角色

1. 创建 `config/characters/new-char.json`（参考 `gu-yun-chi.json`）
2. 可选：创建 `config/characters/new-char-lore.json`（参考 `gu-yun-chi-lore.json`）
3. 在 `src/wechat-server.js` 的 `seedCharacters()` 中添加条目
4. 重启：`pm2 restart lanmeng`

### 默认角色

扫码连接后默认使用**顾昀迟（id=25）**。修改默认角色：在 `wechat-server.js` 中搜索 `c.id === 25`，改为目标角色 ID。

---

## 记忆系统

### 三层架构

| 层级 | 存储 | 容量 | 触发 |
|------|------|------|------|
| L1 短期缓冲 | messages 表 | 最近 40 条 | 每次对话 |
| L2 对话摘要 | summaries 表 | 10 条 | 每 40 条消息自动压缩 |
| L3 用户事实 | facts 表 | 30 条 | 每 20 条消息自动提取 |
| Lore | JSON 文件 | 按需 | 用户消息匹配关键词时注入 |

### 关键词触发 Lore

在 `agent.js` 的 `loadLore()` 中实现：
- 用户消息匹配 `keywords` 数组中的任意词
- 匹配到的 `text` 段落注入 system prompt
- 平时不占 token

---

## 图片识别

### 流程

```
微信收到图片 → SDK 下载到本地
    ↓
vision.js → 转 base64 → 调用千问 qwen-vl-max
    ↓
返回中文描述 → 注入 system prompt → AI 基于描述回复
```

### API 配置

- 模型：`qwen-vl-max`
- 端点：`https://dashscope.aliyuncs.com/compatible-mode/v1`
- 密钥：`DASHSCOPE_API_KEY` 环境变量
- 兼容 OpenAI 格式

### 图片存储

- 收到图片后最多保留最近 5 张在 `/tmp/weixin-images/`
- 旧图片自动删除
- 对话记录只存 `[图片]` 标记，不存千问描述

### 费用

单张 720P 图片 ≈ 1,100 token ≈ 0.0017 元。一元处理 500+ 张。

---

## 主动消息

### 机制

- 扫码连接后**自动开启**
- 30~60 分钟随机间隔
- 时间窗口：早 8:00 ~ 晚 11:00
- 每次发送后随机重置下次触发时间
- 用户发消息后也重置

### AI 生成

主动消息不再是固定模板，而是调用 DeepSeek 根据以下信息实时生成：
- 角色人设（System Prompt）
- 当前北京时间
- 最近对话内容
- 记住的关于用户的事实

每条主动消息消耗约 300 token（≈0.0003 元）。

### 控制命令

| 命令 | 作用 |
|------|------|
| `/wake` | 开启主动消息 |
| `/sleep` | 关闭主动消息 |
| `/ping` | 查看状态 |

---

## 微信命令

| 命令 | 作用 |
|------|------|
| `/chars` | 查看可见角色列表 |
| `/char 25` | 切换到顾昀迟 |
| `/char 78` | 切换到晏烬 |
| `/char 5201314` | 切换到阮怡婷（隐藏） |
| `/wake` | 开启主动消息 |
| `/sleep` | 关闭主动消息 |
| `/ping` | 检查在线状态 |

---

## PM2 管理

```bash
# 查看状态
pm2 status

# 查看日志
pm2 logs lanmeng
pm2 logs lanmeng --lines 50

# 重启
pm2 restart lanmeng

# 停止
pm2 stop lanmeng

# 启动
pm2 start lanmeng

# 开机自启（已配置）
pm2 save
pm2 startup
```

### Web 页面

- 微信扫码：`http://YOUR_SERVER_IP:3721`
- 网页聊天：`http://YOUR_SERVER_IP:3721/web`

---

## GitHub 仓库

### 仓库地址

https://github.com/yan2811/dsh-xiaoyu.git

### 推送

```bash
cd "C:\Users\15279\Desktop\蓝小梦"
git add -A
git commit -m "描述改动"
git push origin main
```

### 拉取到服务器

```bash
ssh root@YOUR_SERVER_IP
cd /root/lan-xiao-meng
git pull origin main
npm install  # 如有新依赖
pm2 restart lanmeng
```

### 注意事项

- `.env` 文件不入 Git（已在 `.gitignore`）
- `data/chat.db` 不入 Git
- `node_modules/` 不入 Git
- 推送前确认没有泄露 API Key

---

## 费用参考

| 项目 | 单价 | 月费（估） |
|------|------|-----------|
| DeepSeek 聊天（deepseek-chat） | 1 元/百万 token | 0.5-1 元/月 |
| 千问视觉（qwen-vl-max） | 1.5 元/百万 token | <0.5 元/月 |
| 主动消息 AI 生成 | 同上 | <0.3 元/月 |
| 阿里云服务器 | 99 元/年 | ~8.25 元/月 |
| **合计** | | **约 10 元/月** |

---

## 故障排查

### 服务挂了

```bash
ssh root@YOUR_SERVER_IP
pm2 status          # 看是否 online
pm2 logs lanmeng --lines 30  # 看最后的日志
pm2 restart lanmeng # 重启试试
```

### 微信连不上

1. 检查服务是否在运行：`pm2 status`
2. 检查是否有无限循环二维码：`pm2 logs lanmeng | grep 二维码`
3. 重新扫码：访问 `http://YOUR_SERVER_IP:3721`，点「重新扫码连接」
4. 极端情况：重启服务 `pm2 restart lanmeng`

### 网页打不开

```bash
# 检查端口是否在监听
ssh root@YOUR_SERVER_IP "ss -tlnp | grep 3721"

# 检查阿里云防火墙是否开放 3721 端口
# 阿里云控制台 → 轻量服务器 → 防火墙
```

### 对话不拆分

检查 system prompt 中是否有 `超过15字必须用|||拆分` 的指令。如果 AI 输出中没有 `|||`，说明模型没遵守——加强 prompt 中的措辞。

### 图片识别不工作

1. 检查 `.env` 中 `DASHSCOPE_API_KEY` 是否配置
2. 查看日志：`pm2 logs lanmeng | grep Vision`
3. 检查千问余额

### 内存语法错误

```bash
ssh root@YOUR_SERVER_IP
cd /root/lan-xiao-meng
pm2 logs lanmeng --err --lines 10  # 看 SyntaxError
# 通常是模板字符串中有未转义的特殊字符
```

---

## License

仅供个人学习娱乐使用，请勿用于商业用途。

角色版权归各自原作所有：顾昀迟（《囚于永夜》）、晏烬（《沧元图》）。
