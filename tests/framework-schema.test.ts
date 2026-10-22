import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { migrate, reset, createTenant } from "../src/db.ts";
import { isolatedDatabase } from "./helpers/database.ts";

test("migration007 defaults legacy products to WordPress and enforces tenant-scoped immutable asset targets", async () => {
  const root = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/framework-schema-",
  );
  const fixture = await isolatedDatabase(`sqlite:${root}/db`);
  const { db } = fixture;
  try {
    await migrate(db);
    assert.equal(await db.schema.hasTable("release_assets"), true);
    await db("products").insert({
      tenant_id: "primary",
      id: "p",
      slug: "p",
      name: "Legacy",
    });
    const product = await db("products").where({ id: "p" }).first();
    assert.equal(product.framework, "wordpress");
    assert.equal(product.framework_config, "{}");
    assert.equal(await db.schema.hasColumn("installations", "label"), true);
    const release = {
      tenant_id: "primary",
      id: "r",
      product_id: "p",
      version: "1.0.0",
      changelog: "notes",
      published_at: 1,
      checksum: "a".repeat(64),
      size: 4,
      min_wp: "",
      min_php: "",
      min_free: "",
      tested: "",
    };
    await db("releases").insert(release);
    const asset = {
      tenant_id: "primary",
      id: "a",
      release_id: "r",
      target: "linux-x64",
      filename: "app.bin",
      size: 4,
      checksum: "b".repeat(64),
      sha512: Buffer.alloc(64).toString("base64"),
    };
    await db("release_assets").insert(asset);
    await assert.rejects(
      db("release_assets").insert({ ...asset, id: "duplicate" }),
    );
    await createTenant(db, { id: "other", slug: "other", name: "Other" });
    await assert.rejects(
      db("release_assets").insert({
        ...asset,
        id: "foreign",
        tenant_id: "other",
      }),
    );
    await migrate(db);
    await (await import("../src/migrations/007_frameworks.ts")).up(db);
    assert.equal((await db("release_assets")).length, 1);
    await assert.rejects(
      (await import("../src/migrations/007_frameworks.ts")).down(),
      /Restore a backup/,
    );
    await reset(db);
    assert.equal((await db("release_assets")).length, 0);
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("framework configuration is strict, bounded and selects site or device activations", async () => {
  const {
    frameworks,
    validateFramework,
    validateFrameworkConfig,
    activationKind,
  } = await import("../src/frameworks.ts");
  assert.deepEqual(frameworks, [
    "wordpress",
    "joomla",
    "electron",
    "tauri",
    "sparkle",
    "jetbrains",
    "generic",
  ]);
  for (const framework of frameworks)
    assert.equal(validateFramework(framework), framework);
  for (const value of ["unknown", null, 42, {}, "WordPress"])
    assert.throws(() => validateFramework(value));
  for (const framework of [
    "wordpress",
    "electron",
    "tauri",
    "sparkle",
  ] as const) {
    assert.deepEqual(validateFrameworkConfig(framework), {});
    assert.throws(() =>
      validateFrameworkConfig(framework, { unexpected: true }),
    );
    assert.throws(() => validateFrameworkConfig(framework, null));
  }
  const joomla = {
    extensionType: "plugin",
    element: "hello",
    folder: "system",
    client: "site",
    joomlaMajor: 5,
  } as const;
  assert.deepEqual(validateFrameworkConfig("joomla", joomla), joomla);
  for (const value of [
    { ...joomla, folder: undefined },
    { ...joomla, joomlaMajor: 1.2 },
    { ...joomla, joomlaMajor: 999 },
    { ...joomla, element: "../bad" },
    { ...joomla, unknown: true },
    { ...joomla, element: "x".repeat(151) },
  ])
    assert.throws(() => validateFrameworkConfig("joomla", value));
  assert.deepEqual(
    validateFrameworkConfig("joomla", {
      extensionType: "component",
      element: "com_example",
      joomlaMajor: 6,
    }),
    { extensionType: "component", element: "com_example", joomlaMajor: 6 },
  );
  assert.deepEqual(
    validateFrameworkConfig("jetbrains", {
      pluginId: "com.example.plugin",
      sinceBuild: "242",
      untilBuild: "243.*",
    }),
    { pluginId: "com.example.plugin", sinceBuild: "242", untilBuild: "243.*" },
  );
  for (const value of [
    { pluginId: "../bad", sinceBuild: "242" },
    { pluginId: "good", sinceBuild: "bad" },
    { pluginId: "good", sinceBuild: "242", untilBuild: "bad" },
  ])
    assert.throws(() => validateFrameworkConfig("jetbrains", value));
  assert.deepEqual(validateFrameworkConfig("generic"), {});
  assert.equal(activationKind("wordpress", {}), "site");
  assert.equal(activationKind("joomla", joomla), "site");
  assert.equal(activationKind("electron", {}), "device");
  assert.equal(activationKind("generic", {}), "device");
  assert.equal(activationKind("generic", { activationKind: "site" }), "site");
  assert.equal(
    activationKind("generic", { activationKind: "device" }),
    "device",
  );
  assert.throws(() =>
    validateFrameworkConfig("generic", { activationKind: "machine" }),
  );
});

test(
  "MySQL migration resumes after CREATE and refuses mismatched existing constraints",
  {
    skip: !(
      process.env.TEST_MYSQL_DATABASE_URL ?? process.env.TEST_SAAS_DATABASE_URL
    )?.startsWith("mysql:"),
  },
  async () => {
    const root = await mkdtemp(
      "/Volumes/Scratch/entitle/tmp/framework-recovery-",
    );
    const fixture = await isolatedDatabase(
      `sqlite:${root}/db`,
      process.env.TEST_MYSQL_DATABASE_URL ?? process.env.TEST_SAAS_DATABASE_URL,
    );
    const { db } = fixture;
    try {
      await migrate(db);
      const migration = await import("../src/migrations/007_frameworks.ts");
      await db.schema.dropTable("release_assets");
      let interrupted = false;
      const interrupt = (_result: unknown, query: { sql: string }) => {
        if (
          !interrupted &&
          query.sql.startsWith("create table `release_assets`")
        ) {
          interrupted = true;
          throw Error("interrupted after CREATE");
        }
      };
      db.on("query-response", interrupt);
      await assert.rejects(migration.up(db), /interrupted after CREATE/);
      db.removeListener("query-response", interrupt);
      assert.equal(interrupted, true);
      await migration.up(db);
      const indexes = await db("information_schema.STATISTICS")
        .where("TABLE_SCHEMA", db.raw("database()"))
        .where({
          TABLE_NAME: "release_assets",
          INDEX_NAME: "release_assets_target_unique",
        })
        .orderBy("SEQ_IN_INDEX")
        .pluck("COLUMN_NAME");
      assert.deepEqual(indexes, ["tenant_id", "release_id", "target"]);
      await db.schema.alterTable("release_assets", (t) =>
        t.dropForeign(
          ["tenant_id", "release_id"],
          "release_assets_release_foreign",
        ),
      );
      await db.schema.alterTable("release_assets", (t) =>
        t.dropUnique(
          ["tenant_id", "release_id", "target"],
          "release_assets_target_unique",
        ),
      );
      await db.schema.alterTable("release_assets", (t) =>
        t.unique(["tenant_id", "release_id", "filename"], {
          indexName: "release_assets_target_unique",
        }),
      );
      await db.schema.alterTable("release_assets", (t) =>
        t
          .foreign(
            ["tenant_id", "release_id"],
            "release_assets_release_foreign",
          )
          .references(["tenant_id", "id"])
          .inTable("releases"),
      );
      await assert.rejects(migration.up(db), /constraint manifest mismatch/i);
    } finally {
      await fixture.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("migration007 preserves populated legacy product and installation records", async () => {
  const root = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/framework-upgrade-",
  );
  const fixture = await isolatedDatabase(`sqlite:${root}/db`);
  const { db } = fixture;
  try {
    const names = [
      "001_initial",
      "002_plugin_identity",
      "003_tenants",
      "004_stripe_status",
      "005_security",
      "006_checkout",
    ];
    await db.migrate.latest({
      migrationSource: {
        getMigrations: async () => names,
        getMigrationName: (name: string) => name,
        getMigration: async (name: string) =>
          import(`../src/migrations/${name}.ts`),
      },
    });
    await db("products").insert({
      tenant_id: "primary",
      id: "legacy",
      slug: "legacy",
      name: "Legacy",
      plugin_basename: "legacy/bootstrap.php",
    });
    await db("customers").insert({
      tenant_id: "primary",
      id: "buyer",
      email: "buyer@example.com",
    });
    await db("plans").insert({
      tenant_id: "primary",
      id: "plan",
      product_id: "legacy",
      name: "Legacy",
      site_allowance: 1,
      stripe_price_id: "price_legacy",
    });
    await db("licenses").insert({
      tenant_id: "primary",
      id: "license",
      customer_id: "buyer",
      product_id: "legacy",
      plan_id: "plan",
      site_allowance: 1,
      paid_through: 10,
      billing_status: "active",
      subscription_id: "sub_legacy",
      key_hash: "a".repeat(64),
    });
    await db("installations").insert({
      tenant_id: "primary",
      id: "installation",
      license_id: "license",
      installation_id: "stable",
      site_url: "https://site.example",
      active: 1,
      exempt: 0,
      token_hash: "b".repeat(64),
      token_cipher: "preserved",
    });
    await migrate(db);
    const product = await db("products").where({ id: "legacy" }).first();
    assert.equal(product.framework, "wordpress");
    assert.equal(product.framework_config, "{}");
    assert.equal(product.plugin_basename, "legacy/bootstrap.php");
    const installation = await db("installations")
      .where({ id: "installation" })
      .first();
    assert.equal(installation.label, null);
    assert.equal(installation.token_cipher, "preserved");
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("JetBrains minimum build rejects wildcard compatibility ranges", async () => {
  const { validateFrameworkConfig } = await import("../src/frameworks.ts");
  assert.throws(() =>
    validateFrameworkConfig("jetbrains", {
      pluginId: "com.example.plugin",
      sinceBuild: "243.*",
    }),
  );
});

test("Joomla module/template/library/package identity requires an explicit client", async () => {
  const { validateFrameworkConfig } = await import("../src/frameworks.ts");
  for (const extensionType of ["module", "template", "library", "package"]) {
    const config = { extensionType, element: "example", joomlaMajor: 6 };
    assert.throws(() => validateFrameworkConfig("joomla", config));
    assert.deepEqual(
      validateFrameworkConfig("joomla", { ...config, client: "site" }),
      { ...config, client: "site" },
    );
  }
});
