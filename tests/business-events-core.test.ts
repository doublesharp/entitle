import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { Billing, type BillingSnapshot } from "../src/billing.ts";
import { Licenses } from "../src/licensing.ts";
import type { DB, License } from "../src/db.ts";
import { unseal } from "../src/crypto.ts";
import { Releases } from "../src/releases.ts";
import { Artifacts } from "../src/artifacts.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import { BusinessEvents } from "../src/business-events.ts";
import { zipBytes } from "./helpers/zip.ts";
import {
  businessFixture,
  secret,
  tenant,
  outbound,
} from "./business-events-fixtures.test.ts";

async function merchant(db: DB) {
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
    site_allowance: 3,
    stripe_price_id: "price",
  });
  const licensing = new Licenses(db, secret, [], tenant);
  const now = Date.now();
  const snapshot: BillingSnapshot = {
    subscriptionId: "s",
    customerId: "c",
    email: "buyer@example.test",
    billingStatus: "active",
    suspended: false,
    fullyRefunded: false,
    grants: [
      {
        id: "g",
        invoiceId: "i",
        priceId: "price",
        periodStart: now - 1000,
        periodEnd: now + 86400000,
        paidAt: now,
        settled: true,
      },
    ],
  };
  const billing = new Billing(db, licensing, {
    snapshot: async () => structuredClone(snapshot),
  });
  const key = async () =>
    unseal<{ text: string }>(
      (await db("emails").orderBy("created_at", "desc").first()).payload,
      secret,
    ).text.match(/DE-\S+/)![0];
  return { billing, snapshot, licensing, key };
}
const types = async (db: DB) =>
  (await db("business_events").orderBy("type")).map((row) => row.type);

test("billing emits only committed creation, paid-through extension and effective refund revocation", async () =>
  businessFixture(async (db) => {
    const m = await merchant(db);
    await m.billing.reconcile("s");
    await m.billing.reconcile("s");
    assert.deepEqual(await types(db), ["license.created"]);
    const original = { ...m.snapshot.grants[0]! };
    m.snapshot.grants = [
      {
        ...original,
        id: "renewal",
        invoiceId: "i2",
        periodStart: original.periodEnd,
        periodEnd: original.periodEnd + 86400000,
      },
    ];
    await m.billing.reconcile("s");
    await m.billing.reconcile("s");
    m.snapshot.grants = [
      {
        ...original,
        id: "historical",
        invoiceId: "ih",
        periodEnd: original.periodEnd - 10,
      },
    ];
    await m.billing.reconcile("s");
    m.snapshot.grants = [original];
    await m.billing.reconcile("s");
    assert.deepEqual(await types(db), ["license.created", "license.renewed"]);
    m.snapshot.fullyRefunded = true;
    await m.billing.reconcile("s");
    await m.billing.reconcile("s");
    m.snapshot.fullyRefunded = false;
    await m.billing.reconcile("s");
    assert.deepEqual(await types(db), [
      "license.created",
      "license.renewed",
      "license.revoked",
    ]);
    const l = await db<License>("licenses").first();
    assert.equal(l!.refund_revoked, 1);
    for (const row of await db("business_events")) {
      assert.equal(row.resource_id, l!.id);
      assert.match(row.id, /^[a-f0-9]{64}$/);
      assert.ok(!JSON.stringify(row).includes("buyer@example.test"));
    }
  }));

