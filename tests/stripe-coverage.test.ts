import { primaryTenant } from "./helpers/tenant.ts";
import test, { before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import Stripe from "stripe";
import { createDb, migrate, reset, type Plan } from "../src/db.ts";
import { StripeBilling } from "../src/stripe.ts";
import { Billing } from "../src/billing.ts";
import { Licenses } from "../src/licensing.ts";
import { loadConfig } from "../src/config.ts";

const root = await mkdtemp(
  "/Volumes/Scratch/double-entitle-wp/tmp/stripe-coverage-",
);
const db = createDb(process.env.TEST_DATABASE_URL ?? `sqlite:${root}/db`);
type Request = {
  path: string;
  query: URLSearchParams;
  body: URLSearchParams;
  idempotency: string | undefined;
  account: string | undefined;
};
type Route = (request: Request) => unknown;
const routes = new Map<string, Route>();
const requests: Request[] = [];
let expectedAccount: string | undefined = "acct_primary";
const list = (path: string, data: unknown[], hasMore = false) => ({
  object: "list",
  url: path,
  data,
  has_more: hasMore,
});
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const url = new URL(req.url!, "http://localhost");
  const request = {
    path: url.pathname,
    query: url.searchParams,
    body: new URLSearchParams(Buffer.concat(chunks).toString()),
    idempotency: req.headers["idempotency-key"] as string | undefined,
    account: req.headers["stripe-account"] as string | undefined,
  };
  requests.push(request);
  const route = routes.get(`${req.method} ${url.pathname}`);
  res.setHeader("content-type", "application/json");
  if (!route) {
    res.statusCode = 404;
    res.end(
      JSON.stringify({
        error: {
          type: "invalid_request_error",
          message: `Unexpected fixture ${req.method} ${url.pathname}`,
        },
      }),
    );
    return;
  }
  res.end(JSON.stringify(route(request)));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const config = loadConfig({
  DEPLOYMENT_MODE: "hosted",
  APP_SECRET: "77".repeat(32),
  OPERATOR_TOKEN: "operator-token".repeat(4),
});
function adapter(local = false) {
  const source = new StripeBilling(
    db,
    { ...config, localBilling: local },
    primaryTenant,
  );
  source.stripe = new Stripe("sk_test_fixture", {
    apiVersion: "2026-09-30.endive",
    host: "127.0.0.1",
    port,
    protocol: "http",
    maxNetworkRetries: 0,
  });
  return source;
}
const plan: Plan = {
  tenant_id: "primary",
  id: "one",
  product_id: "prod",
  name: "One",
  site_allowance: 1,
  stripe_price_id: "price_one",
};
const invoice = (patch: Record<string, unknown> = {}) => ({
  id: "in_paid",
  status: "paid",
  amount_paid: 1000,
  currency: "usd",
  created: 50,
  status_transitions: { paid_at: 70 },
  parent: { subscription_details: { subscription: "sub_1" } },
  ...patch,
});
const line = (patch: Record<string, unknown> = {}) => ({
  id: "il_paid",
  amount: 1000,
  parent: { subscription_item_details: {} },
  pricing: { price_details: { price: "price_one" } },
  period: { start: 10, end: 100 },
  ...patch,
});
before(async () => {
  await migrate(db);
});
after(async () => {
  await db.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await reset(db);
  routes.clear();
  requests.length = 0;
  expectedAccount = "acct_primary";
  routes.set("GET /v1/subscriptions/sub_1", () => ({
    id: "sub_1",
    customer: { id: "cus_1" },
    status: "active",
  }));
  routes.set("GET /v1/customers/cus_1", () => ({
    id: "cus_1",
    email: "owner@example.test",
  }));
  routes.set("GET /v1/invoices", () => list("/v1/invoices", [invoice()]));
  routes.set("GET /v1/invoices/in_paid", () => invoice());
  routes.set("GET /v1/invoice_payments", () =>
    list("/v1/invoice_payments", [
      {
        id: "inpay_1",
        invoice: { id: "in_paid" },
        payment: { payment_intent: { id: "pi_1" } },
      },
    ]),
  );
  routes.set("GET /v1/charges", () =>
    list("/v1/charges", [
      { id: "ch_good", paid: true, amount_refunded: 0, disputed: false },
    ]),
  );
  routes.set("GET /v1/invoices/in_paid/lines", () =>
    list("/v1/invoices/in_paid/lines", [line()]),
  );
  routes.set("GET /v1/prices/price_one", () => ({
    id: "price_one",
    active: true,
    type: "recurring",
    recurring: { interval: "year", interval_count: 1 },
  }));
  routes.set("POST /v1/customers", () => ({ id: "cus_new" }));
  routes.set("POST /v1/checkout/sessions", () => ({
    id: "cs_new",
    url: "https://checkout.stripe.com/c/pay/fixture",
  }));
  routes.set("POST /v1/billing_portal/sessions", () => ({
    id: "bps_1",
    url: "https://billing.stripe.com/fixture",
  }));
});

afterEach(() => {
  for (const request of requests)
    assert.equal(request.account, expectedAccount, request.path);
});

test("snapshot follows invoice, charge and line pagination while ignoring unpaid and non-subscription evidence", async () => {
  routes.set("GET /v1/invoices", (r) =>
    r.query.has("starting_after")
      ? list("/v1/invoices", [invoice()])
      : list(
          "/v1/invoices",
          [
            invoice({ id: "in_open", status: "open" }),
            invoice({ id: "in_zero", amount_paid: 0 }),
          ],
          true,
        ),
  );
  routes.set("GET /v1/charges", (r) =>
    r.query.has("starting_after")
      ? list("/v1/charges", [
          { id: "ch_good", paid: true, amount_refunded: 250, disputed: false },
        ])
      : list(
          "/v1/charges",
          [
            {
              id: "ch_failed",
              paid: false,
              amount_refunded: 1000,
              disputed: true,
            },
          ],
          true,
        ),
  );
  routes.set("GET /v1/invoices/in_paid/lines", (r) =>
    r.query.has("starting_after")
      ? list("/v1/invoices/in_paid/lines", [
          line({
            id: "il_last",
            pricing: { price_details: { price: { id: "price_one" } } },
          }),
        ])
      : list(
          "/v1/invoices/in_paid/lines",
          [
            line({ id: "il_negative", amount: -10 }),
            line({ id: "il_manual", parent: null }),
            line({ id: "il_no_price", pricing: null }),
          ],
          true,
        ),
  );
  const s = await adapter().snapshot("sub_1");
  assert.deepEqual(s.grants, [
    {
      id: "il_last",
      invoiceId: "in_paid",
      priceId: "price_one",
      periodStart: 10000,
      periodEnd: 100000,
      paidAt: 70000,
      settled: true,
    },
  ]);
  assert.equal(s.fullyRefunded, false);
  assert.equal(s.suspended, false);
  assert.equal(s.email, "owner@example.test");
  assert.equal(requests.filter((r) => r.path === "/v1/invoices").length, 2);
  assert.equal(requests.filter((r) => r.path === "/v1/charges").length, 2);
  assert.equal(
    requests.find((r) => r.path === "/v1/charges")!.query.get("payment_intent"),
    "pi_1",
  );
  assert.equal(
    requests
      .find((r) => r.path === "/v1/invoice_payments")!
      .query.get("status"),
    "paid",
  );
});

test("snapshot handles direct charges, unsupported external payment records, timestamp fallback and dispute resolution", async () => {
  routes.set("GET /v1/subscriptions/sub_1", () => ({
    id: "sub_1",
    customer: "cus_1",
    status: "canceled",
  }));
  routes.set("GET /v1/invoices", () =>
    list("/v1/invoices", [invoice({ status_transitions: { paid_at: null } })]),
  );
  routes.set("GET /v1/invoice_payments", () =>
    list("/v1/invoice_payments", [
      { id: "ip_external", payment: { type: "payment_record" } },
      { id: "ip_direct", payment: { charge: { id: "ch_direct" } } },
    ]),
  );
  routes.set("GET /v1/charges/ch_direct", () => ({
    id: "ch_direct",
    paid: true,
    amount_refunded: 1000,
    disputed: true,
  }));
  routes.set("GET /v1/disputes", (r) =>
    r.query.has("starting_after")
      ? list("/v1/disputes", [{ id: "dp_open", status: "needs_response" }])
      : list(
          "/v1/disputes",
          [
            { id: "dp_won", status: "won" },
            { id: "dp_warning", status: "warning_closed" },
          ],
          true,
        ),
  );
  const s = await adapter().snapshot("sub_1");
  assert.equal(s.fullyRefunded, true);
  assert.equal(s.suspended, true);
  assert.equal(s.grants[0]!.paidAt, 50000);
  assert.equal(s.billingStatus, "canceled");
  routes.set("GET /v1/disputes", () =>
    list("/v1/disputes", [{ id: "dp_resolved", status: "warning_closed" }]),
  );
  assert.equal((await adapter().snapshot("sub_1")).suspended, false);
});

test("deleted or email-less customers still return canonical billing evidence", async () => {
  for (const customer of [
    { id: "cus_1", deleted: true },
    { id: "cus_1", email: null },
    { id: "cus_1", email: "" },
  ]) {
    routes.set("GET /v1/customers/cus_1", () => customer);
    const snapshot = await adapter().snapshot("sub_1");
    assert.equal(snapshot.email, "");
    assert.equal(snapshot.grants.length, 1);
  }
  assert.equal(
    requests.some((r) => r.path === "/v1/invoices"),
    true,
  );
});

test("unrelated subscriptions without customer email finish scheduled work without issuing a license", async () => {
  const billing = new Billing(
    db,
    new Licenses(db, config.secret, [], primaryTenant),
    adapter(),
  );
  for (const customer of [
    { id: "cus_1", deleted: true },
    { id: "cus_1", email: null },
    { id: "cus_1", email: "" },
  ]) {
    routes.set("GET /v1/customers/cus_1", () => customer);
    await billing.enqueueReconcile(["sub_1"]);
    await billing.run(async () => null);
    const jobs = await db("work");
    assert.ok(jobs.every((job) => job.state === "sent"));
    assert.equal((await db("licenses")).length, 0);
    assert.equal((await db("customers")).length, 0);
    assert.equal((await db("emails")).length, 0);
  }
});

async function mappedPlan() {
  await db("products").insert({
    tenant_id: "primary",
    id: "prod",
    slug: "product",
    name: "Product",
  });
  await db("plans").insert(plan);
}

test("an existing license reconciles cancellation without customer email and preserves its paid grant", async () => {
  await mappedPlan();
  const licensing = new Licenses(db, config.secret, [], primaryTenant);
  const billing = new Billing(db, licensing, adapter());
  const now = Math.floor(Date.now() / 1000);
  routes.set("GET /v1/invoices/in_paid/lines", () =>
    list("/v1/invoices/in_paid/lines", [
      line({ period: { start: now - 60, end: now + 86400 } }),
    ]),
  );
  await billing.reconcile("sub_1");
  const before = await db("licenses").first();
  assert.equal(licensing.entitled(before), true);
  routes.set("GET /v1/subscriptions/sub_1", () => ({
    id: "sub_1",
    customer: "cus_1",
    status: "canceled",
  }));
  routes.set("GET /v1/invoices", () => list("/v1/invoices", []));
  for (const customer of [
    { id: "cus_1", deleted: true },
    { id: "cus_1", email: null },
  ]) {
    routes.set("GET /v1/customers/cus_1", () => customer);
    await billing.enqueueReconcile(["sub_1"]);
    await billing.run(async () => null);
    const after = await db("licenses").first();
    assert.equal(after.billing_status, "canceled");
    assert.equal(Number(after.paid_through), Number(before.paid_through));
    assert.equal(after.site_allowance, before.site_allowance);
    assert.equal(after.key_hash, before.key_hash);
    assert.equal(licensing.entitled(after), true);
    assert.equal((await db("grants")).length, 1);
    assert.ok((await db("work")).every((job) => job.state === "sent"));
  }
});

test("a mapped paid purchase without customer email remains retryable without credentials until corrected", async () => {
  await mappedPlan();
  routes.set("GET /v1/customers/cus_1", () => ({ id: "cus_1", email: null }));
  const billing = new Billing(
    db,
    new Licenses(db, config.secret, [], primaryTenant),
    adapter(),
  );
  await billing.enqueueReconcile(["sub_1"]);
  await billing.run(async () => null);
  const retry = await db("work").first();
  assert.equal(retry.state, "pending");
  assert.equal(retry.attempts, 1);
  assert.equal((await db("licenses")).length, 0);
  assert.equal((await db("emails")).length, 0);
  await billing.enqueueReconcile(["sub_1"]);
  assert.equal((await db("work")).length, 1);
  assert.equal(
    Number((await db("work").first()).available_at),
    Number(retry.available_at),
  );
  routes.set("GET /v1/customers/cus_1", () => ({
    id: "cus_1",
    email: "owner@example.test",
  }));
  await db("work").update({ available_at: 0 });
  await billing.run(async () => null);
  assert.equal((await db("work").first()).state, "sent");
  assert.equal((await db("licenses")).length, 1);
  assert.equal((await db("emails")).length, 1);
});

test("events resolve canonical subscriptions and acknowledge unrelated invoices, sessions and events", async () => {
  const source = adapter();
  const resolve = (type: string, id = "object") =>
    source.resolveSubscription({ id: "evt", type, data: { object: { id } } });
  assert.equal(
    await resolve("customer.subscription.deleted", "sub_1"),
    "sub_1",
  );
  assert.equal(await resolve("invoice.paid", "in_paid"), "sub_1");
  routes.set("GET /v1/invoices/in_paid", () => invoice({ parent: null }));
  assert.equal(await resolve("invoice.payment_failed", "in_paid"), null);
  routes.set("GET /v1/checkout/sessions/cs_1", () => ({
    id: "cs_1",
    subscription: { id: "sub_1" },
  }));
  assert.equal(await resolve("checkout.session.completed", "cs_1"), "sub_1");
  routes.set("GET /v1/checkout/sessions/cs_1", () => ({
    id: "cs_1",
    subscription: null,
  }));
  assert.equal(await resolve("checkout.session.expired", "cs_1"), null);
  assert.equal(await resolve("customer.created"), null);
});

test("PaymentIntent refund/dispute lookup skips unrelated invoice payments and follows pagination", async () => {
  routes.set("GET /v1/charges/ch_1", () => ({
    id: "ch_1",
    payment_intent: { id: "pi_1" },
  }));
  routes.set("GET /v1/refunds/re_1", () => ({
    id: "re_1",
    charge: { id: "ch_1" },
  }));
  routes.set("GET /v1/disputes/dp_1", () => ({
    id: "dp_1",
    charge: { id: "ch_1" },
  }));
  routes.set("GET /v1/invoice_payments", (r) =>
    r.query.has("starting_after")
      ? list("/v1/invoice_payments", [{ id: "ip_paid", invoice: "in_paid" }])
      : list(
          "/v1/invoice_payments",
          [{ id: "ip_other", invoice: { id: "in_other" } }],
          true,
        ),
  );
  routes.set("GET /v1/invoices/in_other", () =>
    invoice({ id: "in_other", parent: null }),
  );
  const source = adapter();
  for (const [type, id] of [
    ["charge.refunded", "ch_1"],
    ["refund.updated", "re_1"],
    ["charge.dispute.closed", "dp_1"],
  ]) {
    assert.equal(
      await source.resolveSubscription({
        id: "evt",
        type: type!,
        data: { object: { id } },
      }),
      "sub_1",
    );
  }
  assert.equal(
    requests
      .find((r) => r.path === "/v1/invoice_payments")!
      .query.get("payment[payment_intent]"),
    "pi_1",
  );
  routes.set("GET /v1/invoice_payments", () =>
    list("/v1/invoice_payments", []),
  );
  assert.equal(
    await source.resolveSubscription({
      id: "evt",
      type: "charge.refunded",
      data: { object: { id: "ch_1" } },
    }),
    null,
  );
  routes.set("GET /v1/refunds/re_1", () => ({ id: "re_1", charge: null }));
  assert.equal(
    await source.resolveSubscription({
      id: "evt",
      type: "refund.created",
      data: { object: { id: "re_1" } },
    }),
    null,
  );
});

test("legacy charge recovery follows customer invoices and payment pages without matching unrelated charges", async () => {
  routes.set("GET /v1/charges/ch_legacy", () => ({
    id: "ch_legacy",
    customer: { id: "cus_1" },
    payment_intent: null,
  }));
  routes.set("GET /v1/invoices", (r) =>
    r.query.has("starting_after")
      ? list("/v1/invoices", [invoice()])
      : list(
          "/v1/invoices",
          [invoice({ id: "in_manual", parent: null })],
          true,
        ),
  );
  routes.set("GET /v1/invoice_payments", (r) =>
    r.query.has("starting_after")
      ? list("/v1/invoice_payments", [
          { id: "ip_match", payment: { charge: { id: "ch_legacy" } } },
        ])
      : list(
          "/v1/invoice_payments",
          [{ id: "ip_unrelated", payment: { charge: "ch_other" } }],
          true,
        ),
  );
  const source = adapter();
  const event = {
    id: "evt",
    type: "charge.refunded",
    data: { object: { id: "ch_legacy" } },
  };
  assert.equal(await source.resolveSubscription(event), "sub_1");
  assert.equal(
    requests.find((r) => r.path === "/v1/invoices")!.query.get("customer"),
    "cus_1",
  );
  routes.set("GET /v1/invoice_payments", () =>
    list("/v1/invoice_payments", [{ id: "ip_unrelated", payment: {} }]),
  );
  assert.equal(await source.resolveSubscription(event), null);
  routes.set("GET /v1/charges/ch_legacy", () => ({
    id: "ch_legacy",
    customer: null,
    payment_intent: null,
  }));
  assert.equal(await source.resolveSubscription(event), null);
});

test("checkout rejects inactive and nonannual prices before creating Stripe customers or sessions", async () => {
  let candidate = 0;
  for (const price of [
    {
      active: false,
      type: "recurring",
      recurring: { interval: "year", interval_count: 1 },
    },
    { active: true, type: "one_time" },
    { active: true, type: "recurring", recurring: null },
    {
      active: true,
      type: "recurring",
      recurring: { interval: "month", interval_count: 1 },
    },
    {
      active: true,
      type: "recurring",
      recurring: { interval: "year", interval_count: 2 },
    },
  ]) {
    routes.set("GET /v1/prices/price_one", () => ({
      id: "price_one",
      ...price,
    }));
    await assert.rejects(
      adapter().checkout(plan, `new${candidate++}@example.test`),
      /active annual/,
    );
  }
  assert.equal(
    requests.some(
      (r) => r.path === "/v1/customers" || r.path === "/v1/checkout/sessions",
    ),
    false,
  );
});

test("authenticated customer without Stripe mapping receives one idempotent mapping and reuses it", async () => {
  await db("customers").insert({
    tenant_id: "primary",
    id: "pending",
    email: "owner@example.test",
    stripe_id: null,
  });
  const source = adapter();
  await assert.rejects(
    source.checkout(plan, "owner@example.test", "foreign"),
    /Sign in/,
  );
  assert.deepEqual(
    await source.checkout(plan, "owner@example.test", "pending"),
    { url: "https://checkout.stripe.com/c/pay/fixture" },
  );
  assert.equal(
    (await db("customers").where({ id: "pending" }).first()).stripe_id,
    "cus_new",
  );
  assert.equal(
    requests.find((r) => r.path === "/v1/customers")!.idempotency,
    "double-entitle-customer-primary-pending",
  );
  assert.equal(
    requests
      .find((r) => r.path === "/v1/checkout/sessions")!
      .body.get("customer"),
    "cus_new",
  );
  await source.checkout(plan, "owner@example.test", "pending");
  assert.equal(requests.filter((r) => r.path === "/v1/customers").length, 1);
});

test("checkout rejects missing provider URL without issuing any license", async () => {
  routes.set("POST /v1/checkout/sessions", () => ({
    id: "cs_missing",
    url: null,
  }));
  await assert.rejects(
    adapter().checkout(plan, "new@example.test"),
    /checkout URL/,
  );
  assert.equal((await db("licenses")).length, 0);
});

test("Portal uses server-selected customer and reconciliation discovers all subscription pages", async () => {
  const source = adapter();
  assert.deepEqual(await source.portal("cus_owned"), {
    url: "https://billing.stripe.com/fixture",
  });
  assert.equal(requests[0]!.body.get("customer"), "cus_owned");
  assert.equal(
    requests[0]!.body.get("return_url"),
    `${config.origin}/t/primary`,
  );
  routes.set("GET /v1/subscriptions", (r) =>
    r.query.has("starting_after")
      ? list("/v1/subscriptions", [{ id: "sub_2" }])
      : list("/v1/subscriptions", [{ id: "sub_1" }], true),
  );
  assert.deepEqual(await source.subscriptionIds(), ["sub_1", "sub_2"]);
  assert.equal(
    requests.find((r) => r.path === "/v1/subscriptions")!.query.get("status"),
    "all",
  );
});

test("fixture mode denies every Stripe network operation before sending a request", async () => {
  const source = adapter(true);
  for (const call of [
    () => source.snapshot("sub_1"),
    () => source.checkout(plan, "person@example.test"),
    () => source.portal("cus_1"),
    () =>
      source.resolveSubscription({
        id: "evt",
        type: "customer.subscription.created",
        data: { object: { id: "sub_1" } },
      }),
    () => source.subscriptionIds(),
  ])
    await assert.rejects(call(), /disabled in local fixture mode/);
  assert.equal(requests.length, 0);
});

const attributionEvent = (
  type: string,
  objectId: string,
  livemode = false,
) => ({
  id: "evt_privacy",
  type,
  livemode,
  data: { object: { id: objectId, customer: "cus_spoofed" } },
});

test("privacy attribution resolves canonical non-subscription charges, refunds and disputes with account scope", async () => {
  const source = adapter();
  routes.set("GET /v1/charges/ch_direct", () => ({
    id: "ch_direct",
    livemode: false,
    customer: { id: "cus_closed" },
    payment_intent: null,
  }));
  routes.set("GET /v1/disputes/dp_direct", () => ({
    id: "dp_direct",
    livemode: false,
    charge: { id: "ch_direct" },
  }));
  routes.set("GET /v1/refunds/re_direct", () => ({
    id: "re_direct",
    charge: "ch_direct",
    customer: null,
  }));
  for (const [type, objectId] of [
    ["charge.refunded", "ch_direct"],
    ["refund.updated", "re_direct"],
    ["charge.refund.updated", "re_direct"],
    ["charge.dispute.closed", "dp_direct"],
  ])
    assert.equal(
      await source.resolveCustomer(attributionEvent(type!, objectId!)),
      "cus_closed",
    );
  assert.ok(!requests.some((r) => /invoice|subscription/.test(r.path)));
});

test("privacy attribution supports canonical direct refund customer and payment-intent fallback without guessing from webhook fields", async () => {
  const source = adapter();
  routes.set("GET /v1/refunds/re_direct", () => ({
    id: "re_direct",
    customer: "cus_closed",
    charge: null,
    payment_intent: null,
  }));
  assert.equal(
    await source.resolveCustomer(
      attributionEvent("refund.created", "re_direct"),
    ),
    "cus_closed",
  );
  routes.set("GET /v1/refunds/re_direct", () => ({
    id: "re_direct",
    customer: null,
    charge: null,
    payment_intent: { id: "pi_direct" },
  }));
  routes.set("GET /v1/payment_intents/pi_direct", () => ({
    id: "pi_direct",
    livemode: false,
    customer: "cus_closed",
  }));
  assert.equal(
    await source.resolveCustomer(
      attributionEvent("refund.failed", "re_direct"),
    ),
    "cus_closed",
  );
  routes.set("GET /v1/payment_intents/pi_guest", () => ({
    id: "pi_guest",
    livemode: false,
    customer: null,
  }));
  assert.equal(
    await source.resolveCustomer(
      attributionEvent("payment_intent.succeeded", "pi_guest"),
    ),
    null,
  );
  routes.set("GET /v1/refunds/re_direct", () => ({
    id: "re_direct",
    customer: null,
    charge: null,
    payment_intent: null,
  }));
  assert.equal(
    await source.resolveCustomer(
      attributionEvent("refund.created", "re_direct"),
    ),
    null,
  );
  routes.set("GET /v1/charges/ch_guest", () => ({
    id: "ch_guest",
    livemode: false,
    customer: null,
  }));
  assert.equal(
    await source.resolveCustomer(
      attributionEvent("charge.succeeded", "ch_guest"),
    ),
    null,
  );
});

test("privacy attribution retrieves invoice, subscription, Checkout and PaymentIntent customers independently of license history", async () => {
  const source = adapter();
  for (const [type, objectId, path] of [
    ["invoice.updated", "in_direct", "invoices"],
    ["customer.subscription.deleted", "sub_direct", "subscriptions"],
    ["checkout.session.completed", "cs_direct", "checkout/sessions"],
    ["payment_intent.succeeded", "pi_direct", "payment_intents"],
  ]) {
    routes.set(`GET /v1/${path}/${objectId}`, () => ({
      id: objectId,
      livemode: false,
      customer: "cus_closed",
    }));
    assert.equal(
      await source.resolveCustomer(attributionEvent(type!, objectId!)),
      "cus_closed",
    );
  }
});

test("privacy attribution fails before persistence on mode, provider identity, unsupported family or missing event identity", async () => {
  const source = adapter();
  const event = attributionEvent("charge.refunded", "ch_direct");
  await assert.rejects(source.resolveCustomer({ ...event, livemode: true }), {
    code: "stripe_mode",
  });
  for (const canonical of [
    { id: "ch_direct", livemode: true, customer: "cus_closed" },
    { id: "ch_other", livemode: false, customer: "cus_closed" },
  ]) {
    routes.set("GET /v1/charges/ch_direct", () => canonical);
    await assert.rejects(source.resolveCustomer(event), {
      code: "billing_privacy_attribution_required",
    });
  }
  await assert.rejects(
    source.resolveCustomer(attributionEvent("unrecognized.event", "unknown")),
    { code: "billing_privacy_attribution_required" },
  );
  await assert.rejects(
    source.resolveCustomer({ ...event, data: { object: {} } }),
    { code: "billing_privacy_attribution_required" },
  );
  routes.set("GET /v1/disputes/dp_missing", () => ({
    id: "dp_missing",
    livemode: false,
    charge: null,
  }));
  await assert.rejects(
    source.resolveCustomer(
      attributionEvent("charge.dispute.created", "dp_missing"),
    ),
    { code: "billing_privacy_attribution_required" },
  );
  await assert.rejects(
    source.resolveCustomer(
      attributionEvent("charge.refunded", "ch_unavailable"),
    ),
    /Unexpected fixture/,
  );
  await assert.rejects(adapter(true).resolveCustomer(event), {
    code: "local_billing",
  });
});

test("privacy attribution uses the standalone merchant directly and supports the test-mode default", async () => {
  expectedAccount = undefined;
  const standalone = { ...config, deploymentMode: "standalone" as const };
  delete standalone.stripeLiveMode;
  const source = new StripeBilling(db, standalone, {
    ...primaryTenant,
    stripe_account_id: null,
  });
  source.stripe = adapter().stripe;
  routes.set("GET /v1/invoices/in_guest", () => ({
    id: "in_guest",
    livemode: false,
    customer: null,
  }));
  assert.equal(
    await source.resolveCustomer({
      id: "evt_guest",
      type: "invoice.paid",
      data: { object: { id: "in_guest" } },
    }),
    null,
  );
  assert.equal(requests.length, 1);
});

test("privacy attribution rejects missing or malformed canonical customer and refund context", async () => {
  const source = adapter();
  for (const customer of [undefined, "", {}, { id: 42 }, { id: "" }]) {
    routes.set("GET /v1/charges/ch_malformed", () => ({
      id: "ch_malformed",
      livemode: false,
      customer,
    }));
    await assert.rejects(
      source.resolveCustomer(
        attributionEvent("charge.refunded", "ch_malformed"),
      ),
      { code: "billing_privacy_attribution_required" },
    );
  }
  routes.set("GET /v1/refunds/re_malformed", () => ({
    id: "re_malformed",
    customer: null,
    charge: null,
  }));
  await assert.rejects(
    source.resolveCustomer(attributionEvent("refund.created", "re_malformed")),
    { code: "billing_privacy_attribution_required" },
  );
  routes.set("GET /v1/refunds/re_malformed", () => ({
    id: "re_other",
    customer: null,
    charge: null,
    payment_intent: null,
  }));
  await assert.rejects(
    source.resolveCustomer(attributionEvent("refund.created", "re_malformed")),
    { code: "billing_privacy_attribution_required" },
  );
  routes.set("GET /v1/refunds/re_malformed", () => ({
    id: "re_malformed",
    customer: null,
    charge: null,
    payment_intent: null,
  }));
  await assert.rejects(
    source.resolveCustomer({
      id: "evt",
      type: "refund.created",
      data: { object: { id: "re_malformed" } },
    }),
    { code: "billing_privacy_attribution_required" },
  );
});
