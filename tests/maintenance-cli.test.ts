import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { migrate, type Tenant } from "../src/db.ts";
import { seal, hash } from "../src/crypto.ts";
import { isolatedDatabase } from "./helpers/database.ts";
import type { BillingSnapshot } from "../src/billing.ts";

const module = await import("../src/maintenance-cli.ts").catch(() => undefined);
test("offline maintenance entry point exists", () => {
  assert.equal(typeof module?.runMaintenance, "function");
});

const secret = "21".repeat(32);
async function fixture(t: test.TestContext) {
  await mkdir(
    "/Volumes/Scratch/double-entitle-wp/tmp/saas-features-20261021/r3-fixes/privacy/maintenance-cli",
    {
      recursive: true,
      mode: 0o700,
    },
  );
  const path = await mkdtemp(
    "/Volumes/Scratch/double-entitle-wp/tmp/saas-features-20261021/r3-fixes/privacy/maintenance-cli/case-",
  );
  const database = await isolatedDatabase(`sqlite:${path}/db`);
  const db = database.db;
  await migrate(db);
  const output: string[] = [],
    errors: string[] = [],
    calls: string[] = [];
  const env = {
    APP_SECRET: secret,
    OPERATOR_TOKEN: "operator-test-credential".repeat(2),
    DATABASE_URL: `sqlite:${path}/db`,
    WORK_DIR: `${path}/work`,
    STRIPE_SECRET_KEY: "sk_test_fixture",
  };
  const io = {
    out: (value: string) => output.push(value),
    error: (value: string) => errors.push(value),
  };
  // Provider boundary only: all migrations, closure and Billing application use real SQL.
  const snapshots = new Map<string, BillingSnapshot>();
  const dependencies = {
    connect: () => db,
    closeDatabase: async () => {
      calls.push("db.close");
    },
    stripe: () => ({
      stripe: {
        accounts: {
          retrieve: async () => {
            calls.push("account");
            return { id: "acct_merchant" };
          },
        },
        events: {
          retrieve: async (id: string) => {
            calls.push(`event:${id}`);
            return {
              id,
              type: "invoice.paid",
              data: { object: { id: "in_test" } },
            };
          },
        },
      },
      snapshot: async (id: string) => {
        calls.push(`snapshot:${id}`);
        const value = snapshots.get(id);
        if (!value) throw Error("provider fixture unavailable");
        return value;
      },
      resolveSubscription: async (event: { id: string }) => {
        calls.push(`resolve:${event.id}`);
        return event.id === "evt_unrelated" ? null : "sub_event";
      },
    }),
  };
  t.after(async () => {
    await database.close();
    await rm(path, { recursive: true, force: true });
  });
  const base = ["--operator", "operator@example.test", "--quiesced"];
  const run = (args: string[], override: NodeJS.ProcessEnv = {}) =>
    module!.runMaintenance(
      [...args, ...base],
      { ...env, ...override },
      io,
      dependencies,
    );
  const tenant = await db<Tenant>("tenants").where({ id: "primary" }).first();
  return {
    path,
    db,
    env,
    io,
    output,
    errors,
    calls,
    snapshots,
    dependencies,
    run,
    tenant: tenant!,
  };
}

test("rejects missing credentials, unknown options and absent maintenance attestations before opening DB", async (t) => {
  assert.ok(module);
  const f = await fixture(t);
  for (const [args, env] of [
    [["closures", "--tenant", "primary"], {}],
    [["closures", "--tenant", "primary", "--operator", "alice"], {}],
    [
      ["closures", "--tenant", "primary", "--operator", "alice", "--quiesced"],
      { OPERATOR_TOKEN: "" },
    ],
    [
      [
        "closures",
        "--tenant",
        "primary",
        "--operator",
        "alice",
        "--quiesced",
        "--token",
        "secret",
      ],
      {},
    ],
  ] as [string[], NodeJS.ProcessEnv][]) {
    assert.equal(
      await module.runMaintenance(
        args,
        { ...f.env, ...env },
        f.io,
        f.dependencies,
      ),
      1,
    );
  }
  assert.deepEqual(f.calls, []);
  assert.ok(
    f.errors.every(
      (v) => !v.includes("secret") && !v.includes(f.env.APP_SECRET),
    ),
  );
});

test("lists and inspects only tenant-owned closure metadata with bounded pages", async (t) => {
  assert.ok(module);
  const f = await fixture(t);
  await f.db("customers").insert({
    tenant_id: "primary",
    id: "buyer",
    email: "private@example.test",
    stripe_id: null,
  });
  await f.db("account_closures").insert({
    tenant_id: "primary",
    customer_id: "buyer",
    id: "request",
    status: "awaiting_operator",
    blockers: "[]",
    requested_at: 1,
    completed_at: null,
  });
  assert.equal(await f.run(["closures", "--tenant", "primary"]), 0);
  assert.equal(JSON.parse(f.output[0]!).requests[0].id, "request");
  assert.ok(!f.output[0]!.includes("private@example.test"));
  assert.equal(
    await f.run([
      "closure-inspect",
      "--tenant",
      "primary",
      "--customer",
      "buyer",
      "--request",
      "request",
    ]),
    0,
  );
  assert.equal(
    await f.run([
      "closure-inspect",
      "--tenant",
      "primary",
      "--customer",
      "stranger",
      "--request",
      "request",
    ]),
    1,
  );
  assert.equal(await f.run(["closures", "--tenant", "missing"]), 1);
  assert.equal(
    await f.run(["closures", "--tenant", "primary", "--limit", "501"]),
    1,
  );
});

