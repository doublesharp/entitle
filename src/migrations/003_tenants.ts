import type { Knex } from "knex";
import assert from "node:assert/strict";

// MySQL DDL commits implicitly. Durable phase markers make each DDL boundary
// resumable; SQLite and PostgreSQL additionally wrap the upgrade atomically.
export const config = { transaction: false };
const business = [
  "products",
  "plans",
  "customers",
  "licenses",
  "grants",
  "installations",
  "releases",
  "billing_events",
  "work",
  "emails",
  "login_tokens",
  "sessions",
];
const shadow = (name: string) => `${name}_tenant_003`;
export async function up(db: Knex) {
  if (db.client.config.client === "mysql2") await upgrade(db);
  else await db.transaction(upgrade);
}
async function upgrade(db: Knex) {
  let phase = "copy";
  const aliases = new Map<string, string>();
  const manifest: string[] = [];
  const mysql = db.client.config.client === "mysql2";
  const create = async (
    name: string,
    define: (t: Knex.CreateTableBuilder) => void,
  ) => {
    const actualName = aliases.get(name) ?? name;
    const exists = await db.schema.hasTable(actualName);
    if (aliases.has(name) && phase !== "copy")
      assert.ok(exists, `Missing tenant migration table ${actualName}`);
    if (mysql) {
      const statements = db.schema
        .createTable(name, (t) => {
          t.charset("utf8mb4");
          t.collate("utf8mb4_bin");
          define(t);
        })
        .toSQL()
        .map((statement) => replaceTables(statement.sql, aliases));
      manifest.push(...statements);
      if (!exists) await db.raw(statements[0]!);
      for (const statement of statements)
        await mysqlConstraint(db, statement, true);
    } else if (!exists) await db.schema.createTable(actualName, define);
  };
  await create("tenant_migration_003", (t) => {
    t.string("id", 20).primary();
    t.string("phase", 20).notNullable();
  });
  await db("tenant_migration_003")
    .insert({ id: "upgrade", phase: "copy" })
    .onConflict("id")
    .ignore();
  const state = await db("tenant_migration_003")
    .where({ id: "upgrade" })
    .first();
  phase = state.phase;
  if (!["copy", "drop", "rename", "complete"].includes(phase))
    throw Error("Unknown tenant migration phase; restore or inspect backup");
  for (const table of business) {
    const temporary = shadow(table);
    const actual =
      phase === "copy" ||
      phase === "drop" ||
      (await db.schema.hasTable(temporary))
        ? temporary
        : table;
    aliases.set(temporary, actual);
  }
  await create("tenants", (t) => {
    t.string("id", 64).primary();
    t.string("slug", 150).notNullable().unique();
    t.string("name", 200).notNullable();
    t.string("stripe_account_id", 150).nullable().unique();
    t.string("platform_customer_id", 150).nullable().unique();
    t.string("platform_subscription_id", 150).nullable().unique();
    t.string("billing_status", 40).notNullable().defaultTo("trial");
    t.double("paid_through").notNullable().defaultTo(0);
    t.double("trial_ends_at").notNullable().defaultTo(0);
    t.integer("exempt").notNullable().defaultTo(0);
    t.integer("suspended").notNullable().defaultTo(0);
    t.integer("max_products").notNullable().defaultTo(20);
    t.double("max_storage_bytes")
      .notNullable()
      .defaultTo(1024 ** 3);
    t.double("created_at").notNullable();
  });
  await db("tenants")
    .insert({
      id: "primary",
      slug: "primary",
      name: "Primary",
      exempt: 1,
      created_at: Date.now(),
    })
    .onConflict("id")
    .ignore();
  await db("locks")
    .insert(
      ["auth", "billing", "email", "schema", "work"].map((name) => ({
        id: `primary:${name}`,
      })),
    )
    .onConflict("id")
    .ignore();
  const own = (
    t: Knex.CreateTableBuilder,
    composite = false,
    idLength = 64,
  ) => {
    t.string("tenant_id", 64).notNullable().references("tenants.id");
    const id = t.string("id", idLength).notNullable();
    if (composite) t.primary(["tenant_id", "id"]);
    else {
      id.primary();
      t.unique(["tenant_id", "id"]);
    }
  };
  const ref = (
    t: Knex.CreateTableBuilder,
    column: string,
    table: string,
    nullable = false,
  ) => {
    const col = t.string(column, 64);
    if (nullable) col.nullable();
    else col.notNullable();
    t.foreign(["tenant_id", column])
      .references(["tenant_id", "id"])
      .inTable(shadow(table));
  };
  const queue = (t: Knex.CreateTableBuilder) => {
    t.string("kind", 40).notNullable();
    t.text("payload", "mediumtext").notNullable();
    t.string("state", 20).notNullable().defaultTo("pending");
    t.integer("attempts").notNullable().defaultTo(0);
    t.double("available_at").notNullable().defaultTo(0);
    t.double("lease_until").notNullable().defaultTo(0);
    t.string("lease_owner", 64).nullable();
    t.string("last_error", 100).nullable();
    t.double("created_at").notNullable();
    t.index(["state", "available_at"]);
  };
  await create(shadow("products"), (t) => {
    own(t);
    t.string("slug", 150).notNullable();
    t.unique(["tenant_id", "slug"]);
    t.string("name", 200).notNullable();
    t.string("plugin_basename", 255).nullable();
  });
  await create(shadow("plans"), (t) => {
    own(t);
    ref(t, "product_id", "products");
    t.string("name", 150).notNullable();
    t.integer("site_allowance").notNullable();
    t.string("stripe_price_id", 150).notNullable();
    t.unique(["tenant_id", "stripe_price_id"]);
  });
  await create(shadow("customers"), (t) => {
    own(t);
    t.string("email", 254).notNullable();
    t.string("stripe_id", 150).nullable();
    t.unique(["tenant_id", "email"]);
    t.unique(["tenant_id", "stripe_id"]);
  });
  await create(shadow("licenses"), (t) => {
    own(t);
    ref(t, "customer_id", "customers");
    ref(t, "product_id", "products");
    ref(t, "plan_id", "plans");
    t.integer("site_allowance").notNullable();
    t.double("paid_through").notNullable();
    t.string("billing_status", 40).notNullable();
    t.string("subscription_id", 150).notNullable();
    t.unique(["tenant_id", "subscription_id"]);
    t.string("key_hash", 64).notNullable();
    t.unique(["tenant_id", "key_hash"]);
    for (const c of ["revoked", "refund_revoked", "suspended", "lock_version"])
      t.integer(c).notNullable().defaultTo(0);
  });
  await create(shadow("grants"), (t) => {
    own(t, true, 150);
    ref(t, "license_id", "licenses");
    ref(t, "plan_id", "plans");
    t.string("invoice_id", 150).notNullable();
    for (const c of ["period_start", "period_end", "paid_at"])
      t.double(c).notNullable();
  });
  await create(shadow("installations"), (t) => {
    own(t);
    ref(t, "license_id", "licenses");
    t.string("installation_id", 150).notNullable();
    t.string("site_url", 500).notNullable();
    t.integer("active").notNullable();
    t.integer("exempt").notNullable();
    t.string("token_hash", 64).notNullable();
    t.text("token_cipher").notNullable();
    t.unique(["tenant_id", "token_hash"]);
    t.unique(["tenant_id", "license_id", "installation_id"], {
      indexName: "installations_tenant_site_unique",
    });
  });
  await create(shadow("releases"), (t) => {
    own(t);
    ref(t, "product_id", "products");
    t.string("version", 60).notNullable();
    t.text("changelog", "mediumtext").notNullable();
    t.double("published_at").notNullable();
    t.integer("withdrawn").notNullable().defaultTo(0);
    t.string("checksum", 64).notNullable();
    t.double("size").notNullable();
    for (const c of ["min_wp", "min_php", "min_free", "tested"])
      t.string(c, 60).notNullable();
    t.unique(["tenant_id", "product_id", "version"]);
  });
  await create(shadow("billing_events"), (t) => {
    own(t, true, 150);
    t.string("type", 150).notNullable();
    t.text("payload", "mediumtext").notNullable();
    t.double("received_at").notNullable();
    t.double("processed_at").nullable();
  });
  for (const table of ["work", "emails"])
    await create(shadow(table), (t) => {
      own(t, true, 150);
      queue(t);
      if (table === "emails") {
        ref(t, "customer_id", "customers");
        ref(t, "license_id", "licenses", true);
      }
    });
  for (const table of ["login_tokens", "sessions"])
    await create(shadow(table), (t) => {
      own(t);
      ref(t, "customer_id", "customers");
      t.double("expires_at").notNullable();
      if (table === "login_tokens")
        t.integer("used").notNullable().defaultTo(0);
    });
  if (phase === "copy") {
    for (const table of business) {
      if (table === "login_tokens" || table === "sessions") continue;
      // A failed copy phase is safely repeated, retaining the original source.
      let cursor: string | undefined;
      for (;;) {
        const query = db(table).orderBy("id").limit(100);
        if (cursor !== undefined) query.where("id", ">", cursor);
        const rows = await query;
        if (rows.length === 0) break;
        await db(shadow(table))
          .insert(rows.map((row) => ({ ...row, tenant_id: "primary" })))
          .onConflict(
            table === "billing_events" ||
              table === "grants" ||
              table === "work" ||
              table === "emails"
              ? ["tenant_id", "id"]
              : ["id"],
          )
          .ignore();
        const copied = await db(shadow(table))
          .where({ tenant_id: "primary" })
          .whereIn(
            "id",
            rows.map((row) => row.id),
          );
        for (const row of rows) {
          const copy = copied.find((item) => item.id === row.id);
          if (
            !copy ||
            Object.keys(row).some((column) => row[column] !== copy[column])
          )
            throw Error(
              `Tenant migration row verification failed for ${table}/${row.id}`,
            );
        }
        cursor = rows.at(-1).id;
      }
      const original = await db(table).count("* as count").first();
      const copied = await db(shadow(table)).count("* as count").first();
      if (Number(original!.count) !== Number(copied!.count))
        throw Error(`Tenant migration copy verification failed for ${table}`);
    }
    await db("tenant_migration_003")
      .where({ id: "upgrade" })
      .update({ phase: "drop" });
  }
  if (phase === "copy" || phase === "drop") {
    for (const table of [...business].reverse())
      await db.schema.dropTableIfExists(table);
    await db("tenant_migration_003")
      .where({ id: "upgrade" })
      .update({ phase: "rename" });
  }
  if (phase !== "complete") {
    for (const table of business)
      if (await db.schema.hasTable(shadow(table)))
        await db.schema.renameTable(shadow(table), table);
  }
  await create("seller_users", (t) => {
    t.string("id", 64).primary();
    t.string("email", 254).notNullable().unique();
    t.double("verified_at").nullable();
    t.double("created_at").notNullable();
  });
  await create("seller_memberships", (t) => {
    t.string("tenant_id", 64).notNullable().references("tenants.id");
    t.string("user_id", 64).notNullable().references("seller_users.id");
    t.string("role", 20).notNullable().defaultTo("owner");
    t.double("created_at").notNullable();
    t.primary(["tenant_id", "user_id"]);
  });
  for (const table of ["seller_login_tokens", "seller_sessions"])
    await create(table, (t) => {
      t.string("id", 64).primary();
      t.string("user_id", 64).notNullable().references("seller_users.id");
      t.double("expires_at").notNullable();
      if (table === "seller_login_tokens") {
        t.integer("used").notNullable().defaultTo(0);
        t.string("browser_hash", 64).nullable();
        t.double("created_at").notNullable().defaultTo(0);
      } else t.unique(["id", "user_id"]);
    });
  await create("tenant_api_keys", (t) => {
    t.string("id", 64).primary();
    t.string("tenant_id", 64).notNullable().references("tenants.id");
    t.string("name", 150).notNullable();
    t.string("key_hash", 64).notNullable().unique();
    t.double("created_at").notNullable();
    t.double("revoked_at").nullable();
    t.specificType("scopes", "text").notNullable().defaultTo(db.raw("('[]')"));
    t.double("expires_at").nullable();
    t.double("last_used_at").nullable();
    t.string("display_prefix", 32).notNullable().defaultTo("");
  });
  await create("oauth_states", (t) => {
    t.string("id", 64).primary();
    t.string("tenant_id", 64).notNullable().references("tenants.id");
    t.string("user_id", 64).notNullable().references("seller_users.id");
    t.string("session_id", 64).notNullable();
    t.foreign(["session_id", "user_id"])
      .references(["id", "user_id"])
      .inTable("seller_sessions")
      .onDelete("CASCADE");
    t.string("redirect_uri", 1000).notNullable();
    t.double("expires_at").notNullable();
    t.integer("used").notNullable().defaultTo(0);
  });
  await create("audit_events", (t) => {
    t.string("id", 64).primary();
    t.string("tenant_id", 64).nullable().references("tenants.id");
    t.string("actor_type", 40).notNullable();
    t.string("actor_id", 150).nullable();
    t.string("action", 100).notNullable();
    t.text("details", "mediumtext").notNullable();
    t.double("created_at").notNullable();
  });
  await create("platform_events", (t) => {
    t.string("id", 150).primary();
    t.string("type", 150).notNullable();
    t.text("payload", "mediumtext").notNullable();
    t.double("received_at").notNullable();
    t.double("processed_at").nullable();
  });
  for (const table of ["platform_work", "platform_emails"])
    await create(table, (t) => {
      t.string("id", 150).primary();
      queue(t);
    });
  await create("upload_reservations", (t) => {
    t.string("tenant_id", 64).notNullable().references("tenants.id");
    t.string("id", 64).notNullable();
    t.double("bytes").notNullable();
    t.double("expires_at").notNullable();
    t.primary(["tenant_id", "id"]);
  });
  await create("invoice_metrics", (t) => {
    t.string("tenant_id", 64).notNullable().references("tenants.id");
    t.string("invoice_id", 150).notNullable();
    t.string("currency", 10).notNullable();
    t.double("paid_minor").notNullable().defaultTo(0);
    t.double("refunded_minor").notNullable().defaultTo(0);
    t.primary(["tenant_id", "invoice_id"]);
  });
  await create("download_metrics", (t) => {
    t.string("tenant_id", 64).notNullable().references("tenants.id");
    t.string("release_id", 64).notNullable();
    t.foreign(["tenant_id", "release_id"])
      .references(["tenant_id", "id"])
      .inTable("releases");
    t.string("day", 10).notNullable();
    t.double("successful_responses").notNullable().defaultTo(0);
    t.primary(["tenant_id", "release_id", "day"]);
  });
  if (mysql) {
    const finalNames = new Map(business.map((table) => [shadow(table), table]));
    for (const statement of manifest)
      await mysqlConstraint(db, replaceTables(statement, finalNames), false);
  }
  await db("tenant_migration_003")
    .where({ id: "upgrade" })
    .update({ phase: "complete" });
}
export async function down(): Promise<void> {
  throw Error("Restore a backup to reverse migrations");
}

