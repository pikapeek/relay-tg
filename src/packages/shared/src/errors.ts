// ---------------------------------------------------------------------------
// Layered error taxonomy. Telegram adapter errors carry a kind plus optional
// retry metadata; core throws domain errors that callers translate to user- or
// operator-facing messages. Nothing here knows about a runtime or framework.
// ---------------------------------------------------------------------------

export type TelegramErrorKind =
  | "bad_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "retryable_server"
  | "network"
  | "invalid_token"
  | "topic_not_found"
  | "topic_closed"
  | "unexpected";

export class TelegramError extends Error {
  readonly kind: TelegramErrorKind;
  /** Seconds the API asked us to wait, present on 429 responses. */
  readonly retryAfter: number | undefined;
  readonly httpStatus: number | undefined;
  override readonly cause: unknown;

  constructor(
    message: string,
    opts: {
      kind: TelegramErrorKind;
      retryAfter?: number;
      httpStatus?: number;
      cause?: unknown;
    } = { kind: "unexpected" },
  ) {
    super(message);
    this.name = "TelegramError";
    this.kind = opts.kind;
    this.retryAfter = opts.retryAfter;
    this.httpStatus = opts.httpStatus;
    this.cause = opts.cause;
  }

  /** Transient failures that the adapter may retry within its budget. */
  isRetryable(): boolean {
    return this.kind === "rate_limited" || this.kind === "retryable_server" || this.kind === "network";
  }
}

/** Recoverable missing-topic variant surfaced so core can recreate and retry. */
export function isTopicNotFound(e: unknown): e is TelegramError {
  return e instanceof TelegramError && e.kind === "topic_not_found";
}

/** Recoverable closed/hidden-topic variant surfaced so core can restore and retry. */
export function isTopicClosed(e: unknown): e is TelegramError {
  return e instanceof TelegramError && e.kind === "topic_closed";
}

export class DatabaseError extends Error {
  override readonly cause: unknown;
  constructor(message: string, opts: { cause?: unknown } = {}) {
    super(message);
    this.name = "DatabaseError";
    this.cause = opts.cause;
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class AuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorizationError";
  }
}

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

export type ConversationErrorCode =
  | "topic_creation_failed"
  | "conversation_not_found"
  | "no_topic";

export class ConversationError extends Error {
  readonly code: ConversationErrorCode;
  constructor(message: string, code: ConversationErrorCode) {
    super(message);
    this.name = "ConversationError";
    this.code = code;
  }
}
