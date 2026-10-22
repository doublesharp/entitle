import { isolatedDatabase } from "./helpers/database.ts";
import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { migrate, reset, lock } from "../src/db.ts";
import { Billing, type BillingSnapshot } from "../src/billing.ts";
import { Licenses } from "../src/licensing.ts";
import { primaryTenant } from "./helpers/tenant.ts";
const directory = await mkdtemp(
  "/Volumes/Scratch/double-entitle-wp/tmp/saas-billing-review-",
);
const database = await isolatedDatabase(`sqlite:${directory}/db`);
const db = database.db;
const secret = "ae".repeat(32);
const licenses = new Licenses(db, secret, [], primaryTenant);
function paid(subscriptionId = "sub_paid"): BillingSnapshot {
  return {
    subscriptionId,
    customerId: `cus_${subscriptionId}`,
    email: `${subscriptionId}@example.test`,
    billingStatus: "active",
    suspended: false,
    fullyRefunded: false,
    grants: [
      {
        id: `grant_${subscriptionId}`,
        invoiceId: `invoice_${subscriptionId}`,
        priceId: "price_paid",
        periodStart: Date.now() - 1000,
        periodEnd: Date.now() + 86400000,
        paidAt: Date.now(),
        settled: true,
      },
    ],
  };
}
before(async () => {
  await migrate(db);
});
beforeEach(async () => {
  await reset(db);
  await db("products").insert({
    tenant_id: "primary",
    id: "product",
    slug: "product",
    name: "Product",
  });
  await db("plans").insert({
    tenant_id: "primary",
    id: "plan",
    product_id: "product",
    name: "Plan",
    site_allowance: 1,
    stripe_price_id: "price_paid",
  });
});
after(async () => {
  await database.close();
  await rm(directory, { recursive: true, force: true });
});

test("unrelated checkout mutex commits during every pending snapshot cannot starve paid issuance", async () => {
  let calls = 0;
  const billing = new Billing(db, licenses, {
    snapshot: async () => {
      calls++;
      const pending = Promise.withResolvers<BillingSnapshot>();
      void db
        .transaction(async (tx) => {
          await lock(tx, "billing", "primary");
          await lock(tx, "billing", "primary");
        })
        .then(() => pending.resolve(paid()), pending.reject);
      return pending.promise;
    },
  });
  await billing.reconcile("sub_paid");
  assert.equal(calls, 1);
  const license = await db("licenses")
    .where({ tenant_id: "primary", subscription_id: "sub_paid" })
    .first();
  assert.ok(license);
  assert.equal(licenses.entitled(license), true);
  assert.equal((await db("emails")).length, 1);
});

test("reconciling another subscription never invalidates the in-flight subscription revision", async () => {
  const other = new Billing(db, licenses, {
    snapshot: async () => paid("sub_other"),
  });
  let calls = 0;
  const billing = new Billing(db, licenses, {
    snapshot: async () => {
      calls++;
      await other.reconcile("sub_other");
      return paid();
    },
  });
  await billing.reconcile("sub_paid");
  assert.equal(calls, 1);
  assert.equal((await db("licenses")).length, 2);
});

test("independent subscription revisions still serialize competing customer email mappings during apply", async () => {
  const one = new Billing(db, licenses, {
    snapshot: async () => ({
      ...paid("sub_one"),
      email: "shared@example.test",
    }),
  });
  const two = new Billing(db, licenses, {
    snapshot: async () => ({
      ...paid("sub_two"),
      email: "shared@example.test",
    }),
  });
  const results = await Promise.allSettled([
    one.reconcile("sub_one"),
    two.reconcile("sub_two"),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const failure = results.find((result) => result.status === "rejected");
  assert.ok(failure && failure.status === "rejected");
  assert.equal(failure.reason.code, "billing_customer_conflict");
  assert.equal((await db("customers")).length, 1);
  assert.equal((await db("licenses")).length, 1);
});
