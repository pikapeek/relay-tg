// ---------------------------------------------------------------------------
// FakeTelegramClient: the test double for the TelegramClient port. It also
// simulates realistic topic behavior — sending into a missing thread throws
// `topic_not_found`, into a closed thread throws `topic_closed`, and
// hide/restore/delete on a missing thread throw too.
// ---------------------------------------------------------------------------

import { TelegramError, type MessageContent, type TelegramErrorKind } from "@relaytg/shared";
import type { SendTarget, TelegramClient } from "../ports.ts";
import type { BotCommand, BotCommandScope, InlineKeyboard } from "../telegram-types.ts";

const CONTENT_METHODS: Record<MessageContent["type"], string> = {
  text: "sendMessage",
  photo: "sendPhoto",
  video: "sendVideo",
  document: "sendDocument",
  audio: "sendAudio",
  voice: "sendVoice",
  sticker: "sendSticker",
};

const THREAD_SEND_METHODS = new Set([
  "sendMessage",
  "sendPhoto",
  "sendVideo",
  "sendDocument",
  "sendAudio",
  "sendVoice",
  "sendSticker",
  "forwardMessage",
]);

/** Shape of a delivered copy, keyed by its message id. The fake validates edits
 *  against it the way Telegram does: text edits need a text message, caption
 *  edits need a caption-carrying message (photo/video/document/audio/voice). */
type CopyShape = "text" | "photo" | "video" | "document" | "audio" | "voice" | "sticker";

const SEND_SHAPE: Record<string, CopyShape | undefined> = {
  sendMessage: "text",
  sendPhoto: "photo",
  sendVideo: "video",
  sendDocument: "document",
  sendAudio: "audio",
  sendVoice: "voice",
  sendSticker: "sticker",
  // forwardMessage copies arrive in the topic but are not editable.
  forwardMessage: undefined,
};

export interface RecordedCall {
  method: string;
  target: SendTarget & { messageId?: number };
  payload: Record<string, unknown>;
  replyMarkup?: InlineKeyboard;
  /** The message id the fake returned for a send call (absent for non-sends). */
  id?: number;
}

export class FakeTelegramClient implements TelegramClient {
  calls: RecordedCall[] = [];
  topics = new Map<number, { name: string; closed: boolean }>();
  answers: Array<{ callbackQueryId: string; text?: string; showAlert?: boolean }> = [];
  /** Registered command menus, in call order. */
  commandMenus: Array<{ scope?: BotCommandScope; commands: BotCommand[]; languageCode?: string }> = [];

  /** Profile photos by user id — the bot-usable largest file_id, or absent to
   *  simulate "no profile photo". */
  profilePhotos = new Map<number, string | null>();
  /** userIds of every getUserProfilePhoto call, in order — feeds the pinned
   *  info-card photo at topic creation. */
  profilePhotoLookups: number[] = [];
  /** Self-check responses — default to a healthy deployment; tests override
   *  them to exercise failure paths. */
  meResult: { id: number; username: string; first_name: string } = {
    id: 42_000,
    username: "relaytg_test_bot",
    first_name: "RelayTG Test Bot",
  };
  chatResult: { id: number; type: string; is_forum?: boolean; title?: string } = {
    id: -100123456789,
    type: "supergroup",
    is_forum: true,
    title: "Support",
  };
  chatMemberResult: { status: string } = { status: "administrator" };
  /** Message ids pinned via pinChatMessage (e.g. the personal info card). */
  pinnedMessageIds = new Set<number>();
  /** Messages deleted via deleteMessage — the user-chat copies `/delete` cleans up. */
  deletedMessages: Array<{ chatId: number; messageId: number }> = [];
  /** Shape of each delivered copy, keyed by the message id the fake returned. */
  private readonly copyShape = new Map<number, CopyShape>();
  private nextMessageId = 1000;
  private nextTopicId = 100;
  private failOnce: { method?: string; kind: TelegramErrorKind } | null = null;
  private failAlways: { method?: string; kind: TelegramErrorKind } | null = null;
  /** Fail the n-th matching call (1-based), then clear. */
  private failNth: { n: number; method?: string; kind: TelegramErrorKind } | null = null;
  private failCounts: Record<string, number> = {};

