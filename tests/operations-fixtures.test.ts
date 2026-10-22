import { mkdtemp, rm } from "node:fs/promises";
import { createTenant, type DB, type Tenant } from "../src/db.ts";
import { isolatedDatabase } from "./helpers/database.ts";
import { up } from "../src/migrations/010_operations.ts";

export async function operationsFixture(run: (db: DB, tenant: Tenant, other: Tenant) => Promise<void>) {
  const directory = await mkdtemp("/Volumes/Scratch/double-entitle-wp/tmp/operations-case-");
  const { db, close } = await isolatedDatabase(`sqlite:${directory}/db`);
  try {
    // Exercise our schema against the stable predecessor, independently of
    // parallel agents' in-progress migration registration and DDL.
    const migrations=["001_initial","002_plugin_identity","003_tenants","004_stripe_status","005_security","006_checkout","007_frameworks"];
    await db.migrate.latest({migrationSource:{getMigrations:async()=>migrations,getMigrationName:(name:string)=>name,getMigration:async(name:string)=>import(`../src/migrations/${name}.ts`)}});
    await up(db);
    const tenant = await createTenant(db, { id: "operations-a", slug: "operations-a", name: "A", trial_ends_at: Number.MAX_SAFE_INTEGER });
    const other = await createTenant(db, { id: "operations-b", slug: "operations-b", name: "B", trial_ends_at: Number.MAX_SAFE_INTEGER });
    await run(db, tenant, other);
  } finally { await close(); await rm(directory, { recursive: true, force: true }); }
}
export async function seedOperationLicense(db: DB, tenant: Tenant, now = 1800000000000) {
  const prefix = tenant.id;
  await db("products").insert({ tenant_id: prefix, id: `${prefix}-product`, slug: "product", name: "Product" });
  await db("plans").insert({ tenant_id: prefix, id: `${prefix}-plan`, product_id: `${prefix}-product`, name: "Plan", site_allowance: 1, stripe_price_id: "price" });
  await db("customers").insert({ tenant_id: prefix, id: `${prefix}-customer`, email: "buyer@example.test", stripe_id: "customer" });
  await db("licenses").insert({ tenant_id: prefix, id: `${prefix}-license`, customer_id: `${prefix}-customer`, product_id: `${prefix}-product`, plan_id: `${prefix}-plan`, paid_through: now + 86400000, site_allowance: 1, billing_status: "active", subscription_id: "subscription", key_hash: "a".repeat(64) });
  await db("releases").insert({ tenant_id: prefix, id: `${prefix}-release`, product_id: `${prefix}-product`, version: "1.0.0", changelog: "", published_at: now, checksum: "a".repeat(64), size: 100, min_wp: "6", min_php: "8", min_free: "0", tested: "7" });
  return { license: `${prefix}-license`, customer: `${prefix}-customer`, release: `${prefix}-release` };
}

