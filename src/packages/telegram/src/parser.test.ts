import { describe, expect, it } from "vitest";
import { parseUpdate } from "./parser.ts";
import type { TgUpdate } from "./parser.ts";

function user(id: number, extra: Record<string, unknown> = {}) {
  return { id, is_bot: false, first_name: "A", username: "a", ...extra };
}

describe("update parser: user-side events", () => {
  it("maps a private text message to a user_message event", () => {
    const update: TgUpdate = {
      update_id: 1,
      message: {
        message_id: 100,
        from: user(7),
        chat: { id: 7, type: "private" },
        text: "hello",
        reply_to_message: { message_id: 90 },
      },
    };
    const { updateId, event } = parseUpdate(update);
    expect(updateId).toBe(1);
    expect(event.kind).toBe("user_message");
    if (event.kind !== "user_message") return;
    expect(event.chatId).toBe(7);
    expect(event.messageId).toBe(100);
    expect(event.sender.telegramUserId).toBe(7);
    expect(event.content).toEqual({ type: "text", text: "hello" });
    expect(event.replyToMessageId).toBe(90);
    expect(event.mediaGroupId).toBeNull();
  });

  it("maps a photo message with caption to photo content", () => {
    const update: TgUpdate = {
      update_id: 2,
      message: {
        message_id: 101,
        from: user(7),
        chat: { id: 7, type: "private" },
        caption: "look",
        photo: [{ file_id: "f1", file_size: 10 }, { file_id: "f2", file_size: 500 }],
      },
    };
    const { event } = parseUpdate(update);
    if (event.kind !== "user_message") return expect.fail("expected user_message");
    expect(event.content).toEqual({ type: "photo", fileId: "f2", caption: "look", fileSize: 500 });
  });

  it("maps a sticker message to sticker content", () => {
    const update: TgUpdate = {
      update_id: 3,
      message: { message_id: 102, from: user(7), chat: { id: 7, type: "private" }, sticker: { file_id: "st1", file_size: 99 } },
    };
    const { event } = parseUpdate(update);
    if (event.kind !== "user_message") return expect.fail("expected user_message");
    expect(event.content).toEqual({ type: "sticker", fileId: "st1", fileSize: 99 });
  });

  it("maps an edited private message to an edited_user_message event", () => {
    const update: TgUpdate = {
      update_id: 4,
      edited_message: { message_id: 100, from: user(7), chat: { id: 7, type: "private" }, text: "edited" },
    };
    const { event } = parseUpdate(update);
    expect(event.kind).toBe("edited_user_message");
    if (event.kind !== "edited_user_message") return;
    expect(event.content).toEqual({ type: "text", text: "edited" });
  });
});

describe("update parser: operator-side events", () => {
  it("maps a support-group topic message to an operator_message event", () => {
    const update: TgUpdate = {
      update_id: 5,
      message: {
        message_id: 200,
        from: user(900),
        chat: { id: -100, type: "supergroup" },
        message_thread_id: 42,
        text: "reply",
      },
    };
    const { event } = parseUpdate(update);
    if (event.kind !== "operator_message") return expect.fail("expected operator_message");
    expect(event.chatId).toBe(-100);
    expect(event.messageThreadId).toBe(42);
    expect(event.content).toEqual({ type: "text", text: "reply" });
  });

  it("maps a general-chat command to an operator_message with null thread id", () => {
    const update: TgUpdate = {
      update_id: 6,
      message: { message_id: 201, from: user(900), chat: { id: -100, type: "supergroup" }, text: "/restore 7" },
    };
    const { event } = parseUpdate(update);
    if (event.kind !== "operator_message") return expect.fail("expected operator_message");
    expect(event.messageThreadId).toBeNull();
  });

  it("maps an edited topic message to an edited_operator_message event", () => {
    const update: TgUpdate = {
      update_id: 7,
      edited_message: {
        message_id: 200,
        from: user(900),
        chat: { id: -100, type: "supergroup" },
        message_thread_id: 42,
        text: "edited reply",
      },
    };
    const { event } = parseUpdate(update);
    expect(event.kind).toBe("edited_operator_message");
    if (event.kind !== "edited_operator_message") return;
    expect(event.messageThreadId).toBe(42);
  });
});

