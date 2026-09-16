// ---------------------------------------------------------------------------
// TelegramClient over fetch. Encapsulates: URL building, form encoding,
// error-taxonomy mapping (incl. the distinguishable topic_not_found and
// topic_closed variants), 429 retry_after handling, and a bounded retry budget
// for 429 / 5xx / network. 400/403/404 are never blindly retried.
// ---------------------------------------------------------------------------

import type { MessageContent } from "@relaytg/shared";
import { TelegramError as TgError } from "@relaytg/shared";
import type { BotCommand, BotCommandScope, InlineKeyboard, TelegramClient, SendTarget } from "@relaytg/core";
import { contentToForm, contentToMethod, inlineKeyboardToJson } from "./mapper.ts";

/** Ambient global fetch (Node 22 and Workers both provide it structurally). */
declare const fetch: FetchLike;

const API_BASE = "https://api.telegram.org/bot";

/** Structural fetch contract — keeps this package free of Node/DOM types. */
export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export interface FetchLikeInit {
  method?: string;
  body?: string | URLSearchParams;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init?: FetchLikeInit) => Promise<FetchLikeResponse>;

interface BotApiErrorBody {
  ok: false;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}
interface BotApiOkBody {
  ok: true;
  result: { message_id?: number; message_thread_id?: number };
}

const MAX_429_WAIT_MS = 30_000;
/** Cap on the cumulative retry sleep across the whole budget, so a burst of 429s
 *  (or a hung connection) can't pin the webhook handler for the full
 *  retries × per-wait worst case. */
const TOTAL_RETRY_BUDGET_MS = 20_000;
/** Per-request timeout for outbound Bot API calls (Node has no platform
 *  watchdog like Workers, so a hung connection must not stall a handler). */
const REQUEST_TIMEOUT_MS = 10_000;

export interface HttpTelegramClientOptions {
  botToken: string;
  fetchFn?: FetchLike;
  retries?: number;
  baseBackoffMs?: number;
}

export class HttpTelegramClient implements TelegramClient {
  private readonly botToken: string;
  private readonly fetchFn: FetchLike;
  private readonly retries: number;
  private readonly baseBackoffMs: number;

  constructor(opts: HttpTelegramClientOptions) {
    this.botToken = opts.botToken;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.retries = opts.retries ?? 3;
    this.baseBackoffMs = opts.baseBackoffMs ?? 500;
  }

  async sendMessage(target: SendTarget & { text: string; replyMarkup?: InlineKeyboard }): Promise<number> {
    const form: Record<string, unknown> = { chat_id: target.chatId, text: target.text };
    this.withTarget(form, target);
    if (target.replyMarkup) form.reply_markup = inlineKeyboardToJson(target.replyMarkup);
    return this.callNumber("sendMessage", form);
  }

  async sendPhoto(target: SendTarget & { fileId: string; caption?: string }): Promise<number> {
    return this.callNumber("sendPhoto", this.mediaForm("photo", target));
  }

  async sendVideo(target: SendTarget & { fileId: string; caption?: string }): Promise<number> {
    return this.callNumber("sendVideo", this.mediaForm("video", target));
  }

  async sendDocument(target: SendTarget & { fileId: string; caption?: string }): Promise<number> {
    return this.callNumber("sendDocument", this.mediaForm("document", target));
  }

  async sendAudio(target: SendTarget & { fileId: string; caption?: string }): Promise<number> {
    return this.callNumber("sendAudio", this.mediaForm("audio", target));
  }

  async sendVoice(target: SendTarget & { fileId: string; caption?: string }): Promise<number> {
    return this.callNumber("sendVoice", this.mediaForm("voice", target));
  }

  async sendSticker(target: SendTarget & { fileId: string }): Promise<number> {
    return this.callNumber("sendSticker", this.mediaForm("sticker", target));
  }

  async sendContent(target: SendTarget, content: MessageContent, replyMarkup?: InlineKeyboard): Promise<number> {
    const method = contentToMethod(content);
    const form = contentToForm(content);
    this.withTarget(form, target);
    if (replyMarkup) form.reply_markup = inlineKeyboardToJson(replyMarkup);
    return this.callNumber(method, form);
  }

  async sendMediaGroup(p: {
    chatId: number;
    messageThreadId?: number;
    items: Array<{ type: "photo" | "video" | "document" | "audio"; fileId: string; caption?: string }>;
  }): Promise<number[]> {
    // `media` is an array of InputMedia objects. Bot API allows a caption on the
    // FIRST item only — later captions are dropped so the request stays valid.
    const media = p.items.map((item, i) => {
      const m: Record<string, unknown> = { type: item.type, media: item.fileId };
      if (i === 0 && item.caption !== undefined) m.caption = item.caption;
      return m;
    });
    const form: Record<string, unknown> = { chat_id: p.chatId, media };
    if (p.messageThreadId !== undefined) form.message_thread_id = p.messageThreadId;
    const res = await this.call<Array<{ message_id: number }>>("sendMediaGroup", form);
    return res.map((m) => m.message_id);
  }

