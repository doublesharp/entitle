import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createDb, migrate, type DB } from "../src/db.ts";

async function fixture(run: (db: DB) => Promise<void>) {
  const path = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/tenant-schema-",
  );
  const db = createDb(`sqlite:${path}/db`);
  try {
    await migrate(db);
    await run(db);
  } finally {
    await db.destroy();
    await rm(path, { recursive: true, force: true });
  }
}
async function seed(db: DB, tenant_id: string) {
  await db("tenants").insert({
    id: tenant_id,
    slug: tenant_id,
    name: tenant_id,
    created_at: 1,
  });
  await db("products").insert({
    tenant_id,
    id: `${tenant_id}-product`,
    slug: "same",
    name: "Product",
  });
  await db("customers").insert({
    tenant_id,
    id: `${tenant_id}-customer`,
    email: "same@example.com",
    stripe_id: "cus_same",
  });
  await db("plans").insert({
    tenant_id,
    id: `${tenant_id}-plan`,
    product_id: `${tenant_id}-product`,
    name: "Plan",
    site_allowance: 1,
    stripe_price_id: "price_same",
  });
}

test("tenant namespaces permit repeated slugs, emails, provider IDs and event IDs", async () =>
  fixture(async (db) => {
    await seed(db, "one");
    await seed(db, "two");
    for (const tenant_id of ["one", "two"]) {
      await db("billing_events").insert({
        tenant_id,
        id: "evt_same",
        type: "invoice.paid",
        payload: "{}",
        received_at: 1,
      });
      await db("licenses").insert({
        tenant_id,
        id: `${tenant_id}-license`,
        customer_id: `${tenant_id}-customer`,
        product_id: `${tenant_id}-product`,
        plan_id: `${tenant_id}-plan`,
        site_allowance: 1,
        paid_through: 1,
        billing_status: "active",
        subscription_id: "sub_same",
        key_hash: "same",
      });
      await db("grants").insert({
        tenant_id,
        id: "line_same",
        license_id: `${tenant_id}-license`,
        invoice_id: "in_same",
        plan_id: `${tenant_id}-plan`,
        period_start: 1,
        period_end: 2,
        paid_at: 1,
      });
    }
    assert.equal((await db("grants")).length, 2);
    await assert.rejects(
      db("products").insert({
        tenant_id: "one",
        id: "duplicate",
        slug: "same",
        name: "Duplicate",
      }),
      /UNIQUE/,
    );
    await assert.rejects(
      db("products").insert({
        id: "unscoped",
        slug: "unscoped",
        name: "Missing tenant",
      }),
      /NOT NULL/,
    );
  }));

