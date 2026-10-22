# Multitenant SaaS design

Status: approved for implementation by the user on 2026-10-21. Subsequent user
instructions add site metrics and require capped, private S3-compatible release
storage with additional security controls. Stripe Elements custom checkout was also requested on 2026-10-21; see
[stripe-elements-design.md](stripe-elements-design.md).

The user selected `https://entitle.doublesharp.com` as the planned hosted origin on
2026-10-21. The product name remains Double Entitle. This records the hosting
decision; DNS changes and production deployment remain separate work.


Subsequent user instructions also require framework adapters and per-product app
differentiation; see [framework-adapters-design.md](framework-adapters-design.md).
WordPress-specific release validation stays strict for WordPress products.

Release storage will use an S3 adapter and a private MinIO development bucket.
The default ZIP limit is 25 MiB, configurable up to a hard 100 MiB ceiling.
Trials share a seller-anchored 14-day cutoff and allow three products / 100 MiB.
A paid platform invoice raises allowances to 20 products / 1 GiB by default,
preserving any larger operator allocation. Sellers can create at most three tenants. ZIP inspection also bounds
expanded bytes, compression ratio and entry count, rejects encrypted entries,
links and unsafe paths, and verifies CRC and WordPress plugin identity. Private
objects use generated tenant/release keys, conditional immutable creation and
SHA-256 verification. Package URLs remain authenticated application endpoints.
No seller can configure a storage endpoint, object key, credential or redirect.

Seller dashboards will report actual license, activation, artifact-storage,
download and billing metrics. Monetary figures are grouped by currency and
identify their inclusion of taxes and exclusion of provider fees. Public pages
will show only verified product facts or explicitly identified measurements,
without invented adoption, performance or uptime claims.

Double Entitle will serve independent software publishers from one Fastify
deployment and one database. Each publisher is a tenant. Our plugins belong to
the first tenant and use the same seller and customer workflows as other tenants.
SQLite remains available for local development and small installations;
PostgreSQL and MySQL continue to use the same migrations and business logic.
The service remains self-hostable.

The user explicitly removed the legacy API compatibility requirement. All
customer and software-client routes will require tenant context. The example PHP
client, local WordPress fixtures, CLI, tests and documentation will change
together. There will be no unscoped aliases or legacy route fallback.

## Scope and payment ownership

The first SaaS version includes seller signup and email login, a seller web
interface, tenant management, product and plan setup, release publication,
license inspection and revocation, tenant API keys, Stripe account connection,
and platform subscription billing. Existing customer licensing, downloads,
installation management and WordPress updates remain available within a tenant.
Every web workflow has an API counterpart.

Sellers connect their own Stripe accounts through Stripe Connect Standard OAuth.
Plugin buyers pay through Checkout on that connected account. Double Entitle
does not collect the purchase into its own account and then distribute proceeds.
Hosted deployment now adds a configurable application fee, default 1%, on newly
created license subscriptions and their renewals; existing subscriptions remain
unchanged. Standalone uses the primary merchant's own Stripe account directly
with no platform subscription or application fee. See hosted-pricing.md and
deployment.md for mode configuration. The seller remains responsible for
their commerce and tax obligations. Double Entitle is not a merchant-of-record
service.

The platform charges sellers a separate subscription using its own Stripe
account and server-configured prices. No public launch price is chosen by this
design. Environment configuration supplies the permitted SaaS price mappings.
An internal tenant can have a platform-operator exemption. A configurable trial
supports onboarding before a platform subscription is required. Neither status
can be granted by an ordinary seller request.

USDC, affiliates, coupons, usage billing, beta channels, staged rollouts,
custom domains, a marketplace and advanced team roles remain outside this change.

## Tenant and identity boundaries

New platform tables store tenants, seller identities, owner memberships,
seller login tokens, seller sessions, tenant API keys, platform billing state,
OAuth state and operator audit records. Owners can belong to multiple tenants.
Buyer identities remain scoped to the seller they bought from. Seller login
does not imply buyer access, or the reverse.

