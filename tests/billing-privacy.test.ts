import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { migrate, createTenant } from "../src/db.ts";
import {
  Billing,
  type BillingEvent,
  type BillingSnapshot,
} from "../src/billing.ts";
import { Licenses } from "../src/licensing.ts";
import { Auth } from "../src/auth.ts";
import { CustomerAccounts } from "../src/account-management.ts";
import { loadConfig } from "../src/config.ts";
import { seal, unseal } from "../src/crypto.ts";
import { isolatedDatabase } from "./helpers/database.ts";

const secret = "41".repeat(32);
const approval = {
  quiesced: true,
  stripeReconciled: true,
  retentionReviewed: true,
} as const;
async function fixture(t: test.TestContext) {
  const temporary =
    process.env.TMPDIR ?? "/Volumes/Scratch/entitle/tmp";
  await mkdir(temporary, { recursive: true });
  const path = await mkdtemp(join(temporary, "billing-privacy-"));
  const database = await isolatedDatabase(`sqlite:${path}/db`),
    db = database.db;
  t.after(async () => {
    await database.close();
    await rm(path, { recursive: true, force: true });
  });
  await migrate(db);
  const tenant = (await db("tenants").where({ id: "primary" }).first())!;
  const config = loadConfig({
    APP_SECRET: secret,
    OPERATOR_TOKEN: "x".repeat(32),
  });
  const accounts = new CustomerAccounts(db, new Auth(db, config, tenant));
  await db("customers").insert({
    tenant_id: "primary",
    id: "closed",
    email: "closed@example.test",
    stripe_id: "cus_closed",
  });
  await db("account_closures").insert({
    tenant_id: "primary",
    customer_id: "closed",
    id: "closure",
    status: "awaiting_operator",
    blockers: "[]",
    requested_at: 1,
    completed_at: null,
  });
  await accounts.reconcileClosure("closed", "closure", "operator", {
    ...approval,
    reference: "reviewed",
    stripeCustomerId: "cus_closed",
    eventIds: [],
    workIds: [],
    auditIds: [],
    outgoingEventIds: [],
  });
  await accounts.approveClosure("closed", "closure", "operator", approval);
  const snapshot: BillingSnapshot = {
    subscriptionId: "sub_closed",
    customerId: "cus_closed",
    email: "closed@example.test",
    billingStatus: "canceled",
    fullyRefunded: true,
    suspended: false,
    grants: [],
  };
  let snapshots = 0;
  const source = {
    snapshot: async () => {
      snapshots++;
      return snapshot;
    },
  };
  const licenses = new Licenses(db, secret, [], tenant);
  const billing = new Billing(db, licenses, source);
  return {
    db,
    accounts,
    config,
    tenant,
    billing,
    licenses,
    source,
    snapshot,
    snapshots: () => snapshots,
  };
}
function event(
  id = "evt_late",
  customer: unknown = "cus_closed",
): BillingEvent & { livemode: boolean } {
  return {
    id,
    type: "charge.refunded",
    livemode: false,
    data: {
      object: {
        id: "ch_late",
        customer,
        billing_details: {
          email: "closed@example.test",
          name: "Private Buyer",
        },
        amount: 1000,
        amount_refunded: 1000,
        currency: "usd",
      },
    },
  };
}

test("late signed-provider event stores only a minimal financial receipt and is idempotent", async (t) => {
  const f = await fixture(t);
  const e = event();
  await f.billing.receive(e);
  const row = await f.db("billing_events").where({ id: e.id }).first();
  assert.equal(row.payload, "{}");
  assert.ok(row.processed_at !== null);
  assert.equal((await f.db("work")).length, 0);
  const receipts = await f.db("account_privacy_receipts");
  const late = receipts
    .map((r) => JSON.parse(r.details))
    .find((r) => r.events.some((e: { id: string }) => e.id === "evt_late"));
  assert.equal(late.events[0].financial.amount_refunded, 1000);
  assert.equal(late.events[0].financial.currency, "usd");
  assert.ok(!JSON.stringify(receipts).includes("closed@example.test"));
  assert.ok(!JSON.stringify(receipts).includes("Private Buyer"));
  assert.ok(!JSON.stringify(receipts).includes("cus_closed"));
  await f.billing.receive(e);
  assert.equal(
    (await f.db("account_privacy_receipts")).length,
    receipts.length,
  );
  assert.equal((await f.db("customers")).length, 1);
  assert.equal((await f.db("customers").first()).stripe_id, null);
});

