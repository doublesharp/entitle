import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { featureEntitlements } from "../src/plan-features.ts";
import { primaryTenant } from "./helpers/tenant.ts";

test("feature entitlements keep core available and grant advanced local or paid hosted features", async () => {
  const module = await import("../src/plan-features.ts").catch(() => undefined);
  assert.ok(module?.featureEntitlements, "featureEntitlements is required");
  const config = loadConfig({
    APP_SECRET: "11".repeat(32),
    OPERATOR_TOKEN: "x".repeat(32),
  });
  const tenant = {
    ...primaryTenant,
    exempt: 0,
    pro_paid_through: 200,
    pro_period_start: 100,
  };
  const core = {
    licensing: true,
    security: true,
    recovery: true,
    tax: true,
    export: true,
  };
  assert.deepEqual(
    module.featureEntitlements(config, { ...tenant, suspended: 1 }, 150),
    {
      ...core,
      outboundWebhooks: true,
      advancedReports: true,
      automations: true,
    },
  );
  config.deploymentMode = "hosted";
  for (const candidate of [
    tenant,
    { ...tenant, billing_status: "canceled" },
    { ...tenant, billing_status: "past_due" },
  ])
    assert.deepEqual(module.featureEntitlements(config, candidate, 150), {
      ...core,
      outboundWebhooks: true,
      advancedReports: true,
      automations: true,
    });
  for (const candidate of [
    { ...tenant, pro_paid_through: 150 },
    { ...tenant, pro_period_start: 151 },
    { ...tenant, suspended: 1 },
    { ...primaryTenant, exempt: 0 },
  ])
    assert.deepEqual(module.featureEntitlements(config, candidate, 150), {
      ...core,
      outboundWebhooks: false,
      advancedReports: false,
      automations: false,
    });
  assert.equal(
    module.featureEntitlements(
      config,
      { ...tenant, exempt: 1, pro_paid_through: 0 },
      150,
    ).automations,
    false,
  );
});

test("N1 business event retention uses bounded grace without enabling hosted Pro access", async () => {
  const { businessEventPolicy } = await import("../src/plan-features.ts");
  const config = loadConfig({
    DEPLOYMENT_MODE: "hosted",
    APP_SECRET: "11".repeat(32),
    OPERATOR_TOKEN: "x".repeat(32),
    GRACE_DAYS: "1",
  });
  const tenant = {
    ...primaryTenant,
    suspended: 0,
    pro_period_start: 50,
    pro_paid_through: 100,
  };
  const policy = businessEventPolicy(config, tenant, 110);
  assert.equal(policy.enabled, false);
  assert.equal(policy.enabledSince, 50);
  assert.deepEqual(policy.pendingGrace, {
    paidThrough: 100,
    retainUntil: 86400100,
  });
  assert.equal(
    featureEntitlements(config, tenant, 110).outboundWebhooks,
    false,
  );
  for (const candidate of [
    { ...tenant, pro_paid_through: 0 },
    { ...tenant, suspended: 1 },
    { ...primaryTenant, exempt: 0 },
  ])
    assert.equal(
      businessEventPolicy(config, candidate, 110).pendingGrace,
      undefined,
    );
  assert.equal(
    businessEventPolicy(config, tenant, 86400100).pendingGrace,
    undefined,
  );
  config.graceDays = 0;
  assert.equal(
    businessEventPolicy(config, tenant, 110).pendingGrace,
    undefined,
  );
  delete config.graceDays;
  assert.equal(
    businessEventPolicy(config, tenant, 110).pendingGrace?.retainUntil,
    604800100,
  );
  assert.equal(businessEventPolicy(config, tenant, 75).enabled, true);
  config.deploymentMode = "standalone";
  assert.deepEqual(businessEventPolicy(config, tenant, 110), {
    enabled: true,
    enabledSince: 0,
    pendingGrace: undefined,
  });
});
