# Docker and native browser verification, 2026-10-22

The actual multistage Dockerfile built successfully with pinned Node 26.12.0.
The latest Linux suite passed **941/941 tests**, zero failures or skips, and
all 65 application TypeScript modules independently met 100% lines, branches
and functions. TypeScript, ESLint and the production build passed in Docker.

The production-mode image became ready using private local S3 over TLS while
running as UID 1000 with a read-only root filesystem, dropped capabilities
and persistent data. Enabling local fixture billing in production was refused.
Container replacement preserved products, licenses, releases and API keys.
The custom-port healthcheck now probes the configured port.

The built-in browser exercised real Docker routes and local SMTP email links,
without mocked API responses: seller login/product creation/API-key issuance,
all 13 seller destinations, ZIP publication, customer login/download checksums,
deactivation and key replacement, cross-customer denial, hosted first-workspace
onboarding/Pro gating, and encrypted export creation/recovery/download access.
The checks found and fixed invalid local fixture identifiers and a publication
form that sent an internal product ID instead of the API's product slug.

The native browser still times out taking snapshots and reports resize settings
that do not match its measured viewport, including after retesting nightly
0.1.2-nightly.20261022.3526. Navigation, DOM reads and clicking work.

The user-approved visual-only Playwright fallback captured 123 actual Docker
page/width cases at 320, 390, 834 and 1440 pixels: public home/docs/source-and-license information,
all 13 seller sections in standalone and hosted modes, the buyer portal, and
expanded standalone daily reports. There were no uncaught page exceptions,
document overflow or measured table-header clipping. Representative screenshots
were inspected for spacing and readability. The runner allowed only read
requests and local test sign-in POSTs; it made no business mutations or mocked
API responses. This checks installed Chrome, not real mobile devices or Safari.

Live Stripe, external email, signed desktop installs and production deployment
remain unqualified. Production-mode runtime checks used local TLS storage and explicit
nonfunctional Stripe placeholders; they made no payment-provider calls.

Evidence: `/Volumes/Scratch/double-entitle-wp/reports/docker-ui-20261022/`.
Source review acceptance from earlier rounds does not cover these new fixes.
The historical snapshots below retain their original scope and qualification.

# Verification workflow completion checks, 2026-10-22

The current gate passed **938/938 tests**, with no failures, cancellations or
skips. All **65 modules** independently reached **100% lines, branches and
functions**. Strict TypeScript 7, ESLint, formatting and the production build
passed. All 271 source files kept their gate hashes.

Verification Continue opens and fills the intended form even if the seller
already visited that page. Its generation key changes only on Continue, so
consuming or invalidating a proof retains new recovery codes and export handles.
Invalidation checks the original page and token through a callback that works
after unmount. It preserves other-purpose and newer proofs while removing a
stale same-purpose proof. Successful export also clears link-sent feedback.

Real installed Chrome loaded production assets with controlled server-shaped
API fixtures. All **56 page/width cases** at 320, 390, 768, 810, 834, 867, 1024
and 1440 pixels passed with no document overflow or uncaught page exceptions.
Both actions were tested in fresh tabs, directly and after visiting the target
before Continue. The opened summary is focused inside the 390 x 844 viewport,
and the resulting codes or export downloads stay visible. Table bounds were
checked through the narrow tablet/sidebar interval, including header text.

Evidence is `coverage-r8/` and `root-verification-r8.json` in the shared SaaS
reports directory, plus sibling `reports/feature-layout-20261022/r4/`.
The browser script and all captures are preserved there. Existing backend and
nonmeasurement docs acceptance remains unchanged. The final UI review is
recorded separately; test coverage alone is not source review acceptance.
No additional external provider, physical phone, Safari or screen-reader
qualification is claimed. Earlier snapshots below describe older source.

# Feature workflow review fixes verification, 2026-10-22

The current combined suite passed **933 tests, zero failures and skips**.
All **65 modules** independently meet **100% lines, branches and functions**.
Strict TypeScript 7, ESLint and the production build passed. All 271 allowlisted
source files kept their hashes throughout the gate.

Emailed verification links now open the relevant recovery/export disclosure,
including when a saved export exists. Errors retain the open form and its draft;
link-sent feedback stays beside the action. Sandbox and email-change forms give
concise explanations of irreversible consequences. Hosted billing uses readable
statuses, standalone hides hosted placeholders, and fees sit with customer
payments. Webhooks show endpoint URLs and readable delivery states. An existing
closure shows its request status without another request button.

