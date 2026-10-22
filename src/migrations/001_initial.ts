import type { Knex } from "knex";
export async function up(db: Knex) {
  const create = (
    name: string,
    define: (table: Knex.CreateTableBuilder) => void,
  ) =>
    db.schema.createTable(name, (table) => {
      if (db.client.config.client === "mysql2") {
        table.charset("utf8mb4");
        table.collate("utf8mb4_bin");
      }
      define(table);
    });
  await create("locks", (t) => {
    t.string("id", 100).primary();
    t.integer("version").notNullable().defaultTo(0);
  });
  await db("locks").insert([
    { id: "billing" },
    { id: "work" },
    { id: "email" },
    { id: "auth" },
    { id: "schema" },
  ]);
  await create("products", (t) => {
    t.string("id", 64).primary();
    t.string("slug", 150).notNullable().unique();
    t.string("name", 200).notNullable();
  });
  await create("plans", (t) => {
    t.string("id", 64).primary();
    t.string("product_id", 64).notNullable().references("products.id");
    t.string("name", 150).notNullable();
    t.integer("site_allowance").notNullable();
    t.string("stripe_price_id", 150).notNullable().unique();
  });
  await create("customers", (t) => {
    t.string("id", 64).primary();
    t.string("email", 254).notNullable().unique();
    t.string("stripe_id", 150).nullable().unique();
  });
  await create("licenses", (t) => {
    t.string("id", 64).primary();
    t.string("customer_id", 64).notNullable().references("customers.id");
    t.string("product_id", 64).notNullable().references("products.id");
    t.string("plan_id", 64).notNullable().references("plans.id");
    t.integer("site_allowance").notNullable();
    t.double("paid_through").notNullable();
    t.string("billing_status", 40).notNullable();
    t.string("subscription_id", 150).notNullable().unique();
    t.string("key_hash", 64).notNullable().unique();
    for (const c of ["revoked", "refund_revoked", "suspended", "lock_version"])
      t.integer(c).notNullable().defaultTo(0);
  });
  await create("grants", (t) => {
    t.string("id", 150).primary();
    t.string("license_id", 64).notNullable().references("licenses.id");
    t.string("invoice_id", 150).notNullable();
    t.string("plan_id", 64).notNullable().references("plans.id");
    for (const c of ["period_start", "period_end", "paid_at"])
      t.double(c).notNullable();
  });
  await create("installations", (t) => {
    t.string("id", 64).primary();
    t.string("license_id", 64).notNullable().references("licenses.id");
    t.string("installation_id", 150).notNullable();
    t.string("site_url", 500).notNullable();
    t.integer("active").notNullable();
    t.integer("exempt").notNullable();
    t.string("token_hash", 64).notNullable().unique();
    t.text("token_cipher").notNullable();
    t.unique(["license_id", "installation_id"]);
  });
  await create("releases", (t) => {
    t.string("id", 64).primary();
    t.string("product_id", 64).notNullable().references("products.id");
    t.string("version", 60).notNullable();
    t.text("changelog", "mediumtext").notNullable();
    t.double("published_at").notNullable();
    t.integer("withdrawn").notNullable().defaultTo(0);
    t.string("checksum", 64).notNullable();
    t.double("size").notNullable();
    for (const c of ["min_wp", "min_php", "min_free", "tested"])
      t.string(c, 60).notNullable();
    t.unique(["product_id", "version"]);
  });
  await create("billing_events", (t) => {
    t.string("id", 150).primary();
    t.string("type", 150).notNullable();
    t.text("payload", "mediumtext").notNullable();
    t.double("received_at").notNullable();
    t.double("processed_at").nullable();
  });
  for (const table of ["work", "emails"])
    await create(table, (t) => {
      t.string("id", 150).primary();
      t.string("kind", 40).notNullable();
      t.text("payload", "mediumtext").notNullable();
      t.string("state", 20).notNullable().defaultTo("pending");
      t.integer("attempts").notNullable().defaultTo(0);
      t.double("available_at").notNullable().defaultTo(0);
      t.double("lease_until").notNullable().defaultTo(0);
      t.string("lease_owner", 64).nullable();
      t.string("last_error", 100).nullable();
      t.double("created_at").notNullable();
      if (table === "emails") {
        t.string("customer_id", 64).notNullable().references("customers.id");
        t.string("license_id", 64).nullable().references("licenses.id");
      }
      t.index(["state", "available_at"]);
    });
  await create("login_tokens", (t) => {
    t.string("id", 64).primary();
    t.string("customer_id", 64).notNullable().references("customers.id");
    t.double("expires_at").notNullable();
    t.integer("used").notNullable().defaultTo(0);
  });
  await create("sessions", (t) => {
    t.string("id", 64).primary();
    t.string("customer_id", 64).notNullable().references("customers.id");
    t.double("expires_at").notNullable();
  });
}
export async function down(): Promise<void> {
  throw Error("Restore a backup to reverse migrations");
}
