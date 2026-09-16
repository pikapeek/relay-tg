// Outbound inline-keyboard shapes used by the TelegramClient port.
export interface InlineKeyboardButton {
  text: string;
  /** Callback payload — omit when the button is a plain url link. */
  callbackData?: string;
  /** HTTP / tg:// URL opened when the button is pressed (e.g. tg://user?id=<user_id>). */
  url?: string;
}

/** A single-row inline keyboard. */
export interface InlineKeyboard {
  buttons: InlineKeyboardButton[];
}

/** One entry in the bot command menu (Bot API `setMyCommands`). */
export interface BotCommand {
  command: string;
  description: string;
}

/** Bot API `BotCommandScope` for `setMyCommands` — narrowed to the scopes RelayTG uses.
 *  Precedence (most specific wins): default < all_private_chats < all_group_chats
 *  < all_chat_administrators < chat < chat_administrators < chat_member.
 *  A `chat` scope keyed by a user id addresses that user's private chat with
 *  the bot, which lets RelayTG give staff a full role menu while everyone else
 *  sees the /start-only public menu. */
export type BotCommandScope =
  | { type: "default" }
  | { type: "all_private_chats" }
  | { type: "chat"; chat_id: number }
  | { type: "chat_administrators"; chat_id: number }
  | { type: "chat_member"; chat_id: number; user_id: number };
