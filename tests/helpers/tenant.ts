import type { Tenant } from "../../src/db.ts";

// Explicit bootstrap merchant used by the pre-SaaS regression scenarios.
export const primaryTenant: Tenant = {
  id: "primary",
  slug: "primary",
  name: "Primary",
  stripe_account_id: "acct_primary",
  stripe_status: "connected",
  platform_customer_id: null,
  platform_subscription_id: null,
  billing_status: "trial",
  paid_through: 0,
  trial_ends_at: 0,
  exempt: 1,
  suspended: 0,
  max_products: 20,
  max_storage_bytes: 1024 ** 3,
  created_at: 0,
};

export const testTenantKey =
  "DE-TK-regression-tenant-primary-distinct-from-operator";