function replaceTables(sql: string, aliases: Map<string, string>) {
  for (const [from, to] of aliases)
    sql = sql.replaceAll(`\`${from}\``, `\`${to}\``);
  return sql;
}
function columns(sql: string) {
  return [...sql.matchAll(/`([^`]+)`/g)].map((match) => match[1]!);
}
async function mysqlConstraint(db: Knex, sql: string, repair: boolean) {
  const table = /(?:create|alter) table `([^`]+)`/.exec(sql)![1]!;
  const foreign =
    /add constraint `([^`]+)` foreign key \((.*?)\) references `([^`]+)` \((.*?)\)/i.exec(
      sql,
    );
  let expected: unknown[];
  let read: () => Promise<unknown[]>;
  if (foreign) {
    const name = foreign[1]!;
    const references = columns(foreign[4]!);
    const onDelete =
      /on delete (\w+)/i.exec(sql)?.[1]?.toUpperCase() ?? "NO ACTION";
    expected = columns(foreign[2]!).map((column, index) => ({
      column,
      table: foreign[3],
      reference: references[index],
      onDelete,
    }));
    read = () =>
      db("information_schema.KEY_COLUMN_USAGE as keys")
        .join(
          "information_schema.REFERENTIAL_CONSTRAINTS as rules",
          function () {
            this.on("rules.CONSTRAINT_SCHEMA", "keys.CONSTRAINT_SCHEMA")
              .andOn("rules.CONSTRAINT_NAME", "keys.CONSTRAINT_NAME")
              .andOn("rules.TABLE_NAME", "keys.TABLE_NAME");
          },
        )
        .select({
          column: "keys.COLUMN_NAME",
          table: "keys.REFERENCED_TABLE_NAME",
          reference: "keys.REFERENCED_COLUMN_NAME",
          onDelete: "rules.DELETE_RULE",
        })
        .where("keys.CONSTRAINT_SCHEMA", db.raw("database()"))
        .where("keys.REFERENCED_TABLE_SCHEMA", db.raw("database()"))
        .where({ "keys.TABLE_NAME": table, "keys.CONSTRAINT_NAME": name })
        .orderBy("keys.ORDINAL_POSITION");
  } else {
    const index = /add (unique|index) `([^`]+)`\((.*?)\)/i.exec(sql);
    const name = index ? index[2]! : "PRIMARY";
    const list = index ? index[3]! : /primary key \((.*?)\)/i.exec(sql)![1]!;
    const unique = index?.[1] === "index" ? 1 : 0;
    expected = columns(list).map((column) => ({ column, unique }));
    read = () =>
      db("information_schema.STATISTICS")
        .select({ column: "COLUMN_NAME", unique: "NON_UNIQUE" })
        .where("TABLE_SCHEMA", db.raw("database()"))
        .where({ TABLE_NAME: table, INDEX_NAME: name })
        .orderBy("SEQ_IN_INDEX");
  }
  let actual = await read();
  if (repair && actual.length === 0 && sql.startsWith("alter")) {
    await db.raw(sql);
    actual = await read();
  }
  assert.deepEqual(
    actual,
    expected,
    `Tenant constraint manifest mismatch: ${table}`,
  );
}
