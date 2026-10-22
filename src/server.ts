import { createDb, migrate } from "./db.ts";
import { loadConfig, type Config } from "./config.ts";
import { buildApp } from "./app.ts";

export interface ServerRuntime {
  createDb: typeof createDb;
  migrate: typeof migrate;
  buildApp: typeof buildApp;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  signals: Pick<NodeJS.Process, "on" | "off">;
  exit: (code: number) => void;
}

export const serverRuntime: ServerRuntime = {
  createDb,
  migrate,
  buildApp,
  setInterval,
  clearInterval,
  signals: process,
  exit: (code) => process.exit(code),
};

export async function startServer(
  config: Config = loadConfig(),
  runtime: ServerRuntime = serverRuntime,
) {
  const db = runtime.createDb(config.databaseUrl);
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    await runtime.migrate(db);
    app = await runtime.buildApp(config, db);
    await app.listen({ host: config.production ? "0.0.0.0" : "127.0.0.1", port: config.port });
  } catch (error) {
    try {
      await app?.close();
    } finally {
      await db.destroy();
    }
    throw error;
  }
  const running = app;
  const tick = (running as typeof running & { tick: () => Promise<void> }).tick;
  const timer = runtime.setInterval(() => {
    void tick().catch(() =>
      running.log.error({ code: "job_tick_failed" }, "worker tick failed"),
    );
  }, 5000);
  timer.unref();
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (!stopping) {
      runtime.clearInterval(timer);
      stopping = (async () => {
        try {
          await running.close();
        } finally {
          try {
            await db.destroy();
          } finally {
            for (const signal of ["SIGINT", "SIGTERM"] as const)
              runtime.signals.off(signal, onSignal);
          }
        }
      })();
    }
    return stopping;
  };
  let signalHandled = false;
  const onSignal = () => {
    if (signalHandled) return;
    signalHandled = true;
    void stop().then(
      () => runtime.exit(0),
      () => {
        running.log.error({ code: "shutdown_failed" }, "shutdown failed");
        runtime.exit(1);
      },
    );
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    runtime.signals.on(signal, onSignal);
  return { app: running, db, stop };
}

if (import.meta.main) await startServer();
