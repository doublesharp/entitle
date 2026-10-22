import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  startServer,
  serverRuntime,
  type ServerRuntime,
} from "../src/server.ts";
import { loadConfig } from "../src/config.ts";
import { createDb } from "../src/db.ts";

const root = await mkdtemp(
  "/Volumes/Scratch/entitle/tmp/server-coverage-",
);
let serial = 0;
const config = () =>
  loadConfig({ DEPLOYMENT_MODE: "hosted",
    APP_SECRET: "55".repeat(32),
    OPERATOR_TOKEN: "operator-test-token".repeat(3),
    DATA_DIR: `${root}/${++serial}`,
    PORT: "0",
    LOCAL_BILLING: "true",
  });
after(async () => {
  await rm(root, { recursive: true, force: true });
});

function controlledRuntime() {
  const signals = new EventEmitter();
  const exits: number[] = [];
  let tick!: () => void;
  let timer!: NodeJS.Timeout;
  let period = 0;
  const runtime: ServerRuntime = {
    ...serverRuntime,
    signals: signals as unknown as ServerRuntime["signals"],
    exit: (code) => {
      exits.push(code);
    },
    setInterval: ((callback: () => void, ms: number) => {
      tick = callback;
      period = ms;
      timer = setInterval(callback, 60000);
      return timer;
    }) as typeof setInterval,
  };
  return {
    runtime,
    signals,
    exits,
    runTick: () => tick(),
    get timer() {
      return timer;
    },
    get period() {
      return period;
    },
  };
}

test("server exposes a lifecycle function without opening a listener at import", () => {
  assert.equal(typeof startServer, "function");
});

