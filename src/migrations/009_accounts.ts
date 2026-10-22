import type { Knex } from "knex";
import assert from "node:assert/strict";

// MySQL DDL commits independently. Each foreign key is repaired and read
// back after table creation; other engines create the schema atomically.
export const config = { transaction: false };
interface ForeignKey {
  table: string;
  name: string;
  columns: string[];
  target: string;
  references: string[];
  cascade: boolean;
}
const keys: ForeignKey[] = [
  {
    table: "account_challenges",
    name: "account_challenges_user_foreign",
    columns: ["user_id"],
    target: "seller_users",
    references: ["id"],
    cascade: true,
  },
  {
    table: "account_challenges",
    name: "account_challenges_session_foreign",
    columns: ["session_hash", "user_id"],
    target: "seller_sessions",
    references: ["id", "user_id"],
    cascade: true,
  },
  {
    table: "account_recovery_codes",
    name: "account_recovery_codes_user_foreign",
    columns: ["user_id"],
    target: "seller_users",
    references: ["id"],
    cascade: true,
  },
  {
    table: "account_closures",
    name: "account_closures_customer_foreign",
    columns: ["tenant_id", "customer_id"],
    target: "customers",
    references: ["tenant_id", "id"],
    cascade: false,
  },
  {
    table: "account_privacy_receipts",
    name: "account_privacy_receipts_customer_foreign",
    columns: ["tenant_id", "customer_id"],
    target: "customers",
    references: ["tenant_id", "id"],
    cascade: false,
  },
];
function defineKey(
  t: Knex.CreateTableBuilder | Knex.AlterTableBuilder,
  key: ForeignKey,
) {
  const constraint = t
    .foreign(key.columns, key.name)
    .references(key.references)
    .inTable(key.target);
  if (key.cascade) constraint.onDelete("CASCADE");
}
export async function up(db: Knex) {
  if (db.client.config.client === "mysql2") await upgrade(db);
  else await db.transaction(upgrade);
}
async function upgrade(db: Knex) {
  const create = async (
    name: string,
    define: (t: Knex.CreateTableBuilder) => void,
  ) => {
    if (await db.schema.hasTable(name)) return;
    await db.schema.createTable(name, (t) => {
      if (db.client.config.client === "mysql2") {
        t.charset("utf8mb4");
        t.collate("utf8mb4_bin");
      }
      define(t);
      if (db.client.config.client !== "mysql2")
        for (const key of keys.filter((key) => key.table === name))
          defineKey(t, key);
    });
  };
  await create("account_challenges", (t) => {
    t.string("id", 64).primary();
    t.string("user_id", 64).notNullable();
    t.string("session_hash", 64).notNullable();
    t.string("purpose", 40).notNullable();
    t.string("token_hash", 64).notNullable();
    t.string("second_hash", 64).nullable();
    t.string("email", 254).nullable();
    t.string("old_email_hash", 64).nullable();
    t.double("expires_at").notNullable();
    t.double("created_at").notNullable();
  });
  await create("account_recovery_codes", (t) => {
    t.string("id", 64).primary();
    t.string("user_id", 64).notNullable();
    t.double("created_at").notNullable();
  });
  await create("account_attempts", (t) => {
    t.string("id", 64).primary();
    t.integer("attempts").notNullable();
    t.double("expires_at").notNullable();
  });
  await create("account_privacy_receipts", (t) => {
    t.string("id", 64).primary();
    t.string("tenant_id", 64).notNullable();
    t.string("customer_id", 64).notNullable();
    t.string("request_id", 64).notNullable();
    t.text("details", "mediumtext").notNullable();
    t.double("created_at").notNullable();
  });
  await create("account_closures", (t) => {
    t.string("tenant_id", 64).notNullable();
    t.string("customer_id", 64).notNullable();
    t.primary(["tenant_id", "customer_id"]);
    t.string("id", 64).notNullable();
    t.string("status", 40).notNullable();
    t.text("blockers").notNullable();
    t.double("requested_at").notNullable();
    t.double("completed_at").nullable();
  });
  if (db.client.config.client === "mysql2") {
    for (const key of keys) {
      const read = () =>
        db("information_schema.KEY_COLUMN_USAGE")
          .select({
            column: "COLUMN_NAME",
            target: "REFERENCED_TABLE_NAME",
            reference: "REFERENCED_COLUMN_NAME",
          })
          .where("CONSTRAINT_SCHEMA", db.raw("database()"))
          .where({ TABLE_NAME: key.table, CONSTRAINT_NAME: key.name })
          .orderBy("ORDINAL_POSITION");
      let actual = await read();
      if (!actual.length) {
        await db.schema.alterTable(key.table, (t) => defineKey(t, key));
        actual = await read();
      }
      assert.deepEqual(
        actual,
        key.columns.map((column, index) => ({
          column,
          target: key.target,
          reference: key.references[index],
        })),
        "Account foreign key manifest mismatch",
      );
    }
  }
}
export async function down(): Promise<void> {
  throw Error("Restore a backup to reverse migrations");
}
