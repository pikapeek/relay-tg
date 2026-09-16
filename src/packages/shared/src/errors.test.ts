import { describe, expect, it } from "vitest";
import {
  AuthorizationError,
  ConversationError,
  DatabaseError,
  RateLimitError,
  TelegramError,
  ValidationError,
  isTopicClosed,
  isTopicNotFound,
} from "./errors.ts";

describe("layered error types", () => {
  it("constructs every error type", () => {
    expect(new TelegramError("t").name).toBe("TelegramError");
    expect(new DatabaseError("d").name).toBe("DatabaseError");
    expect(new ValidationError("v").name).toBe("ValidationError");
    expect(new AuthorizationError("a").name).toBe("AuthorizationError");
    expect(new RateLimitError("r").name).toBe("RateLimitError");
    expect(new ConversationError("c", "conversation_not_found").name).toBe("ConversationError");
  });

  it("carries kind and retry_after on TelegramError", () => {
    const err = new TelegramError("too many", { kind: "rate_limited", retryAfter: 42, httpStatus: 429 });
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfter).toBe(42);
    expect(err.httpStatus).toBe(429);
    expect(err.isRetryable()).toBe(true);
  });

  it("classifies retryable vs non-retryable kinds", () => {
    expect(new TelegramError("x", { kind: "retryable_server" }).isRetryable()).toBe(true);
    expect(new TelegramError("x", { kind: "network" }).isRetryable()).toBe(true);
    expect(new TelegramError("x", { kind: "bad_request" }).isRetryable()).toBe(false);
    expect(new TelegramError("x", { kind: "forbidden" }).isRetryable()).toBe(false);
    expect(new TelegramError("x", { kind: "not_found" }).isRetryable()).toBe(false);
  });

  it("distinguishes topic_not_found and topic_closed variants", () => {
    const notFound = new TelegramError("chat not found", { kind: "topic_not_found" });
    const closed = new TelegramError("topic closed", { kind: "topic_closed" });
    expect(isTopicNotFound(notFound)).toBe(true);
    expect(isTopicNotFound(closed)).toBe(false);
    expect(isTopicClosed(closed)).toBe(true);
    expect(isTopicClosed(notFound)).toBe(false);
  });
});