test("composite database foreign keys reject cross-tenant ownership", async () =>
  fixture(async (db) => {
    await seed(db, "one");
    await seed(db, "two");
    await assert.rejects(
      db("plans").insert({
        tenant_id: "one",
        id: "bad-plan",
        product_id: "two-product",
        name: "Plan",
        site_allowance: 1,
        stripe_price_id: "bad",
      }),
      /FOREIGN KEY/,
    );
    const license = {
      tenant_id: "one",
      id: "license",
      customer_id: "one-customer",
      product_id: "one-product",
      plan_id: "one-plan",
      site_allowance: 1,
      paid_through: 1,
      billing_status: "active",
      subscription_id: "sub",
      key_hash: "hash",
    };
    for (const column of ["customer_id", "product_id", "plan_id"]) {
      await assert.rejects(
        db("licenses").insert({
          ...license,
          [column]: `two-${column.split("_")[0]}`,
        }),
        /FOREIGN KEY/,
      );
    }
    await assert.rejects(
      db("releases").insert({
        tenant_id: "one",
        id: "release",
        product_id: "two-product",
        version: "1",
        changelog: "",
        published_at: 1,
        checksum: "hash",
        size: 1,
        min_wp: "",
        min_php: "",
        min_free: "",
        tested: "",
      }),
      /FOREIGN KEY/,
    );
    await db("licenses").insert(license);
    await assert.rejects(
      db("grants").insert({
        tenant_id: "two",
        id: "bad-grant",
        license_id: "license",
        invoice_id: "in",
        plan_id: "two-plan",
        period_start: 1,
        period_end: 2,
        paid_at: 1,
      }),
      /FOREIGN KEY/,
    );
    await assert.rejects(
      db("grants").insert({
        tenant_id: "one",
        id: "bad-plan-grant",
        license_id: "license",
        invoice_id: "in",
        plan_id: "two-plan",
        period_start: 1,
        period_end: 2,
        paid_at: 1,
      }),
      /FOREIGN KEY/,
    );
    await assert.rejects(
      db("installations").insert({
        tenant_id: "two",
        id: "bad-site",
        license_id: "license",
        installation_id: "site",
        site_url: "https://example.com",
        active: 1,
        exempt: 0,
        token_hash: "hash",
        token_cipher: "encrypted",
      }),
      /FOREIGN KEY/,
    );
    await assert.rejects(
      db("emails").insert({
        tenant_id: "two",
        id: "bad-email",
        kind: "test",
        payload: "encrypted",
        customer_id: "two-customer",
        license_id: "license",
        created_at: 1,
      }),
      /FOREIGN KEY/,
    );
    await assert.rejects(
      db("emails").insert({
        tenant_id: "two",
        id: "bad-customer-email",
        kind: "test",
        payload: "encrypted",
        customer_id: "one-customer",
        created_at: 1,
      }),
      /FOREIGN KEY/,
    );
    await db("releases").insert({
      tenant_id: "two",
      id: "two-release",
      product_id: "two-product",
      version: "1",
      changelog: "",
      published_at: 1,
      checksum: "hash",
      size: 1,
      min_wp: "",
      min_php: "",
      min_free: "",
      tested: "",
    });
    await assert.rejects(
      db("download_metrics").insert({
        tenant_id: "one",
        release_id: "two-release",
        day: "2026-10-21",
        successful_responses: 1,
      }),
      /FOREIGN KEY/,
    );
    await assert.rejects(
      db("sessions").insert({
        tenant_id: "one",
        id: "session",
        customer_id: "two-customer",
        expires_at: 1,
      }),
      /FOREIGN KEY/,
    );
    await assert.rejects(
      db("login_tokens").insert({
        tenant_id: "one",
        id: "login",
        customer_id: "two-customer",
        expires_at: 1,
      }),
      /FOREIGN KEY/,
    );
  }));

test("forward migration preserves populated rows and invalidates old authentication links", async () => {
  const path = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/tenant-upgrade-",
  );
  const db = createDb(`sqlite:${path}/db`);
  try {
    await db.migrate.latest({
      migrationSource: {
        getMigrations: async () => ["001_initial", "002_plugin_identity"],
        getMigrationName: (name: string) => name,
        getMigration: async (name: string) =>
          name === "001_initial"
            ? import("../src/migrations/001_initial.ts")
            : import("../src/migrations/002_plugin_identity.ts"),
      },
    });
    await db("products").insert({
      id: "old",
      slug: "old",
      name: "Old",
      plugin_basename: "old/main.php",
    });
    await db("customers").insert({ id: "buyer", email: "buyer@example.com" });
    await db("sessions").insert({
      id: "session",
      customer_id: "buyer",
      expires_at: 100,
    });
    await db("login_tokens").insert({
      id: "login",
      customer_id: "buyer",
      expires_at: 100,
    });
    await migrate(db);
    await migrate(db);
    assert.equal(
      (await db("products").where({ id: "old" }).first()).tenant_id,
      "primary",
    );
    assert.equal(
      (await db("products").first()).plugin_basename,
      "old/main.php",
    );
    assert.equal(
      (await db("tenants").where({ id: "primary" }).first()).exempt,
      1,
    );
    assert.equal((await db("sessions")).length, 0);
    assert.equal((await db("login_tokens")).length, 0);
    assert.equal(
      (
        await db("locks").whereIn("id", [
          "primary:auth",
          "primary:billing",
          "primary:email",
          "primary:schema",
          "primary:work",
        ])
      ).length,
      5,
    );
  } finally {
    await db.destroy();
    await rm(path, { recursive: true, force: true });
  }
});

