import assert from "node:assert/strict";
import type { Knex } from "knex";

// MySQL commits each DDL statement. Every step inspects committed schema state
// before applying, so an interrupted upgrade can resume without changing data.
export const config = { transaction: false };
export async function up(db: Knex) {
  const client = db.client.config.client;
  if (client === "mysql2") await upgrade(db);
  else
    await db.transaction(upgrade, {
      // SQLite rebuilds licenses to remove NOT NULL. Its dependent foreign keys
      // must be disabled before BEGIN; Knex checks all foreign keys before COMMIT
      // and restores enforcement afterwards, including on rollback.
      ...(client === "better-sqlite3" ? { enforceForeignCheck: false } : {}),
    });
}
async function upgrade(db: Knex) {
  const columns = await db("licenses").columnInfo();
  if (!columns.plan_id!.nullable || !columns.subscription_id!.nullable)
    await db.schema.alterTable("licenses", (t) => {
      t.string("plan_id", 64).nullable().alter();
      t.string("subscription_id", 150).nullable().alter();
    });
  const additions: [string, (t: Knex.AlterTableBuilder) => void][] = [
    [
      "provenance",
      (t) => {
        t.string("provenance", 20).notNullable().defaultTo("paid");
      },
    ],
    [
      "expires_at",
      (t) => {
        t.double("expires_at").nullable();
      },
    ],
    [
      "complimentary_request_id",
      (t) => {
        t.string("complimentary_request_id", 64).nullable();
      },
    ],
    [
      "complimentary_request_hash",
      (t) => {
        t.string("complimentary_request_hash", 64).nullable();
      },
    ],
    [
      "issued_by",
      (t) => {
        t.string("issued_by", 64).nullable();
      },
    ],
    [
      "issued_at",
      (t) => {
        t.double("issued_at").nullable();
      },
    ],
    [
      "internal_note",
      (t) => {
        t.text("internal_note").nullable();
      },
    ],
  ];
  for (const [name, define] of additions)
    if (!(await db.schema.hasColumn("licenses", name)))
      await db.schema.alterTable("licenses", define);
  const name = "licenses_complimentary_request_unique";
  const readIndex = async () => {
    if (db.client.config.client === "mysql2") {
      const rows = await db("information_schema.STATISTICS")
        .select({ column: "COLUMN_NAME", nonUnique: "NON_UNIQUE" })
        .where("TABLE_SCHEMA", db.raw("database()"))
        .where({ TABLE_NAME: "licenses", INDEX_NAME: name })
        .orderBy("SEQ_IN_INDEX");
      return rows.length ? rows.map((r) => `${r.nonUnique}:${r.column}`) : [];
    }
    if (db.client.config.client === "pg") {
      const row = await db("pg_indexes")
        .where({
          schemaname: db.raw("current_schema()"),
          tablename: "licenses",
          indexname: name,
        })
        .first("indexdef");
      if (!row) return [];
      assert.match(
        row.indexdef,
        /CREATE UNIQUE INDEX .* ON .* USING btree \(tenant_id, complimentary_request_id\)$/,
      );
      return ["0:tenant_id", "0:complimentary_request_id"];
    }
    const indexes = await db.raw("PRAGMA index_list(licenses)");
    const index = indexes.find((r: { name: string }) => r.name === name);
    if (!index) return [];
    const fields = await db.raw("PRAGMA index_info(??)", [name]);
    return fields.map(
      (r: { name: string }) => `${index.unique ? 0 : 1}:${r.name}`,
    );
  };
  if (!(await readIndex()).length)
    await db.schema.alterTable("licenses", (t) => {
      t.unique(["tenant_id", "complimentary_request_id"], { indexName: name });
    });
  assert.deepEqual(
    await readIndex(),
    ["0:tenant_id", "0:complimentary_request_id"],
    "Complimentary issuance request constraint mismatch",
  );
}
export async function down(): Promise<void> {
  throw Error("Restore a backup to reverse migrations");
}
