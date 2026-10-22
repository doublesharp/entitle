import assert from "node:assert/strict";
import type { Knex } from "knex";

// Each MySQL DDL step can resume after its implicit commit.
export const config = { transaction: false };
export async function up(db: Knex) {
  if (db.client.config.client === "mysql2") await upgrade(db);
  else await db.transaction(upgrade);
}
async function upgrade(db: Knex) {
  const mysql = db.client.config.client === "mysql2";
  for (const field of [
    "pro_paid_through",
    "pro_period_start",
    "platform_billing_revision",
    "automatic_tax",
    "collect_tax_id",
    "collect_billing_address",
  ])
    if (!(await db.schema.hasColumn("tenants", field)))
      await db.schema.alterTable("tenants", (t) => {
        t.double(field).notNullable().defaultTo(0);
      });
  if (!(await db.schema.hasColumn("products", "tax_code")))
    await db.schema.alterTable("products", (t) => {
      t.string("tax_code", 32).nullable();
    });
  if (!(await db.schema.hasTable("platform_grants")))
    await db.schema.createTable("platform_grants", (t) => {
      if (mysql) {
        t.charset("utf8mb4");
        t.collate("utf8mb4_bin");
      }
      t.string("tenant_id", 64).notNullable();
      t.string("id", 150).notNullable();
      t.string("subscription_id", 150).notNullable();
      t.string("invoice_id", 150).notNullable();
      t.string("price_id", 150).notNullable();
      t.string("tier", 16).notNullable();
      t.double("period_start").notNullable();
      t.double("period_end").notNullable();
      t.integer("revoked").notNullable().defaultTo(0);
      t.primary(["tenant_id", "id"]);
      if (!mysql)
        t.foreign("tenant_id", "platform_grants_tenant_foreign").references(
          "tenants.id",
        );
    });
  if (mysql) {
    const read = () =>
      db("information_schema.KEY_COLUMN_USAGE")
        .select({
          column: "COLUMN_NAME",
          target: "REFERENCED_TABLE_NAME",
          reference: "REFERENCED_COLUMN_NAME",
        })
        .where("CONSTRAINT_SCHEMA", db.raw("database()"))
        .where({
          TABLE_NAME: "platform_grants",
          CONSTRAINT_NAME: "platform_grants_tenant_foreign",
        });
    let actual = await read();
    if (!actual.length) {
      await db.schema.alterTable("platform_grants", (t) => {
        t.foreign("tenant_id", "platform_grants_tenant_foreign").references(
          "tenants.id",
        );
      });
      actual = await read();
    }
    assert.deepEqual(
      actual,
      [{ column: "tenant_id", target: "tenants", reference: "id" }],
      "Commerce grant constraint manifest mismatch",
    );
  }
}
export async function down(): Promise<void> {
  throw Error("Restore a backup to reverse migrations");
}
