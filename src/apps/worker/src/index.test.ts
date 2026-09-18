// ---------------------------------------------------------------------------
// Cloudflare runtime tests (tasks 12.1, 12.2, 12.3). Drives the real
// ConversationDO class over a fake sql handle (node:sqlite shaped like the DO
// SqlStorage API) with the real embedded migrations and the fake Telegram
// client, so every outbound side effect is recorded. The alarm() signature
// accepts an optional `now` reference time for determinism (the runtime calls
// it with no arguments).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { FakeTelegramClient } from "@relaytg/core/testing";
import type { Relay } from "./relay.ts";
import { MIGRATIONS } from "./migrations.ts";
import type { SqlValue } from "@relaytg/adapter-sqlite/sql-db";
import type { DurableObjectCursor, DurableObjectSqlHandle } from "@relaytg/adapter-cloudflare-do";
import { ConversationDO, type Env } from "./conversation-do.ts";
import { default as workerFetch } from "./index.ts";

const GROUP_ID = "-1001234567890";

function configEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    BOTS: "main:test-token-not-a-secret",
    GROUP_ID,
    AUTO_HIDE_HOURS: "168",
    ...overrides,
  };
}

/** In-memory fake standing in for ctx.storage.sql (the DO API shape). */
class FakeDoSqlHandle implements DurableObjectSqlHandle {
  private readonly inner = new DatabaseSync(":memory:");

  exec(query: string, ...bindings: SqlValue[]): DurableObjectCursor {
    // Migration/schema exec can be multi-statement DDL (with leading SQL
    // comments); route those to DatabaseSync.exec (multi-statement-aware).
    const stripped = query.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const isDdl = /^\s*(CREATE|ALTER|DROP|BEGIN|COMMIT)\b/i.test(stripped);
    if (isDdl) {
      this.inner.exec(query);
      return { toArray: () => [], rowsWritten: 0 };
    }
    const stmt = this.inner.prepare(query);
    // data-returning statements vs. writes (the repository never uses RETURNING).
    const returnsRows = /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(stripped);
    if (returnsRows) {
      const rows = stmt.all(...bindings) as Array<Record<string, SqlValue>>;
      return { toArray: () => rows, rowsWritten: rows.length };
    }
    const result = stmt.run(...bindings);
    return { toArray: () => [], rowsWritten: Number(result.changes) };
  }
}

/** Minimal DurableObjectState stand-in: sqlite storage + alarm recording. */
class FakeDoState {
  alarms: number[] = [];
  readonly storage: {
    sql: FakeDoSqlHandle;
    setAlarm: (ms: number) => Promise<void>;
    getAlarm: () => Promise<number | null>;
  };

  constructor(sql: FakeDoSqlHandle) {
    this.storage = {
      sql,
      setAlarm: (ms: number) => {
        this.alarms.push(ms);
        return Promise.resolve();
      },
      getAlarm: () => Promise.resolve(this.alarms.length > 0 ? this.alarms[this.alarms.length - 1] : null),
    };
  }
}

function makeEnv(env: Record<string, string>, namespace?: object): Env {
  return { ...env, CONVERSATION: namespace ?? {} } as unknown as Env;
}

function profile(telegramUserId: number, overrides: Partial<{ username: string; firstName: string; isBot: boolean }> = {}) {
  return {
    telegramUserId,
    username: overrides.username ?? `user${telegramUserId}`,
    firstName: overrides.firstName ?? `User ${telegramUserId}`,
    lastName: null,
    languageCode: "en",
    isBot: overrides.isBot ?? false,
  };
}

function userUpdate(updateId: number, messageId: number, telegramUserId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      from: { id: telegramUserId, is_bot: false, first_name: `User ${telegramUserId}` },
      chat: { id: telegramUserId, type: "private" },
      text,
    },
  };
}

