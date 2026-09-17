// ---------------------------------------------------------------------------
// Shared fixtures for the operator-command suites (commands.*.test.ts). Named
// *.test-helpers.ts so the vitest include pattern (*.test.ts) never collects it
// as a test file.
// ---------------------------------------------------------------------------

import type { ApplicationDecisionEvent, ConversationRecord } from "@relaytg/shared";
import { buildServices } from "./index.ts";
import { profile, GROUP_ID, type Harness } from "./harness.ts";

export async function seeded(h: Harness) {
  const services = buildServices(h.ctx);
  await services.operators.seed();
  return services;
}

export async function verifiedUser(h: Harness, telegramUserId: number, purpose = "test purpose"): Promise<ConversationRecord> {
  const services = buildServices(h.ctx);
  const { user } = await services.users.getOrCreate(profile(telegramUserId));
  await services.users.markVerified(user.telegramUserId);
  // Verification is followed by the first-contact purpose gate: the user states
  // a purpose before any topic exists, so fixtures carry one on the record.
  await services.users.setPurpose(user.telegramUserId, purpose);
  return services.conversations.grantAccess(user);
}

/** Reply posted by the bot back into the support group (operator command echo).
 * Relayed content sends are excluded: only direct command replies carry a
 * plain `payload.text`. The pinned personal info card is also excluded — it is
 * a `sendMessage` into the topic whose tap-through profile button marks it. */
export function groupReplies(h: Harness, messageThreadId?: number) {
  return h.telegram
    .callsOf("sendMessage")
    .filter((c) => c.payload.text != null)
    .filter((c) => c.target.chatId === GROUP_ID && (messageThreadId === undefined || c.target.messageThreadId === messageThreadId))
    .filter((c) => !c.replyMarkup?.buttons.some((b) => b.url?.startsWith("tg://user?id=")));
}

export function replyText(h: Harness, messageThreadId?: number): string[] {
  return groupReplies(h, messageThreadId).map((c) => c.payload.text as string);
}

export function applicationDecision(
  callbackQueryId: string,
  senderId: number,
  decision: "approve" | "reject",
  applicationId: string,
): ApplicationDecisionEvent {
  return { kind: "application_decision", callbackQueryId, chatId: GROUP_ID, messageId: 200, sender: profile(senderId), decision, applicationId };
}

export async function hiddenConversation(h: Harness, telegramUserId: number): Promise<ConversationRecord> {
  const conv = await verifiedUser(h, telegramUserId);
  await h.telegram.hideForumTopic({ chatId: GROUP_ID, messageThreadId: conv.telegramTopicId! });
  await h.db.conversations.setHidden(conv.id, h.runtime.now().toISOString());
  return conv;
}