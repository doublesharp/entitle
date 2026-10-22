import { primaryTenant, testTenantKey } from "./helpers/tenant.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import Stripe from "stripe";
import { createDb, migrate, reset } from "../src/db.ts";
import { buildApp } from "../src/app.ts";
import { hash, unseal } from "../src/crypto.ts";
import type { Message } from "../src/email.ts";
import { Licenses } from "../src/licensing.ts";
const root = await mkdtemp("/Volumes/Scratch/double-entitle-wp/tmp/api-");
const db = createDb(`sqlite:${root}/db`);
const config = {
  origin: "http://localhost:3210",
  secret: "22".repeat(32),
  operatorToken: "test-operator-token-long-enough-123456",
  storage: `${root}/artifacts`,
  staticDir: `${root}/web`,
  production: false,
  exemptSuffixes: [],
  stripeSecret: "sk_test_fixture",
  stripeWebhookSecret: "whsec_local",
  stripeConnectWebhookSecret: "whsec_connect_local",
  smtpHost: "localhost",
  smtpPort: 1025,
  smtpUser: "",
  smtpPass: "",
  smtpSecure: false,
  mailFrom: "licenses@example.test",
  port: 3210,
  databaseUrl: `sqlite:${root}/db`,
  localBilling: true,
  deploymentMode: "hosted" as const,
  standaloneOwnerEmail: "",
  hostedApplicationFeePercent: 1,
};
await mkdir(config.staticDir);
await writeFile(
  `${config.staticDir}/index.html`,
  "<!doctype html><title>Double Entitle</title>",
);
const store = new InMemoryArtifactStore();
const app = await buildApp(config, db, undefined, { store });
before(async () => {
  await migrate(db);
  await app.ready();
});
after(async () => {
  await app.close();
  await db.destroy();
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await reset(db);
  await seedTenantKey(db);
  await db("tenants")
    .where({ id: "primary" })
    .update({ stripe_account_id: "acct_primary", stripe_status: "connected" });
  await db("customers").insert([
    {
      tenant_id: "primary",
      id: "alice",
      email: "alice@example.test",
      stripe_id: "cus_alice",
    },
    {
      tenant_id: "primary",
      id: "bob",
      email: "bob@example.test",
      stripe_id: "cus_bob",
    },
  ]);
});
async function login() {
  await app.inject({
    method: "POST",
    url: "/api/v1/tenants/primary/auth/request",
    headers: { origin: config.origin },
    payload: { email: "alice@example.test" },
  });
  const email = await db("emails").where({ kind: "login" }).first();
  const message = unseal<Message>(email.payload, config.secret);
  const token = /#login=([A-Za-z0-9_-]+)/.exec(message.text)![1]!;
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/tenants/primary/auth/consume",
    headers: { origin: config.origin },
    payload: { token },
  });
  assert.equal(response.statusCode, 200);
  const cookie = response.headers["set-cookie"]!.toString().split(";")[0]!;
  const me = await app.inject({
    url: "/api/v1/tenants/primary/me",
    headers: { cookie },
  });
  return { token, cookie, csrf: me.json().csrfToken as string };
}
test("single use email links create server sessions; replay, expiration and CSRF denied", async () => {
  const { token, cookie, csrf } = await login();
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/tenants/primary/auth/consume",
        headers: { origin: config.origin },
        payload: { token },
      })
    ).statusCode,
    401,
  );
  assert.ok(
    await db("sessions")
      .where({ id: hash(cookie.split("=")[1]!) })
      .first(),
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/tenants/primary/auth/logout",
        headers: { cookie },
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/tenants/primary/auth/logout",
        headers: {
          cookie,
          origin: "https://attacker.test",
          "x-csrf-token": csrf,
        },
        payload: {},
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/tenants/primary/auth/logout",
        headers: { cookie, origin: config.origin, "x-csrf-token": csrf },
        payload: {},
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        url: "/api/v1/tenants/primary/me",
        headers: { cookie },
      })
    ).statusCode,
    401,
  );
  await db("login_tokens").insert({
    tenant_id: "primary",
    id: hash("expired-token"),
    customer_id: "alice",
    expires_at: 1,
  });
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/tenants/primary/auth/consume",
        headers: { origin: config.origin },
        payload: { token: "expired-token" },
      })
    ).statusCode,
    401,
  );
});
test("customer ownership, operator authentication and server-controlled checkout mappings", async () => {
  const { cookie, csrf } = await login();
  for (const url of [
    "/api/v1/tenants/primary/licenses/foreign/key",
    "/api/v1/tenants/primary/installations/foreign/deactivate",
  ]) {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { cookie, origin: config.origin, "x-csrf-token": csrf },
          payload: {},
        })
      ).statusCode,
      404,
    );
  }
  assert.equal(
    (await app.inject({ url: "/api/v1/tenants/primary/seller/overview" }))
      .statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/tenants/primary/checkout",
        payload: {
          planId: "unknown",
          email: "alice@example.test",
          priceId: "attacker",
        },
      })
    ).statusCode,
    400,
  );
});
test("webhook raw signature verification, durable receipt, duplicate handling and retries", async () => {
  const payload = JSON.stringify({
    id: "evt_test",
    account: "acct_primary",
    livemode: false,
    object: "event",
    type: "customer.subscription.updated",
    data: { object: { id: "sub_local" } },
  });
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/stripe/connect-webhook",
        headers: {
          "content-type": "application/json",
          "stripe-signature": "invalid",
        },
        payload,
      })
    ).statusCode,
    400,
  );
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: config.stripeConnectWebhookSecret,
  });
  for (let i = 0; i < 3; i++)
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/stripe/connect-webhook",
          headers: {
            "content-type": "application/json",
            "stripe-signature": signature,
          },
          payload,
        })
      ).statusCode,
      200,
    );
  assert.equal((await db("billing_events")).length, 1);
  assert.equal((await db("work")).length, 1);
});
test("single deployment serves built customer assets", async () => {
  const response = await app.inject({ url: "/" });
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /Double Entitle/);
});
test("operator publishes private ZIP; cached package URL has no expiry and current access always wins", async () => {
  const auth = { authorization: `Bearer ${testTenantKey}` };
  const created = await app.inject({
    method: "POST",
    url: "/api/v1/tenants/primary/seller/products",
    headers: auth,
    payload: {
      slug: "example-pro",
      name: "Example Pro",
      plans: [{ name: "One", siteAllowance: 1, priceId: "price_one" }],
    },
  });
  assert.equal(created.statusCode, 200);
  const { product, plans } = created.json();
  const license = {
    tenant_id: "primary",
    id: "license-alice",
    customer_id: "alice",
    product_id: product.id,
    plan_id: plans[0].id,
    site_allowance: 1,
    paid_through: Date.now() + 86400000,
    billing_status: "active",
    subscription_id: "sub_alice",
    key_hash: hash("DE-example-key"),
  };
  await db("licenses").insert(license);
  await db("licenses").insert({
    ...license,
    id: "license-bob",
    customer_id: "bob",
    subscription_id: "sub_bob",
    key_hash: hash("DE-bob-key"),
  });
  await mkdir(`${root}/example-pro`, { recursive: true });
  await writeFile(
    `${root}/example-pro/example-pro.php`,
    "<?php\n/*\nPlugin Name: Example\nVersion: 1.0.0\n*/",
  );
  execFileSync(
    "zip",
    ["-q", `${root}/release.zip`, "example-pro/example-pro.php"],
    {
      cwd: root,
    },
  );
  const { readFile } = await import("node:fs/promises");
  const bytes = await readFile(`${root}/release.zip`);
  const upload = await app.inject({
    method: "POST",
    url: "/api/v1/tenants/primary/seller/releases/example-pro/1.0.0",
    headers: {
      ...auth,
      "content-type": "application/zip",
      "x-release-metadata": Buffer.from(
        JSON.stringify({
          changelog: "First",
          minWp: "6.0",
          minPhp: "8.0",
          minFree: "0.0.0",
          tested: "7.0",
        }),
      ).toString("base64url"),
    },
    payload: bytes,
  });
  assert.equal(upload.statusCode, 200, upload.body);
  const release = upload.json();
  const activation = await app.inject({
    method: "POST",
    url: "/api/v1/tenants/primary/activate",
    payload: {
      key: "DE-example-key",
      installationId: "stable-id",
      siteUrl: "https://example.test",
      product: "example-pro",
    },
  });
  assert.equal(activation.statusCode, 200);
  const token = activation.json().token;
  const headers = { authorization: `Bearer ${token}` };
  const metadata = await app.inject({
    url: "/api/v1/tenants/primary/updates/example-pro",
    headers,
  });
  assert.equal(metadata.statusCode, 200);
  const url = new URL(metadata.json().download_url);
  assert.equal(url.search, "");
  assert.ok(!url.href.includes(token));
  assert.equal(
    (await app.inject({ url: "/artifacts/" + release.id + ".zip" })).statusCode,
    404,
  );
  assert.equal((await app.inject({ url: url.pathname })).statusCode, 401);
  assert.deepEqual(
    (await app.inject({ url: url.pathname, headers })).rawPayload,
    bytes,
  );
  // A delayed request reuses the exact cached package path, without a storage TTL.
  assert.equal(
    (await app.inject({ url: url.pathname, headers })).statusCode,
    200,
  );
  const { cookie, csrf } = await login();
  const sessionHeaders = {
    cookie,
    origin: config.origin,
    "x-csrf-token": csrf,
  };
  const me = await app.inject({
    url: "/api/v1/tenants/primary/me",
    headers: { cookie },
  });
  assert.equal(me.json().licenses.length, 1);
  assert.equal(
    (
      await app.inject({
        url: `/api/v1/tenants/primary/licenses/license-bob/releases/${release.id}/download`,
        headers: { cookie },
      })
    ).statusCode,
    404,
  );
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: "/api/v1/tenants/primary/licenses/license-bob/key",
        headers: sessionHeaders,
        payload: {},
      })
    ).statusCode,
    404,
  );
  for (const patch of [
    { paid_through: 1 },
    { revoked: 1 },
    { suspended: 1 },
    { refund_revoked: 1 },
  ]) {
    await db("licenses")
      .where({ id: license.id })
      .update({ ...patch });
    assert.equal(
      (await app.inject({ url: url.pathname, headers })).statusCode,
      403,
    );
    await db("licenses").where({ id: license.id }).update({
      paid_through: license.paid_through,
      revoked: 0,
      suspended: 0,
      refund_revoked: 0,
    });
  }
  const licensing = new Licenses(db, config.secret, [], primaryTenant);
  const bob = await licensing.activate(
    "DE-bob-key",
    "bob-install",
    "https://bob.test",
    "example-pro",
  );
  const foreignInstall = await db("installations")
    .where({ license_id: "license-bob" })
    .first();
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/tenants/primary/installations/${foreignInstall.id}/deactivate`,
        headers: sessionHeaders,
        payload: {},
      })
    ).statusCode,
    404,
  );
  assert.equal((await licensing.status(bob.token)).entitled, true);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: `/api/v1/tenants/primary/seller/releases/${release.id}/withdraw`,
        headers: auth,
        payload: {},
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ url: url.pathname, headers })).statusCode,
    404,
  );
  assert.equal(
    (await store.get("primary", release.id, release.checksum, release.size))
      .length,
    bytes.length,
  );
});
test("authentication requests are rate limited with consistent errors", async () => {
  const statuses = [];
  for (let i = 0; i < 8; i++) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/tenants/primary/auth/request",
      headers: { origin: config.origin },
      payload: { email: "unknown@example.test" },
    });
    statuses.push(response.statusCode);
    if (response.statusCode === 429) {
      assert.equal(response.json().error.code, "rate_limited");
      assert.ok(response.json().error.requestId);
    }
  }
  assert.ok(statuses.includes(429));
});

async function seedTenantKey(database: import("../src/db.ts").DB) {
  await database("tenant_api_keys").insert({
    id: "regression-key",
    tenant_id: "primary",
    name: "Regression key",
    key_hash: hash(testTenantKey),
    created_at: Date.now(),
    revoked_at: null,
    scopes: JSON.stringify([
      "read",
      "catalog:write",
      "releases:write",
      "licenses:write",
      "billing:reconcile",
    ]),
    expires_at: Date.now() + 86400000,
    last_used_at: null,
    display_prefix: testTenantKey.slice(0, 14),
  });
}