function post(doInstance: ConversationDO, url = "https://relaytg.example/webhook", body: unknown): Promise<Response> {
  return doInstance.fetch(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

describe("ConversationDO (12.1, 12.2, 12.3)", () => {
  it("arms the self-scheduled hide sweep on construction", async () => {
    const state = new FakeDoState(new FakeDoSqlHandle());
    void new ConversationDO(state as unknown as DurableObjectState, makeEnv(configEnv()));
    // The constructor arms via an async getAlarm → setAlarm chain.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.alarms.length).toBe(1);
    expect(state.alarms[0]).toBeGreaterThan(Date.now());
  });

  it("does not re-arm the sweep when an alarm is already pending (cold start), preserving the existing cadence", async () => {
    const state = new FakeDoState(new FakeDoSqlHandle());
    await state.storage.setAlarm(1234);
    void new ConversationDO(state as unknown as DurableObjectState, makeEnv(configEnv()));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.alarms).toEqual([1234]);
  });

  it("GET /health returns 200 {\"status\":\"ok\"} without touching storage", async () => {
    const state = new FakeDoState(new FakeDoSqlHandle());
    const doInstance = new ConversationDO(state as unknown as DurableObjectState, makeEnv(configEnv()));
    const res = await doInstance.fetch(new Request("https://relaytg.example/health"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
  });

  it("rejects non-JSON webhook bodies with 400", async () => {
    const state = new FakeDoState(new FakeDoSqlHandle());
    const doInstance = new ConversationDO(state as unknown as DurableObjectState, makeEnv(configEnv()));
    const res = await post(doInstance, "https://relaytg.example/webhook", "not json");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ ok: false, error: "bad_request" });
  });

  it("404s methods other than POST and GET /health", async () => {
    const state = new FakeDoState(new FakeDoSqlHandle());
    const doInstance = new ConversationDO(state as unknown as DurableObjectState, makeEnv(configEnv()));
    const res = await doInstance.fetch(new Request("https://relaytg.example/webhook"));
    expect(res.status).toBe(404);
  });

  it("12.2 issues a four-choice verification for an unverified user (zero rows)", async () => {
    const telegram = new FakeTelegramClient();
    const state = new FakeDoState(new FakeDoSqlHandle());
    const doInstance = new ConversationDO(state as unknown as DurableObjectState, makeEnv(configEnv()), {
      telegram,
    });

    const res = await post(doInstance, "https://relaytg.example/webhook", userUpdate(1001, 501, 90001, "hi"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, status: "verification_issued" });

    const sends = telegram.callsOf("sendMessage");
    expect(sends.length).toBe(1);
    expect(sends[0].target.chatId).toBe(90001);
    expect(sends[0].replyMarkup?.buttons.length).toBe(4);

    const relay = await (doInstance as unknown as { relay(): Promise<Relay> }).relay();
    expect(await relay.db.users.getByTelegramUserId(90001)).toBeNull();
    expect(await relay.db.conversations.getByTelegramUserId(90001)).toBeNull();
  });

  it("12.2 relays a verified user's message into their topic", async () => {
    const telegram = new FakeTelegramClient();
    const state = new FakeDoState(new FakeDoSqlHandle());
    const doInstance = new ConversationDO(state as unknown as DurableObjectState, makeEnv(configEnv()), {
      telegram,
    });

    // Seed the "fake-verified" user with an open topic, then drive a real update
    // through the DO fetch.
    const relay = await (doInstance as unknown as { relay(): Promise<Relay> }).relay();
    await relay.services.users.getOrCreate(profile(42));
    await relay.services.users.markVerified(42, relay.bots.primary());
    // The first-contact purpose gate runs before any topic exists: a stated
    // purpose means the message below relays instead of being consumed as one.
    await relay.services.users.setPurpose(42, "test purpose");
    const conversation = await relay.services.conversations.grantAccess((await relay.services.users.getByTelegramUserId(42))!, relay.bots.primary());
    expect(conversation.telegramTopicId).not.toBeNull();

    const res = await post(doInstance, "https://relaytg.example/webhook", userUpdate(2002, 601, 42, "hello support"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, status: "processed" });

    // The user's message is forwarded verbatim into their topic.
    const topicForwards = telegram
      .callsOf("forwardMessage")
      .filter((c) => c.target.messageThreadId === conversation.telegramTopicId);
    expect(topicForwards.length).toBe(1);
    expect(topicForwards[0].payload.fromChatId).toBe(42);
    expect(topicForwards[0].payload.messageId).toBe(601);

    // The topic's first message is the user-info card (text card for a sender
    // without a profile photo) with a tap-through identity button — a pure info
    // display, never pinned.
    const card = telegram.callsOf("sendMessage").find((c) => c.target.messageThreadId === conversation.telegramTopicId)!;
    expect(card.payload.text).toBe("👤 User 42\n@user42\n🆔 42");
    expect(card.replyMarkup?.buttons[0]).toMatchObject({ url: "tg://user?id=42" });

    const recorded = await relay.db.messages.getBySource(42, 601);
    expect(recorded?.conversationId).toBe(conversation.id);
    expect(recorded?.relayedMessageId).toBe(topicForwards[0].id);
  });

  it("12.3 the alarm sweep hides a stale conversation, skips hide_after_hours=0, and re-arms", async () => {
    const telegram = new FakeTelegramClient();
    const state = new FakeDoState(new FakeDoSqlHandle());
    const doInstance = new ConversationDO(state as unknown as DurableObjectState, makeEnv(configEnv()), {
      telegram,
    });

    const now = new Date("2024-05-01T12:00:00Z");
    const stale = new Date(now.getTime() - 200 * 3600 * 1000);
    const moderate = new Date(now.getTime() - 100 * 3600 * 1000);

    const relay = await (doInstance as unknown as { relay(): Promise<Relay> }).relay();
    const { user: userA } = await relay.services.users.getOrCreate(profile(1001));
    await relay.services.users.markVerified(1001, relay.bots.primary());
    const convA = await relay.services.conversations.grantAccess(userA, relay.bots.primary());
    await relay.db.conversations.touchActivity(convA.id, stale);

    const { user: userB } = await relay.services.users.getOrCreate(profile(1002));
    await relay.services.users.markVerified(1002, relay.bots.primary());
    const convB = await relay.services.conversations.grantAccess(userB, relay.bots.primary());
    await relay.db.conversations.setHideAfterHours(convB.id, 0);
    // Permanent policy and still under the 7-day cap → skipped.
    await relay.db.conversations.touchActivity(convB.id, moderate);

    await doInstance.alarm(now);

    expect((await relay.db.conversations.getById(convA.id))?.hiddenAt).toBe(now.toISOString());
    expect((await relay.db.conversations.getById(convB.id))?.hiddenAt).toBeNull();

    const hiddenCalls = telegram.callsOf("hideForumTopic");
    expect(hiddenCalls.length).toBe(1);
    expect(hiddenCalls[0].target.messageThreadId).toBe(convA.telegramTopicId);

    // Re-armed one hour out.
    expect(state.alarms.length).toBe(2);
    expect(state.alarms[1]).toBeGreaterThan(Date.now());
  });

  it("routes POST /webhook/<botId> to that bot's client (not the primary's)", async () => {
    const telegram = new FakeTelegramClient();
    const second = new FakeTelegramClient();
    const state = new FakeDoState(new FakeDoSqlHandle());
    const doInstance = new ConversationDO(
      state as unknown as DurableObjectState,
      makeEnv(configEnv({ BOTS: "main:test-token-not-a-secret,second:other-token" })),
      { telegram, bots: [{ botId: "second", client: second }] },
    );

    const res = await post(doInstance, "https://relaytg.example/webhook/second", userUpdate(5001, 901, 92001, "hi"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, status: "verification_issued" });

    // The challenge goes out through the second bot's client; the primary
    // client must not see it.
    expect(second.callsOf("sendMessage").length).toBe(1);
    expect(telegram.callsOf("sendMessage").length).toBe(0);
  });

  it("404s POST /webhook/<unknown bot>", async () => {
    const state = new FakeDoState(new FakeDoSqlHandle());
    const doInstance = new ConversationDO(state as unknown as DurableObjectState, makeEnv(configEnv()));

    const res = await post(doInstance, "https://relaytg.example/webhook/nope", userUpdate(5002, 902, 92002, "hi"));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ ok: false, error: "unknown_bot" });
  });
});

