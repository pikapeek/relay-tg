// ---------------------------------------------------------------------------
// FakeRuntime + CaptureLogger: the test doubles for the Runtime and Logger
// ports, used by the service/pipeline unit suites and both integration suites.
// ---------------------------------------------------------------------------

import type { Logger, LogEvent, LogFields } from "@relaytg/shared";
import type { Runtime } from "../ports.ts";

export class FakeRuntime implements Runtime {
  private timeMs: number;
  private idCounter = 0;
  private timers: Array<{ at: number; callback: () => void; seq: number }> = [];
  private timerSeq = 0;

  constructor(initialMs = 1_700_000_000_000) {
    this.timeMs = initialMs;
  }

  now(): Date {
    return new Date(this.timeMs);
  }

  randomId(): string {
    this.idCounter += 1;
    return `fake-${this.idCounter}`;
  }

  schedule(delayMs: number, callback: () => void): void {
    this.timers.push({ at: this.timeMs + delayMs, callback, seq: ++this.timerSeq });
    this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
  }

  advance(ms: number): void {
    this.timeMs += ms;
    this.fireDueTimers();
  }

  set(ms: number): void {
    this.timeMs = ms;
    this.fireDueTimers();
  }

  /** Fire every timer due at or before now, in order. One-shot: fired timers
   *  are removed. Callbacks may schedule new timers mid-fire, so keep draining
   *  until none are due (a callback scheduling a future timer never re-fires
   *  within this window — its `at` lands past the advanced clock). */
  private fireDueTimers(): void {
    for (;;) {
      const due = this.timers.filter((t) => t.at <= this.timeMs);
      if (due.length === 0) return;
      this.timers = this.timers.filter((t) => t.at > this.timeMs);
      for (const t of due) t.callback();
    }
  }
}

export class CaptureLogger implements Logger {
  lines: Array<{ level: string; event: LogEvent; fields?: LogFields }> = [];

  debug(event: LogEvent, fields?: LogFields): void {
    this.lines.push({ level: "debug", event, fields });
  }
  info(event: LogEvent, fields?: LogFields): void {
    this.lines.push({ level: "info", event, fields });
  }
  warn(event: LogEvent, fields?: LogFields): void {
    this.lines.push({ level: "warn", event, fields });
  }
  error(event: LogEvent, fields?: LogFields): void {
    this.lines.push({ level: "error", event, fields });
  }

  has(event: LogEvent): boolean {
    return this.lines.some((l) => l.event === event);
  }
}