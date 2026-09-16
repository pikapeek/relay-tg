<div align="center">

# 🤖 RelayTG

**[English](README.md) · [简体中文](README.zh-CN.md)**

自托管的 Telegram 双向消息与客服平台。

让用户直接联系你的客服团队，又不用暴露任何人的真实账号。

每个用户拥有独立话题，客服在话题内回复，机器人双向转发到用户私聊。

</div>

---

## ✨ 特性

| | |
| --- | --- |
| 🔁 **双向中继** | 文本、图片、相册都能传，回复关系和客服侧编辑都保留。 |
| ✅ **验证 + 来意门** | `/start` 算术验证或 `/apply` 申请通过；首次联系先写来意。 |
| 🌐 **双语** | 英文 + 简体中文，自动识别，可用 `/lang` 切换。 |
| 👥 **角色** | `ADMIN` / `OPERATOR`，默认所有客服都能处理所有会话。 |
| 🛡 **反垃圾 + 广告防护** | 限流、洪水防护、广告词检测与隔离。 |
| 📌 **话题默认永久显示** | 7 天无回复才自动隐藏（不是删除），用户下一条消息自动重开；`/hide` 可设更早阈值。 |
| 🔒 **置顶卡保护** | 话题首条置顶的「来意+信息」卡删不掉——只有删除整个会话才能移除。 |
| 🏗 **一套代码，两种运行方式** | Docker / Node.js 或 Cloudflare Workers Free。 |

---

## 🚀 部署

> 源码在 GitHub，Docker 镜像在 GHCR——都由你自己跑起来。

### 1️⃣ 先在 Telegram 准备

1. **Bot token** — 找 [@BotFather](https://t.me/BotFather) 发 `/newbot`，起好名字，复制返回的 token。
2. **客服论坛群** — 建一个群，开启 **Topics**，把 bot 加为**管理员**（勾选 *Manage Topics*）。
3. **群 id** — 在群里右键任意消息 → *复制消息链接*（`https://t.me/c/1234567890/5`）→ 群 id 就是 `-1001234567890`。
4. **管理员 / 客服 id** — 数值用户 id（用 @userinfobot 查）填进 `ADMIN_IDS` / `OPERATOR_IDS`。

### 2️⃣ 选择运行方式

**💻 命令行** — 一键脚本：

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/pikapeek/relay-tg/main/scripts/run.sh)
```

第一次运行自动 clone 源码并复制 `.env.example` → `.env`；填好 `BOT_TOKEN` / `GROUP_ID` / `ADMIN_IDS` 后再跑一次同一行，就会加载 `.env` 并在 17575 端口启动。

**🐳 Docker** — `docker-compose.yml`：

```yaml
services:
  relaytg:
    image: ghcr.io/pikapeek/relay-tg:latest
    restart: unless-stopped
    env_file: .env
    ports:
      - "17575:17575"
    volumes:
      - ./data:/app/data
```

```bash
docker compose up -d
```

…或单条命令：

```bash
docker run -d --name relaytg --restart unless-stopped \
  -p 17575:17575 -v "$PWD/data:/app/data" \
  -e BOT_TOKEN=1234567890:TOKEN \
  -e GROUP_ID=-1001234567890 \
  -e ADMIN_IDS=111,222 \
  ghcr.io/pikapeek/relay-tg:latest
```

**☁️ Cloudflare Workers** — 一键：

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/pikapeek/relay-tg)

…或手动：

```bash
pnpm deploy:cf   # 自动把 .env 里的 BOT_TOKEN / GROUP_ID / ADMIN_IDS / OPERATOR_IDS / WEBHOOK_SECRET 推为 secrets，再部署
```

### 3️⃣ 激活 Webhook

```text
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<你的公网地址>/webhook&secret_token=<WEBHOOK_SECRET>
```

`你的公网地址` = Cloudflare 域名或 HTTPS 隧道（如 cloudflared）。设置了 `WEBHOOK_SECRET`，RelayTG 就会拒绝不带它的请求。

健康检查：`curl http://localhost:17575/health` → `{"status":"ok"}`

---

## ⚙️ 环境变量

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `BOT_TOKEN` | — 必填 | @BotFather 拿到的 bot token |
| `GROUP_ID` | — 必填 | 客服群 id，如 `-1001234567890` |
| `ADMIN_IDS` | — | 管理员用户 id，逗号分隔 |
| `OPERATOR_IDS` | — | 客服用户 id，逗号分隔 |
| `WEBHOOK_SECRET` | — | webhook 校验密钥（可选） |
| `DATABASE_PATH` | `data/relaytg.db` | SQLite 文件路径（仅 Docker） |
| `AUTO_HIDE_HOURS` | `168` | 空闲 N 小时自动隐藏话题 |
| `PORT` | `17575` | HTTP 端口（Docker / 本地） |

统一填在 `.env`——命令行和 Docker 都读它。Cloudflare 用 `pnpm deploy:cf` 把主要值推为 secrets，其余在 `wrangler.jsonc` 里有默认值，也可以在控制台 Settings → Variables 里改。所有可选配置的完整说明见 `.env.example`。

---

## 📋 客服指令

在会话的话题里发送：

| 命令 | 作用 |
| --- | --- |
| `/list` | 列出所有会话。 |
| `/info` | 会话摘要：用户、来意、备注、历史。 |
| `/assign <@用户\|id>` | 指定负责的客服（仅展示）。 |
| `/note <文本>` | 内部备注，`/info` 可见，绝不发给用户。 |
| `/rename <新名>` | 改话题名。 |
| `/hide <小时\|off\|default>` | 本会话的隐藏策略。默认永久显示；`小时` 设一个比全局 7 天上限更早的阈值。 |
| `/ban` `/unban` | 拉黑 / 解封该用户。群组级：`/ban <@用户\|id>`。 |
| `/ad` | 管理广告规则；`/ad restore` 把隔离的消息捞回来。 |
| `/delete` | 回复你发过的消息 → 撤回用户侧的副本。置顶的开场卡对谁都删不掉。不带回复或群组级 → 删除整个会话（仅管理员）。 |
| `/restore <@用户\|id>` | 重开被隐藏的会话。 |
| `/help` | 逐行列出所有命令。 |
| `/lang <en\|zh\|auto>` | 设置客服语言。 |
| `/selfcheck` | 重跑启动自检并贴出报告（仅管理员）。 |

用户直接给 bot 发消息即可：`/start` 进入，`/apply` 申请当客服。

---

## 🔐 安全说明

> [!IMPORTANT]
> `BOT_TOKEN` 绝不进入 git、日志、数据库、Docker 镜像或客户端代码——只经环境变量 / Worker secrets 注入。`.env*`、`data/` 都已 gitignore。授权只认 `telegram_user_id`。
