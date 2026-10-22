import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import Stripe from "stripe";
import { loadConfig } from "../src/config.ts";
import { buildApp } from "../src/app.ts";
import { createTenant, migrate, type Tenant } from "../src/db.ts";
import { hash, unseal } from "../src/crypto.ts";
import type { Message } from "../src/email.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import { isolatedDatabase } from "./helpers/database.ts";

const credentials = { APP_SECRET: "11".repeat(32), OPERATOR_TOKEN: "x".repeat(32) };
test("standalone is the default and only hosted deployments collect the configured fee", () => {
  const standalone = loadConfig(credentials);
  assert.equal(standalone.deploymentMode, "standalone");
  assert.equal(standalone.hostedApplicationFeePercent, 0);
  const hosted = loadConfig({ ...credentials, DEPLOYMENT_MODE: "hosted" });
  assert.equal(hosted.hostedApplicationFeePercent, 1);
  assert.equal(loadConfig({ ...credentials, DEPLOYMENT_MODE: "hosted", HOSTED_APPLICATION_FEE_PERCENT: "0.75" }).hostedApplicationFeePercent, 0.75);
  for (const value of ["-1", "100.01", "1.001", "NaN", "Infinity", "", " "])
    assert.throws(() => loadConfig({ ...credentials, DEPLOYMENT_MODE: "hosted", HOSTED_APPLICATION_FEE_PERCENT: value }));
  assert.throws(() => loadConfig({ ...credentials, DEPLOYMENT_MODE: "typo" }));
  assert.throws(() => loadConfig({ ...credentials, HOSTED_APPLICATION_FEE_PERCENT: "1" }), /standalone/i);
  assert.equal(loadConfig({ ...credentials, HOSTED_APPLICATION_FEE_PERCENT: "0" }).hostedApplicationFeePercent, 0);
  assert.throws(() => loadConfig({ ...credentials, STANDALONE_OWNER_EMAIL: "invalid" }));
});

test("production standalone uses merchant credentials without Connect or a platform price", () => {
  const config = {
    ...credentials, NODE_ENV: "production", PUBLIC_ORIGIN: "https://license.example.com",
    STRIPE_SECRET_KEY: "sk_live_fixture", STRIPE_LIVE_MODE: "true", STRIPE_WEBHOOK_SECRET: "whsec_merchant",
    STRIPE_PUBLISHABLE_KEY: "pk_live_fixture", STANDALONE_OWNER_EMAIL: "Owner@Example.com",
    SMTP_HOST: "smtp.example.com", MAIL_FROM: "licensing@example.com", TRUST_PROXY: "172.30.81.2",
    S3_BUCKET: "private", S3_REGION: "us-east-1",
  };
  assert.equal(loadConfig(config).standaloneOwnerEmail, "owner@example.com");
  assert.throws(() => loadConfig({ ...config, STANDALONE_OWNER_EMAIL: "" }), /STANDALONE_OWNER_EMAIL/);
  assert.throws(() => loadConfig({ ...config, STRIPE_PUBLISHABLE_KEY: "" }), /publishable/i);
});

async function fixture(t: TestContext, setup?: (db: Awaited<ReturnType<typeof isolatedDatabase>>["db"]) => Promise<void>) {
  const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/deployment-modes-");
  const config = loadConfig({ ...credentials, DATA_DIR: root, WEB_DIR: `${root}/web`, LOCAL_BILLING: "true", STANDALONE_OWNER_EMAIL: "owner@example.test" });
  const database = await isolatedDatabase(config.databaseUrl);
  t.after(async () => { await database.close(); await rm(root, { recursive: true, force: true }); });
  await migrate(database.db);
  await setup?.(database.db);
  const app = await buildApp(config, database.db, { send: async () => {} }, { store: new InMemoryArtifactStore() });
  t.after(() => app.close());
  const post = (url: string, payload: object = {}, cookie = "", csrfToken = "") => app.inject({ method: "POST", url, payload, headers: { origin: config.origin, cookie, "x-csrf-token": csrfToken } });
  return { app, db: database.db, config, post };
}

