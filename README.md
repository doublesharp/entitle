<p align="center">
  <img src="web/public/favicon.svg" width="88" height="88" alt="Doublesharp Entitle logo">
</p>

<h1 align="center">Doublesharp Entitle</h1>

<p align="center">
  <strong>Software licensing, subscriptions and private updates.</strong><br>
  Self-hostable, with a seller dashboard, customer portal and versioned APIs.
</p>

<p align="center">
  <a href="#local-setup">Local setup</a> ·
  <a href="docs/api.md">API reference</a> ·
  <a href="docs/deployment.md">Deployment</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="#license">License</a>
</p>

Sell software, manage licenses and deliver private updates from one Fastify
application. Sellers and buyers use Vue 3 interfaces backed by the same APIs.
SQLite is the default; PostgreSQL and MySQL share migrations and business logic.
Private release ZIPs and native artifacts live in S3-compatible storage.

Standalone mode serves one publisher with multiple products and direct Stripe
payments. Hosted mode serves multiple publishers with connected Stripe accounts,
a platform subscription and a configurable application fee, default 1%.

> The planned hosted service is **https://entitle.doublesharp.com**. This
> repository does not claim a public launch or production availability. See the
> [hosting options](#hosted-or-self-hosted) and [license terms](#license) before
> choosing a deployment.

## What it does

- Manage subscriptions, license activation, installation allowances and private
  release downloads.
- Give sellers scoped automation keys, a CLI, release controls and metrics based
  on recorded licenses, storage, downloads and payments.
- Give buyers a portal for licenses, installations, billing and downloads.
- Provide email sign-in, account recovery, publisher sandboxes, operating health
  and encrypted workspace exports.

Installed client functionality keeps working after license expiration and during
server outages. WordPress Free plugins use WordPress.org updates. This
repository does not implement Validated Field's Free/Pro split.

### Platforms and client adapters

Licensing and billing are shared across frameworks. The product framework
selects package validation, update feeds, installation policy and setup
snippets. Native clients use scoped activation tokens, immutable artifacts per
target and their runtime's signing checks.

| Platform     | Update format                          | Example                                                  |
| ------------ | -------------------------------------- | -------------------------------------------------------- |
| WordPress    | Plugin metadata and ZIP                | [PHP plugin](examples/wordpress/double-entitle-example/) |
| Joomla       | Extension update XML and ZIP           | [Installer plugin](examples/joomla/)                     |
| Electron     | Generic provider `latest*.yml`         | [JavaScript updater](examples/electron/)                 |
| Tauri        | Dynamic JSON with detached signature   | [Rust updater](examples/tauri/)                          |
| Sparkle      | Appcast with EdDSA signature           | [Swift integration](examples/sparkle/)                   |
| JetBrains    | Custom repository `updatePlugins.xml`  | [Kotlin/Java integration](examples/jetbrains/)           |
| Generic HTTP | JSON with target and checksum metadata | [JavaScript client](examples/generic/)                   |

See [platform support](docs/platform-support.md) for setup requirements and
exact qualification limits. Server tests do not qualify every native
installation flow.

## Hosted or self-hosted

Both modes provide the seller dashboard, customer portal, scoped APIs, license
activation, release publication and framework adapters. The mode determines
publisher onboarding, Stripe routing and who operates the service.

|                 | Hosted service                                                                  | Self-hosted standalone                                                                 |
| --------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Operations      | Operator handles upgrades, database, storage, email and backups                 | You run and maintain the installation                                                  |
| Publisher setup | Sign in, create a workspace and connect Stripe                                  | Configure the owner email and sign into `primary`                                      |
| Payments        | Your Stripe account through Connect Standard                                    | Your Stripe credentials; no Connect setup                                              |
| Service charges | Platform subscription and application fee, default 1%; Stripe fees are separate | No platform subscription or application fee; you pay infrastructure and provider costs |
| Products        | Multiple products within platform allowances                                    | Multiple products within configured limits                                             |
| Buyer portal    | `/t/YOUR_SLUG`                                                                  | `/t/primary`                                                                           |
| Tenant API      | `/api/v1/tenants/YOUR_SLUG`                                                     | `/api/v1/tenants/primary`                                                              |
| Server mode     | Managed by the hosted operator                                                  | `DEPLOYMENT_MODE=standalone`, the default                                              |

The hosted application fee applies to new subscriptions and their renewals. Both
modes enforce upload and security caps.

Read the configured subscription amount and application fee in the hosted
dashboard before subscribing. Both modes use your Stripe account for customer
payments. Entitle is not a merchant of record. Self-hosting does not make
storage or payment processing free.

Start with [self-hosted deployment](docs/deployment.md#self-hosted-standalone),
[hosted seller setup](docs/deployment.md#using-the-hosted-service), or the
public `/docs#hosting-options` guide. [Hosted pricing](docs/hosted-pricing.md)
explains fee changes and the application-fee refund policy. Running a platform
for independent publishers is a separate licensing question from running it for
your own products; see [License](#license).

## Local setup

### 1. Check prerequisites

Use Node **26.12.0**, pnpm **12.14.0** and TypeScript **7.0.2**. The local
fixtures also use Docker and Go. See the [toolchain guide](docs/toolchain.md).

On this macOS workspace, **`/Volumes/Scratch` must be mounted**. Keep caches,
builds, temporary files and raw evidence there.

### 2. Start the application and local fixtures

```sh
export TMPDIR=/Volumes/Scratch/double-entitle-wp/tmp/setup
mkdir -p "$TMPDIR"
pnpm install --frozen-lockfile --store-dir /Volumes/Scratch/double-entitle-wp/cache/pnpm --virtual-store-dir /Volumes/Scratch/double-entitle-wp/cache/virtual-store
node scripts/setup-local.ts
node scripts/local-s3.ts up
docker compose -p double-entitle-saas-test -f compose.test.yaml up -d mail
pnpm build
node --env-file=.env --env-file=/Volumes/Scratch/double-entitle-wp/data/local-s3/integration.env src/server.ts
```

The source-built MinIO fixture needs Go; set `GO_BINARY` if it is not
`/opt/homebrew/bin/go`. Its pinned official source is a development fixture, not
a production storage recommendation. `local-s3.ts up` builds/verifies it, starts
a loopback-only S3 server and creates a private bucket. `status` and `stop`
manage only its recorded process. Alternatively supply credentials for another
private S3-compatible bucket. No paid services or Stripe credentials are
required for local fixture mode.

`setup-local.ts` creates a mode-0600 `.env` and refuses to overwrite an existing
one. Reuse existing secrets instead of replacing them. Explicit pnpm cache flags
remain necessary with pnpm 12. On Linux, copy `.env.example` and choose
persistent/cache paths explicitly; the macOS setup helper deliberately requires
Scratch.

### 3. Sign in

The application uses `http://localhost:3211` locally.

| Page                    | Purpose                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| `/`                     | Marketing home                                                   |
| `/docs`                 | Hosting options, setup, server limits and framework requirements |
| `/seller`               | Seller sign-in and dashboard                                     |
| `/t/primary`            | Standalone buyer portal; hosted buyers use `/t/YOUR_SLUG`        |
| `http://localhost:8025` | Mailpit inbox for local sign-in and license emails               |

Standalone is the default. Set `STANDALONE_OWNER_EMAIL` to the publisher owner's
email; the setup helper uses `owner@example.test` for the local fixture. Sign in
at `/seller` and open the emailed link in the browser that requested it. Email
verification grants access to the existing `primary` workspace automatically. No
`tenant-owner` command is needed.

Configure a product and create a scoped automation key in the seller dashboard.
The key is displayed once.

> To test hosted onboarding, set `DEPLOYMENT_MODE=hosted` before starting the
> app. Sellers create a workspace after sign-in and buyers use `/t/YOUR_SLUG`.
> Existing multitenant or connected-account databases require hosted mode.
> Standalone refuses to open them and never converts or deletes their records.

### 4. Create a product and publish a release

`LOCAL_BILLING=true` enables labeled purchase fixtures and blocks real Stripe
checkout and billing-portal access.

```sh
export TENANT_SLUG=primary
# Hosted sellers use their actual workspace slug instead.
# Supply TENANT_API_KEY privately in your shell/secret store, never in a command argument.
pnpm cli product examples/product.json
curl "http://localhost:3211/api/v1/tenants/${TENANT_SLUG}/catalog"
pnpm cli demo-purchase PLAN_ID_FROM_CATALOG you@example.test
pnpm cli publish validated-field-pro 1.0.0 /absolute/path/pro.zip examples/release.json
# Other frameworks publish one immutable target at a time:
pnpm cli product examples/generic/product.json
pnpm cli publish-asset example-app 1.0.0 /absolute/path/app.bin examples/generic/release.json
```

The purchase fixture creates canonical paid entitlement and queues the initial
key email. Login links, key recovery and installation management then work
normally. License tables hold hashes; retryable delivery encrypts the
recoverable key and clears delivered payloads.

### Before accepting real payments

Standalone uses its own Stripe secret and publishable keys with a signed
`/api/v1/stripe/merchant-webhook`. It needs no Connect configuration or platform
subscription and collects no application fee.

Real hosted commerce needs the seller's connected Stripe account. Hosted
operator exemption covers platform subscription charges only, not application
fees. Hosted defaults to `HOSTED_APPLICATION_FEE_PERCENT=1` for new
subscriptions and their renewals; existing subscriptions are unchanged. Read
[deployment](docs/deployment.md) and [hosted pricing](docs/hosted-pricing.md)
before switching modes or enabling real payments.

## Operations

### CLI and access

Tenant automation uses `TENANT_SLUG` and `TENANT_API_KEY`. API-key scopes and
expiry apply to CLI calls. Remote commands need no application, Stripe or SMTP
secrets.

| Access                    | Commands                                                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Tenant API key            | `product`, `publish`, `publish-asset`, `licenses`, `revoke`, `restore`, `withdraw`, `reconcile`, `jobs`, `work` |
| Separate `OPERATOR_TOKEN` | Global commands such as `tenants`, `tenant-status`, `tenant-owner`, `platform-reconcile`, `platform-jobs`       |

### Default limits

| Limit                             | Default                                                           |
| --------------------------------- | ----------------------------------------------------------------- |
| WordPress ZIP upload              | 25 MiB; hard maximum 100 MiB                                      |
| Native artifact upload            | 100 MiB; hard maximum 2 GiB                                       |
| WordPress ZIP contents            | 2,000 entries; 250 MiB expanded                                   |
| Concurrent transfer-buffer budget | 256 MiB                                                           |
| Daily SMTP attempts               | 1,000 per tenant and 1,000 platform-wide                          |
| Failed-work retry window          | 72 hours; backoff capped at one hour                              |
| Hosted workspaces                 | Three per seller                                                  |
| Hosted trial                      | Seller-anchored 14 days; three products and 100 MiB per workspace |
| Hosted paid capacity              | 20 products and 1 GiB after a confirmed paid platform invoice     |
| Standalone capacity               | 20 products and 1 GiB in the existing `primary` workspace         |

Larger WordPress caps require at least six times the cap in transfer-memory
budget. Native packages use separate disk spool and verified-cache budgets;
see the [configuration reference](docs/configuration.md#upload-disk-and-transfer-budgets). Excess
mail defers without losing keys. After the retry window, failed work awaits
authenticated individual or bounded bulk retry.

Operators can configure workspace allowances. Standalone has no hosted trial or
platform subscription requirement; configured capacity and security limits still
apply.

### Seller metrics

Seller metrics report actual license states, paid site allowances,
installations, stored and reserved bytes, served download responses and
canonical payments and refunds grouped by currency. Amounts include taxes and
exclude Stripe fees. A served download response does not prove that a client
completed installation.

### Accounts and paid capabilities

The seller dashboard includes account sessions, emailed confirmation for
sensitive actions, offline recovery codes, dual-mailbox email changes, isolated
publisher sandboxes, Stripe tax settings, operating health and encrypted
workspace exports. Buyers can read lifecycle notices, export their own account
data and request an operator-reviewed closure. Paid rights remain separate from
account closure and hosted platform billing.

Hosted monthly Pro adds signed outgoing webhooks and advanced daily reports;
self-hosted standalone includes the local capabilities without a platform
subscription. Prices remain operator-configured. See
[hosted tiers](docs/hosted-pricing.md), [API reference](docs/api.md) and
[workspace portability](docs/portability.md).

### Optional caching

`@0xdoublesharp/adaptive-cache` caches annual Stripe price-picker results and
pure framework feed rendering, with tenant/account/input isolation. Default
storage is an 8 MiB bounded in-memory cache. Set `CACHE_REDIS_URL` to use an
existing Redis server for price-picker caching; update feeds remain in trusted
process memory. No additional service is required. See
[deployment](docs/deployment.md). Authorization, payment confirmation,
entitlement, revocation, release withdrawal, artifact reads and integrity checks
remain live. Cache failure falls back to the source operation. Cached picker
prices are suggestions; checkout still validates the current Stripe price
server-side.

## Verification

Run the standard checks:

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm test:invariants
pnpm test:fuzz
pnpm build
php examples/wordpress/tests/client-test.php
```

<details>
<summary>Database coverage and real S3 integration checks</summary>

Start disposable PostgreSQL and MySQL first. Use installed PHP on `PATH`. These
database credentials are local fixtures only.

```sh
TEST_SAAS_DATABASE_URL=mysql://root:entitle-test@127.0.0.1:53306/entitle \
TEST_POSTGRES_DATABASE_URL=postgresql://postgres:entitle-test@127.0.0.1:55432/entitle \
TEST_MYSQL_DATABASE_URL=mysql://root:entitle-test@127.0.0.1:53306/entitle \
node --env-file=/Volumes/Scratch/double-entitle-wp/data/local-s3/integration.env scripts/coverage.ts
node --env-file=/Volumes/Scratch/double-entitle-wp/data/local-s3/integration.env --test tests/s3-integration.test.ts
```

</details>

Coverage requires **100% lines, branches and functions per executable TypeScript
module**, including migrations and Vue. Engine migration tests create/drop
unique disposable databases; the test user needs those privileges. The ordinary
suite skips opt-in real integrations when their environment is absent; that does
not qualify them. Reports belong on Scratch. See
[current verification](docs/verification.md) for measured results and
integrations not exercised.

The [invariant suite](docs/invariant-testing.md) generates licensing, billing,
tenant-isolation and queue sequences. The bounded version runs with `pnpm test`;
`pnpm test:fuzz` runs longer campaigns. Failures report a seed and shrink path
for replay. PostgreSQL/MySQL runs use isolated disposable databases.

Production deployment and live charges are separate from local verification.

## Documentation

Start with the [documentation index](docs/README.md) or the application's public
`/docs` guide. The index separates publisher tasks, client integration and server
operations from historical design/plan documents.

| Guide                                                                                         | What it covers                                                    |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [Getting started](docs/getting-started.md)                                                    | First product, local fixture, purchase, activation and update     |
| [Seller guide](docs/seller-guide.md)                                                          | Plans, releases, customer support, account security and sandboxes |
| [Client integration](docs/client-integration.md)                                              | Activation lifecycle, native feeds and protected downloads        |
| [CLI reference](docs/cli.md)                                                                  | CI publication, scoped commands and reconciliation                |
| [Outgoing webhooks](docs/webhooks.md)                                                         | Event contracts, signature helper, retries and rotation           |
| [Configuration reference](docs/configuration.md)                                              | Environment defaults, validation and memory/disk budgets          |
| [Troubleshooting](docs/troubleshooting.md)                                                    | Authentication, billing, publication and delivery failures        |
| [Deployment](docs/deployment.md)                                                              | Standalone setup, hosted onboarding and production configuration  |
| [API reference](docs/api.md)                                                                  | Authentication, scoped automation and versioned endpoints         |
| [Platform support](docs/platform-support.md)                                                  | Framework adapters, signing and qualification limits              |
| [WordPress integration](docs/wordpress.md)                                                    | Plugin licensing and private updates                              |
| [Hosted pricing](docs/hosted-pricing.md)                                                      | Subscriptions, application fees and refund policy                 |
| [Backup and restore](docs/backup.md)                                                          | Service recovery procedures                                       |
| [Workspace portability](docs/portability.md)                                                  | Workspace exports and transfers                                   |
| [Offline maintenance](docs/operator-maintenance.md)                                           | Import/finalize, customer closure and reviewed retention          |
| [Toolchain](docs/toolchain.md)                                                                | Runtime and package-manager requirements                          |
| [Verification](docs/verification.md)                                                          | Measured results and remaining qualification work                 |
| [SaaS design](docs/saas-design.md) · [Stripe Elements design](docs/stripe-elements-design.md) | Architecture and checkout design                                  |
| [Contributing](CONTRIBUTING.md)                                                               | Development and source-distribution requirements                  |

Public branding lives in [src/site.ts](src/site.ts), shared by the site, API
product facts, email subjects and built HTML metadata. The header and favicon
use the [same vector mark](web/public/favicon.svg). The private app package is
`@0xdoublesharp/entitle`; first-party npm packages use the `@0xdoublesharp`
scope. Set `PUBLIC_ORIGIN` for the actual deployment. The application and HTTPS
proxy share this variable; browser navigation and API links stay on the current
origin.

## License

The service and dashboard are **source available** under
[Elastic License 2.0](LICENSE) plus
[Publisher Use Permission 1.0](ADDITIONAL-PERMISSION.md).

- Use and modify the service for your own software business, including paid
  products, buyer portals, activation, updates and downloads.
- The publisher permission does not cover offering a licensing or distribution
  platform to independent publishers. Hosted and managed services remain subject
  to the ELv2 restriction unless separately licensed. Feature flags do not grant
  rights.
- This is not an OSI open source license.
- Client adapters and examples use [MIT](examples/LICENSE). Generated client
  setup snippets also have an attribution-free
  [Zero-Clause BSD grant](examples/GENERATED-CODE-LICENSE).

Third-party software retains its own terms. See [NOTICE](NOTICE) and
[contributing](CONTRIBUTING.md).

Each build provides `/legal/source.tar.gz`, license texts and publisher
permissions, the project notice and browser dependency notices. Public docs and
both account interfaces link to source/license information. The archive uses the
explicit reviewed allowlist in `scripts/source-files.txt`; it excludes
deployment secrets, customer data, package storage, caches and run reports. Keep
it current when adding project source. A local build does not publish a remote
repository. See [contributing](CONTRIBUTING.md).
