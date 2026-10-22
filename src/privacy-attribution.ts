import { createHmac } from "node:crypto";
import { z } from "zod";
import { seal, unseal } from "./crypto.ts";
import { check } from "./errors.ts";

const identifier = z.string().min(1).max(200);
const customerIdentifier = z
  .string()
  .regex(/^cus_[A-Za-z0-9_]+$/)
  .max(150)
  .nullable();
const scopeSchema = z
  .object({
    tenantId: identifier,
    customerId: identifier,
    requestId: identifier,
    stripeLiveMode: z.boolean(),
  })
  .strict();
export type PrivacyScope = z.infer<typeof scopeSchema>;
const attributionSchema = scopeSchema.extend({
  version: z.literal(1),
  stripeCustomerId: customerIdentifier,
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().safe();
const financial = z
  .object({
    currency: z
      .string()
      .regex(/^[a-z]{3}$/)
      .optional(),
    amount: integer.optional(),
    amount_paid: integer.optional(),
    amount_refunded: integer.optional(),
    amount_due: integer.optional(),
    total: integer.optional(),
    subtotal: integer.optional(),
    tax: integer.optional(),
    starting_balance: integer.optional(),
    ending_balance: integer.optional(),
    application_fee_amount: integer.optional(),
  })
  .strict();
const retained = {
  stripeLiveMode: z.boolean(),
  events: z
    .array(
      z
        .object({
          id: identifier,
          type: identifier,
          payloadHash: digest,
          financial,
        })
        .strict(),
    )
    .max(10000),
  invoices: z
    .array(
      z
        .object({
          invoice_id: identifier,
          currency: z.string().regex(/^[a-z]{3}$/),
          paid_minor: z.coerce.number().int().safe().nonnegative(),
          refunded_minor: z.coerce.number().int().safe().nonnegative(),
        })
        .strict(),
    )
    .max(10000)
    .optional(),
  workIds: z.array(identifier).max(1000).optional(),
  auditIds: z.array(identifier).max(1000).optional(),
  outgoingEventIds: z.array(identifier).max(1000).optional(),
};
const localSchema = z
  .object({
    ...retained,
    referenceDigests: z.array(digest).max(10000),
    stripeCustomerAttribution: z.string().min(1).max(4096).optional(),
  })
  .strict();
const portableSchema = z
  .object({ ...retained, stripeCustomerId: customerIdentifier })
  .strict();

export function privacyReferenceDigest(secret: string, value: string) {
  return createHmac("sha256", Buffer.from(secret, "hex"))
    .update(`privacy-reference:${value}`)
    .digest("hex");
}
export function sealPrivacyAttribution(
  scope: PrivacyScope,
  stripeCustomerId: string | null,
  secret: string,
) {
  return seal(
    attributionSchema.parse({ version: 1, ...scope, stripeCustomerId }),
    secret,
  );
}
export function unsealPrivacyAttribution(
  value: string,
  scope: PrivacyScope,
  secret: string,
) {
  const expected = scopeSchema.parse(scope);
  const attribution = attributionSchema.parse(unseal(value, secret));
  check(
    attribution.tenantId === expected.tenantId &&
      attribution.customerId === expected.customerId &&
      attribution.requestId === expected.requestId &&
      attribution.stripeLiveMode === expected.stripeLiveMode,
    409,
    "privacy_attribution_mismatch",
    "Retained provider attribution must match the exact closure and provider mode.",
  );
  return attribution.stripeCustomerId;
}
/** Output contains one financial identifier. Keep it only inside the passphrase-encrypted manifest. */
export function exportPrivacyReceipt(
  details: string,
  scope: PrivacyScope,
  secret: string,
) {
  const local = localSchema.parse(JSON.parse(details));
  check(
    local.stripeLiveMode === scope.stripeLiveMode,
    409,
    "privacy_attribution_mismatch",
    "Retained receipt mode must match the closure scope.",
  );
  check(
    local.stripeCustomerAttribution,
    409,
    "privacy_attribution_upgrade_required",
    "Run the reviewed closure-attribution-upgrade maintenance command before transfer.",
  );
  const stripeCustomerId = unsealPrivacyAttribution(
    local.stripeCustomerAttribution,
    scope,
    secret,
  );
  const { referenceDigests, stripeCustomerAttribution, ...values } = local;
  void referenceDigests;
  void stripeCustomerAttribution;
  return JSON.stringify(portableSchema.parse({ ...values, stripeCustomerId }));
}
/** The importer supplies the destination tenant scope. No source verifier key is retained. */
export function importPrivacyReceipt(
  details: string,
  scope: PrivacyScope,
  secret: string,
) {
  const portable = portableSchema.parse(JSON.parse(details));
  check(
    portable.stripeLiveMode === scope.stripeLiveMode,
    409,
    "privacy_attribution_mismatch",
    "Imported receipt mode must match the destination scope.",
  );
  const { stripeCustomerId, ...values } = portable;
  return JSON.stringify({
    ...values,
    referenceDigests: [
      ...(stripeCustomerId === null
        ? []
        : [privacyReferenceDigest(secret, stripeCustomerId)]),
      privacyReferenceDigest(secret, scope.customerId),
    ],
    stripeCustomerAttribution: sealPrivacyAttribution(
      scope,
      stripeCustomerId,
      secret,
    ),
  });
}
