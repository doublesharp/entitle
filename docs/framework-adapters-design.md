# Framework adapters

Requested for implementation on 2026-10-21: extend the existing service with
framework adapters and app differentiation. Execute this design within that
authorization. Preserve the prior SaaS design, security fixes and local data.

## Scope and alternatives

Use one shared licensing/billing service with small framework adapters. Separate
services would repeat entitlement and tenant checks; pretending every package is
a WordPress ZIP would weaken validation and produce invalid native update feeds.
Supported product framework values are `wordpress`, `joomla`, `electron`, `tauri`,
`sparkle`, `jetbrains`, and `generic`. Add client examples for all new frameworks.
Keep the existing WordPress client and update UI working.

No production deployment, live charges, remote feature disabling, beta channels,
delta generation or code-signing service. Sellers build and sign their artifacts.
Do not claim native-runtime qualification from API fixtures or template tests.

## Product and installation model

Migration007 adds `products.framework` defaulting to `wordpress` and
`products.framework_config` containing validated JSON. Product APIs accept
`framework?` and `frameworkConfig?`; omission preserves existing configuration,
or defaults to WordPress for a new product. Public/seller DTOs expose `framework`
and parsed `frameworkConfig`. `pluginBasename` applies only to WordPress.
After licenses or releases exist, framework and identifying configuration cannot
change. Display names and additional paid plans remain editable as before.

Joomla configuration: `extensionType` (plugin/component/module/template/package/library),
`element`, `folder?`, `client` (site/administrator; required for module, template,
library and package; optional for plugin/component), `joomlaMajor` (integer).
Plugins require a folder. Modules, templates, libraries and packages require an
explicit client to preserve native update identity. JetBrains: `pluginId`, `sinceBuild`, `untilBuild?`.
WordPress, Electron, Tauri and Sparkle use empty framework configuration initially.
Generic products optionally configure `activationKind: "site" | "device"`, default device.
All configurations reject unknown fields and are bounded.

WordPress and Joomla use site activations and existing URL normalization/exemptions.
Other frameworks use device activations, except an explicitly site-based generic
product. A device activation submits `installationId` and `installationLabel?`,
without a fake site URL. Store an opaque `device:INSTALLATION_ID` identity and a
bounded optional label. No hardware fingerprint, machine inventory or remote
feature gate. A stable randomly generated ID persists across app updates.
Seats retain the existing `site_allowance` storage/API name for shared billing;
the UI labels them sites, devices or installations as appropriate.

## Releases and immutable assets

Keep the existing single-asset WordPress publication path and its strict ZIP
checks. Add `release_assets`, with generated `id`, `tenant_id`, `release_id`,
`target`, `filename`, `size`, `checksum` (SHA-256), `sha512` (base64), nullable
`signature`, and nullable `min_system_version`. Unique `(tenant_id,release_id,target)`
and composite tenant/release foreign keys prevent replacement and cross-tenant
attachments. Migration007 also adds nullable `installations.label`.

Publish non-WordPress assets one at a time through
`POST /seller/assets/:product/:version` with `application/octet-stream` bytes and
base64url JSON `X-Release-Metadata` containing
`{target,filename,changelog,signature?,minSystemVersion?}`.
Metadata is bounded to fit HTTP headers. A version can acquire additional targets;
already published target bytes and version notes cannot change. Each target is
offered only after its bytes have been fully verified and its row committed.
Clients requesting an absent target receive no update, never an incomplete package.

The first asset creates the parent release; later target publications reuse it.
For non-WordPress parents, `releases.size` is the sum of asset sizes so existing
quota and storage metrics remain correct. Parent checksum denotes the first
asset only; every actual download uses its own asset checksum. The old WordPress
package route must reject non-WordPress releases. Parent withdrawal hides all
targets and preserves every object and quota charge.

Global upload limits remain 25 MiB by default and hard 100 MiB, with the existing
six-times upload and twice-size download memory admission. Larger desktop bundles
are rejected; do not claim unbounded streaming support. Asset downloads support
authenticated HEAD and single byte ranges for native updater compatibility.
Differential/blockmap generation and multipart ranges are deferred. Quotas, reservations and orphan cleanup include every asset. S3 object IDs remain opaque;
the private `.zip` key suffix is an internal storage convention, not a format claim.

Joomla ZIPs require bounded safe paths and a matching XML manifest identity and
version. JetBrains ZIP/JAR packages require a matching plugin.xml ID/version.
Use the maintained `fast-xml-parser` 5.11.2, verified from npm on 2026-10-21;
reject DTD/entities before parsing and bound XML bytes. Preserve WordPress ZIP
validation independently. Desktop assets have per-framework filename/target
allowlists and basic archive/executable validation. Tauri and Sparkle require
well-formed detached signature metadata; native updaters verify signatures using
public keys embedded by the seller. HTTP SHA-256 is not a replacement for signing.

