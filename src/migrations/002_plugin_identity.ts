import type { Knex } from "knex";
export async function up(db: Knex) {
  await db.schema.alterTable("products", (table) => {
    table.string("plugin_basename", 255).nullable();
  });
}
export async function down(): Promise<void> {
  throw Error("Restore a backup to reverse migrations");
}
