import { randomUUID } from "node:crypto";
import type { DB, Job, Tx } from "./db.ts";
import { lock } from "./db.ts";

export class DeferredJob extends Error {
  availableAt:number;
  constructor(availableAt:number){super("Job deferred by resource budget");this.availableAt=availableAt;}
}

export async function runQueue(
  db: DB,
  table: "work" | "emails" | "platform_work" | "platform_emails",
  handler: (job: Job) => Promise<void>,
  limit = 20,
  tenantId?: string,
) {
  const tenantOwned = table === "work" || table === "emails";
  if (tenantOwned && !tenantId) throw Error("Tenant context is required for business jobs");
  const query = (connection: Tx) => {
    const q = connection<Job>(table);
    return tenantOwned ? q.where({ tenant_id: tenantId! }) : q;
  };
  for (let i = 0; i < limit; i++) {
    const job = await db.transaction(async (tx) => {
      await lock(tx, table.endsWith("work") ? "work" : "email", tenantId);
      const row = await query(tx)
        .whereIn("state", ["pending", "running"])
        .andWhere("available_at", "<=", Date.now())
        .andWhere("lease_until", "<", Date.now())
        .orderBy("created_at")
        .first();
      if (!row) return;
      const owner = randomUUID();
      await query(tx)
        .where({ id: row.id })
        .update({
          state: "running",
          lease_until: Date.now() + 300000,
          lease_owner: owner,
          attempts: row.attempts + 1,
        });
      return { ...row, attempts: row.attempts + 1, lease_owner: owner };
    });
    if (!job) break;
    try {
      await handler(job);
      await query(db)
        .where({ id: job.id, lease_owner: job.lease_owner, state: "running" })
        .update({
          state: "sent",
          lease_until: 0,
          lease_owner: null,
          last_error: null,
          ...(table.endsWith("emails") ? { payload: "" } : {}),
        });
    } catch(error) {
      await query(db)
        .where({ id: job.id, lease_owner: job.lease_owner, state: "running" })
        .update({
          state: error instanceof DeferredJob ? "pending" : Date.now()-Number(job.created_at)>=72*3600000 ? "failed" : "pending",
          attempts: error instanceof DeferredJob ? job.attempts-1 : job.attempts,
          lease_until: 0,
          lease_owner: null,
          available_at: error instanceof DeferredJob ? error.availableAt : Date.now() +
            Math.min(3600000, 1000 * 2 ** Math.min(job.attempts, 12)),
          last_error: error instanceof DeferredJob ? "resource_budget" : "processing_failed",
        });
    }
  }
}