test("tenant creation seeds independent locks and reset removes children before tenants", async () =>
  fixture(async (db) => {
    const { createTenant, lock, reset } = await import("../src/db.ts");
    const tenant = await createTenant(db, {
      id: "created",
      slug: "created",
      name: "Created",
    });
    assert.equal(tenant.exempt, 0);
    assert.equal(tenant.max_storage_bytes, 1024 ** 3);
    assert.equal(tenant.max_products, 20);
    assert.equal(tenant.billing_status, "trial");
    assert.ok(tenant.trial_ends_at > tenant.created_at);
    await assert.rejects(lock(db, "missing"), /missing lock/);
    await assert.rejects(lock(db, "billing", "missing"), /missing lock/);
    await lock(db, "billing");
    await lock(db, "billing", tenant.id);
    assert.equal(
      (await db("locks").where({ id: "created:billing" }).first()).version,
      1,
    );
    assert.equal(
      (await db("locks").where({ id: "primary:billing" }).first()).version,
      0,
    );
    await db("seller_users").insert({
      id: "seller",
      email: "seller@example.com",
      created_at: 1,
    });
    await db("seller_memberships").insert({
      user_id: "seller",
      tenant_id: tenant.id,
      created_at: 1,
    });
    await db("seller_sessions").insert({
      id: "seller-session",
      user_id: "seller",
      expires_at: 100,
    });
    await db("oauth_states").insert({
      id: "oauth",
      tenant_id: tenant.id,
      user_id: "seller",
      session_id: "seller-session",
      redirect_uri: "https://example.com/callback",
      expires_at: 100,
    });
    await db("upload_reservations").insert({
      tenant_id: tenant.id,
      id: "upload",
      bytes: 100,
      expires_at: 10,
    });
    await db("invoice_metrics").insert({
      tenant_id: tenant.id,
      invoice_id: "in",
      currency: "usd",
      paid_minor: 100,
      refunded_minor: 0,
    });
    await db("tenants").where({ id: "primary" }).update({
      stripe_account_id: "acct_changed",
      billing_status: "past_due",
      suspended: 1,
    });
    await reset(db);
    assert.equal((await db("tenants").first()).stripe_account_id, null);
    assert.equal((await db("tenants").first()).suspended, 0);
    assert.equal((await db("tenants")).length, 1);
    assert.equal((await db("tenants").first()).id, "primary");
    assert.equal((await db("oauth_states")).length, 0);
    assert.equal((await db("seller_users")).length, 0);
    await db("locks").insert({ id: "collision:auth" });
    await assert.rejects(
      createTenant(db, {
        id: "collision",
        slug: "collision",
        name: "Collision",
      }),
      /UNIQUE/,
    );
    assert.equal(
      await db("tenants").where({ id: "collision" }).first(),
      undefined,
    );
    await assert.rejects(
      createTenant(db, { id: "primary", slug: "other", name: "Duplicate" }),
      /UNIQUE/,
    );
  }));

test("security migration upgrades legacy seller credentials without granting old keys", async () =>
  fixture(verifySecurityUpgrade));
async function verifySecurityUpgrade(db: DB) {
  await db.schema.alterTable("seller_login_tokens", (table) => {
    table.dropColumn("browser_hash");
    table.dropColumn("created_at");
  });
  await db.schema.alterTable("tenant_api_keys", (table) => {
    for (const name of [
      "scopes",
      "expires_at",
      "last_used_at",
      "display_prefix",
    ])
      table.dropColumn(name);
  });
  await db("seller_users").insert({
    id: "legacy-user",
    email: "legacy@example.com",
    created_at: 1,
  });
  await db("seller_login_tokens").insert({
    id: "legacy-token",
    user_id: "legacy-user",
    expires_at: Date.now() + 100000,
  });
  await db("tenant_api_keys").insert({
    id: "legacy-key",
    tenant_id: "primary",
    name: "Legacy",
    key_hash: "legacy-hash",
    created_at: 1,
  });
  await db("knex_migrations").where({ name: "005_security" }).delete();
  await migrate(db);
  assert.equal(
    await db.schema.hasColumn("seller_login_tokens", "browser_hash"),
    true,
  );
  const token = await db("seller_login_tokens")
    .where({ id: "legacy-token" })
    .first();
  assert.equal(token.used, 1);
  assert.equal(token.browser_hash, null);
  assert.equal(token.created_at, 0);
  const key = await db("tenant_api_keys").where({ id: "legacy-key" }).first();
  assert.equal(key.scopes, "[]");
  assert.equal(key.expires_at, null);
  assert.equal(key.last_used_at, null);
  assert.equal(key.display_prefix, "");
  const { up, down } = await import("../src/migrations/005_security.ts");
  await db("seller_login_tokens").insert({
    id: "new-token",
    user_id: "legacy-user",
    browser_hash: "browser",
    created_at: 1,
    expires_at: 100,
  });
  await up(db);
  assert.equal(
    (await db("seller_login_tokens").where({ id: "new-token" }).first()).used,
    0,
  );
  await assert.rejects(down(), /Restore a backup/);
}

