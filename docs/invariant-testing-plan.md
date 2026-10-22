# Invariant testing plan

The approved approach adds fast-check to the existing Node test runner. A small
reference model describes paid periods, seats and credential lifetimes without
calling production entitlement helpers. Commands apply generated sequences to
the real services and compare persisted state after each step.

- [x] Add a pinned development dependency, bounded defaults and replay controls.
  Normal tests discover `tests/invariants-*.test.ts`; `test:invariants` selects them
  alone and `test:fuzz` increases the run and command budgets.
- [x] Exercise activation, repeat activation, deactivation, key replacement,
  paid/unpaid plan changes, time boundaries, suspension and refund revocation.
  Existing seats may exceed a downgraded allowance; new seats must be denied.
- [x] Exercise duplicate and reordered billing events against authoritative
  snapshots. Compare durable grants, ownership and paid dates, and verify
  unpaid changes cannot issue licenses or increase allowances.
- [x] Exercise two tenants with matching external identifiers. Check foreign
  credentials fail and rejected operations leave both tenants unchanged.
- [x] Exercise retries, deferrals and worker lease takeover with explicit
  barriers. A stale completion or failure must leave the newer lease intact.
- [x] Run bounded and extended campaigns, replay a deliberately detected
  failure, and run generated activation/reconciliation races on disposable
  PostgreSQL and MySQL databases when local fixtures are available.
- [x] Turn confirmed application defects into deterministic regressions before
  fixing production code. Run the regression suite, typecheck, lint and the
  existing coverage gate without changing thresholds or exclusions.
- [x] Document commands, replay parameters, invariant scope and measured limits.

Every generated case starts from isolated state, including shrink attempts.
Database fixtures and all temporary files use `/Volumes/Scratch`; raw run
evidence stays there. This checkout has no Git metadata, so implementation
proceeds in place without creating a branch or commit. No external provider
calls or live payments are needed.

Completed with one application fix for future allowances during paid-period
gaps. The independent second review passed. See `invariant-testing.md` for
measured verification and the unrelated documentation coverage limitation.