test("scheduled reconciliation of a completed closure cannot resurrect a customer or grants", async (t) => {
  const f = await fixture(t);
  await f.db("products").insert({
    tenant_id: "primary",
    id: "product",
    slug: "product",
    name: "Product",
  });
  await f.db("plans").insert({
    tenant_id: "primary",
    id: "plan",
    product_id: "product",
    name: "Plan",
    stripe_price_id: "price",
    site_allowance: 1,
  });
  f.snapshot.grants.push({
    id: "grant",
    invoiceId: "invoice",
    priceId: "price",
    periodStart: 1,
    periodEnd: 1000,
    paidAt: 1,
    settled: true,
  });
  await f.billing.reconcile("sub_closed");
  assert.equal((await f.db("customers")).length, 1);
  assert.equal((await f.db("customers").first()).stripe_id, null);
  assert.equal((await f.db("licenses")).length, 0);
  assert.equal((await f.db("grants")).length, 0);
});

test("open and unknown customers retain normal events even when metadata mentions the closed identity", async (t) => {
  const f = await fixture(t);
  await f.db("customers").insert({
    tenant_id: "primary",
    id: "open",
    email: "open@example.test",
    stripe_id: "cus_open",
  });
  for (const customer of [
    "cus_open",
    "cus_unknown",
    { id: "cus_open", email: "open@example.test" },
  ]) {
    const e = event(
      `evt_${typeof customer === "string" ? customer : "expanded"}`,
      customer,
    );
    await f.billing.receive(e);
    const row = await f.db("billing_events").where({ id: e.id }).first();
    assert.equal(unseal<BillingEvent>(row.payload, secret).id, e.id);
    assert.equal(row.processed_at, null);
  }
  assert.equal((await f.db("work")).length, 3);
  assert.equal((await f.db("account_privacy_receipts")).length, 1);
});

test("another tenant's completed receipt cannot redact this tenant's event", async (t) => {
  const f = await fixture(t);
  const tenant = await createTenant(f.db, {
    id: "other",
    slug: "other",
    name: "Other",
  });
  const billing = new Billing(
    f.db,
    new Licenses(f.db, secret, [], tenant),
    f.source,
  );
  await billing.receive(event());
  assert.notEqual(
    (await f.db("billing_events").where({ tenant_id: "other" }).first())
      .payload,
    "{}",
  );
});

test("customer resource events and expanded customer references are minimized after closure", async (t) => {
  const f = await fixture(t);
  await f.billing.receive(
    event("evt_expanded", { id: "cus_closed", email: "closed@example.test" }),
  );
  await f.billing.receive({
    ...event("evt_customer"),
    type: "customer.updated",
    data: { object: { id: "cus_closed", email: "closed@example.test" } },
  });
  assert.ok((await f.db("billing_events")).every((r) => r.payload === "{}"));
});

test("an event with no customer requires canonical attribution and provider failures leave nothing durable", async (t) => {
  const f = await fixture(t);
  const e = event("evt_dispute", undefined);
  delete e.data.object.customer;
  await assert.rejects(f.billing.receive(e), {
    code: "billing_privacy_attribution_required",
  });
  assert.equal((await f.db("billing_events")).length, 0);
  let reads = 0;
  const billing = new Billing(f.db, f.licenses, f.source, {
    stripeLiveMode: false,
    resolveCustomer: async () => {
      reads++;
      if (reads === 1) throw Error("provider temporary failure");
      // A DB read is possible while provider I/O is in progress.
      assert.equal((await f.db("customers")).length, 1);
      return "cus_closed";
    },
  });
  await assert.rejects(billing.receive(e), /provider temporary failure/);
  assert.equal((await f.db("billing_events")).length, 0);
  await billing.receive(e);
  assert.equal((await f.db("billing_events").first()).payload, "{}");
  await billing.receive(e);
  assert.equal(reads, 2);
});

