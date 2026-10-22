import { randomUUID } from "node:crypto";
import type { Knex } from "knex";
import { lock, type DB, type License } from "./db.ts";
import { hash } from "./crypto.ts";
import { check } from "./errors.ts";
import type { OutboundEvent, OutboundWebhooks } from "./outbound-webhooks.ts";

export type BusinessEventType = Exclude<OutboundEvent["type"], "alert.raised">;
interface BusinessEventRow {
  tenant_id: string;
  id: string;
  type: BusinessEventType;
  resource_id: string;
  occurred_at: number;
  state: string;
  attempts: number;
  available_at: number;
}

export interface PendingEventGrace {
  paidThrough: number;
  retainUntil: number;
}

// Call only inside the transaction that commits the corresponding transition.
// Replay identity includes tenant/type/resource/transition, never timestamps or
// customer/provider data. The first committed occurrence retains its timestamp.
export async function recordBusinessEvent(
  tx: Knex.Transaction,
  tenantId: string,
  type: BusinessEventType,
  resourceId: string,
  transitionId: string = randomUUID(),
  occurredAt = Date.now(),
): Promise<string> {
  const id = hash(JSON.stringify([tenantId, type, resourceId, transitionId]));
  await tx("business_events")
    .insert({
      tenant_id: tenantId,
      id,
      type,
      resource_id: resourceId,
      occurred_at: occurredAt,
    })
    .onConflict(["tenant_id", "id"])
    .merge(["id"]);
  return id;
}

// Seller/operator handler hook. The row lock serializes billing and activation
// writes too. Restoring access does not reactivate inactive installations.
export async function setLicenseRevoked(
  tx: Knex.Transaction,
  tenantId: string,
  id: string,
  revoked: boolean,
  now = Date.now(),
) {
  // Billing reads the prior license only after taking this mutex. Share it
  // so a refund cannot use a stale pre-operator revocation snapshot.
  await lock(tx, "billing", tenantId);
  await tx("licenses")
    .where({ tenant_id: tenantId, id })
    .increment("lock_version", 1);
  const before = await tx<License>("licenses")
    .where({ tenant_id: tenantId, id })
    .first();
  check(before, 404, "not_found", "License not found.");
  if (!!before.revoked === revoked) return;
  await tx("licenses")
    .where({ tenant_id: tenantId, id })
    .update({ revoked: revoked ? 1 : 0 });
  if (revoked && !before.refund_revoked)
    await recordBusinessEvent(
      tx,
      tenantId,
      "license.revoked",
      id,
      `operator:${before.lock_version}`,
      now,
    );
}

