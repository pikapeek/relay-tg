// Core-facing re-export of the internal event vocabulary. Events themselves are
// defined in shared so the Telegram adapter can emit them without depending on
// core; this module is a convenience barrel for core consumers.
export type {
  InboundEvent,
  UserMessageEvent,
  OperatorMessageEvent,
  EditedUserMessageEvent,
  EditedOperatorMessageEvent,
  VerificationAnswerEvent,
  ApplicationDecisionEvent,
  IgnoredEvent,
  ProcessResult,
  ProcessStatus,
} from "@relaytg/shared";