test("canonical no-customer attribution preserves unknown events for the normal retry queue", async (t) => {
  const f = await fixture(t);
  const billing = new Billing(f.db, f.licenses, f.source, {
    stripeLiveMode: false,
    resolveCustomer: async () => null,
  });
  const e = event("evt_unattributed");
  delete e.data.object.customer;
  await billing.receive(e);
  assert.equal((await f.db("work").first()).state, "pending");
  let calls = 0;
  await billing.run(async () => {
    calls++;
    throw Error("temporary resolve failure");
  });
  assert.equal((await f.db("work").first()).state, "pending");
  assert.equal((await f.db("billing_events").first()).processed_at, null);
  await f.db("work").update({ available_at: 0 });
  await billing.run(async () => {
    calls++;
    return null;
  });
  assert.equal(calls, 2);
  assert.equal((await f.db("work").first()).state, "sent");
});

test("mode mismatch cannot use a closure in the other mode and is retry-safe", async (t) => {
  const f = await fixture(t);
  const live = new Billing(f.db, f.licenses, f.source, {
    stripeLiveMode: true,
  });
  await assert.rejects(live.receive(event()), {
    code: "billing_mode_mismatch",
  });
  assert.equal((await f.db("billing_events")).length, 0);
  await live.receive({ ...event(), livemode: true });
  assert.notEqual((await f.db("billing_events").first()).payload, "{}");
});

test("only completed receipts minimize events and ambiguous legacy mode remains retryable", async (t) => {
  const f = await fixture(t);
  await f
    .db("account_closures")
    .update({ status: "blocked", completed_at: null });
  await f.billing.receive(event("evt_open_closure"));
  assert.notEqual((await f.db("billing_events").first()).payload, "{}");
  await f
    .db("account_closures")
    .update({ status: "completed", completed_at: 1 });
  const receipt = await f.db("account_privacy_receipts").first();
  const details = JSON.parse(receipt.details);
  delete details.stripeLiveMode;
  await f
    .db("account_privacy_receipts")
    .where({ id: receipt.id })
    .update({ details: JSON.stringify(details) });
  await assert.rejects(f.billing.receive(event("evt_legacy")), {
    code: "billing_privacy_mode_required",
  });
  assert.equal(
    await f.db("billing_events").where({ id: "evt_legacy" }).first(),
    undefined,
  );
});

test("invalid financial values cannot partially commit a late receipt and a corrected retry succeeds", async (t) => {
  const f = await fixture(t);
  const e = event();
  e.data.object.amount = "wrong";
  await assert.rejects(f.billing.receive(e));
  assert.equal((await f.db("account_privacy_receipts")).length, 1);
  assert.equal((await f.db("billing_events")).length, 0);
  e.data.object.amount = 1000;
  await f.billing.receive(e);
  assert.equal((await f.db("account_privacy_receipts")).length, 2);
});

test("closure completion racing receipt insertion cannot persist an unattributed payload", async (t) => {
  const f = await fixture(t);
  await f
    .db("account_closures")
    .update({ status: "blocked", completed_at: null });
  const raced = new Proxy(f.db, {
    get(target, property) {
      if (property === "transaction")
        return async (
          action: (tx: import("../src/db.ts").Tx) => Promise<unknown>,
        ) => {
          await target("account_closures").update({
            status: "completed",
            completed_at: 1,
          });
          return target.transaction(action);
        };
      return Reflect.get(target, property);
    },
  });
  const billing = new Billing(raced, f.licenses, f.source);
  const e = event();
  delete e.data.object.customer;
  await assert.rejects(billing.receive(e), {
    code: "billing_privacy_attribution_required",
  });
  assert.equal((await f.db("billing_events")).length, 0);
});