// Enqueue only, never network delivery. Commit each inbox lease BEFORE calling
// outbound.enqueue; it owns its own short work lock/transaction. A crash between
// fanout and acknowledgement replays the same durable ID and payload.
export class BusinessEvents {
  readonly db: DB;
  readonly tenantId: string;
  readonly outbound: Pick<OutboundWebhooks, "tenantId" | "enqueue">;
  readonly now: () => number;
  constructor(
    db: DB,
    tenantId: string,
    outbound: Pick<OutboundWebhooks, "tenantId" | "enqueue">,
    now = Date.now,
  ) {
    this.db = db;
    this.tenantId = tenantId;
    this.outbound = outbound;
    this.now = now;
    check(
      outbound.tenantId === tenantId,
      500,
      "event_tenant",
      "Business event tenant mismatch.",
    );
  }
  // Call on every tick with businessEventPolicy, including disabled tenants.
  // Pending available_at stores the first observed grace deadline. Ready rows
  // instead use it for retry backoff. A later renewal cannot extend that deadline
  // or resurrect suppressed history. Already qualified retries pause disabled.
  async dispatch(
    enabled: boolean,
    limit = 100,
    enabledSince = 0,
    pendingGrace?: PendingEventGrace,
  ) {
    check(
      Number.isInteger(limit) && limit >= 1 && limit <= 100,
      400,
      "invalid_limit",
      "Limit must be between 1 and 100.",
    );
    check(
      Number.isSafeInteger(enabledSince) && enabledSince >= 0,
      400,
      "invalid_period",
      "Invalid paid period start.",
    );
    check(
      !pendingGrace ||
        (Number.isSafeInteger(pendingGrace.paidThrough) &&
          pendingGrace.paidThrough >= enabledSince &&
          Number.isSafeInteger(pendingGrace.retainUntil) &&
          pendingGrace.retainUntil > pendingGrace.paidThrough),
      400,
      "invalid_grace",
      "Invalid pending event grace.",
    );
    const held: string[] = [];
    const result = { dispatched: 0, suppressed: 0, deferred: 0 };
    for (let i = 0; i < limit; i++) {
      const claimed = await this.db.transaction(async (tx) => {
        await lock(tx, "work", this.tenantId);
        const now = this.now();
        const row = await tx<BusinessEventRow>("business_events")
          .where({ tenant_id: this.tenantId })
          .whereIn("state", enabled ? ["pending", "ready"] : ["pending"])
          .andWhere((q) =>
            q.where({ state: "pending" }).orWhere("available_at", "<=", now),
          )
          .whereNotIn("id", held)
          .andWhere("lease_until", "<=", now)
          .orderBy("occurred_at")
          .orderBy("id")
          .first();
        if (!row) return;
        if (
          row.state === "pending" &&
          !enabled &&
          pendingGrace &&
          now < pendingGrace.retainUntil &&
          Number(row.occurred_at) >= enabledSince &&
          Number(row.occurred_at) < pendingGrace.retainUntil &&
          (!Number(row.available_at) || now < Number(row.available_at))
        ) {
          await tx("business_events")
            .where({ tenant_id: this.tenantId, id: row.id })
            .update({
              available_at: Math.min(
                Number(row.available_at) || pendingGrace.retainUntil,
                pendingGrace.retainUntil,
              ),
            });
          return { held: row.id } as const;
        }
        if (
          row.state === "pending" &&
          (!enabled ||
            Number(row.occurred_at) < enabledSince ||
            (Number(row.available_at) > 0 && now >= Number(row.available_at)))
        ) {
          await tx("business_events")
            .where({ tenant_id: this.tenantId, id: row.id })
            .update({ state: "suppressed" });
          return { skip: true } as const;
        }
        const owner = randomUUID();
        await tx("business_events")
          .where({ tenant_id: this.tenantId, id: row.id })
          .update({
            state: "ready",
            available_at: 0,
            lease_until: now + 30000,
            lease_owner: owner,
            attempts: Number(row.attempts) + 1,
          });
        return { skip: false, row, owner } as const;
      });
      if (!claimed) break;
      if ("held" in claimed) {
        held.push(claimed.held);
        result.deferred++;
        continue;
      }
      if (claimed.skip) {
        result.suppressed++;
        continue;
      }
      const { row, owner } = claimed;
      const own = { tenant_id: this.tenantId, id: row.id, lease_owner: owner };
      try {
        await this.outbound.enqueue({
          id: row.id,
          type: row.type,
          resourceId: row.resource_id,
          occurredAt: Number(row.occurred_at),
        });
        await this.db("business_events").where(own).update({
          state: "dispatched",
          lease_owner: null,
          lease_until: 0,
          last_error: null,
        });
        result.dispatched++;
      } catch {
        // Retry forever with bounded backoff: capacity is not loss of a paid
        // business event. Store no exception text or external response bodies.
        await this.db("business_events")
          .where(own)
          .update({
            lease_owner: null,
            lease_until: 0,
            available_at:
              this.now() +
              Math.min(3600000, 5000 * 2 ** Math.min(Number(row.attempts), 10)),
            last_error: "dispatch_failed",
          });
        result.deferred++;
      }
    }
    return result;
  }
}
