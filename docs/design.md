# Double Entitle

The current multitenant design is documented in [saas-design.md](saas-design.md); this document retains core entitlement policies. One Fastify application serves tenant-scoped JSON routes and Vue 3 seller/customer interfaces. Business logic is product-neutral. The first product is Validated Field for ACF Pro, with annual 1, 5, and 25 site plans sharing one artifact. The existing plugin repository is outside this project's scope.

## Entitlement and billing

Licenses separate billing status, paid-through, operator revocation, refund revocation, and dispute suspension. Only settled recurring invoice lines mapped to configured Stripe prices grant seats or time. Subscription updates alone cannot grant seats. Reconciliation reads canonical Stripe invoices, charges, refunds and disputes outside SQL transactions, then applies them under an atomic billing-revision check. Conflicting snapshots are refetched before applying; slow provider requests never hold SQLite’s single connection. Duplicate events are persisted once and trigger retryable reconciliation. Paid-through never decreases because a stale notification arrived. Cancellation and payment failure preserve purchased time. Full refunds revoke download access, partial refunds do not, and open or lost disputes suspend access. The existing full-refund rule applies to any fully refunded paid invoice, including an upgrade invoice: it permanently revokes the whole license, preserves paid-through for audit, and is separate from operator revocation. Operator restore clears only operator revocation and cannot undo refund revocation. The user confirmed this business policy on 2026-10-21: a fully refunded upgrade retains permanent whole-license revocation, including access from the earlier paid base purchase. Dispute resolution reconciles canonical state.

## Credentials

License and activation secrets contain 256 random bits and are stored as SHA-256 hashes. Key issuance and an encrypted email outbox commit in one transaction. Delivery retries decrypt the same message. A customer can rotate a lost key through email login; rotation revokes activation tokens and supersedes pending key emails. Installation identifiers are stable client-generated UUIDs. Normalization removes scheme, default ports, query, fragment and trailing slash, lowercases/punycodes the hostname, and preserves non-root paths. URL metadata is never fetched. Explicit operator-configured host suffix exemptions are off by default. License-row write locks serialize seat checks on every database.

## Releases and sessions

CLI publication validates ZIP paths, contents, digest and size; stores the verified snapshot with conditional immutable creation in private S3, verifies readback, and only then inserts release metadata. Withdrawals preserve files. Update metadata uses stable service package URLs. WordPress attaches its scoped token in an Authorization header when downloading, so metadata has no expiring storage URL or embedded credentials. Every download rechecks entitlement, token revocation, publication and withdrawal.

Email login links expire after 15 minutes and are consumed by a POST after a confirmation page, protecting links from passive email scanners. Sessions are server-side, hashed, expire after 7 days, and use HttpOnly SameSite cookies. Mutations require same-origin and a session-bound CSRF token. Customer queries always include customer ownership.

## Verification and deployment

The same migrations and business tests run against real SQLite, PostgreSQL and MySQL. Stripe and email adapters are injectable. Test fixtures never make charges. Docker supplies database and WordPress integration environments. One production container sits behind an HTTPS proxy and uses persistent database/working storage and a private S3-compatible bucket. Database snapshots and private storage must be restored together with encryption keys. Integration results and limitations are recorded in docs/verification.md.