test("open-customer reconciliation retains financial totals and rejects malformed metrics atomically", async (t) => {
  const f = await fixture(t);
  await f.db("products").insert({
    tenant_id: "primary",
    id: "product",
    slug: "product",
    name: "Product",
  });
  await f.db("plans").insert({
    tenant_id: "primary",
    id: "plan",
    product_id: "product",
    name: "Plan",
    stripe_price_id: "price",
    site_allowance: 1,
  });
  f.snapshot.customerId = "cus_open";
  f.snapshot.email = "open@example.test";
  f.snapshot.grants = [
    {
      id: "grant",
      invoiceId: "invoice",
      priceId: "price",
      periodStart: 1,
      periodEnd: 1000,
      paidAt: 1,
      settled: true,
    },
  ];
  const valid = {
    invoiceId: "invoice",
    currency: "usd",
    paidMinor: 1000,
    refundedMinor: 0,
  };
  for (const bad of [
    { currency: "invalid" },
    { paidMinor: 1.5 },
    { paidMinor: -1 },
    { refundedMinor: 0.5 },
    { refundedMinor: -1 },
  ]) {
    f.snapshot.invoices = [{ ...valid, ...bad }];
    await assert.rejects(f.billing.reconcile("sub_closed"), {
      code: "billing_metrics",
    });
    assert.equal((await f.db("invoice_metrics")).length, 0);
    assert.equal((await f.db("customers")).length, 1);
  }
  f.snapshot.invoices = [valid];
  await f.billing.reconcile("sub_closed");
  f.snapshot.invoices = [{ ...valid, refundedMinor: 1000 }];
  await f.billing.reconcile("sub_closed");
  const rows = await f.db("invoice_metrics");
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].paid_minor), 1000);
  assert.equal(Number(rows[0].refunded_minor), 1000);
});

test("reconciliation and late-event receipts retain scope-bound encrypted customer attribution", async (t) => {
  const f = await fixture(t);
  await f.billing.receive(event());
  for (const row of await f.db("account_privacy_receipts")) {
    const details = JSON.parse(row.details);
    assert.equal(typeof details.stripeCustomerAttribution, "string");
    assert.deepEqual(unseal(details.stripeCustomerAttribution, secret), {
      version: 1,
      tenantId: "primary",
      customerId: "closed",
      requestId: "closure",
      stripeLiveMode: false,
      stripeCustomerId: "cus_closed",
    });
  }
});

test("completed scoped subscription reconciliation skips provider reads for deleted Stripe customers", async (t) => {
  const f = await fixture(t);
  await f.db("products").insert({
    tenant_id: "primary",
    id: "product",
    slug: "product",
    name: "Product",
  });
  await f.db("plans").insert({
    tenant_id: "primary",
    id: "plan",
    product_id: "product",
    name: "Plan",
    stripe_price_id: "price",
    site_allowance: 1,
  });
  await f.db("licenses").insert({
    tenant_id: "primary",
    id: "license",
    customer_id: "closed",
    product_id: "product",
    plan_id: "plan",
    site_allowance: 1,
    paid_through: 1,
    billing_status: "canceled",
    subscription_id: "sub_closed",
    key_hash: "a".repeat(64),
    revoked: 1,
    refund_revoked: 0,
    suspended: 0,
    lock_version: 0,
  });
  const source = {
    snapshot: async () => {
      throw Error("deleted Stripe customer must not be requested");
    },
  };
  const billing = new Billing(f.db, f.licenses, source);
  await billing.reconcile("sub_closed");
  const { completedSubscriptionClosure } =
    await import("../src/account-management.ts");
  assert.equal(
    await completedSubscriptionClosure(
      f.db,
      "primary",
      secret,
      "sub_closed",
      false,
    ),
    true,
  );
  assert.equal(
    await completedSubscriptionClosure(
      f.db,
      "other",
      secret,
      "sub_closed",
      false,
    ),
    false,
  );
  assert.equal(
    await completedSubscriptionClosure(
      f.db,
      "primary",
      secret,
      "sub_missing",
      false,
    ),
    false,
  );
  assert.equal(
    await completedSubscriptionClosure(
      f.db,
      "primary",
      secret,
      "sub_closed",
      true,
    ),
    false,
  );
  await f.db("account_closures").update({ status: "blocked" });
  assert.equal(
    await completedSubscriptionClosure(
      f.db,
      "primary",
      secret,
      "sub_closed",
      false,
    ),
    false,
  );
});

