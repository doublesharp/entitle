import { createDb, migrate, assertSchemaCurrent } from "./db.ts";
import { loadConfig, serverIdentity, type Config } from "./config.ts";
import { buildApp } from "./app.ts";

export interface ServerRuntime {
  createDb: typeof createDb;
  migrate: typeof migrate;
  // Optional for compatibility with existing injected ServerRuntime callers.
  assertSchemaCurrent?: typeof assertSchemaCurrent;
  buildApp: typeof buildApp;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  signals: Pick<NodeJS.Process, "on" | "off">;
  exit: (code: number) => void;
}

export const serverRuntime: ServerRuntime = {
  createDb,
  migrate,
  assertSchemaCurrent,
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
  const { role, slot } = serverIdentity(config);
  if (role === "migrate")
    throw Error("Use startRuntime for SERVER_ROLE=migrate");
  const db = runtime.createDb(config.databaseUrl);
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    if (role === "all") await runtime.migrate(db);
    else await (runtime.assertSchemaCurrent ?? assertSchemaCurrent)(db);
    app = await runtime.buildApp(config, db);
    app.addHook("onRequest", async (request, reply) => {
      if (request.url.split("?")[0] !== "/api/v1/ready") return;
      reply.header("X-Entitle-Server-Role", role);
      if (slot !== undefined) reply.header("X-Entitle-Deployment-Slot", slot);
    });
    await app.listen({
      host: config.production ? "0.0.0.0" : "127.0.0.1",
      port: config.port,
    });
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
  const timer =
    role === "api"
      ? undefined
      : runtime.setInterval(() => {
          void tick().catch(() =>
            running.log.error(
              { code: "job_tick_failed" },
              "worker tick failed",
            ),
          );
        }, 5000);
  timer?.unref();
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (!stopping) {
      if (timer !== undefined) runtime.clearInterval(timer);
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
  return { role, app: running, db, stop };
}

// Keep startServer's listener lifecycle return type intact for legacy callers.
export async function startRuntime(
  config: Config = loadConfig(),
  runtime: ServerRuntime = serverRuntime,
) {
  const { role } = serverIdentity(config);
  if (role !== "migrate") return startServer(config, runtime);
  const db = runtime.createDb(config.databaseUrl);
  try {
    await runtime.migrate(db);
  } finally {
    await db.destroy();
  }
  return { role };
}

if (import.meta.main) await startRuntime();
