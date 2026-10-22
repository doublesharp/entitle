import type { Knex } from "knex";

// MySQL DDL commits independently. Replay each table/constraint boundary safely.
export const config = { transaction: false };
export async function up(db: Knex) {
  if (db.client.config.client === "mysql2") await upgrade(db);
  else await db.transaction(upgrade);
}
async function upgrade(db: Knex) {
  const mysql = db.client.config.client === "mysql2";
  for (const column of ["served_bytes", "storage_read_bytes", "storage_reads"])
    if (!(await db.schema.hasColumn("download_metrics", column)))
      await db.schema.alterTable("download_metrics", t => { t.double(column).notNullable().defaultTo(0); });
  const create = async (name: string, define: (t: Knex.CreateTableBuilder) => void) => {
    const statements = db.schema.createTable(name, t => {
      if (mysql) { t.charset("utf8mb4"); t.collate("utf8mb4_bin"); }
      define(t);
    }).toSQL();
    if (!(await db.schema.hasTable(name))) {
      if (!mysql) { await db.schema.createTable(name, define); return; }
      await db.raw(statements[0]!.sql);
    }
    if (mysql) for (const statement of statements.slice(1)) {
      const constraint = /add (?:constraint |unique |index )`([^`]+)`/.exec(statement.sql)![1]!;
      const index = statement.sql.includes("add index");
      const exists = await db(index ? "information_schema.STATISTICS" : "information_schema.TABLE_CONSTRAINTS")
        .where(index ? "TABLE_SCHEMA" : "CONSTRAINT_SCHEMA", db.raw("database()"))
        .where({ TABLE_NAME: name, [index ? "INDEX_NAME" : "CONSTRAINT_NAME"]: constraint }).first();
      if (!exists) await db.raw(statement.sql);
    }
  };
  const own = (t: Knex.CreateTableBuilder) => {
    t.string("tenant_id", 64).notNullable().references("tenants.id");
    t.string("id", 64).notNullable(); t.primary(["tenant_id", "id"]);
  };
  await create("operation_settings", t => {
    t.string("tenant_id", 64).primary().references("tenants.id");
    t.text("settings").notNullable();
  });
  await create("operation_alerts", t => {
    own(t); t.integer("active").notNullable(); t.double("last_sent_at").notNullable();
  });
  await create("operation_notifications", t => {
    own(t); t.string("customer_id", 64).notNullable();
    t.foreign(["tenant_id", "customer_id"]).references(["tenant_id", "id"]).inTable("customers");
    t.string("license_id", 64).notNullable();
    t.foreign(["tenant_id", "license_id"]).references(["tenant_id", "id"]).inTable("licenses");
    t.string("kind", 40).notNullable(); t.double("paid_through").notNullable();
    t.double("created_at").notNullable(); t.integer("dismissed").notNullable().defaultTo(0);
  });
  await create("outbound_endpoints", t => {
    own(t); t.string("url", 1000).notNullable(); t.text("events").notNullable();
    t.text("secret_cipher").notNullable(); t.integer("generation").notNullable().defaultTo(1);
    t.integer("active").notNullable().defaultTo(1); t.double("created_at").notNullable();
  });
  await create("outbound_events", t => {
    own(t); t.text("payload").notNullable(); t.double("created_at").notNullable();
  });
  await create("outbound_deliveries", t => {
    own(t); t.string("event_id", 64).notNullable(); t.string("endpoint_id", 64).notNullable();
    for (const [column, table] of [["event_id", "outbound_events"], ["endpoint_id", "outbound_endpoints"]])
      t.foreign(["tenant_id", column!]).references(["tenant_id", "id"]).inTable(table!);
    t.unique(["tenant_id", "event_id", "endpoint_id"]);
    t.integer("generation").notNullable(); t.string("state", 20).notNullable().defaultTo("pending");
    t.integer("attempts").notNullable().defaultTo(0); t.double("available_at").notNullable();
    t.double("deadline_at").notNullable(); t.double("created_at").notNullable();
    t.double("lease_until").notNullable().defaultTo(0); t.string("lease_owner", 64).nullable();
    t.string("last_error", 40).nullable();
    t.index(["tenant_id", "state", "available_at"]);
  });
}
export async function down(): Promise<void> { throw Error("Restore a backup to reverse migrations"); }