test("server listens on an actual socket, polls retryable work, and closes resources idempotently", async (t) => {
  const c = config(),
    control = controlledRuntime();
  const running = await startServer(c, control.runtime);
  t.after(() => running.stop());
  const address = running.app.server.address() as { port: number };
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/v1/health`,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(control.period, 5000);
  assert.equal(control.timer.hasRef(), false);
  await running
    .db("customers")
    .insert({ tenant_id:"primary", id: "customer", email: "person@example.test" });
  await running
    .db("sessions")
    .insert({ tenant_id:"primary", id: "expired", customer_id: "customer", expires_at: 1 });
  control.runTick();
  for (let i = 0; i < 100 && (await running.db("sessions")).length; i++)
    await delay(5);
  assert.equal((await running.db("sessions")).length, 0);
  assert.equal(control.signals.listenerCount("SIGINT"), 1);
  const first = running.stop();
  assert.equal(running.stop(), first);
  await first;
  assert.equal(control.signals.listenerCount("SIGINT"), 0);
  assert.equal(control.signals.listenerCount("SIGTERM"), 0);
  assert.equal(running.app.server.listening, false);
  await assert.rejects(running.db.raw("select 1"), /connection/i);
  assert.deepEqual(control.exits, []);
});

test("a failed worker tick logs a generic error and the next interval still runs", async (t) => {
  const control = controlledRuntime();
  let attempts = 0;
  control.runtime.buildApp = async (...args) => {
    const app = await serverRuntime.buildApp(...args);
    (app as typeof app & { tick: () => Promise<void> }).tick = async () => {
      attempts++;
      if (attempts === 1) throw Error("private provider detail");
    };
    return app;
  };
  const running = await startServer(config(), control.runtime);
  t.after(() => running.stop());
  const log = t.mock.method(running.app.log, "error");
  control.runTick();
  await delay(0);
  control.runTick();
  await delay(0);
  assert.equal(attempts, 2);
  assert.equal(log.mock.callCount(), 1);
  assert.equal(
    JSON.stringify(log.mock.calls[0]!.arguments).includes("private provider"),
    false,
  );
  assert.deepEqual(log.mock.calls[0]!.arguments, [
    { code: "job_tick_failed" },
    "worker tick failed",
  ]);
});

test("both process signals shut down the listener and database before exiting", async () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const control = controlledRuntime();
    const running = await startServer(config(), control.runtime);
    control.signals.emit(signal);
    await running.stop();
    await delay(0);
    assert.deepEqual(control.exits, [0]);
    assert.equal(running.app.server.listening, false);
    control.signals.emit(signal);
    await delay(0);
    assert.deepEqual(control.exits, [0]);
  }
});

test("repeated termination signals remain handled while asynchronous shutdown is pending", async (t) => {
  const control = controlledRuntime();
  const running = await startServer(config(), control.runtime);
  const originalClose = running.app.close.bind(running.app);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(running.app, "close", async () => {
    await gate;
    await originalClose();
  });
  control.signals.emit("SIGTERM");
  try {
    assert.equal(
      control.signals.listenerCount("SIGTERM"),
      1,
      "a second SIGTERM must not invoke default process termination during cleanup",
    );
    control.signals.emit("SIGINT");
    control.signals.emit("SIGTERM");
    assert.deepEqual(control.exits, []);
  } finally {
    release();
    await running.stop();
    await delay(0);
  }
  assert.deepEqual(control.exits, [0]);
  assert.equal(control.signals.listenerCount("SIGTERM"), 0);
});

test("startup failure at migration, application creation, or listen destroys the database", async (t) => {
  for (const stage of ["migration", "application", "listen"]) {
    const c = config(),
      db = createDb(c.databaseUrl),
      control = controlledRuntime();
    const destroy = t.mock.method(db, "destroy");
    control.runtime.createDb = () => db;
    if (stage === "migration")
      control.runtime.migrate = async () => {
        throw Error("migration failed");
      };
    else if (stage === "application")
      control.runtime.buildApp = async () => {
        throw Error("application failed");
      };
    else
      control.runtime.buildApp = async (...args) => {
        const app = await serverRuntime.buildApp(...args);
        t.mock.method(app, "listen", async () => {
          throw Error("listen failed");
        });
        return app;
      };
    await assert.rejects(startServer(c, control.runtime), new RegExp(stage));
    assert.equal(destroy.mock.callCount(), 1);
    assert.equal(control.signals.listenerCount("SIGINT"), 0);
  }
});

test("shutdown still destroys database and returns exit 1 if closing the application fails", async (t) => {
  const control = controlledRuntime();
  const running = await startServer(config(), control.runtime);
  const originalClose = running.app.close.bind(running.app);
  t.mock.method(running.app, "close", async () => {
    await originalClose();
    throw Error("closing failed");
  });
  const destroy = t.mock.method(running.db, "destroy");
  const log = t.mock.method(running.app.log, "error");
  control.signals.emit("SIGTERM");
  await assert.rejects(running.stop(), /closing failed/);
  await delay(0);
  assert.equal(destroy.mock.callCount(), 1);
  assert.deepEqual(control.exits, [1]);
  assert.deepEqual(log.mock.calls[0]!.arguments, [
    { code: "shutdown_failed" },
    "shutdown failed",
  ]);
});

test("default server dependencies distinguish process health from unavailable private storage", async (t) => {
  const previous = process.env;
  process.env = {
    ...process.env,
    APP_SECRET: "55".repeat(32),
    OPERATOR_TOKEN: "operator-test-token".repeat(3),
    DATA_DIR: `${root}/default`,
    DATABASE_URL: `sqlite:${root}/default/db.sqlite`,
    WORK_DIR: `${root}/default/work`,
    S3_ENDPOINT:"http://127.0.0.1:1",S3_ALLOW_HTTP:"true",S3_ACCESS_KEY_ID:"fixture",S3_SECRET_ACCESS_KEY:"fixture-secret",
    PORT: "0",
    LOCAL_BILLING: "true",
    NODE_ENV: "test",
  };
  try {
    const running = await startServer();
    t.after(()=>running.stop());
    assert.equal((await running.app.inject({url:"/api/v1/health"})).statusCode,200);
    assert.equal(
      (await running.app.inject({ url: "/api/v1/ready" })).statusCode,
      503,
    );
    await running.stop();
  } finally {
    process.env = previous;
  }
});

test("real server entry process listens and exits cleanly on SIGTERM", async (t) => {
  const child = spawn(process.execPath, ["src/server.ts"], {
    env: {
      ...process.env,
      NODE_ENV: "development",
      APP_SECRET: "55".repeat(32),
      OPERATOR_TOKEN: "operator-test-token".repeat(3),
      DATA_DIR: `${root}/process`,
      DATABASE_URL: `sqlite:${root}/process/db.sqlite`,
      WORK_DIR: `${root}/process/work`,
      S3_ENDPOINT:"http://127.0.0.1:1",S3_ALLOW_HTTP:"true",S3_ACCESS_KEY_ID:"fixture",S3_SECRET_ACCESS_KEY:"fixture-secret",
      PUBLIC_ORIGIN: "http://localhost",
      PORT: "0",
      LOCAL_BILLING: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 10000);
  t.after(() => {
    clearTimeout(watchdog);
    child.kill("SIGKILL");
  });
  const address = await new Promise<string>((resolve, reject) => {
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(stdout);
      if (match) resolve(match[0]);
    });
    child.once("close", () =>
      reject(Error(`server exited before listening: ${stderr}`)),
    );
  });
  assert.equal((await fetch(`${address}/api/v1/health`)).status,200);
  assert.equal((await fetch(`${address}/api/v1/ready`)).status,503);
  child.kill("SIGTERM");
  assert.equal(await completed, 0, stderr);
});

test("development binds loopback while production retains its container interface",async(t)=>{
 const hosts:string[]=[];
 for(const production of [false,true]){
 const c=config();c.production=production;const control=controlledRuntime();
 control.runtime.buildApp=async(...args)=>{const app=await serverRuntime.buildApp(...args);t.mock.method(app,'listen',async(options:{host:string;port:number})=>{hosts.push(options.host);return 'http://fixture';});return app;};
 const running=await startServer(c,control.runtime);await running.stop();
 }
 assert.deepEqual(hosts,['127.0.0.1','0.0.0.0']);
});