Every business table gets a required tenant ID, including products, plans,
customers, licenses, grants, installations, releases, billing events, jobs,
email delivery state, buyer login tokens and buyer sessions. Provider IDs,
product slugs and customer emails are unique within the appropriate tenant and
provider account, rather than across unrelated sellers. Database constraints
prevent relationships between records from different tenants. All three
database engines must reject those relationships directly.

Business services receive explicit, immutable tenant context. They do not
derive authority from caller-supplied object IDs, a tenant header or Stripe
metadata. Seller sessions must have a live membership for the selected tenant.
API keys are high-entropy secrets stored as hashes and bound to one tenant.
Customer sessions, activation tokens and license keys cannot authorize an action
through another tenant's route. Global operator credentials are never accepted
as ordinary seller credentials and never exposed to the browser or PHP client.

The tenant slug selects a public namespace and becomes immutable after creation.
Private files use server-generated tenant and release IDs. Tenant names, slugs,
ZIP contents and uploaded filenames never select arbitrary filesystem paths.

## Routes and interfaces

- `/api/v1/platform/*`: seller authentication, tenant creation and membership,
  platform subscription checkout and billing portal.
- `/api/v1/tenants/:tenant/*`: tenant catalog, buyer authentication, checkout,
  buyer portal, activation, update metadata and private package downloads.
- `/api/v1/tenants/:tenant/seller/*`: authenticated tenant administration,
  publication, license operations, API keys and reconciliation requests.
- `/api/v1/operator/*`: platform-only inspection, exemptions, tenant lifecycle
  and recovery operations.
- `/api/v1/stripe/platform-webhook`: signed events for platform subscriptions.
- `/api/v1/stripe/connect-webhook`: signed events for connected sellers.

The Vue application has a seller area and tenant-specific buyer pages under
`/t/:tenant`. Both use the versioned API. Seller and buyer session cookies have
separate names. Sessions remain server-side, expiring and HttpOnly. Login links
remain single-use and require explicit confirmation. Same-origin checks and
session-bound CSRF protect authenticated browser mutations. A supplied tenant
selector never replaces ownership checks.

The WordPress client is configured with the full tenant API base. Update
metadata returns stable package URLs under that same base. The client checks
the complete origin, tenant API path, release URL and checksum before attaching
its activation token. Delayed downloads still recheck current entitlement.

## Stripe and durable work

OAuth state is random, hashed, short-lived, single-use and bound to an
authenticated seller, tenant and fixed callback. The server exchanges the code
and verifies the resulting connected account. It does not accept an account ID
from the browser as proof of ownership. Each connected account belongs to one
tenant. After commerce records exist, account references cannot silently move
to another seller or account.

Every seller Stripe request, including pagination, reconciliation, Checkout,
Customer Portal and refunds/disputes lookup, runs in that tenant's connected
account context. Signed Connect events select the tenant through the verified
top-level account ID and the stored account mapping. Unknown accounts cannot
create tenant data. Test and live events are separated according to configured
mode. Subscription metadata is descriptive, not authorization.

Platform subscription events use a separate receiver, records and business
logic. They never create a plugin license. Both receivers verify raw-body
signatures, durably persist receipts and use retryable reconciliation rather
than granting access from redirects or trusting event order. Queued work
persists its tenant and provider context; workers do not inherit context from
the most recent HTTP request. Lease checks, stable idempotency keys and bounded
retries remain mandatory.

Platform subscription delinquency blocks new sales, publication and other
capacity-increasing seller operations after the configured grace period.
Existing buyer-paid download rights, license recovery, deactivation and
billing reconciliation remain available. An explicit platform-operator abuse
suspension can block service access, with an audit record and recovery path.
Installed plugin features continue working in every case. Disconnecting Stripe
blocks new commerce without erasing already-paid grants.

## Storage, quotas and operations

ZIPs use private S3-compatible object storage; the local volume holds the database and temporary verification work only. Upload verification,
immutability, checksums and withdrawal behavior remain in force. Publication
reserves tenant storage transactionally so concurrent uploads cannot exceed a
configured allowance; failures release reservations. Limits cover products,
stored artifacts, upload size and API rates. Download usage can be observed;
usage-based billing is deferred.