  failOnceWith(kind: TelegramErrorKind, method?: string): void {
    this.failOnce = { kind, method };
  }

  failAlwaysWith(kind: TelegramErrorKind, method?: string): void {
    this.failAlways = { kind, method };
  }

  failNthWith(n: number, kind: TelegramErrorKind, method?: string): void {
    this.failNth = { n, kind, method };
  }

  /** Give a user a profile photo whose largest file_id is `fileId` — the avatar
   *  the pinned personal info card uses for a photo card. */
  setProfilePhoto(telegramUserId: number, fileId: string): void {
    this.profilePhotos.set(telegramUserId, fileId);
  }

  /** Remove any profile photo; getUserProfilePhoto then returns null. */
  clearProfilePhoto(telegramUserId: number): void {
    this.profilePhotos.delete(telegramUserId);
  }

  // -- sends ---------------------------------------------------------------

  async sendMessage(target: SendTarget & { text: string; replyMarkup?: InlineKeyboard }): Promise<number> {
    return this.record("sendMessage", target, { text: target.text }, target.replyMarkup);
  }

  async sendPhoto(target: SendTarget & { fileId: string; caption?: string }): Promise<number> {
    return this.record("sendPhoto", target, { fileId: target.fileId, caption: target.caption });
  }

  async sendVideo(target: SendTarget & { fileId: string; caption?: string }): Promise<number> {
    return this.record("sendVideo", target, { fileId: target.fileId, caption: target.caption });
  }

  async sendDocument(target: SendTarget & { fileId: string; caption?: string }): Promise<number> {
    return this.record("sendDocument", target, { fileId: target.fileId, caption: target.caption });
  }

  async sendAudio(target: SendTarget & { fileId: string; caption?: string }): Promise<number> {
    return this.record("sendAudio", target, { fileId: target.fileId, caption: target.caption });
  }

  async sendVoice(target: SendTarget & { fileId: string; caption?: string }): Promise<number> {
    return this.record("sendVoice", target, { fileId: target.fileId, caption: target.caption });
  }

  async sendSticker(target: SendTarget & { fileId: string }): Promise<number> {
    return this.record("sendSticker", target, { fileId: target.fileId });
  }

  async sendContent(target: SendTarget, content: MessageContent, replyMarkup?: InlineKeyboard): Promise<number> {
    return this.record(CONTENT_METHODS[content.type], target, { content }, replyMarkup);
  }

  async sendMediaGroup(p: {
    chatId: number;
    messageThreadId?: number;
    items: Array<{ type: "photo" | "video" | "document" | "audio"; fileId: string; caption?: string }>;
  }): Promise<number[]> {
    this.checkFail("sendMediaGroup");
    if (p.messageThreadId != null) {
      const topic = this.topics.get(p.messageThreadId);
      if (!topic) throw new TelegramError("message thread not found", { kind: "topic_not_found", httpStatus: 400 });
      if (topic.closed) throw new TelegramError("message thread is closed", { kind: "topic_closed", httpStatus: 400 });
    }
    const ids = p.items.map(() => this.nextMessageId++);
    this.calls.push({
      method: "sendMediaGroup",
      target: { chatId: p.chatId, messageThreadId: p.messageThreadId },
      payload: { items: p.items },
    });
    return ids;
  }

  async getUserProfilePhoto(p: { userId: number }): Promise<string | null> {
    this.checkFail("getUserProfilePhoto");
    this.profilePhotoLookups.push(p.userId);
    return this.profilePhotos.get(p.userId) ?? null;
  }

  async getMe(): Promise<{ id: number; username: string; first_name: string }> {
    this.checkFail("getMe");
    this.calls.push({ method: "getMe", target: { chatId: 0 }, payload: {} });
    return this.meResult;
  }

  async getChat(p: { chatId: number }): Promise<{ id: number; type: string; is_forum?: boolean; title?: string }> {
    this.checkFail("getChat");
    this.calls.push({ method: "getChat", target: { chatId: p.chatId }, payload: {} });
    return this.chatResult;
  }