Real Chrome checked seven feature pages at 320, 390, 768, 1024 and 1440 pixels,
using the actual production bundle with controlled, server-shaped API fixtures.
All 35 page/width cases had no document overflow or browser errors. Additional
interactions checked both prefilled proof links, open-form/draft preservation,
one-time secrets outside collapsed configuration, standalone billing and the
restricted/first-workspace security headings. At 320 and 390 pixels the queue's
four columns and label text fit their cells without horizontal scrolling.
This proves local UI behavior, not external provider qualification.

Final gate evidence is `coverage-r6/` and `coverage-r6.log`; UI evidence is the
sibling `reports/feature-layout-20261022/r2/`. The R5 backend source verdict
accepted the closure fixes. Two remaining documentation Low findings were fixed
with explicit legacy-null and Compose ownership guidance. Fresh UI and docs
review results are recorded separately; the gate alone is not review acceptance.

Earlier snapshots below describe their stated older source.

# Feature layout and round-4 fixes verification, 2026-10-22

The combined suite passed **926 tests, zero failures and skips**. All **65
application modules** independently reach **100% lines, branches and functions**.
Strict TypeScript 7, full ESLint and the production build passed. All 271
allowlisted source files retained their hashes during the gate.

The new dashboard groups desktop navigation and uses a page selector on mobile.
Operations uses readable metric cards and queue/report tables. Tax overrides,
webhook setup, recovery, email changes and export creation use native disclosures.
One-time secrets and actionable errors remain outside collapsed setup. Billing
shows actual allowances, fees and connection status; active subscribers are not
offered a second subscription. Standalone hides the unsupported email-change UI.

Real Chrome exercised seven feature pages at 320, 390, 768, 1024 and 1440 pixels,
using the actual built frontend with controlled API fixtures. All 35 page/width
cases had no document overflow or page errors. One-time recovery codes stayed
visible after their configuration disclosure closed. These captures test layout
and browser behavior, not provider qualification. Actual viewport sizes are recorded with the browser evidence.

Portability now preserves receipt-free awaiting-operator and blocked closure
requests as well as completed closures. An unfinished request with existing
privacy receipts receives `409 closure_reconciliation_pending` before artifact
reads; an operator must finish that privacy review before transfer. Pending
customers continue canonical reconciliation. Completed customers retain their
precise provider-read skip. Retained authenticated HMAC bindings minimize late
events even when a later receipt has a null or historical attribution value.

SQLite/PostgreSQL/MySQL, private MinIO, Redis, PHP and local TCP fixtures were
exercised. External Stripe, SMTP, DNS/TLS, fresh Docker images, signed desktop
installs and production retain the qualification scope recorded below.
Source and docs/UI reviews are separate pending gates. Evidence is in
`/Volumes/Scratch/double-entitle-wp/reports/saas-features-20261021/` and
`/Volumes/Scratch/double-entitle-wp/reports/feature-layout-20261022/`.

Earlier snapshots below are historical and are superseded where stated here.

# Round-3 SaaS fixes verification, 2026-10-22

The full combined gate passed **911 tests, zero failures and skips**, with all
**65 executable modules independently at 100% lines, branches and functions**.
Strict TypeScript 7, full ESLint and the compiled server/Vue/source-distribution
build passed. Runtime, tests and documentation remained unchanged during the
gate. See [coverage](coverage.md) for totals and evidence.

The round-3 fixes restore new Checkout after canonical terminal cancellation,
recover stale unexecuted attempts safely, reuse verified dedicated Portal
configurations, preserve completed customer closures across encrypted tenant
transfer, rekey attribution at the destination and skip closed subscriptions
before provider reads. The operator CLI upgrades legacy receipts through an
explicit reviewed mode and retained keyed proof. No application secret or source
attribution key is transferred.

Export cleanup failures retain their disk charge and no longer interrupt other
tenants' billing or email jobs. Authenticated export listing and dashboard resume
and delete controls recover lost handles. Download leases are reserved before
opening files and released only on descriptor close. Import and export stage
one plaintext artifact at a time; the exact disk bound is documented in
[portability](portability.md). Development binds loopback by default; production
containers retain their external listener behind HTTPS.

