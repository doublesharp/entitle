# Hosted application fees

The hosted default is 1% per subscription invoice, with no fixed application
fee, in addition to the existing platform subscription and the seller's own
Stripe fees. Standalone collects no application fee and needs no subscription
to Doublesharp. The platform subscription price still comes from
PLATFORM_STRIPE_PRICE_ID; this change does not invent or publish a monthly price.

## Hosted and self-hosted costs

| Charge or responsibility | Hosted service | Self-hosted standalone |
| --- | --- | --- |
| Platform subscription | Operator-configured Stripe price, shown at checkout | None |
| Application fee | Configurable; default 1% on new subscriptions and their renewals | None |
| Stripe charges | Seller pays their Stripe fees separately | Publisher pays their Stripe fees directly |
| Infrastructure | Operated by the hosted provider, within the service allowances | Publisher supplies and pays for compute, database, S3, email and backups |
| Capacity | Trial/paid platform allowances shown in the dashboard | Operator-configured product, storage, upload and security limits |

Both versions use the publisher's Stripe account for buyer payments and provide
the same core licensing/update workflows. Self-hosting avoids platform charges;
it does not remove provider costs or operating work. The planned hosted address
and self-hosting entry points are in [README](../README.md#hosted-or-self-hosted).
See [deployment](deployment.md) for the two setup paths and licensing boundary.
This page does not establish a public launch, fixed subscription price or SLA.

## Basis for the rate

Pricing checked on 2026-10-21: [Freemius](https://freemius.com/pricing/) lists
3.8% + $0.50 plus gateway fees, with an additional 2.3% for its WordPress
solution. [Lemon Squeezy](https://www.lemonsqueezy.com/pricing) lists a base
5% + $0.50 including processing and merchant-of-record services, with possible
additional fees. Their merchant-of-record services include tax/compliance
responsibilities that Entitle does not assume. Do not present these as
equivalent services or claim Entitle is always cheapest.

Standard connected accounts using direct charges pay their Stripe processing,
Billing and other service fees. Stripe's account-paid configuration currently
has no additional Connect account/payout fees according to
[Stripe's fee responsibility documentation](https://docs.stripe.com/connect/direct-charges-fee-payer-behavior).
Confirm that responsibility on actual connected accounts before launching.

Our 1% is revenue toward storage, download egress, database/compute, email,
backups, support and engineering. Illustrative revenue before our operating
costs is $0.20 on a $20 invoice, $1 on $100, or $100 on $10,000 sales volume.
These are arithmetic examples, not measured costs or profit forecasts. A
seller's low sales can coexist with heavy download/support usage; retain the
platform subscription and bounded storage/product allowances. Measure paid
storage, bytes served, requests, email and support costs before expanding them.

## Configuration and behavior

Set DEPLOYMENT_MODE=hosted. HOSTED_APPLICATION_FEE_PERCENT defaults to 1 and
accepts 0-100 with at most two decimal places. Zero omits the fee parameter.
Standalone defaults to zero and rejects an explicitly nonzero setting.
The browser and seller API cannot override the rate.

Checkout passes subscription_data.application_fee_percent on the seller's
connected account for both Stripe-hosted Checkout and Elements. Stripe retains
that rate on the resulting subscription for renewals. Changing environment
configuration changes newly created subscriptions only, and does not rewrite
existing subscriptions or already-open Checkout Sessions. An existing-subscription
fee migration needs a separate deliberate process and seller communication.
The existing operator exemption covers platform subscription charges only;
it does not grant an application-fee exemption.

Stripe calculates the fee on the final invoice amount, including relevant
adjustments. Fees for independently created or immediately invoiced proration
invoices are not automatically covered by the subscription percentage. See
[Stripe subscription fees](https://docs.stripe.com/connect/subscriptions#collect-fees-on-subscriptions).
The hosted dashboard discloses the configured rate and separate Stripe charges.

## Refunds and reporting

Application fees are retained on refunds by default in this version. Do not
promise an automatic fee refund. For a refund initiated through Stripe, an
operator may separately refund the application fee through the platform Stripe
Dashboard/API. Reconcile that action in Stripe; this change does not introduce
automatic fee-refund execution or a fee-refund retry queue. See
[Stripe direct charge refunds](https://docs.stripe.com/connect/direct-charges?platform=web&ui=stripe-hosted#refunds).

Actual application fees and their refunds are available in Stripe's Collected
fees view. Entitle's existing payment metrics remain gross paid/refunded
invoice amounts grouped by currency, not seller net proceeds or platform profit.
No live charges, bank payouts or cost/profitability acceptance are claimed by
local fixture verification.

## Hosted Starter and monthly Pro

Hosted Starter includes licensing and updates, customer recovery, seller security,
Stripe tax settings, sandbox workspaces, customer export and closure requests,
encrypted tenant exports, basic operating health, and lifecycle notices.
Hosted Pro adds signed outbound webhooks, advanced daily bandwidth reports, and
integrations built on those signed events. These capabilities use
the same application and database-backed worker.

Configure `PLATFORM_PRO_STRIPE_PRICE_ID` to enable Pro purchases. It must identify
an active, positive, monthly recurring Stripe price, distinct from the Starter
`PLATFORM_STRIPE_PRICE_ID`. The browser chooses the tier, never an arbitrary
price or amount. Platform billing uses a dedicated server-created Stripe Portal
configuration. Each session verifies that price switching is disabled and
cancellation takes effect at period end without prorations. A subscribed seller
must cancel renewal, wait for canonical cancellation at the paid period end,
then choose the new tier in Checkout. Immediate tier changes are unavailable.
Only reconciled paid invoices grant Pro, so an unpaid upgrade,
trial, capacity exemption, or checkout redirect cannot enable it. Cancellation
and downgrade preserve the already-paid Pro period. Full refund and dispute
handling apply to the affected grants.

Pro expiration pauses advanced delivery and reporting access. During the bounded
`GRACE_DAYS` renewal window, business events remain pending so a subsequently paid
contiguous renewal can qualify them. An expired grace, explicit revocation, or a
later paid period that excludes those events suppresses them permanently.
Never-Pro workspaces do not receive historical backfill. This retention window
does not enable unpaid Pro features. Pro expiration preserves
core security, account recovery, exports, and the buyers' existing paid download
rights. Standalone installations have all local capabilities without a platform
subscription, application fee, or licensing callback to the hosted service.
No monthly dollar price is published here; review the operator-configured amount
in Stripe before subscribing.

## Credit and plan-change policy

Canonical invoices paid from a matching Stripe customer-balance credit can grant
Pro even when cash paid on that invoice is zero. The credit ledger must identify
the same invoice, customer, currency and Stripe mode and cover its positive
value after reversals. Deferred minimum-charge debt, zero-value invoices and free
coupons do not qualify.

A paid negative proration that identifies its original debit invoice and line
shortens that original grant at the returned period's start. Reconciliation
reconstructs and reapplies these adjustments idempotently. A cancellation or
ordinary downgrade without a returned paid-time credit preserves the paid period.

Classic/manual credits without Stripe `credited_items` attribution cannot safely
identify the original grant. The platform enforces its safe Portal policy in
code and refuses a changed configuration; it never falls back to the account's
default Portal. Operator-created immediate unlinked-credit downgrades remain
unsupported. Local canonical-provider fixtures test accounting and idempotency;
real Stripe test-account Portal qualification is still required before release.
See [Stripe prorations](https://docs.stripe.com/billing/subscriptions/prorations).

Customer-balance settlement identifies the receiving invoice, not the entire
history of the funds. If an operator refunds or loses a dispute on the payment
that funded credit, review and remove the corresponding unused Stripe customer
balance before it buys further service. This review is an operator responsibility;
the service does not claim automatic credit-source tracing. If credit has already funded Pro, place the affected service under operator review and reconcile any hold explicitly; removing only unused balance cannot reverse spent credit.

Verified historical price/tier mappings are durable and mode-specific. Archiving
an old price stops new sales without stopping its existing renewals, refunds or
dispute reconciliation. Changing current price configuration does not reclassify
an already-verified historical price into another tier.
