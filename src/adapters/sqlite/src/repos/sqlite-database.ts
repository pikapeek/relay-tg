// ---------------------------------------------------------------------------
// SqliteDatabase (tasks 10.3-10.4): the core `Database` port implemented over
// the shared SqlDb surface, composing one repository class per domain. This
// module is platform-neutral — it never imports node:sqlite or the DO storage —
// so both runtimes (Docker via node-sqlite-db, Cloudflare via the DO wrapper)
// build the same repository layer.
// ---------------------------------------------------------------------------

import type {
  ApplicationRepository,
  BlockRepository,
  ConversationRepository,
  Database,
  MessageRepository,
  NoteRepository,
  OperatorRepository,
  ProcessedUpdatesRepository,
  SettingsRepository,
  UserRepository,
} from "@relaytg/core";
import type { SqlDb } from "../sql-db.ts";
import { SqliteUsers } from "./users.ts";
import { SqliteConversations } from "./conversations.ts";
import { SqliteMessages } from "./messages.ts";
import { SqliteOperators } from "./operators.ts";
import { SqliteNotes } from "./notes.ts";
import { SqliteBlocks } from "./blocks.ts";
import { SqliteApplications } from "./applications.ts";
import { SqliteProcessedUpdates } from "./processed-updates.ts";
import { SqliteSettings } from "./settings.ts";

export class SqliteDatabase implements Database {
  readonly users: UserRepository;
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  readonly operators: OperatorRepository;
  readonly notes: NoteRepository;
  readonly blocks: BlockRepository;
  readonly applications: ApplicationRepository;
  readonly processedUpdates: ProcessedUpdatesRepository;
  readonly settings: SettingsRepository;

  constructor(private readonly sql: SqlDb) {
    this.users = new SqliteUsers(sql);
    this.conversations = new SqliteConversations(sql);
    this.messages = new SqliteMessages(sql);
    this.operators = new SqliteOperators(sql);
    this.notes = new SqliteNotes(sql);
    this.blocks = new SqliteBlocks(sql);
    this.applications = new SqliteApplications(sql);
    this.processedUpdates = new SqliteProcessedUpdates(sql);
    this.settings = new SqliteSettings(sql);
  }

  /** The underlying SqlDb owns transaction semantics: node:sqlite brackets with
   *  BEGIN/COMMIT/ROLLBACK; the DO binding runs the unit as-is (per-instance
   *  serialization already isolates requests). The same Database instance backs
   *  every transactional view. */
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return this.sql.transaction(async () => fn(this));
  }
}
