import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import { reset, type Installation, type License } from "../src/db.ts";
import {
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

type Action =
  | { kind: "activate"; slot: number; site: number; exempt: boolean }
  | { kind: "deactivate"; slot: number }
  | { kind: "replace" }
  | { kind: "advance"; by: number }
  | { kind: "plan"; seats: number; future: boolean; settled: boolean }
  | { kind: "suspend"; value: boolean }
  | { kind: "refund" };
const action: fc.Arbitrary<Action> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      kind: fc.constant("activate" as const),
      slot: fc.integer({ min: 0, max: 4 }),
      site: fc.integer({ min: 0, max: 2 }),
      exempt: fc.boolean(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("deactivate" as const),
      slot: fc.integer({ min: 0, max: 4 }),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "replace" as const }) },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("advance" as const),
      by: fc.constantFrom(0, 1, 99, 100, 101),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant("plan" as const),
      seats: fc.constantFrom(1, 3),
      future: fc.boolean(),
      settled: fc.boolean(),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("suspend" as const),
      value: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: "refund" as const }) },
);

test("future paid grants retain the prior allowance during a gap, including after reconciliation", async () => {
  await reset(db);
  const m = await merchant(db);
  const { key } = await purchase(db, m);
  const first = await m.licensing.activate(
    key,
    "first",
    "https://first.example.test",
    slug,
  );
  m.clock.now = epoch + 1;
  m.snapshot.grants.push({
    id: "future",
    invoiceId: "future",
    priceId: "price_3",
    settled: true,
    periodStart: epoch + 101,
    periodEnd: epoch + 201,
    paidAt: epoch + 1,
  });
  await m.billing.reconcile(m.snapshot.subscriptionId);
  m.clock.now = epoch + 100;
  assert.equal((await m.licensing.status(first.token)).siteAllowance, 1);
  assert.equal(
    (
      await m.licensing.activate(
        key,
        "first",
        "https://first.example.test",
        slug,
      )
    ).siteAllowance,
    1,
  );
  await m.billing.reconcile(m.snapshot.subscriptionId);
  assert.equal((await m.licensing.status(first.token)).siteAllowance, 1);
  await denied(
    m.licensing.activate(key, "second", "https://second.example.test", slug),
    "site_limit",
  );
  m.clock.now = epoch + 101;
  assert.equal(
    (
      await m.licensing.activate(
        key,
        "second",
        "https://second.example.test",
        slug,
      )
    ).siteAllowance,
    3,
  );
});