describe("embedded migrations", () => {
  it("matches the on-disk migrations/*.sql so the two cannot drift", () => {
    const files = ["001_initial.sql", "002_preferred_language.sql", "003_purpose.sql", "004_multi_bot.sql", "005_per_bot_verification.sql"];
    expect(MIGRATIONS).toHaveLength(files.length);
    for (const file of files) {
      const fromDisk = readFileSync(new URL(`../../../migrations/${file}`, import.meta.url), "utf8");
      const migration = MIGRATIONS.find((m) => `${m.version}.sql` === file);
      expect(migration).toBeDefined();
      expect(migration!.sql).toBe(fromDisk);
    }
  });
});

describe("worker default export (12.1)", () => {
  function fakeNamespace(handler: (request: Request) => Promise<Response>) {
    return {
      idFromName: () => ({ toString: () => "primary" }),
      get: () => ({ fetch: handler }),
    } as unknown as DurableObjectNamespace;
  }

  it("short-circuits GET /health without forwarding to the DO", async () => {
    let forwarded = 0;
    const env = makeEnv(configEnv(), fakeNamespace(async () => {
      forwarded += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }));

    const res = await workerFetch.fetch(new Request("https://relaytg.example/health"), env as Env);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
    expect(forwarded).toBe(0);
  });

  it("forwards webhook updates into the DO stub", async () => {
    let forwarded: Request | null = null;
    const env = makeEnv(configEnv(), fakeNamespace(async (request) => {
      forwarded = request;
      return new Response(JSON.stringify({ ok: true, status: "processed" }), { status: 200 });
    }));

    const body = JSON.stringify(userUpdate(3003, 701, 77, "ping"));
    const res = await workerFetch.fetch(
      new Request("https://relaytg.example/webhook", { method: "POST", body }),
      env as Env,
    );
    expect(res.status).toBe(200);
    expect(forwarded).not.toBeNull();
    expect(forwarded!.method).toBe("POST");
    await expect(forwarded!.text()).resolves.toBe(body);
  });
});
