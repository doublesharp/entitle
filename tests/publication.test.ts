import { primaryTenant, testTenantKey } from "./helpers/tenant.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { hash } from "../src/crypto.ts";
import { createDb, migrate, reset } from "../src/db.ts";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { Releases } from "../src/releases.ts";
import { zipBytes } from "./helpers/zip.ts";
const root = await mkdtemp(
  "/Volumes/Scratch/double-entitle-wp/tmp/publication-",
);
const config = loadConfig({ DEPLOYMENT_MODE: "hosted",
  APP_SECRET: "11".repeat(32),
  OPERATOR_TOKEN: "publication-test-operator-token-123456789",
  DATA_DIR: root,
  LOCAL_BILLING: "true",
});
const db = createDb(config.databaseUrl);
const store = new InMemoryArtifactStore();
const app = await buildApp(config, db, undefined, { store });
before(async () => {
  await migrate(db);
  await app.ready();
});
after(async () => {
  await app.close();
  await db.destroy();
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await reset(db);
  await seedTenantKey(db);
});
const base = {
  slug: "catalog-pro",
  name: "Catalog",
  plans: [{ name: "One", siteAllowance: 1, priceId: "price_one" }],
};
async function setup(pluginBasename?: string) {
  return app.inject({
    method: "POST",
    url: "/api/v1/tenants/primary/seller/products",
    headers: { authorization: `Bearer ${testTenantKey}` },
    payload: {
      ...base,
      ...(pluginBasename === undefined ? {} : { pluginBasename }),
    },
  });
}
async function publish(basename: string) {
  const file = `${root}/input.zip`;
  await writeFile(
    file,
    zipBytes([
      {
        name: basename,
        data: "<?php\n/*\nPlugin Name: Test\nVersion: 1.0.0\n*/",
      },
    ]),
  );
  await new Releases(db, store, primaryTenant, config.storage).publish({
    product: base.slug,
    file,
    version: "1.0.0",
    changelog: "First",
    minWp: "6.0",
    minPhp: "8.0",
    minFree: "0.0.0",
    tested: "7.0",
  });
}
test("operator accepts an explicit safe basename and preserves it on omitted setup retries", async () => {
  let result = await setup("installed/bootstrap.php");
  assert.equal(result.statusCode, 200, result.body);
  const id = result.json().product.id;
  assert.equal(
    result.json().product.plugin_basename,
    "installed/bootstrap.php",
  );
  result = await setup();
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().product.id, id);
  assert.equal(
    result.json().product.plugin_basename,
    "installed/bootstrap.php",
  );
  assert.equal(
    (await db("products").first()).plugin_basename,
    "installed/bootstrap.php",
  );
  result = await setup("different/new.php");
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().product.plugin_basename, "different/new.php");
});
test("operator validates basename paths before writing catalog data", async () => {
  for (const basename of [
    "flat.php",
    "../escape.php",
    "dir/../escape.php",
    "/absolute.php",
    "dir/file.txt",
    "dir/sub/file.php",
    "dir\\file.php",
    "dir/.php",
    "dir/file.PHP",
    "dir/file.php/",
    "dir/file.php\n",
    "dir/" + "x".repeat(260) + ".php",
  ]) {
    const response = await setup(basename);
    assert.equal(response.statusCode, 400, basename);
    assert.equal((await db("products")).length, 0);
  }
});
test("operator freezes the effective basename once any release exists, including withdrawn releases", async () => {
  assert.equal((await setup()).statusCode, 200);
  await publish("catalog-pro/catalog-pro.php");
  assert.equal(
    (await db("products").first()).plugin_basename,
    "catalog-pro/catalog-pro.php",
    "first publication must persist and freeze the validated default identity",
  );
  assert.equal((await setup("catalog-pro/catalog-pro.php")).statusCode, 200);
  await db("releases").update({ withdrawn: 1 });
  const result = await setup("different/bootstrap.php");
  assert.equal(result.statusCode, 409, result.body);
  assert.equal(result.json().error.code, "plugin_identity_immutable");
  assert.equal(
    (await db("products").first()).plugin_basename,
    "catalog-pro/catalog-pro.php",
  );
});
test("configured identity also stays fixed after publication and omitted retries preserve it", async () => {
  assert.equal((await setup("installed/main.php")).statusCode, 200);
  await publish("installed/main.php");
  assert.equal((await setup()).statusCode, 200);
  assert.equal((await setup("installed/main.php")).statusCode, 200);
  assert.equal((await setup("catalog-pro/catalog-pro.php")).statusCode, 409);
});

