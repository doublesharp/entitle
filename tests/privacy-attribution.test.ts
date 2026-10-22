import test from "node:test";
import assert from "node:assert/strict";
import { seal, unseal } from "../src/crypto.ts";

const module = await import("../src/privacy-attribution.ts").catch(
  () => undefined,
);
const source = "ab".repeat(32),
  destination = "cd".repeat(32);
const scope = {
  tenantId: "tenant-one",
  customerId: "closed",
  requestId: "request",
  stripeLiveMode: false,
};
const digest = "0".repeat(64);
const details = () => ({
  referenceDigests: [digest],
  stripeLiveMode: false,
  events: [
    {
      id: "evt_one",
      type: "charge.refunded",
      payloadHash: digest,
      financial: { amount: 500, amount_refunded: 500, currency: "usd" },
    },
  ],
  invoices: [
    {
      invoice_id: "in_one",
      currency: "usd",
      paid_minor: 500,
      refunded_minor: 500,
    },
  ],
  workIds: ["job"],
  auditIds: ["audit"],
  outgoingEventIds: ["outgoing"],
});

test("privacy attribution roundtrips only the allowlisted identifier and rekeys destination digests", () => {
  assert.ok(module, "privacy helper is implemented");
  const local = {
    ...details(),
    stripeCustomerAttribution: module.sealPrivacyAttribution(
      scope,
      "cus_closed",
      source,
    ),
  };
  assert.ok(!JSON.stringify(local).includes("cus_closed"));
  const portable = module.exportPrivacyReceipt(
    JSON.stringify(local),
    scope,
    source,
  );
  const value = JSON.parse(portable);
  assert.equal(value.stripeCustomerId, "cus_closed");
  assert.equal(value.referenceDigests, undefined);
  assert.equal(value.stripeCustomerAttribution, undefined);
  assert.ok(!portable.includes(source));
  assert.deepEqual(value.events, local.events);
  const nextScope = { ...scope, tenantId: "primary" };
  const restored = JSON.parse(
    module.importPrivacyReceipt(portable, nextScope, destination),
  );
  assert.deepEqual(restored.referenceDigests, [
    module.privacyReferenceDigest(destination, "cus_closed"),
    module.privacyReferenceDigest(destination, scope.customerId),
  ]);
  assert.deepEqual(unseal(restored.stripeCustomerAttribution, destination), {
    version: 1,
    ...nextScope,
    stripeCustomerId: "cus_closed",
  });
  assert.throws(() => unseal(restored.stripeCustomerAttribution, source));
  assert.equal(restored.stripeCustomerId, undefined);
  assert.ok(!JSON.stringify(restored).includes("cus_closed"));
});

test("source attribution authenticates tenant customer request and provider mode", () => {
  assert.ok(module);
  const raw = JSON.stringify({
    ...details(),
    stripeCustomerAttribution: module.sealPrivacyAttribution(
      scope,
      "cus_closed",
      source,
    ),
  });
  for (const changed of [
    { tenantId: "other" },
    { customerId: "other" },
    { requestId: "other" },
    { stripeLiveMode: true },
  ])
    assert.throws(() =>
      module.exportPrivacyReceipt(raw, { ...scope, ...changed }, source),
    );
  assert.throws(() => module.exportPrivacyReceipt(raw, scope, destination));
  const forged = JSON.stringify({
    ...details(),
    stripeCustomerAttribution: seal(
      {
        version: 1,
        ...scope,
        stripeCustomerId: "cus_closed",
        extra: "private",
      },
      source,
    ),
  });
  assert.throws(() => module.exportPrivacyReceipt(forged, scope, source));
});

test("portable receipt rejects unreviewed legacy attribution, arbitrary keys and financial PII", () => {
  assert.ok(module);
  assert.throws(
    () => module.exportPrivacyReceipt(JSON.stringify(details()), scope, source),
    { code: "privacy_attribution_upgrade_required" },
  );
  for (const changed of [
    { stripeCustomerId: "cus_bad" },
    { secret: source },
    {
      events: [
        {
          ...details().events[0],
          financial: { email: "private@example.test" },
        },
      ],
    },
    { stripeLiveMode: true },
  ]) {
    const raw = JSON.stringify({
      ...details(),
      stripeCustomerAttribution: module.sealPrivacyAttribution(
        scope,
        "cus_closed",
        source,
      ),
      ...changed,
    });
    assert.throws(() => module.exportPrivacyReceipt(raw, scope, source));
  }
  const portable = { ...details(), stripeCustomerId: "cus_closed" } as Record<
    string,
    unknown
  >;
  delete portable.referenceDigests;
  assert.throws(() =>
    module.importPrivacyReceipt(
      JSON.stringify({ ...portable, stripeCustomerAttribution: "secret" }),
      scope,
      destination,
    ),
  );
  assert.throws(() =>
    module.importPrivacyReceipt(
      JSON.stringify({ ...portable, stripeLiveMode: true }),
      scope,
      destination,
    ),
  );
  assert.throws(() =>
    module.sealPrivacyAttribution(scope, "email@example.test", source),
  );
  assert.throws(() =>
    module.sealPrivacyAttribution({ ...scope, tenantId: "" }, null, source),
  );
});

test("reviewed no-provider receipts retain null encrypted attribution and minimal late shapes", () => {
  assert.ok(module);
  const raw = JSON.stringify({
    referenceDigests: [],
    stripeLiveMode: false,
    events: [],
    stripeCustomerAttribution: module.sealPrivacyAttribution(
      scope,
      null,
      source,
    ),
  });
  const portable = module.exportPrivacyReceipt(raw, scope, source);
  const restored = JSON.parse(
    module.importPrivacyReceipt(portable, scope, destination),
  );
  assert.deepEqual(restored.referenceDigests, [
    module.privacyReferenceDigest(destination, scope.customerId),
  ]);
  assert.deepEqual(
    unseal<{ stripeCustomerId: null }>(
      restored.stripeCustomerAttribution,
      destination,
    ).stripeCustomerId,
    null,
  );
  assert.equal(restored.invoices, undefined);
});
