// ---------------------------------------------------------------------------
// Structured logger with a fixed event catalog and a restricted field schema.
// The value contract: methods accept a known event name plus an object whose
// keys MUST be on the allowlist. Unknown keys are dropped at runtime, so a
// secret passed under a stray key can never be interpolated into a log line.
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Fixed event catalog. Components log by picking an event from this list —
 * free-form message strings are not part of the API.
 */
export type LogEvent =
  | "system_start"
  | "system_error"
  | "update_received"
  | "update_processed"
  | "update_duplicate"
  | "update_ignored"
  | "user_created"
  | "user_profile_refreshed"
  | "user_verified"
  | "user_language_changed"
  | "purpose_prompted"
  | "purpose_recorded"
  | "user_access_reset"
  | "copy_delete_failed"
  | "conversation_created"
  | "conversation_lost_race"
  | "conversation_deleted"
  | "conversation_hidden"
  | "conversation_restored"
  | "topic_created"
  | "topic_card_posted"
  | "topic_card_failed"
  | "topic_card_pin_failed"
  | "topic_restored"
  | "topic_deleted"
  | "message_relayed"
  | "relay_undeliverable"
  | "message_recorded"
  | "message_edit_relayed"
  | "message_edit_dropped"
  | "del_user_chat_failed"
  | "verification_issued"
  | "verification_correct"
  | "verification_wrong"
  | "verification_expired"
  | "application_created"
  | "application_decided"
  | "command_executed"
  | "command_rejected"
  | "command_invalid"
  | "command_failed"
  | "block_added"
  | "block_removed"
  | "ad_blocked"
  | "ad_quarantined"
  | "quarantine_restored"
  | "message_queued"
  | "pending_forward_failed"
  | "rate_limited"
  | "flood_restricted"
  | "message_rejected"
  | "sweep_hide"
  | "sweep_skip"
  | "command_menu_failed"
  | "selfcheck";

/** Fields emitted on a log line. Allowlisted keys only. */
export interface LogFields {
  conversationId?: string;
  telegramUserId?: number;
  topicId?: number;
  updateId?: number;
  direction?: string;
  contentType?: string;
  status?: string;
  errorKind?: string;
  durationMs?: number;
  attempt?: number;
  /** Distinguishes the path a rejection came from (e.g. "edit"). */
  kind?: string;
  /** The topic id dropped by a lost create race. */
  droppedTopicId?: number;
  /** Bot command scope that failed to register (e.g. "all_private_chats"). */
  scope?: string;
  /** The language chosen by a `/lang` change (e.g. "zh", "en", "auto"). */
  language?: string;
  /** The `/delete` path: "direct" | "picker" | "tap". */
  mode?: string;
  /** Whether a posted identity card was pinned (the first-contact combined
   *  purpose+info card is pinned; recovered-topic cards are not). */
  pinned?: boolean;
  /** What an ad detection matched (keyword/pattern), for ad_blocked lines. */
  reason?: string;
  /** The bot a log line belongs to (multi-bot: events arrive per bot). */
  botId?: string;
}

/** Restricted field keys — anything not in this set is dropped at runtime. */
const FIELD_KEYS = new Set<keyof LogFields>([
  "conversationId",
  "telegramUserId",
  "topicId",
  "updateId",
  "direction",
  "contentType",
  "status",
  "errorKind",
  "durationMs",
  "attempt",
  "kind",
  "droppedTopicId",
  "scope",
  "language",
  "mode",
  "pinned",
  "reason",
  "botId",
]);

export interface Logger {
  debug(event: LogEvent, fields?: LogFields): void;
  info(event: LogEvent, fields?: LogFields): void;
  warn(event: LogEvent, fields?: LogFields): void;
  error(event: LogEvent, fields?: LogFields): void;
}

export type LogSink = (line: string) => void;

export interface LoggerOptions {
  component: string;
  level?: LogLevel;
  sink?: LogSink;
  now?: () => Date;
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class ConsoleLogger implements Logger {
  private readonly component: string;
  private readonly minLevel: LogLevel;
  private readonly sink: LogSink;
  private readonly now: () => Date;

  constructor(opts: LoggerOptions) {
    this.component = opts.component;
    this.minLevel = opts.level ?? "info";
    this.sink = opts.sink ?? ((line) => console.log(line));
    this.now = opts.now ?? (() => new Date());
  }

  debug(event: LogEvent, fields?: LogFields): void {
    this.log("debug", event, fields);
  }

  info(event: LogEvent, fields?: LogFields): void {
    this.log("info", event, fields);
  }

  warn(event: LogEvent, fields?: LogFields): void {
    this.log("warn", event, fields);
  }

  error(event: LogEvent, fields?: LogFields): void {
    this.log("error", event, fields);
  }

  private log(level: LogLevel, event: LogEvent, fields?: LogFields): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return;
    const ts = this.now().toISOString();
    const safe = this.sanitize(fields);
    const fieldsJson = Object.keys(safe).length > 0 ? ` ${JSON.stringify(safe)}` : "";
    this.sink(`${ts} ${level} [${this.component}] ${event}${fieldsJson}`);
  }

  /** Drop any key that is not on the allowlist — secrets can't leak through. */
  private sanitize(fields?: LogFields): Record<string, unknown> {
    if (!fields) return {};
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(fields) as Array<keyof LogFields>) {
      if (FIELD_KEYS.has(key) && fields[key] !== undefined) {
        out[key] = fields[key];
      }
    }
    return out;
  }
}