test("inbox insert failures roll back purchases, renewals, refunds and key delivery", async () =>
  businessFixture(async (db) => {
    const m = await merchant(db);
    const rejectEvent = (query: { sql: string }) => {
      if (/insert into ["`]business_events["`]/.test(query.sql))
        throw Error("inbox unavailable");
    };
    db.on("query", rejectEvent);
    try {
      await assert.rejects(m.billing.reconcile("s"), /inbox unavailable/);
    } finally {
      db.off("query", rejectEvent);
    }
    assert.equal((await db("licenses")).length, 0);
    assert.equal((await db("emails")).length, 0);
    assert.equal((await db("business_events")).length, 0);
    await m.billing.reconcile("s");
    const before = await db<License>("licenses").first();
    m.snapshot.grants.push({
      ...m.snapshot.grants[0]!,
      id: "g2",
      periodEnd: Number(before!.paid_through) + 86400000,
    });
    m.snapshot.fullyRefunded = true;
    db.on("query", rejectEvent);
    try {
      await assert.rejects(m.billing.reconcile("s"), /inbox unavailable/);
    } finally {
      db.off("query", rejectEvent);
    }
    const after = await db<License>("licenses").first();
    assert.equal(Number(after!.paid_through), Number(before!.paid_through));
    assert.equal(after!.refund_revoked, 0);
    assert.equal((await db("grants")).length, 1);
    assert.equal((await db("business_events")).length, 1);
  }));

test("activation changes cover activation, deactivation, reactivation and replacement without replay events", async () =>
  businessFixture(async (db) => {
    const m = await merchant(db);
    await m.billing.reconcile("s");
    const key = await m.key();
    const l = (await db<License>("licenses").first())!;
    const first = await m.licensing.activate(
      key,
      "device",
      "https://example.test",
      "p",
    );
    await m.licensing.activate(key, "device", "https://example.test", "p");
    assert.equal(
      (await types(db)).filter((t) => t === "activation.changed").length,
      1,
    );
    await m.licensing.deactivate(first.token);
    await assert.rejects(
      m.licensing.deactivate(first.token),
      /invalid or revoked/,
    );
    const second = await m.licensing.activate(
      key,
      "device",
      "https://example.test",
      "p",
    );
    const installation = (await db("installations").first()).id;
    await m.licensing.deactivateOwned(installation, l.customer_id);
    await m.licensing.deactivateOwned(installation, l.customer_id);
    await m.licensing.activate(key, "device", "https://example.test", "p");
    await m.licensing.activate(key, "second", "https://two.example.test", "p");
    const before = (await types(db)).filter(
      (t) => t === "activation.changed",
    ).length;
    const nextKey = await m.licensing.replaceKey(l.id, l.customer_id);
    assert.equal(
      (await types(db)).filter((t) => t === "activation.changed").length,
      before + 2,
    );
    await m.licensing.replaceKey(l.id, l.customer_id);
    assert.equal(
      (await types(db)).filter((t) => t === "activation.changed").length,
      before + 2,
    );
    await assert.rejects(m.licensing.resolve(second.token));
    assert.notEqual(key, nextKey);
    assert.equal(
      (await types(db)).filter((t) => t === "license.revoked").length,
      0,
    );
    assert.equal((await db("installations").where({ active: 1 })).length, 0);
  }));

test("activation and credential recovery roll back together if inbox persistence fails", async () =>
  businessFixture(async (db) => {
    const m = await merchant(db);
    await m.billing.reconcile("s");
    const key = await m.key();
    const rejectEvent = (query: { sql: string }) => {
      if (/insert into ["`]business_events["`]/.test(query.sql))
        throw Error("inbox unavailable");
    };
    db.on("query", rejectEvent);
    try {
      await assert.rejects(
        m.licensing.activate(key, "device", "https://example.test", "p"),
        /inbox unavailable/,
      );
    } finally {
      db.off("query", rejectEvent);
    }
    assert.equal((await db("installations")).length, 0);
    const token = await m.licensing.activate(
      key,
      "device",
      "https://example.test",
      "p",
    );
    const l = (await db<License>("licenses").first())!;
    db.on("query", rejectEvent);
    try {
      await assert.rejects(
        m.licensing.replaceKey(l.id, l.customer_id),
        /inbox unavailable/,
      );
      await assert.rejects(
        m.licensing.deactivate(token.token),
        /inbox unavailable/,
      );
    } finally {
      db.off("query", rejectEvent);
    }
    assert.equal(
      (await m.licensing.resolve(token.token)).license.key_hash,
      l.key_hash,
    );
    assert.equal((await db("emails")).length, 1);
  }));

test("WordPress and each native target publication plus withdrawal persist atomic event transitions", async () =>
  businessFixture(async (db) => {
    await merchant(db);
    const root = await mkdtemp(
      "/Volumes/Scratch/entitle/tmp/business-events-publication-",
    );
    try {
      const store = new InMemoryArtifactStore();
      const releases = new Releases(db, store, tenant, `${root}/verify`);
      await writeFile(
        `${root}/p.zip`,
        zipBytes([
          {
            name: "p/p.php",
            data: "<?php\n/*\nPlugin Name: P\nVersion: 1.0.0\n*/",
          },
        ]),
      );
      const wp = await releases.publish({
        product: "p",
        version: "1.0.0",
        file: `${root}/p.zip`,
        changelog: "",
        minWp: "6.0",
        minPhp: "8.0",
        minFree: "0.0",
        tested: "6.0",
      });
      await db("products").insert({
        tenant_id: tenant.id,
        id: "native",
        slug: "native",
        name: "Native",
        framework: "generic",
        framework_config: "{}",
      });
      await writeFile(`${root}/app.bin`, "native bytes");
      const artifacts = new Artifacts(db, store, tenant);
      const input = {
        product: "native",
        version: "1.0.0",
        file: `${root}/app.bin`,
        target: "linux-x64",
        filename: "app.bin",
        changelog: "",
      };
      const a = await artifacts.publish(input),
        b = await artifacts.publish({ ...input, target: "darwin-arm64" });
      await assert.rejects(artifacts.publish(input), /already exists/);
      const published = await db("business_events").where({
        type: "release.published",
      });
      assert.deepEqual(
        published.map((row) => row.resource_id).sort(),
        [wp.id, a.asset.id, b.asset.id].sort(),
      );
      const rejectEvent = (query: { sql: string }) => {
        if (/insert into ["`]business_events["`]/.test(query.sql))
          throw Error("inbox unavailable");
      };
      await writeFile(
        `${root}/p.zip`,
        zipBytes([
          {
            name: "p/p.php",
            data: "<?php\n/*\nPlugin Name: P\nVersion: 1.0.1\n*/",
          },
        ]),
      );
      db.on("query", rejectEvent);
      try {
        await assert.rejects(releases.withdraw(wp.id), /inbox unavailable/);
        await assert.rejects(
          releases.withdraw(a.release.id),
          /inbox unavailable/,
        );
        await assert.rejects(
          artifacts.publish({ ...input, version: "1.0.1" }),
          /inbox unavailable/,
        );
        await assert.rejects(
          releases.publish({
            product: "p",
            version: "1.0.1",
            file: `${root}/p.zip`,
            changelog: "",
            minWp: "6.0",
            minPhp: "8.0",
            minFree: "0.0",
            tested: "6.0",
          }),
          /inbox unavailable/,
        );
      } finally {
        db.off("query", rejectEvent);
      }
      assert.equal((await db("releases").where({ withdrawn: 1 })).length, 0);
      await releases.withdraw(wp.id);
      await releases.withdraw(wp.id);
      await releases.withdraw(a.release.id);
      await releases.withdraw(a.release.id);
      assert.equal(
        (await db("business_events").where({ type: "release.withdrawn" }))
          .length,
        2,
      );
      assert.equal((await db("releases")).length, 2);
      assert.equal((await db("release_assets")).length, 2);
      assert.equal((await db("upload_reservations")).length, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }));

test("a full outbound queue cannot interrupt purchases or license recovery and retries later", async () =>
  businessFixture(async (db) => {
    const sink = outbound(db);
    const endpoint = await sink.createEndpoint({
      url: "https://example.test/events",
      events: ["license.created", "activation.changed"],
    });
    // Actual queue budget, with valid event/endpoint foreign keys and unique pairs.
    for (let offset = 0; offset < 1000; offset += 100) {
      await db("outbound_events").insert(
        Array.from({ length: 100 }, (_, n) => ({
          tenant_id: tenant.id,
          id: `e${offset + n}`,
          payload: "{}",
          created_at: 0,
        })),
      );
      await db("outbound_deliveries").insert(
        Array.from({ length: 100 }, (_, n) => ({
          tenant_id: tenant.id,
          id: `d${offset + n}`,
          event_id: `e${offset + n}`,
          endpoint_id: endpoint.id,
          generation: 1,
          available_at: 0,
          deadline_at: Date.now() + 86400000,
          created_at: 0,
        })),
      );
    }
    const m = await merchant(db);
    await m.billing.reconcile("s");
    const key = await m.key();
    await m.licensing.activate(key, "device", "https://example.test", "p");
    const l = (await db<License>("licenses").first())!;
    await m.licensing.replaceKey(l.id, l.customer_id);
    let now = Date.now();
    const worker = new BusinessEvents(db, tenant.id, sink, () => now);
    assert.deepEqual(await worker.dispatch(true), {
      dispatched: 0,
      suppressed: 0,
      deferred: 3,
    });
    await db("outbound_deliveries").update({ state: "succeeded" });
    now += 5001;
    assert.equal((await worker.dispatch(true)).dispatched, 3);
    assert.equal(
      (await db("outbound_deliveries").where({ state: "pending" })).length,
      3,
    );
  }));

test("refund of an already operator-revoked license does not duplicate effective revocation", async () =>
  businessFixture(async (db) => {
    const m = await merchant(db);
    await m.billing.reconcile("s");
    await db("licenses").update({ revoked: 1 });
    m.snapshot.fullyRefunded = true;
    await m.billing.reconcile("s");
    assert.deepEqual(await types(db), ["license.created"]);
    assert.equal((await db("licenses").first()).refund_revoked, 1);
  }));
