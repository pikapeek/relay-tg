# RelayTG — Technical Specification

Self-hosted, platform-independent Telegram bidirectional messaging & support platform. One TypeScript core runs identically on **Cloudflare Workers Free** (a Worker, one Durable Object, and SQLite-backed Durable Object storage) and **Docker / Node.js** (a SQLite file). This document is the complete specification: architecture, data model, flows, commands, anti-spam, reliability, and operations.

---

## 1. Overview

RelayTG bridges Telegram end users and support operators without exposing operators' personal accounts:

```text
Telegram User ─► Telegram Bot ─► RelayTG ─► Support Forum Group
                                          └─► Topic per user (operators reply inside it)
```

- Users message any of the deployed **Bots** in private chat; all bots share **one support group**.
- Each **(bot × user)** pair maps to a dedicated **Forum Topic** in the support group, named `botName | DisplayName | telegram_user_id` — a user talking to two bots gets two independent topics.
- Operators reply by replying inside that topic (or via commands); each reply goes out through the **topic's own bot**.
- Every message is recorded internally and relayed in both directions; replies and edits are preserved best-effort.
- Optional human verification (`/start`) and customer-service applications (`/apply`) gate the creation of the first conversation.
- Multi-bot support is the default mode: a single-bot deployment is just `BOTS="name:<token>"`.

## 2. Core design principles

1. **One core, two runtimes.** All business logic lives in `src/packages/core`, which never touches runtime, Telegram, or storage APIs directly.
2. **Platform independence.** Core depends only on injected ports: `Runtime`, `Database` (repository interfaces), `TelegramClient`, `Serializer`, `VerificationStore`, and a `Logger`. No Cloudflare APIs, no Node APIs, no file system, no SQLite driver, no HTTP framework.
3. **Telegram is a transport.** Core never sees a raw Telegram Update. The adapter parses updates into internal events and maps internal messages into Bot API calls.
4. **Simple-first.** No web admin, AI, PostgreSQL, Redis, payment, or CRM in the MVP. The architecture leaves room for them.

```text
Telegram Update ─► Parser ─► Internal Event ─► Core ─► Internal Command ─► Mapper ─► Bot API
```

## 3. Architecture

```
                RelayTG Core (src/packages/core)
                      │            │                   │              │
            ┌─────────┴──────┐  ┌──┴────────────┐   ┌──┴─────────┐  ┌─┴────────────┐
            │ TelegramClient │  │    Database   │   │  Runtime   │  │  Serializer  │
            │   (ports)      │  │   (ports)     │   │ (ports)    │  │  (ports)     │
            └─────┬──────────┘  └──┬────────────┘   └────────────┘  └──────────────┘
                  │                │
  src/packages/telegram   ┌───────┴───────────────┐
  (client, parser,        │ src/adapters/sqlite    │
   mapper)                │   node:sqlite (Docker) │
                          │ src/adapters/cloudflare-do │
                          │   DO SqlStorage        │
                          └────────────────────────┘
                │
        ┌───────┴──────────────┐
        │ src/apps/docker      │  HTTP: POST /webhook[/<botId>], GET /health; hourly hide sweep
        │ src/apps/worker      │  Worker entry + ConversationDO; self-scheduled hide sweep
        └──────────────────────┘
```

Everything under `src/`: the pnpm workspaces (`apps`, `packages`, `adapters`), the shared `migrations`, and the deployment assets (`docker`, `scripts`); the repo root keeps only configuration, docs, CI, and the runtime `data/` directory.

**Packages**

- `src/packages/shared` — domain types, layered errors, env config loader, structured logger.
- `src/packages/core` — ports and services: `UserService`, `ConversationService`, `TopicService`, `VerificationService`, `ApprovalService`, `HideService`, `MessageService`, `SpamService`, `Relayer`, `CommandService`, `UpdateProcessor`.
- `src/packages/telegram` — Bot API client with retry/`429` handling, update parser, outbound mapper.
- `src/adapters/sqlite` — `SqlDb` abstractions, repository implementations, migration runner, and the shared integration suites.
- `src/adapters/cloudflare-do` — binds the same repositories to Durable Object SQLite storage (`ctx.storage.sql`).
- `src/apps/docker` — Node HTTP server (webhook ingestion + health) and the hourly hide sweep.
- `src/apps/worker` — the Worker entry and the single `ConversationDO` Durable Object.
- `src/migrations/` — the versioned SQL schema (shared verbatim by both runtimes).

