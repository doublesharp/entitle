# Multitenant SaaS implementation plan

> Execute the approved design in `docs/saas-design.md` continuously. Use
> test-driven changes and independent review. The workspace has no Git history;
> preserve the current checkout and do not create a pretend upstream baseline.

## Constraints

- One Fastify application and Vue build; Node 26.12.0, TS 7.0.2, pnpm 12.14.0.
- SQLite, PostgreSQL and MySQL use real migrations and shared business logic.
- Every executable application TS module retains a 100% coverage requirement.
- Tenant-only APIs; update PHP example and local fixtures together.
- Private S3-compatible storage, 25 MiB default ZIP limit, 100 MiB hard ceiling,
  1 GiB default tenant storage. No credentials or signed storage URLs in clients.
- No production deployment, purchases, live charges, USDC or merchant-of-record
  functionality. Test integration gaps must be reported explicitly.
- All temporary files, dependency caches, builds and evidence stay on Scratch.

## Shared contracts

`Tenant` is exported from `src/db.ts`: `id`, `slug`, `name`,
`stripe_account_id: string | null`, `platform_customer_id: string | null`,
`platform_subscription_id: string | null`, `billing_status`, `paid_through`,
`trial_ends_at`, `exempt`, `suspended`, `max_products`, `max_storage_bytes`,
`created_at`. Numeric flags/timestamps follow the existing DB conventions.
`TenantContext = Pick<Tenant, "id" | "slug" | "name">` is also exported.

Every business service receives explicit tenant context. All owned records
include `tenant_id`; there is no default tenant argument in production services.
`lock(tx, name, tenantId?)` namespaces business locks by tenant; omission is for
platform-wide operations only. Tenant creation seeds five namespaced lock rows
for auth, billing, email, schema and work. Existing local records migrate to
the bootstrap tenant `id=primary`, `slug=primary`, with an operator exemption.

Canonical buyer/software APIs are `/api/v1/tenants/:tenant/*`; tenant seller APIs
are `/api/v1/tenants/:tenant/seller/*`. Platform identities, signup, tenant
creation and seller sessions use `/api/v1/platform/*`. Platform-only operations
use `/api/v1/operator/*`. Buyer pages are `/t/:tenant`; the seller area is
`/seller`. No former unscoped buyer or operator-business route remains.

New platform tables: `seller_users`, `seller_memberships`, `seller_login_tokens`,
`seller_sessions`, `tenant_api_keys`, `oauth_states`, `audit_events`,
`platform_events`, `platform_work`, `platform_emails`. Generic queue fields mirror
the current durable work table. Platform email recipient is stored only inside
encrypted message payloads. `upload_reservations` stores tenant, ID, byte count
and expiry. `invoice_metrics` stores tenant/invoice ID, currency, paid and refunded
minor units; `download_metrics` stores tenant/release/day and successful responses.

## Task 1: Tenant schema and constraints

Owner: schema implementer. Files: `src/db.ts`, migration 003, schema-specific
tests. First write/run failing tests for duplicate namespaces and forbidden
cross-tenant foreign keys. Build a forward migration preserving existing rows,
invalidate old sessions/login links and safely rerun after success. Add composite
foreign keys and scoped unique constraints. Preserve binary MySQL collation.
Export the shared types, tenant creation helper and reset/seed test utilities.
Run SQLite tests first and real PostgreSQL/MySQL tests after local services start.

## Task 2: Seller identity and platform administration

Owner: platform identity implementer. New modules `src/platform-auth.ts` and
`src/tenants.ts`, their tests; do not edit app routing or the shared schema.
Implement verified-email signup/login, distinct seller cookies, CSRF, owner
memberships, tenant creation, revocable tenant API keys and audit writes.
Use existing encrypted outbox message shape and generic durable queue behavior.
Expose services for root integration; cookie/session authentication returns
`{user, csrfToken, sessionHash}`. Tenant authorization returns the live tenant
after membership or tenant-key checks. Owner-only account/key management requires
an interactive seller session. No role or exemption comes from client payloads.

## Task 3: Object storage and release security

Owner: storage implementer. New `src/storage.ts` plus storage tests and focused
ZIP validation changes/tests in `src/releases.ts`; coordinate its release-file
ownership with the root before editing. Define `ArtifactStore` with immutable
`put(tenantId, releaseId, bytes, checksum)`, verified bounded
`get(tenantId, releaseId, checksum, size)`, `delete`, and `ready`. Put/get return
bytes, never public URLs. A local in-memory fixture implements the interface for
unit tests. Production uses the maintained AWS S3 SDK with environment-only
configuration, timeouts, private generated keys and conditional writes. Record
and pin the verified exact dependency version. Exercise actual MinIO later.

## Task 4: Tenant business services and routes

Owner: root integration. First add failing two-tenant behavior tests. Require
tenant context in licensing, billing, buyer auth, email, releases and workers.
Scope every query, write and row lock. Move business operator routes into seller
routes with per-action authorization. Replace local release reads with storage
adapter calls and transactional upload reservations. Preserve stable package URLs
and current buyer rights through platform delinquency. Track verified downloads.
Adapt existing regression fixtures to explicit tenant IDs rather than preserve
legacy behavior. Retain all purchase/refund/dispute/security regression scenarios.

## Task 5: Connected payments and platform subscriptions

Owner: payments implementer after schema/identity contracts land. Modify
`src/stripe.ts`, add `src/platform-billing.ts`, tests. Put connected account
options on every seller Stripe call including pagination. Add single-use,
session-bound Standard OAuth connection, account ownership checks and immutable
mapping after commerce. Signed Connect events route by verified event account;
platform subscription events are separate. Persist and reconcile invoice metrics
idempotently. Trial defaults to 14 days and delinquency grace to 7 days, both
operator-configurable. Platform subscription prices come from environment values.

## Task 6: Web workflows, metrics, CLI and WordPress

Owner: UI implementer for `web/*` after API contracts are fixed; root owns CLI
and PHP integration. Seller routes cover email login, tenant creation/selection,
Stripe connection, product/plan setup, publication, license inspection/revocation,
API keys, platform billing and actual tenant metrics. Buyer interface uses tenant
API context. Landing page states verified facts and shows no fabricated metrics.
Add guided setup and copyable tenant-specific PHP configuration. Update CLI to
use tenant keys for business operations and operator token for platform actions.
Update local WordPress fixture URLs and execute real update workflows.

## Task 7: Verification and independent review

Use targeted failing/passing regression runs during implementation. Then run the
full suite, strict TS7/ESLint, build and 100% per-module coverage gate with real
MySQL enabled. Run business/security suites against PostgreSQL/MySQL, real MinIO
put/get/private access, browser seller/buyer flows, real WordPress UI/WP-CLI/auto
updates, Docker startup and a two-tenant backup/restore. Independently review
tenant isolation, OAuth, Stripe account routing, artifact publication and quotas;
reproduce and fix findings, then re-review. Update setup/API/deployment/recovery
docs with exact measured results and explicitly unexercised external services.

## Progress

- Design approved. User removed legacy API support and required S3 security caps.
- Baseline: 184 tests passed, one MySQL integration skipped, TS7 and ESLint passed.
- Implementation in progress; no SaaS completion or integration claim yet.
