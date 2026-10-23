# Blue/green deployments implementation plan

> **For agentic workers:** Use subagent-driven-development or executing-plans to implement task by task.

**Goal:** Activate verified two-slot API deployments with one background worker and shorten CI wall time.

**Architecture:** Separate server roles, two independent Coolify API resources, a stable internal router and a singleton worker. Existing atomic frontend publication and immutable healthy receipts remain authoritative.

**Tech stack:** Node/TypeScript, PostgreSQL/Knex, Nginx, Docker Compose, Python deployment automation, GitHub Actions and Coolify.

## Global constraints

- API slots never run jobs or migrations.
- Stop and verify the previous worker before starting its replacement.
- Automatic promotion and API rollback require identical migration fingerprints.
- Promote only the exact successful source run and immutable digests.
- Store disposable outputs and evidence under /Volumes/Scratch/entitle.
- Preserve source distribution, license notices, authentication and tenant boundaries.

### Task 1: Server roles and migration checks

Files: src/server.ts, src/config.ts, src/db.ts, tests/server-coverage.test.ts, new focused role tests, docs/configuration.md, scripts/source-files.txt.

- [ ] Add failing tests for api without jobs/migrations, worker with jobs and schema checks, migrate without listener, unknown role rejection and startup failure cleanup.
- [ ] Implement SERVER_ROLE=all|api|worker|migrate with all as the legacy default. Check pending and unknown migration names before api/worker startup. Retain graceful shutdown and job drainage.
- [ ] Run focused tests, typecheck and lint; commit only owned files and request review.

### Task 2: Stable router and faster CI

Files: deploy/runtime.Dockerfile, new router entrypoint/template and integration tests, .github/workflows/ci.yml, scripts/deployment/check-ci-results.mjs, CI tests, source manifest.

- [ ] Test candidate failure preserving live routing, slot changes, invalid state, graceful reload and routed identity using real HTTP/container integration.
- [ ] Add a stable internal API router with validated blue/green state and graceful reload. Preserve forwarded request semantics.
- [ ] Construct images concurrently with checks; publish reusable images only after checks pass. Split slow tests without omitting files or running duplicate fixed-port fixtures concurrently.
- [ ] Verify complete CI gate behavior and all affected checks; commit and review.

### Task 3: Private promotion, ledger and provisioning

Repository: entitle-deploy, task-owned Scratch worktree blue-green-ops-20261023.
Files: release.py, rollback.py, deployment_ledger.py, observe.py, provision.php, Compose files, workflow and focused tests.

- [ ] Add behavioral tests for inactive-slot preparation, fingerprint rejection before mutation, worker stop-before-start, failed candidate, failed cutover, rollback and retry after interrupted acknowledgement.
- [ ] Implement slot-aware observations, atomic route state, serialized deployment transaction and previous-state recovery. Keep current receipts compatible and protect both slots in retention.
- [ ] Provision blue/green API, worker and router resources with restricted environment and no new Docker authority for the CI user.
- [ ] Run the private unit suite, actionlint and Compose validation; commit and review.

### Task 4: Integrate and activate

- [ ] Run source suite, builds, private suite and real container cutover/rollback tests. Resolve independent review findings.
- [ ] Open/link PRs, wait for required CI, merge verified changes and provision host resources.
- [ ] Activate the exact source digests, verify readiness/auth/webhook rejection, prove old API continues during candidate startup and worker ownership transfers without overlap.
- [ ] Demonstrate rollback and a subsequent successful promotion; record measured times and accepted receipt in a short human-written summary.