## 4. Data model

SQLite schema (versioned `src/migrations/*.sql` — `001_initial`, `002_preferred_language`, `003_purpose`, `004_multi_bot`, `005_per_bot_verification`), applied by the migration runner on boot. The database is versioned and **never drop-and-recreated**.

| Table | Purpose | Key columns |
| --- | --- | --- |
| `users` | One row per Telegram identity (**global** across bots) | `telegram_user_id` (unique), `username` (display only), `approved_at`, `purpose`, `purpose_at` |
| `user_verifications` | Human-verification marks — **per (bot, user)** | `bot_id` + `telegram_user_id` (primary key), `verified_at` |
| `conversations` | One conversation per **(bot, user)**; **no status lifecycle** | `bot_id` + `telegram_user_id` (unique), `telegram_topic_id`, `assigned_operator_id` (informational), `last_activity_at`, `hidden_at`, `hide_after_hours` (null/`0` = permanent display policy; the global 7-day cap still applies) |
| `messages` | Every relayed copy | `bot_id` + `telegram_chat_id` + `telegram_message_id` (unique per source), `telegram_topic_id`, `relayed_message_id`, `direction`, `sender_type`, `content_type`, `reply_to_message_id` |
| `operators` | Operator registry seeded from `OPERATOR_IDS` + `ADMIN_IDS` (**global**) | `telegram_user_id` (unique), `role` (`ADMIN`/`OPERATOR`) |
| `conversation_notes` | Internal notes (never delivered) | `conversation_id`, `operator_id`, `text` |
| `blocks` | Block records (**global**) | `telegram_user_id` (unique), `created_by_telegram_user_id` |
| `applications` | `/apply` requests; re-apply allowed after rejection (**global**) | `telegram_user_id`, `status` (`pending`/`approved`/`rejected`), `decided_at` |
| `processed_updates` | Idempotency claim ledger | `bot_id` + `update_id` (primary key — update ids are per-bot), `claim_id` (per-claim nonce), `processed_at` |
| `settings` | Reserved key/value store | `key`, `value` |

Key invariants:

- `username` is **never** an identity key (Telegram usernames are mutable). Only `telegram_user_id` authorizes.
- Conversations carry no `status`/`closed_at`; they are live from creation until explicitly deleted by an admin (`/delete`).
- Messages are source-keyed `(bot_id, chat_id, message_id)`, unique per source, so idempotency, replies, and edits resolve through the same key. (Two bots each number their private-chat messages from 1, so `bot_id` is required to tell them apart; the non-unique `(chat_id, message_id)` index still resolves edits of group messages, whose ids are globally unique.)

## 5. Message model & mapping

Every relayed message records: `direction` (`USER_TO_OPERATOR` / `OPERATOR_TO_USER` / `SYSTEM`), `sender_type` (`USER` / `OPERATOR` / `SYSTEM`), `content_type` (text, photo, video, document, audio, voice, sticker), the source `(telegram_chat_id, telegram_message_id)`, the delivered copy id (`relayed_message_id`), and an optional reply anchor.

Mapping rules:

- **user message** `(private_chat, msg_id)` → record → **forwarded verbatim** into the topic with `relayed_message_id`, so the copy shows the sender's real name and avatar via Telegram's forward attribution.
- **operator topic reply** `(group, topic, msg_id)` → resolve conversation by topic → record → user-chat copy.
- **identity** — every topic opens with a **user-info card** (profile-photo card when the user has one, text card otherwise): name, `@username` when present, numeric user id, and a `tg://user?id=` profile button. For a first-time contact the topic's **single pinned opening message** is one **combined card** carrying the user's stated **purpose (来意)** as its first line plus the user info (the purpose statement itself is **consumed, never forwarded** into the topic). An older/ recovered topic with no fresh purpose re-opens with the plain, **unpinned** card. Card creation is best-effort and never fails topic creation.
- **reply preservation** — a user replying to the delivered copy replies to the operator's original topic message, and vice-versa; unresolvable replies degrade to a plain send (never a failure). A forward cannot carry a reply-to, so user-side reply references are preserved in the database only.
- **media groups** — a burst of album items is buffered for 2 s and delivered into the topic as **one album** (`sendMediaGroup`, chunked at 10 items), so operators see a single gallery instead of N forwards; each item is still recorded individually with its own source and delivered-copy id. Degrades to per-item forwards when the window closes with a single item (Bot API needs 2–10) or an album contains a non-album-able item (voice/sticker/text) — nothing is lost.
- **boot config self-check** — at startup the bot verifies the token (`getMe`), that the support group is a forum (`getChat`), and that the bot is an administrator there (`getChatMember`), logging the verdict; an admin's `/selfcheck` (private chat or group level) re-runs the checks and replies with the report. A failed probe never blocks the server or crashes an update.
- **edits** — a user message edit is dropped (a forwarded topic copy cannot be edited); an edited operator reply edits the user-chat copy; unmappable edits are logged and dropped without resend.
- **deletion** — message deletion is unobservable via the Bot API and is a documented platform limitation, not an error path.

