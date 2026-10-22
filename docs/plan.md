# Double Entitle implementation plan

Goal: replace the licensing, subscription, download and update functions of EDD for an annual Pro product.

1. Verify Node, TS7, Vue, Vite and ESLint compatibility. Pin exact dependencies and save the lockfile. Keep build outputs, dependency caches, test databases and captures on Scratch. The empty destination needs no worktree isolation.
2. Write failing behavior tests in tests/core.test.ts for payment evidence, stale/duplicate billing events, seat transactions, key delivery/rotation, expired and suspended downloads and ZIP publication. Implement src/db.ts, src/crypto.ts, src/licensing.ts, src/billing.ts, src/jobs.ts and src/releases.ts. Reuse these tests with TEST_DATABASE_URL for PostgreSQL and MySQL.
3. Implement Stripe and SMTP adapters, raw-body webhook ingestion, retry and reconciliation commands. Exercise failures and canonical fixture snapshots without production credentials.
4. Write API tests for login token replay/expiry, CSRF and ownership. Implement src/app.ts, src/auth.ts and authenticated CLI. Serve Vue assets from the same process.
5. Build web/ customer interface and examples/wordpress/ PHP client against documented API contracts. Check the interface in a browser. Exercise real WordPress update metadata, package download, admin update screen, WP-CLI and automatic-update paths.
6. Add Docker/Compose, .env.example and API/setup/deployment/backup docs. Run strict TS7 checking, flat-config ESLint, tests against all engines, production build and Docker smoke checks. Review security boundaries and fix verified findings before handoff. Record every unexercised external integration.

Assumptions: cancellation preserves paid time; unpaid upgrades grant no additional seats; a paid downgrade takes effect after the larger paid allowance ends and can leave existing installations over limit while blocking new installations; staging exemptions are disabled unless configured; checkout prices are configured by the operator; local billing fixtures and an SMTP sink are explicitly development-only. All customer and operator workflows are available through the API so a future hosted website can consume the service.
