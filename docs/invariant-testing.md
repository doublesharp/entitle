# Invariant and fuzz testing

`pnpm test` includes the bounded fast-check suite. Run it alone with:

```sh
pnpm test:invariants
pnpm test:fuzz
FUZZ_RUNS=1000 FUZZ_COMMANDS=150 FUZZ_SEED=20261021 pnpm test:fuzz
```

The bounded suite generates 30 cases per property with up to 30 operations per
sequence. The extended command defaults to 500 cases per property and up to 100
operations. Array generators use the entire requested length range. Fixed
examples also exercise critical transitions, regardless of the random seed.
There are six properties across licensing, billing, tenant isolation and queues.
Two deterministic regressions cover allowance selection during a paid-period
gap and draining concurrent writers before resetting a shrinking sample. These
commands do not schedule recurring work.

The suite uses the existing Node test runner and pinned fast-check development
dependency. Use the project's Node 26 runtime so the SQLite native module and
TypeScript support match the rest of the tests.

## Properties

- License sequences combine site changes, exempt development sites, repeated
  activation, deactivation, key rotation, paid/unpaid plan changes, future
  downgrades, exact time boundaries, suspension and refund revocation. A small
  purchase ledger and expected active installations supply the reference model.
  It does not call production entitlement helpers to decide expected results.
  An existing installation can remain above a downgraded allowance; adding a new
  nonexempt installation must respect the allowance effective at that time.
  Gaps retain the most recent plan that has begun. Reconciliation must not
  apply a future plan before its start, including inside a gap.
- Concurrent activation races admit exactly the paid allowance and reject the
  other contenders with `site_limit` on the real database.
- Billing sequences combine unpaid observations, omitted historical invoices,
  duplicate/reordered durable events, concurrent reconciliation, provider
  failures and worker retries. Grants and paid dates persist, ownership remains
  fixed, initial key delivery is unique, unpaid upgrades add no seats, and full
  refund revocation cannot be cleared by a later healthy snapshot.
- Two tenants share product slugs, email addresses, provider customer IDs,
  subscription IDs, invoice IDs, grant IDs and event IDs. Foreign keys, tokens
  and ownership IDs are rejected by the other tenant's service. After every
  operation, the other tenant's complete business records must remain unchanged.
- Queue sequences check ordinary retries, budget deferrals, the 72-hour retry
  window, terminal states, encrypted payload preservation and tenant scoping.
- Lease takeover checks both success and failure of the stale worker while a
  replacement worker holds the lease. Every field of the replacement lease
  must remain unchanged. The exact lease expiry boundary is tested as well.

All four queue tables are generated. Email payloads are erased on successful
delivery and preserved for retry after failure or budget deferral. Delivery
remains at least once; these tests do not assert exactly-once external effects.

## Isolation and database engines

Every property evaluation, including each shrinking attempt, resets its own
disposable database. Concurrent operations are fully drained before reporting
failure, so an old writer cannot contaminate the next shrinking attempt.
SQLite databases and temporary files live under
`/Volumes/Scratch/double-entitle-wp/tmp/invariants-*` and are removed after the
test file completes. Scratch must be mounted. The suite deliberately ignores
`TEST_DATABASE_URL` to avoid resetting a retained database.

To exercise real PostgreSQL or MySQL, select the existing isolated fixture
helper through `TEST_SAAS_DATABASE_URL`:

```sh
# Local disposable fixture credentials. The user needs CREATE/DROP DATABASE.
TEST_SAAS_DATABASE_URL=postgresql://postgres:entitle-test@127.0.0.1:55432/entitle \
  FUZZ_SEED=20261021 pnpm test:invariants
TEST_SAAS_DATABASE_URL=mysql://root:entitle-test@127.0.0.1:53306/entitle \
  FUZZ_SEED=20261021 pnpm test:invariants
```

Each test file creates and drops its own randomly named database. It never
resets the database named in the connection URL. The activation and billing
races use actual transactions; a JavaScript scheduler cannot replace checking
the locking behavior of each supported database.

## Replaying a failure

fast-check reports the seed, shrink path and smallest failing input. Keep the
same dependency version, property, command budget and explicit examples when
replaying. Filter to the single failing property so its path is not applied to
other generators:

```sh
FUZZ_RUNS=500 FUZZ_COMMANDS=100 FUZZ_SEED=20261021 FUZZ_PATH='0:1:2' \
  node --test \
  --test-name-pattern='^invariant: generated license lifecycles' \
  tests/invariants-licensing.test.ts
```

Replace the illustrative seed and path above with the reported values. The
generators use ordinary arrays of operations, so no separate command replay
path is needed. `FUZZ_RUNS` accepts 1–100000, `FUZZ_COMMANDS` accepts 1–1000 and
`FUZZ_SEED` accepts a signed 32-bit integer. Invalid values fail before tests run.

Save logs and machine-generated failure evidence under
`/Volumes/Scratch/double-entitle-wp/reports/`. Turn a confirmed application defect
into a short deterministic regression before changing production code. Preserve
the existing coverage thresholds and exclusions.

This is bounded exploration of the stated properties. It does not prove all
operation orders correct or qualify live Stripe, SMTP, deployment, archive
parsers or every HTTP authorization route.

## Defect found

The gap regression reproduced a future three-seat plan taking effect one tick
early after billing reconciliation, while the prior allowance was one seat.
`effectiveLicense` now chooses the largest currently active allowance, or the
most recent plan that has begun if no grant is active. A future grant cannot
replace that fallback before its start.

## Verification on 2026-10-21

- SQLite extended campaign: all six properties passed at 500 cases each, with
  up to 100 operations, plus both deterministic regressions. Seed `20261021`.
- PostgreSQL and MySQL: all eight tests passed on each engine with 30 cases
  per property, with zero skips.
- Isolated mutation checks detected broken seat limits, missing lease fencing,
  early future-plan selection and fail-fast sibling handling. The seat-limit
  failure replayed with seed `20261021` and path `0:0`.
- Independent second review passed after the gap-model and sibling-draining
  findings were resolved. Strict typecheck, lint and test formatting passed.
- Full local integration run: 521 tests passed, zero failures and skips.
  Licensing, billing and queues each retained 100% lines, branches and functions.
  The aggregate coverage gate failed at 96.30% lines, 100% branches and 99.24%
  functions because separate work added `web/docs.ts` during the run. Every
  other measured module reached 100%; thresholds and exclusions were unchanged.

Raw evidence is in
`/Volumes/Scratch/double-entitle-wp/reports/invariants-20261021/`, including
`fuzz-reviewed.log`, `postgres-reviewed.log`, `mysql-reviewed.log`,
`mutation-reviewed-summary.json`, `future-gap-red.log` and
`coverage-reviewed/summary.json`. Disposable mutation copies were removed.