**Multi-bot routing (N bots, one support group).** The deployment runs N Telegram bots sharing **one** support group; the group control surface belongs to the **primary** bot (the first `BOTS` entry) alone:

- **Per-(bot × user) accounting** — conversations, messages, the pending queue and **human verification** (`user_verifications`) are keyed by `bot_id`; `/apply` approval, purpose, language and block stay global. A user talking to two bots gets two independent topics, each named `botName | DisplayName | telegram_user_id` — and must pass the arithmetic gate **separately on each bot**; being verified on one bot never opens a topic on another.
- **Group control surface = primary** — every bot in the group receives a copy of each group message via its own webhook; the non-primary copies are **claimed for dedup but ignored** (operator commands, topic delete/approve pickers, edited operator messages). Only the primary processes group commands, self-checks, and group-level pickers.
- **User-side sends route through the topic's own bot** — the forward out of the user's chat with bot2, the operator-reply delivery into their chat, message edits, the info-card avatar fetch/post, and `/delete` copy retraction all use `registry.get(conversation.botId).client`. Group-side operations (topic create/hide/restore/edit/delete, pin, command menus) go through the **primary** client — any admin bot in the group can perform them.
- **Webhook routes** — `POST /webhook` addresses the primary bot; `POST /webhook/<botId>` addresses a specific bot. The single `WEBHOOK_SECRET` authenticates every path; the path selects the bot, the header authenticates.
- **Update dedup is per (bot, update)** — the same `update_id` on two bots claims independently and never dedupes each other; the pending/verification queue is keyed `pending:<botId>:<telegramUserId>` so two simultaneous challenges never overwrite each other.

## 6. Flows

### 6.1 User → operator

