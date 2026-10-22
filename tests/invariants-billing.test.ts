import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import type { BillingEvent, PaidGrant } from "../src/billing.ts";
import { reset, type License } from "../src/db.ts";
import {
  allCompleted,
  businessState,
  denied,
  epoch,
  invariantDatabase,
  merchant,
  parameters,
  purchase,
  sequence,
  slug,
} from "./helpers/invariants.ts";

const database = await invariantDatabase();
const db = database.db;
after(() => database.close());

type Step =
  | { kind: "observe"; slot: number; settled: boolean }
  | { kind: "flags"; suspended: boolean; refunded: boolean }
  | { kind: "receive"; event: number }
  | { kind: "apply"; concurrent: boolean; fail: boolean }
  | { kind: "work"; fail: boolean };
const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    kind: fc.constant("observe" as const),
    slot: fc.integer({ min: 0, max: 3 }),
    settled: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant("flags" as const),
    suspended: fc.boolean(),
    refunded: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant("receive" as const),
    event: fc.integer({ min: 0, max: 3 }),
  }),
  fc.record({
    kind: fc.constant("apply" as const),
    concurrent: fc.boolean(),
    fail: fc.boolean(),
  }),
  fc.record({ kind: fc.constant("work" as const), fail: fc.boolean() }),
);
function event(id: number): BillingEvent {
  return {
    id: `evt_${id}`,
    type: id % 2 ? "customer.subscription.updated" : "invoice.paid",
    data: { object: { id: `in_${id}` } },
  };
}

