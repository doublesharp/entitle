# CLI reference

Run commands from the source checkout with the pinned Node runtime. `pnpm cli`
runs `src/cli.ts` and reads `.env` when it exists. Remote publisher commands do
not need the server's application, storage, SMTP or Stripe secrets.

## Publisher connection

Supply these settings through a protected environment or secret manager:

| Variable         | Value                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `PUBLIC_ORIGIN`  | Deployment origin, default `http://localhost:3211`. No path, query, credentials or fragment. |
| `TENANT_SLUG`    | Required explicit public workspace slug; set `primary` for the default standalone workspace. No CLI default.                     |
| `TENANT_API_KEY` | Scoped, unexpired key created in the seller dashboard. Required.                             |

The CLI validates the slug and `DE-TK-...` key format before making requests.
API authorization still checks expiry, tenant ownership and scopes. Supply
credentials privately; never put them in command arguments, JSON metadata or
release packages. Output is JSON on success. Errors return exit 1; successful
commands return exit 0. Known configured credentials are redacted from messages,
but license/customer output still needs private handling.

## Publisher commands

| Command                                            | Required scope      | What it does                                                                              |
| -------------------------------------------------- | ------------------- | ----------------------------------------------------------------------------------------- |
| `product [FILE]`                                   | `catalog:write`     | Saves product/plans from JSON; defaults to `product.json`.                                |
| `publish PRODUCT VERSION ZIP METADATA_FILE`        | `releases:write`    | Publishes a WordPress ZIP.                                                                |
| `publish-asset PRODUCT VERSION FILE METADATA_FILE` | `releases:write`    | Streams one native asset with declared length.                                            |
| `licenses`                                         | `read`              | Returns seller overview, including safe license/release data and metrics.                 |
| `revoke LICENSE_ID`                                | `licenses:write`    | Sets the seller's manual revocation.                                                      |
| `restore LICENSE_ID`                               | `licenses:write`    | Clears that manual revocation; refund/dispute restrictions remain.                        |
| `withdraw RELEASE_ID`                              | `releases:write`    | Withdraws every target of a release; retains storage.                                     |
| `reconcile [SUBSCRIPTION_ID]`                      | `billing:reconcile` | Discovers merchant subscriptions or queues one subscription for canonical reconciliation. |
| `jobs`                                             | `read`              | Lists safe tenant work/email states, attempts and errors.                                 |
| `work`                                             | `billing:reconcile` | Runs a bounded batch of tenant work.                                                      |
| `demo-purchase PLAN_ID EMAIL`                      | `licenses:write`    | Creates entitlement in local billing mode only, without a real charge.                    |

The `licenses` command is an overview, not a paginated all-history export. Use
the dedicated [encrypted export API](portability.md#export) for a workspace
transfer. Automation keys cannot perform interactive owner-only actions.

## Publish from CI

Keep product and release metadata in source control; keep private packages and
credentials out of public artifacts. Replace the example Stripe price IDs with
prices from the intended account/mode before product creation.

```sh
export PUBLIC_ORIGIN=https://licenses.example.com
export TENANT_SLUG=primary
# The CI secret store supplies TENANT_API_KEY without printing it.
pnpm cli product examples/product.json
pnpm cli publish validated-field-pro 1.0.0 \
  /absolute/private/path/validated-field-pro.zip examples/release.json
```

Native publication uses a different endpoint and metadata shape:

```sh
pnpm cli product examples/generic/product.json
pnpm cli publish-asset example-app 1.0.0 \
  /absolute/private/path/app.bin examples/generic/release.json
```

`publish-asset` opens a regular file without following symlinks, sends
`Content-Length`, and encodes metadata into `X-Release-Metadata` as base64url
JSON. It permits 1 byte through 2 GiB locally, but the server's configured cap,
disk admission and workspace quota can be smaller. WordPress `publish` reads
the ZIP into memory and uses the separate WordPress limit.

A duplicate version/target is a conflict, not an overwrite. If an upload times
out after the server may have committed, inspect the release inventory and
checksum first. Do not generate a new version merely to hide an ambiguous
publication result.

## Recover billing and jobs

```sh
pnpm cli reconcile sub_REPLACE
pnpm cli jobs
pnpm cli work
```

Reconciliation retrieves canonical provider state; it does not charge a customer.
The normal server worker runs every five seconds. `work` is a bounded manual
batch, not a persistent worker or scheduler. Discovery with `reconcile` and no
subscription should be scheduled separately according to your operating policy.

Failed work/email retries use the API because the CLI has no retry command:

```http
POST /api/v1/tenants/primary/seller/jobs/work/JOB_ID/retry
Authorization: Bearer SELLER_API_KEY
Content-Type: application/json

{}
```

Replace `work` with `emails` for email jobs. Bulk retry uses
`POST /seller/jobs/:table/retry-failed` with `{ "limit": 100 }`; the accepted
range is 1-500. Both require `billing:reconcile`. Inspect the failure and resolve
its cause before retry. Explicit retry starts a fresh retry window; mail-budget
deferral does not discard encrypted keys.

## Platform operator commands

These commands require the independent `OPERATOR_TOKEN`, at least 32 characters.
They use `OPERATOR_ORIGIN` when supplied, otherwise `PUBLIC_ORIGIN`, and target
`/api/v1/operator`. A publisher key cannot substitute for that token.

| Command                             | Behavior                                                      |
| ----------------------------------- | ------------------------------------------------------------- |
| `tenants`                           | Lists platform tenants.                                       |
| `tenant-status TENANT_ID JSON_FILE` | Applies reviewed status/capacity settings.                    |
| `tenant-owner TENANT_ID EMAIL`      | Assigns ownership to a verified seller.                       |
| `platform-reconcile TENANT_ID`      | Queues hosted platform-subscription reconciliation.           |
| `platform-jobs`                     | Lists safe platform job/email state.                          |
| `platform-work`                     | Runs a bounded batch of platform work.                        |
| `local-tenant TENANT_ID JSON_FILE`  | Development-only fixture state; unavailable for real billing. |

Use internal tenant IDs, not public slugs. A status file can contain `suspended`,
`exempt`, `maxProducts` and `maxStorageBytes` within server validation limits.
An exemption covers platform billing capacity, not hosted Pro or application
fees. Standalone ownership is assigned automatically on verified owner sign-in.

## Local database and offline maintenance

`pnpm cli migrate` opens the locally configured database, applies migrations and
closes it. It requires full server configuration and does not contact the HTTP
API. Normal server startup also migrates. Back up matching database, private
objects and `APP_SECRET` before an upgrade; do not run competing app versions.

Encrypted imports and customer closure review use `pnpm maintenance`, a separate
offline tool with mandatory named operator and quiescence attestations. Read
[operator maintenance](operator-maintenance.md) before using it. Do not treat
an HTTP queue action or tenant suspension as proof that all workers have drained.

`closure-attribution-upgrade` adds encrypted, scope-bound attribution to older completed-closure receipts using a private reviewed receipt with explicit Stripe mode and proven provider customer ID. See [operator maintenance](operator-maintenance.md#upgrade-legacy-closure-attribution).