1. An update arrives at `POST /webhook` and is parsed into an internal event.
2. Rejection order (each creates **zero** database rows and is never relayed): bot sender → block check → **ad-text check** (§8) → rate-limit/spam/content checks → verification gate.
3. A `/start` from an unverified user issues a four-choice arithmetic challenge; nothing is persisted.
4. **Pending queue** — user messages that arrive while the verification/purpose gate still holds (a non-command text of an unverified user) are not lost: each is queued in the settings table under `pending:<botId>:<telegram_user_id>` (JSON array of `{ messageId, contentType, replyToMessageId }`, deduped by message id, capped at 50 dropping the oldest; ad and rate/flood-limited messages were already rejected at earlier gates and never enqueued — so the flush needs no re-checks). The key is per **(bot, user)**, so the same user challenging on two bots never overwrites the other queue.
5. A correct tap marks the user verified **on that bot only** (`user_verifications`). The **first-contact purpose gate** then applies: a user who has stated a purpose before gets their conversation immediately; a first-time user is asked to state their purpose (来意) — the message answering that prompt **is** the purpose statement, is persisted, and opens the conversation with a **single pinned combined card** (purpose + user info) as the new topic's opening message; the purpose statement itself is not forwarded into the topic (commands re-prompt and never count). Once the conversation is open, the pending queue is **flushed in order** — each queued message is forwarded into the topic (topic-recovery aware) and recorded like any relay; a single failed entry is logged and skipped without aborting the rest.
6. A verified/approved user with an open conversation: ensure user → ensure the **(bot, user)** conversation (create that bot's topic if needed, which opens with a user-info card; a first-time contact already opened the topic with its single pinned purpose+info card) → restore a hidden topic before relaying → forward the message into the topic → record.

### 6.2 Operator → user

- Only **authorized** operators (ADMIN or registered OPERATOR) have their topic messages relayed.
- A message in a mapped topic resolves to the owning conversation and is delivered to **that user's private chat only**, then recorded.
- Non-operator topic posts and group-general-chat chatter are ignored.

### 6.3 Human verification (`/start`)

- An unverified user entering `/start` gets a single arithmetic expression of five random operators (`+ − × ÷`, no parentheses, integer-exact division, operands and intermediate results bounded to ±1000) with **four distinct integer choices**, exactly one correct.
- A correct tap marks the user verified **on that bot only** (`user_verifications` keyed (bot, user)); a returning user (purpose already stated) gets the conversation (topic) immediately, while a first-time user is asked to state their purpose first (§6.1 / §6.6). Passing on one bot never verifies the human on another — a user who messages a second bot is challenged afresh there.
- A wrong tap consumes an attempt (default 3) and re-asks with reshuffled options; non-button content re-asks **without** consuming an attempt.
- Exhausted or expired challenges reply to the user and create nothing; the next contact restarts the challenge.

### 6.4 Customer-service applications (`/apply`)

- An unapproved user sending `/apply` creates a pending application and posts an **Approve / Reject** inline-button notice to the support group.
- Decisions are `ADMIN`-only; a double-tap is a no-op.
- **Approve** sets `users.approved_at` and promotes the applicant to `OPERATOR`; the first-contact purpose gate applies — a returning user gets the conversation/topic, a first-time user is asked to state their purpose first (§6.1). **Reject** notifies the user and creates nothing.
- Approved users skip re-application thereafter, unless `/delete` resets their access (§6.6). Rejected users may re-apply.

### 6.5 Hide & restore

- The default hide policy is **permanent display**: `hide_after_hours` of `null` (the default) and `0` (`/hide off`) both mean the conversation is never hidden by its own policy.
- A universal **7-day hard cap** applies to every conversation regardless of its policy: the sweep hides any conversation whose `last_activity_at` is older than `AUTO_HIDE_HOURS` (default `168` = 7 days) — the topic is closed best-effort (`hideForumTopic`) and `hidden_at` is set; the conversation is **never deleted**. A per-conversation `/hide N` can only set a *sooner* threshold (effective `min(N, 168)`).
- Restore (reopen topic, clear `hidden_at`, refresh `last_activity_at`) happens on `/restore`, on `/hide`, and automatically before relaying a message from a hidden conversation.
- Both runtimes sweep on boot and then hourly (`setInterval` in Docker; a self-scheduled Durable Object alarm in Cloudflare).

### 6.6 Conversation deletion (`/delete`)

- Admin `/delete` cascade-deletes the conversation's messages, notes, and row in one transaction; the topic is removed best-effort. Because the conversation row is gone, topic recovery never resurrects a `/delete`d conversation — auto-recovery only ever recreates topics that were deleted *manually*.
- In that same transaction the user's access is **reset**: the deleted conversation's **bot**'s `user_verifications` mark is cleared (`clearVerified`), `approved_at` and the stored purpose (`purpose`, `purpose_at`) are cleared, so the next contact **through that bot** requires human verification again **and must state a fresh purpose** — which opens the new topic as its single pinned purpose+info card (§6.1) — before a new conversation is created. The user's other bots' verification marks and topics are untouched.
- The delivered user-chat copies (`OPERATOR_TO_USER` rows) are read before the cascade and each is deleted from the user's private chat best-effort afterwards, honoring the Telegram Bot API limit that only messages younger than 48 hours can be deleted; an expired (or already gone) copy is logged and dropped without failing. No welcome message is sent when a conversation opens, so these delivered copies are the only things to clean up on the user's side.
- `/delete` is refused for the requester's **own** conversation, the **bot's**, or a **staff member's** (`ADMIN`/`OPERATOR`) conversation — every delete path (in-topic, direct `/delete <target>`, and the tap-to-delete picker) guards the target and replies/answers with `deleteStaffRefused` (`command_rejected`, `staff_target:*`) without any state change.
- The **first pinned purpose+info opening card** (§6.1) is permanent: replying to it with `/delete` is refused for both operators and admins (`pinCardProtected`, log kind `pinned_card`) with no fall-through to the conversation delete; only deleting the conversation itself removes it.
- Inside a topic `/delete` **with a reply** retracts the replied-to message's delivered user-chat copy (OPERATOR+; §7) and does not touch the conversation; **without a reply** it deletes that conversation. At group level and in a staff member's private chat, `/delete` with no argument posts a **tap-to-delete picker** — one single-column inline button per conversation carrying `del:<conversation_id>` (ADMIN only). A tap deletes the conversation, answers the callback with a toast, and re-renders the picker (dropping the removed row, or swapping to the empty list when none remain). `/delete <@user|id|conversation>` deletes directly.

## 7. Commands

Operator commands require authorization by `telegram_user_id` (`ADMIN` / registered `OPERATOR` — username grants nothing). Commands outside a mapped topic are rejected with an explanatory reply, except the group-level `/list`, `/restore`, `/delete`, `/ad`, `/ban <@user|id>`, `/unban <@user|id>`, and `/help`. `/list` and `/delete` also work in a staff member's private chat with the bot.

| Command | Scope | Role | Effect |
| --- | --- | --- | --- |
| `/list` | group or private chat | OPERATOR+ | numbered list of every conversation with its id, so `/delete <id>` targets it directly |
| `/info` | topic | OPERATOR+ | user id, username, name, purpose of contact, conversation id, created at, last message, saved notes, assigned operator, hide policy |
| `/assign <@user\|id>` | topic | OPERATOR+ | set `assigned_operator_id` (informational; all operators handle all conversations by default) |
| `/note <text>` | topic | OPERATOR+ | store an internal note (never sent to the user; shown under `/info`) |
| `/rename <name>` | topic | OPERATOR+ | rename the topic; the title is persisted in settings so an auto-recovered topic (manually deleted → recreated) keeps the name |
| `/hide <hours\|off\|default>` | topic | OPERATOR+ | per-conversation hide policy — permanent by default; `hours` sets a sooner threshold than the global 7-day cap |
| `/ban` | topic or group | ADMIN | in a topic: block the conversation's user; at group level `/ban <@user\|id>` blocks by target (reaches users with no topic, e.g. ad auto-blocks) |
| `/unban` | topic or group | ADMIN | in a topic: remove the block; at group level `/unban <@user\|id>` removes it by target |
| `/ad` | topic or group | ADMIN | ad management: no arg or `list` lists block keywords + the link rule; `add <word>` appends a block keyword (dedupe, case-insensitive), `del <word>` removes; `allow <list\|add\|del> <word>` manages the allowlist (an allow hit clears a message regardless of blocklists); `links <n\|off>` sets/clears the link-count rule; `restore` (reply to a quarantined copy in the quarantine topic) forwards the copy back into the sender's topic — restoring never unblocks. Everything is persisted in the settings table and effective immediately |
| `/delete` | topic, group, or private chat | OPERATOR+ (retract) / ADMIN (delete) | **in a topic:** replying to a message retracts its delivered user-chat copy (OPERATOR+): the copy in the user's private chat is deleted best-effort (Bot API 48 h limit) and the topic message stays — the operator's archive is kept; the confirmation quotes the replied-to message and reports `delDone`/`delFailed`. Replying to a **user** message is silently ignored — the bot can only delete its own messages, never ones the user typed; replying to the conversation's **first pinned purpose+info opening card** is refused for both admins and operators (`pinCardProtected`) — that card is permanent and only removed by deleting the conversation itself; a target with no record at all (an ordinary unpinned info card) has no user-side copy to retract, so an **admin's** reply-to-target `/delete` falls through to the conversation delete while a non-admin operator gets an honest `nothingToRetract` reply instead of a hollow success. **Without a reply** `/delete` deletes the conversation (ADMIN only). At group level / private chat: `/delete <@user\|id\|conversation>` deletes directly, otherwise posts the tap-to-delete picker. Refuses the requester's own, the bot's, or a staff member's conversation. The delete path cascade-deletes messages + notes, removes the conversation, resets the user's access (re-verify on next contact), and best-effort deletes the topic and the delivered user-chat copies |
| `/restore <@user\|id\|conversation>` | group | OPERATOR+ | reopen a hidden conversation |
| `/help` | topic or group | OPERATOR+ | every command with its parameters and usage, one per line |

**Why `/delete` retracts explicitly.** The Bot API delivers an `edited_message` update when a message is edited but **never notifies a bot when a message is deleted** — so an operator long-press-deleting a topic message cannot be detected, and the copy of an operator→user relay in the user's chat would silently remain even though the topic source is gone. Replying to a topic message with `/delete` makes the retraction an explicit command: the bot owns the user-side copy it delivered (it sent it), so it can remove it; the topic message is deliberately kept so operators retain the archive. Deletions are best-effort — messages older than 48 h (or already gone) are logged and dropped without failing.

User-side commands: `/start` (verification entry), `/apply` (application entry), and `/help`. Per product decision, **user help advertises only `/start`** — no other commands are hinted. Unknown user commands also point to `/start`. `/lang` still works when typed but is deliberately not shown in the user command menu (it stays in the operator menus).

## 8. Anti-spam

All thresholds are config-driven, never hardcoded:

- **Per-user rate limit** — rolling window (default 10 messages / 60 s).
- **Flood protection** — a burst past the flood threshold triggers a temporary restriction (no block record).
- **Message length cap** and **media size cap** — rejected at ingestion.
- **Block list** — blocked users are rejected at ingestion and cannot bypass block by re-`/start`.
- **Ad-text detection (广告防护)** — detection runs on the hot path for text and media captions (a sticker has no text and never matches), with **allow-first** evaluation: allow keywords (`/ad allow` + `AD_ALLOW_KEYWORDS`) and allow patterns (`AD_ALLOW_PATTERNS`) are checked before anything else and clear the message on a hit; then the link-count rule (`AD_MAX_LINKS` / `/ad links` — counts `http(s)://` plus `t.me/…` and `telegram.me/…` handles); then the keyword blocklist (case-insensitive substring match); then the regex blocklist (tested against the whole text). The keyword blocklist merges the `AD_KEYWORDS` env words — a built-in default blacklist of 43 common spam words (`兼职,网赚,返利,返佣,刷单,刷赞,代购,垫付,日结,日赚,月入,躺赚,稳赚,赚钱,高佣金,宝妈,做任务,薅羊毛,加微信,加V,加QQ,引流,私聊,免费领取,领红包,抽奖,中奖,优惠券,赌博,博彩,菠菜,六合彩,彩票,开奖,出款,跑分,贷款,放款,炒股,荐股,投资,理财,虚拟币`) applies when the variable is unset and an explicitly empty variable contributes none; the whole list is overridable via `AD_KEYWORDS` and individual false positives via `AD_ALLOW_KEYWORDS` — with runtime keywords managed via `/ad`, persisted in the settings table, so a runtime change takes effect immediately. Regex patterns come only from `AD_PATTERNS`. **Only users who have not passed human verification on the bot they are messaging are subject to the blacklist** — verification is per (bot, user), so a human verified on one bot is still ad-screened on another; a verified-on-this-bot or approved human is trusted and is never ad-blocked. On a hit by an unverified user the message is dropped (no rows created) and, when `AD_AUTO_BLOCK=true`, the sender is written to the block list (`created_by_telegram_user_id = 0` marks an auto-block). The hit is **quarantined** instead of announced in the general chat: the message is silently forwarded into a dedicated "🚮 Spam quarantine" topic (created lazily, id persisted in settings), and the notification (user, matched reason, excerpt, `/unban <id>` hint) is posted **inside that topic**. An admin replies to the quarantined copy with `/ad restore` to forward it back into the sender's topic, recorded as a USER_TO_OPERATOR relay; restoring never unblocks. Any quarantine failure falls back to a group-general-chat notification so an admin is never left blind. The check sits after the block check and before rate limiting, so a first-contact ad creates no user/conversation/topic row and is still reachable via group-level `/unban <@user|id>`. `AD_ENABLED=false` disables detection entirely; `AD_AUTO_BLOCK=false` drops + quarantines without blocking.

The user-facing `/apply` and `/start` paths are also subject to the per-user rate limit.

## 9. Reliability

- **Idempotency** — every `(bot_id, update_id)` is claimed (ledger row with a per-claim nonce) before processing; a duplicate claim is a no-op. Update ids are **per-bot**, so the same update id arriving on two bots claims independently. The unique `messages(bot_id, chat_id, message_id)` index is the storage backstop.
- **Telegram retries** — `429` honors `retry_after`; retryable failures (`429`, 5xx, network) get a bounded, exponential-backoff budget. `400`/`403`/`404` are never blind-retried, except the semantic recovery paths below.
- **Topic recovery** — a send against a deleted topic recreates the topic, posts its user-info card, updates `conversation.telegram_topic_id`, and retries once; a send against a closed/hidden topic restores it in place and retries once. Recovery only runs while the conversation row still exists — `/delete` removes it, so deleted conversations are never resurrected.
- **Per-conversation serialization** — the Docker path uses an in-process keyed mutex; the Cloudflare path relies on the Durable Object queue, which already serializes requests per instance.

## 10. Deployment

### 10.1 Docker

Requirements: Docker with compose.

1. `cp .env.example .env` at the repo root and configure `BOTS`, `GROUP_ID`, `ADMIN_IDS`, `OPERATOR_IDS` (see §11).
2. `docker compose -f src/docker/docker-compose.yml up -d` (from the repo root).
3. The service listens on port `17575` (`POST /webhook` and `/webhook/<botId>`, `GET /health`).
4. The SQLite database lives at `/app/data/relaytg.db` on the mounted `data/` volume at the repo root — container restarts keep all data.
5. Put a public HTTPS endpoint in front (reverse proxy, tunnel) and configure the Telegram webhooks once (§12).

### 10.2 Cloudflare Workers Free

Requirements: Node 22+, a Cloudflare account, `wrangler`.

1. `pnpm install`.
2. Set secrets (never in `wrangler.jsonc` or git):
   ```bash
   npx wrangler secret put BOTS
   npx wrangler secret put ADMIN_IDS
   npx wrangler secret put OPERATOR_IDS
   ```
3. Set `GROUP_ID` in `src/apps/worker/wrangler.jsonc` `vars` (a group id is not a credential).
4. `npx wrangler deploy` — first deploy registers the `ConversationDO` Durable Object with SQLite-backed storage (`new_sqlite_classes`). No paid Cloudflare products, no external database, no third-party services are required.
5. Configure the Telegram webhooks once (§12) at `https://<worker>.workers.dev/webhook` and `/webhook/<botId>`.

Local development: `npx wrangler dev --var BOTS:main:... --var GROUP_ID:...` (shell env vars are not injected as Worker bindings).

### 10.3 Health

Both runtimes expose `GET /health` → `200 {"status":"ok"}`.

## 11. Configuration reference

Docker: environment variables via `.env`. Cloudflare: Worker **secrets** for credentials, `vars` for non-secrets. The canonical list lives in `.env.example`.

| Variable | Default | Secret | Purpose |
| --- | --- | --- | --- |
| `BOTS` | — (required) | ✓ | Comma-separated `name:token` pairs; the FIRST is the primary bot (owns the group control surface). The token itself contains `:`, so each name is everything before the first colon of its entry, validating `[A-Za-z0-9_-]`. The name becomes the topic-name prefix (`bot名 | 用户名 | ID`). |
| `GROUP_ID` | — (required) | | Numeric id of the Forum support group |
| `ADMIN_IDS` | — | ✓ | Comma-separated numeric admin `telegram_user_id`s |
| `OPERATOR_IDS` | — | ✓ | Comma-separated numeric operator `telegram_user_id`s |
| `DATABASE_PATH` | `data/relaytg.db` | | SQLite file (Docker only) |
| `AUTO_HIDE_HOURS` | `168` | | Global no-reply auto-hide hard cap (hours); the default policy is permanent display — `/hide N` sets a sooner per-conversation threshold |
| `VERIFY_ATTEMPTS` | `3` | | Arithmetic challenge attempt budget |
| `VERIFY_TTL_SECONDS` | `300` | | Challenge validity window |
| `SPAM_ENABLED` | `true` | | Master anti-spam switch |
| `SPAM_RATE_LIMIT_MAX` | `10` | | Messages per user per window |
| `SPAM_RATE_LIMIT_WINDOW_SECONDS` | `60` | | Rate-limit window |
| `SPAM_FLOOD_MAX` | `30` | | Flood threshold per window |
| `SPAM_FLOOD_WINDOW_SECONDS` | `60` | | Flood window |
| `SPAM_FLOOD_RESTRICT_SECONDS` | `300` | | Temporary restriction length |
| `SPAM_MAX_MESSAGE_LENGTH` | `4096` | | Message-length cap |
| `SPAM_MAX_MEDIA_SIZE_BYTES` | `20971520` | | Media-size cap |
| `AD_ENABLED` | `true` | | Master ad-detection switch |
| `AD_AUTO_BLOCK` | `true` | | On an ad hit: drop the message **and** block the sender |
| `AD_KEYWORDS` | — | | Comma-separated ad keywords (case-insensitive substring match); unset = built-in default blacklist (43 words: 兼职/网赚/返利/刷单/代购/赚钱/日赚/月入/垫付/加微信/引流/博彩/彩票/贷款/投资/理财/虚拟币 等), empty = none |
| `AD_PATTERNS` | — | | Comma-separated ad regex patterns (no commas inside a regex) |
| `AD_ALLOW_KEYWORDS` | — | | Comma-separated allow keywords — checked first, a hit clears the message |
| `AD_ALLOW_PATTERNS` | — | | Comma-separated allow regex patterns — same allow-first behavior |
| `AD_MAX_LINKS` | `0` | | Link-count rule: reject unverified messages with ≥ N links (`0` = off) |
| `TELEGRAM_RETRIES` | `3` | | Retry budget for retryable failures |
| `TELEGRAM_BASE_BACKOFF_MS` | `500` | | Exponential-backoff base (`Docker: 500`, Worker var default `250`) |

## 12. One-time out-of-band webhook configuration

RelayTG exposes **`POST /webhook`** (= the primary bot) and **`POST /webhook/<botId>`** (one route per additional bot) on both runtimes and **does not** manage `setWebhook`/`deleteWebhook`/`getWebhookInfo` — configuring the Telegram side is a documented one-time deployment step. The path selects which bot an update belongs to; the single `WEBHOOK_SECRET` guards every route.

Your deployment must be reachable at a **public HTTPS URL** that forwards to the webhook paths:

- Docker: `https://your-host.example/webhook[/<botId>]` (reverse proxy / tunnel → `http://<container>:17575`).
- Cloudflare: `https://relaytg.<subdomain>.workers.dev/webhook[/<botId>]`.

Configure every bot once (replace `<TOKEN>` for that bot, `<BOT_ID>` = its `BOTS` name, and the URL). The **primary** bot registers at `/webhook`:

```bash
curl -F "url=https://YOUR-PUBLIC-HOST/webhook" \
  -F "secret_token=$WEBHOOK_SECRET" \
  "https://api.telegram.org/bot<TOKEN>/setWebhook"
```

Every **additional** bot registers at `/webhook/<botId>`, sharing the same `$WEBHOOK_SECRET`:

```bash
curl -F "url=https://YOUR-PUBLIC-HOST/webhook/<BOT_ID>" \
  -F "secret_token=$WEBHOOK_SECRET" \
  "https://api.telegram.org/bot<TOKEN>/setWebhook"
```

Verify each bot:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

## 13. Security

- `BOTS` and other secrets **must never** be committed to git, written to logs, stored in the database, baked into a Docker image, or shipped to clients. They arrive only via environment variables / Worker secrets at startup.
- `.env`, `.env.*`, `data/`, `.wrangler/`, and `.dev.vars` are gitignored.
- The structured logger emits a fixed event catalog (timestamp, level, component, event, `conversation_id`/`telegram_user_id`) and is constructed so a value passed as a body can never be interpolated into output.
- Authorization is exclusively by `telegram_user_id`; usernames are display-only.
- Broadcast/channel traffic and bot senders are ignored at the parser and again at the processor (defense in depth).

## 14. Testing & acceptance

`pnpm test` runs the full Vitest suite:

- **Unit tests** for every service, the Telegram parser/mapper/client, config, and logger.
- **Shared storage suite** (`src/adapters/sqlite/src/storage-suite.ts`) — migrations + every repository method against **both** `node:sqlite` and the Durable Object fake handle.
- **Shared relay scenario suite** (`src/adapters/sqlite/src/relay-suite.ts`) — user→topic, topic→user, four-choice verification, purpose gate (prompt after verification, purpose statement opens the conversation, `/apply` approval asks for a purpose), `/apply` approval, reply, duplicate update, block, rate limit, hide/restore, and `/hide` policy against **both** stacks.
- **Acceptance suite** (`src/apps/docker/src/acceptance.test.ts`) — the ten §48 acceptance scenarios (new-user verification, second-user isolation, user message, operator reply, reply, restart persistence, topic-deletion recovery, block, rate limit, duplicate update) plus edit relay, non-operator messages ignored, `/apply`→approval (purpose gate on approval), hide→`/restore`→reopen, `/hide off`, purpose gate on the verify path + the topic opening with a single pinned purpose+info card (no forward), and `/help` in both contexts. The `/delete` re-verify + user-chat copy mirroring scenarios are covered by the core commands suite and the shared storage suite.

Acceptance criteria (summary):

1. A new user passes the four-choice arithmetic verification and a conversation is opened.
2. A second user's conversation is isolated from the first.
3. A user message reaches their topic and is recorded.
4. An operator reply reaches the owning user's private chat.
5. A reply preserves its target across the relay.
6. Restarting the process preserves users, conversations, and messages.
7. Deleting the support topic recovers with a fresh topic and delivery succeeds.
8. A blocked user's messages are rejected.
9. An over-window user is rate-limited.
10. A repeated update is deduplicated.