async function verifyStripeStatusUpgrade(db: DB) {
  await db("tenants").insert([
    {
      id: "legacy-connected",
      slug: "legacy-connected",
      name: "Connected",
      stripe_account_id: "acct_legacy",
      billing_status: "past_due",
      created_at: 1,
    },
    {
      id: "legacy-unconnected",
      slug: "legacy-unconnected",
      name: "Unconnected",
      billing_status: "active",
      created_at: 1,
    },
  ]);
  await migrate(db);
  assert.equal(
    (await db("tenants").where({ id: "primary" }).first()).stripe_status,
    "platform",
  );
  const connected = await db("tenants")
    .where({ id: "legacy-connected" })
    .first();
  assert.equal(connected.stripe_status, "connected");
  assert.equal(connected.billing_status, "past_due");
  assert.equal(
    (await db("tenants").where({ id: "legacy-unconnected" }).first())
      .stripe_status,
    "unconnected",
  );
  await db("tenants")
    .where({ id: "legacy-connected" })
    .update({ stripe_status: "disconnected", billing_status: "active" });
  const { up, down } = await import("../src/migrations/004_stripe_status.ts");
  await up(db);
  assert.equal(
    (await db("tenants").where({ id: "legacy-connected" }).first())
      .stripe_status,
    "disconnected",
  );
  await assert.rejects(down(), /Restore a backup/);
}

test("Stripe connection state upgrades independently from platform subscription status", async () => {
  const path = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/stripe-status-upgrade-",
  );
  const db = createDb(`sqlite:${path}/db`);
  try {
    await db.migrate.latest({
      migrationSource: {
        getMigrations: async () => [
          "001_initial",
          "002_plugin_identity",
          "003_tenants",
        ],
        getMigrationName: (name: string) => name,
        getMigration: async (name: string) =>
          name === "001_initial"
            ? import("../src/migrations/001_initial.ts")
            : name === "002_plugin_identity"
              ? import("../src/migrations/002_plugin_identity.ts")
              : import("../src/migrations/003_tenants.ts"),
      },
    });
    await verifyStripeStatusUpgrade(db);
    const { createTenant } = await import("../src/db.ts");
    assert.equal(
      (
        await createTenant(db, {
          id: "new-connected",
          slug: "new-connected",
          name: "Connected",
          stripe_account_id: "acct_new",
        })
      ).stripe_status,
      "connected",
    );
    assert.equal(
      (
        await createTenant(db, {
          id: "new-empty",
          slug: "new-empty",
          name: "Empty",
        })
      ).stripe_status,
      "unconnected",
    );
    assert.equal(
      (
        await createTenant(db, {
          id: "new-restricted",
          slug: "new-restricted",
          name: "Restricted",
          stripe_status: "restricted",
        })
      ).stripe_status,
      "restricted",
    );
    await db("tenants")
      .where({ id: "primary" })
      .update({ stripe_status: "restricted" });
    const { reset } = await import("../src/db.ts");
    await reset(db);
    assert.equal((await db("tenants").first()).stripe_status, "platform");
  } finally {
    await db.destroy();
    await rm(path, { recursive: true, force: true });
  }
});