test("invariant: billing sequences preserve paid grants, ownership and idempotency through retries", async () => {
  await fc.assert(
    fc.asyncProperty(sequence(step), async (steps) => {
      await reset(db);
      const m = await merchant(db);
      m.snapshot.grants = [];
      let providerFails = false;
      m.billing.source.snapshot = async () => {
        if (providerFails) throw Error("fixture provider unavailable");
        return structuredClone(m.snapshot);
      };
      const ledger = new Map<string, PaidGrant>();
      const events = new Set<number>();
      const processed = new Set<number>();
      let suspended = false,
        refunded = false;
      let owner: string | undefined, licenseId: string | undefined;
      const applyModel = () => {
        for (const grant of m.snapshot.grants)
          if (grant.settled) ledger.set(grant.id, grant);
        if (ledger.size) {
          suspended = m.snapshot.suspended;
          refunded ||= m.snapshot.fullyRefunded;
        }
      };
      const verify = async () => {
        const licenses = await db<License>("licenses").where({
          tenant_id: m.tenant.id,
        });
        assert.equal(licenses.length, ledger.size ? 1 : 0);
        assert.equal(
          (await db("emails")).length,
          ledger.size ? 1 : 0,
          "one initial license key delivery",
        );
        const actual = await db("grants").orderBy("id");
        assert.deepEqual(
          actual.map((g) => g.id),
          [...ledger.keys()].sort(),
        );
        for (const g of actual) {
          const expected = ledger.get(g.id)!;
          assert.equal(g.invoice_id, expected.invoiceId);
          assert.equal(Number(g.period_start), expected.periodStart);
          assert.equal(Number(g.period_end), expected.periodEnd);
          assert.equal(
            g.plan_id,
            `primary-plan-${expected.priceId === "price_1" ? 1 : 3}`,
          );
        }
        if (licenses.length) {
          const l = licenses[0]!;
          owner ??= l.customer_id;
          licenseId ??= l.id;
          assert.equal(l.customer_id, owner);
          assert.equal(l.id, licenseId);
          assert.equal(
            Number(l.paid_through),
            Math.max(...[...ledger.values()].map((g) => g.periodEnd)),
          );
          assert.equal(l.suspended, Number(suspended));
          assert.equal(l.refund_revoked, Number(refunded));
          const effective = await m.licensing.effective(l);
          assert.equal(
            effective.site_allowance,
            Math.max(
              ...[...ledger.values()].map((g) =>
                g.priceId === "price_1" ? 1 : 3,
              ),
            ),
          );
          assert.equal(m.licensing.entitled(l), !suspended && !refunded);
        }
        const stored = await db("billing_events").orderBy("id");
        assert.deepEqual(
          stored.map((e) => e.id),
          [...events].map((i) => `evt_${i}`).sort(),
        );
        for (const e of stored)
          assert.equal(
            e.processed_at !== null,
            processed.has(Number(e.id.slice(4))),
          );
      };
      // Always exercise the unpaid path, even if a generated sequence starts with a worker.
      m.snapshot.grants = [
        {
          id: "unpaid",
          invoiceId: "unpaid",
          priceId: "price_3",
          periodStart: epoch - 1,
          periodEnd: epoch + 100,
          paidAt: epoch,
          settled: false,
        },
      ];
      await m.billing.reconcile(m.snapshot.subscriptionId);
      await verify();
      for (const s of steps) {
        switch (s.kind) {
          case "observe":
            // Provider responses may omit older invoices. IDs retain immutable terms.
            m.snapshot.grants = [
              {
                id: `grant_${s.slot}`,
                invoiceId: `invoice_${s.slot}`,
                priceId: s.slot % 2 ? "price_3" : "price_1",
                periodStart: epoch - 10 + s.slot,
                periodEnd: epoch + 100 + s.slot,
                paidAt: epoch + s.slot,
                settled: s.settled,
              },
            ];
            break;
          case "flags":
            m.snapshot.suspended = s.suspended;
            m.snapshot.fullyRefunded = s.refunded;
            break;
          case "receive":
            await m.billing.receive(event(s.event));
            await m.billing.receive(event(s.event));
            events.add(s.event);
            assert.equal((await db("work")).length, events.size);
            break;
          case "apply": {
            providerFails = s.fail;
            const before = await businessState(db, m.tenant.id);
            const calls = Array.from({ length: s.concurrent ? 3 : 1 }, () =>
              m.billing.reconcile(m.snapshot.subscriptionId),
            );
            if (providerFails) {
              await allCompleted(
                calls.map((call) =>
                  assert.rejects(call, /fixture provider unavailable/),
                ),
              );
              assert.deepEqual(await businessState(db, m.tenant.id), before);
            } else {
              await allCompleted(calls);
              applyModel();
            }
            break;
          }
          case "work": {
            providerFails = s.fail;
            await db("work")
              .where({ state: "pending" })
              .update({ available_at: 0 });
            const pending = [...events].filter((i) => !processed.has(i));
            await m.billing.run(async () => m.snapshot.subscriptionId);
            if (!providerFails && pending.length) {
              applyModel();
              pending.forEach((i) => processed.add(i));
            }
            break;
          }
        }
        await verify();
      }
      // Drain retries against one authoritative state, then replay all durable IDs.
      providerFails = false;
      await m.billing.reconcile(m.snapshot.subscriptionId);
      applyModel();
      await db("work").where({ state: "pending" }).update({ available_at: 0 });
      await m.billing.run(async () => m.snapshot.subscriptionId);
      events.forEach((i) => processed.add(i));
      for (const id of events) await m.billing.receive(event(id));
      await verify();
      const stable = await businessState(db, m.tenant.id);
      await m.billing.run(async () => m.snapshot.subscriptionId);
      assert.deepEqual(await businessState(db, m.tenant.id), stable);
    }),
    parameters<[Step[]]>([
      [
        [
          { kind: "observe", slot: 0, settled: true },
          { kind: "receive", event: 0 },
          { kind: "work", fail: true },
          { kind: "work", fail: false },
          { kind: "observe", slot: 1, settled: false },
          { kind: "apply", concurrent: true, fail: false },
          { kind: "observe", slot: 1, settled: true },
          { kind: "apply", concurrent: true, fail: false },
          { kind: "observe", slot: 0, settled: true },
          { kind: "flags", suspended: true, refunded: false },
          { kind: "apply", concurrent: true, fail: false },
          { kind: "flags", suspended: false, refunded: true },
          { kind: "apply", concurrent: false, fail: false },
          { kind: "flags", suspended: false, refunded: false },
          { kind: "apply", concurrent: false, fail: false },
        ],
      ],
    ]),
  );
});