test("closure reconciliation and approval require an exact private reviewed receipt and preserve blocked rights", async (t) => {
  assert.ok(module);
  const f = await fixture(t);
  await f.db("customers").insert({
    tenant_id: "primary",
    id: "buyer",
    email: "private@example.test",
    stripe_id: "cus_buyer",
  });
  await f.db("account_closures").insert({
    tenant_id: "primary",
    customer_id: "buyer",
    id: "request",
    status: "awaiting_operator",
    blockers: "[]",
    requested_at: 1,
    completed_at: null,
  });
  const receipt = {
    version: 1,
    operatorId: "operator@example.test",
    tenantId: "primary",
    customerId: "buyer",
    requestId: "request",
    approval: {
      quiesced: true,
      stripeReconciled: true,
      retentionReviewed: true,
      reference: "privacy-ticket-123",
      stripeCustomerId: "cus_buyer",
      eventIds: [],
      workIds: [],
      auditIds: [],
      outgoingEventIds: [],
    },
  };
  const file = `${f.path}/receipt.json`;
  await writeFile(file, JSON.stringify(receipt), { mode: 0o600 });
  const args = [
    "--tenant",
    "primary",
    "--customer",
    "buyer",
    "--request",
    "request",
    "--receipt",
    file,
  ];
  assert.equal(await f.run(["closure-reconcile", ...args]), 0);
  assert.equal(
    (await f.db("customers").where({ id: "buyer" }).first()).stripe_id,
    null,
  );
  assert.equal(await f.run(["closure-approve", ...args]), 0);
  assert.equal((await f.db("account_closures").first()).status, "completed");
  assert.notEqual(
    (await f.db("customers").where({ id: "buyer" }).first()).email,
    "private@example.test",
  );
  await writeFile(
    file,
    JSON.stringify({ ...receipt, operatorId: "someone-else" }),
  );
  assert.equal(await f.run(["closure-approve", ...args]), 1);
  await writeFile(
    file,
    JSON.stringify({
      ...receipt,
      approval: { ...receipt.approval, retentionReviewed: false },
    }),
  );
  assert.equal(await f.run(["closure-approve", ...args]), 1);
});

test("finalization reconciles queued subscriptions without licenses and decrypted pending receipts before opening traffic", async (t) => {
  assert.ok(module);
  const f = await fixture(t);
  await f.db("tenants").where({ id: "primary" }).update({ suspended: 1 });
  await f
    .db("locks")
    .insert({ id: `primary:portability:${hash("acct_merchant")}`, version: 1 });
  await f.db("work").insert({
    tenant_id: "primary",
    id: "held",
    kind: "reconcile",
    payload: seal({ subscriptionId: "sub_unmaterialized" }, secret),
    state: "held",
    attempts: 0,
    available_at: 0,
    lease_until: 0,
    lease_owner: null,
    last_error: null,
    created_at: 1,
  });
  for (const id of ["evt_pending", "evt_unrelated"]) {
    await f.db("billing_events").insert({
      tenant_id: "primary",
      id,
      type: "invoice.paid",
      payload: seal(
        { id, type: "invoice.paid", data: { object: { id: "in_test" } } },
        secret,
      ),
      received_at: 1,
      processed_at: null,
    });
  }
  for (const id of ["sub_unmaterialized", "sub_event"])
    f.snapshots.set(id, {
      subscriptionId: id,
      customerId: "cus_fixture",
      email: "buyer@example.test",
      billingStatus: "canceled",
      suspended: false,
      fullyRefunded: false,
      grants: [],
    });
  assert.equal(
    await f.run(["finalize", "--expected-stripe-account", "acct_merchant"]),
    0,
  );
  assert.ok(f.calls.includes("snapshot:sub_unmaterialized"));
  assert.ok(f.calls.includes("snapshot:sub_event"));
  assert.ok(
    f.calls.indexOf("account") < f.calls.indexOf("snapshot:sub_unmaterialized"),
  );
  assert.equal(
    (await f.db("tenants").where({ id: "primary" }).first()).suspended,
    0,
  );
  assert.ok(
    (await f.db("billing_events")).every(
      (r) => r.processed_at !== null && r.payload === "",
    ),
  );
  assert.equal(
    (await f.db("work").where({ id: "held" }).first()).state,
    "canceled",
  );
});

test("provider failure and wrong merchant retain import maintenance and unprocessed receipts", async (t) => {
  assert.ok(module);
  const f = await fixture(t);
  await f.db("tenants").where({ id: "primary" }).update({ suspended: 1 });
  await f
    .db("locks")
    .insert({ id: `primary:portability:${hash("acct_merchant")}`, version: 1 });
  await f.db("billing_events").insert({
    tenant_id: "primary",
    id: "evt_pending",
    type: "invoice.paid",
    payload: seal(
      {
        id: "evt_pending",
        type: "invoice.paid",
        data: { object: { id: "in_test" } },
      },
      secret,
    ),
    received_at: 1,
    processed_at: null,
  });
  assert.equal(
    await f.run(["finalize", "--expected-stripe-account", "acct_wrong"]),
    1,
  );
  assert.equal(
    await f.run(["finalize", "--expected-stripe-account", "acct_merchant"]),
    1,
  );
  assert.equal((await f.db("tenants").first()).suspended, 1);
  assert.equal((await f.db("billing_events").first()).processed_at, null);
  assert.equal(
    await f.run(["finalize", "--expected-stripe-account", "acct_merchant"], {
      LOCAL_BILLING: "true",
    }),
    1,
  );
  assert.equal(
    await f.run(["finalize", "--expected-stripe-account", "acct_merchant"], {
      DEPLOYMENT_MODE: "hosted",
    }),
    1,
  );
  assert.ok(!f.errors.join("").includes("provider fixture unavailable"));
});

