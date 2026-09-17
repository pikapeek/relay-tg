// ---------------------------------------------------------------------------
// Shared fixtures for the relay-pipeline suites (pipeline.*.test.ts). Named
// *.test-helpers.ts so the vitest include pattern (*.test.ts) never collects it
// as a test file.
// ---------------------------------------------------------------------------

import { loadConfig, type ConversationRecord, type MessageContent, type Config } from "@relaytg/shared";
import { buildServices } from "./index.ts";
import { profile, type Harness } from "./harness.ts";

export async function verifiedUser(h: Harness, telegramUserId: number, purpose = "test purpose"): Promise<void> {
  const services = buildServices(h.ctx);
  const { user } = await services.users.getOrCreate(profile(telegramUserId));
  await services.users.markVerified(user.telegramUserId);
  // Verification is followed by the first-contact purpose gate: the user states
  // a purpose before any topic exists, so fixtures carry one on the record.
  await services.users.setPurpose(user.telegramUserId, purpose);
}

/** Open the user's conversation (topic + welcome) without any relayed messages. */
export async function openConversation(h: Harness, telegramUserId: number): Promise<ConversationRecord> {
  const services = buildServices(h.ctx);
  const user = (await services.users.getByTelegramUserId(telegramUserId))!;
  return services.conversations.grantAccess(user);
}

export function topicSends(h: Harness, topicId: number, method = "sendMessage") {
  return h.telegram.callsOf(method).filter((c) => c.target.messageThreadId === topicId);
}

export function recordsForConversation(h: Harness, conversationId: string) {
  return [...h.db.messages.rows.values()].filter((m) => m.conversationId === conversationId);
}

/** Relay sends go through sendContent, whose recorded payload wraps the content. */
export function contentOf(call: { payload: Record<string, unknown> }): MessageContent | null {
  return (call.payload.content as MessageContent | undefined) ?? null;
}

export function textOf(call: { payload: Record<string, unknown> }): string | undefined {
  const content = contentOf(call);
  return content && content.type === "text" ? content.text : undefined;
}

export function fileIdOf(call: { payload: Record<string, unknown> }): string | undefined {
  const content = contentOf(call);
  return content && content.type !== "text" ? content.fileId : undefined;
}

/** The pinned personal-info card carries the user's info text as its payload
 *  (`sendMessage`) or caption (`sendContent` photo card). */
export function cardInfoOf(
  call: { payload: Record<string, unknown> },
): string | undefined {
  const text = call.payload.text;
  if (typeof text === "string") return text;
  const caption = call.payload.caption;
  if (typeof caption === "string") return caption;
  const content = contentOf(call);
  if (content && content.type !== "text" && "caption" in content) return content.caption ?? undefined;
  return undefined;
}

/** The identity button's tg:// URL, when the call carries a reply markup. */
export function identityUrlOf(call: { replyMarkup?: { buttons: Array<{ url?: string }> } }): string | undefined {
  return call.replyMarkup?.buttons[0]?.url;
}

/** Drain the microtask queue so a fire-and-forget async flush (MediaGroupService)
 *  has finished its fake-only promise chain before the test asserts. One
 *  macrotask is enough: every await in the chain resolves immediately. */
export async function drainMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Shared ad-config builder for the 广告防护 suites (ad + pending). */
export function adConfig(env: Record<string, string> = {}): Config {
  return loadConfig({
    BOT_TOKEN: "test-token",
    GROUP_ID: "-100123456789",
    ADMIN_IDS: "111",
    OPERATOR_IDS: "222,333",
    ...env,
  });
}