import test from "node:test";
import assert from "node:assert/strict";
import { down } from "../src/migrations/012_business_events.ts";
import {
  BusinessEvents,
  recordBusinessEvent,
  setLicenseRevoked,
} from "../src/business-events.ts";
import {
  businessFixture,
  tenant,
  outbound,
} from "./business-events-fixtures.test.ts";
// Core transactions are independent of all outbound capacity and network work.
test("durable recording deduplicates stable transitions and rolls back with state", async () =>
  businessFixture(async (db) => {
    const first = await db.transaction((tx) =>
      recordBusinessEvent(
        tx,
        tenant.id,
        "license.created",
        "license",
        "created",
        10,
      ),
    );
    assert.equal(
      await db.transaction((tx) =>
        recordBusinessEvent(
          tx,
          tenant.id,
          "license.created",
          "license",
          "created",
          20,
        ),
      ),
      first,
    );
    assert.equal((await db("business_events").first()).occurred_at, 10);
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx("products").insert({
          tenant_id: tenant.id,
          id: "rollback",
          slug: "rollback",
          name: "Rollback",
        });
        await recordBusinessEvent(
          tx,
          tenant.id,
          "release.published",
          "rollback",
        );
        throw Error("rollback");
      }),
      /rollback/,
    );
    assert.equal((await db("products")).length, 0);
    assert.equal((await db("business_events")).length, 1);
    await assert.rejects(
      db.transaction((tx) =>
        recordBusinessEvent(tx, "missing", "license.created", "license"),
      ),
    );
    await assert.rejects(down(), /backup/);
  }));

test("worker dispatches once, isolates tenants, bounds ticks and validates configuration", async () =>
  businessFixture(async (db) => {
    const sink = outbound(db, () => 100);
    await sink.createEndpoint({
      url: "https://example.test/events",
      events: ["license.created"],
    });
    const worker = new BusinessEvents(db, tenant.id, sink, () => 100);
    await db.transaction(async (tx) => {
      await recordBusinessEvent(
        tx,
        tenant.id,
        "license.created",
        "one",
        "one",
        1,
      );
      await recordBusinessEvent(
        tx,
        tenant.id,
        "license.created",
        "two",
        "two",
        2,
      );
      await recordBusinessEvent(tx, "other", "license.created", "other");
    });
    assert.deepEqual(await worker.dispatch(true, 1), {
      dispatched: 1,
      suppressed: 0,
      deferred: 0,
    });
    assert.deepEqual(await worker.dispatch(true), {
      dispatched: 1,
      suppressed: 0,
      deferred: 0,
    });
    assert.deepEqual(await worker.dispatch(true), {
      dispatched: 0,
      suppressed: 0,
      deferred: 0,
    });
    assert.equal((await db("outbound_deliveries")).length, 2);
    assert.equal(
      (await db("business_events").where({ tenant_id: "other" }).first()).state,
      "pending",
    );
    for (const n of [0, 101, 1.5])
      await assert.rejects(worker.dispatch(true, n), /Limit/);
    await assert.rejects(worker.dispatch(true, 1, -1), /period/);
    assert.throws(() => new BusinessEvents(db, "other", sink), /tenant/);
  }));

test("disabled dispatch suppresses new history while paid retries pause and recover idempotently after a crash", async () =>
  businessFixture(async (db) => {
    let now = 100;
    const sink = outbound(db, () => now),
      worker = new BusinessEvents(db, tenant.id, sink, () => now);
    const id = await db.transaction((tx) =>
      recordBusinessEvent(
        tx,
        tenant.id,
        "license.created",
        "paid",
        "paid",
        now,
      ),
    );
    // Simulate process death after enqueue commits, before the inbox acknowledgement.
    const row = await db("business_events").where({ id }).first();
    await sink.enqueue({
      id,
      type: row.type,
      resourceId: row.resource_id,
      occurredAt: row.occurred_at,
    });
    await db("business_events")
      .where({ id })
      .update({ state: "ready", lease_owner: "dead", lease_until: 200 });
    await db.transaction((tx) =>
      recordBusinessEvent(
        tx,
        tenant.id,
        "license.created",
        "unpaid1",
        "unpaid1",
        now,
      ),
    );
    await db.transaction((tx) =>
      recordBusinessEvent(
        tx,
        tenant.id,
        "license.created",
        "unpaid2",
        "unpaid2",
        now,
      ),
    );
    assert.equal((await worker.dispatch(false, 1)).suppressed, 1);
    assert.equal(
      (await db("business_events").where({ id }).first()).state,
      "ready",
    );
    now = 201;
    // Future Pro signup cannot replay even history beyond the disabled tick limit.
    assert.deepEqual(await worker.dispatch(true, 100, 150), {
      dispatched: 1,
      suppressed: 1,
      deferred: 0,
    });
    assert.equal((await db("outbound_events")).length, 1);
    assert.equal(
      (await db("business_events").where({ id }).first()).state,
      "dispatched",
    );
  }));

