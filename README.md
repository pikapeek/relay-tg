<div align="center">

# 🤖 RelayTG

**[English](README.md) · [简体中文](README.zh-CN.md)**

A self-hosted Telegram bot that connects your users to your support team without exposing anyone's real account.

Each user gets their own topic in a forum group — operators reply inside the topic, the bot relays both ways.

</div>

---

## ✨ Features

| | |
| --- | --- |
| 🔁 **Two-way relay** | Text, media and albums both ways — replies and operator edits preserved. |
| ✅ **Verification + purpose gate** | `/start` arithmetic challenge or `/apply` approval; first-timers state their purpose first. |
| 🌐 **Bilingual** | English + 简体中文, auto-detected, `/lang` to override. |
| 👥 **Roles** | `ADMIN` / `OPERATOR`; all operators handle all conversations by default. |
| 🛡 **Anti-spam & ad guard** | Rate limits, flood protection, ad-text detection with quarantine. |
| 📌 **Topics stay put** | Permanent by default; hidden only after 7 idle days (never deleted), auto-reopened on the next message. `/hide` sets a sooner threshold. |
| 🔒 **Protected pin** | The first pinned purpose+info card can't be removed with `/delete` — only deleting the whole conversation removes it. |
| 🏗 **One codebase, two runtimes** | Docker / Node.js or Cloudflare Workers Free. |

---

## 🚀 Deploy

> Source is on GitHub, the Docker image is on GHCR — either way, you run it yourself.

### 1️⃣ Prepare once in Telegram

1. **Bot token** — [@BotFather](https://t.me/BotFather): send `/newbot`, pick a name, copy the token.
2. **Forum group** — create a group, enable **Topics**, add the bot as **admin** with *Manage Topics*.
3. **Group id** — right-click a message → *Copy Message Link* (`https://t.me/c/1234567890/5`) → the group id is `-1001234567890`.
4. **Admin / operator ids** — numeric user ids (from @userinfobot) into `ADMIN_IDS` / `OPERATOR_IDS`.

### 2️⃣ Pick a runtime

**💻 Command line** — one-command script: install, configure and start in a single line:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/pikapeek/relay-tg/main/scripts/run.sh) --token=1234567890:REPLACE_WITH_REAL_TOKEN --group=-1001234567890 --admin=111,222
```

Every option is optional — leave out `--token` / `--group` and the script asks for them interactively (BOT_TOKEN is not echoed). The script checks the environment first: if Node is missing or below 22.5, it asks for your consent and installs an official Node 22 into `~/.relaytg` (no system changes). Then it clones the source, writes `.env`, installs dependencies and starts on port 17575 — no manual editing. Re-run the same line without options to start again from the existing `.env`. Options: `--token` / `--group` / `--admin` / `--operator` / `--port` / `--db` / `--auto-hide`.

**🐳 Docker** — `docker-compose.yml`:

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

…or a one-liner:

```bash
docker run -d --name relaytg --restart unless-stopped \
  -p 17575:17575 -v "$PWD/data:/app/data" \
  -e BOT_TOKEN=1234567890:TOKEN \
  -e GROUP_ID=-1001234567890 \
  -e ADMIN_IDS=111,222 \
  ghcr.io/pikapeek/relay-tg:latest
```

**☁️ Cloudflare Workers** — one click:

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/pikapeek/relay-tg)

…or manual:

```bash
pnpm deploy:cf   # pushes BOT_TOKEN / GROUP_ID / ADMIN_IDS / OPERATOR_IDS / WEBHOOK_SECRET from .env as secrets, then deploys
```

### 3️⃣ Activate the webhook

```text
https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=<PUBLIC_URL>/webhook&secret_token=<WEBHOOK_SECRET>
```

`PUBLIC_URL` = your Cloudflare domain or an HTTPS tunnel (e.g. cloudflared). If you set `WEBHOOK_SECRET`, RelayTG rejects updates without it.

Health check: `curl http://localhost:17575/health` → `{"status":"ok"}`

---

## ⚙️ Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `BOT_TOKEN` | — required | Bot token from @BotFather |
| `GROUP_ID` | — required | Support group id, e.g. `-1001234567890` |
| `ADMIN_IDS` | — | Admin user ids, comma-separated |
| `OPERATOR_IDS` | — | Operator user ids, comma-separated |
| `WEBHOOK_SECRET` | — | Webhook auth secret (optional) |
| `DATABASE_PATH` | `data/relaytg.db` | SQLite file (Docker only) |
| `AUTO_HIDE_HOURS` | `168` | Auto-hide a topic after N idle hours |
| `PORT` | `17575` | HTTP port (Docker / local) |

Fill them in `.env` — the command-line and Docker setups both read it. For Cloudflare, `pnpm deploy:cf` pushes the main values as Worker secrets; the rest have defaults in `wrangler.jsonc`, or set them in the dashboard under Settings → Variables. Everything optional is documented in `.env.example`.

---

## 📋 Operator commands

Post them inside a conversation's topic:

| Command | What it does |
| --- | --- |
| `/list` | All conversations. |
| `/info` | Summary: user, purpose, notes, history. |
| `/assign <@user\|id>` | Mark who's handling this one (informational). |
| `/note <text>` | Internal note, shown in `/info`, never sent to the user. |
| `/rename <name>` | Rename the topic. |
| `/hide <hours\|off\|default>` | Hide policy for this topic. Permanent by default; `hours` hides it sooner than the global 7-day cap. |
| `/ban` `/unban` | Block/unblock the user. At group level: `/ban <@user\|id>`. |
| `/ad` | Manage ad rules; `/ad restore` pulls a quarantined message back. |
| `/delete` | Reply to a message you sent → remove its copy from the user's chat. The pinned opening card is off-limits for everyone. Without a reply (or at group level) → delete the whole conversation (admin). |
| `/restore <@user\|id>` | Reopen a hidden conversation. |
| `/help` | All commands, one line each. |
| `/lang <en\|zh\|auto>` | Operator language. |
| `/selfcheck` | Re-run startup checks and post the report (admin). |

Users just message the bot: `/start` to get in, `/apply` to apply as an operator.

---

## 🔐 Security

> [!IMPORTANT]
> `BOT_TOKEN` never enters git, logs, the database, the Docker image, or client code — it's read only from environment variables / Worker secrets. `.env*` and `data/` are gitignored. Access is by `telegram_user_id` only.