test("legacy attribution upgrade validates every scoped receipt atomically, never guesses missing evidence", async (t) => {
  const f = await fixture(t);
  const input = {
    ...approval,
    reference: "backfill",
    stripeCustomerId: "cus_closed",
    eventIds: [],
    workIds: [],
    auditIds: [],
    outgoingEventIds: [],
  };
  const row = await f.db("account_privacy_receipts").first();
  const original = row.details;
  const legacy = JSON.parse(original);
  delete legacy.stripeCustomerAttribution;
  await f
    .db("account_privacy_receipts")
    .update({ details: JSON.stringify(legacy) });
  const initial = (await f.db("account_privacy_receipts").first()).details;
  await assert.rejects(
    f.accounts.upgradeClosureAttribution("closed", "closure", "", input, false),
    { code: "operator_required" },
  );
  await assert.rejects(
    f.accounts.upgradeClosureAttribution(
      "closed",
      "closure",
      "operator",
      { ...input, eventIds: ["event"] },
      false,
    ),
    { code: "privacy_attribution_mismatch" },
  );
  await assert.rejects(
    f.accounts.upgradeClosureAttribution(
      "closed",
      "wrong-request",
      "operator",
      input,
      false,
    ),
    { code: "closure_reconciliation_conflict" },
  );
  await assert.rejects(
    f.accounts.upgradeClosureAttribution(
      "wrong-customer",
      "closure",
      "operator",
      input,
      false,
    ),
    { code: "closure_reconciliation_conflict" },
  );
  await f.db("account_privacy_receipts").insert({
    ...row,
    id: "second",
    details: JSON.stringify({ ...legacy, stripeLiveMode: true }),
  });
  await assert.rejects(
    f.accounts.upgradeClosureAttribution(
      "closed",
      "closure",
      "operator",
      input,
      false,
    ),
    { code: "privacy_attribution_mismatch" },
  );
  assert.equal(
    (await f.db("account_privacy_receipts").where({ id: row.id }).first())
      .details,
    initial,
  );
  await f
    .db("account_privacy_receipts")
    .where({ id: "second" })
    .update({
      details: JSON.stringify({
        ...legacy,
        stripeCustomerAttribution:
          JSON.parse(original).stripeCustomerAttribution,
      }),
    });
  await assert.rejects(
    f.accounts.upgradeClosureAttribution(
      "closed",
      "closure",
      "operator",
      { ...input, stripeCustomerId: "cus_wrong" },
      false,
    ),
    { code: "privacy_attribution_mismatch" },
  );
  const { sealPrivacyAttribution } =
    await import("../src/privacy-attribution.ts");
  await f
    .db("account_privacy_receipts")
    .where({ id: "second" })
    .update({
      details: JSON.stringify({
        ...legacy,
        stripeCustomerAttribution: sealPrivacyAttribution(
          {
            tenantId: "other",
            customerId: "closed",
            requestId: "closure",
            stripeLiveMode: false,
          },
          "cus_closed",
          secret,
        ),
      }),
    });
  await assert.rejects(
    f.accounts.upgradeClosureAttribution(
      "closed",
      "closure",
      "operator",
      input,
      false,
    ),
    { code: "privacy_attribution_mismatch" },
  );
  await f.db("account_privacy_receipts").where({ id: "second" }).delete();
  assert.deepEqual(
    await f.accounts.upgradeClosureAttribution(
      "closed",
      "closure",
      "operator",
      input,
      false,
    ),
    { upgraded: true, receipts: 1 },
  );
  await f.db("account_privacy_receipts").delete();
  await assert.rejects(
    f.accounts.upgradeClosureAttribution(
      "closed",
      "closure",
      "operator",
      input,
      false,
    ),
    { code: "privacy_attribution_mismatch" },
  );
});

