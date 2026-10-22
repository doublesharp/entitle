# Docker integration coverage, 2026-10-22

The latest Linux Docker gate passed **941/941 tests**, with zero failures,
cancellations or skips. All **65 executable modules under src/ and web/**
independently reached **100% lines, branches and functions**: 25,416 lines,
5,551 branches and 1,532 functions. Strict TypeScript 7, ESLint and the actual
multistage Docker build passed. Thresholds and exclusions remain unchanged.
The suite exercised isolated PostgreSQL/MySQL databases, private local S3,
Redis, PHP and JDK fixtures from inside the container.

New regressions execute the Docker healthcheck against real HTTP servers on
configured ports, prove local operator/purchase fixtures can be encrypted and
exported, and require browser publication to use product slugs for both ZIP
and native-asset routes. The seller UI suite passed 67/67.

These percentages measure the application TypeScript modules, not every
possible workflow, Docker directive, PHP opcode or external integration.
Docker startup, persistence and built-in-browser interactions were checked
separately. The approved visual-only Playwright fallback captured 123 real
Docker page/width cases with no document overflow or uncaught page exceptions;
representative screenshots were inspected. This is separate from TS coverage.

Evidence is in
`/Volumes/Scratch/double-entitle-wp/reports/docker-ui-20261022/`:
`coverage-r3/summary.json`, `coverage-r3.log`, the red/green logs,
`build-r3.log`, `production-runtime.json` and `native-browser.json`.
Only the two measurement documents were updated after the gate; the final
image/source archive includes those updates. Older sections below describe
their stated historical snapshots.

# Verification workflow coverage, 2026-10-22

The current integrated gate passed **938/938 tests, zero failures and skips**.
All **65 modules** independently have **100% lines, branches and functions**:
25,416 lines, 5,550 branches and 1,532 functions. Strict TS7,
ESLint, formatting and the production build passed. Thresholds and exclusions
are unchanged; all 271 source hashes were stable throughout the gate.

Final regressions cover both navigation orders before verification Continue,
one-time result retention, purpose-specific invalidation after navigation,
protection of newer proofs, export feedback reset and prior workflow fixes.
The focused UI suite passed **149/149**. Actual local PostgreSQL/MySQL, private
MinIO, Redis, PHP and TCP fixtures ran in the full gate.

Evidence: `coverage-r8/summary.json`, `coverage-r8.log`,
`r8-gate-source-manifest.json` and `root-verification-r8.json` under
`/Volumes/Scratch/double-entitle-wp/reports/saas-features-20261021/`.
UI logs, browser script, captures and explicit exits are in sibling
`reports/feature-layout-20261022/r4/`. These result sections were updated after
the gate; source review acceptance is separate. Earlier snapshots below
refer to their stated older source.

# Feature workflow review fixes coverage, 2026-10-22

The current integrated gate passed **933/933 tests, zero failures and skips**.
All **65 executable application modules** independently have **100% lines,
branches and functions**: 25,358 lines, 5,536 branches and 1,532 functions.
Strict TypeScript 7, full ESLint and the production build passed. The thresholds
and exclusions are unchanged. All 271 source files retained their pre-gate hashes.

New regressions cover emailed proof links opening recovery/export forms, action
errors preserving drafts, irreversible choices, readable billing/delivery states,
one billing-capacity notice, restricted/first-workspace security headings and
closure-request status. Existing authorization and proof-purpose checks remain.
Actual local PostgreSQL/MySQL, private MinIO, Redis, PHP and TCP fixtures ran.

Evidence is `coverage-r6/summary.json`, `coverage-r6/coverage.txt`,
`coverage-r6.log` and `r6-gate-source-manifest.json` under
`/Volumes/Scratch/double-entitle-wp/reports/saas-features-20261021/`.
UI type/lint/build logs, 144-test scoped coverage, browser interactions and
screenshots are in `reports/feature-layout-20261022/r2/` on the same volume.
Source/UI review acceptance is separate. These two measurement documents were
updated after the gate and included in the review/build snapshot.

Earlier snapshots below describe their stated older source.

# Feature layout and round-4 fixes coverage, 2026-10-22

The final integrated gate passed **926/926 tests, zero failures and skips**.
All **65 executable application modules** independently have **100% lines,
branches and functions**: 25,238 lines, 5,497 branches and 1,524 functions.
Strict TypeScript 7, full ESLint and the production build passed. Thresholds and
exclusions were unchanged. Every source file matched its pre-gate hash.

This includes readable feature-screen summaries, grouped/mobile navigation,
progressive setup forms, one-time secret visibility, terminal subscription
billing actions, preservation of receipt-free pending closure requests,
partial-reconciliation export refusal and authenticated late-event matching.
Actual local PostgreSQL/MySQL, private MinIO, Redis, PHP and TCP fixtures ran.

Evidence: `coverage-r5/summary.json`, `coverage-r5/coverage.txt`,
`coverage-r5.log`, `typecheck-r5.log`, `lint-r5.log`, `build-r5.log`,
`r5-gate-source-manifest.json` and `r4-closure-fixes/` under
`/Volumes/Scratch/double-entitle-wp/reports/saas-features-20261021/`.
UI red/green and real Chrome evidence is under the sibling
`reports/feature-layout-20261022/` directory. Independent source/UI acceptance
remains separate from this gate. The two result documents were updated only
after the gate, before the final review snapshot.

Earlier snapshots below describe their stated older source.

# Round-3 SaaS fixes coverage, 2026-10-22

The combined gate passed **911/911 tests, zero failures and skips**. All **65
executable application modules** independently have **100% lines, branches and
functions**: 24,784 lines, 5,442 branches and 1,503 functions. Thresholds and
exclusions were unchanged. Strict TypeScript 7, full ESLint and the production
server/Vue/source-distribution build passed.

New regressions exercise terminal subscription checkout in the seller UI,
canonical stale-checkout recovery, reusable verified Portal configurations,
completed-closure attribution export/import and destination rekeying, legacy
reviewed attribution upgrades, export recovery after reload, cleanup failure
isolation and download/delete lease accounting. Actual local PostgreSQL, MySQL,
private MinIO, Redis, PHP and TCP fixtures were enabled. Stripe, external SMTP
and signed desktop installations remain outside live qualification.

Evidence is under
`/Volumes/Scratch/double-entitle-wp/reports/saas-features-20261021/`:
`coverage-r4/summary.json`, `coverage-r4/coverage.txt`, `coverage-r4.log`,
`typecheck-r4.log`, `lint-r4.log`, `build-r4.log` and the `r3-fixes/` handoffs.
All 271 source-distribution files matched their pre-gate hashes after completion.
Only this document and the verification summary were subsequently updated with
results before the review snapshot. Source acceptance still requires independent
review. Coverage does not establish production correctness or live qualification.

Earlier snapshots below predate the round-3 fixes.

# Round-2 SaaS fixes coverage, 2026-10-22

The post-review combined gate passed **875/875 tests, zero failures and skips**.
All **64 executable application modules** independently have **100% lines,
branches and functions**: 23,305 lines, 5,294 branches and
1,462 functions. No threshold or exclusion was relaxed.
Strict TypeScript 7 and full ESLint also passed.

This run exercises real local PostgreSQL/MySQL migration fixtures, private
MinIO, Redis, PHP and real TCP regressions for silent native publication, cold
download and encrypted export phases. The worker test holds renewal-gap events
without enabling unpaid Pro, then qualifies exactly one delivery after payment.
New tests also cover safe Portal enforcement, export fairness/disconnect cleanup,
leased-cache reuse, precise privacy blocker IDs and minimal late-event receipts.

Evidence is under
`/Volumes/Scratch/double-entitle-wp/reports/saas-features-20261021/`:
`coverage-r3/summary.json`, `coverage-r3/coverage.txt`, `coverage-r3.log`,
`typecheck-r3.log`, `lint-r3.log` and the `r2-fixes/` handoffs. The gate source
matched its frozen manifest after completion. Independent source review and live
provider qualification are distinct from this automated result.

Earlier snapshots below predate the round-2 fixes.

# SaaS feature coverage, 2026-10-22

The combined gate passed **821 tests, zero failures and zero skips**. All **63
executable application modules** independently meet **100% lines, branches and
functions**: 22,362 lines, 5,087 branches and 1,420 functions. Thresholds and
exclusions were not relaxed. Strict TypeScript 7, ESLint and the production build
also passed.

The run enabled actual local PostgreSQL/MySQL migration fixtures, private
MinIO, Redis and PHP. Stripe and external SMTP remain fixture-qualified rather
than live-provider-qualified. Coverage measures exercised source paths, not proof
of production correctness or native desktop installation.

Regression tests exposed and verified fixes for checkout tier pinning, historical
Stripe price handling, credit settlement and linked prorations, cache expiry with
active downloads, bounded disk-cache races, progress-aware transfer deadlines,
customer-specific closure attribution, nullable financial fields, webhook rotation
and shared-worker fairness. Unlinked classic/manual returned-time credits remain
unsupported; use the portal policy in [hosted pricing](hosted-pricing.md).

Evidence is under
`/Volumes/Scratch/double-entitle-wp/reports/saas-features-20261021/`:
`coverage-final/summary.json`, `coverage-final/coverage.txt`, `coverage-final.log`,
`typecheck-final.log`, `lint-final.log` and `build-final.log`.

Earlier snapshots below retain their original scope and do not supersede this
combined gate.

# Standalone and hosted modes verification

2026-10-21: the full MySQL/S3/Redis run passed 536 tests, zero failures and one
PostgreSQL-specific case skipped. The coverage gate passed for all 42 executable
TypeScript application modules at 100% lines, branches and functions:
13,283 lines, 3,032 branches and 785 functions. PostgreSQL mode/Stripe regressions
also passed all 16 tests in a separate run. The populated PostgreSQL upgrade
case also passed separately with zero failures or skips. Typechecking, lint and
the production build pass.

This verifies local fixtures, not live Stripe charges, payouts, deployed service
operation, measured profitability or legal enforceability. Opus accepted the
corrected local license text; counsel and hosted seller terms remain pre-release
work. Evidence is under
`/Volumes/Scratch/double-entitle/reports/hosted-modes-20261021/`.
No existing database, deployment configuration or shared service was changed.

Earlier snapshot results follow.

# Coverage and defects found

## Current marketing home and docs gate

2026-10-21: **503/503 tests passed, zero failures and skips**. Each of all 40
executable TypeScript application modules has 100% lines, branches and functions.
Totals: 12,597/12,597 lines, 2,905/2,905 branches and 755/755 functions.
Public UI and HTTP regressions cover home/signup navigation, all home-to-docs
anchors, direct `/docs` and `/docs/` routes, no API requests on home and retryable
public limits on docs. The first-seller and admin regression tests still pass.

Opus 5.5 accepted the final snapshot; all reviewed hashes match after the gate.
Evidence is `/Volumes/Scratch/double-entitle-wp/reports/home-marketing-20261021/coverage-r2/`
and sibling `coverage-r2.log`, `verification.json` and `source-manifest.json`.
Thresholds and exclusions are unchanged. Earlier results describe older snapshots.

## Earlier admin layout gate

2026-10-21: **501/501 tests passed, zero failures and skips**. Each of the 40
executable TypeScript application modules has 100% lines, branches and functions.
Totals: 12,196/12,196 lines, 2,894/2,894 branches and 751/751 functions.
New tests cover focused navigation, preserved drafts, workspace/session reset,
pending-action guards, readable storage units, first-time seller onboarding and
headings during recovery/refresh. Existing buyer, checkout, scoped key and
publication interactions remain covered. Opus 5.5 accepted round 2, and the final
coverage gate passed with the reviewed source hashes unchanged.

Current evidence is `/Volumes/Scratch/double-entitle-wp/reports/admin-style-20261021/coverage-r2/`
and its sibling `coverage-r2.log`, `verification.json` and `source-manifest.json`.
No exclusions or thresholds changed. Older results below describe earlier snapshots.

## Earlier framework SaaS gate

2026-10-21: **495/495 tests passed, zero failures and skips**. Every one of the
**40 executable `src/` and `web/` TypeScript modules** meets **100% lines, branches
and functions**. Totals: 12,060/12,060 lines, 2,870/2,870 branches and746/746
functions. All seven migrations and the five web modules are included. No
coverage-ignore directives or new exclusions were introduced.

The final run used real PostgreSQL/MySQL migration fixtures, MySQL-backed SaaS
fixtures, private native MinIO, actual backup/restore tests, PHP and Java contract
runtimes. Additional shared PostgreSQL and SQLite suites passed separately.
Opus5.5 accepted the frozen source and all131 reviewed hashes matched after the
full gate. Two later Joomla documentation corrections changed no runtime code.

Evidence: `/Volumes/Scratch/double-entitle-wp/reports/framework-resumed-coverage/`
contains `summary.json` and `coverage.txt`. The raw log is
`framework-resumed-coverage.log`; `framework-final-acceptance-receipt.json` records
counts, hashes and the review condition check. The interrupted
`framework-accepted-coverage` report is invalid. Earlier measurements below are
historical.

New regressions fixed native Joomla collection/details authentication and
activation persistence, explicit client identity, Electron ARM channel names and
YAML controls, Sparkle SDK/error handling, duplicate updater listeners, and JSON
download failures inheriting artifact headers. See [verification](verification.md)
for actual native results and integrations not exercised.

## Earlier SaaS and Elements gate

2026-10-21: the integrated SaaS and Stripe Elements implementation passed **376/376 tests, zero failures or skips**, with **100% lines, branches and functions in all31 executable TypeScript application modules**. Totals: 7,774/7,774 lines, 2,040/2,040 branches, 607/607 functions. The run enabled real PostgreSQL/MySQL migration tests and the private native MinIO integration; it did not make Stripe charges.

Evidence: `/Volumes/Scratch/double-entitle-wp/reports/saas-coverage-final/summary.json`, `coverage.txt`, and `/Volumes/Scratch/double-entitle-wp/reports/saas-baseline-20261021/coverage-final.log`. Run with TEST_POSTGRES_DATABASE_URL and TEST_MYSQL_DATABASE_URL on disposable fixtures, and load the local S3 integration.env. Older measurements below are historical.

New regressions found and fixed MySQL interrupted-DDL constraint loss; missing-lock fail-open behavior; forwarded seller login links; unbounded tenant/trial/API-key policies; S3 transfer timeout and transient reused-socket failures; buffered-transfer memory admission; suspended seller API access; empty local configuration500; mutable publication input/context; future-plan seat metrics; and Elements iframe load failures. Retry/email caps preserve the only usable encrypted license key. See individual SaaS reports on Scratch and verification.md for integration limits and the final Opus findings.

## Earlier standalone baseline

On 2026-10-21, Node 26.12.0 native V8 coverage measured **100% lines, branches and functions in each of all 19 executable TypeScript application modules** under `src/` and `web/`. The full run passed 185 tests with no skips. This includes migrations, server/CLI entry functions, the Stripe adapter and real Vue DOM interaction tests.

The original baseline was 76.94% lines, 83.80% branches and 85.71% functions across 29 tests. The target was raised from 95% to 100%. `pnpm coverage` enforces the new 100% floor both globally and per module, rejects missing/duplicate coverage entries, and includes modules not loaded by tests. Only test files and declaration-only files are excluded. No coverage-ignore directives are used. Build/setup/test infrastructure scripts and the PHP example are outside the TypeScript application denominator.

## Reproduce

Start the disposable PostgreSQL/MySQL fixtures from `compose.test.yaml` and the
private S3 fixture with `node scripts/local-s3.ts up`. Wait for readiness, then use
the pinned Node runtime:

```sh
# Use installed PHP on PATH. These database credentials are disposable local fixtures.
TEST_SAAS_DATABASE_URL=mysql://root:entitle-test@127.0.0.1:53306/entitle \
TEST_POSTGRES_DATABASE_URL=postgresql://postgres:entitle-test@127.0.0.1:55432/entitle \
TEST_MYSQL_DATABASE_URL=mysql://root:entitle-test@127.0.0.1:53306/entitle \
node --env-file=/Volumes/Scratch/double-entitle-wp/data/local-s3/integration.env scripts/coverage.ts
```

The MySQL test creates a randomly named database, tests actual migrations/collations/constraints, then drops only that database. The connection user needs CREATE/DROP DATABASE on a disposable server. Omitting this variable skips that test and intentionally fails the 100% migration coverage gate. SQLite tests need no separate service. PostgreSQL/MySQL core regression commands are documented in the README; never point them at retained data.

Machine-readable results: `/Volumes/Scratch/double-entitle-wp/reports/coverage/summary.json`. Human-readable test/coverage report: `coverage.txt` in that directory. Override `COVERAGE_DIR` and `COVERAGE_TMP_DIR` only with paths on Scratch. The runner overrides inherited TMPDIR to keep tests off the snapshotted Data volume.

## Bugs found with regression tests

- Unicode credentials of equal JavaScript string length but different UTF-8 byte length threw inside `timingSafeEqual`; comparison now checks byte lengths, so invalid credentials receive normal denial.
- Concurrent operator product setup could produce a PostgreSQL 500. Setup now locks before reading mappings; one winner and a clean 409 loser were verified on PostgreSQL, MySQL and SQLite.
- A successful key replacement followed by a temporary account-refresh failure hid the only visible key. The UI preserves the same account/key with an error banner; malformed account responses are rejected before rendering.
- Signing into a second account while its refresh failed could retain the previous customer’s identity and CSRF. Successful identity changes clear old state before fetching the new account; logout also clears inherited checkout email.
- Invalid public origins and listener/SMTP ports were accepted until they broke sessions, startup or delivery. Configuration now rejects malformed values and canonicalizes valid origins.
- Startup failures could leave database connections open, and repeated shutdown signals could interrupt cleanup. Startup now unwinds resources and shutdown is idempotent.
- The WordPress SDK could allow core fallback after an endpoint change, intercept another plugin’s packages on the same API, globally attach the wrong token, or accept an earlier handler’s unverified file. Explicit ownership, scoped download authentication and fail-closed own-package handling now prevent these cases.
- PHP version comparison treated default Free version `0` as below a no-dependency minimum `0.0.0`. The default now uses `0.0.0`.

Tests also exercise real corrupt/unsafe ZIPs, provider callback failures, database rollback and artifact cleanup, outbox claims/cancellation, billing ordering, unpaid upgrades, entitlement denial, token/key rotation, CSRF/customer isolation and asynchronous Vue interactions. SQL COUNT’s redundant missing-row fallback was removed: an ungrouped aggregate returns exactly one row, including when the count is zero; a broken adapter now fails closed rather than assuming spare seats.

## Integration boundaries

Stripe SDK tests use local HTTP provider fixtures, not a Stripe test account. SMTP includes a real local sink; internet delivery is not qualified. Real PostgreSQL/MySQL queries and migrations passed separately. The current PHP SDK passed isolated regressions and real WordPress upgrader/HTTP hook regressions; the earlier full admin/WP-CLI/automatic installation matrix predates these guard changes. No production deployment or live charges occurred. Coverage proves exercised code paths, not complete correctness or production readiness.

## Opus review remediation

The earlier remediation run retained 100% coverage per module after the session, billing and publication fixes: 179 tests passed, zero skipped, 3794/3794 lines, 857/857 branches and 255/255 functions. The extra module is forward-only migration002. Those receipts are under `/Volumes/Scratch/double-entitle-wp/reports/opus55-fixes-20261020/coverage-final/`.

Production logout clears the Secure host cookie correctly. Expired checkout sessions can enter guest checkout while database failures and existing-customer ownership rules remain enforced. An authenticated email conflict returns409 and keeps the signed-in interface/key visible. Stripe HTTP runs outside database transactions; revision-checked reconciliation and stable checkout customer IDs protect ordering and retries across all three engines.

Publication verifies the configured WordPress basename, root directory and version using WordPress raw-header matching within the first 8 KiB. Successful publication persists the identity, while migrated unbound products can explicitly bind their legacy identity once. Regressions cover upgraded published products, immutability, publication/configuration races, inline PHP headers, template-contained headers, duplicate plugins and Unicode edge cases. A separate isolated PHP run of the actual WordPress header functions agreed with all 12 reference cases.

The existing permanent whole-license full-refund policy is unchanged and explicitly tested for upgraded licenses. Changing upgrade refunds to preserve earlier base access remains a separate business-policy decision.

The 2026-10-21 review added six tests and corrected seven observed failing regression tests. Scheduled reconciliation is deduplicated under the work lock without resetting retries or live leases. Missing Stripe customer email no longer blocks unrelated or existing-license reconciliation, while new issuance still validates email. Failed login-link confirmation preserves existing customer identity, CSRF and a visible replacement key. The latest strict run passed 185 tests with zero skips: 3818/3818 lines, 872/872 branches and 256/256 functions. Both real PostgreSQL and MySQL regression runs passed 49 tests with one SQLite-only hook skipped. Current receipts are under `/Volumes/Scratch/double-entitle-wp/reports/opus55-current-20261021/coverage/`.
