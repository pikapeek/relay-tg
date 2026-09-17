// ---------------------------------------------------------------------------
// SqliteProcessedUpdates: the core ProcessedUpdatesRepository over SqlDb.
// ---------------------------------------------------------------------------

import type { ProcessedUpdatesRepository } from "@relaytg/core";
import type { SqlDb } from "../sql-db.ts";
import { iso, newId } from "./mapping.ts";

export class SqliteProcessedUpdates implements ProcessedUpdatesRepository {
  constructor(private readonly sql: SqlDb) {}

  /** Claim an update_id before processing. The INSERT OR IGNORE writes the row
   *  exactly once; the per-claim nonce distinguishes the inserting claim from a
   *  duplicate (which keeps its own nonce in the row), independent of the
   *  runtime clock. */
  async claim(updateId: number, now: Date): Promise<boolean> {
    const claimId = newId();
    this.sql
      .prepare("INSERT OR IGNORE INTO processed_updates (update_id, claim_id, processed_at) VALUES (?, ?, ?)")
      .run(updateId, claimId, iso(now));
    const check = this.sql
      .prepare("SELECT COUNT(*) AS c FROM processed_updates WHERE update_id = ? AND claim_id = ?")
      .get(updateId, claimId);
    return check != null && Number(check.c) === 1;
  }
}