async function interruptedMysqlUpgrade(db: DB) {
  const { up, down } = await import("../src/migrations/003_tenants.ts");
  async function interrupt(
    sql: (query: { sql: string; bindings?: unknown[] }) => boolean,
  ) {
    const listener = (
      _result: unknown,
      query: { sql: string; bindings?: unknown[] },
    ) => {
      if (sql(query)) throw Error("injected migration interruption");
    };
    db.on("query-response", listener);
    try {
      await assert.rejects(up(db), /injected migration interruption/);
    } finally {
      db.removeListener("query-response", listener);
    }
  }
  await interrupt((query) => query.sql.startsWith("create table `tenants`"));
  await interrupt((query) =>
    query.sql.startsWith("create table `products_tenant_003`"),
  );
  await interrupt((query) =>
    query.sql.startsWith("create table `plans_tenant_003`"),
  );
  await interrupt(
    (query) =>
      query.sql.startsWith("update `tenant_migration_003`") &&
      query.bindings?.[0] === "drop",
  );
  assert.equal(
    (await db("products").where({ id: "old" }).first()).name,
    "Old 🎹",
  );
  await db("tenant_migration_003").update({ phase: "copy" });
  await db("products_tenant_003")
    .where({ id: "old" })
    .update({ name: "Corrupted copy" });
  await assert.rejects(up(db), /row verification failed/);
  await db("products_tenant_003")
    .where({ id: "old" })
    .update({ name: "Old 🎹" });
  await db("products_tenant_003").insert({
    id: "extra",
    tenant_id: "primary",
    slug: "extra",
    name: "Extra",
  });
  await assert.rejects(up(db), /copy verification failed/);
  await db("products_tenant_003").where({ id: "extra" }).delete();
  const missingReadback = (result: unknown, query: { sql: string }) => {
    if (query.sql.startsWith("select * from `products_tenant_003`"))
      (result as unknown[]).length = 0;
  };
  db.on("query-response", missingReadback);
  try {
    await assert.rejects(up(db), /row verification failed/);
  } finally {
    db.removeListener("query-response", missingReadback);
  }
  await interrupt((query) => query.sql === "drop table if exists `sessions`");
  assert.equal((await db("tenant_migration_003").first()).phase, "drop");
  await interrupt(
    (query) =>
      query.sql.startsWith("update `tenant_migration_003`") &&
      query.bindings?.[0] === "rename",
  );
  assert.equal(await db.schema.hasTable("products"), false);
  await interrupt(
    (query) => query.sql === "rename table `products_tenant_003` to `products`",
  );
  await interrupt((query) =>
    query.sql.startsWith("create table `seller_users`"),
  );
  await interrupt((query) =>
    query.sql.startsWith("create table `tenant_api_keys`"),
  );
  await up(db);
  await up(db);
  // A final readback failure must prevent the complete marker, even when all
  // CREATE/ALTER repair operations appeared successful.
  await db("tenant_migration_003").update({ phase: "rename" });
  let checks = 0;
  const missingManifest = (
    result: unknown,
    query: { sql: string; bindings?: unknown[] },
  ) => {
    if (
      query.sql.includes("information_schema`.`STATISTICS") &&
      query.bindings?.includes("products_tenant_003_tenant_id_slug_unique")
    ) {
      checks++;
      if (checks === 2) (result as unknown[]).length = 0;
    }
  };
  db.on("query-response", missingManifest);
  try {
    await assert.rejects(up(db), /constraint manifest mismatch/);
  } finally {
    db.removeListener("query-response", missingManifest);
  }
  assert.equal((await db("tenant_migration_003").first()).phase, "rename");
  await up(db);
  await db("tenant_migration_003").update({ phase: "invalid" });
  await assert.rejects(up(db), /Unknown tenant migration phase/);
  assert.equal(
    (await db("products").where({ id: "old" }).first()).name,
    "Old 🎹",
  );
  await db("tenant_migration_003").update({ phase: "complete" });
  await assert.rejects(down(), /Restore a backup/);
}

