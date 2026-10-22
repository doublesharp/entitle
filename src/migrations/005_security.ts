import type { Knex } from "knex";
import { up as ensureTenantConstraints } from "./003_tenants.ts";

export const config = { transaction: false };
export async function up(db: Knex) {
  if (db.client.config.client === "mysql2") await upgrade(db);
  else await db.transaction(upgrade);
}
async function upgrade(db: Knex) {
  const add = async (
    table: string,
    name: string,
    define: (t: Knex.AlterTableBuilder) => void,
  ) => {
    if (!(await db.schema.hasColumn(table, name)))
      await db.schema.alterTable(table, define);
  };
  await add("seller_login_tokens", "browser_hash", (t) => {
    t.string("browser_hash", 64).nullable();
  });
  await add("seller_login_tokens", "created_at", (t) => {
    t.double("created_at").notNullable().defaultTo(0);
  });
  await add("tenant_api_keys", "scopes", (t) => {
    t.specificType("scopes", "text").notNullable().defaultTo(db.raw("('[]')"));
  });
  await add("tenant_api_keys", "expires_at", (t) => {
    t.double("expires_at").nullable();
  });
  await add("tenant_api_keys", "last_used_at", (t) => {
    t.double("last_used_at").nullable();
  });
  await add("tenant_api_keys", "display_prefix", (t) => {
    t.string("display_prefix", 32).notNullable().defaultTo("");
  });
  if (db.client.config.client === "mysql2")
    await db.raw("alter table ?? modify ?? text not null default ('[]')", [
      "tenant_api_keys",
      "scopes",
    ]);
  await db("seller_login_tokens").whereNull("browser_hash").update({ used: 1 });
  // Also repair installations whose pre-hardening migration003 was already
  // recorded despite an interrupted MySQL CREATE/ALTER constraint sequence.
  await ensureTenantConstraints(db);
}
export async function down(): Promise<void> {
  throw Error("Restore a backup to reverse migrations");
}
