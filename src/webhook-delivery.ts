// One pool per app. Rejected admissions remain in SQL for a later tick; there
// is deliberately no in-memory waiting queue or per-tenant pending promise.
export class WebhookDeliveryPool {
  private readonly active = new Map<string, Promise<void>>();
  private readonly maxConcurrent: number;
  private readonly onFailure: (tenantId: string) => void;
  private closed = false;
  constructor(onFailure: (tenantId: string) => void, maxConcurrent = 4) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 64)
      throw Error("Webhook concurrency must be an integer between 1 and 64");
    this.onFailure = onFailure;
    this.maxConcurrent = maxConcurrent;
  }
  start(tenantId: string, job: () => Promise<void>): boolean {
    if (this.closed || this.active.has(tenantId) || this.active.size >= this.maxConcurrent) return false;
    const task = Promise.resolve().then(job).catch(() => {
      try { this.onFailure(tenantId); } catch { /* Logging cannot retain a slot or reject shutdown. */ }
    }).finally(() => { this.active.delete(tenantId); });
    this.active.set(tenantId, task);
    return true;
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.active.values());
  }
}
