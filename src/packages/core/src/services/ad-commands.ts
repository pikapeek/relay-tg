// ---------------------------------------------------------------------------
// AdCommands: the admin /ad surface — blocklist add/del/list, the allowlist
// (`/ad allow`), the link-count rule (`/ad links`) and quarantine recovery
// (`/ad restore`). Split out of CommandService so command dispatch stays a thin
// facade. Admin-only; the individual handlers reachable anywhere in the group.
// ---------------------------------------------------------------------------

import type { OperatorMessageEvent } from "@relaytg/shared";
import type { ServiceContext } from "./service-context.ts";
import { OPERATOR_TEXTS, type OperatorTexts } from "./texts.ts";
import { CommandBase, type CommandsDeps } from "./command-base.ts";

export class AdCommands extends CommandBase {
  constructor(ctx: ServiceContext, deps: CommandsDeps) {
    super(ctx, deps);
  }

  /** /ad — admin-only runtime ad management: blocklist add/del/list, allowlist
   *  management (`/ad allow`), the link-count rule (`/ad links`), and
   *  quarantine recovery (`/ad restore` — reply to a quarantined copy). The
   *  blocklist is also seeded from AD_KEYWORDS at boot. */
  async ad(senderId: number, args: string[], event: OperatorMessageEvent): Promise<void> {
    const t = OPERATOR_TEXTS(await this.deps.users.effectiveLanguageOf(event.sender));
    if (!(await this.deps.operators.isAdmin(senderId))) {
      await this.send(event, t.adminOnly);
      this.logger.info("command_rejected", { telegramUserId: senderId, status: "admin_only:/ad" });
      return;
    }
    const [action, ...rest] = args;
    const word = rest.join(" ").trim();
    switch (action) {
      case undefined:
      case "list": {
        const keywords = await this.deps.ad.listKeywords();
        const links = await this.deps.ad.getMaxLinks();
        const lines = keywords.length > 0 ? [t.adListHeader(keywords.length), ...keywords] : [t.adEmpty];
        lines.push(links > 0 ? t.adLinksCurrent(links) : t.adLinksOff);
        await this.send(event, lines.join("\n"));
        break;
      }
      case "allow": {
        await this.adAllow(rest, event, t);
        break;
      }
      case "links": {
        await this.adLinks(rest, event, t);
        break;
      }
      case "restore": {
        await this.adRestore(event, t);
        break;
      }
      case "add": {
        if (word.length === 0) {
          await this.send(event, t.adUsage);
          return;
        }
        await this.deps.ad.addKeyword(word);
        await this.send(event, t.adAdded(word));
        break;
      }
      case "del": {
        if (word.length === 0) {
          await this.send(event, t.adUsage);
          return;
        }
        const removed = await this.deps.ad.removeKeyword(word);
        await this.send(event, removed ? t.adRemoved(word) : t.adEmpty);
        break;
      }
      default:
        await this.send(event, t.adUsage);
    }
    this.logger.info("command_executed", { telegramUserId: senderId, status: "/ad", kind: action ?? "list" });
  }

  /** /ad allow — runtime allowlist (an allow match overrides the blocklist:
   *  a keyword on both lists clears the message). */
  async adAllow(rest: string[], event: OperatorMessageEvent, t: OperatorTexts): Promise<void> {
    const [sub, ...subArgs] = rest;
    const word = subArgs.join(" ").trim();
    switch (sub) {
      case undefined:
      case "list": {
        const allow = await this.deps.ad.listAllowKeywords();
        await this.send(event, allow.length === 0 ? t.adAllowEmpty : [t.adAllowListHeader(allow.length), ...allow].join("\n"));
        return;
      }
      case "add": {
        if (word.length === 0) {
          await this.send(event, t.adAllowUsage);
          return;
        }
        await this.deps.ad.addAllowKeyword(word);
        await this.send(event, t.adAllowAdded(word));
        return;
      }
      case "del": {
        if (word.length === 0) {
          await this.send(event, t.adAllowUsage);
          return;
        }
        const removed = await this.deps.ad.removeAllowKeyword(word);
        await this.send(event, removed ? t.adAllowRemoved(word) : t.adAllowEmpty);
        return;
      }
      default:
        await this.send(event, t.adAllowUsage);
    }
  }

  /** /ad links — set/clear the link-count rule (`/ad links 3`, `/ad links
   *  off`), or show the current value with no argument. */
  async adLinks(rest: string[], event: OperatorMessageEvent, t: OperatorTexts): Promise<void> {
    if (rest.length === 0) {
      const current = await this.deps.ad.getMaxLinks();
      await this.send(event, current > 0 ? t.adLinksCurrent(current) : t.adLinksOff);
      return;
    }
    const raw = rest.join(" ").trim().toLowerCase();
    if (raw === "off" || raw === "0") {
      await this.deps.ad.setMaxLinks(0);
      await this.send(event, t.adLinksSet("off"));
      return;
    }
    if (/^\d+$/.test(raw) && Number(raw) > 0) {
      const n = Number(raw);
      await this.deps.ad.setMaxLinks(n);
      await this.send(event, t.adLinksSet(String(n)));
      return;
    }
    await this.send(event, t.adLinksUsage);
  }

  /** /ad restore — reply to a quarantined copy in the quarantine topic to
   *  forward it back into the sender's conversation. Only the message is
   *  recovered; unblocking stays a separate /unban. */
  async adRestore(event: OperatorMessageEvent, t: OperatorTexts): Promise<void> {
    if (event.replyToMessageId == null) {
      await this.send(event, t.adRestoreUsage);
      return;
    }
    const entry = await this.deps.quarantine.lookup(event.replyToMessageId);
    if (!entry) {
      await this.send(event, t.adRestoreNotFound);
      return;
    }
    // A first-contact ad auto-block may have zero user rows — ensure the user
    // (minimal profile) and open their conversation before the restore.
    let user = await this.deps.users.getByTelegramUserId(entry.userId);
    if (!user) {
      const result = await this.deps.users.getOrCreate({
        telegramUserId: entry.userId,
        username: null,
        firstName: String(entry.userId),
        lastName: null,
        languageCode: null,
        isBot: false,
      });
      user = result.user;
    }
    const conversation = await this.deps.conversations.grantAccess(user);
    await this.deps.quarantine.restore(entry, conversation);
    await this.send(event, t.adRestoreDone);
  }
}