// ---------------------------------------------------------------------------
// Docker runtime tests (tasks 11.1, 11.3). Full-fidelity wiring: real
// node:sqlite (:memory:), real migration-on-boot, real service graph — only
// the Telegram client is the fake, so every outbound side effect is recorded.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { FakeTelegramClient } from "@relaytg/core/testing";
import type { AppDeps, RelayApp } from "./app.ts";
import { createApp, createHttpServer } from "./app.ts";

const TEST_ENV = {
  BOTS: "main:test-token-not-a-secret",
  GROUP_ID: "-1001234567890",
};

const apps: RelayApp[] = [];
const servers: Server[] = [];

function makeEnv(overrides: Record<string, string> = {}): typeof TEST_ENV & Record<string, string> {
  return { ...TEST_ENV, ...overrides };
}

async function makeApp(
  env: ReturnType<typeof makeEnv> = makeEnv(),
): Promise<{ app: RelayApp; telegram: FakeTelegramClient }> {
  const telegram = new FakeTelegramClient();
  const app = await createApp({ env, databasePath: ":memory:", telegram } satisfies AppDeps);
  apps.push(app);
  return { app, telegram };
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

async function startServer(app: RelayApp): Promise<{ baseUrl: string }> {
  const server = createHttpServer(app);
  servers.push(server);
  const port = await listen(server);
  return { baseUrl: `http://127.0.0.1:${port}` };
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const app of apps.splice(0)) {
    await app.close();
  }
});

describe("docker runtime HTTP surface (11.1)", () => {
  it('GET /health returns 200 {"status":"ok"}', async () => {
    const { app } = await makeApp();
    const { baseUrl } = await startServer(app);

    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: "ok" });
  });

  it("posts a user update and the relay pipeline processes it", async () => {
    const { app, telegram } = await makeApp();
    const { baseUrl } = await startServer(app);

    const update = {
      update_id: 1001,
      message: {
        message_id: 501,
        from: { id: 90001, is_bot: false, first_name: "Newbie" },
        chat: { id: 90001, type: "private" },
        text: "hi",
      },
    };

    const res = await fetch(`${baseUrl}/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; status: string };
    expect(body.ok).toBe(true);
    // Unverified user -> arithmetic question with four choice buttons, no conversation.
    expect(body.status).toBe("verification_issued");

    const sends = telegram.callsOf("sendMessage");
    expect(sends.length).toBe(1);
    expect(sends[0].target.chatId).toBe(90001);
    expect(sends[0].replyMarkup?.buttons.length).toBe(4);
    // Task 7.4: the verification gate creates zero database rows.
    expect(await app.services.users.getByTelegramUserId(90001)).toBeNull();
    expect(await app.services.conversations.getByTelegramUserId(90001)).toBeNull();
  });

  it("returns the processed status for an already-claimed update (duplicate)", async () => {
    const { app } = await makeApp();
    const { baseUrl } = await startServer(app);

    const update = {
      update_id: 2002,
      message: {
        message_id: 601,
        from: { id: 90002, is_bot: false, first_name: "Dup" },
        chat: { id: 90002, type: "private" },
        text: "hello",
      },
    };
    const post = (): Promise<Response> =>
      fetch(`${baseUrl}/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(update),
      });

    const first = await post();
    expect(first.status).toBe(200);
    const second = await post();
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ ok: true, status: "duplicate" });
  });

  it("rejects non-JSON webhook bodies with 400", async () => {
    const { app } = await makeApp();
    const { baseUrl } = await startServer(app);

    const res = await fetch(`${baseUrl}/webhook`, { method: "POST", body: "not json" });
    expect(res.status).toBe(400);
  });

  it("rejects oversized webhook bodies with 413", async () => {
    const { app } = await makeApp();
    const { baseUrl } = await startServer(app);

    const res = await fetch(`${baseUrl}/webhook`, { method: "POST", body: "x".repeat(1024 * 1024 + 1) });
    expect(res.status).toBe(413);
  });

  it("404s unknown routes", async () => {
    const { app } = await makeApp();
    const { baseUrl } = await startServer(app);

    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
  });
});

describe("docker runtime multi-bot webhook routing", () => {
  it("routes POST /webhook/<botId> to that bot's client (not the primary's)", async () => {
    const telegram = new FakeTelegramClient();
    const second = new FakeTelegramClient();
    const app = await createApp({
      env: makeEnv({ BOTS: "main:test-token-not-a-secret,second:other-token" }),
      databasePath: ":memory:",
      telegram,
      bots: [{ botId: "second", client: second }],
    } satisfies AppDeps);
    apps.push(app);
    const { baseUrl } = await startServer(app);

    const update = {
      update_id: 4001,
      message: {
        message_id: 801,
        from: { id: 91001, is_bot: false, first_name: "Bob" },
        chat: { id: 91001, type: "private" },
        text: "hello",
      },
    };
    const res = await fetch(`${baseUrl}/webhook/second`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(update),
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, status: "verification_issued" });

    // The four-choice challenge goes out through the second bot's client;
    // the primary client must not see it.
    expect(second.callsOf("sendMessage").length).toBe(1);
    expect(telegram.callsOf("sendMessage").length).toBe(0);
  });

  it("404s POST /webhook/<unknown bot>", async () => {
    const { app } = await makeApp();
    const { baseUrl } = await startServer(app);

    const res = await fetch(`${baseUrl}/webhook/nope`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ ok: false, error: "unknown_bot" });
  });
});

