import { randomUUID } from "node:crypto";
import type { DB, Tenant, Tx } from "./db.ts";
import { createTenant, lock } from "./db.ts";
import type { Config } from "./config.ts";
import type { SellerSession } from "./platform-auth.ts";
import { hash, random } from "./crypto.ts";
import { check } from "./errors.ts";

export const tenantApiKeyScopes = [
  "read",
  "catalog:write",
  "releases:write",
  "licenses:write",
  "billing:reconcile",
  "operations:write",
  "data:export",
] as const;
type TenantConfig = Config & {
  trialDays?: number;
  maxTenantsPerSeller?: number;
  trialStorageBytes?: number;
};
const reservedSlugs = new Set([
  "primary",
  "admin",
  "api",
  "operator",
  "platform",
  "seller",
  "stripe",
  "wordpress",
  "support",
  "double-entitle",
]);

export type TenantOperation = "capacity" | "buyer" | "recovery" | "reconcile";
export function tenantAvailable(
  tenant: Tenant,
  operation: TenantOperation,
  graceMs = 7 * 86400000,
  now = Date.now(),
): boolean {
  if (tenant.suspended) return false;
  if (operation !== "capacity" || tenant.exempt) return true;
  return Math.max(tenant.trial_ends_at, tenant.paid_through + graceMs) > now;
}

