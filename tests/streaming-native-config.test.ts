import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
const credentials = {
  APP_SECRET: "01".repeat(32),
  OPERATOR_TOKEN: "operator-".repeat(5),
};
test("native limits and disk budgets are separate from WordPress memory caps", () => {
  const config = loadConfig(credentials);
  assert.equal(config.maxNativeUploadBytes, 100 * 1024 ** 2);
  assert.equal(config.maxUploadBytes, 25 * 1024 ** 2);
  assert.equal(config.nativeSpoolBytes, 4096 * 1024 ** 2);
  assert.equal(config.artifactCacheBytes, 4096 * 1024 ** 2);
  assert.equal(config.artifactCacheInflightBytes, 2048 * 1024 ** 2);
  assert.equal(
    loadConfig({ ...credentials, MAX_NATIVE_UPLOAD_MIB: "2048" })
      .maxNativeUploadBytes,
    2048 * 1024 ** 2,
  );
  for (const values of [
    { MAX_NATIVE_UPLOAD_MIB: "2049" },
    { MAX_NATIVE_UPLOAD_MIB: "0" },
    { MAX_NATIVE_UPLOAD_MIB: "1.5" },
    { MAX_NATIVE_UPLOAD_MIB: "NaN" },
    { NATIVE_SPOOL_MIB: "199" },
    { ARTIFACT_CACHE_MIB: "100" },
    { ARTIFACT_CACHE_INFLIGHT_MIB: "99" },
    { NATIVE_UPLOAD_TIMEOUT_MS: "3600001" },
    { ARTIFACT_CACHE_TTL_MS: "86400001" },
    { MIN_DISK_FREE_MIB: "-1" },
  ])
    assert.throws(() => loadConfig({ ...credentials, ...values }));
});

test("standalone merchant identity accepts only an explicit operator account ID", () => {
  assert.equal(
    loadConfig({
      ...credentials,
      STANDALONE_STRIPE_ACCOUNT_ID: "acct_merchant1",
    }).standaloneStripeAccountId,
    "acct_merchant1",
  );
  for (const value of ["", "acct_bad_id", "https://stripe.com", "merchant"])
    assert.throws(() =>
      loadConfig({ ...credentials, STANDALONE_STRIPE_ACCOUNT_ID: value }),
    );
});
test("existing hosted Pro, sandbox credential, outbound host, and standalone production validation stays strict", () => {
  const full = {
    ...credentials,
    DEPLOYMENT_MODE: "hosted",
    PLATFORM_PRO_STRIPE_PRICE_ID: "price_pro",
    PLATFORM_STRIPE_PRICE_ID: "price_base",
    STRIPE_TEST_SECRET_KEY: "sk_test_fixture",
    STRIPE_TEST_PUBLISHABLE_KEY: "pk_test_fixture",
    STRIPE_TEST_WEBHOOK_SECRET: "whsec_fixture",
    OUTBOUND_WEBHOOK_HOSTS: " Updates.Example.com, ,api.example.com",
  };
  const config = loadConfig(full);
  assert.equal(config.platformProStripePriceId, "price_pro");
  assert.equal(config.stripeTestSecret, "sk_test_fixture");
  assert.deepEqual(config.outboundWebhookHosts, [
    "updates.example.com",
    "api.example.com",
  ]);
  for (const values of [
    { PLATFORM_PRO_STRIPE_PRICE_ID: "bad" },
    { PLATFORM_PRO_STRIPE_PRICE_ID: "price_base" },
    { STRIPE_TEST_SECRET_KEY: "sk_live_bad" },
    { STRIPE_TEST_PUBLISHABLE_KEY: "bad" },
    { STRIPE_TEST_WEBHOOK_SECRET: "bad" },
    { OUTBOUND_WEBHOOK_HOSTS: "localhost" },
    { OUTBOUND_WEBHOOK_HOSTS: "*.example.com" },
  ])
    assert.throws(() => loadConfig({ ...full, ...values }));
  assert.throws(() =>
    loadConfig({
      ...credentials,
      STRIPE_TEST_PUBLISHABLE_KEY: "pk_test_partial",
    }),
  );
  assert.equal(
    loadConfig({ ...credentials, STANDALONE_OWNER_EMAIL: "OWNER@EXAMPLE.COM" })
      .standaloneOwnerEmail,
    "owner@example.com",
  );
  assert.throws(() =>
    loadConfig({ ...credentials, HOSTED_APPLICATION_FEE_PERCENT: "101" }),
  );
  assert.throws(() =>
    loadConfig({ ...credentials, HOSTED_APPLICATION_FEE_PERCENT: "1" }),
  );
  const production = {
    ...credentials,
    NODE_ENV: "production",
    PUBLIC_ORIGIN: "https://licenses.example.com",
    STRIPE_SECRET_KEY: "sk_test_fixture",
    STRIPE_WEBHOOK_SECRET: "whsec_fixture",
    STRIPE_PUBLISHABLE_KEY: "pk_test_fixture",
    SMTP_HOST: "smtp.example.com",
    TRUST_PROXY: "127.0.0.1",
    MAIL_FROM: "licenses@example.com",
    S3_BUCKET: "private-fixture",
    S3_REGION: "us-east-1",
    STANDALONE_OWNER_EMAIL: "owner@example.com",
  };
  assert.equal(loadConfig(production).deploymentMode, "standalone");
  assert.throws(() =>
    loadConfig({ ...production, STANDALONE_OWNER_EMAIL: "" }),
  );
  assert.throws(() =>
    loadConfig({ ...production, STRIPE_PUBLISHABLE_KEY: "" }),
  );
});

test('cache configuration reserves room for a replacement generation during active TTL refresh',()=>{
 assert.throws(()=>loadConfig({...credentials,MAX_NATIVE_UPLOAD_MIB:'100',ARTIFACT_CACHE_MIB:'100',ARTIFACT_CACHE_INFLIGHT_MIB:'100'}));
 assert.equal(loadConfig({...credentials,MAX_NATIVE_UPLOAD_MIB:'100',ARTIFACT_CACHE_MIB:'200',ARTIFACT_CACHE_INFLIGHT_MIB:'100'}).artifactCacheBytes,200*1024**2);
});