type TenantStep = {
  tenant: number;
  operation: "activate" | "replace" | "foreign" | "event";
  slot: number;
};
test("invariant: matching external IDs never cross tenant ownership or credential boundaries", async () => {
  const tenantStep: fc.Arbitrary<TenantStep> = fc.record({
    tenant: fc.integer({ min: 0, max: 1 }),
    operation: fc.constantFrom("activate", "replace", "foreign", "event"),
    slot: fc.integer({ min: 0, max: 2 }),
  });
  await fc.assert(
    fc.asyncProperty(sequence(tenantStep), async (steps) => {
      await reset(db);
      const merchants = [await merchant(db), await merchant(db, "other")];
      const buyers = await allCompleted(merchants.map((m) => purchase(db, m)));
      assert.notEqual(
        buyers[0]!.license.customer_id,
        buyers[1]!.license.customer_id,
      );
      const tokens: string[][] = [[], []];
      for (const [index, m] of merchants.entries()) {
        const active = await m.licensing.activate(
          buyers[index]!.key,
          "install-0",
          "https://same.example.test",
          slug,
        );
        tokens[index]!.push(active.token);
      }
      for (const s of steps) {
        const m = merchants[s.tenant]!,
          own = buyers[s.tenant]!;
        const foreign = 1 - s.tenant,
          other = buyers[foreign]!;
        const beforeOther = await businessState(
          db,
          merchants[foreign]!.tenant.id,
        );
        if (s.operation === "foreign") {
          const beforeOwn = await businessState(db, m.tenant.id);
          await denied(
            m.licensing.activate(
              other.key,
              `install-${s.slot}`,
              "https://same.example.test",
              slug,
            ),
            "invalid_license",
          );
          await denied(
            m.licensing.replaceKey(other.license.id, other.license.customer_id),
            "not_found",
          );
          const foreignInstallation = await db("installations")
            .where({ tenant_id: merchants[foreign]!.tenant.id })
            .first();
          assert.ok(foreignInstallation);
          await denied(
            m.licensing.deactivateOwned(
              foreignInstallation.id,
              other.license.customer_id,
            ),
            "not_found",
          );
          for (const token of tokens[foreign]!) {
            await denied(m.licensing.status(token), "invalid_activation");
            await denied(m.licensing.deactivate(token), "invalid_activation");
          }
          assert.deepEqual(await businessState(db, m.tenant.id), beforeOwn);
        } else if (s.operation === "replace") {
          own.key = await m.licensing.replaceKey(
            own.license.id,
            own.license.customer_id,
          );
        } else if (s.operation === "event") {
          await m.billing.receive(event(s.slot));
          await m.billing.run(async () => m.snapshot.subscriptionId);
        } else {
          const id = `install-${s.slot}`;
          const current = await db("installations").where({
            tenant_id: m.tenant.id,
            active: 1,
          });
          if (
            current.some((i) => i.installation_id === id) ||
            !current.length
          ) {
            const activated = await m.licensing.activate(
              own.key,
              id,
              "https://same.example.test",
              slug,
            );
            tokens[s.tenant]!.push(activated.token);
          } else
            await denied(
              m.licensing.activate(
                own.key,
                id,
                "https://same.example.test",
                slug,
              ),
              "site_limit",
            );
        }
        assert.deepEqual(
          await businessState(db, merchants[foreign]!.tenant.id),
          beforeOther,
        );
        assert.equal((await db("licenses")).length, 2);
      }
    }),
    parameters(),
  );
});