test("explicitly reviewed no-provider legacy receipt upgrades retain null attribution", async (t) => {
  const f = await fixture(t);
  const row = await f.db("account_privacy_receipts").first();
  const details = JSON.parse(row.details);
  delete details.stripeCustomerAttribution;
  details.referenceDigests = [];
  await f
    .db("account_privacy_receipts")
    .update({ details: JSON.stringify(details) });
  const input = {
    ...approval,
    reference: "no-provider-reviewed",
    stripeCustomerId: null,
    eventIds: [],
    workIds: [],
    auditIds: [],
    outgoingEventIds: [],
  };
  assert.equal(
    (
      await f.accounts.upgradeClosureAttribution(
        "closed",
        "closure",
        "operator",
        input,
        false,
      )
    ).upgraded,
    true,
  );
  const upgraded = JSON.parse(
    (await f.db("account_privacy_receipts").first()).details,
  );
  assert.equal(
    unseal<{ stripeCustomerId: null }>(
      upgraded.stripeCustomerAttribution,
      secret,
    ).stripeCustomerId,
    null,
  );
  await f.accounts.upgradeClosureAttribution(
    "closed",
    "closure",
    "operator",
    input,
    false,
  );
  await f.db("products").insert({
    tenant_id: "primary",
    id: "product",
    slug: "product",
    name: "Product",
  });
  await f.db("plans").insert({
    tenant_id: "primary",
    id: "plan",
    product_id: "product",
    name: "Plan",
    stripe_price_id: "price",
    site_allowance: 1,
  });
  await f.db("licenses").insert({
    tenant_id: "primary",
    id: "license",
    customer_id: "closed",
    product_id: "product",
    plan_id: "plan",
    site_allowance: 1,
    paid_through: 1,
    billing_status: "canceled",
    subscription_id: "sub_closed",
    key_hash: "a".repeat(64),
    revoked: 1,
    refund_revoked: 0,
    suspended: 0,
    lock_version: 0,
  });
  await assert.rejects(
    f.accounts.upgradeClosureAttribution(
      "closed",
      "closure",
      "operator",
      input,
      false,
    ),
    { code: "privacy_attribution_mismatch" },
  );
  const { completedSubscriptionClosure } =
    await import("../src/account-management.ts");
  assert.equal(
    await completedSubscriptionClosure(
      f.db,
      "primary",
      secret,
      "sub_closed",
      false,
    ),
    false,
  );
  delete upgraded.stripeCustomerAttribution;
  await f
    .db("account_privacy_receipts")
    .update({ details: JSON.stringify(upgraded) });
  assert.equal(
    await completedSubscriptionClosure(
      f.db,
      "primary",
      secret,
      "sub_closed",
      false,
    ),
    false,
  );
});

test("late event lookup authenticates encrypted destination receipt scope before minimizing", async (t) => {
  const f = await fixture(t);
  const { sealPrivacyAttribution } =
    await import("../src/privacy-attribution.ts");
  const row = await f.db("account_privacy_receipts").first();
  const details = JSON.parse(row.details);
  for (const changed of [
    { tenantId: "other" },
    { customerId: "other" },
    { requestId: "other" },
    { stripeLiveMode: true },
  ]) {
    const scope = {
      tenantId: "primary",
      customerId: "closed",
      requestId: "closure",
      stripeLiveMode: false,
      ...changed,
    };
    const cipher = sealPrivacyAttribution(scope, "cus_closed", secret);
    await f
      .db("account_privacy_receipts")
      .where({ id: row.id })
      .update({
        details: JSON.stringify({
          ...details,
          stripeCustomerAttribution: cipher,
        }),
      });
    await assert.rejects(f.billing.receive(event()), {
      code: "privacy_attribution_mismatch",
    });
    assert.equal((await f.db("billing_events")).length, 0);
  }
  await f.db("account_privacy_receipts").update({ details: row.details });
  await f.billing.receive(event());
  assert.equal((await f.db("billing_events").first()).payload, "{}");
});

