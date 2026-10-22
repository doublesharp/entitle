import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { migrate, createDb, type DB } from "../src/db.ts";
import { randomUUID } from "node:crypto";
async function fixture(run: (db: DB) => Promise<void>) {
  const directory = await mkdtemp(
    "/Volumes/Scratch/double-entitle-wp/tmp/checkout-schema-",
  );
  const parent =
    process.env.TEST_SAAS_DATABASE_URL ?? process.env.TEST_MYSQL_DATABASE_URL;
  const admin = parent ? createDb(parent) : undefined;
  const name = `entitle_checkout_${randomUUID().replaceAll("-", "")}`;
  let db: DB;
  if (admin) {
    const url = new URL(parent!);
    await admin.raw("CREATE DATABASE ??", [name]);
    url.pathname = `/${name}`;
    db = createDb(url.toString());
  } else db = createDb(`sqlite:${directory}/db`);
  try {
    await migrate(db);
    await run(db);
  } finally {
    await db.destroy();
    if (admin) {
      try {
        await admin.raw("DROP DATABASE ??", [name]);
      } finally {
        await admin.destroy();
      }
    }
    await rm(directory, { recursive: true, force: true });
  }
}
test("durable platform checkout guards migrate with tenant uniqueness, foreign keys and restart-safe data preservation", async () =>
  fixture(async (db) => {
    assert.equal(await db.schema.hasTable("platform_checkouts"), true);
    const { up, down } = await import("../src/migrations/006_checkout.ts");
    const row = {
      tenant_id: "primary",
      id: "attempt",
      customer_id: "cus_platform",
      price_id: "price_platform",
      created_at: Date.now(),
    };
    await db("platform_checkouts").insert(row);
    await up(db);
    await up(db);
    assert.equal((await db("platform_checkouts").first()).id, "attempt");
    await assert.rejects(
      db("platform_checkouts").insert({ ...row, id: "duplicate" }),
    );
    await assert.rejects(
      db("platform_checkouts").insert({ ...row, tenant_id: "missing" }),
    );
    await assert.rejects(down(), /Restore a backup/);
  }));
test("MySQL checkout migration repairs a crash between CREATE and foreign-key ALTER without losing attempts", async (t) =>
  fixture(async (db) => {
    if (db.client.config.client !== "mysql2") {
      t.skip("Requires a real MySQL fixture");
      return;
    }
    const { up } = await import("../src/migrations/006_checkout.ts");
    await db.schema.dropTable("platform_checkouts");
    const interrupt = (_result: unknown, query: { sql: string }) => {
      if (query.sql.startsWith("create table `platform_checkouts`"))
        throw Error("Injected checkout DDL interruption");
    };
    db.on("query-response", interrupt);
    try {
      await assert.rejects(up(db), /Injected checkout DDL interruption/);
    } finally {
      db.off("query-response", interrupt);
    }
    await db("platform_checkouts").insert({
      tenant_id: "primary",
      id: "durable-attempt",
      customer_id: "cus_platform",
      price_id: "price_platform",
      created_at: 1,
    });
    const interruptForeign = (_result: unknown, query: { sql: string }) => {
      if (
        query.sql.startsWith("alter table `platform_checkouts` add constraint")
      )
        throw Error("Injected checkout FK response interruption");
    };
    db.on("query-response", interruptForeign);
    try {
      await assert.rejects(
        up(db),
        /Injected checkout FK response interruption/,
      );
    } finally {
      db.off("query-response", interruptForeign);
    }
    await up(db);
    await up(db);
    assert.equal(
      (await db("platform_checkouts").first()).id,
      "durable-attempt",
    );
    await assert.rejects(
      db("platform_checkouts").insert({
        tenant_id: "missing",
        id: "orphan",
        customer_id: "cus_platform",
        price_id: "price_platform",
        created_at: 1,
      }),
    );
  }));
