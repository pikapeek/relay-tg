// ---------------------------------------------------------------------------
// Shared storage integration suite (tasks 10.2-10.4).
//
// Runs the same migration-runner tests and the same every-repository-method
// tests against any SqlDb binding: the Docker path (node:sqlite, in
// sqlite/src/*.test.ts) and the Cloudflare DO path (a fake sql handle, in
// cloudflare-do/src/*.test.ts). Each test gets a fresh migrated database.
// ---------------------------------------------------------------------------

import { describe, expect, it, beforeEach } from "vitest";
import type { Database } from "@relaytg/core";
import type { UserProfile } from "@relaytg/shared";
import type { SqlDb } from "./sql-db.ts";
import type { Migration } from "./migrate.ts";
import { applyMigrations, currentSchemaVersion } from "./migrate.ts";
import { SqliteDatabase } from "./repository.ts";

const NOW = new Date("2026-01-01T00:00:00.000Z");
const HOUR = 3_600_000;

function profile(id: number): UserProfile {
  return {
    telegramUserId: id,
    username: `user${id}`,
    firstName: `First${id}`,
    lastName: null,
    languageCode: "en",
    isBot: false,
  };
}

export function storageSuite(label: string, makeDb: () => Promise<SqlDb>, migrations: Migration[]): void {
  describe(`storage suite: ${label}`, () => {
    describe("migration runner", () => {
      let sql: SqlDb;

      beforeEach(async () => {
        sql = await makeDb();
      });

      it("applies every pending migration on a fresh database, in version order", async () => {
        const applied = await applyMigrations(sql, migrations);
        expect(applied).toEqual(migrations.map((m) => m.version).sort());
        expect(currentSchemaVersion(sql)).toBe([...migrations].sort((a, b) => a.version.localeCompare(b.version)).at(-1)?.version);

        // The nine required tables now exist.
        const tables = sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => String(r.name));
        for (const expected of [
          "users",
          "conversations",
          "messages",
          "operators",
          "conversation_notes",
          "blocks",
          "applications",
          "processed_updates",
          "settings",
        ]) {
          expect(tables).toContain(expected);
        }
      });

      it("re-applying an up-to-date database is a no-op", async () => {
        await applyMigrations(sql, migrations);
        const applied = await applyMigrations(sql, migrations);
        expect(applied).toEqual([]);
      });

      it("applies only pending migrations on an older database", async () => {
        await applyMigrations(sql, migrations);
        const extra: Migration = { version: "002_test", sql: "CREATE TABLE extra_rows (id INTEGER PRIMARY KEY);" };
        const applied = await applyMigrations(sql, [extra, ...migrations]);
        expect(applied).toEqual(["002_test"]);
        const tables = sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => String(r.name));
        expect(tables).toContain("extra_rows");
      });

      it("restart preserves data (new facade over the same database)", async () => {
        await applyMigrations(sql, migrations);
        const first = new SqliteDatabase(sql);
        await first.users.upsertProfile(profile(1), NOW);

        // Fresh facade over the same storage = process restart.
        const second = new SqliteDatabase(sql);
        const user = await second.users.getByTelegramUserId(1);
        expect(user?.firstName).toBe("First1");
        expect(await applyMigrations(sql, migrations)).toEqual([]);
      });
    });

    describe("repositories", () => {
      let sql: SqlDb;
      let db: Database;

      beforeEach(async () => {
        sql = await makeDb();
        await applyMigrations(sql, migrations);
        db = new SqliteDatabase(sql);
      });

      it("users: get-or-create, profile refresh, fallbacks, flags, username lookup", async () => {
        expect(await db.users.getByTelegramUserId(1)).toBeNull();

        const created = await db.users.upsertProfile(profile(1), NOW);
        expect(created.created).toBe(true);
        expect(created.user.telegramUserId).toBe(1);
        expect(await db.users.getVerifiedAt("primary", 1)).toBeNull();
        expect(created.user.approvedAt).toBeNull();
        expect(created.user.isBot).toBe(false);

        const refreshed = await db.users.upsertProfile(
          { ...profile(1), firstName: "Renamed", username: "newname" },
          new Date("2026-01-02T00:00:00.000Z"),
        );
        expect(refreshed.created).toBe(false);
        expect(refreshed.user.firstName).toBe("Renamed");
        expect(refreshed.user.username).toBe("newname");

        // first_name falls back to username, then to the numeric id.
        const fallback = await db.users.upsertProfile({ ...profile(2), firstName: null, username: "abc" }, NOW);
        expect(fallback.user.firstName).toBe("abc");
        const numeric = await db.users.upsertProfile({ ...profile(3), firstName: null, username: null }, NOW);
        expect(numeric.user.firstName).toBe("3");

        expect((await db.users.getByUsername("newname"))?.telegramUserId).toBe(1);

        // preferred_language starts NULL, is settable, survives a profile
        // refresh, and clears back to NULL.
        expect((await db.users.getByTelegramUserId(1))?.preferredLanguage).toBeNull();
        await db.users.setPreferredLanguage(1, "zh", NOW);
        expect((await db.users.getByTelegramUserId(1))?.preferredLanguage).toBe("zh");
        await db.users.upsertProfile({ ...profile(1), firstName: "RenamedAgain" }, NOW);
        expect((await db.users.getByTelegramUserId(1))?.preferredLanguage).toBe("zh");
        await db.users.setPreferredLanguage(1, null, NOW);
        expect((await db.users.getByTelegramUserId(1))?.preferredLanguage).toBeNull();

        await db.users.setVerifiedAt("primary", 1, NOW);
        expect(await db.users.getVerifiedAt("primary", 1)).toBe(NOW.toISOString());
        // Verification is per (bot, user): the record on another bot is
        // independent, and clearVerified removes only the named bot's mark.
        expect(await db.users.getVerifiedAt("other", 1)).toBeNull();
        await db.users.setVerifiedAt("other", 1, NOW);
        await db.users.clearVerified("primary", 1);
        expect(await db.users.getVerifiedAt("primary", 1)).toBeNull();
        expect(await db.users.getVerifiedAt("other", 1)).toBe(NOW.toISOString());
        await db.users.clearVerified("other", 1);
        await db.users.setVerifiedAt("primary", 1, NOW);
        await db.users.setApprovedAt(1, NOW);
        expect((await db.users.getByTelegramUserId(1))?.approvedAt).toBe(NOW.toISOString());

        // purpose starts NULL, is settable, survives a profile refresh, and the
        // access reset clears approved_at AND the purpose so the next
        // conversation re-asks for a fresh one. The per-(bot,user) verification
        // mark is NOT part of resetAccess — clearVerified() owns it — so it
        // survives a reset untouched.
        expect((await db.users.getByTelegramUserId(1))?.purpose).toBeNull();
        await db.users.setPurpose(1, "refund help", NOW);
        expect((await db.users.getByTelegramUserId(1))?.purpose).toBe("refund help");
        expect((await db.users.getByTelegramUserId(1))?.purposeAt).toBe(NOW.toISOString());
        await db.users.upsertProfile({ ...profile(1), firstName: "RenamedAgain" }, NOW);
        expect((await db.users.getByTelegramUserId(1))?.purpose).toBe("refund help");
        await db.users.resetAccess(1);
        const reset = await db.users.getByTelegramUserId(1);
        expect(await db.users.getVerifiedAt("primary", 1)).toBe(NOW.toISOString());
        expect(reset?.approvedAt).toBeNull();
        expect(reset?.purpose).toBeNull();
        expect(reset?.purposeAt).toBeNull();
        await db.users.clearVerified("primary", 1);
        expect(await db.users.getVerifiedAt("primary", 1)).toBeNull();
      });

      it("conversations: create, lookups, topic/assignment/activity/hide updates, delete", async () => {
        await db.users.upsertProfile(profile(1), NOW);
        const row = await db.conversations.create({ botId: "primary", telegramUserId: 1, telegramTopicId: 42, assignedOperatorId: null }, NOW);
        expect(row.telegramTopicId).toBe(42);
        expect(row.hiddenAt).toBeNull();
        expect(row.hideAfterHours).toBeNull();
        expect(row.lastActivityAt).toBe(NOW.toISOString());

        expect((await db.conversations.getById(row.id))?.id).toBe(row.id);
        expect((await db.conversations.getByTelegramUserId(1))?.id).toBe(row.id);
        expect((await db.conversations.getByTopicId(42))?.id).toBe(row.id);

        await db.conversations.updateTopicId(row.id, 43);
        expect((await db.conversations.getByTopicId(43))?.id).toBe(row.id);
        expect(await db.conversations.getByTopicId(42)).toBeNull();

        await db.conversations.setAssignedOperatorId(row.id, "op-1");
        expect((await db.conversations.getById(row.id))?.assignedOperatorId).toBe("op-1");
        await db.conversations.setAssignedOperatorId(row.id, null);
        expect((await db.conversations.getById(row.id))?.assignedOperatorId).toBeNull();

        const later = new Date("2026-01-01T01:00:00.000Z");
        await db.conversations.touchActivity(row.id, later);
        expect((await db.conversations.getById(row.id))?.lastActivityAt).toBe(later.toISOString());

        await db.conversations.setHidden(row.id, later.toISOString());
        expect((await db.conversations.getById(row.id))?.hiddenAt).toBe(later.toISOString());
        await db.conversations.setHideAfterHours(row.id, 48);
        expect((await db.conversations.getById(row.id))?.hideAfterHours).toBe(48);

        await db.conversations.delete(row.id);
        expect(await db.conversations.getByTelegramUserId(1)).toBeNull();
      });

      it("conversations: stale-hidden candidates apply the global hard cap to every policy", async () => {
        // create() seeds last_activity_at from its `now` argument; the hide
        // policy is set separately.
        const make = (id: number, last: Date, hideAfterHours: number | null) =>
          db.conversations
            .create({ botId: "primary", telegramUserId: id, telegramTopicId: id * 100, assignedOperatorId: null }, last)
            .then((c) => db.conversations.setHideAfterHours(c.id, hideAfterHours));
        const hours = (n: number) => new Date(NOW.getTime() - n * HOUR);
        const autoHideHours = 168; // 7-day hard cap
        // Past the hard cap regardless of policy (default / never-hide) → stale.
        await make(1, hours(200), null);
        await make(2, hours(200), 0);
        // Under the hard cap: the permanent (null) policy stays visible...
        await make(3, hours(100), null);
        // ...while a custom /hide N only makes the threshold sooner.
        await make(4, hours(100), 48);
        // A custom threshold past the hard cap is still capped at 7 days.
        await make(5, hours(200), 400);

        expect((await db.conversations.listStaleHiddenCandidates(NOW, autoHideHours)).map((c) => c.telegramUserId)).toEqual([1, 2, 4, 5]);

        // Already-hidden conversations are skipped even when stale.
        await db.conversations.setHidden((await db.conversations.getByTelegramUserId(1))!.id, NOW.toISOString());
        expect((await db.conversations.listStaleHiddenCandidates(NOW, autoHideHours)).map((c) => c.telegramUserId)).toEqual([
          2, 4, 5,
        ]);
      });

      it("messages: create with source keys, source/relayed-id resolution, last-message, delete", async () => {
        await db.users.upsertProfile(profile(1), NOW);
        const conv = await db.conversations.create({ botId: "primary", telegramUserId: 1, telegramTopicId: 42, assignedOperatorId: null }, NOW);

        const msg = await db.messages.create(
          {
            conversationId: conv.id,
            botId: "primary",
            telegramChatId: 100,
            telegramMessageId: 200,
            telegramTopicId: 42,
            relayedMessageId: 300,
            direction: "USER_TO_OPERATOR",
            senderType: "USER",
            contentType: "text",
            replyToMessageId: null,
          },
          NOW,
        );
        expect(msg.conversationId).toBe(conv.id);

        const bySource = await db.messages.getBySource(100, 200);
        expect(bySource?.id).toBe(msg.id);
        expect(await db.messages.getBySource(999, 999)).toBeNull();

        const byRelayed = await db.messages.getByConversationAndRelayedId(conv.id, 300, "USER_TO_OPERATOR");
        expect(byRelayed?.id).toBe(msg.id);
        // Direction-scoped: the same id never resolves as an operator-side copy.
        expect(await db.messages.getByConversationAndRelayedId(conv.id, 999, "USER_TO_OPERATOR")).toBeNull();
      });

      it("operators: upsert, never demote admin, list; notes; blocks", async () => {
        const op1 = await db.operators.upsert({ telegramUserId: 10, role: "OPERATOR" }, NOW);
        expect(op1.role).toBe("OPERATOR");
        await db.operators.upsert({ telegramUserId: 10, role: "OPERATOR" }, new Date());
        expect((await db.operators.getByTelegramUserId(10))?.role).toBe("OPERATOR");

        const admin = await db.operators.upsert({ telegramUserId: 11, role: "ADMIN" }, NOW);
        expect(admin.role).toBe("ADMIN");
        await db.operators.upsert({ telegramUserId: 11, role: "OPERATOR" }, NOW);
        expect((await db.operators.getByTelegramUserId(11))?.role).toBe("ADMIN");

        const list = await db.operators.list();
        expect(list.map((o) => o.telegramUserId).sort()).toEqual([10, 11]);

        // notes
        await db.users.upsertProfile(profile(1), NOW);
        const conv = await db.conversations.create({ botId: "primary", telegramUserId: 1, telegramTopicId: 1, assignedOperatorId: null }, NOW);
        const note = await db.notes.create({ conversationId: conv.id, operatorId: op1.id, text: "internal" }, NOW);
        expect(note.text).toBe("internal");
        // The NoteRepository port exposes create + cascade-delete only, so check
        // persistence through the raw handle.
        const stored = sql.prepare("SELECT text FROM conversation_notes WHERE conversation_id = ?").all(conv.id);
        expect(stored).toHaveLength(1);
        expect(stored[0].text).toBe("internal");

        await db.notes.deleteByConversationId(conv.id);
        expect(sql.prepare("SELECT COUNT(*) AS c FROM conversation_notes WHERE conversation_id = ?").get(conv.id)?.c).toBe(0);
      });

      it("messages: full coverage of source/relayed/last/delete", async () => {
        await db.users.upsertProfile(profile(1), NOW);
        const conv = await db.conversations.create({ botId: "primary", telegramUserId: 1, telegramTopicId: 42, assignedOperatorId: null }, NOW);
        const mk = (fromId: number, toId: number | null, at: Date) =>
          db.messages.create(
            {
              conversationId: conv.id,
              botId: "primary",
              telegramChatId: 100,
              telegramMessageId: fromId,
              telegramTopicId: 42,
              relayedMessageId: toId,
              direction: "USER_TO_OPERATOR",
              senderType: "USER",
              contentType: "text",
              replyToMessageId: null,
            },
            at,
          );

        await mk(1, 101, NOW);
        await mk(2, null, new Date("2026-01-01T01:00:00.000Z"));
        await mk(3, 103, new Date("2026-01-01T02:00:00.000Z"));

        expect((await db.messages.getByConversationAndRelayedId(conv.id, 101, "USER_TO_OPERATOR"))?.telegramMessageId).toBe(1);
        expect((await db.messages.getLastByConversation(conv.id))?.telegramMessageId).toBe(3);
        expect(await db.messages.getLastByConversation("nope")).toBeNull();

        // listUserChatCopyIds: only OPERATOR_TO_USER records with a delivered
        // copy id qualify (the user-chat copies /delete mirrors to the user).
        const toUser = (fromId: number, copyId: number | null, at: Date) =>
          db.messages.create(
            {
              conversationId: conv.id,
              botId: "primary",
              telegramChatId: 900,
              telegramMessageId: fromId,
              telegramTopicId: 42,
              relayedMessageId: copyId,
              direction: "OPERATOR_TO_USER",
              senderType: "OPERATOR",
              contentType: "text",
              replyToMessageId: null,
            },
            at,
          );
        await toUser(10, 2001, NOW);
        await toUser(11, null, NOW);
        expect(await db.messages.listUserChatCopyIds(conv.id)).toEqual([2001]);
        expect(await db.messages.listUserChatCopyIds("nope")).toEqual([]);

        await db.messages.deleteByConversationId(conv.id);
        expect(await db.messages.getBySource(100, 3)).toBeNull();
        expect(await db.messages.getLastByConversation(conv.id)).toBeNull();
      });

      it("blocks: create/re-block/delete by user id", async () => {
        await db.blocks.create({ telegramUserId: 7, createdByTelegramUserId: 99 }, NOW);
        expect((await db.blocks.getByTelegramUserId(7))?.createdByTelegramUserId).toBe(99);

        // Re-blocking keeps a single block row and refreshes metadata.
        await db.blocks.create({ telegramUserId: 7, createdByTelegramUserId: 88 }, NOW);
        expect((await db.blocks.getByTelegramUserId(7))?.createdByTelegramUserId).toBe(88);

        await db.blocks.deleteByTelegramUserId(7);
        expect(await db.blocks.getByTelegramUserId(7)).toBeNull();
      });

      it("applications: pending create, latest-wins, decision update", async () => {
        const first = await db.applications.create({ telegramUserId: 5 }, NOW);
        expect(first.status).toBe("pending");
        expect(first.decidedAt).toBeNull();

        const second = await db.applications.create({ telegramUserId: 5 }, new Date("2026-01-01T01:00:00.000Z"));
        expect((await db.applications.getLatestByTelegramUserId(5))?.id).toBe(second.id);
        expect((await db.applications.getById(first.id))?.status).toBe("pending");

        const decided = new Date("2026-01-02T00:00:00.000Z");
        await db.applications.update({ id: second.id, status: "rejected", decidedAt: decided, decidedByTelegramUserId: 99 });
        const updated = await db.applications.getById(second.id);
        expect(updated?.status).toBe("rejected");
        expect(updated?.decidedAt).toBe(decided.toISOString());
        expect(updated?.decidedByTelegramUserId).toBe(99);
      });

      it("processedUpdates: claim exactly once per (bot, update) even under a frozen clock", async () => {
        expect(await db.processedUpdates.claim("primary", 1, NOW)).toBe(true);
        expect(await db.processedUpdates.claim("primary", 1, NOW)).toBe(false);
        expect(await db.processedUpdates.claim("primary", 2, NOW)).toBe(true);
        // Update ids increment per bot: the same id number claims independently
        // on a second bot, and never conflicts back.
        expect(await db.processedUpdates.claim("bot2", 1, NOW)).toBe(true);
        expect(await db.processedUpdates.claim("bot2", 1, NOW)).toBe(false);
        expect(await db.processedUpdates.claim("primary", 1, NOW)).toBe(false);
      });

      it("multi-bot: one conversation per (bot, user); identical message ids across bots coexist", async () => {
        await db.users.upsertProfile(profile(1), NOW);

        const a = await db.conversations.create({ botId: "bot1", telegramUserId: 1, telegramTopicId: 11, assignedOperatorId: null }, NOW);
        const b = await db.conversations.create({ botId: "bot2", telegramUserId: 1, telegramTopicId: 12, assignedOperatorId: null }, NOW);
        expect(a.id).not.toBe(b.id);

        // Exact (bot, user) lookup returns the right conversation.
        expect((await db.conversations.getByBotAndUser("bot1", 1))?.id).toBe(a.id);
        expect((await db.conversations.getByBotAndUser("bot2", 1))?.id).toBe(b.id);
        expect(await db.conversations.getByBotAndUser("bot3", 1)).toBeNull();

        // getByTelegramUserId is a cross-bot fallback: the most recent one wins.
        await db.conversations.touchActivity(a.id, new Date("2026-01-01T02:00:00.000Z"));
        expect((await db.conversations.getByTelegramUserId(1))?.id).toBe(a.id);

        await db.conversations.delete(a.id);
        expect(await db.conversations.getByBotAndUser("bot1", 1)).toBeNull();
        expect((await db.conversations.getByBotAndUser("bot2", 1))?.id).toBe(b.id);

        // A user's private chat id is the same number on every bot, and message
        // ids restart at 1 per bot — so (chat, message) == (1, 7) is recorded
        // once per bot without clobbering.
        const mk = (botId: string, conversationId: string) =>
          db.messages.create(
            {
              conversationId,
              botId,
              telegramChatId: 1,
              telegramMessageId: 7,
              telegramTopicId: null,
              relayedMessageId: null,
              direction: "USER_TO_OPERATOR",
              senderType: "USER",
              contentType: "text",
              replyToMessageId: null,
            },
            NOW,
          );
        const ma = await mk("bot1", a.id);
        const mb = await mk("bot2", b.id);
        expect(ma.id).not.toBe(mb.id); // the unique (bot_id, chat, message) allows both
        expect((await db.messages.getBySource(1, 7))?.id).toBe(ma.id); // earliest row wins
      });

      it("settings: get/set and overwrite", async () => {
        expect(await db.settings.get("key")).toBeNull();
        await db.settings.set("key", "v1");
        expect(await db.settings.get("key")).toBe("v1");
        await db.settings.set("key", "v2");
        expect(await db.settings.get("key")).toBe("v2");
      });

      // Commit + nesting hold on every driver. Rollback is driver-specific
      // (node:sqlite brackets with BEGIN/COMMIT; the DO binding serializes
      // requests instead), so the rollback path lives in the sqlite adapter's
      // own test file.
      it("transaction: commits on success and nests", async () => {
        await db.transaction(async (tx) => {
          await tx.users.upsertProfile(profile(1), NOW);
          await tx.transaction(async (inner) => {
            await inner.users.upsertProfile(profile(2), NOW);
          });
        });
        expect(await db.users.getByTelegramUserId(1)).not.toBeNull();
        expect(await db.users.getByTelegramUserId(2)).not.toBeNull();
      });
    });
  });
}