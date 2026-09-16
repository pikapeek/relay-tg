// ---------------------------------------------------------------------------
// OperatorService (task 8.1): the operator registry and role checks.
// Roles are granted by telegram_user_id only — username grants nothing.
// The registry is seeded at boot from ADMIN_IDS + OPERATOR_IDS; when an id
// appears in both, ADMIN wins (admins are upserted last).
// ---------------------------------------------------------------------------

import type { OperatorRecord, OperatorRole, Config } from "@relaytg/shared";
import type { Database, Runtime } from "../ports.ts";
import type { ServiceContext } from "./service-context.ts";

export class OperatorService {
  private readonly db: Database;
  private readonly runtime: Runtime;
  private readonly config: Config;

  constructor(ctx: ServiceContext) {
    this.db = ctx.db;
    this.runtime = ctx.runtime;
    this.config = ctx.config;
  }

  async seed(): Promise<void> {
    const now = this.runtime.now();
    for (const id of this.config.operatorIds) {
      await this.db.operators.upsert({ telegramUserId: id, role: "OPERATOR" }, now);
    }
    for (const id of this.config.adminIds) {
      await this.db.operators.upsert({ telegramUserId: id, role: "ADMIN" }, now);
    }
  }

  async isAdmin(telegramUserId: number): Promise<boolean> {
    return (await this.getRole(telegramUserId)) === "ADMIN";
  }

  async isOperator(telegramUserId: number): Promise<boolean> {
    return (await this.getRole(telegramUserId)) != null;
  }

  async getRole(telegramUserId: number): Promise<OperatorRole | null> {
    const op = await this.db.operators.getByTelegramUserId(telegramUserId);
    return op?.role ?? null;
  }

  /** The full operator registry, for command-menu registration. */
  async list(): Promise<OperatorRecord[]> {
    return this.db.operators.list();
  }

  /**
   * Resolve `@username` or a numeric id to a registered operator.
   * Username is only a display convenience — it never authorizes by itself.
   */
  async resolveByTarget(target: string): Promise<OperatorRecord | null> {
    const trimmed = target.trim();
    if (/^-?\d+$/.test(trimmed)) {
      return this.db.operators.getByTelegramUserId(Number(trimmed));
    }
    if (trimmed.startsWith("@")) {
      const user = await this.db.users.getByUsername(trimmed.slice(1));
      if (!user) return null;
      return this.db.operators.getByTelegramUserId(user.telegramUserId);
    }
    return null;
  }
}