export class Tenants {
  db: DB;
  config: TenantConfig;
  constructor(db: DB, config: TenantConfig) {
    this.db = db;
    this.config = config;
  }
  private async session(tx: Tx, seller: SellerSession) {
    const session = await tx("seller_sessions")
      .where({ id: seller.sessionHash, user_id: seller.user.id })
      .andWhere("expires_at", ">", Date.now())
      .first();
    const user = await tx("seller_users")
      .where({ id: seller.user.id })
      .whereNotNull("verified_at")
      .first();
    check(
      session && user,
      401,
      "seller_login_required",
      "An active verified seller session is required.",
    );
    return user;
  }
  private async owner(tx: Tx, seller: SellerSession, tenantId: string) {
    await this.session(tx, seller);
    const membership = await tx("seller_memberships")
      .where({ tenant_id: tenantId, user_id: seller.user.id, role: "owner" })
      .first();
    check(membership, 403, "tenant_denied", "You do not own this tenant.");
  }
  private async audit(
    tx: Tx,
    seller: SellerSession,
    tenantId: string,
    action: string,
    details: Record<string, string> = {},
  ) {
    await tx("audit_events").insert({
      id: randomUUID(),
      tenant_id: tenantId,
      actor_type: "seller",
      actor_id: seller.user.id,
      action,
      details: JSON.stringify(details),
      created_at: Date.now(),
    });
  }
  async list(userId: string): Promise<Tenant[]> {
    return this.db<Tenant>("tenants")
      .join("seller_memberships", "seller_memberships.tenant_id", "tenants.id")
      .where({
        "seller_memberships.user_id": userId,
        "seller_memberships.role": "owner",
      })
      .select("tenants.*")
      .orderBy("tenants.created_at");
  }
  async create(
    seller: SellerSession,
    input: { slug: string; name: string },
  ): Promise<Tenant> {
    check(
      this.config.deploymentMode === "hosted",
      404,
      "not_found",
      "Tenant creation is unavailable in standalone mode.",
    );
    const slug = input.slug;
    const name = input.name.trim();
    check(
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug) &&
        name.length > 0 &&
        name.length <= 200,
      400,
      "invalid_tenant",
      "Choose a lowercase tenant slug and a name of at most 200 characters.",
    );
    check(
      !reservedSlugs.has(slug),
      400,
      "reserved_tenant",
      "That tenant namespace is reserved for the platform.",
    );
    return this.db.transaction(async (tx) => {
      await lock(tx, "schema");
      const user = await this.session(tx, seller);
      check(
        !(await tx("tenants").where({ slug }).first()),
        409,
        "tenant_exists",
        "That tenant namespace is already registered.",
      );
      const membershipCount = await tx("seller_memberships")
        .where({ user_id: user.id, role: "owner" })
        .whereNotIn(
          "tenant_id",
          tx("publisher_sandboxes").select("sandbox_tenant_id"),
        )
        .count({ total: "tenant_id" })
        .first();
      check(
        Number(membershipCount!.total) < (this.config.maxTenantsPerSeller ?? 3),
        403,
        "tenant_limit",
        "Your seller account has reached its tenant limit. Contact the platform operator.",
      );
      const tenant = await createTenant(tx, {
        id: randomUUID(),
        slug,
        name,
        trial_ends_at:
          Number(user.verified_at) + (this.config.trialDays ?? 14) * 86400000,
        max_products: 3,
        max_storage_bytes: this.config.trialStorageBytes ?? 100 * 1024 * 1024,
      });
      await tx("seller_memberships").insert({
        tenant_id: tenant.id,
        user_id: seller.user.id,
        role: "owner",
        created_at: Date.now(),
      });
      await this.audit(tx, seller, tenant.id, "tenant.created");
      await this.audit(tx, seller, tenant.id, "membership.created");
      return tenant;
    });
  }
  async keys(seller: SellerSession, tenantId: string) {
    await this.owner(this.db, seller, tenantId);
    return this.db("tenant_api_keys")
      .where({ tenant_id: tenantId })
      .select(
        "id",
        "name",
        "created_at",
        "revoked_at",
        "scopes",
        "expires_at",
        "last_used_at",
        "display_prefix",
      )
      .orderBy("created_at");
  }
  async createKey(
    seller: SellerSession,
    tenantId: string,
    name: string,
    options: { scopes?: string[]; expiresInDays?: number } = {},
  ) {
    name = name.trim();
    check(
      name.length > 0 && name.length <= 150,
      400,
      "invalid_key_name",
      "Give this key a name of at most 150 characters.",
    );
    const scopes = [...new Set(options.scopes ?? ["read", "releases:write"])];
    const days = options.expiresInDays ?? 90;
    check(
      scopes.length > 0 &&
        scopes.every((scope) =>
          tenantApiKeyScopes.includes(
            scope as (typeof tenantApiKeyScopes)[number],
          ),
        ) &&
        Number.isInteger(days) &&
        days >= 1 &&
        days <= 365,
      400,
      "invalid_key_policy",
      "Choose valid API key scopes and an expiration between 1 and 365 days.",
    );
    const token = `DE-TK-${random()}`;
    const id = randomUUID();
    const created_at = Date.now();
    const expires_at = created_at + days * 86400000;
    const display_prefix = token.slice(0, 14);
    await this.db.transaction(async (tx) => {
      await lock(tx, "auth");
      await this.owner(tx, seller, tenantId);
      await tx("tenant_api_keys").insert({
        id,
        tenant_id: tenantId,
        name,
        key_hash: hash(token),
        created_at,
        revoked_at: null,
        scopes: JSON.stringify(scopes),
        expires_at,
        last_used_at: null,
        display_prefix,
      });
      await this.audit(tx, seller, tenantId, "api_key.created", { key_id: id });
    });
    return { id, name, token, scopes, expires_at, display_prefix };
  }
  async revokeKey(seller: SellerSession, tenantId: string, keyId: string) {
    await this.db.transaction(async (tx) => {
      await lock(tx, "auth");
      await this.owner(tx, seller, tenantId);
      const key = await tx("tenant_api_keys")
        .where({ id: keyId, tenant_id: tenantId })
        .first();
      check(key, 404, "key_not_found", "API key was not found.");
      if (key.revoked_at !== null) return;
      await tx("tenant_api_keys")
        .where({ id: keyId, tenant_id: tenantId })
        .update({ revoked_at: Date.now() });
      await this.audit(tx, seller, tenantId, "api_key.revoked", {
        key_id: keyId,
      });
    });
  }
}
