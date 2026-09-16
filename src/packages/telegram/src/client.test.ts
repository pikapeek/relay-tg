import { describe, expect, it } from "vitest";
import { HttpTelegramClient } from "./client.ts";
import type { FetchLike, FetchLikeInit } from "./client.ts";
import { TelegramError } from "@relaytg/shared";

interface MockResponse {
  status: number;
  body: { ok: boolean; error_code?: number; description?: string; parameters?: { retry_after?: number }; result?: unknown };
}

function mockFetch(responses: MockResponse[]): { fetchFn: FetchLike; calls: Array<{ url: string; init?: FetchLikeInit }> } {
  const calls: Array<{ url: string; init?: FetchLikeInit }> = [];
  let idx = 0;
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = responses[Math.min(idx, responses.length - 1)];
    idx += 1;
    return {
      ok: r.body.ok,
      status: r.status,
      json: async () => r.body,
    };
  };
  return { fetchFn, calls };
}

function formOf(init?: FetchLikeInit): URLSearchParams {
  return init?.body as URLSearchParams;
}

const TOKEN = "123:token";

describe("HttpTelegramClient retry semantics", () => {
  it("honors 429 retry_after and retries", async () => {
    const { fetchFn, calls } = mockFetch([
      { status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 0 } } },
      { status: 200, body: { ok: true, result: { message_id: 5 } } },
    ]);
    const client = new HttpTelegramClient({ botToken: TOKEN, fetchFn, retries: 3, baseBackoffMs: 1 });
    const id = await client.sendMessage({ chatId: 1, text: "hi" });
    expect(id).toBe(5);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain("/sendMessage");
  });

  it("exhausts the retry budget on repeated 429 and throws, without exiting", async () => {
    const { fetchFn, calls } = mockFetch([
      { status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 0 } } },
      { status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 0 } } },
      { status: 429, body: { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 0 } } },
    ]);
    const client = new HttpTelegramClient({ botToken: TOKEN, fetchFn, retries: 2, baseBackoffMs: 1 });
    await expect(client.sendMessage({ chatId: 1, text: "hi" })).rejects.toMatchObject({ kind: "rate_limited", retryAfter: 0 });
    expect(calls).toHaveLength(3);
  });

  it("retries a 5xx response", async () => {
    const { fetchFn, calls } = mockFetch([
      { status: 500, body: { ok: false, error_code: 500, description: "Internal" } },
      { status: 500, body: { ok: false, error_code: 500, description: "Internal" } },
      { status: 200, body: { ok: true, result: { message_id: 9 } } },
    ]);
    const client = new HttpTelegramClient({ botToken: TOKEN, fetchFn, retries: 3, baseBackoffMs: 1 });
    const id = await client.sendMessage({ chatId: 1, text: "hi" });
    expect(id).toBe(9);
    expect(calls).toHaveLength(3);
  });

  it("does not retry a 400", async () => {
    const { fetchFn, calls } = mockFetch([
      { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: bad thing" } },
    ]);
    const client = new HttpTelegramClient({ botToken: TOKEN, fetchFn, retries: 3, baseBackoffMs: 1 });
    await expect(client.sendMessage({ chatId: 1, text: "hi" })).rejects.toMatchObject({ kind: "bad_request" });
    expect(calls).toHaveLength(1);
  });
});

