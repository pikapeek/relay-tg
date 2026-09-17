// ---------------------------------------------------------------------------
// In-memory fakes for the core ports. These are the test doubles for the
// service and pipeline unit tests and for both integration suites (task 13).
// They mirror the storage spec's repository behavior so the real adapters in
// task 10 are tested against the same expectations.
//
// The fake TelegramClient also simulates realistic topic behavior: sending
// into a missing thread throws `topic_not_found`, into a closed thread throws
// `topic_closed`, and hide/restore/delete on a missing thread throw too.
//
// This file is a barrel (package subpath "./testing") so imports stay stable;
// the fakes themselves live in ./testing/.
// ---------------------------------------------------------------------------

export * from "./testing/fake-runtime.ts";
export * from "./testing/memory-database.ts";
export * from "./testing/fake-telegram-client.ts";

// ---------------------------------------------------------------------------
// Serializers (task 7.5) and the verification store — shared with production
// (platform.ts); re-exported here as aliases so tests keep importing them from
// the harness module.
// ---------------------------------------------------------------------------

export { KeyedMutexSerializer, immediateSerializer } from "./platform.ts";
export { InMemoryVerificationStore as MemoryVerificationStore } from "./platform.ts";

// ---------------------------------------------------------------------------
// Record shapes the fakes store (kept so tests can import the type).
// ---------------------------------------------------------------------------

export type { ConversationRecord, UserRecord, MessageRecord } from "@relaytg/shared";