  async getUserProfilePhoto(p: { userId: number }): Promise<string | null> {
    const res = await this.call<{ total_count: number; photos: Array<Array<{ file_id: string }>> }>("getUserProfilePhotos", {
      user_id: p.userId,
      limit: 1,
    });
    const sizes = res.photos[0];
    if (!sizes || sizes.length === 0) return null;
    // photos[0] is the most recent photo; its last element is the largest
    // size, and every photo file_id is directly reusable in sendPhoto.
    return sizes[sizes.length - 1]!.file_id;
  }

  async getMe(): Promise<{ id: number; username: string; first_name: string }> {
    return this.call("getMe", {});
  }

  async getChat(p: { chatId: number }): Promise<{ id: number; type: string; is_forum?: boolean; title?: string }> {
    return this.call("getChat", { chat_id: p.chatId });
  }

  async getChatMember(p: { chatId: number; userId: number }): Promise<{ status: string }> {
    return this.call("getChatMember", { chat_id: p.chatId, user_id: p.userId });
  }

  /** Relay a user's message verbatim into the support group as a forwarded
   *  copy. The forward preserves the original sender's name and avatar
   *  attribution; the returned id is the topic copy's reply anchor. */
  async forwardMessage(p: {
    chatId: number;
    messageThreadId?: number;
    fromChatId: number;
    messageId: number;
  }): Promise<number> {
    const form: Record<string, unknown> = {
      chat_id: p.chatId,
      from_chat_id: p.fromChatId,
      message_id: p.messageId,
    };
    if (p.messageThreadId !== undefined) form.message_thread_id = p.messageThreadId;
    const res = await this.call<{ message_id: number }>("forwardMessage", form);
    return res.message_id;
  }

  async pinChatMessage(p: { chatId: number; messageId: number; messageThreadId?: number }): Promise<void> {
    const form: Record<string, unknown> = { chat_id: p.chatId, message_id: p.messageId };
    if (p.messageThreadId !== undefined) form.message_thread_id = p.messageThreadId;
    await this.call("pinChatMessage", form);
  }

  async deleteMessage(p: { chatId: number; messageId: number }): Promise<void> {
    // Bot API rejects bot-owned messages older than 48 h and already-deleted
    // ones; those surface as TelegramErrors (400/403) that the caller logs and
    // drops — deletion is best-effort cleanup, never a pipeline failure.
    await this.call("deleteMessage", { chat_id: p.chatId, message_id: p.messageId });
  }

  async editMessageText(p: { chatId: number; messageId: number; text: string; replyMarkup?: InlineKeyboard }): Promise<void> {
    const form: Record<string, unknown> = { chat_id: p.chatId, message_id: p.messageId, text: p.text };
    if (p.replyMarkup) form.reply_markup = inlineKeyboardToJson(p.replyMarkup);
    await this.call("editMessageText", form);
  }

  async editMessageCaption(p: { chatId: number; messageId: number; caption?: string; replyMarkup?: InlineKeyboard }): Promise<void> {
    const form: Record<string, unknown> = { chat_id: p.chatId, message_id: p.messageId };
    if (p.caption !== undefined) form.caption = p.caption;
    if (p.replyMarkup) form.reply_markup = inlineKeyboardToJson(p.replyMarkup);
    await this.call("editMessageCaption", form);
  }

  async createForumTopic(p: { chatId: number; name: string }): Promise<number> {
    const res = await this.call<{ message_thread_id: number }>("createForumTopic", { chat_id: p.chatId, name: p.name });
    return res.message_thread_id;
  }

  async editForumTopic(p: { chatId: number; messageThreadId: number; name: string }): Promise<void> {
    await this.call("editForumTopic", { chat_id: p.chatId, message_thread_id: p.messageThreadId, name: p.name });
  }

  async hideForumTopic(p: { chatId: number; messageThreadId: number }): Promise<void> {
    // Closing is the hide: the topic leaves the active list and its topic icon
    // disappears from the general view where the API supports it.
    await this.call("closeForumTopic", { chat_id: p.chatId, message_thread_id: p.messageThreadId });
  }

  async restoreForumTopic(p: { chatId: number; messageThreadId: number }): Promise<void> {
    await this.call("reopenForumTopic", { chat_id: p.chatId, message_thread_id: p.messageThreadId });
  }

  async deleteForumTopic(p: { chatId: number; messageThreadId: number }): Promise<void> {
    await this.call("deleteForumTopic", { chat_id: p.chatId, message_thread_id: p.messageThreadId });
  }

  async answerCallbackQuery(p: { callbackQueryId: string; text?: string; showAlert?: boolean }): Promise<void> {
    const form: Record<string, unknown> = { callback_query_id: p.callbackQueryId };
    if (p.text !== undefined) form.text = p.text;
    if (p.showAlert !== undefined) form.show_alert = p.showAlert;
    await this.call("answerCallbackQuery", form);
  }

