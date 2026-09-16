// ---------------------------------------------------------------------------
// SelfCheckService (boot config self-check). Verifies the three things a
// misconfigured deployment would get wrong before traffic arrives: the token
// resolves to a bot (getMe), the support group exists and is a forum (getChat),
// and the bot is an administrator there (getChatMember). Never throws — every
// probe is isolated, and the caller logs the report at boot / sends it to an
// admin on request.
// ---------------------------------------------------------------------------

import type { Config } from "@relaytg/shared";
import type { TelegramClient } from "../ports.ts";
import type { ServiceContext } from "./service-context.ts";

export interface SelfCheckProbe {
  ok: boolean;
  /** True when an earlier probe failure made this check meaningless (rendered
   *  differently from a real failure in the report). */
  skipped?: boolean;
  detail: string;
}

export interface SelfCheckReport {
  bot: SelfCheckProbe;
  group: SelfCheckProbe;
  admin: SelfCheckProbe;
  allOk: boolean;
}

export class SelfCheckService {
  private readonly telegram: TelegramClient;
  private readonly config: Config;

  constructor(ctx: ServiceContext) {
    this.telegram = ctx.telegram;
    this.config = ctx.config;
  }

  async run(): Promise<SelfCheckReport> {
    const botIdentity = { id: 0, username: "" };
    const bot = await this.probe(async () => {
      const me = await this.telegram.getMe();
      botIdentity.id = me.id;
      botIdentity.username = me.username;
      return { ok: true, detail: `@${me.username}` };
    });
    if (!bot.ok) {
      // A bad token makes the remaining probes meaningless; skip them rather
      // than firing calls that would all fail with 401.
      const skipped: SelfCheckProbe = { ok: false, skipped: true, detail: "skipped" };
      return { bot, group: skipped, admin: skipped, allOk: false };
    }
    const group = await this.probe(async () => {
      const chat = await this.telegram.getChat({ chatId: this.config.supportGroupId });
      if (chat.is_forum) return { ok: true, detail: "forum" };
      return { ok: false, detail: "not a forum" };
    });
    const admin = group.ok
      ? await this.probe(async () => {
          const member = await this.telegram.getChatMember({
            chatId: this.config.supportGroupId,
            userId: botIdentity.id,
          });
          if (member.status === "administrator" || member.status === "creator") {
            return { ok: true, detail: member.status };
          }
          return { ok: false, detail: member.status };
        })
      : { ok: false, skipped: true, detail: "skipped" };
    return { bot, group, admin, allOk: bot.ok && group.ok && admin.ok };
  }

  private async probe(fn: () => Promise<SelfCheckProbe>): Promise<SelfCheckProbe> {
    try {
      return await fn();
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
