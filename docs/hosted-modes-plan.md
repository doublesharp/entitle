# Standalone and hosted deployment implementation

The approved design keeps one inspectable source tree. Standalone serves one
publisher with multiple products, their own Stripe account and no platform
subscription or application fees. Hosted enables seller onboarding, multiple
publishers, the existing SaaS subscription and a 1% application fee on new
subscriptions and their renewals. Existing subscriptions are not changed.

The license permits using the service for one's own software business and
requires separate permission to provide a licensing/distribution service to
independent publishers. Opus reviews the legal boundary before finalization.
Source-available wording replaces open-source claims for restricted code.

## Implementation sequence

- [x] Add failing configuration, standalone owner/API isolation, direct Stripe
  routing and hosted fee tests. Run them before changing implementation.
- [x] Add `DEPLOYMENT_MODE=standalone|hosted`, default standalone;
  `STANDALONE_OWNER_EMAIL`; and `HOSTED_APPLICATION_FEE_PERCENT`, default 1,
  bounded to 0-100 with at most two decimal places. Standalone rejects nonzero
  explicit fees. Production standalone needs owner credentials, ordinary Stripe
  webhooks and storage/email settings, rather than Connect/platform prices.
- [x] Standalone requires the existing primary tenant and refuses additional
  tenants or preexisting connected/platform billing state. Owner login assigns
  primary membership only after email verification. Other seller requests and
  stale sessions cannot gain access. Tenant creation and platform/Connect
  operations are unavailable. Ordinary Stripe events route only to primary.
- [x] Preserve hosted account routing and apply the server-configured fee to
  subscription data in both Checkout interfaces. Standalone uses its Stripe
  secret directly. No automatic subscription migration or fee refunds.
- [x] Disclose deployment mode and fee in API/dashboard, hide irrelevant
  hosted controls in standalone, and update setup/deployment instructions.
- [x] Apply the reviewed license, retain MIT client adapters, and package the
  exact license and supplementary permissions with the source archive.
- [x] Run focused tests, typecheck, lint, full tests, coverage and a build.
  Keep raw output on Scratch. Address material review findings before handoff.

## Verification

Use Node 26 from the installed v26.12.1 toolchain. Run tests with
`node --test --test-concurrency=1 tests/*.test.ts web/*.test.ts`,
`node node_modules/typescript/bin/tsc --noEmit`,
`node node_modules/eslint/bin/eslint.js src tests web scripts/*.ts`,
`node scripts/coverage.ts`, and `node scripts/build.ts`.
Set `TMPDIR`, `BUILD_DIR`, `COVERAGE_DIR` and `COVERAGE_TMP_DIR` to task-owned
directories under `/Volumes/Scratch/double-entitle/`. Do not change deployment
secrets, existing data, or live services. There is no Git checkout to commit.