Local PostgreSQL/MySQL isolated fixtures, private MinIO, Redis, PHP and actual
TCP tests were exercised. The expanded public documentation and its frontend
were included in the gate. Independent review is a separate pending gate.

No real Stripe test-account Checkout/Connect/Portal/Tax qualification, external
SMTP/DNS/TLS, real-network gigabyte transfer, fresh Docker image build, signed
desktop installation or production deployment is claimed. Earlier native
WordPress/Joomla evidence retains its historical scope. The shared Docker disk
image remains on the internal Data volume, so new bulky layers were not written
there under the disk policy. Immediate platform tier switching is unavailable;
period-end cancellation followed by new Checkout is the supported path. Unlinked
manual credit prorations and upstream funding provenance need operator review.

Earlier snapshots below describe older bytes and are superseded where this
round explicitly implements the previous completed-closure transfer boundary.

# Round-2 SaaS fixes verification, 2026-10-22

The new combined gate passed **875 tests, zero failures or skips**, with every
one of **64 executable modules at 100% lines, branches and functions**.
Strict TypeScript 7 and full ESLint passed. Runtime and test hashes stayed
unchanged throughout the gate. [Coverage](coverage.md) records exact totals.

The verified fixes preserve renewal-gap business events for bounded later paid
qualification, enforce a dedicated safe Stripe Portal configuration, let admitted
large operations use their own deadlines, isolate per-tenant export admission,
reuse leased verified cache files, list precise closure blocker IDs and prevent
late events from restoring identity within retained closure history.

Tier changes currently require cancellation at period end followed by a new
Checkout after canonical cancellation. Immediate tier changes are unavailable.
Operator-created unlinked proration credits and funding provenance of applied
balance credits remain outside automatic accounting. Real Stripe test-account
Portal/Tax/Connect qualification is still required before release.

