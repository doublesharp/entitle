import type { Knex } from "knex";

export async function up(db: Knex) {
  if (!(await db.schema.hasColumn("tenants", "stripe_status"))) {
    await db.schema.alterTable("tenants", (table) => {
      table.string("stripe_status", 20).notNullable().defaultTo("unconnected");
    });
  }
  // Restrict backfill to the new default so retrying MySQL's committed DDL
  // cannot reconnect a tenant whose connection was already deauthorized.
  await db("tenants")
    .where({ stripe_status: "unconnected" })
    .whereNot({ id: "primary" })
    .whereNotNull("stripe_account_id")
    .update({ stripe_status: "connected" });
  await db("tenants")
    .where({ id: "primary", stripe_status: "unconnected" })
    .update({ stripe_status: "platform" });
}
export async function down(): Promise<void> {
  throw Error("Restore a backup to reverse migrations");
}