  async setMyCommands(p: { commands: BotCommand[]; scope?: BotCommandScope; languageCode?: string }): Promise<void> {
    // `encode` JSON-stringifies non-string values, so a form-encoded body
    // carries commands and the (nested) scope exactly as the Bot API wants.
    const form: Record<string, unknown> = { commands: p.commands };
    if (p.scope !== undefined) form.scope = p.scope;
    if (p.languageCode !== undefined) form.language_code = p.languageCode;
    await this.call("setMyCommands", form);
  }

  // -------------------------------------------------------------------------

  private mediaForm(
    kind: "photo" | "video" | "document" | "audio" | "voice" | "sticker",
    target: SendTarget & { fileId: string; caption?: string },
  ): Record<string, unknown> {
    const form: Record<string, unknown> = {};
    const key = kind === "sticker" ? "sticker" : kind;
    form[key] = target.fileId;
    if (target.caption !== undefined) form.caption = target.caption;
    this.withTarget(form, target);
    return form;
  }

  private withTarget(form: Record<string, unknown>, target: SendTarget): void {
    form.chat_id = target.chatId;
    if (target.messageThreadId !== undefined) form.message_thread_id = target.messageThreadId;
    if (target.replyToMessageId !== undefined) form.reply_to_message_id = target.replyToMessageId;
  }

  private async callNumber(method: string, form: Record<string, unknown>): Promise<number> {
    const res = await this.call<{ message_id: number }>(method, form);
    return res.message_id;
  }

  private async call<T>(method: string, form: Record<string, unknown>): Promise<T> {
    return this.request<T>(method, this.encode(form), { "Content-Type": "application/x-www-form-urlencoded" });
  }

  private async request<T>(method: string, body: string | URLSearchParams, headers: Record<string, string>): Promise<T> {
    const url = `${API_BASE}${this.botToken}/${method}`;
    const deadline = Date.now() + TOTAL_RETRY_BUDGET_MS;
    let attempt = 0;
    for (;;) {
      let bodyOut: BotApiOkBody | BotApiErrorBody;
      let status = 0;
      try {
        const response = await this.fetchFn(url, {
          method: "POST",
          body,
          headers,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        status = response.status;
        bodyOut = (await response.json()) as BotApiOkBody | BotApiErrorBody;
      } catch (err) {
        const wrapped = new TgError(`network failure calling ${method}`, { kind: "network", cause: err });
        if (attempt < this.retries && this.canWait(this.backoffMs(attempt + 1, undefined), deadline)) {
          attempt += 1;
          await sleep(this.backoffMs(attempt, undefined));
          continue;
        }
        throw wrapped;
      }

      if (bodyOut.ok) {
        return (bodyOut as BotApiOkBody).result as T;
      }

      const err = this.mapError(method, bodyOut, status);
      if (err.isRetryable() && attempt < this.retries && this.canWait(this.backoffMs(attempt + 1, err.retryAfter), deadline)) {
        attempt += 1;
        await sleep(this.backoffMs(attempt, err.retryAfter));
        continue;
      }
      throw err;
    }
  }

  /** True when `ms` of backoff still fits inside the cumulative retry budget. */
  private canWait(ms: number, deadline: number): boolean {
    return Date.now() + ms <= deadline;
  }

  private mapError(method: string, body: BotApiErrorBody, status: number): TgError {
    const code = body.error_code ?? status;
    const description = body.description ?? `unknown error calling ${method}`;

    if (code === 429) {
      return new TgError(description, {
        kind: "rate_limited",
        retryAfter: body.parameters?.retry_after,
        httpStatus: 429,
      });
    }

    // Recoverable topic states surface as distinguishable kinds so core can
    // recreate or restore and retry instead of treating them as plain 400s.
    if (/message thread is closed|topic is closed|forum topic is closed/i.test(description)) {
      return new TgError(description, { kind: "topic_closed", httpStatus: code });
    }
    if (/message thread not found|topic not found/i.test(description)) {
      return new TgError(description, { kind: "topic_not_found", httpStatus: code });
    }

    switch (code) {
      case 400:
        return new TgError(description, { kind: "bad_request", httpStatus: 400 });
      case 401:
        return new TgError(description, { kind: "unauthorized", httpStatus: 401 });
      case 403:
        return new TgError(description, { kind: "forbidden", httpStatus: 403 });
      case 404:
        return new TgError(description, { kind: "not_found", httpStatus: 404 });
      case 409:
        return new TgError(description, { kind: "conflict", httpStatus: 409 });
      default:
        if (status >= 500) {
          return new TgError(description, { kind: "retryable_server", httpStatus: status });
        }
        return new TgError(description, { kind: "unexpected", httpStatus: status });
    }
  }

  private encode(form: Record<string, unknown>): URLSearchParams {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(form)) {
      if (value === undefined) continue;
      params.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }
    return params;
  }

  private backoffMs(attempt: number, retryAfterSeconds: number | undefined): number {
    if (retryAfterSeconds !== undefined) {
      return Math.min(retryAfterSeconds * 1000, MAX_429_WAIT_MS);
    }
    return this.baseBackoffMs * 2 ** (attempt - 1);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