Authentication limits include IP-based abuse controls. Authenticated operations
also have tenant/principal limits so one tenant cannot exhaust another's
allowance. Webhooks, jobs and uploads have bounded work. Audit records cover
membership, API-key lifecycle, Stripe connection, publication, revocation and
platform suspension without recording credentials or encrypted message contents.

Existing local data is assigned to a first tenant by a forward migration. This
preserves data, not old API behavior. Old sessions are invalidated. The migration
and any private-file relocation must be restart-safe and must preserve the
original artifact until its tenant destination is verified. Existing raw ZIP
bytes and checksums do not change. A pre-migration backup is required before
updating a populated installation; no development database is silently deleted.

One application still serves the API and Vue build. No Redis, Kubernetes or
microservices are introduced. Releases require a private S3-compatible bucket,
which may be self-hosted or supplied by a storage provider. Backup/restore covers
the shared database, every tenant's artifacts, application secrets and platform
configuration. SQLite remains the inexpensive starting deployment; production
load testing, rather than tenant count alone, determines when to use PostgreSQL.

## Verification and delivery

The existing 100% lines, branches and functions gate remains enforced per
executable TypeScript module. Tests must exercise behavior and rejection paths,
not remove application files from the denominator or lower thresholds.

Required regression scenarios include:

- Two tenants with identical customer emails, product slugs and provider IDs.
- Cross-tenant reads, writes, sessions, API keys, installation tokens, product
  setup, ZIP publication, job processing and package downloads rejected.
- Database constraints, fresh migrations, populated upgrades and migration
  retries exercised on SQLite, PostgreSQL and MySQL.
- Seller email signup/login, token replay, CSRF, session expiry and tenant
  ownership checks; seller and buyer session confusion rejected.
- OAuth state replay, expiry, wrong-session use and account-binding conflicts.
- Stripe requests and pagination isolated by connected account, unknown/mismatched
  webhook accounts rejected, and platform events separated from plugin billing.
- Existing paid purchase, renewal, cancellation, failed payment, paid/unpaid
  upgrade, refund, dispute and reconciliation scenarios retained per tenant.
- Platform billing/trial/grace/exemption behavior without reducing buyer grants.
- Concurrent activation limits, storage reservations and duplicate publication.
- Tenant-aware WordPress discovery, cached/delayed package downloads, normal
  updates, WP-CLI and automatic-updater paths on real local WordPress.
- Browser seller setup and buyer download flows, real SMTP to Mailpit, Docker
  startup and restore of at least two tenants from one backup.

The local fixture mode supports seller signup, two tenants, simulated Connect
and platform billing, email login and real ZIP downloads without external
credentials. Fixtures remain prohibited in production. Live Stripe integration
is exercised only if test-account credentials are supplied privately; otherwise
the delivery report explicitly identifies that integration as unexercised.
No production deployment, service purchases or live charges are authorized.

## Implementation sequence

1. Add tenant schema and constraints, populated-data migration, explicit tenant
   service context and tests against all three databases.
2. Add separate seller identity/session handling, tenant membership and API-key
   management; move all business routes to tenant namespaces.
3. Add Connect onboarding/account context and isolated platform billing with
   signature, retry, reconciliation and account-boundary regressions.
4. Add seller Vue workflows, tenant-aware buyer UI, authenticated publication,
   quotas, audit records and operator CLI changes.
5. Update the PHP client and local WordPress fixtures. Run browser, database,
   WordPress, Docker/recovery and 100% coverage verification; fix verified bugs.
6. Update API, setup, deployment and recovery documentation with measured results
   and external integration limits.

Official Stripe references checked for this design:

- [SaaS platform model](https://docs.stripe.com/connect/saas)
- [Standard account onboarding](https://docs.stripe.com/connect/standard-accounts)
- [Connect webhook account context](https://docs.stripe.com/connect/webhooks)