for (const engine of ["POSTGRES", "MYSQL"]) {
  const url = process.env[`TEST_${engine}_DATABASE_URL`];
  test(
    `real ${engine} populated tenant upgrade, isolated namespaces and foreign keys`,
    { skip: !url },
    async () => {
      const { randomUUID } = await import("node:crypto");
      const connection = new URL(url!);
      const databaseName = `entitle_tenant_${randomUUID().replaceAll("-", "")}`;
      const adminConnection = new URL(connection);
      adminConnection.pathname = engine === "POSTGRES" ? "/postgres" : "/mysql";
      const admin = createDb(adminConnection.href);
      let db: DB | undefined;
      let created = false;
      try {
        await admin.raw(
          engine === "MYSQL"
            ? "CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"
            : "CREATE DATABASE ??",
          [databaseName],
        );
        created = true;
        connection.pathname = `/${databaseName}`;
        db = createDb(connection.href);
        await db.migrate.latest({
          migrationSource: {
            getMigrations: async () => ["001_initial", "002_plugin_identity"],
            getMigrationName: (name: string) => name,
            getMigration: async (name: string) =>
              name === "001_initial"
                ? import("../src/migrations/001_initial.ts")
                : import("../src/migrations/002_plugin_identity.ts"),
          },
        });
        await db("products").insert({
          id: "old",
          slug: "old",
          name: "Old 🎹",
          plugin_basename: "old/main.php",
        });
        await db("customers").insert({
          id: "old-customer",
          email: "old@example.com",
          stripe_id: "cus_old",
        });
        await db("plans").insert({
          id: "old-plan",
          product_id: "old",
          name: "Old plan",
          site_allowance: 1,
          stripe_price_id: "price_old",
        });
        await db("licenses").insert({
          id: "old-license",
          customer_id: "old-customer",
          product_id: "old",
          plan_id: "old-plan",
          site_allowance: 1,
          paid_through: 1,
          billing_status: "active",
          subscription_id: "sub_old",
          key_hash: "old",
        });
        await db("grants").insert({
          id: "old-line",
          license_id: "old-license",
          invoice_id: "in_old",
          plan_id: "old-plan",
          period_start: 1,
          period_end: 2,
          paid_at: 1,
        });
        await db("installations").insert({
          id: "old-site",
          license_id: "old-license",
          installation_id: "site",
          site_url: "https://example.com",
          active: 1,
          exempt: 0,
          token_hash: "token",
          token_cipher: "encrypted",
        });
        await db("releases").insert({
          id: "old-release",
          product_id: "old",
          version: "1",
          changelog: "Old",
          published_at: 1,
          checksum: "hash",
          size: 1,
          min_wp: "",
          min_php: "",
          min_free: "",
          tested: "",
        });
        await db("billing_events").insert({
          id: "evt_old",
          type: "invoice.paid",
          payload: "{}",
          received_at: 1,
        });
        await db("work").insert({
          id: "job",
          kind: "reconcile",
          payload: "{}",
          created_at: 1,
        });
        await db("emails").insert({
          id: "email",
          kind: "receipt",
          payload: "encrypted",
          created_at: 1,
          customer_id: "old-customer",
          license_id: "old-license",
        });
        for (const table of ["login_tokens", "sessions"])
          await db(table).insert({
            id: table,
            customer_id: "old-customer",
            expires_at: 10,
          });
        await db("products").insert(
          Array.from({ length: 101 }, (_, index) => ({
            id: `batch-${String(index).padStart(3, "0")}`,
            slug: `batch-${index}`,
            name: "Batch",
          })),
        );
        if (engine === "MYSQL") await interruptedMysqlUpgrade(db);
        else await (await import("../src/migrations/003_tenants.ts")).up(db);
        await verifyStripeStatusUpgrade(db);
        await migrate(db);
        await migrate(db);
        await verifySecurityUpgrade(db);
        for (const table of [
          "products",
          "customers",
          "plans",
          "licenses",
          "grants",
          "installations",
          "releases",
          "billing_events",
          "work",
          "emails",
        ])
          assert.equal((await db(table).first()).tenant_id, "primary", table);
        assert.equal(
          (await db("products").where({ id: "old" }).first()).name,
          "Old 🎹",
        );
        assert.equal((await db("sessions")).length, 0);
        assert.equal((await db("login_tokens")).length, 0);
        await seed(db, "one");
        await seed(db, "two");
        const { lock } = await import("../src/db.ts");
        await assert.rejects(lock(db, "missing"), /missing lock/);
        await assert.rejects(lock(db, "auth", "one"), /missing lock/);
        const attempts = await Promise.allSettled(
          ["first", "second"].map((id) =>
            db!.transaction(async (tx) => {
              await lock(tx, "schema", "one");
              await tx("upload_reservations").insert({
                tenant_id: "one",
                id,
                bytes: 1,
                expires_at: 1,
              });
            }),
          ),
        );
        for (const attempt of attempts) {
          assert.equal(attempt.status, "rejected");
          if (attempt.status === "rejected")
            assert.match(attempt.reason.message, /missing lock one:schema/);
        }
        assert.equal(
          (await db("upload_reservations").where({ tenant_id: "one" })).length,
          0,
        );
        await assert.rejects(
          db("tenants").insert({
            id: "duplicate-tenant",
            slug: "one",
            name: "Duplicate",
            created_at: 1,
          }),
        );
        await assert.rejects(
          db("plans").insert({
            tenant_id: "one",
            id: "bad",
            product_id: "two-product",
            name: "Bad",
            site_allowance: 1,
            stripe_price_id: "bad",
          }),
        );
        await db("plans").insert({
          tenant_id: "one",
          id: "case",
          product_id: "one-product",
          name: "Case",
          site_allowance: 1,
          stripe_price_id: "price_Same",
        });
        await assert.rejects(
          db("plans").insert({
            tenant_id: "one",
            id: "duplicate",
            product_id: "one-product",
            name: "Duplicate",
            site_allowance: 1,
            stripe_price_id: "price_same",
          }),
        );
        if (engine === "MYSQL") {
          await db.raw(
            "alter table `products` drop index `products_tenant_003_tenant_id_slug_unique`",
          );
          await db.raw(
            "alter table `plans` drop foreign key `plans_tenant_003_tenant_id_product_id_foreign`",
          );
          await db.raw(
            "alter table `tenants` drop index `tenants_slug_unique`",
          );
          const { up: forwardSecurity } =
            await import("../src/migrations/005_security.ts");
          await forwardSecurity(db);
          await assert.rejects(
            db("products").insert({
              tenant_id: "one",
              id: "duplicate-product",
              slug: "same",
              name: "Duplicate",
            }),
          );
          await assert.rejects(
            db("plans").insert({
              tenant_id: "one",
              id: "cross-product",
              product_id: "two-product",
              name: "Cross",
              site_allowance: 1,
              stripe_price_id: "cross",
            }),
          );
          await assert.rejects(
            db("tenants").insert({
              id: "duplicate-tenant-2",
              slug: "one",
              name: "Duplicate",
              created_at: 1,
            }),
          );
          await db("seller_users").insert({
            id: "seller",
            email: "seller@example.com",
            created_at: 1,
          });
          await assert.rejects(
            db("seller_users").insert({
              id: "duplicate-seller",
              email: "seller@example.com",
              created_at: 1,
            }),
          );
          const key = {
            id: "key",
            tenant_id: "one",
            name: "Key",
            key_hash: "key-hash",
            created_at: 1,
          };
          await db("tenant_api_keys").insert(key);
          await assert.rejects(
            db("tenant_api_keys").insert({ ...key, id: "duplicate-key" }),
          );
          await assert.rejects(
            db("tenant_api_keys").insert({
              ...key,
              id: "orphan-key",
              key_hash: "orphan-hash",
              tenant_id: "missing",
            }),
          );
          const tables = await db("information_schema.tables")
            .select({ collation: "TABLE_COLLATION" })
            .where({ TABLE_SCHEMA: databaseName })
            .whereNotIn("TABLE_NAME", [
              "knex_migrations",
              "knex_migrations_lock",
            ]);
          for (const table of tables)
            assert.equal(table.collation, "utf8mb4_bin");
        }
        const { reset } = await import("../src/db.ts");
        await reset(db);
        assert.equal((await db("tenants")).length, 1);
      } finally {
        await db?.destroy();
        try {
          if (created) await admin.raw("DROP DATABASE ??", [databaseName]);
        } finally {
          await admin.destroy();
        }
      }
    },
  );
}