  async getChatMember(p: { chatId: number; userId: number }): Promise<{ status: string }> {
    this.checkFail("getChatMember");
    this.calls.push({ method: "getChatMember", target: { chatId: p.chatId }, payload: { userId: p.userId } });
    return this.chatMemberResult;
  }

  async forwardMessage(p: {
    chatId: number;
    messageThreadId?: number;
    fromChatId: number;
    messageId: number;
  }): Promise<number> {
    return this.record(
      "forwardMessage",
      { chatId: p.chatId, messageThreadId: p.messageThreadId },
      { fromChatId: p.fromChatId, messageId: p.messageId },
    );
  }

  async pinChatMessage(p: { chatId: number; messageId: number; messageThreadId?: number }): Promise<void> {
    this.checkFail("pinChatMessage");
    this.pinnedMessageIds.add(p.messageId);
    this.calls.push({
      method: "pinChatMessage",
      target: { chatId: p.chatId, messageThreadId: p.messageThreadId },
      payload: { messageId: p.messageId },
    });
  }

  async deleteMessage(p: { chatId: number; messageId: number }): Promise<void> {
    this.checkFail("deleteMessage");
    this.deletedMessages.push({ chatId: p.chatId, messageId: p.messageId });
    this.calls.push({ method: "deleteMessage", target: { chatId: p.chatId }, payload: { messageId: p.messageId } });
  }

  // -- edits ---------------------------------------------------------------

  async editMessageText(p: { chatId: number; messageId: number; text: string; replyMarkup?: InlineKeyboard }): Promise<void> {
    this.checkFail("editMessageText");
    // A failed shape attempt is recorded too — the call reached the API — so the
    // relayer's caption→text fallback is observable in the call list.
    this.pushEdit("editMessageText", p, { text: p.text }, p.replyMarkup, ["text"], "there is no text in the message to edit");
  }

  async editMessageCaption(p: { chatId: number; messageId: number; caption?: string; replyMarkup?: InlineKeyboard }): Promise<void> {
    this.checkFail("editMessageCaption");
    const payload: Record<string, unknown> = {};
    if (p.caption !== undefined) payload.caption = p.caption;
    this.pushEdit(
      "editMessageCaption",
      p,
      payload,
      p.replyMarkup,
      ["photo", "video", "document", "audio", "voice"],
      "there is no caption in the message to edit",
    );
  }

  // -- topics --------------------------------------------------------------

  async createForumTopic(p: { chatId: number; name: string }): Promise<number> {
    this.checkFail("createForumTopic");
    const topicId = this.nextTopicId++;
    this.calls.push({ method: "createForumTopic", target: { chatId: p.chatId }, payload: { name: p.name } });
    this.topics.set(topicId, { name: p.name, closed: false });
    return topicId;
  }

  async editForumTopic(p: { chatId: number; messageThreadId: number; name: string }): Promise<void> {
    this.checkFail("editForumTopic");
    const topic = this.topics.get(p.messageThreadId);
    if (!topic) throw new TelegramError("message thread not found", { kind: "topic_not_found", httpStatus: 400 });
    topic.name = p.name;
    this.calls.push({ method: "editForumTopic", target: p, payload: { name: p.name } });
  }

  async hideForumTopic(p: { chatId: number; messageThreadId: number }): Promise<void> {
    this.checkFail("hideForumTopic");
    const topic = this.topics.get(p.messageThreadId);
    if (!topic) throw new TelegramError("message thread not found", { kind: "topic_not_found", httpStatus: 400 });
    topic.closed = true;
    this.calls.push({ method: "hideForumTopic", target: p, payload: {} });
  }

  async restoreForumTopic(p: { chatId: number; messageThreadId: number }): Promise<void> {
    this.checkFail("restoreForumTopic");
    const topic = this.topics.get(p.messageThreadId);
    if (!topic) throw new TelegramError("message thread not found", { kind: "topic_not_found", httpStatus: 400 });
    topic.closed = false;
    this.calls.push({ method: "restoreForumTopic", target: p, payload: {} });
  }

