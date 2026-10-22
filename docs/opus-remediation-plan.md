# Opus review remediation implementation plan

Goal: correct the reviewed defects without weakening customer isolation, paid entitlement, artifact integrity or the strict 100% TypeScript gate.

Architecture: keep one application and the existing schema. Restore correct production cookie deletion and allow only genuinely expired/missing sessions to enter guest checkout. Keep Stripe HTTP outside SQL transactions; use the existing billing-lock version as an optimistic compare-and-swap before applying canonical snapshots, retrying a bounded number of conflicts. Persist local checkout customer identities before external creation so retries use the same Stripe idempotency key; map external IDs under a short locked transaction. Publication must verify its product directory and one root plugin header/version before making metadata visible.

Constraints: Double Entitle only; preserve unrelated work and all existing runtime sources. No .env, retained databases, provider calls, production actions or publication. No Git repository exists; before-source backup and raw evidence live on Scratch. Build, test and disposable database output remain on Scratch.

- [x] F1/F3: add failing API regressions for Secure logout deletion, stale-session guest checkout and valid-session email conflict, plus UI state retention; implement minimal auth/API fixes; run focused tests. Files: src/auth.ts, src/app.ts, src/stripe.ts, web/main.ts if required; corresponding API/UI/Stripe tests.
- [x] F2: add failing tests for independent reads during blocked snapshot/customer/session HTTP, stale concurrent snapshots and conflict retry exhaustion; implement short transactions with revision CAS and durable/idempotent customer mapping; test concurrency on SQLite, PostgreSQL and MySQL. Files: src/billing.ts, src/stripe.ts, tests/review-regressions.test.ts and existing Stripe tests as needed.
- [x] F4: retain permanent whole-license revocation for fully refunded upgrades, confirmed by the user on 2026-10-21; added an upgraded-license regression and explicit docs covering permanent whole-license revocation and operator-restore limits. No refund-policy code changed.
- [x] F5: add invalid ZIP identity/version/header regressions; enforce product slug as root directory and exactly one main plugin header matching the published semantic version. Adapt legitimate ZIP fixtures to valid product/version content; preserve malformed ZIP tests and cleanup checks. Files: src/releases.ts and test/archive fixtures.
- [x] Verify all tests, 100% coverage per executable module with disposable MySQL, strict TS7, lint, production build, and real database concurrency regressions. Obtain a fresh Opus follow-up review of changes and original findings; resolve concrete objections before completing.

Regression discipline: each production fix follows an observed failing behavior test. Evidence records the failing and passing runs. Independent review must distinguish source acceptance, test evidence and unqualified live-provider behavior.

## Follow-up review corrections

- [x] N1: migrated NULL plugin basenames remain explicitly bindable once; successful verified publication persists the effective basename under the schema lock. Legacy published/withdrawn products and newly published default identities have regressions.
- [x] N2: replace the PHP-comment tokenizer with WordPress get_file_data raw-byte/header matching, PHP-style cleanup, and WordPress empty-name semantics. Regressions cover inline PHP tags, preceding apostrophes, string/template headers, Unicode separators and old-version headers.
- [x] Repeat final strict coverage/build/database checks and obtain round3 independent review.

Final verification: 179 tests passed with zero failures or skips. All 19 executable TypeScript modules have 100% lines, branches and functions. Typecheck, lint, production build and compiled startup smoke passed. Real PostgreSQL and MySQL regression suites each passed 48 tests with one SQLite-only hook skipped; operator concurrency and migration/binding checks also passed on both engines.

Opus 5.5 round 3 accepted spec compliance and code quality with no remaining findings. All 71 reviewed fingerprints matched before this checklist update. Application and test files remain identical to the accepted snapshot. Raw review, hashes, test evidence and qualification limits are retained under /Volumes/Scratch/double-entitle-wp/reports/opus55-fixes-20261020. Disposable task containers, runtime data and build outputs were removed; shared caches were preserved. Stripe used local fixtures; the full WordPress installation/update matrix was not rerun.