describe("docker runtime persistence (11.2)", () => {
  it("survives a full app restart on a file-backed database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relaytg-"));
    const dbPath = join(dir, "relaytg.db");
    const env = makeEnv({ DATABASE_PATH: dbPath });
    const telegram1 = new FakeTelegramClient();

    const app1 = await createApp({ env, databasePath: dbPath, telegram: telegram1 } satisfies AppDeps);
    const { user } = await app1.services.users.getOrCreate({
      telegramUserId: 3001,
      username: "persist",
      firstName: "Persister",
      lastName: null,
      languageCode: "en",
      isBot: false,
    });
    const { conversation } = await app1.services.conversations.ensureForUser(user, app1.bots.primary());
    await app1.close();

    // Second boot: same file, fresh graph. Data must still be there.
    const telegram2 = new FakeTelegramClient();
    const app2 = await createApp({ env, databasePath: dbPath, telegram: telegram2 } satisfies AppDeps);
    const loadedUser = await app2.services.users.getByTelegramUserId(3001);
    const loadedConv = await app2.services.conversations.getByTelegramUserId(3001);
    expect(loadedUser?.username).toBe("persist");
    expect(loadedConv?.id).toBe(conversation.id);
    expect(loadedConv?.telegramTopicId).toBe(conversation.telegramTopicId);
    await app2.close();

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("docker runtime hide sweep (11.3)", () => {
  it("hides a conversation past the 7-day hard cap and skips a permanent-policy one under it", async () => {
    const { app, telegram } = await makeApp();
    const now = new Date("2024-05-01T12:00:00Z");
    const stale = new Date(now.getTime() - 200 * 3600 * 1000);
    const moderate = new Date(now.getTime() - 100 * 3600 * 1000);
    const recent = new Date(now.getTime() - 3600 * 1000);

    // Conversation A: past the 7-day auto-hide cap, default policy -> should hide.
    const { user: userA } = await app.services.users.getOrCreate({
      telegramUserId: 1001,
      username: "alice",
      firstName: "Alice",
      lastName: null,
      languageCode: "en",
      isBot: false,
    });
    const { conversation: convA } = await app.services.conversations.ensureForUser(userA, app.bots.primary());
    await app.db.conversations.touchActivity(convA.id, stale);

    // Conversation B: permanent policy (never-hide) and still under the 7-day cap -> skipped.
    const { user: userB } = await app.services.users.getOrCreate({
      telegramUserId: 1002,
      username: "bob",
      firstName: "Bob",
      lastName: null,
      languageCode: "en",
      isBot: false,
    });
    const { conversation: convB } = await app.services.conversations.ensureForUser(userB, app.bots.primary());
    await app.db.conversations.setHideAfterHours(convB.id, 0);
    await app.db.conversations.touchActivity(convB.id, moderate);

    // Conversation C: recently active, default (permanent) policy -> must be skipped.
    const { user: userC } = await app.services.users.getOrCreate({
      telegramUserId: 1003,
      username: "carol",
      firstName: "Carol",
      lastName: null,
      languageCode: "en",
      isBot: false,
    });
    const { conversation: convC } = await app.services.conversations.ensureForUser(userC, app.bots.primary());
    await app.db.conversations.touchActivity(convC.id, recent);

    const hidden = await app.sweepHidden(now);
    expect(hidden).toBe(1);

    const afterA = await app.db.conversations.getById(convA.id);
    const afterB = await app.db.conversations.getById(convB.id);
    const afterC = await app.db.conversations.getById(convC.id);
    expect(afterA?.hiddenAt).toBe(now.toISOString());
    expect(afterB?.hiddenAt).toBeNull();
    expect(afterC?.hiddenAt).toBeNull();

    const hiddenCalls = telegram.callsOf("hideForumTopic");
    expect(hiddenCalls.length).toBe(1);
    expect(hiddenCalls[0].target.messageThreadId).toBe(convA.telegramTopicId);
  });

  it("is idempotent: a second sweep hides nothing new", async () => {
    const { app } = await makeApp();
    const now = new Date("2024-05-01T12:00:00Z");
    const stale = new Date(now.getTime() - 200 * 3600 * 1000);

    const { user } = await app.services.users.getOrCreate({
      telegramUserId: 2001,
      username: "dave",
      firstName: "Dave",
      lastName: null,
      languageCode: "en",
      isBot: false,
    });
    const { conversation } = await app.services.conversations.ensureForUser(user, app.bots.primary());
    await app.db.conversations.touchActivity(conversation.id, stale);

    expect(await app.sweepHidden(now)).toBe(1);
    expect(await app.sweepHidden(now)).toBe(0);
  });
});