describe("update parser: callback queries", () => {
  it("maps a verify callback to a verification_answer event", () => {
    const update: TgUpdate = {
      update_id: 8,
      callback_query: {
        id: "cq1",
        from: user(7),
        message: { message_id: 300, chat: { id: 7, type: "private" } },
        data: "verify:17",
      },
    };
    const { event } = parseUpdate(update);
    if (event.kind !== "verification_answer") return expect.fail("expected verification_answer");
    expect(event.answer).toBe(17);
    expect(event.callbackQueryId).toBe("cq1");
  });

  it("maps an apply approve callback to an application_decision event", () => {
    const update: TgUpdate = {
      update_id: 9,
      callback_query: {
        id: "cq2",
        from: user(900),
        message: { message_id: 301, chat: { id: -100, type: "supergroup" } },
        data: "apply:approve:app_123",
      },
    };
    const { event } = parseUpdate(update);
    if (event.kind !== "application_decision") return expect.fail("expected application_decision");
    expect(event.decision).toBe("approve");
    expect(event.applicationId).toBe("app_123");
  });

  it("maps an apply reject callback", () => {
    const update: TgUpdate = {
      update_id: 10,
      callback_query: {
        id: "cq3",
        from: user(900),
        message: { message_id: 302, chat: { id: -100, type: "supergroup" } },
        data: "apply:reject:app_123",
      },
    };
    const { event } = parseUpdate(update);
    if (event.kind !== "application_decision") return expect.fail("expected application_decision");
    expect(event.decision).toBe("reject");
    expect(event.applicationId).toBe("app_123");
  });

  it("maps a del: callback (tap-to-delete picker) to a conversation_delete event", () => {
    const update: TgUpdate = {
      update_id: 11,
      callback_query: {
        id: "cq-del",
        from: user(111),
        message: { message_id: 402, chat: { id: -100, type: "supergroup" } },
        data: "del:conv_abc123",
      },
    };
    const { event } = parseUpdate(update);
    if (event.kind !== "conversation_delete") return expect.fail("expected conversation_delete");
    expect(event.callbackQueryId).toBe("cq-del");
    expect(event.chatId).toBe(-100);
    expect(event.messageId).toBe(402);
    expect(event.conversationId).toBe("conv_abc123");
  });

  it("ignores a del: callback without a message (no chat/message id to act on)", () => {
    const update: TgUpdate = {
      update_id: 12,
      callback_query: { id: "cq-del2", from: user(111), data: "del:conv_abc123" },
    };
    const { event } = parseUpdate(update);
    expect(event.kind).toBe("ignored");
  });
});

describe("update parser: ignored cases", () => {
  it("ignores a bot sender", () => {
    const update: TgUpdate = {
      update_id: 11,
      message: { message_id: 400, from: user(500, { is_bot: true }), chat: { id: 7, type: "private" }, text: "hi" },
    };
    const { event } = parseUpdate(update);
    expect(event.kind).toBe("ignored");
  });

  it("ignores a non-message, non-callback update", () => {
    const update: TgUpdate = { update_id: 12, channel_post: { message_id: 1 } } as unknown as TgUpdate;
    const { event } = parseUpdate(update);
    expect(event.kind).toBe("ignored");
  });

  it("ignores an unsupported content type", () => {
    const update: TgUpdate = {
      update_id: 13,
      message: { message_id: 401, from: user(7), chat: { id: 7, type: "private" }, location: { latitude: 1, longitude: 2 } },
    } as unknown as TgUpdate;
    const { event } = parseUpdate(update);
    expect(event.kind).toBe("ignored");
  });

  it("ignores malformed verify data — a truncated or Number()-coercible payload must not be consumed as a wrong-but-valid tap", () => {
    for (const data of ["verify:", "verify:abc", "verify:0x10", "verify:1e2", "verify: 5", "verify:+7"]) {
      const update: TgUpdate = {
        update_id: 14,
        callback_query: { id: "cq4", from: user(7), message: { message_id: 1, chat: { id: 7, type: "private" } }, data },
      };
      const { event } = parseUpdate(update);
      expect(event.kind, `data=${JSON.stringify(data)}`).toBe("ignored");
    }
  });

  it("maps a negative verify answer (valid strict decimal) to a verification_answer event", () => {
    const update: TgUpdate = {
      update_id: 16,
      callback_query: { id: "cq-neg", from: user(7), message: { message_id: 1, chat: { id: 7, type: "private" } }, data: "verify:-3" },
    };
    const { updateId, event } = parseUpdate(update);
    expect(updateId).toBe(16);
    expect(event.kind).toBe("verification_answer");
    if (event.kind === "verification_answer") expect(event.answer).toBe(-3);
  });

  it("ignores unknown callback data", () => {
    const update: TgUpdate = {
      update_id: 15,
      callback_query: { id: "cq5", from: user(7), message: { message_id: 1, chat: { id: 7, type: "private" } }, data: "unknown" },
    };
    const { event } = parseUpdate(update);
    expect(event.kind).toBe("ignored");
  });
});