describe("HttpTelegramClient topic errors", () => {
  it("maps a closed-topic send failure to topic_closed", async () => {
    const { fetchFn } = mockFetch([
      { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: message thread is closed" } },
    ]);
    const client = new HttpTelegramClient({ botToken: TOKEN, fetchFn, retries: 0 });
    await expect(client.sendContent({ chatId: -100, messageThreadId: 42 }, { type: "text", text: "x" })).rejects.toMatchObject({ kind: "topic_closed" });
  });

  it("maps a missing-topic send failure to topic_not_found", async () => {
    const { fetchFn } = mockFetch([
      { status: 400, body: { ok: false, error_code: 400, description: "Bad Request: message thread not found" } },
    ]);
    const client = new HttpTelegramClient({ botToken: TOKEN, fetchFn, retries: 0 });
    await expect(client.sendContent({ chatId: -100, messageThreadId: 42 }, { type: "text", text: "x" })).rejects.toMatchObject({ kind: "topic_not_found" });
  });
});

describe("HttpTelegramClient topic hide/restore and payloads", () => {
  it("calls closeForumTopic for hide and reopenForumTopic for restore", async () => {
    const { fetchFn, calls } = mockFetch([
      { status: 200, body: { ok: true, result: {} } },
      { status: 200, body: { ok: true, result: {} } },
    ]);
    const client = new HttpTelegramClient({ botToken: TOKEN, fetchFn, retries: 0 });
    await client.hideForumTopic({ chatId: -100, messageThreadId: 42 });
    await client.restoreForumTopic({ chatId: -100, messageThreadId: 42 });
    expect(calls[0]!.url).toContain("/closeForumTopic");
    expect(calls[1]!.url).toContain("/reopenForumTopic");
    expect(formOf(calls[0]!.init).get("message_thread_id")).toBe("42");
    expect(formOf(calls[1]!.init).get("message_thread_id")).toBe("42");
  });

  it("calls editForumTopic with chat, thread, and name", async () => {
    const { fetchFn, calls } = mockFetch([{ status: 200, body: { ok: true, result: {} } }]);
    const client = new HttpTelegramClient({ botToken: TOKEN, fetchFn, retries: 0 });
    await client.editForumTopic({ chatId: -100, messageThreadId: 42, name: "VIP case" });
    expect(calls[0]!.url).toContain("/editForumTopic");
    expect(formOf(calls[0]!.init).get("message_thread_id")).toBe("42");
    expect(formOf(calls[0]!.init).get("name")).toBe("VIP case");
  });

  it("encodes reply markup and topic target on sendContent", async () => {
    const { fetchFn, calls } = mockFetch([{ status: 200, body: { ok: true, result: { message_id: 3 } } }]);
    const client = new HttpTelegramClient({ botToken: TOKEN, fetchFn, retries: 0 });
    await client.sendContent(
      { chatId: -100, messageThreadId: 42 },
      { type: "text", text: "hello" },
      { buttons: [{ text: "5", callbackData: "verify:5" }] },
    );
    const form = formOf(calls[0]!.init);
    expect(form.get("chat_id")).toBe("-100");
    expect(form.get("message_thread_id")).toBe("42");
    expect(form.get("text")).toBe("hello");
    expect(form.get("reply_markup")).toContain('"callback_data":"verify:5"');
  });
});

describe("HttpTelegramClient network failure", () => {
  it("wraps fetch rejection as a network TelegramError and does not crash", async () => {
    const fetchFn: FetchLike = async () => {
      throw new Error("socket hang up");
    };
    const client = new HttpTelegramClient({ botToken: TOKEN, fetchFn, retries: 1, baseBackoffMs: 1 });
    const err = await client.sendMessage({ chatId: 1, text: "hi" }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TelegramError);
    expect((err as TelegramError).kind).toBe("network");
  });
});

describe("HttpTelegramClient setMyCommands", () => {
  it("posts JSON-encoded commands and the nested scope in the form body", async () => {
    const { fetchFn, calls } = mockFetch([{ status: 200, body: { ok: true, result: true } }]);
    const client = new HttpTelegramClient({ botToken: TOKEN, fetchFn, retries: 3, baseBackoffMs: 1 });

    await client.setMyCommands({
      commands: [
        { command: "start", description: "Begin chatting with support" },
        { command: "help", description: "Show help" },
      ],
      scope: { type: "chat", chat_id: -100123 },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/setMyCommands");
    const form = formOf(calls[0]!.init);
    const commands = JSON.parse(form.get("commands")!) as Array<{ command: string }>;
    expect(commands.map((c) => c.command)).toEqual(["start", "help"]);
    const scope = JSON.parse(form.get("scope")!) as { type: string; chat_id: number };
    expect(scope).toEqual({ type: "chat", chat_id: -100123 });
    expect(form.has("language_code")).toBe(false);
  });

  it("serializes an optional language_code for localized menus", async () => {
    const { fetchFn, calls } = mockFetch([{ status: 200, body: { ok: true, result: true } }]);
    const client = new HttpTelegramClient({ botToken: TOKEN, fetchFn, retries: 3, baseBackoffMs: 1 });

    await client.setMyCommands({
      commands: [{ command: "start", description: "与客服开始聊天" }],
      languageCode: "zh",
    });

    expect(calls).toHaveLength(1);
    const form = formOf(calls[0]!.init);
    expect(form.get("language_code")).toBe("zh");
    expect(form.has("scope")).toBe(false);
  });

  it("omits the scope when not provided", async () => {
    const { fetchFn, calls } = mockFetch([{ status: 200, body: { ok: true, result: true } }]);
    const client = new HttpTelegramClient({ botToken: TOKEN, fetchFn, retries: 3, baseBackoffMs: 1 });

    await client.setMyCommands({ commands: [] });

    expect(calls).toHaveLength(1);
    expect(formOf(calls[0]!.init).has("scope")).toBe(false);
    expect(formOf(calls[0]!.init).get("commands")).toBe("[]");
  });
});

describe("HttpTelegramClient getUserProfilePhoto", () => {
  it("posts user_id and limit, and returns the largest size of the most recent photo", async () => {
    const { fetchFn, calls } = mockFetch([
      {
        status: 200,
        body: {
          ok: true,
          result: {
            total_count: 1,
            photos: [
              [
                { file_id: "small", width: 160, height: 160 },
                { file_id: "avatar-largest", width: 640, height: 640 },
              ],
            ],
          },
        },
      },
    ]);
    const client = new HttpTelegramClient({ botToken: TOKEN, fetchFn, retries: 0, baseBackoffMs: 1 });

    const fileId = await client.getUserProfilePhoto({ userId: 42 });

    expect(fileId).toBe("avatar-largest");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/getUserProfilePhotos");
    const form = formOf(calls[0]!.init);
    expect(form.get("user_id")).toBe("42");
    expect(form.get("limit")).toBe("1");
  });

  it("returns null when the user has no profile photo", async () => {
    const { fetchFn, calls } = mockFetch([{ status: 200, body: { ok: true, result: { total_count: 0, photos: [] } } }]);
    const client = new HttpTelegramClient({ botToken: TOKEN, fetchFn, retries: 0, baseBackoffMs: 1 });

    const fileId = await client.getUserProfilePhoto({ userId: 7 });

    expect(fileId).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe("HttpTelegramClient sendMediaGroup", () => {
  it("posts a media array and returns the message ids in order", async () => {
    const { fetchFn, calls } = mockFetch([
      { status: 200, body: { ok: true, result: [{ message_id: 11 }, { message_id: 12 }] } },
    ]);
    const client = new HttpTelegramClient({ botToken: TOKEN, fetchFn, retries: 0, baseBackoffMs: 1 });

    const ids = await client.sendMediaGroup({
      chatId: -100,
      messageThreadId: 42,
      items: [
        { type: "photo", fileId: "f1", caption: "first" },
        { type: "video", fileId: "f2" },
      ],
    });

    expect(ids).toEqual([11, 12]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/sendMediaGroup");
    const form = formOf(calls[0]!.init);
    expect(form.get("chat_id")).toBe("-100");
    expect(form.get("message_thread_id")).toBe("42");
    const media = JSON.parse(form.get("media")!) as Array<Record<string, unknown>>;
    expect(media).toEqual([
      { type: "photo", media: "f1", caption: "first" },
      { type: "video", media: "f2" },
    ]);
  });

  it("drops captions beyond the first item (Bot API restriction)", async () => {
    const { fetchFn, calls } = mockFetch([
      { status: 200, body: { ok: true, result: [{ message_id: 1 }, { message_id: 2 }] } },
    ]);
    const client = new HttpTelegramClient({ botToken: TOKEN, fetchFn, retries: 0, baseBackoffMs: 1 });

    await client.sendMediaGroup({
      chatId: -100,
      items: [
        { type: "photo", fileId: "f1", caption: "first" },
        { type: "photo", fileId: "f2", caption: "second" },
      ],
    });

    const media = JSON.parse(formOf(calls[0]!.init).get("media")!) as Array<Record<string, unknown>>;
    expect(media[0]).toEqual({ type: "photo", media: "f1", caption: "first" });
    expect(media[1]).toEqual({ type: "photo", media: "f2" });
  });

  it("omits message_thread_id when no topic is targeted", async () => {
    const { fetchFn, calls } = mockFetch([
      { status: 200, body: { ok: true, result: [{ message_id: 1 }] } },
    ]);
    const client = new HttpTelegramClient({ botToken: TOKEN, fetchFn, retries: 0, baseBackoffMs: 1 });

    await client.sendMediaGroup({ chatId: -100, items: [{ type: "photo", fileId: "f1" }] });

    expect(formOf(calls[0]!.init).has("message_thread_id")).toBe(false);
  });
});

describe("HttpTelegramClient self-check reads", () => {
  it("getMe returns the bot identity", async () => {
    const { fetchFn, calls } = mockFetch([
      { status: 200, body: { ok: true, result: { id: 1, username: "relay_bot", first_name: "Relay" } } },
    ]);
    const client = new HttpTelegramClient({ botToken: TOKEN, fetchFn, retries: 0, baseBackoffMs: 1 });

    const me = await client.getMe();
    expect(me).toEqual({ id: 1, username: "relay_bot", first_name: "Relay" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/getMe");
  });

  it("getChat posts chat_id and returns the forum flag", async () => {
    const { fetchFn, calls } = mockFetch([
      { status: 200, body: { ok: true, result: { id: -100, type: "supergroup", is_forum: true, title: "Support" } } },
    ]);
    const client = new HttpTelegramClient({ botToken: TOKEN, fetchFn, retries: 0, baseBackoffMs: 1 });

    const chat = await client.getChat({ chatId: -100 });
    expect(chat).toMatchObject({ id: -100, type: "supergroup", is_forum: true, title: "Support" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/getChat");
    expect(formOf(calls[0]!.init).get("chat_id")).toBe("-100");
  });

  it("getChatMember posts chat_id and user_id", async () => {
    const { fetchFn, calls } = mockFetch([
      { status: 200, body: { ok: true, result: { status: "administrator" } } },
    ]);
    const client = new HttpTelegramClient({ botToken: TOKEN, fetchFn, retries: 0, baseBackoffMs: 1 });

    const member = await client.getChatMember({ chatId: -100, userId: 42 });
    expect(member.status).toBe("administrator");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("/getChatMember");
    const form = formOf(calls[0]!.init);
    expect(form.get("chat_id")).toBe("-100");
    expect(form.get("user_id")).toBe("42");
  });
});
