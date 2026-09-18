// ---------------------------------------------------------------------------
// Shared test harness for the core service/pipeline unit suites: in-memory
// fakes wired into a ServiceContext plus typed event builders.
// ---------------------------------------------------------------------------

import {
  loadConfig,
  type Config,
  type EditedOperatorMessageEvent,
  type EditedUserMessageEvent,
  type MessageContent,
  type OperatorMessageEvent,
  type UserMessageEvent,
  type UserProfile,
  type VerificationAnswerEvent,
} from "@relaytg/shared";
import type { Serializer } from "../ports.ts";
import { botRegistryFrom, type BotRegistry } from "./bot-registry.ts";
import type { ServiceContext } from "./service-context.ts";
import {
  CaptureLogger,
  FakeRuntime,
  FakeTelegramClient,
  FakeTopicStore,
  immediateSerializer,
  MemoryDatabase,
  MemoryVerificationStore,
} from "../testing.ts";

export interface Harness {
  ctx: ServiceContext;
  db: MemoryDatabase;
  /** The PRIMARY bot's fake client. */
  telegram: FakeTelegramClient;
  bots: BotRegistry;
  runtime: FakeRuntime;
  logger: CaptureLogger;
  store: MemoryVerificationStore;
}

export function baseConfig(): Config {
  return loadConfig({
    BOTS: "main:test-token",
    GROUP_ID: "-100123456789",
    ADMIN_IDS: "111",
    OPERATOR_IDS: "222,333",
  });
}

export function makeHarness(config: Config = baseConfig(), serializer: Serializer = immediateSerializer): Harness {
  const db = new MemoryDatabase();
  // All bots of one deployment live in the SAME support group, so the fakes
  // share a topic store — a topic created by the primary bot is a real group
  // topic the other bots can send into (the fake's per-instance topic map must
  // not hide that).
  const topicStore: FakeTopicStore = { topics: new Map(), nextTopicId: 100 };
  const telegram = new FakeTelegramClient(topicStore);
  const runtime = new FakeRuntime();
  const logger = new CaptureLogger();
  const store = new MemoryVerificationStore();
  // One fake client per configured bot; the FIRST is the harness's `telegram`.
  // Identities come from the fakes' meResult so the registry matches what each
  // fake would report without a getMe round-trip.
  const clients = config.bots.map((_bot, i) => (i === 0 ? telegram : new FakeTelegramClient(topicStore)));
  const bots = botRegistryFrom(
    config.bots.map((bot, i) => ({
      botId: bot.id,
      client: clients[i]!,
      botTelegramUserId: clients[i]!.meResult.id,
      botUsername: clients[i]!.meResult.username,
    })),
  );
  const ctx: ServiceContext = { db, telegram, bots, runtime, config, logger, verificationStore: store, serializer };
  return { ctx, db, telegram, bots, runtime, logger, store };
}

export function profile(telegramUserId: number, overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    telegramUserId,
    username: null,
    firstName: `User${telegramUserId}`,
    lastName: null,
    languageCode: null,
    isBot: false,
    ...overrides,
  };
}

export function text(t: string): MessageContent {
  return { type: "text", text: t };
}

export function photo(fileId: string, caption: string | null = null): MessageContent {
  return { type: "photo", fileId, caption, fileSize: 10 };
}

export function userMessage(
  chatId: number,
  messageId: number,
  sender: UserProfile,
  content: MessageContent,
  opts: { replyToMessageId?: number | null; mediaGroupId?: string | null } = {},
): UserMessageEvent {
  return {
    kind: "user_message",
    chatId,
    messageId,
    sender,
    content,
    replyToMessageId: opts.replyToMessageId ?? null,
    mediaGroupId: opts.mediaGroupId ?? null,
  };
}

export function operatorMessage(
  chatId: number,
  messageId: number,
  sender: UserProfile,
  content: MessageContent,
  messageThreadId: number | null,
  replyToMessageId: number | null = null,
): OperatorMessageEvent {
  return { kind: "operator_message", chatId, messageId, messageThreadId, sender, content, replyToMessageId };
}

export function verificationAnswer(
  chatId: number,
  messageId: number,
  answer: number,
  callbackQueryId: string,
  sender: UserProfile,
): VerificationAnswerEvent {
  return { kind: "verification_answer", callbackQueryId, chatId, messageId, sender, answer };
}

export function editedUserMessage(
  chatId: number,
  messageId: number,
  sender: UserProfile,
  content: MessageContent,
): EditedUserMessageEvent {
  return { kind: "edited_user_message", chatId, messageId, sender, content };
}

export function editedOperatorMessage(
  chatId: number,
  messageId: number,
  sender: UserProfile,
  content: MessageContent,
  messageThreadId: number | null,
): EditedOperatorMessageEvent {
  return { kind: "edited_operator_message", chatId, messageId, messageThreadId, sender, content };
}

export const HOUR = 3_600_000;
export const GROUP_ID = -100123456789;
