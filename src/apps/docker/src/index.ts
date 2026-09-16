// ---------------------------------------------------------------------------
// Docker runtime entrypoint (tasks 11.1, 11.3). Boots the app, serves
// POST /webhook + GET /health, and runs the hide sweep on boot and hourly.
// Importing this module must not start anything: the guard below keeps tests
// (which import from app.ts / this barrel) side-effect free.
// ---------------------------------------------------------------------------

import { createApp, createHttpServer, HIDE_SWEEP_INTERVAL_MS } from "./app.ts";

export { createApp, createHttpServer, handleWebhookJson } from "./app.ts";
export type { AppDeps, RelayApp } from "./app.ts";

const IS_ENTRYPOINT = process.argv[1] && import.meta.url.endsWith(process.argv[1]);

if (IS_ENTRYPOINT) {
  void main();
}

async function main(): Promise<void> {
  const app = await createApp({ env: process.env });
  const logger = app.logger;

  const server = createHttpServer(app);
  const port = Number(process.env.PORT ?? 17575);
  server.listen(port, () => logger.info("system_start", { status: `listening:${port}` }));

  // Hide sweep: once on boot, then on an hourly interval (task 11.3).
  const sweep = async (): Promise<void> => {
    try {
      const hidden = await app.sweepHidden();
      if (hidden > 0) logger.info("sweep_hide", { status: `hidden:${hidden}` });
    } catch (err) {
      logger.error("system_error", { errorKind: "sweep" });
    }
  };
  void sweep();
  const timer = setInterval(() => void sweep(), HIDE_SWEEP_INTERVAL_MS);
  timer.unref?.();

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(timer);

    // Stop accepting new connections first; Node drains in-flight requests
    // before the close callback resolves. closeIdleConnections drops keep-alive
    // sockets that would otherwise pin the pending count past the real workload.
    server.close(() => void afterDrained());
    server.closeIdleConnections?.();

    // Safety net: if a request hangs, exit anyway rather than block a restart.
    const safety = setTimeout(() => void afterDrained(), 10_000);
    safety.unref?.();

    // Only now is the database closed — never while a request could still be
    // reading or writing. close() (DB teardown) is best-effort on the error
    // path so a hung drain still exits with a nonzero status.
    async function afterDrained(): Promise<void> {
      try {
        await app.close();
        process.exit(0);
      } catch {
        process.exit(1);
      }
    }
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}