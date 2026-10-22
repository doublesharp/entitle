# Hosted and self-hosted feature expansion

User approved implementation with subagents, full coverage and fast parallel execution on 2026-10-21. Subsequent decision: monthly Pro tiers apply to hosted customers first. No fixed public dollar price is selected.

## Product rules

One application, shared database, SQLite/PostgreSQL/MySQL migrations and optional Redis remain. Core licensing, buyer recovery, security, sandbox testing, tax configuration, data export and basic health alerts are available in every edition. Hosted Pro adds signed outgoing webhooks, configurable automations and advanced reporting. Self-hosted local features do not require a platform subscription or phone home. Existing buyer paid download rights remain independent of seller platform/Pro billing. No billing state disables installed functionality.

Stripe platform prices are operator-controlled. Existing platform price remains Starter; an optional additional monthly price enables Pro. Paid invoices, not redirects, unpaid upgrades or status alone, grant Pro. Preserve already-paid periods on cancellation/downgrade. No external paid service, live charge or production deployment is authorized.

## Parallel ownership

- Commerce agent: Stripe and platform billing, tax settings, plan feature entitlement module, migration 008 and scoped tests.
- Accounts agent: authentication service extensions, email changes, sessions, recovery codes, sensitive-action confirmation, customer export/closure/privacy, migration 009 and scoped tests.
- Operations agent: metrics, health alerts, lifecycle notices, signed outbound event delivery, migration 010 and scoped tests.
- Root: shared configuration, database migration registration, app/API/CLI integration, sandbox environment, portability, larger/streamed native artifacts, Vue workflow integration, docs, source distribution, review and final gates. Further bounded delegated tasks follow as slots become available.

Shared files have a single owner. Agents use separate test fixtures, never reset parent databases and never run competing whole-app builds. Raw logs, source snapshots, caches and temporary artifacts stay on Scratch.

## Scope and acceptance

1. Per-publisher sandbox: an explicit isolated test workspace with distinct customers, licenses, activation tokens, release storage and buyer URL. Synthetic testing works without paid credentials; optional server-configured Stripe test credentials exercise real test-mode Checkout. Test webhooks never enter live business state. Clear sandbox labels and isolated account context are mandatory.
2. Tax-ready checkout: opt-in server-controlled automatic tax, tax-ID/address collection, compatible with Stripe-hosted Checkout and Elements. Keep registration/tax provider configuration explicit and never infer a completed compliance service.
3. Operating visibility: served bytes and storage reads, tenant health/queue/backlog summaries, bounded deduplicated alerts and optional advanced reports. Cost controls preserve existing paid access; no usage billing is added.
4. Seller security: verified email changes, session list/revocation, one-time offline recovery and short-lived purpose-bound step-up confirmation for sensitive actions. Retain existing browser-bound email login and CSRF rules.
5. Portability: authenticated tenant-scoped exports and operator-controlled import into a fresh standalone installation. Preserve paid grants and immutable artifacts; encrypt portable secret state with a user-held key, exclude unrelated platform/seller/session secrets, re-encrypt destination state and do not silently migrate Stripe accounts or overwrite a populated destination.
6. Lifecycle notices: deduplicated expiring/expired access notices and capacity warnings through the existing durable email outbox. Reuse Stripe renewal/failed-payment emails instead of duplicating that system.
7. Privacy: own-customer export, explicit closure/retention workflow, safe anonymization once ongoing paid rights and subscriptions are resolved, and minimal reconciliation/audit retention. Pending outbox payloads must not silently retain erased PII.
8. Outgoing webhooks: stable event IDs, versioned payloads, encrypted signing secrets, timestamp/HMAC signatures, bounded durable retries, manual recovery, tenant isolation and SSRF-safe delivery without redirects or credential-bearing URLs. Hosted Pro gating is independent of business event persistence.
9. Desktop artifacts: configurable larger native-package cap, file-based verified publication and bounded streaming/ranges with immutable integrity checks. Keep stricter WordPress/archive checks, publication atomicity and current entitlement checks. No differential update generation.

## Verification

Write meaningful failing tests before new behavior. Exercise actual migrations/queries on all three engines and local Redis/S3/PHP integrations. Verify adversarial ownership, replay, races, failed payments, stale plan changes, recovery failures, webhook SSRF/signatures/retries, import tampering and streaming cancellation. Maintain 100% lines, branches and functions per executable TypeScript module; no exclusions or lowered thresholds. Run strict TypeScript, lint, built source-package equality, Docker/browser checks where affected and an independent Opus review before final acceptance. Record unexercised real integrations separately. Final full verification uses a frozen source manifest and one build/coverage owner.
