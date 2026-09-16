// ---------------------------------------------------------------------------
// Outbound mapper: unified internal MessageContent -> Bot API send params.
// Keeps content-type dispatch in one place so core never sees Bot API shapes.
// ---------------------------------------------------------------------------

import type { MessageContent } from "@relaytg/shared";
import type { InlineKeyboard } from "@relaytg/core";

export type BotSendMethod =
  | "sendMessage"
  | "sendPhoto"
  | "sendVideo"
  | "sendDocument"
  | "sendAudio"
  | "sendVoice"
  | "sendSticker";

/** The send* endpoint for a given unified content type. */
export function contentToMethod(content: MessageContent): BotSendMethod {
  switch (content.type) {
    case "text":
      return "sendMessage";
    case "photo":
      return "sendPhoto";
    case "video":
      return "sendVideo";
    case "document":
      return "sendDocument";
    case "audio":
      return "sendAudio";
    case "voice":
      return "sendVoice";
    case "sticker":
      return "sendSticker";
  }
}

/** Content-specific form fields (file_id forwarding — media bytes never flow through us). */
export function contentToForm(content: MessageContent): Record<string, string | number> {
  switch (content.type) {
    case "text":
      return { text: content.text };
    case "photo":
      return { photo: content.fileId, ...(content.caption ? { caption: content.caption } : {}) };
    case "video":
      return { video: content.fileId, ...(content.caption ? { caption: content.caption } : {}) };
    case "document":
      return { document: content.fileId, ...(content.caption ? { caption: content.caption } : {}) };
    case "audio":
      return { audio: content.fileId, ...(content.caption ? { caption: content.caption } : {}) };
    case "voice":
      return { voice: content.fileId, ...(content.caption ? { caption: content.caption } : {}) };
    case "sticker":
      return { sticker: content.fileId };
  }
}

/** Serialize an inline keyboard into the Bot API reply_markup JSON. */
export function inlineKeyboardToJson(keyboard: InlineKeyboard): string {
  return JSON.stringify({
    inline_keyboard: keyboard.buttons.map((b) => {
      const row: Record<string, string> = { text: b.text };
      if (b.callbackData !== undefined) row.callback_data = b.callbackData;
      if (b.url !== undefined) row.url = b.url;
      return [row];
    }),
  });
}

/** A single row of one button each keeps choice buttons tappable on mobile. */
export function singleColumnKeyboard(buttons: Array<{ text: string; callbackData: string }>): InlineKeyboard {
  return { buttons };
}