test("invariant: generated license lifecycles preserve seats, paid boundaries and credential lifetimes", async () => {
  await fc.assert(
    fc.asyncProperty(sequence(action), async (actions) => {
      await reset(db);
      const m = await merchant(db);
      const { license, key: initialKey } = await purchase(db, m);
      let key = initialKey,
        suspended = false,
        refunded = false;
      const oldKeys: string[] = [];
      const tokens = new Set<string>();
      const installations = new Map<
        number,
        { site: string; exempt: boolean; token: string }
      >();
      // Independent purchase ledger: the oracle never calls effective/entitled.
      const periods = [
        { start: epoch - 100, end: epoch + 100, seats: 1, order: 0 },
      ];
      let grantNumber = 0;
      const allowance = () => {
        const active = periods.filter(
          (p) => p.start <= m.clock.now && m.clock.now < p.end,
        );
        if (active.length) return Math.max(...active.map((p) => p.seats));
        return periods
          .filter((p) => p.start <= m.clock.now)
          .toSorted((a, b) => b.start - a.start || b.order - a.order)[0]!.seats;
      };
      const paidThrough = () => Math.max(...periods.map((p) => p.end));
      const entitled = () =>
        m.clock.now < paidThrough() && !suspended && !refunded;
      for (const step of actions) {
        switch (step.kind) {
          case "activate": {
            const host = step.exempt ? "dev.test.local" : "example.test";
            const site = `${host}/site-${step.site}`;
            const existing = installations.get(step.slot);
            const count = [...installations.values()].filter(
              (i) => !i.exempt,
            ).length;
            const code = !entitled()
              ? "not_entitled"
              : existing
                ? existing.site !== site
                  ? "site_changed"
                  : undefined
                : !step.exempt && count >= allowance()
                  ? "site_limit"
                  : undefined;
            const activation = m.licensing.activate(
              key,
              `install-${step.slot}`,
              `https://${site}/?ignored=1`,
              slug,
            );
            if (code) await denied(activation, code);
            else {
              const result = await activation;
              assert.equal(result.siteAllowance, allowance());
              if (existing)
                assert.equal(
                  result.token,
                  existing.token,
                  "repeat activation must reuse its token",
                );
              tokens.add(result.token);
              installations.set(step.slot, {
                site,
                exempt: step.exempt,
                token: result.token,
              });
            }
            break;
          }
          case "deactivate": {
            const existing = installations.get(step.slot);
            if (existing) {
              await m.licensing.deactivate(existing.token);
              installations.delete(step.slot);
            } else
              await denied(
                m.licensing.deactivate("unknown-token"),
                "invalid_activation",
              );
            break;
          }
          case "replace":
            oldKeys.push(key);
            key = await m.licensing.replaceKey(license.id, license.customer_id);
            installations.clear();
            break;
          case "advance":
            m.clock.now += step.by;
            break;
          case "plan": {
            const n = ++grantNumber;
            const start = m.clock.now + (step.future ? 100 : 0);
            m.snapshot.grants.push({
              id: `grant_${n}`,
              invoiceId: `invoice_${n}`,
              priceId: `price_${step.seats}`,
              periodStart: start,
              periodEnd: start + 100,
              paidAt: epoch + n,
              settled: step.settled,
            });
            await m.billing.reconcile(m.snapshot.subscriptionId);
            if (step.settled)
              periods.push({
                start,
                end: start + 100,
                seats: step.seats,
                order: n,
              });
            break;
          }
          case "suspend":
            suspended = step.value;
            m.snapshot.suspended = suspended;
            await m.billing.reconcile(m.snapshot.subscriptionId);
            break;
          case "refund":
            refunded = true;
            m.snapshot.fullyRefunded = true;
            await m.billing.reconcile(m.snapshot.subscriptionId);
            break;
        }
        const stored = await db<License>("licenses")
          .where({ id: license.id })
          .first();
        assert.ok(stored);
        assert.equal(Number(stored.paid_through), paidThrough());
        const rows = await db<Installation>("installations").where({
          license_id: license.id,
          active: 1,
        });
        assert.equal(rows.length, installations.size);
        assert.equal(
          new Set(rows.map((i) => i.installation_id)).size,
          rows.length,
        );
        for (const token of tokens) {
          const active = [...installations.values()].find(
            (i) => i.token === token,
          );
          if (!active)
            await denied(m.licensing.status(token), "invalid_activation");
          else {
            const status = await m.licensing.status(token);
            assert.equal(status.entitled, entitled());
            // With no active grant, status can report a cached historical plan.
            // Expiry still must deny entitlement and every new activation.
            if (
              periods.some((p) => p.start <= m.clock.now && m.clock.now < p.end)
            )
              assert.equal(status.siteAllowance, allowance());
          }
        }
        for (const oldKey of oldKeys)
          await denied(
            m.licensing.activate(oldKey, "stale", "https://example.test", slug),
            "invalid_license",
          );
      }
    }),
    parameters<[Action[]]>([
      [
        [
          { kind: "activate", slot: 0, site: 0, exempt: false },
          { kind: "advance", by: 1 },
          { kind: "plan", seats: 3, future: true, settled: true },
          { kind: "advance", by: 99 },
          { kind: "activate", slot: 0, site: 0, exempt: false },
          { kind: "activate", slot: 1, site: 1, exempt: false },
          { kind: "suspend", value: false },
          { kind: "activate", slot: 1, site: 1, exempt: false },
          { kind: "advance", by: 1 },
          { kind: "activate", slot: 1, site: 1, exempt: false },
        ],
      ],
      [
        [
          { kind: "plan", seats: 3, future: true, settled: true },
          { kind: "activate", slot: 0, site: 0, exempt: false },
          { kind: "advance", by: 101 },
          { kind: "advance", by: 99 },
          { kind: "refund" },
        ],
      ],
      [
        [
          { kind: "activate", slot: 0, site: 0, exempt: false },
          { kind: "activate", slot: 0, site: 0, exempt: false },
          { kind: "activate", slot: 1, site: 1, exempt: false },
          { kind: "plan", seats: 3, future: false, settled: false },
          { kind: "activate", slot: 1, site: 1, exempt: false },
          { kind: "plan", seats: 3, future: false, settled: true },
          { kind: "activate", slot: 1, site: 1, exempt: false },
          { kind: "plan", seats: 1, future: true, settled: true },
          { kind: "advance", by: 100 },
          { kind: "activate", slot: 2, site: 2, exempt: false },
          { kind: "activate", slot: 0, site: 0, exempt: false },
          { kind: "replace" },
          { kind: "activate", slot: 0, site: 0, exempt: false },
          { kind: "deactivate", slot: 0 },
          { kind: "advance", by: 100 },
          { kind: "activate", slot: 0, site: 0, exempt: true },
        ],
      ],
    ]),
  );
});

test("invariant: concurrent activation admits only the effective paid allowance", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 1, max: 3 }),
      fc.integer({ min: 4, max: 12 }),
      async (seats, contenders) => {
        await reset(db);
        const m = await merchant(db);
        await db("plans")
          .where({ id: "primary-plan-1" })
          .update({ site_allowance: seats });
        const { key } = await purchase(db, m);
        const results = await Promise.allSettled(
          Array.from({ length: contenders }, (_, i) =>
            m.licensing.activate(
              key,
              `racer-${i}`,
              `https://site-${i}.example.test`,
              slug,
            ),
          ),
        );
        assert.equal(
          results.filter((r) => r.status === "fulfilled").length,
          seats,
        );
        for (const result of results)
          if (result.status === "rejected")
            assert.equal(result.reason.code, "site_limit");
        const rows = await db("installations").where({ active: 1, exempt: 0 });
        assert.equal(rows.length, seats);
      },
    ),
    parameters(),
  );
});
