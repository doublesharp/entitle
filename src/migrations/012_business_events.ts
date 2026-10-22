import type { Knex } from "knex";

// MySQL DDL commits independently. Repair each constraint/index on replay,
// matching migration 010 and the binary collation of tenants.id.
export const config = { transaction: false };
export async function up(db: Knex) {
  if (db.client.config.client === "mysql2") await upgrade(db);
  else await db.transaction(upgrade);
}
async function upgrade(db: Knex) {
  const mysql = db.client.config.client === "mysql2";
  const statements = db.schema
    .createTable("business_events", (t) => {
      if (mysql) {
        t.charset("utf8mb4");
        t.collate("utf8mb4_bin");
      }
      t.string("tenant_id", 64).notNullable().references("tenants.id");
      t.string("id", 64).notNullable();
      t.primary(["tenant_id", "id"]);
      // Resource IDs are opaque references, intentionally not FKs: business
      // history survives resource deletion and never retains PII or secrets.
      t.string("type", 40).notNullable();
      t.string("resource_id", 64).notNullable();
      t.double("occurred_at").notNullable();
      t.string("state", 20).notNullable().defaultTo("pending");
      t.integer("attempts").notNullable().defaultTo(0);
      t.double("available_at").notNullable().defaultTo(0);
      t.double("lease_until").notNullable().defaultTo(0);
      t.string("lease_owner", 64).nullable();
      t.string("last_error", 40).nullable();
      t.index(["tenant_id", "state", "available_at"]);
    })
    .toSQL();
  if (!(await db.schema.hasTable("business_events"))) {
    if (!mysql) {
      // Knex's compiled first statement contains all non-MySQL constraints.
      for (const statement of statements)
        await db.raw(statement.sql, statement.bindings);
      return;
    }
    await db.raw(statements[0]!.sql);
  }
  if (mysql)
    for (const statement of statements.slice(1)) {
      const name = /add (?:constraint |unique |index )`([^`]+)`/.exec(
        statement.sql,
      )![1]!;
      const index = statement.sql.includes("add index");
      const exists = await db(
        index
          ? "information_schema.STATISTICS"
          : "information_schema.TABLE_CONSTRAINTS",
      )
        .where(
          index ? "TABLE_SCHEMA" : "CONSTRAINT_SCHEMA",
          db.raw("database()"),
        )
        .where({
          TABLE_NAME: "business_events",
          [index ? "INDEX_NAME" : "CONSTRAINT_NAME"]: name,
        })
        .first();
      if (!exists) await db.raw(statement.sql);
    }
}
export async function down(): Promise<void> {
  throw Error("Restore a backup to reverse business event migrations");
}