## Feeds and authenticated downloads

All routes are under `/api/v1/tenants/:tenant`. Discovery feeds and every package
require a valid activation token, current entitlement and matching product/framework.
Joomla alone has a public immutable version-details document because its native
metadata reload has no authentication hook. It exposes no buyer data or credentials;
package bytes remain protected and withdrawn/future details are unavailable.
No credential-bearing URLs, S3 redirects or administrative secrets.
Joomla's installer plugin uses `onInstallerBeforeUpdateSiteDownload` and
`onInstallerBeforePackageDownload` to add scoped headers for this product only.

- Joomla: `/updates/joomla/:product.xml`, authenticated native collection XML
  linking `/updates/joomla/:product/releases/:releaseId.xml` public version details.
- Electron: `/updates/electron/:product/:target/latest.yml`, also accepted native
  filenames `latest-mac.yml` and `latest-linux.yml` for their matching target.
- Tauri: `/updates/tauri/:product/:target/:currentVersion`, dynamic JSON or 204.
- Sparkle: `/updates/sparkle/:product/:target/appcast.xml`, native signed enclosure.
- JetBrains: `/updates/jetbrains/:product/updatePlugins.xml`, native repository XML.
- Generic: `/updates/generic/:product/:target`, JSON metadata, optional currentVersion.
- Asset: `/packages/:product/assets/:assetId/:filename`, GET/HEAD and one byte range.
- Buyer download: `/licenses/:id/assets/:assetId/download`, buyer session and ownership.

Target values use upstream conventions. Joomla/JetBrains use `any`;
Electron uses windows/darwin/linux with x64/arm64; Tauri uses its documented
OS-architecture identifiers; Sparkle uses darwin-x64/darwin-arm64/darwin-universal;
generic targets are bounded safe identifiers. Feed output escapes XML/YAML and
contains immutable authenticated application URLs. Cache-Control remains no-store.
Metadata expiry cannot break an otherwise entitled delayed download. Wrong
framework, target, product, tenant or customer fails closed.

## Shared implementation contracts

`src/frameworks.ts` exports framework values/types and product config validation.
`src/artifacts.ts` exports `Artifacts(db,store,tenant,maxBytes?,graceMs?)` with
`publish({product,version,file,target,filename,changelog,signature?,minSystemVersion?})`
returning `{release,asset}`, `latest(productId,target?)` returning
`{release,assets}` or undefined, and `read(asset)` returning verified bounded bytes.
`ReleaseAsset` is exported from db.ts. Existing `Releases.cleanup` protects stored
asset IDs when cleaning expired reservations. Existing release withdrawal applies
to the shared parent row.

`src/update-adapters.ts` is a pure feed renderer. Root will pass an object
`{framework,product:{slug,name,frameworkConfig},release:{version,changelog,published_at},assets}`,
where assets contain their DB metadata plus a fully constructed `url`.
Export `renderUpdate(input): {contentType:string; body:string|Record<string,unknown>}`.
Root handles tenant/auth/current-version selection and storage, not the renderer.

## App and CLI

Product setup chooses a framework and shows only relevant identity fields.
Release upload chooses product/target, filename and required signatures; WordPress
retains its compatibility fields and publication endpoint. Setup snippets and
customer downloads reflect the selected product and target. Customer installations
show labels/site URLs, with correct allowance units. The public site lists actual
adapters and clearly separates implemented feeds from runtime qualification.
The CLI gains `publish-asset PRODUCT VERSION FILE METADATA_JSON`; product JSON
accepts framework configuration through the same validated API.

## Verification

Write failing behavior tests before implementation. Exercise each native feed,
identity/package mismatch, unsafe archive, signature requirement, paid/expired/
revoked/suspended access, cached delayed download, target selection, range/HEAD,
concurrent quota/activation, immutable assets, withdrawal, cross-tenant and
cross-customer denial. Test migration007 and core new behavior on actual SQLite,
PostgreSQL and MySQL. Keep 100% lines/branches/functions per executable src/web TS
module. Test templates without production credentials and run native integrations
where available, recording exact gaps. Obtain independent Opus5.5 review and fix
verified findings. All temporary outputs and raw evidence stay on Scratch.

Linux ARM64 clients request `latest-linux-arm64.yml`; `latest-linux.yml` is reserved for Linux x64.


Native Joomla qualification found that its details reload omits the authentication hook. The authenticated discovery feed therefore links a public, immutable version details document at `/updates/joomla/:product/releases/:releaseId.xml`. It includes no buyer information or credentials. Packages retain activation authentication and entitlement checks, and withdrawn/future releases return no details. This narrowly scoped metadata exception preserves native installer compatibility.