Transfers involving completed customer closures need a separately reviewed
attribution migration before destination webhooks or workers run; current
import/finalize does not automate that privacy migration. See
[operator maintenance](operator-maintenance.md#discover-closure-blockers-before-reconciliation).
No production deployment, live charge, external SMTP/DNS/TLS, new Docker image
build or signed desktop installation is claimed. Earlier integration limits
below remain unless explicitly superseded.

Final review evidence and gate outputs live under
`/Volumes/Scratch/double-entitle-wp/reports/saas-features-20261021/`.
The earlier 821-test result is the pre-round-2 snapshot.

# SaaS feature verification, 2026-10-22

The combined suite passed **821/821 tests, zero skips**, with every one of **63
application modules at 100% lines, branches and functions**. Strict TypeScript 7,
ESLint and the compiled server/Vue production build passed. The source snapshot
was hashed before the run and checked for drift afterwards. See
[coverage](coverage.md) for exact totals and evidence locations.

This batch adds hosted Starter/Pro entitlements, isolated seller sandboxes, tax
settings, account recovery and sessions, customer export and reviewed closure,
encrypted portability and operator maintenance, durable business webhooks,
operating metrics/alerts and larger verified streaming artifacts. Self-hosted
advanced functionality needs no platform subscription. Platform delinquency does
not revoke buyers' already-paid download rights.

Actual local PostgreSQL/MySQL migration fixtures, private MinIO transfers above
100 MiB, Redis and PHP fixtures were exercised. The existing local development
server was restarted against its preserved database and private storage; readiness
and the new hosted-mode limits returned successfully. No production deployment,
live Stripe charge, public DNS/TLS or external SMTP delivery occurred.

Stripe Checkout, Billing, Connect, Tax, Portal and reconciliation use controlled
SDK/HTTP fixtures. Live Stripe test-account qualification and the linked-proration
portal policy remain pre-release requirements. Unlinked classic/manual returned-
time credits are unsupported. Signed native desktop installations remain
unqualified. Earlier WordPress/Joomla installation evidence below is historical;
this batch did not repeat those complete installer paths. A fresh Docker image
build has not been repeated for this batch because the shared Docker disk image
is on the internal Data volume; new bulky layers there violate the disk policy.

Raw evidence remains outside the repository under
`/Volumes/Scratch/double-entitle-wp/reports/saas-features-20261021/`.
Earlier snapshots below describe their stated source and integration scope.

# Verification results

## Current marketing home and public docs, 2026-10-21

The home page explains the purchase-to-license-to-update journey with native
SVG/HTML graphics, benefit-led feature cards, supported-framework badges and a
first-class WordPress panel. Two workspace signup actions lead to `/seller`.
Setup, dynamic server limits, billing caveats and native adapter requirements
now live at `/docs`, also reachable directly at `/docs/`. Home needs no API
request. Public documentation uses only the existing server-info endpoint.

The final gate passed **503 tests, zero failures or skips** and **100% lines,
branches and functions in all 40 executable TypeScript application modules**.
Totals: 12,597 lines, 2,905 branches and 755 functions, all covered. Strict TS7,
ESLint and the production build passed. Opus 5.5 accepted both review rounds;
all five reviewed source hashes matched after the final run. Tests cover direct
HTTP docs routes, home-to-docs section links, real signup destinations, public
request boundaries and retrying failed server-limit requests.

The actual built app was checked through native browser navigation/evaluation
at desktop size. Direct home, docs and trailing-slash docs routes worked;
server limits loaded and no private requests or broken fragment targets appeared.
Native snapshot timed out and viewport resize did not change the measured
window. Exact actual DOM/CSS was therefore rendered and inspected with native
T3 HTML preview at desktop and mobile widths. Final 390px and 320px renders
had matching document/viewport widths and no horizontal overflow. This does not
qualify a real mobile device or native mobile window. No security policy changed.

Final evidence is under
`/Volumes/Scratch/double-entitle-wp/reports/home-marketing-20261021/`:
`coverage-r2/summary.json`, `coverage-r2.log`, `verification.json`,
`source-manifest.json`, `browser-notes.md` and `opus-review-r2.md`.
The earlier 502-test gate predates final polish. No dependencies, tracking,
production deployment or live charges were added. Traffic and conversion gains
need measurement after launch; none are claimed by local UI verification.
Native installer, external Stripe/SMTP/DNS and Docker qualification were not
repeated by this frontend pass. Earlier integration limits below still apply.

## Earlier admin layout and public positioning, 2026-10-21

The admin interface now separates Overview, Products, Releases, Licenses, Client
setup, API keys and Billing. A compact workspace selector, four overview metrics,
collapsible detail/creation forms and consistent record/table spacing replace
the continuous page. Drafts persist across sections; workspace changes and sign-out
reset navigation, and pending actions disable navigation/workspace selection.
Storage allowances use readable units while detailed counts remain exact.
The public headline is Software licensing and updates, with first-class WordPress
support described separately.

The full real-database/S3 suite passed **501 tests, no failures or skips**, with
**100% lines, branches and functions in every one of 40 application modules**.
Totals: 12,196 lines, 2,894 branches and 751 functions. Strict TS7, ESLint and the
production build passed. Final evidence is under
`/Volumes/Scratch/double-entitle-wp/reports/admin-style-20261021/coverage-r2/`,
with `coverage-r2.log`, `verification.json` and `source-manifest.json` alongside it.

Opus 5.5 accepted the revised code in round 2. Its first-round finding exposed
an empty page for new sellers. Regression tests reproduced it before the fix;
new sellers now see an open workspace form and guidance. Recovery and refresh
headings also reflect their actual state. All three reviewed source hashes still
match after the final gate. Reports are `opus-review.md` and `opus-review-r2.md`
in the same Scratch directory. Opus reviewed source; the root ran the checks.

The actual browser checked 1280px desktop and 390px mobile. The same fixture's
initial overview height fell from 4,765px to 823px; only one section is visible.
Expanded product/release forms fit on mobile, and the license table scrolls inside
its own container without document overflow. Main body, muted text, navigation,
selected navigation and table headings meet 4.5:1 contrast. Authentication used
real local Mailpit email and the browser-bound confirmation flow. A separate
first-time seller session confirmed the visible workspace form at both widths
and was signed out afterward. No workspace, product, billing, license or release
mutation was submitted during visual checks, and no live payment occurred.

The earlier native/backend results below remain scoped to their stated runs;
this change modifies only frontend presentation and interaction tests. It does
not repeat native installation, Docker or external billing qualification.

## Current multi-framework SaaS, 2026-10-21

The final frozen implementation passed **495 tests, zero failures and zero skips**.
All **40 executable TypeScript application modules** under `src/` and `web/` have
**100% lines, branches and functions**, including seven migrations and all five
web modules. Totals are 12,060 lines, 2,870 branches and 746 functions, all covered.
Strict TypeScript7, flat-config ESLint and the production build passed.

Opus5.5 round3 returned **ACCEPT for source**, conditional on this full gate and
unchanged hashes. Both conditions passed: the gate exited0 and all131 reviewed
file hashes matched afterward. Two nonblocking documentation corrections were
then applied for Joomla's required client field; runtime source stayed unchanged.
This is local implementation acceptance, with the integration limits below.

| Verification | Result |
| --- | --- |
| Real SQLite, PostgreSQL18.6 and MySQL8.4.11 | Shared migrations, billing, licensing and framework queries passed |
| Final PostgreSQL late-fix regressions | 16passed; one MySQL-only interrupted-DDL test intentionally skipped on PostgreSQL |
| Final full suite with real MySQL/PostgreSQL/MinIO and PHP | 495passed, no skips |
| Real private MinIO backup/restore | Six assets restored after original bucket/database removal; multi-target hashes, ranges, cached URLs, isolation and withdrawn retention passed |
| Final production Docker image | Build and nonroot/read-only smoke passed; readiness verified through privately trusted TLS to MinIO, migration007, built Vue, compiled CLI and absent production fixture endpoint |
| Browser | Seller framework fields and device allowances verified at1280px and390px with no horizontal overflow; real private metrics displayed |
| Native Joomla6.1.3/PHP8.5.11 | Real library update1.0.0-to-2.0.0, authenticated discovery/package checksum, immutable public details reload, settings-save activation persistence and deactivation passed |
| Native WordPress7.1.3/PHP8.3.35 | Normal update screen, WP-CLI and automatic-updater installation path passed in the SaaS fixture; final activation/package SHA/deactivation checks passed on the framework snapshot |
| Sparkle2.9.1 | Swift example passed typechecking against a real SDK; no install/relaunch claimed |
| Other native contracts | Executed PHP and Java scopes, generic/Electron lifecycle and error handling, structured XML/YAML/JSON rendering; Rust parser/format checks |

Review and tests found and corrected Joomla's unauthenticated native details
reload and settings-save loss of activation identity, Sparkle's read-only feed API
and benign-error handling, Electron's ARM Linux channel filename and duplicate
error listeners, YAML control characters, ambiguous Joomla client identity,
interrupted MySQL migration constraints, and download errors retaining attachment
headers. Earlier SaaS billing, session, retry and resource-limit fixes remain
covered. [Coverage details](coverage.md) describe the denominator and reproduction.

The current Docker image is
`sha256:c94e72d4b2a374795a48530c428489db6d6e0a2bbd20f22d47bb100fa213ca2d`.
Its isolated production fixture was removed after verification. The local app,
WordPress, database and email fixtures were restored after the T3 restart. The
WordPress example remains active1.3.0 with its license deliberately deactivated.

Reports remain outside the repository under
`/Volumes/Scratch/double-entitle-wp/reports/`: `framework-resumed-coverage/`,
`framework-final-acceptance-receipt.json`, `saas-opus55-final-framework-r3.md`,
`framework-final-engines-report.md`, `framework-backup-report.md`,
`framework-docker-report.md`, `framework-joomla-integration-report.md`,
`framework-wordpress-final-report.md` and `framework-protocols-review-report.md`.
The interrupted `framework-accepted-coverage` run is not a passing result.

No production deployment, paid service purchase or live charge occurred. Stripe
Checkout/Connect/Billing/Portal/Elements use controlled SDK/HTTP fixtures; no
Stripe test-account payment or live provider event delivery was exercised.
Mailpit received real local SMTP; external SMTP/domain delivery and public DNS/TLS
remain unqualified. Joomla qualification covers the library update path only.
Electron, Tauri and JetBrains signed native install/relaunch, desktop key stores,
Sparkle installation and the full Kotlin IDE SDK build remain unqualified.
PostgreSQL/MySQL dump-and-restore procedures are documented but were not executed.
WordPress multisite, the real Validated Field Pro ZIP and its Free/Pro split remain
outside this work.

Joomla's public immutable version-details document contains only release metadata
and a protected package URL. Every artifact request still checks entitlement.
Range requests currently verify the full stored object and reserve twice its size;
S3 ranged reads and differential updates remain deferred. Download metrics count
served responses including206, rather than completed installations.

## Historical snapshots

The following results describe earlier source snapshots and do not supersede the
current gate or native/SaaS evidence above.

### Site and documentation update, 2026-10-21

The site now uses shared public branding from `src/site.ts`, including its planned
hosted address, HTML title/description and visible branding. Deployment shares
`PUBLIC_ORIGIN` between the application and Caddy. This change does not configure
DNS or deploy the service. The site and [platform support](platform-support.md)
distinguish language-independent licensing APIs from the currently supported
WordPress release pipeline.

Fresh checks for this change: 86 UI tests passed with no skips and 100% lines,
branches and functions across the four web modules and shared site module.
Strict TS7, lint on the changed code, the production build, Compose configuration
and offline Caddy adaptation passed. Caddy resolved the shared origin to the
expected HTTPS host on port443. The local browser displayed the generated metadata, shared
hosted link, same-origin seller link and platform support copy at 1280 px without
horizontal overflow. These focused checks do not replace the pending final SaaS
whole-system gate or Opus re-review. The older results below describe their stated
snapshots, including the former single-tenant deployment.

Raw UI output is in
`/Volumes/Scratch/double-entitle-wp/reports/site-update-20261021/ui-coverage.log`.

### Earlier verification snapshot

Latest automated verification: 2026-10-21. Browser, Docker/recovery and WordPress integration results below were collected on 2026-10-20. No production deployment, purchase of services or live charges were performed. Earlier source review corrections covered checkout ownership/customer-creation races, direct-charge refund routing, canceled-email retry, proxy port and canonical-version issues.

### Automated checks

| Check | Result |
| --- | --- |
| Exact runtime/compiler | Node 26.12.0, TypeScript 7.0.2 |
| Strict TS7 check and flat-config ESLint | Pass |
| Vite production build and server compilation | Pass |
| Full Node coverage suite | 185 tests pass, zero skipped with real MySQL enabled |
| Per-module application coverage | 19 modules each 100% lines, branches and functions |
| Shared SQLite core suite | 23 tests pass |
| Shared PostgreSQL core suite | 22 pass, one SQLite-specific hook test skipped on PostgreSQL 18.6 |
| Shared MySQL core suite | 22 pass, one SQLite-specific hook test skipped on MySQL 8.4.11 |
| Current PostgreSQL and MySQL core/billing/Stripe regression matrix | Each engine: 49 pass, one SQLite-specific hook test skipped |
| Dependency audit | No known production vulnerabilities reported at verification time |
| PHP boundary tests and syntax checks | Pass |

See [coverage details](coverage.md) for the enforced denominator, command and bugs found while expanding tests. Concurrent operator setup also passed separately on PostgreSQL and MySQL. A fresh MySQL migration test additionally verifies binary collation, case-distinct provider IDs, four-byte Unicode and constraint enforcement.

The current Opus follow-up fixes were reproduced with seven failing regression tests before code changes. Scheduled reconciliation now reuses one job per subscription, preserving pending retry timing and live worker leases; completed jobs can be scheduled again. Deleted/email-less unrelated Stripe customers no longer poison reconciliation, existing customers still receive billing-state updates, and new paid issuance without a usable email remains safely retryable. A failed login-link confirmation preserves an already authenticated account, visible replacement key and CSRF. All focused regressions, strict TS7/lint, production build and compiled startup smoke passed. Evidence is under `/Volumes/Scratch/double-entitle-wp/reports/opus55-current-20261021/`.

The database suites run the same real business queries against each engine. Fresh PostgreSQL/MySQL databases applied the final migration, and migration reruns were checked. Coverage includes initial settled purchase and renewal; duplicate/out-of-order durable events and retries; cancellation/failed-payment paid periods; paid/unpaid plan changes and future downgrades; full refunds/dispute suspension/resolution; concurrent seat limits; repeat activation, site moves and deactivation; staging exemptions; key/token replacement; retryable initial key email and cancellation races; case-sensitive provider identifiers and large encrypted webhook payloads; publication integrity, immutability and withdrawal.

API tests cover raw Stripe signatures, session token replay/expiry, CSRF, actual cross-customer objects, operator authentication, private ZIP publication, stable cached package URLs, delayed authenticated requests, and expired/revoked/refunded/suspended denial. Stripe SDK tests use a real local HTTP fixture with the pinned API version. They exercise positive paid invoice lines, negative credits, partial/full refunds, open/lost/won disputes, direct-charge event routing, safe Checkout customer ownership and concurrent first checkout.

### Browser and local email

The Vue interface was exercised in the T3 browser at desktop 1280 px and mobile 390 px widths. Login email delivery used real SMTP to Mailpit. A login link opened in an existing tab initially exposed a fragment-handling bug; the corrected hashchange path has a regression test. The browser verified explicit link confirmation, fragment removal, single-use failure, dashboard dates/allowance, one-time replacement-key display, activation/deactivation, authenticated ZIP bytes/checksum, logout, and a CSRF rejection that preserved the session. No horizontal overflow was observed.

Local fixture mode explicitly returns unavailable errors for Checkout and Portal. Their UI loading/error recovery was checked. No live Stripe redirect is qualified by that result.

### Real WordPress integration

WordPress **7.1.3**, PHP **8.3.35**, actual WordPress HTTP and upgrader APIs, no upgrader mocks:

- License activation twice returned the same scoped token and stable UUID. Metadata, plugin information, normal admin license form and authenticated package SHA-256 passed.
- The normal WordPress plugins screen was inspected in a logged-in browser and showed the 1.1.0 update, details link and update action for installed 1.0.0.
- Native `wp plugin update double-entitle-example` installed 1.0.0 -> 1.1.0.
- `WP_Automatic_Updater::update` in real cron context installed 1.1.0 -> 1.2.0 and preserved active plugin/activation state. This exercises the automatic updater path, not an elapsed cron schedule.
- Authenticated `admin-ajax.php` `update-plugin`, with real WordPress login cookies and nonce, installed 1.2.0 -> 1.3.0 and left the plugin active.
- A cached older package URL downloaded the same immutable bytes after a newer release appeared. A real service relay outage preserved cached metadata, token, installation UUID and installed shortcode functionality.
- Final license deactivation cleared the token and freed the seat while the plugin and shortcode remained active.

The coverage follow-up additionally ran the current SDK through real `WP_Upgrader::download_package` and WordPress HTTP against a local credential-checking fixture. Authenticated SHA-256 download, scoped Bearer cleanup, foreign/unattributed package preservation, changed/invalid endpoint rejection and prior-handler file rejection passed. Full admin/manual/automatic installations above were performed before these follow-up SDK guard changes; those full installation paths were not repeated afterward.

Only the example plugin in this repository was installed. The existing Validated Field repository was not changed. Local-only HTTP allowances and Docker loopback relays exist solely to test the canonical localhost URLs. See [WordPress workflow](wordpress.md) for commands and the distinction between native/core integration and unit doubles.

### Docker and recovery

The production Docker image built with pinned Node and pnpm, TS7 checking, ESLint and the Vue build. It ran as the unprivileged user with a read-only root filesystem and a writable Scratch-backed `/data` volume. The supplied Caddy configuration served API readiness and built Vue HTML through locally trusted HTTPS. Operator product setup worked and the development purchase endpoint was absent in production mode.

A stopped-volume SQLite archive was restored into a new directory and a new application container. The restored product/plan and release metadata, immutable ZIP size/SHA-256, readiness and startup migration rerun passed. Compiled local `pnpm start` was also exercised separately. The documented PostgreSQL and MySQL dump/restore procedures were not executed; those engines' migrations and business logic were exercised separately.

### Integration limits

External Stripe Checkout, Billing event delivery, Customer Portal settings/plan transitions and real Stripe reconciliation were not called without credentials. The SDK integration is fixture-qualified, not Stripe test-account-qualified. Before production use, run the documented Stripe test-mode purchase, renewal, unpaid upgrade, refund, dispute and Portal scenarios with your configured prices and webhook endpoint.

SMTP delivery to Mailpit was real. Internet SMTP authentication, TLS, domain authentication and recipient delivery were not exercised. Public DNS and publicly issued HTTPS certificates were not configured. Multisite behavior, a real Validated Field Pro ZIP and its future Free/Pro split remain outside this MVP verification.
