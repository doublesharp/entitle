import assert from "node:assert/strict";
import type { Knex } from "knex";

// MySQL commits DDL implicitly. Every column and constraint can resume after an
// interrupted statement; the other engines also have a transaction boundary.
export const config = { transaction: false };
export async function up(db: Knex) {
  if (db.client.config.client === "mysql2") await upgrade(db);
  else await db.transaction(upgrade);
}
async function upgrade(db: Knex) {
  const mysql = db.client.config.client === "mysql2";
  if (!(await db.schema.hasColumn("products", "framework")))
    await db.schema.alterTable("products", (t) => {
      t.string("framework", 30).notNullable().defaultTo("wordpress");
    });
  if (!(await db.schema.hasColumn("products", "framework_config")))
    await db.schema.alterTable("products", (t) => {
      t.specificType("framework_config", "text")
        .notNullable()
        .defaultTo(db.raw("('{}')"));
    });
  if (!(await db.schema.hasColumn("installations", "label")))
    await db.schema.alterTable("installations", (t) => {
      t.string("label", 200).nullable();
    });
  if (mysql)
    await db.raw("alter table ?? modify ?? text not null default ('{}')", [
      "products",
      "framework_config",
    ]);
  const define = (t: Knex.CreateTableBuilder) => {
    if (mysql) {
      t.charset("utf8mb4");
      t.collate("utf8mb4_bin");
    }
    t.string("id", 64).primary();
    t.string("tenant_id", 64).notNullable();
    t.string("release_id", 64).notNullable();
    t.string("target", 100).notNullable();
    t.string("filename", 200).notNullable();
    t.double("size").notNullable();
    t.string("checksum", 64).notNullable();
    t.string("sha512", 88).notNullable();
    t.text("signature").nullable();
    t.string("min_system_version", 100).nullable();
    t.unique(["tenant_id", "id"], {
      indexName: "release_assets_tenant_id_unique",
    });
    t.unique(["tenant_id", "release_id", "target"], {
      indexName: "release_assets_target_unique",
    });
    t.foreign("tenant_id", "release_assets_tenant_foreign").references(
      "tenants.id",
    );
    t.foreign(["tenant_id", "release_id"], "release_assets_release_foreign")
      .references(["tenant_id", "id"])
      .inTable("releases");
  };
  if (!mysql) {
    if (!(await db.schema.hasTable("release_assets")))
      await db.schema.createTable("release_assets", define);
    return;
  }
  const statements = db.schema.createTable("release_assets", define).toSQL();
  if (!(await db.schema.hasTable("release_assets")))
    await db.raw(statements[0]!.sql);
  for (const statement of statements.slice(1)) {
    const name = /(?:add unique|add constraint) `([^`]+)`/.exec(
      statement.sql,
    )![1]!;
    const constraints = await db("information_schema.TABLE_CONSTRAINTS")
      .where("CONSTRAINT_SCHEMA", db.raw("database()"))
      .where({ TABLE_NAME: "release_assets", CONSTRAINT_NAME: name });
    if (!constraints.length) await db.raw(statement.sql);
  }
  const schema = (await db.raw("select database() as name"))[0][0]
    .name as string;
  const manifest: Record<
    string,
    {
      type: string;
      columns: string[];
      target: string | null;
      references: string[];
    }
  > = {
    PRIMARY: {
      type: "PRIMARY KEY",
      columns: ["id"],
      target: null,
      references: [],
    },
    release_assets_tenant_id_unique: {
      type: "UNIQUE",
      columns: ["tenant_id", "id"],
      target: null,
      references: [],
    },
    release_assets_target_unique: {
      type: "UNIQUE",
      columns: ["tenant_id", "release_id", "target"],
      target: null,
      references: [],
    },
    release_assets_tenant_foreign: {
      type: "FOREIGN KEY",
      columns: ["tenant_id"],
      target: "tenants",
      references: ["id"],
    },
    release_assets_release_foreign: {
      type: "FOREIGN KEY",
      columns: ["tenant_id", "release_id"],
      target: "releases",
      references: ["tenant_id", "id"],
    },
  };
  for (const [name, expected] of Object.entries(manifest)) {
    const actualType = await db("information_schema.TABLE_CONSTRAINTS")
      .where("CONSTRAINT_SCHEMA", db.raw("database()"))
      .where({ TABLE_NAME: "release_assets", CONSTRAINT_NAME: name })
      .pluck("CONSTRAINT_TYPE");
    assert.deepEqual(
      actualType,
      [expected.type],
      "Release asset constraint manifest mismatch",
    );
    const actual = await db("information_schema.KEY_COLUMN_USAGE")
      .select({
        column: "COLUMN_NAME",
        target: "REFERENCED_TABLE_NAME",
        reference: "REFERENCED_COLUMN_NAME",
        schema: "REFERENCED_TABLE_SCHEMA",
      })
      .where("CONSTRAINT_SCHEMA", db.raw("database()"))
      .where({ TABLE_NAME: "release_assets", CONSTRAINT_NAME: name })
      .orderBy("ORDINAL_POSITION");
    assert.deepEqual(
      actual,
      expected.columns.map((column, index) => ({
        column,
        target: expected.target,
        reference: expected.references[index] ?? null,
        schema: expected.target === null ? null : schema,
      })),
      "Release asset constraint manifest mismatch",
    );
    if (expected.target !== null) {
      const rules = await db("information_schema.REFERENTIAL_CONSTRAINTS")
        .where("CONSTRAINT_SCHEMA", db.raw("database()"))
        .where({ TABLE_NAME: "release_assets", CONSTRAINT_NAME: name })
        .first();
      assert.ok(
        ["RESTRICT", "NO ACTION"].includes(rules.DELETE_RULE) &&
          ["RESTRICT", "NO ACTION"].includes(rules.UPDATE_RULE),
        "Release asset constraint manifest mismatch",
      );
    }
  }
}
export async function down(): Promise<void> {
  throw Error("Restore a backup to reverse migrations");
}
