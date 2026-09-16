// ---------------------------------------------------------------------------
// Internal events: the vocabulary between the Telegram adapter (parser) and
// core. Core never sees a raw Telegram Update; the adapter never sees domain
// state. These live in shared so both sides compile against the same contract.
// ---------------------------------------------------------------------------

import type { MessageContent, UserProfile } from "./types.ts";

export interface UserMessageEvent {
  kind: "user_message";
  /** User's private chat id. */
  chatId: number;
  /** Message id where the message was created (user side). */
  messageId: number;
  sender: UserProfile;
  content: MessageContent;
  replyToMessageId: number | null;
  /** Present on media-group items; every item is relayed individually. */
  mediaGroupId: string | null;
}

export interface OperatorMessageEvent {
  kind: "operator_message";
  /** Support-group chat id. */
  chatId: number;
  messageId: number;
  /** Forum topic id; null when posted in the group's general chat. */
  messageThreadId: number | null;
  sender: UserProfile;
  content: MessageContent;
  replyToMessageId: number | null;
}

export interface EditedUserMessageEvent {
  kind: "edited_user_message";
  chatId: number;
  messageId: number;
  sender: UserProfile;
  content: MessageContent;
}

export interface EditedOperatorMessageEvent {
  kind: "edited_operator_message";
  chatId: number;
  messageId: number;
  messageThreadId: number | null;
  sender: UserProfile;
  content: MessageContent;
}

export interface VerificationAnswerEvent {
  kind: "verification_answer";
  callbackQueryId: string;
  chatId: number;
  messageId: number;
  sender: UserProfile;
  /** The integer the user tapped (`verify:<answer>`). */
  answer: number;
}

export interface ApplicationDecisionEvent {
  kind: "application_decision";
  callbackQueryId: string;
  chatId: number;
  messageId: number;
  sender: UserProfile;
  decision: "approve" | "reject";
  applicationId: string;
}

export interface ConversationDeleteEvent {
  kind: "conversation_delete";
  callbackQueryId: string;
  /** Chat (private chat or support group) the picker message lives in. */
  chatId: number;
  /** Message id of the picker message, to re-render after the delete. */
  messageId: number;
  sender: UserProfile;
  conversationId: string;
}

export interface IgnoredEvent {
  kind: "ignored";
  reason: string;
}

export type InboundEvent =
  | UserMessageEvent
  | OperatorMessageEvent
  | EditedUserMessageEvent
  | EditedOperatorMessageEvent
  | VerificationAnswerEvent
  | ApplicationDecisionEvent
  | ConversationDeleteEvent
  | IgnoredEvent;

/** Outcome of processing one update. */
export type ProcessStatus =
  | "duplicate"
  | "ignored"
  | "processed"
  | "blocked"
  | "rate_limited"
  | "message_rejected"
  | "verification_issued"
  | "purpose_pending"
  | "command_handled"
  | "error";

export interface ProcessResult {
  status: ProcessStatus;
  conversationId?: string;
}
