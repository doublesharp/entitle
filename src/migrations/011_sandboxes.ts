import type { Knex } from "knex";

// A single CREATE includes all constraints, so MySQL cannot persist a table
// before its foreign keys. UUID parent columns must use the parent's collation.
export const config = { transaction: false };
export async function up(db: Knex) {
  if (await db.schema.hasTable("publisher_sandboxes")) return;
  const mysql = db.client.config.client === "mysql2";
  await db.raw(
    `CREATE TABLE ?? (
    ?? varchar(64) NOT NULL PRIMARY KEY,
    ?? varchar(64) NOT NULL UNIQUE,
    ?? varchar(16) NOT NULL,
    ?? double precision NOT NULL,
    CONSTRAINT ?? FOREIGN KEY (??) REFERENCES ?? (??),
    CONSTRAINT ?? FOREIGN KEY (??) REFERENCES ?? (??)
  )${mysql ? " DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin" : ""}`,
    [
      "publisher_sandboxes",
      "parent_tenant_id",
      "sandbox_tenant_id",
      "mode",
      "created_at",
      "sandbox_parent_foreign",
      "parent_tenant_id",
      "tenants",
      "id",
      "sandbox_workspace_foreign",
      "sandbox_tenant_id",
      "tenants",
      "id",
    ],
  );
}
export async function down() {
  throw new Error("Sandbox rollback requires restoring a matching backup.");
}
