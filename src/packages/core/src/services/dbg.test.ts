import { describe, expect, it } from "vitest";
import { buildServices } from "./index.ts";
import { makeHarness, profile, text, operatorMessage, GROUP_ID } from "./harness.ts";

describe("dbg", () => {
  it("shows what /help sends", async () => {
    const h = makeHarness();
    const s = buildServices(h.ctx);
    await s.operators.seed();
    const { user } = await s.users.getOrCreate(profile(42));
    await s.users.markVerified(user.telegramUserId, h.bots.primary());
    const conv = await s.conversations.grantAccess(user, h.bots.primary());
    const r1 = await s.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/help"), conv.telegramTopicId!));
    const r2 = await s.processor.process(2, operatorMessage(GROUP_ID, 2, profile(222), text("/help"), null));
    console.log("r1", JSON.stringify(r1), "r2", JSON.stringify(r2));
    console.log("calls", JSON.stringify(h.telegram.calls.map(c => ({ m: c.method, cid: c.target.chatId, tid: c.target.messageThreadId, t: c.payload.text }))));
    expect(r2.status).toBe("command_handled");
  });
});