test("migration002 lets a legacy published product bind its actual basename once without direct SQL repair", async () => {
  const legacyRoot = await mkdtemp(
    "/Volumes/Scratch/double-entitle-wp/tmp/legacy-identity-",
  );
  const legacyDb = createDb(`sqlite:${legacyRoot}/db`);
  let legacyApp: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    await legacyDb.migrate.latest({
      migrationSource: {
        getMigrations: async () => ["001_initial"],
        getMigrationName: (name: string) => name,
        getMigration: async () => import("../src/migrations/001_initial.ts"),
      },
    });
    await legacyDb("products").insert({
      id: "legacy",
      slug: "validated-field-pro",
      name: "Legacy",
    });
    await legacyDb("releases").insert({
      id: "00000000-0000-4000-8000-000000000001",
      product_id: "legacy",
      version: "1.0.0",
      changelog: "old release",
      published_at: 1,
      withdrawn: 1,
      checksum: "0".repeat(64),
      size: 1,
      min_wp: "6.0",
      min_php: "8.0",
      min_free: "0.0.0",
      tested: "7.0",
    });
    await migrate(legacyDb);
    assert.equal((await legacyDb("products").first()).plugin_basename, null);
    const legacyConfig = loadConfig({ DEPLOYMENT_MODE: "hosted",
      APP_SECRET: "22".repeat(32),
      OPERATOR_TOKEN: "legacy-identity-operator-token-123456",
      DATA_DIR: legacyRoot,
      LOCAL_BILLING: "true",
    });
    await seedTenantKey(legacyDb);
    legacyApp = await buildApp(legacyConfig, legacyDb, undefined, { store });
    const configure = (pluginBasename: string) =>
      legacyApp!.inject({
        method: "POST",
        url: "/api/v1/tenants/primary/seller/products",
        headers: { authorization: `Bearer ${testTenantKey}` },
        payload: {
          slug: "validated-field-pro",
          name: "Legacy",
          pluginBasename,
          plans: [{ name: "One", siteAllowance: 1, priceId: "price_legacy" }],
        },
      });
    const identity = "double-entitle-example/double-entitle-example.php";
    const configured = await configure(identity);
    assert.equal(configured.statusCode, 200, configured.body);
    const file = legacyRoot + "/release.zip";
    await writeFile(
      file,
      zipBytes([
        {
          name: identity,
          data: "<?php\n/*\nPlugin Name: Example\nVersion: 1.1.0\n*/",
        },
      ]),
    );
    const release = await new Releases(
      legacyDb,
      store,
      primaryTenant,
      legacyConfig.storage,
    ).publish({
      product: "validated-field-pro",
      file,
      version: "1.1.0",
      changelog: "new",
      minWp: "6.0",
      minPhp: "8.0",
      minFree: "0.0.0",
      tested: "7.0",
    });
    assert.equal(release.version, "1.1.0");
    const changed = await configure("other/main.php");
    assert.equal(changed.statusCode, 409);
    assert.equal(changed.json().error.code, "plugin_identity_immutable");
    assert.equal(
      (await legacyDb("products").first()).plugin_basename,
      identity,
    );
  } finally {
    await legacyApp?.close();
    await legacyDb.destroy();
    await rm(legacyRoot, { recursive: true, force: true });
  }
});

async function seedTenantKey(database: import("../src/db.ts").DB) {
  await database("tenant_api_keys").insert({
    id: "regression-key",
    tenant_id: "primary",
    name: "Regression key",
    key_hash: hash(testTenantKey),
    created_at: Date.now(),
    revoked_at: null,
    scopes: JSON.stringify([
      "read",
      "catalog:write",
      "releases:write",
      "licenses:write",
      "billing:reconcile",
    ]),
    expires_at: Date.now() + 86400000,
    last_used_at: null,
    display_prefix: testTenantKey.slice(0, 14),
  });
}
