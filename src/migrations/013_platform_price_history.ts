import assert from "node:assert/strict";
import type { Knex } from "knex";

export const config = { transaction: false };
export async function up(db: Knex) {
  if (db.client.config.client === "mysql2") await upgrade(db);
  else await db.transaction(upgrade);
}
async function upgrade(db: Knex) {
  const mysql = db.client.config.client === "mysql2";
  if (!(await db.schema.hasTable("platform_price_history")))
    await db.schema.createTable("platform_price_history", (t) => {
      if (mysql) {
        t.charset("utf8mb4");
        t.collate("utf8mb4_bin");
      }
      t.string("tenant_id", 64).notNullable();
      t.integer("livemode").notNullable();
      t.string("price_id", 150).notNullable();
      t.string("tier", 16).notNullable();
      t.double("verified_at").notNullable();
      t.primary(["tenant_id", "livemode", "price_id"]);
      if (!mysql)
        t.foreign(
          "tenant_id",
          "platform_price_history_tenant_foreign",
        ).references("tenants.id");
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
          TABLE_NAME: "platform_price_history",
          CONSTRAINT_NAME: "platform_price_history_tenant_foreign",
        });
    let actual = await read();
    if (!actual.length) {
      await db.schema.alterTable("platform_price_history", (t) => {
        t.foreign(
          "tenant_id",
          "platform_price_history_tenant_foreign",
        ).references("tenants.id");
      });
      actual = await read();
    }
    assert.deepEqual(
      actual,
      [{ column: "tenant_id", target: "tenants", reference: "id" }],
      "Platform price history constraint manifest mismatch",
    );
  }
  // Grants predate mode attribution. Runtime verifies their actual Stripe price
  // mode before seeding; this migration never guesses a test/live mapping.
}
export async function down(): Promise<void> {
  throw Error("Restore a backup to reverse migrations");
}
