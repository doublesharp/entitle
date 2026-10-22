import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { migrate } from "../src/db.ts";
import { isolatedDatabase } from "./helpers/database.ts";

test("commerce migration defaults tax off, isolates durable grants and resumes forward only", async () => {
  const root = await mkdtemp(
    "/Volumes/Scratch/double-entitle-wp/tmp/commerce-schema-",
  );
  const fixture = await isolatedDatabase(`sqlite:${root}/db`);
  try {
    await migrate(fixture.db);
    const migration = await import("../src/migrations/008_commerce.ts").catch(
      () => undefined,
    );
    assert.ok(migration?.up, "commerce migration is required");
    await migration.up(fixture.db);
    await migration.up(fixture.db);
    const tenant = await fixture.db("tenants").where({ id: "primary" }).first();
    for (const field of [
      "automatic_tax",
      "collect_tax_id",
      "collect_billing_address",
      "pro_paid_through",
      "pro_period_start",
      "platform_billing_revision",
    ])
      assert.equal(tenant[field], 0);
    await fixture
      .db("products")
      .insert({ tenant_id: "primary", id: "p", slug: "p", name: "Product" });
    assert.equal((await fixture.db("products").first()).tax_code, null);
    const grant = {
      tenant_id: "primary",
      id: "il_test",
      subscription_id: "sub_test",
      invoice_id: "in_test",
      price_id: "price_test",
      tier: "pro",
      period_start: 1,
      period_end: 2,
      revoked: 0,
    };
    await fixture.db("platform_grants").insert(grant);
    await assert.rejects(fixture.db("platform_grants").insert(grant));
    await assert.rejects(
      fixture.db("platform_grants").insert({ ...grant, tenant_id: "unknown" }),
    );
    await assert.rejects(migration.down(), /Restore a backup/);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const [engine, variable] of [
  ["PostgreSQL", "TEST_POSTGRES_DATABASE_URL"],
  ["MySQL", "TEST_MYSQL_DATABASE_URL"],
] as const)
  test(
    `${engine} commerce migration applies and resumes on a real isolated database`,
    { skip: !process.env[variable] },
    async () => {
      const previous = process.env.TEST_SAAS_DATABASE_URL;
      process.env.TEST_SAAS_DATABASE_URL = process.env[variable];
      const root = await mkdtemp(
        "/Volumes/Scratch/double-entitle-wp/tmp/commerce-engine-",
      );
      const fixture = await isolatedDatabase(`sqlite:${root}/db`),
        db = fixture.db;
      try {
        await migrate(db);
        const migration = await import("../src/migrations/008_commerce.ts");
        if (engine === "MySQL") {
          // Exercise implicit-commit recovery after CREATE but before the FK.
          if (await db.schema.hasTable("platform_grants"))
            await db.schema.dropTable("platform_grants");
          let interrupted = false;
          const interrupt = (_result: unknown, query: { sql: string }) => {
            if (
              !interrupted &&
              query.sql.startsWith("create table `platform_grants`")
            ) {
              interrupted = true;
              throw Error("interrupted after CREATE");
            }
          };
          db.on("query-response", interrupt);
          await assert.rejects(migration.up(db), /interrupted after CREATE/);
          db.removeListener("query-response", interrupt);
          assert.equal(interrupted, true);
        }
        await migration.up(db);
        await migration.up(db);
        const history =
          await import("../src/migrations/013_platform_price_history.ts");
        if (engine === "MySQL") {
          if (await db.schema.hasTable("platform_price_history"))
            await db.schema.dropTable("platform_price_history");
          let interrupted = false;
          const interrupt = (_result: unknown, query: { sql: string }) => {
            if (
              !interrupted &&
              query.sql.startsWith("create table `platform_price_history`")
            ) {
              interrupted = true;
              throw Error("history CREATE interrupted");
            }
          };
          db.on("query-response", interrupt);
          await assert.rejects(history.up(db), /history CREATE interrupted/);
          db.removeListener("query-response", interrupt);
          assert.equal(interrupted, true);
        }
        await history.up(db);
        await history.up(db);
        await assert.rejects(
          db("platform_price_history").insert({
            tenant_id: "missing",
            livemode: 0,
            price_id: "p",
            tier: "pro",
            verified_at: 1,
          }),
        );
        if (engine === "MySQL") {
          await db.schema.alterTable("platform_price_history", (t) =>
            t.dropForeign("tenant_id", "platform_price_history_tenant_foreign"),
          );
          await db.schema.alterTable("platform_price_history", (t) =>
            t
              .foreign("tenant_id", "platform_price_history_tenant_foreign")
              .references("seller_users.id"),
          );
          await assert.rejects(
            history.up(db),
            /Platform price history constraint manifest mismatch/,
          );
        }
        const tenant = await db("tenants").where({ id: "primary" }).first();
        assert.equal(Number(tenant.automatic_tax), 0);
        await assert.rejects(
          db("platform_grants").insert({
            tenant_id: "missing",
            id: "g",
            subscription_id: "s",
            invoice_id: "i",
            price_id: "p",
            tier: "pro",
            period_start: 1,
            period_end: 2,
          }),
        );
        if (engine === "MySQL") {
          await db.schema.alterTable("platform_grants", (t) =>
            t.dropForeign("tenant_id", "platform_grants_tenant_foreign"),
          );
          await db.schema.alterTable("platform_grants", (t) =>
            t
              .foreign("tenant_id", "platform_grants_tenant_foreign")
              .references("seller_users.id"),
          );
          await assert.rejects(
            migration.up(db),
            /Commerce grant constraint manifest mismatch/,
          );
        }
      } finally {
        await fixture.close();
        await rm(root, { recursive: true, force: true });
        if (previous === undefined) delete process.env.TEST_SAAS_DATABASE_URL;
        else process.env.TEST_SAAS_DATABASE_URL = previous;
      }
    },
  );

test("migration013 persists mode-scoped tenant price history without guessing legacy modes", async () => {
  const root = await mkdtemp(
    "/Volumes/Scratch/double-entitle-wp/tmp/commerce-history-",
  );
  const fixture = await isolatedDatabase(`sqlite:${root}/db`),
    db = fixture.db;
  try {
    await migrate(db);
    const migration =
      await import("../src/migrations/013_platform_price_history.ts").catch(
        () => undefined,
      );
    assert.ok(migration?.up, "forward price-history migration is required");
    await migration.up(db);
    await migration.up(db);
    assert.equal((await db("platform_price_history")).length, 0);
    const history = {
      tenant_id: "primary",
      livemode: 0,
      price_id: "price_history",
      tier: "pro",
      verified_at: 1,
    };
    await db("platform_price_history").insert(history);
    await assert.rejects(db("platform_price_history").insert(history));
    await db("platform_price_history").insert({ ...history, livemode: 1 });
    await assert.rejects(
      db("platform_price_history").insert({ ...history, tenant_id: "foreign" }),
    );
    await assert.rejects(migration.down(), /Restore a backup/);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