import { openSync, closeSync } from "node:fs";
import { chmod, symlink, readFile, mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { loadConfig } from "../src/config.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import { Portability } from "../src/portability.ts";
import { spawn } from "node:child_process";
import type { S3Client } from "@aws-sdk/client-s3";

test("passphrase reader bounds owner-only FD input, strips one newline and refuses malformed secrets", async (t) => {
  assert.ok(module);
  const f = await fixture(t),
    file = `${f.path}/passphrase`;
  for (const [value, valid] of [
    ["correct horse battery staple\r\n", true],
    ["é".repeat(1024), true],
    ["x".repeat(1025), false],
    ["x".repeat(5000), false],
    ["short", false],
    ["valid secret\nsecond line", false],
    ["valid secret\0extra", false],
  ] as const) {
    await writeFile(file, value, { mode: 0o600 });
    const fd = openSync(file, "r");
    try {
      if (valid)
        assert.equal(
          module.readMaintenancePassphrase(fd),
          value.replace(/\r?\n$/, ""),
        );
      else assert.throws(() => module.readMaintenancePassphrase(fd));
    } finally {
      closeSync(fd);
    }
  }
  await writeFile(
    file,
    Buffer.from([255, ...Buffer.from("invalid utf8 secret")]),
  );
  let fd = openSync(file, "r");
  try {
    assert.throws(() => module.readMaintenancePassphrase(fd));
  } finally {
    closeSync(fd);
  }
  await chmod(file, 0o644);
  fd = openSync(file, "r");
  try {
    assert.throws(() => module.readMaintenancePassphrase(fd));
  } finally {
    closeSync(fd);
  }
  for (const invalid of [-1, 1.5, Number.NaN])
    assert.throws(() => module!.readMaintenancePassphrase(invalid));
  const dir = openSync(f.path, "r");
  try {
    assert.throws(() => module.readMaintenancePassphrase(dir));
  } finally {
    closeSync(dir);
  }
});

test("SDK adapter conditionally streams and verifies immutable objects and always closes its client", async (t) => {
  assert.ok(module);
  const f = await fixture(t),
    id = randomUUID(),
    bytes = Buffer.from("immutable artifact bytes");
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const objects = new Map<string, Buffer>();
  const calls: string[] = [];
  const sdk = {
    send: async (command: {
      constructor: { name: string };
      input: Record<string, unknown>;
    }) => {
      calls.push(command.constructor.name);
      const input = command.input;
      if (command.constructor.name === "PutObjectCommand") {
        assert.equal(input.IfNoneMatch, "*");
        const chunks: Buffer[] = [];
        if (Buffer.isBuffer(input.Body)) chunks.push(input.Body);
        else
          for await (const chunk of input.Body as Readable)
            chunks.push(Buffer.from(chunk));
        objects.set(String(input.Key), Buffer.concat(chunks));
        return {};
      }
      if (command.constructor.name === "GetObjectCommand")
        return { Body: Readable.from([objects.get(String(input.Key))!]) };
      if (command.constructor.name === "DeleteObjectCommand") {
        objects.delete(String(input.Key));
        return {};
      }
      if (command.constructor.name === "GetBucketAclCommand")
        return {
          Owner: { ID: "owner" },
          Grants: [
            {
              Grantee: { Type: "CanonicalUser", ID: "owner" },
              Permission: "FULL_CONTROL",
            },
          ],
        };
      if (command.constructor.name === "GetBucketPolicyCommand")
        throw Object.assign(Error("no policy"), { name: "NoSuchBucketPolicy" });
      if (command.constructor.name === "ListObjectsV2Command")
        return { KeyCount: objects.size, Contents: [] };
      return {};
    },
    destroy: () => {
      calls.push("destroy");
    },
  };
  const storage = module.maintenanceStorage(
    loadConfig(f.env),
    sdk as unknown as Pick<S3Client, "send" | "destroy">,
  );
  await storage.store.ready();
  await storage.verifyEmpty();
  await storage.store.put("primary", id, bytes, checksum);
  assert.deepEqual(
    await storage.store.get("primary", id, checksum, bytes.length),
    bytes,
  );
  const source = `${f.path}/artifact`;
  await writeFile(source, bytes);
  await storage.store.putFile!("primary", id, source, checksum, bytes.length);
  await storage.store.getToFile!(
    "primary",
    id,
    checksum,
    bytes.length,
    `${f.path}/readback`,
  );
  assert.deepEqual(await readFile(`${f.path}/readback`), bytes);
  await assert.rejects(
    storage.store.get("primary", id, "0".repeat(64), bytes.length),
  );
  await assert.rejects(
    storage.store.get("primary", id, checksum, bytes.length - 1),
  );
  await assert.rejects(
    storage.store.get("primary", id, checksum, bytes.length + 1),
  );
  await assert.rejects(
    storage.store.put("primary", randomUUID(), bytes, "0".repeat(64)),
    /integrity/i,
  );
  await assert.rejects(
    storage.store.putFile!("primary", id, source, "0".repeat(64), bytes.length),
  );
  await assert.rejects(storage.store.put("foreign", id, bytes, checksum));
  await assert.rejects(storage.store.put("primary", "bad-id", bytes, checksum));
  await assert.rejects(storage.store.put("primary", id, bytes, "invalid"));
  await storage.store.delete("primary", id);
  assert.equal(objects.size, 0);
  storage.close();
  assert.equal(calls.at(-1), "destroy");
});

test("import uses real portability verification and never finalizes automatically", async (t) => {
  assert.ok(module);
  const f = await fixture(t);
  const source = await isolatedDatabase(`sqlite:${f.path}/source`);
  t.after(() => source.close());
  await migrate(source.db);
  const tenant = (await source.db<Tenant>("tenants").first())!;
  const exportDirectory = `${f.path}/exports`;
  await mkdir(exportDirectory, { mode: 0o700 });
  const exporter = new Portability({
    db: source.db,
    store: new InMemoryArtifactStore(),
    secret,
    directory: exportDirectory,
    sourceStripeAccountId: "acct_merchant",
  });
  t.after(() => exporter.close());
  const exported = await exporter.createExport(
    tenant.id,
    "private transfer phrase",
  );
  let closed = 0,
    verified = 0;
  const result = await module.runMaintenance(
    [
      "import",
      "--operator",
      "operator@example.test",
      "--quiesced",
      "--bundle",
      `${exportDirectory}/${exported.id}`,
      "--expected-stripe-account",
      "acct_merchant",
    ],
    { ...f.env, S3_BUCKET: "private-destination", S3_REGION: "us-east-1" },
    f.io,
    {
      ...f.dependencies,
      passphrase: () => "private transfer phrase",
      storage: () => ({
        store: new InMemoryArtifactStore(),
        verifyEmpty: async () => {
          verified++;
        },
        close: () => {
          closed++;
        },
      }),
    },
  );
  assert.equal(result, 0, f.errors.join(""));
  assert.equal(verified, 1);
  assert.equal(closed, 1);
  assert.equal((await f.db("tenants").first()).suspended, 1);
  assert.equal(JSON.parse(f.output[0]!).requiresReconciliation, true);
  assert.equal(
    await f.run([
      "import",
      "--bundle",
      `${exportDirectory}/${exported.id}`,
      "--expected-stripe-account",
      "acct_merchant",
    ]),
    1,
  );
  assert.equal(
    await f.run([
      "import",
      "--bundle",
      "relative",
      "--expected-stripe-account",
      "acct_merchant",
    ]),
    1,
  );
});

test("receipt input fails closed for public, linked, oversized and unknown-field documents", async (t) => {
  assert.ok(module);
  const f = await fixture(t),
    file = `${f.path}/receipt`,
    args = [
      "closure-approve",
      "--tenant",
      "primary",
      "--customer",
      "buyer",
      "--request",
      "request",
      "--receipt",
      file,
    ];
  await writeFile(file, "{}", { mode: 0o644 });
  assert.equal(await f.run(args), 1);
  await chmod(file, 0o600);
  assert.equal(await f.run(args), 1);
  await writeFile(file, "x".repeat(262145));
  assert.equal(await f.run(args), 1);
  await symlink(file, `${f.path}/linked`);
  assert.equal(await f.run([...args.slice(0, -1), `${f.path}/linked`]), 1);
  assert.equal(await f.run([...args.slice(0, -1), f.path]), 1);
});

test("run wrapper redacts provider/config errors and closes handles even after migration errors", async (t) => {
  assert.ok(module);
  const f = await fixture(t);
  assert.equal(
    await module.runMaintenance(
      ["closures", "--tenant", "primary", "--operator", "alice", "--quiesced"],
      f.env,
      f.io,
      {
        connect: () => {
          throw Error("credential=secret");
        },
      },
    ),
    1,
  );
  const db = await isolatedDatabase(`sqlite:${f.path}/broken`);
  await db.db.schema.createTable("knex_migrations", (t) => {
    t.string("unexpected");
  });
  let closed = false;
  assert.equal(
    await module.runMaintenance(
      ["closures", "--tenant", "primary", "--operator", "alice", "--quiesced"],
      f.env,
      f.io,
      {
        connect: () => db.db,
        closeDatabase: async () => {
          closed = true;
          await db.close();
        },
      },
    ),
    1,
  );
  assert.equal(closed, true);
  assert.ok(!f.errors.join("").includes("credential"));
});

test("direct command reports errors without printing secrets or stack traces", async () => {
  const result = await new Promise<{
    code: number | null;
    out: string;
    error: string;
  }>((resolve) => {
    const child = spawn(
      process.execPath,
      ["src/maintenance-cli.ts", "closures"],
      {
        env: { ...process.env, OPERATOR_TOKEN: "private-secret-for-test" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let out = "",
      error = "";
    child.stdout.on("data", (chunk) => {
      out += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      error += String(chunk);
    });
    child.on("close", (code) => resolve({ code, out, error }));
  });
  assert.equal(result.code, 1);
  assert.equal(result.out, "");
  assert.deepEqual(JSON.parse(result.error), { error: "maintenance_required" });
});

test("finalization refuses an unverified provider receipt even when local resolution would succeed", async (t) => {
  assert.ok(module);
  const f = await fixture(t);
  await f.db("tenants").where({ id: "primary" }).update({ suspended: 1 });
  await f
    .db("locks")
    .insert({ id: `primary:portability:${hash("acct_merchant")}`, version: 1 });
  await f.db("billing_events").insert({
    tenant_id: "primary",
    id: "evt_unrelated",
    type: "invoice.paid",
    payload: seal(
      {
        id: "evt_unrelated",
        type: "invoice.paid",
        data: { object: { id: "in_test" } },
      },
      secret,
    ),
    received_at: 1,
    processed_at: null,
  });
  const dependencies = {
    ...f.dependencies,
    stripe: () => ({
      ...f.dependencies.stripe(),
      stripe: {
        accounts: { retrieve: async () => ({ id: "acct_merchant" }) },
        events: {
          retrieve: async () => {
            throw Error("provider cannot confirm receipt");
          },
        },
      },
    }),
  };
  assert.equal(
    await module.runMaintenance(
      [
        "finalize",
        "--expected-stripe-account",
        "acct_merchant",
        "--operator",
        "alice",
        "--quiesced",
      ],
      f.env,
      f.io,
      dependencies,
    ),
    1,
  );
  assert.equal((await f.db("tenants").first()).suspended, 1);
  assert.equal((await f.db("billing_events").first()).processed_at, null);
});

import Stripe from "stripe";
import { StripeBilling } from "../src/stripe.ts";

test("default DB/provider factories close real handles and verify the credential account without Connect overrides", async (t) => {
  assert.ok(module);
  const f = await fixture(t);
  // The SDK method alone is the provider fixture; no network call is permitted.
  const prototype = Object.getPrototypeOf(
    new Stripe("sk_test_fixture").accounts,
  );
  const retrieve = t.mock.method(
    prototype,
    "retrieve",
    async (...args: unknown[]) => {
      assert.deepEqual(args, [null]);
      return { id: "acct_merchant" };
    },
  );
  await f.db("tenants").where({ id: "primary" }).update({ suspended: 1 });
  await f
    .db("locks")
    .insert({ id: `primary:portability:${hash("acct_merchant")}`, version: 1 });
  assert.equal(
    await module.runMaintenance(
      [
        "finalize",
        "--expected-stripe-account",
        "acct_merchant",
        "--operator",
        "alice",
        "--quiesced",
      ],
      { ...f.env, STANDALONE_STRIPE_ACCOUNT_ID: "acct_merchant" },
      f.io,
      {
        ...f.dependencies,
        stripe: (db, config, tenant) => new StripeBilling(db, config, tenant),
      },
    ),
    0,
  );
  assert.equal(retrieve.mock.calls.length, 1);
  // Exercise the built-in factory too, on an unpending import. Still no provider network.
  const { stripe: ignored, ...dependencies } = f.dependencies;
  void ignored;
  assert.equal(
    await module.runMaintenance(
      [
        "finalize",
        "--expected-stripe-account",
        "acct_merchant",
        "--operator",
        "alice",
        "--quiesced",
      ],
      f.env,
      f.io,
      dependencies,
    ),
    1,
  );
  assert.equal(retrieve.mock.calls.length, 2);
  assert.equal(
    await module.runMaintenance(
      ["closures", "--tenant", "primary", "--operator", "alice", "--quiesced"],
      { ...f.env, DATABASE_URL: `sqlite:${f.path}/default-db` },
    ),
    0,
  );
});

test("pagination, config merchant mismatch and command-specific flags fail or scope correctly", async (t) => {
  assert.ok(module);
  const f = await fixture(t);
  assert.equal(
    await f.run(["closures", "--tenant", "primary", "--after", "request"]),
    0,
  );
  assert.deepEqual(JSON.parse(f.output[0]!).requests, []);
  for (const args of [
    [],
    ["unknown"],
    ["closures", "extra"],
    ["closures", "--tenant", "primary", "--bundle", "/private"],
  ])
    assert.equal(await f.run(args), 1);
  assert.equal(
    await f.run(["finalize", "--expected-stripe-account", "acct_merchant"], {
      STANDALONE_STRIPE_ACCOUNT_ID: "acct_other",
    }),
    1,
  );
  assert.equal(
    await f.run(["finalize", "--expected-stripe-account", "acct_merchant"], {
      STRIPE_SECRET_KEY: "",
    }),
    1,
  );
  assert.equal(
    await f.run(["finalize", "--expected-stripe-account", "invalid"]),
    1,
  );
});

test("provider receipt identity, unsupported event types and tampered destination ciphertext keep maintenance", async (t) => {
  assert.ok(module);
  const f = await fixture(t);
  await f.db("tenants").where({ id: "primary" }).update({ suspended: 1 });
  await f
    .db("locks")
    .insert({ id: `primary:portability:${hash("acct_merchant")}`, version: 1 });
  const scope = { tenant_id: "primary", id: "evt_unrelated" };
  await f.db("billing_events").insert({
    ...scope,
    type: "invoice.paid",
    payload: seal(
      {
        id: "evt_unrelated",
        type: "invoice.paid",
        data: { object: { id: "wrong" } },
      },
      secret,
    ),
    received_at: 1,
    processed_at: null,
  });
  const args = ["finalize", "--expected-stripe-account", "acct_merchant"];
  assert.equal(await f.run(args), 1);
  await f
    .db("billing_events")
    .where(scope)
    .update({
      type: "unknown.created",
      payload: seal(
        {
          id: "evt_unrelated",
          type: "unknown.created",
          data: { object: { id: "in_test" } },
        },
        secret,
      ),
    });
  assert.equal(await f.run(args), 1);
  await f
    .db("billing_events")
    .where(scope)
    .update({
      type: "invoice.paid",
      payload: seal(
        {
          id: "wrong",
          type: "invoice.paid",
          data: { object: { id: "in_test" } },
        },
        secret,
      ),
    });
  assert.equal(await f.run(args), 1);
  await f
    .db("billing_events")
    .where(scope)
    .update({
      payload: seal(
        {
          id: "evt_unrelated",
          type: "invoice.paid",
          data: { object: { id: "in_test" } },
        },
        "12".repeat(32),
      ),
    });
  assert.equal(await f.run(args), 1);
  assert.equal((await f.db("tenants").first()).suspended, 1);
  assert.equal((await f.db("billing_events").first()).processed_at, null);
});

test("closure approval returns durable blockers and does not revoke or cancel rights", async (t) => {
  assert.ok(module);
  const f = await fixture(t),
    product = randomUUID(),
    plan = randomUUID(),
    license = randomUUID();
  await f.db("customers").insert({
    tenant_id: "primary",
    id: "buyer",
    email: "buyer@example.test",
    stripe_id: null,
  });
  await f
    .db("products")
    .insert({ tenant_id: "primary", id: product, slug: "paid", name: "Paid" });
  await f.db("plans").insert({
    tenant_id: "primary",
    id: plan,
    product_id: product,
    name: "Annual",
    site_allowance: 1,
    stripe_price_id: "price_paid",
  });
  await f.db("licenses").insert({
    tenant_id: "primary",
    id: license,
    customer_id: "buyer",
    product_id: product,
    plan_id: plan,
    site_allowance: 1,
    paid_through: Date.now() + 86400000,
    billing_status: "active",
    subscription_id: "sub_paid",
    key_hash: hash("original-key"),
  });
  await f.db("account_closures").insert({
    tenant_id: "primary",
    customer_id: "buyer",
    id: "request",
    status: "awaiting_operator",
    blockers: "[]",
    requested_at: 1,
    completed_at: null,
  });
  const receipt = {
    version: 1,
    operatorId: "operator@example.test",
    tenantId: "primary",
    customerId: "buyer",
    requestId: "request",
    approval: {
      quiesced: true,
      stripeReconciled: true,
      retentionReviewed: true,
      reference: "review-123",
      stripeCustomerId: null,
      eventIds: [],
      workIds: [],
      auditIds: [],
      outgoingEventIds: [],
    },
  };
  const file = `${f.path}/receipt`;
  await writeFile(file, JSON.stringify(receipt), { mode: 0o600 });
  assert.equal(
    await f.run([
      "closure-approve",
      "--tenant",
      "primary",
      "--customer",
      "buyer",
      "--request",
      "request",
      "--receipt",
      file,
    ]),
    0,
  );
  const response = JSON.parse(f.output[0]!);
  assert.equal(response.status, "blocked");
  assert.ok(response.blockers.includes("paid_or_installed_rights"));
  const row = await f.db("licenses").where({ id: license }).first();
  assert.equal(row.revoked, 0);
  assert.equal(row.billing_status, "active");
  assert.equal(row.key_hash, hash("original-key"));
});

test("S3 response and stream failures propagate without leaking raw diagnostics", async (t) => {
  assert.ok(module);
  const f = await fixture(t),
    id = randomUUID(),
    checksum = hash("bytes");
  let response: unknown = { Body: null };
  const storage = module.maintenanceStorage(loadConfig(f.env), {
    send: async () => response,
    destroy: () => {},
  } as unknown as Pick<S3Client, "send" | "destroy">);
  await assert.rejects(storage.store.get("primary", id, checksum, 5));
  response = {
    Body: new Readable({
      read() {
        this.destroy(new Error("stream-failure"));
      },
    }),
  };
  await assert.rejects(
    storage.store.get("primary", id, checksum, 5),
    /stream-failure/,
  );
  assert.throws(() =>
    module!.maintenanceStorage({
      ...loadConfig(f.env),
      s3: undefined,
    } as unknown as ReturnType<typeof loadConfig>),
  );
  const closed = module.maintenanceStorage(loadConfig(f.env));
  closed.close();
});

test("storage stream stalls abort within the SDK operation deadline", async (t) => {
  assert.ok(module);
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const body = new Readable({ read() {} });
  const sdk = { send: async () => ({ Body: body }), destroy: () => {} };
  const storage = module.maintenanceStorage(
    loadConfig(f.env),
    sdk as unknown as Pick<S3Client, "send" | "destroy">,
  );
  const pending = storage.store.get("primary", randomUUID(), hash("bytes"), 5);
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await new Promise<void>((resolve) => setImmediate(resolve));
  t.mock.timers.tick(120000);
  await rejected;
  assert.equal(body.destroyed, true);
  storage.close();
});

import { appendFileSync, truncateSync } from "node:fs";
import { setImmediate as turn } from "node:timers/promises";

const config = loadConfig({
  APP_SECRET: "24".repeat(32),
  OPERATOR_TOKEN: "private operator fixture credential",
});
const digest = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex");
type RequestOptions = { abortSignal: AbortSignal; requestTimeout: number };
function virtualTime(t: test.TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // Make the old AbortSignal.timeout regression observable without a real two-minute wait.
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
}
async function directory(t: test.TestContext) {
  await mkdir(
    "/Volumes/Scratch/double-entitle-wp/tmp/saas-features-20261021/r3-fixes/privacy/maintenance-cli",
    {
      recursive: true,
      mode: 0o700,
    },
  );
  const path = await mkdtemp(
    "/Volumes/Scratch/double-entitle-wp/tmp/saas-features-20261021/r3-fixes/privacy/maintenance-cli/timeouts-",
  );
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
const asSdk = (send: unknown) =>
  ({ send, destroy: () => {} }) as Pick<S3Client, "send" | "destroy">;

test("2 GiB import read progresses beyond 120 seconds, then a stall aborts and destroys its stream", async (t) => {
  const path = await directory(t);
  virtualTime(t);
  const body = new Readable({ read() {} });
  let request!: RequestOptions;
  const storage = module!.maintenanceStorage(
    config,
    asSdk(async (_command: unknown, options: RequestOptions) => {
      request = options;
      return { Body: body };
    }),
  );
  const pending = storage.store.getToFile!(
    "primary",
    randomUUID(),
    "0".repeat(64),
    2 * 1024 ** 3,
    `${path}/partial`,
  );
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await turn();
  assert.equal(request.requestTimeout, 2168000);
  for (let i = 0; i < 3; i++) {
    t.mock.timers.tick(60000);
    body.push(Buffer.from([i]));
    await turn();
    assert.equal(
      request.abortSignal.aborted,
      false,
      "progress must extend idle deadline past 120 seconds",
    );
  }
  t.mock.timers.tick(120000);
  await rejected;
  assert.equal(body.destroyed, true);
  storage.close();
});

test("file upload completes beyond the idle window using a size-scaled SDK request timeout", async (t) => {
  const path = await directory(t),
    bytes = Buffer.alloc(1024 ** 2, 42),
    file = `${path}/upload`;
  await writeFile(file, bytes);
  virtualTime(t);
  let signal!: AbortSignal,
    elapsed = 0,
    received = 0,
    attempts = 0;
  const storage = module!.maintenanceStorage(
    config,
    asSdk(
      async (
        command: { input: { Body: Readable; IfNoneMatch: string } },
        options: RequestOptions,
      ) => {
        attempts++;
        signal = options.abortSignal;
        assert.equal(options.requestTimeout, 121000);
        assert.equal(command.input.IfNoneMatch, "*");
        for await (const chunk of command.input.Body) {
          received += chunk.length;
          const target = Math.floor((120500 * received) / bytes.length);
          t.mock.timers.tick(target - elapsed);
          elapsed = target;
          await turn();
          assert.equal(signal.aborted, false);
        }
        return {};
      },
    ),
  );
  await storage.store.putFile!(
    "primary",
    randomUUID(),
    file,
    digest(bytes),
    bytes.length,
  );
  assert.equal(received, bytes.length);
  assert.equal(elapsed, 120500);
  assert.equal(attempts, 1);
  t.mock.timers.tick(10000000);
  assert.equal(
    signal.aborted,
    false,
    "completed operation must clear both timers",
  );
  storage.close();
});

test("ongoing read progress cannot extend the finite total deadline", async (t) => {
  virtualTime(t);
  const body = new Readable({ read() {} });
  let request!: RequestOptions;
  const storage = module!.maintenanceStorage(
    config,
    asSdk(async (_command: unknown, options: RequestOptions) => {
      request = options;
      return { Body: body };
    }),
  );
  const pending = storage.store.get(
    "primary",
    randomUUID(),
    "0".repeat(64),
    100 * 1024 ** 2,
  );
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await turn();
  assert.equal(request.requestTimeout, 220000);
  for (let i = 0; i < 2; i++) {
    t.mock.timers.tick(80000);
    body.push(Buffer.from([i]));
    await turn();
    assert.equal(request.abortSignal.aborted, false);
  }
  t.mock.timers.tick(60000);
  await rejected;
  assert.equal(body.destroyed, true);
  storage.close();
});

test("upload stalls abort once, destroy the owned body, and never retry a write", async (t) => {
  virtualTime(t);
  let attempts = 0,
    body!: Readable;
  const storage = module!.maintenanceStorage(
    config,
    asSdk(
      async (
        command: { input: { Body: Readable } },
        options: RequestOptions,
      ) => {
        attempts++;
        body = command.input.Body;
        return new Promise((_resolve, reject) =>
          options.abortSignal.addEventListener(
            "abort",
            () => reject(options.abortSignal.reason),
            { once: true },
          ),
        );
      },
    ),
  );
  const bytes = Buffer.alloc(1024 ** 2, 7),
    pending = storage.store.put("primary", randomUUID(), bytes, digest(bytes));
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await turn();
  t.mock.timers.tick(120000);
  await rejected;
  assert.equal(body.destroyed, true);
  assert.equal(attempts, 1);
  storage.close();
});

test("a read stalled before response headers is bounded by the idle deadline", async (t) => {
  virtualTime(t);
  let attempts = 0;
  const storage = module!.maintenanceStorage(
    config,
    asSdk(async (_command: unknown, options: RequestOptions) => {
      attempts++;
      assert.equal(options.requestTimeout, 120001);
      return new Promise((_resolve, reject) =>
        options.abortSignal.addEventListener(
          "abort",
          () => reject(options.abortSignal.reason),
          { once: true },
        ),
      );
    }),
  );
  const pending = storage.store.get(
    "primary",
    randomUUID(),
    digest(Buffer.from("x")),
    1,
  );
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await turn();
  t.mock.timers.tick(120000);
  await rejected;
  assert.equal(attempts, 1);
  storage.close();
});

test("upload byte bounds still reject a source that grows or shrinks after its checksum check", async (t) => {
  const path = await directory(t),
    file = `${path}/changing`,
    bytes = Buffer.alloc(65536, 1);
  for (const change of [
    () => appendFileSync(file, "extra"),
    () => truncateSync(file, 1),
  ]) {
    await writeFile(file, bytes);
    let attempts = 0,
      body!: Readable;
    const storage = module!.maintenanceStorage(
      config,
      asSdk(async (command: { input: { Body: Readable } }) => {
        attempts++;
        body = command.input.Body;
        await change();
        for await (const _chunk of body) {
          void _chunk;
        }
        return {};
      }),
    );
    await assert.rejects(
      storage.store.putFile!(
        "primary",
        randomUUID(),
        file,
        digest(bytes),
        bytes.length,
      ),
      /Artifact/,
    );
    assert.equal(attempts, 1);
    assert.equal(body.destroyed, true);
    storage.close();
  }
});

test("closure CLI lists precise blocker IDs and reconciles exactly those records before approval", async (t) => {
  const f = await fixture(t);
  await f.db("customers").insert({
    tenant_id: "primary",
    id: "buyer",
    email: "private@example.test",
    stripe_id: "cus_buyer",
  });
  await f.db("account_closures").insert({
    tenant_id: "primary",
    customer_id: "buyer",
    id: "request",
    status: "awaiting_operator",
    blockers: "[]",
    requested_at: 1,
    completed_at: null,
  });
  await f.db("billing_events").insert({
    tenant_id: "primary",
    id: "evt_private",
    type: "invoice.paid",
    payload: seal(
      {
        data: {
          object: {
            id: "in_private",
            customer: "cus_buyer",
            customer_email: "private@example.test",
            amount_paid: 500,
            currency: "usd",
          },
        },
      },
      secret,
    ),
    received_at: 1,
    processed_at: 2,
  });
  await f.db("work").insert({
    tenant_id: "primary",
    id: "evt_private",
    kind: "stripe_event",
    payload: seal({ eventId: "evt_private" }, secret),
    state: "sent",
    created_at: 1,
  });
  await f.db("audit_events").insert({
    id: "audit_private",
    tenant_id: "primary",
    actor_type: "customer",
    actor_id: "buyer",
    action: "billing.reconciled",
    details: JSON.stringify({ customer: "cus_buyer" }),
    created_at: 1,
  });
  const receipt = {
    version: 1,
    operatorId: "operator@example.test",
    tenantId: "primary",
    customerId: "buyer",
    requestId: "request",
    approval: {
      quiesced: true,
      stripeReconciled: true,
      retentionReviewed: true,
      reference: "review-1",
      stripeCustomerId: "cus_buyer",
      eventIds: [],
      workIds: [],
      auditIds: [],
      outgoingEventIds: [],
    },
  };
  const file = `${f.path}/precise-receipt.json`;
  await writeFile(file, JSON.stringify(receipt), { mode: 0o600 });
  const args = [
    "--tenant",
    "primary",
    "--customer",
    "buyer",
    "--request",
    "request",
  ];
  assert.equal(await f.run(["closure-approve", ...args, "--receipt", file]), 0);
  const blocked = JSON.parse(f.output.at(-1)!);
  assert.equal(blocked.status, "blocked");
  assert.ok(blocked.blockerRecords);
  assert.deepEqual(blocked.blockerRecords.billing_events, ["evt_private"]);
  assert.deepEqual(blocked.blockerRecords.work, ["evt_private"]);
  assert.deepEqual(blocked.blockerRecords.audit_events, ["audit_private"]);
  assert.equal(await f.run(["closure-inspect", ...args]), 0);
  const inspection = JSON.parse(f.output.at(-1)!);
  assert.deepEqual(inspection.blockerRecords, blocked.blockerRecords);
  assert.ok(!JSON.stringify(inspection).includes("private@example.test"));
  assert.ok(!JSON.stringify(inspection).includes("cus_buyer"));
  await writeFile(
    file,
    JSON.stringify({
      ...receipt,
      approval: {
        ...receipt.approval,
        eventIds: inspection.blockerRecords.billing_events,
        workIds: inspection.blockerRecords.work,
        auditIds: inspection.blockerRecords.audit_events,
        outgoingEventIds: inspection.blockerRecords.outbound_events,
      },
    }),
  );
  assert.equal(
    await f.run(["closure-reconcile", ...args, "--receipt", file]),
    0,
  );
  assert.equal(await f.run(["closure-inspect", ...args]), 0);
  assert.ok(
    Object.values(JSON.parse(f.output.at(-1)!).blockerRecords).every(
      (ids) => Array.isArray(ids) && ids.length === 0,
    ),
  );
  assert.equal(await f.run(["closure-approve", ...args, "--receipt", file]), 0);
  assert.equal(JSON.parse(f.output.at(-1)!).status, "completed");
  assert.equal((await f.db("billing_events").first()).payload, "{}");
  assert.equal((await f.db("work").first()).payload, "{}");
});

test("live-mode maintenance reconciliation honors completed live privacy receipts", async (t) => {
  const f = await fixture(t);
  const { privacyReferenceDigest } =
    await import("../src/account-management.ts");
  await f.db("tenants").where({ id: "primary" }).update({ suspended: 1 });
  await f
    .db("locks")
    .insert({ id: `primary:portability:${hash("acct_merchant")}`, version: 1 });
  await f.db("customers").insert({
    tenant_id: "primary",
    id: "closed",
    email: "closed@example.invalid",
    stripe_id: null,
  });
  await f.db("account_closures").insert({
    tenant_id: "primary",
    customer_id: "closed",
    id: "closure",
    status: "completed",
    blockers: "[]",
    requested_at: 1,
    completed_at: 2,
  });
  await f.db("account_privacy_receipts").insert({
    tenant_id: "primary",
    customer_id: "closed",
    request_id: "closure",
    id: "receipt",
    details: JSON.stringify({
      referenceDigests: [privacyReferenceDigest(secret, "cus_closed")],
      stripeLiveMode: true,
    }),
    created_at: 1,
  });
  await f.db("products").insert({
    tenant_id: "primary",
    id: "product",
    slug: "product",
    name: "Product",
  });
  await f.db("plans").insert({
    tenant_id: "primary",
    id: "plan",
    product_id: "product",
    name: "Plan",
    stripe_price_id: "price",
    site_allowance: 1,
  });
  await f.db("work").insert({
    tenant_id: "primary",
    id: "held",
    kind: "reconcile",
    payload: seal({ subscriptionId: "sub_closed" }, secret),
    state: "held",
    created_at: 1,
  });
  f.snapshots.set("sub_closed", {
    subscriptionId: "sub_closed",
    customerId: "cus_closed",
    email: "private@example.test",
    billingStatus: "canceled",
    suspended: false,
    fullyRefunded: false,
    grants: [
      {
        id: "grant",
        invoiceId: "invoice",
        priceId: "price",
        periodStart: 1,
        periodEnd: 1000,
        paidAt: 1,
        settled: true,
      },
    ],
  });
  assert.equal(
    await f.run(["finalize", "--expected-stripe-account", "acct_merchant"], {
      STRIPE_LIVE_MODE: "true",
      STRIPE_SECRET_KEY: "sk_live_fixture",
    }),
    0,
  );
  assert.equal((await f.db("customers")).length, 1);
  assert.equal((await f.db("licenses")).length, 0);
});

test("reviewed legacy receipt upgrade proves scoped mode and customer digest without provider calls", async (t) => {
  const f = await fixture(t);
  const { privacyReferenceDigest } =
    await import("../src/account-management.ts");
  const { unseal } = await import("../src/crypto.ts");
  await f.db("customers").insert({
    tenant_id: "primary",
    id: "closed",
    email: "closed@invalid.invalid",
    stripe_id: null,
  });
  await f.db("account_closures").insert({
    tenant_id: "primary",
    customer_id: "closed",
    id: "closure",
    status: "completed",
    blockers: "[]",
    requested_at: 1,
    completed_at: 2,
  });
  const legacy = {
    referenceDigests: [privacyReferenceDigest(secret, "cus_legacy")],
    stripeLiveMode: false,
    events: [],
  };
  await f.db("account_privacy_receipts").insert({
    tenant_id: "primary",
    customer_id: "closed",
    request_id: "closure",
    id: "receipt",
    details: JSON.stringify(legacy),
    created_at: 1,
  });
  const receipt = {
    version: 1,
    operatorId: "operator@example.test",
    tenantId: "primary",
    customerId: "closed",
    requestId: "closure",
    stripeLiveMode: false,
    approval: {
      quiesced: true,
      stripeReconciled: true,
      retentionReviewed: true,
      reference: "reviewed-backfill",
      stripeCustomerId: "cus_legacy",
      eventIds: [],
      workIds: [],
      auditIds: [],
      outgoingEventIds: [],
    },
  };
  const file = `${f.path}/legacy-review.json`;
  const args = [
    "closure-attribution-upgrade",
    "--tenant",
    "primary",
    "--customer",
    "closed",
    "--request",
    "closure",
    "--receipt",
    file,
  ];
  await writeFile(file, JSON.stringify(receipt), { mode: 0o600 });
  assert.equal(await f.run(args), 0, f.errors.join(" "));
  const upgraded = JSON.parse(
    (await f.db("account_privacy_receipts").first()).details,
  );
  assert.deepEqual(upgraded.referenceDigests, legacy.referenceDigests);
  assert.equal(
    unseal<{ stripeCustomerId: string }>(
      upgraded.stripeCustomerAttribution,
      secret,
    ).stripeCustomerId,
    "cus_legacy",
  );
  assert.ok(!JSON.stringify(upgraded).includes("cus_legacy"));
  assert.equal(f.calls.filter((c) => c !== "db.close").length, 0);
  assert.equal((await f.db("customers").first()).stripe_id, null);
  assert.equal(await f.run(args), 0);
  await writeFile(
    file,
    JSON.stringify({
      ...receipt,
      approval: { ...receipt.approval, stripeCustomerId: "cus_other" },
    }),
    { mode: 0o600 },
  );
  assert.equal(await f.run(args), 1);
  assert.equal(
    JSON.parse(f.errors.at(-1)!).error,
    "privacy_attribution_mismatch",
  );
  await writeFile(file, JSON.stringify({ ...receipt, stripeLiveMode: true }), {
    mode: 0o600,
  });
  assert.equal(await f.run(args), 1);
  assert.equal(
    JSON.parse(f.errors.at(-1)!).error,
    "privacy_attribution_mismatch",
  );
});

test("legacy missing provider mode requires explicit private reviewed mode and customer proof", async (t) => {
  const f = await fixture(t);
  const { privacyReferenceDigest } =
    await import("../src/account-management.ts");
  await f
    .db("customers")
    .insert({
      tenant_id: "primary",
      id: "closed",
      email: "closed@invalid.invalid",
      stripe_id: null,
    });
  await f
    .db("account_closures")
    .insert({
      tenant_id: "primary",
      customer_id: "closed",
      id: "closure",
      status: "completed",
      blockers: "[]",
      requested_at: 1,
      completed_at: 2,
    });
  const details = {
    referenceDigests: [privacyReferenceDigest(secret, "cus_legacy")],
    events: [],
  };
  await f
    .db("account_privacy_receipts")
    .insert({
      tenant_id: "primary",
      customer_id: "closed",
      request_id: "closure",
      id: "receipt",
      details: JSON.stringify(details),
      created_at: 1,
    });
  const receipt = {
    version: 1,
    operatorId: "operator@example.test",
    tenantId: "primary",
    customerId: "closed",
    requestId: "closure",
    approval: {
      quiesced: true,
      stripeReconciled: true,
      retentionReviewed: true,
      reference: "reviewed-mode",
      stripeCustomerId: "cus_legacy",
      eventIds: [],
      workIds: [],
      auditIds: [],
      outgoingEventIds: [],
    },
  };
  const file = `${f.path}/legacy-mode.json`;
  const args = [
    "closure-attribution-upgrade",
    "--tenant",
    "primary",
    "--customer",
    "closed",
    "--request",
    "closure",
    "--receipt",
    file,
  ];
  await writeFile(file, JSON.stringify(receipt), { mode: 0o600 });
  assert.equal(await f.run(args), 1);
  assert.equal(
    JSON.parse(f.errors.at(-1)!).error,
    "privacy_attribution_mismatch",
  );
  assert.equal(
    JSON.parse((await f.db("account_privacy_receipts").first()).details)
      .stripeLiveMode,
    undefined,
  );
  await writeFile(file, JSON.stringify({ ...receipt, stripeLiveMode: false }), {
    mode: 0o600,
  });
  assert.equal(await f.run(args), 0, f.errors.join(" "));
  assert.equal(
    JSON.parse((await f.db("account_privacy_receipts").first()).details)
      .stripeLiveMode,
    false,
  );
  await f
    .db("account_privacy_receipts")
    .update({ details: JSON.stringify({ ...details, stripeLiveMode: null }) });
  assert.equal(await f.run(args), 1);
});