  async deleteForumTopic(p: { chatId: number; messageThreadId: number }): Promise<void> {
    this.checkFail("deleteForumTopic");
    const topic = this.topics.get(p.messageThreadId);
    if (!topic) throw new TelegramError("message thread not found", { kind: "topic_not_found", httpStatus: 400 });
    this.topics.delete(p.messageThreadId);
    this.calls.push({ method: "deleteForumTopic", target: p, payload: {} });
  }

  // -- callbacks -----------------------------------------------------------

  async answerCallbackQuery(p: { callbackQueryId: string; text?: string; showAlert?: boolean }): Promise<void> {
    this.checkFail("answerCallbackQuery");
    this.answers.push(p);
  }

  async setMyCommands(p: { commands: BotCommand[]; scope?: BotCommandScope; languageCode?: string }): Promise<void> {
    this.checkFail("setMyCommands");
    this.commandMenus.push(
      p.languageCode !== undefined
        ? { scope: p.scope, commands: p.commands, languageCode: p.languageCode }
        : { scope: p.scope, commands: p.commands },
    );
  }

  // -------------------------------------------------------------------------

  private record(method: string, target: SendTarget & { messageId?: number }, payload: Record<string, unknown>, replyMarkup?: InlineKeyboard): number {
    this.checkFail(method);
    if (THREAD_SEND_METHODS.has(method) && target.messageThreadId != null) {
      const topic = this.topics.get(target.messageThreadId);
      if (!topic) throw new TelegramError("message thread not found", { kind: "topic_not_found", httpStatus: 400 });
      if (topic.closed) throw new TelegramError("message thread is closed", { kind: "topic_closed", httpStatus: 400 });
    }
    const id = this.nextMessageId++;
    this.calls.push({ method, target: { ...target }, payload, replyMarkup, id });
    const shape = SEND_SHAPE[method];
    if (shape) this.copyShape.set(id, shape);
    return id;
  }

  /** Record an edit attempt and throw when the target copy can't be edited that
   *  way (mirrors Telegram's "there is no text/caption in the message to edit").
   *  Unknown copies (e.g. manually seeded records) are treated leniently. */
  private pushEdit(
    method: string,
    target: SendTarget & { messageId?: number },
    payload: Record<string, unknown>,
    replyMarkup: InlineKeyboard | undefined,
    allowedShapes: CopyShape[],
    mismatchDescription: string,
  ): void {
    const call: RecordedCall = { method, target: { chatId: target.chatId, messageId: target.messageId }, payload };
    if (replyMarkup) call.replyMarkup = replyMarkup;
    this.calls.push(call);
    const shape = this.copyShape.get(target.messageId!);
    if (shape !== undefined && !allowedShapes.includes(shape)) {
      throw new TelegramError(mismatchDescription, { kind: "bad_request", httpStatus: 400 });
    }
  }

  private checkFail(method: string): void {
    if (this.failOnce && (!this.failOnce.method || this.failOnce.method === method)) {
      const f = this.failOnce;
      this.failOnce = null;
      throw new TelegramError(`simulated ${method} failure`, { kind: f.kind });
    }
    if (this.failAlways && (!this.failAlways.method || this.failAlways.method === method)) {
      throw new TelegramError(`simulated ${method} failure`, { kind: this.failAlways.kind });
    }
    if (this.failNth && (!this.failNth.method || this.failNth.method === method)) {
      const n = (this.failCounts[method] ?? 0) + 1;
      this.failCounts[method] = n;
      if (n === this.failNth.n) {
        const f = this.failNth;
        this.failNth = null;
        throw new TelegramError(`simulated ${method} failure`, { kind: f.kind });
      }
    }
  }

  // -- test helpers ----------------------------------------------------------

  lastCall(): RecordedCall | null {
    return this.calls.length > 0 ? this.calls[this.calls.length - 1] : null;
  }

  callsOf(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Create the topic that a fresh conversation would have created. */
  seedTopic(): number {
    const id = this.nextTopicId++;
    this.topics.set(id, { name: "seed", closed: false });
    return id;
  }
}