test("standalone admits only the configured verified owner and provisions primary membership", async t => {
  const { app, db, config, post } = await fixture(t);
  assert.equal((await post("/api/v1/platform/auth/request", { email: "outsider@example.test" })).statusCode, 200);
  assert.equal((await db("seller_users")).length, 0);
  const requested = await post("/api/v1/platform/auth/request", { email: "OWNER@example.test" });
  const preauth = requested.cookies.map(c => `${c.name}=${c.value}`).join("; ");
  const message = unseal<Message>((await db("platform_emails").first()).payload, config.secret);
  const token = /seller-login=([A-Za-z0-9_-]+)/.exec(message.text)![1]!;
  const signed = await post("/api/v1/platform/auth/consume", { token }, preauth);
  assert.equal(signed.statusCode, 200, signed.body);
  const cookie = signed.cookies.map(c => `${c.name}=${c.value}`).join("; ");
  const me = (await app.inject({ url: "/api/v1/platform/me", headers: { cookie } })).json();
  assert.deepEqual(me.tenants.map((item: Tenant) => item.id), ["primary"]);
  assert.equal((await post("/api/v1/platform/tenants", { slug: "second", name: "Second" }, cookie, me.csrfToken)).statusCode, 404);
  for (const path of ["stripe/connect", "platform/checkout", "platform/portal"])
    assert.equal((await post(`/api/v1/tenants/primary/seller/${path}`, {}, cookie, me.csrfToken)).statusCode, 404);
  const overview = await app.inject({ url: "/api/v1/tenants/primary/seller/overview", headers: { cookie } });
  assert.equal(overview.statusCode, 200, overview.body);
  const info = (await app.inject({ url: "/api/v1/platform/info" })).json();
  assert.equal(info.deploymentMode, "standalone");
  assert.equal(info.applicationFeePercent, 0);
  assert.equal((await post("/api/v1/platform/auth/consume", { token }, preauth)).statusCode, 401);
  await db("seller_users").insert({ id: "outsider", email: "outsider@example.test", verified_at: Date.now(), created_at: Date.now() });
  await db("seller_sessions").insert({ id: hash("old-session"), user_id: "outsider", expires_at: Date.now() + 100000 });
  const old = await app.inject({ url: "/api/v1/platform/me", headers: { cookie: "de-seller-session=old-session" } });
  assert.equal(old.statusCode, 401);
  assert.equal((await app.inject({ url: "/api/v1/platform/stripe/callback" })).statusCode, 404);
  await (app as typeof app & { tick: () => Promise<void> }).tick();
});

test("standalone rejects stale owner login tokens and cannot bootstrap an unconfigured owner", async t => {
  const { db, config, post } = await fixture(t);
  config.standaloneOwnerEmail = "";
  await post("/api/v1/platform/auth/request", { email: "owner@example.test" });
  assert.equal((await db("seller_users")).length, 0);
  config.standaloneOwnerEmail = "owner@example.test";
  const requested = await post("/api/v1/platform/auth/request", { email: "owner@example.test" });
  const cookie = requested.cookies.map(c => `${c.name}=${c.value}`).join("; ");
  const message = unseal<Message>((await db("platform_emails").first()).payload, config.secret);
  const token = /seller-login=([A-Za-z0-9_-]+)/.exec(message.text)![1]!;
  config.standaloneOwnerEmail = "different@example.test";
  assert.equal((await post("/api/v1/platform/auth/consume", { token }, cookie)).statusCode, 401);
  assert.equal((await db("seller_memberships")).length, 0);
});

test("standalone refuses a multitenant or connected database without changing its records", async t => {
  const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/deployment-refuse-");
  const config = loadConfig({ ...credentials, DATA_DIR: root });
  const database = await isolatedDatabase(config.databaseUrl), db = database.db;
  t.after(async () => { await database.close(); await rm(root, { recursive: true, force: true }); });
  await migrate(db);
  const open = () => buildApp(config, db, { send: async () => {} }, { store: new InMemoryArtifactStore() });
  await createTenant(db, { id: "other", slug: "other", name: "Other" });
  await assert.rejects(open(), /standalone.*database/i);
  assert.equal((await db("tenants")).length, 2);
  await db("tenants").where({ id: "other" }).delete();
  for (const field of ["stripe_account_id", "platform_customer_id", "platform_subscription_id"]) {
    await db("tenants").where({ id: "primary" }).update({ [field]: "existing" });
    await assert.rejects(open(), /standalone.*database/i);
    assert.equal((await db("tenants").where({ id: "primary" }).first())[field], "existing");
    await db("tenants").where({ id: "primary" }).update({ [field]: null });
  }
});

test("standalone merchant webhook routes verified events to primary and rejects connected scope", async t => {
  const { app, config, db } = await fixture(t);
  const stripe = new Stripe("sk_test_fixture");
  async function event(path: string, account?: string, livemode = false) {
    const body = JSON.stringify({ id: `evt_${path}_${account}_${livemode}`, type: "customer.subscription.updated", livemode, ...(account ? { account } : {}), data: { object: { id: "sub_merchant" } } });
    return app.inject({ method: "POST", url: `/api/v1/stripe/${path}`, payload: body, headers: { "content-type": "application/json", "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload: body, secret: config.stripeWebhookSecret }) } });
  }
  assert.equal((await event("merchant-webhook")).statusCode, 200);
  assert.equal((await db("billing_events").first()).tenant_id, "primary");
  assert.equal((await event("merchant-webhook", "acct_other")).statusCode, 400);
  assert.equal((await event("merchant-webhook", undefined, true)).json().ignored, true);
  for (const path of ["platform-webhook", "connect-webhook"]) assert.equal((await event(path)).statusCode, 404);
  await createTenant(db, { id: "injected", slug: "injected", name: "Injected" });
  assert.equal((await app.inject({ url: "/api/v1/tenants/injected/catalog" })).statusCode, 404);
});