test("reviewed legacy null attribution retains HMAC protection for a canonical late customer event", async (t) => {
  const f = await fixture(t);
  const { completedCustomerClosure, privacyReferenceDigest } =
    await import("../src/account-management.ts");
  const row = await f.db("account_privacy_receipts").first();
  const details = JSON.parse(row.details);
  delete details.stripeCustomerAttribution;
  await f
    .db("account_privacy_receipts")
    .update({ details: JSON.stringify(details) });
  assert.equal(
    (await completedCustomerClosure(
      f.db,
      "primary",
      secret,
      "cus_closed",
      false,
    ))!.id,
    row.id,
  );
  details.referenceDigests = [privacyReferenceDigest(secret, "cus_closed")];
  await f
    .db("account_privacy_receipts")
    .update({ details: JSON.stringify(details) });
  await f.accounts.upgradeClosureAttribution(
    "closed",
    "closure",
    "operator",
    {
      ...approval,
      reference: "legacy-reviewed-null",
      stripeCustomerId: null,
      eventIds: [],
      workIds: [],
      auditIds: [],
      outgoingEventIds: [],
    },
    false,
  );
  assert.equal(
    (
      await completedCustomerClosure(
        f.db,
        "primary",
        secret,
        "cus_closed",
        false,
      )
    )?.id,
    row.id,
  );
  await f.billing.receive({
    ...event("evt_legacy_null"),
    type: "customer.updated",
    data: { object: { id: "cus_closed", email: "closed@example.test" } },
  });
  assert.equal((await f.db("billing_events").first()).payload, "{}");
  assert.equal((await f.db("work")).length, 0);
  const receipts = await f.db("account_privacy_receipts");
  assert.equal(receipts.length, 2);
  assert.ok(!JSON.stringify(receipts).includes("closed@example.test"));
});

test("historical bindings on the same completed closure minimize late financial events in either receipt order", async (t) => {
  const f = await fixture(t);
  const { sealPrivacyAttribution, privacyReferenceDigest } =
    await import("../src/privacy-attribution.ts");
  const original = await f.db("account_privacy_receipts").first();
  const details = JSON.parse(original.details);
  const bindings = ["cus_closed", "cus_second"];
  const rows = bindings.map((binding, index) => ({
    ...original,
    id: `receipt_${index}`,
    details: JSON.stringify({
      ...details,
      referenceDigests: bindings.map((id) =>
        privacyReferenceDigest(secret, id),
      ),
      stripeCustomerAttribution: sealPrivacyAttribution(
        {
          tenantId: "primary",
          customerId: "closed",
          requestId: "closure",
          stripeLiveMode: false,
        },
        binding,
        secret,
      ),
    }),
  }));
  for (const order of [rows, [...rows].reverse()]) {
    await f.db("account_privacy_receipts").delete();
    // Fixed row IDs make either binding the first candidate even on engines
    // that return rows in primary-key order rather than insertion order.
    await f
      .db("account_privacy_receipts")
      .insert(order.map((row, index) => ({ ...row, id: `receipt_${index}` })));
    await f.db("billing_events").delete();
    for (const binding of bindings)
      await f.billing.receive(event(`evt_${binding}`, binding));
    assert.ok(
      (await f.db("billing_events")).every(
        (row) => row.payload === "{}" && row.processed_at !== null,
      ),
    );
    assert.equal((await f.db("work")).length, 0);
    const receipts = await f.db("account_privacy_receipts");
    assert.equal(receipts.length, 4);
    for (const binding of bindings)
      assert.ok(
        receipts.some((row) =>
          JSON.parse(row.details).events.some(
            (event: { id: string }) => event.id === `evt_${binding}`,
          ),
        ),
      );
  }
});

test("matching HMAC with malformed or unauthenticated ciphertext refuses late event storage", async (t) => {
  const f = await fixture(t);
  const original = await f.db("account_privacy_receipts").first();
  const details = JSON.parse(original.details);
  for (const cipher of [
    "malformed",
    seal({ invalid: "scope" }, secret),
    seal(
      {
        version: 1,
        tenantId: "primary",
        customerId: "closed",
        requestId: "closure",
        stripeLiveMode: false,
        stripeCustomerId: "cus_closed",
      },
      "99".repeat(32),
    ),
  ]) {
    await f.db("account_privacy_receipts").update({
      details: JSON.stringify({
        ...details,
        stripeCustomerAttribution: cipher,
      }),
    });
    await assert.rejects(f.billing.receive(event()));
    assert.equal((await f.db("billing_events")).length, 0);
    assert.equal((await f.db("work")).length, 0);
  }
});