test("dispatch releases leases with bounded backoff on failure and ignores a replaced lease owner", async () =>
  businessFixture(async (db) => {
    let now = 100;
    const id = await db.transaction((tx) =>
      recordBusinessEvent(
        tx,
        tenant.id,
        "license.created",
        "retry",
        "retry",
        now,
      ),
    );
    const failure = {
      tenantId: tenant.id,
      enqueue: async () => {
        throw Error("capacity or transport secret must not be stored");
      },
    };
    const worker = new BusinessEvents(db, tenant.id, failure, () => now);
    assert.equal((await worker.dispatch(true)).deferred, 1);
    let row = await db("business_events").where({ id }).first();
    assert.equal(row.state, "ready");
    assert.equal(row.last_error, "dispatch_failed");
    assert.equal(Number(row.available_at), 5100);
    assert.equal((await worker.dispatch(true)).deferred, 0);
    await db("business_events").where({ id }).update({ attempts: 100 });
    now = 5100;
    assert.deepEqual(await worker.dispatch(false), {
      dispatched: 0,
      suppressed: 0,
      deferred: 0,
    });
    assert.equal((await worker.dispatch(true)).deferred, 1);
    row = await db("business_events").where({ id }).first();
    assert.equal(Number(row.available_at), now + 3600000);
    const race = new BusinessEvents(
      db,
      tenant.id,
      {
        tenantId: tenant.id,
        enqueue: async () => {
          await db("business_events")
            .where({ id })
            .update({ lease_owner: "replacement", lease_until: now + 30000 });
          return true;
        },
      },
      () => now,
    );
    now += 3600000;
    await race.dispatch(true);
    assert.equal(
      (await db("business_events").where({ id }).first()).lease_owner,
      "replacement",
    );
  }));

// The helper is the seller API integration boundary; restoration has no invented event type.
test("operator revocation records only a real effective transition", async () =>
  businessFixture(async (db) => {
    await db("products").insert({
      tenant_id: tenant.id,
      id: "p",
      slug: "p",
      name: "P",
    });
    await db("plans").insert({
      tenant_id: tenant.id,
      id: "p",
      product_id: "p",
      name: "P",
      site_allowance: 1,
      stripe_price_id: "price",
    });
    await db("customers").insert({
      tenant_id: tenant.id,
      id: "c",
      email: "a@example.test",
    });
    await db("licenses").insert({
      tenant_id: tenant.id,
      id: "l",
      customer_id: "c",
      product_id: "p",
      plan_id: "p",
      subscription_id: "s",
      key_hash: "a".repeat(64),
      paid_through: 10,
      site_allowance: 1,
      billing_status: "active",
    });
    const revoke = (value: boolean) =>
      db.transaction((tx) => setLicenseRevoked(tx, tenant.id, "l", value, 10));
    await revoke(true);
    await revoke(true);
    await revoke(false);
    await revoke(false);
    assert.equal((await db("business_events")).length, 1);
    await revoke(true);
    assert.equal((await db("business_events")).length, 2);
    await revoke(false);
    await db("licenses").where({ id: "l" }).update({ refund_revoked: 1 });
    await revoke(true);
    assert.equal((await db("business_events")).length, 2);
    await assert.rejects(
      db.transaction((tx) => setLicenseRevoked(tx, "other", "l", true)),
      /not found/,
    );
    await assert.rejects(
      db.transaction(async (tx) => {
        await setLicenseRevoked(tx, tenant.id, "l", false);
        throw Error("rollback");
      }),
      /rollback/,
    );
    assert.equal((await db("licenses").where({ id: "l" }).first()).revoked, 1);
  }));

