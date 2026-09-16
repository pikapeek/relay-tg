// ---------------------------------------------------------------------------
// Core services barrel + composition. buildServices(ctx) wires everything the
// relay pipeline and both runtimes depend on.
// ---------------------------------------------------------------------------

export type { ServiceContext } from "./service-context.ts";
export { TEXTS, OPERATOR_TEXTS, resolveLanguage } from "./texts.ts";
export type { Language } from "./texts.ts";
export {
  USER_COMMANDS,
  USER_COMMANDS_ZH,
  OPERATOR_COMMANDS,
  OPERATOR_COMMANDS_ZH,
  ADMIN_COMMANDS,
  ADMIN_COMMANDS_ZH,
  setCommandMenu,
  applyUserMenu,
  syncPreferredLanguageMenus,
} from "./command-menu.ts";
export type { UserMenuChoice } from "./command-menu.ts";
export { generateArithmeticQuestion, shuffle } from "./arithmetic.ts";
export type { ArithmeticChallenge } from "./arithmetic.ts";
export { UserService } from "./user-service.ts";
export { TopicService } from "./topic-service.ts";
export { ConversationService } from "./conversation-service.ts";
export { OperatorService } from "./operator-service.ts";
export { VerificationService } from "./verification-service.ts";
export type { AnswerOutcome } from "./verification-service.ts";
export { ApprovalService } from "./approval-service.ts";
export type { ApplyOutcome, DecideOutcome } from "./approval-service.ts";
export { HideService } from "./hide-service.ts";
export { MessageService } from "./message-service.ts";
export { SpamService } from "./spam-service.ts";
export type { SpamCheckResult, ContentCheckResult } from "./spam-service.ts";
export { AdDetectionService } from "./ad-service.ts";
export type { AdCheckResult } from "./ad-service.ts";
export { QuarantineService } from "./quarantine-service.ts";
export type { QuarantinedMessage, QuarantineEntry } from "./quarantine-service.ts";
export { PendingService, PENDING_MAX } from "./pending-service.ts";
export type { PendingEntry } from "./pending-service.ts";
export { Relayer } from "./relayer.ts";
export { MediaGroupService, MEDIA_GROUP_WINDOW_MS } from "./media-group-service.ts";
export { SelfCheckService } from "./selfcheck-service.ts";
export type { SelfCheckProbe, SelfCheckReport } from "./selfcheck-service.ts";
export { CommandService } from "./command-service.ts";
export type { CommandsDeps } from "./command-service.ts";
export { UpdateProcessor } from "./update-processor.ts";
export type { ProcessDeps } from "./update-processor.ts";

import type { ServiceContext } from "./service-context.ts";
import { setCommandMenu, applyUserMenu, type UserMenuChoice } from "./command-menu.ts";
import { UserService } from "./user-service.ts";
import { TopicService } from "./topic-service.ts";
import { ConversationService } from "./conversation-service.ts";
import { OperatorService } from "./operator-service.ts";
import { VerificationService } from "./verification-service.ts";
import { ApprovalService } from "./approval-service.ts";
import { HideService } from "./hide-service.ts";
import { MessageService } from "./message-service.ts";
import { SpamService } from "./spam-service.ts";
import { AdDetectionService } from "./ad-service.ts";
import { QuarantineService } from "./quarantine-service.ts";
import { PendingService } from "./pending-service.ts";
import { Relayer } from "./relayer.ts";
import { MediaGroupService } from "./media-group-service.ts";
import { SelfCheckService } from "./selfcheck-service.ts";
import { CommandService } from "./command-service.ts";
import { UpdateProcessor } from "./update-processor.ts";

export interface CoreServices {
  users: UserService;
  topics: TopicService;
  conversations: ConversationService;
  operators: OperatorService;
  verification: VerificationService;
  approvals: ApprovalService;
  hides: HideService;
  messages: MessageService;
  spam: SpamService;
  ad: AdDetectionService;
  quarantine: QuarantineService;
  pending: PendingService;
  relayer: Relayer;
  mediaGroups: MediaGroupService;
  selfCheck: SelfCheckService;
  commands: CommandService;
  processor: UpdateProcessor;
}

/** Wire every core service against one injected context. */
export function buildServices(ctx: ServiceContext): CoreServices {
  const users = new UserService(ctx);
  const topics = new TopicService(ctx);
  const conversations = new ConversationService(ctx, topics);
  const operators = new OperatorService(ctx);
  const verification = new VerificationService(ctx);
  // Menu registration reads the live operator registry, so an approval that
  // promotes someone to OPERATOR can re-register with the updated roster.
  const refreshMenus = (): Promise<void> => setCommandMenu(ctx.telegram, ctx.config, ctx.logger, () => operators.list());
  const approvals = new ApprovalService(ctx, conversations, (id) => operators.isAdmin(id), refreshMenus);
  const hides = new HideService(ctx);
  const messages = new MessageService(ctx);
  const spam = new SpamService(ctx.config.spam);
  const ad = new AdDetectionService(ctx);
  const quarantine = new QuarantineService(ctx);
  const pending = new PendingService(ctx);
  const relayer = new Relayer(ctx, { users, topics, conversations }, messages);
  const mediaGroups = new MediaGroupService(ctx, relayer);
  const selfCheck = new SelfCheckService(ctx);
  // A /lang change re-applies just that user's menus (role-aware) so the
  // suggestion menu follows the stored preference, not just the client language.
  const syncUserMenu = (telegramUserId: number, lang: UserMenuChoice): Promise<void> =>
    applyUserMenu(ctx.telegram, ctx.config, ctx.logger, () => operators.list(), telegramUserId, lang);
  const commands = new CommandService(ctx, { users, conversations, operators, hides, syncUserMenu, selfCheck, ad, topics, quarantine });
  const processor = new UpdateProcessor(
    ctx,
    { users, conversations, operators, verification, approvals, hides, spam, ad, quarantine, pending, commands, topics, syncUserMenu, mediaGroups, selfCheck },
    relayer,
  );
  return { users, topics, conversations, operators, verification, approvals, hides, messages, spam, ad, quarantine, pending, relayer, mediaGroups, selfCheck, commands, processor };
}