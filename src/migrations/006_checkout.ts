import assert from "node:assert/strict";
import type { Knex } from "knex";

export const config = { transaction: false };
export async function up(db: Knex) {
  if (db.client.config.client === "mysql2") await upgrade(db);
  else await db.transaction(upgrade);
}
async function upgrade(db: Knex) {
  const mysql = db.client.config.client === "mysql2";
  if (!(await db.schema.hasTable("platform_checkouts"))) {
    await db.schema.createTable("platform_checkouts", (table) => {
      if (mysql) {
        table.charset("utf8mb4");
        table.collate("utf8mb4_bin");
      }
      table.string("tenant_id", 64).primary();
      table.string("id", 64).notNullable();
      table.string("customer_id", 150).notNullable();
      table.string("price_id", 150).notNullable();
      table.string("session_id", 150).nullable();
      table.double("attempted_at").nullable();
      table.string("lease_owner", 64).nullable();
      table.double("lease_until").notNullable().defaultTo(0);
      table.double("created_at").notNullable();
      if (!mysql)
        table
          .foreign("tenant_id", "platform_checkouts_tenant_foreign")
          .references("tenants.id");
    });
  }
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
          TABLE_NAME: "platform_checkouts",
          CONSTRAINT_NAME: "platform_checkouts_tenant_foreign",
        });
    let actual = await read();
    if (!actual.length) {
      await db.schema.alterTable("platform_checkouts", (table) =>
        table
          .foreign("tenant_id", "platform_checkouts_tenant_foreign")
          .references("tenants.id"),
      );
      actual = await read();
    }
    assert.deepEqual(
      actual,
      [{ column: "tenant_id", target: "tenants", reference: "id" }],
      "Platform checkout constraint manifest mismatch",
    );
  }
}
export async function down(): Promise<void> {
  throw Error("Restore a backup to reverse migrations");
}
