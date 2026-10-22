import type { Config } from "./config.ts";
import type { Tenant } from "./db.ts";

export type ProTenant = Tenant & {
  pro_paid_through?: number;
  pro_period_start?: number;
};

// Capacity exemptions, trials, grace and provider status do not confer Pro.
// Standalone features are local and never require a grant. Sandbox callers
// resolve this against the parent tenant, not the exempt child capacity row.
export function featureEntitlements(
  config: Config,
  tenant: ProTenant,
  now = Date.now(),
) {
  const advanced =
    config.deploymentMode === "standalone" ||
    (!tenant.suspended &&
      (tenant.pro_period_start ?? 0) <= now &&
      (tenant.pro_paid_through ?? 0) > now);
  return {
    licensing: true,
    security: true,
    recovery: true,
    tax: true,
    export: true,
    outboundWebhooks: advanced,
    advancedReports: advanced,
    automations: advanced,
  };
}

// Retention is independent of access. Only the latest nonrevoked contiguous
// paid interval can hold unqualified events through a bounded renewal delay.
export function businessEventPolicy(
  config: Config,
  tenant: ProTenant,
  now = Date.now(),
) {
  const enabled = featureEntitlements(config, tenant, now).outboundWebhooks;
  const enabledSince =
    config.deploymentMode === "standalone"
      ? 0
      : Number(tenant.pro_period_start ?? 0);
  const paidThrough = Number(tenant.pro_paid_through ?? 0);
  const retainUntil = paidThrough + (config.graceDays ?? 7) * 86400000;
  const pendingGrace =
    config.deploymentMode === "hosted" &&
    !tenant.suspended &&
    paidThrough > enabledSince &&
    now >= paidThrough &&
    now < retainUntil
      ? { paidThrough, retainUntil }
      : undefined;
  return { enabled, enabledSince, pendingGrace };
}