test("concurrent dispatch and acknowledgement failure preserve exactly one committed fanout", async () =>
  businessFixture(async (db) => {
    let now = 100;
    const sink = outbound(db, () => now);
    await sink.createEndpoint({
      url: "https://example.test/events",
      events: ["license.created"],
    });
    await db.transaction((tx) =>
      recordBusinessEvent(tx, tenant.id, "license.created", "ack", "ack", now),
    );
    const worker = new BusinessEvents(db, tenant.id, sink, () => now);
    let rejected = false;
    const failAck = (query: { sql: string; bindings: unknown[] }) => {
      if (
        !rejected &&
        /update ["`]business_events["`]/.test(query.sql) &&
        query.bindings.includes("dispatched")
      ) {
        rejected = true;
        throw Error("acknowledgement connection lost");
      }
    };
    db.on("query", failAck);
    try {
      assert.equal((await worker.dispatch(true)).deferred, 1);
    } finally {
      db.off("query", failAck);
    }
    assert.equal((await db("outbound_deliveries")).length, 1);
    now += 5001;
    const results = await Promise.all([
      worker.dispatch(true),
      new BusinessEvents(db, tenant.id, sink, () => now).dispatch(true),
    ]);
    assert.equal(
      results.reduce((count, result) => count + result.dispatched, 0),
      1,
    );
    assert.equal((await db("outbound_deliveries")).length, 1);
    assert.equal((await db("business_events").first()).state, "dispatched");
  }));

test("N1 renewal-gap events remain pending without enqueue and qualify when a continuous renewal is paid", async () =>
  businessFixture(async (db) => {
    let now = 110;
    const sink = outbound(db, () => now);
    await sink.createEndpoint({
      url: "https://example.test/events",
      events: ["license.created"],
    });
    const worker = new BusinessEvents(db, tenant.id, sink, () => now);
    const id = await db.transaction((tx) =>
      recordBusinessEvent(tx, tenant.id, "license.created", "gap", "gap", now),
    );
    assert.deepEqual(
      await worker.dispatch(false, 100, 50, {
        paidThrough: 100,
        retainUntil: 200,
      }),
      { dispatched: 0, suppressed: 0, deferred: 1 },
    );
    assert.equal(
      (await db("business_events").where({ id }).first()).state,
      "pending",
    );
    assert.equal((await db("outbound_deliveries")).length, 0);
    now = 150;
    assert.equal((await worker.dispatch(true, 100, 50)).dispatched, 1);
    assert.equal((await db("outbound_deliveries")).length, 1);
  }));

test("N1 expired grace and a later paid period suppress gap events permanently", async () =>
  businessFixture(async (db) => {
    let now = 110;
    const worker = new BusinessEvents(
      db,
      tenant.id,
      outbound(db, () => now),
      () => now,
    );
    const record = (id: string, at = now) =>
      db.transaction((tx) =>
        recordBusinessEvent(tx, tenant.id, "license.created", id, id, at),
      );
    await record("before", 49);
    await record("gap");
    assert.deepEqual(
      await worker.dispatch(false, 100, 50, {
        paidThrough: 100,
        retainUntil: 200,
      }),
      { dispatched: 0, suppressed: 1, deferred: 1 },
    );
    now = 200;
    // The durable deadline also applies if a renewal arrives before the next tick.
    assert.equal((await worker.dispatch(true, 100, 50)).suppressed, 1);
    assert.equal((await worker.dispatch(true, 100, 50)).dispatched, 0);
    now = 250;
    await record("new-gap");
    await worker.dispatch(false, 100, 50, {
      paidThrough: 240,
      retainUntil: 300,
    });
    assert.equal((await worker.dispatch(true, 100, 260)).suppressed, 1);
  }));

test("N1 revocation ends retention, never-Pro has no backfill, and held rows cannot starve later rows", async () =>
  businessFixture(async (db) => {
    const now = 110;
    const worker = new BusinessEvents(
      db,
      tenant.id,
      outbound(db, () => now),
      () => now,
    );
    await db.transaction(async (tx) => {
      await recordBusinessEvent(
        tx,
        tenant.id,
        "license.created",
        "gap",
        "gap",
        now,
      );
      await recordBusinessEvent(
        tx,
        tenant.id,
        "license.created",
        "future",
        "future",
        300,
      );
    });
    assert.deepEqual(
      await worker.dispatch(false, 100, 50, {
        paidThrough: 100,
        retainUntil: 200,
      }),
      { dispatched: 0, suppressed: 1, deferred: 1 },
    );
    // No last valid Pro interval after a refund. It cannot be revived by an upgrade.
    assert.equal((await worker.dispatch(false)).suppressed, 1);
    assert.equal((await worker.dispatch(true, 100, 50)).dispatched, 0);
    for (const grace of [
      { paidThrough: -1, retainUntil: 200 },
      { paidThrough: 100, retainUntil: 99 },
      { paidThrough: 100, retainUntil: NaN },
    ])
      await assert.rejects(worker.dispatch(false, 100, 50, grace), /grace/);
  }));

test("N1 a stored retention deadline cannot slide forward and its write rolls back on failure", async () =>
  businessFixture(async (db) => {
    let now = 110;
    const worker = new BusinessEvents(
      db,
      tenant.id,
      outbound(db, () => now),
      () => now,
    );
    const id = await db.transaction((tx) =>
      recordBusinessEvent(
        tx,
        tenant.id,
        "license.created",
        "deadline",
        "deadline",
        now,
      ),
    );
    const rejectRetention = (query: { sql: string }) => {
      if (/update ["`]business_events["`]/.test(query.sql))
        throw Error("retention unavailable");
    };
    db.on("query", rejectRetention);
    try {
      await assert.rejects(
        worker.dispatch(false, 100, 50, { paidThrough: 100, retainUntil: 200 }),
        /retention unavailable/,
      );
    } finally {
      db.off("query", rejectRetention);
    }
    assert.equal(
      Number((await db("business_events").where({ id }).first()).available_at),
      0,
    );
    await worker.dispatch(false, 100, 50, {
      paidThrough: 100,
      retainUntil: 200,
    });
    now = 150;
    assert.equal(
      (
        await worker.dispatch(false, 100, 50, {
          paidThrough: 100,
          retainUntil: 300,
        })
      ).deferred,
      1,
    );
    assert.equal(
      Number((await db("business_events").where({ id }).first()).available_at),
      200,
    );
    now = 200;
    assert.equal(
      (
        await worker.dispatch(false, 100, 50, {
          paidThrough: 100,
          retainUntil: 300,
        })
      ).suppressed,
      1,
    );
  }));

test("N1 qualification clears the pending deadline so a crashed dispatch can recover after its lease", async () =>
  businessFixture(async (db) => {
    let now = 110;
    const sink = outbound(db, () => now);
    const worker = new BusinessEvents(db, tenant.id, sink, () => now);
    await db.transaction((tx) =>
      recordBusinessEvent(
        tx,
        tenant.id,
        "license.created",
        "crash-gap",
        "crash-gap",
        now,
      ),
    );
    await worker.dispatch(false, 100, 50, {
      paidThrough: 100,
      retainUntil: 1000000,
    });
    now = 150;
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const stalled = new BusinessEvents(
      db,
      tenant.id,
      {
        tenantId: tenant.id,
        enqueue: async () => {
          entered.resolve();
          await release.promise;
          return true;
        },
      },
      () => now,
    );
    const running = stalled.dispatch(true, 1, 50);
    await entered.promise;
    try {
      now += 30001;
      assert.equal((await worker.dispatch(true, 1, 50)).dispatched, 1);
    } finally {
      release.resolve();
      await running;
    }
  }));
