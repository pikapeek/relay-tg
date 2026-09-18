// ---------------------------------------------------------------------------
// Production runtime helpers, shared by the Docker and Cloudflare runtimes.
// Core stays platform-neutral: these use only language built-ins, so the same
// classes power both stacks.
// ---------------------------------------------------------------------------

import type { Runtime, Serializer, VerificationState, VerificationStore } from "./ports.ts";

/** Wall-clock runtime: real timestamps, opaque random ids. */
export class WallClockRuntime implements Runtime {
  private readonly randomFn: () => string;

  constructor(randomFn: () => string = defaultRandomId) {
    this.randomFn = randomFn;
  }

  now(): Date {
    return new Date();
  }

  randomId(): string {
    return this.randomFn();
  }

  schedule(delayMs: number, callback: () => void): void {
    setTimeout(callback, delayMs);
  }
}

function defaultRandomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Transient verification challenge store (D14). In-memory by design: a
 *  restart only loses in-flight challenges. Identical on both runtimes. */
export class InMemoryVerificationStore implements VerificationStore {
  /** Composite key `${botId}:${telegramUserId}` — independent per bot. */
  private readonly states = new Map<string, VerificationState>();

  async get(botId: string, telegramUserId: number): Promise<VerificationState | null> {
    return this.states.get(`${botId}:${telegramUserId}`) ?? null;
  }

  async set(botId: string, telegramUserId: number, state: VerificationState): Promise<void> {
    this.states.set(`${botId}:${telegramUserId}`, state);
  }

  async delete(botId: string, telegramUserId: number): Promise<void> {
    this.states.delete(`${botId}:${telegramUserId}`);
  }
}

/** Docker-path serializer (task 7.5): an in-process keyed mutex. Chain promises
 *  per key so per-conversation ingestion never interleaves. */
export class KeyedMutexSerializer implements Serializer {
  private readonly chains = new Map<string, Promise<unknown>>();

  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    // A rejected run must never poison the chain: the next run on this key
    // reads `prev`, so swallow the previous outcome before chaining fn. The
    // caller still receives fn's own result/error via `next`.
    const gate = prev.then(() => undefined, () => undefined);
    const next = gate.then(fn);
    // Track the swallowing promise; once it settles, drop the chain — but only
    // if a newer run hasn't already replaced it (a stale finally must never
    // delete the live chain of a subsequent run on the same key).
    const tracked = next.catch(() => undefined).finally(() => {
      if (this.chains.get(key) === tracked) this.chains.delete(key);
    });
    this.chains.set(key, tracked);
    return next;
  }
}

/** Cloudflare-path serializer: a no-op. The DO queue already delivers updates
 *  strictly serially per instance, so there is nothing to mutex here. */
export const immediateSerializer: Serializer = {
  runExclusive<T>(_key: string, fn: () => Promise<T>): Promise<T> {
    return fn();
  },
};