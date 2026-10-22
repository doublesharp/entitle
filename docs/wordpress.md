# WordPress example

`examples/wordpress/double-entitle-example/` is an installable plugin, version 1.0.0. It requires WordPress 6.0 and PHP 7.4. Copy that directory into `wp-content/plugins/` and activate it. This is a single-site example; a multisite product needs an explicit network license and option ownership policy.

Configure the service before entering a license key in **Settings > Double Entitle license**:

```php
// wp-config.php, before WordPress loads.
define('DOUBLE_ENTITLE_API_URL', 'https://entitle.doublesharp.com/api/v1/tenants/your-publisher');
define('DOUBLE_ENTITLE_PRODUCT', 'double-entitle-example');
```

The corresponding option names are `double_entitle_api_url` and `double_entitle_product`. Constants take precedence. The API product may instead be `validated-field-pro`; configure seller product setup with `"pluginBasename": "double-entitle-example/double-entitle-example.php"` so its releases install into the example's directory. With no explicit basename, publication expects `<product-slug>/<product-slug>.php`. Setup retries preserve the configured basename when `pluginBasename` is omitted. A successful publication saves the effective basename, including the implicit default, and that identity stays immutable while any release exists, including withdrawn releases. Products upgraded from migration001 have no bound identity yet; an operator may explicitly bind their actual basename once, even when legacy releases already exist. Set this before publishing a new release when the legacy install path differs from the product slug. Every ZIP entry must be inside that directory. Exactly one root PHP file must have a nonempty WordPress Plugin Name header, at the configured basename, with Version equal to the published version. Headers are read from the initial 8 KiB using WordPress get_file_data matching and cleanup, including optional PHP opening tags. WordPress also recognizes header-shaped lines inside strings and templates; those lines therefore participate in the version and duplicate-plugin checks. Replace the plugin directory, basename and headers when adapting this client to the real product.

The license form checks administrator capability and a WordPress nonce. Keys go in a JSON POST body and are never stored. The installation token is stored in a non-autoloaded option. Treat database copies and backups as credentials. The client creates its installation UUID once with atomic `add_option`; license deactivation and plugin deactivation preserve it. A failed deactivation retains the token for retry. No plugin activation/deactivation hook silently consumes or releases a license seat.

For an intentionally independent clone, explicitly deactivate its copied license state and generate a new installation UUID before activation. Do not reset IDs on routine plugin updates or URL changes. Keep the API URL and product stable for an activated installation; deactivate against the original service before changing either setting.

## Update behavior

The updater registers on every plugin load, before any product feature or compatibility gate. There are no remote feature gates. The example shortcode `[double_entitle_example]` keeps working without a license, after expiry or deactivation, and during service outages.

This small example uses native WordPress hooks instead of bundling an update-checker dependency. Its responsibilities are limited to one product, JSON metadata and authenticated packages. [`pre_set_site_transient_update_plugins`](https://developer.wordpress.org/reference/hooks/pre_set_site_transient_transient/) adds offers to WordPress's normal cache; `plugins_api` supplies the details modal. [`http_request_args`](https://developer.wordpress.org/reference/hooks/http_request_args/) attaches Bearer only during this client’s own synchronous verified download, for its exact package URL at the configured origin and API prefix. It never authenticates unrelated global HTTP requests. URLs with credentials, query strings, fragments, encoded path components or extra path segments do not receive the token. All authenticated HTTP requests disable redirects. WordPress admin, WP-CLI and cron use these same hooks.

Package URLs contain no credentials and have no client expiration. The server rechecks entitlement at download time, so a cached offer does not bypass expiry, token rotation or withdrawal. Metadata is cached for one hour and retained for at most one day. Temporary request failures can reuse that validated cache; explicit 401/403 removes the offer. Installed features and activation state remain intact. Metadata and transport errors displayed to administrators are fixed local messages, without raw service responses.

Explicit foreign-plugin hook attribution preserves the preceding handler result. Own-plugin packages fail closed after an endpoint/configuration change and reject files returned by an earlier handler without this client’s verification. Unattributed other-product packages remain untouched.

The `upgrader_pre_download` hook downloads with WordPress's `download_url`, checks SHA-256, removes a failed temporary file, and returns the verified file to the normal upgrader. Minimum WP/PHP versions remain in update offers. The client separately checks `min_free` and blocks installation with an actionable message while keeping the offer visible. Set `DOUBLE_ENTITLE_FREE_VERSION` to the actual installed Free plugin version before the client loads, or provide `double_entitle_free_version`; the default is `0.0.0`. Publish minimum Free `0.0.0` if the example has no Free dependency. A real product should read the installed Free plugin's version rather than asking users to maintain this option.

Future releases can require a newer PHP/WP/Free version than the installed release. Those requirements do not stop this updater from registering or hide the newer release. The bootstrap itself must remain parseable on its declared supported PHP version. Keep this distinction when adapting the example.

## Local verification

The isolated test uses small WordPress API doubles for boundary checks. It does not claim to replace a running WordPress installation:

```sh
php examples/wordpress/tests/client-test.php
php -l examples/wordpress/double-entitle-example/class-double-entitle-client.php
php -l examples/wordpress/double-entitle-example/double-entitle-example.php
php -l scripts/wordpress-integration.php
```

Generate disposable real plugin releases under Scratch. Each ZIP contains the actual client and a matching plugin version header:

```sh
python3 scripts/wordpress-build-fixture.py --version 1.1.0 --output /Volumes/Scratch/double-entitle-wp/tmp/wordpress/1.1.0.zip
python3 scripts/wordpress-build-fixture.py --version 1.2.0 --output /Volumes/Scratch/double-entitle-wp/tmp/wordpress/1.2.0.zip
```

Use the application's normal release publisher to publish 1.1.0 first, with product `double-entitle-example`, minimum WP `6.0`, minimum PHP `7.4` and minimum Free `0.0.0`. Provision a local fixture license with purchased time. No Stripe payment or production secret is needed. The ZIP helper refuses outputs outside the project's Scratch directory and refuses to overwrite an existing ZIP.

Mount WordPress's writable files, temporary directory and evidence directory from Scratch. For local plain HTTP only, set `DOUBLE_ENTITLE_ALLOW_HTTP=true`. A private Docker service hostname or custom port also needs a local-only WordPress MU configuration permitting exactly that hostname with `http_request_host_is_external` and its port with `http_allowed_safe_ports`. Keep that override out of production. Set `WP_TEMP_DIR` to the Scratch-backed container temporary directory; the PHP client leaves temporary-file location to WordPress.

Run the following through the local WordPress container's WP-CLI. `/workspace` below means the repository mounted read-only in that container; use its actual mount path. Provide the disposable license key through the container environment as `DOUBLE_ENTITLE_TEST_KEY`, without echoing it or putting it on a command line. All modes require `DOUBLE_ENTITLE_INTEGRATION=1` and an administrator user:

```sh
wp --user=admin eval-file /workspace/scripts/wordpress-integration.php check
wp --user=admin eval-file /workspace/scripts/wordpress-integration.php manual
# Publish 1.2.0 using the normal release CLI before this next command.
wp --user=admin eval-file /workspace/scripts/wordpress-integration.php automatic
wp --user=admin eval-file /workspace/scripts/wordpress-integration.php deactivate
```

`check` activates twice to check idempotency when a key is supplied, verifies the UUID, calls real `wp_update_plugins` and `plugins_api`, renders the actual admin plugin update row and license form, and downloads the authenticated package with real WordPress HTTP. The package's SHA-256 must match. `manual` uses [`Plugin_Upgrader::upgrade`](https://developer.wordpress.org/reference/classes/plugin_upgrader/upgrade/) and confirms installed file headers changed to the offered version. `automatic` temporarily opts this plugin into automatic updates, calls [`WP_Automatic_Updater::update`](https://developer.wordpress.org/reference/classes/wp_automatic_updater/update/), and checks the installed version. It retains WordPress's filesystem, compatibility and automatic-update policy checks, so an unsuitable local installation fails instead of silently bypassing them. `deactivate` checks that the UUID and installed shortcode survive license deactivation.

These checks render real admin components in PHP. They do not prove browser login, CSS layout or an elapsed cron schedule; inspect the local admin screen separately and record those results separately. A normal `wp plugin update double-entitle-example` is another useful CLI entrypoint after publishing a later release. Save logs/screenshots only under `/Volumes/Scratch/double-entitle-wp/reports/`. Do not store keys or tokens in committed evidence.

The checked local Docker fixture uses WordPress on `http://localhost:8088`, the licensing service on `http://localhost:3211`, and the disposable administrator `admin`. `scripts/wordpress-cli.sh` runs the CLI image with the WordPress container's network namespace, task-owned mounts and database settings. `scripts/wordpress-local-config.php` and `scripts/wordpress-local-mu.php` are fixture-only files; the Compose WordPress and WP-CLI services share the same `WORDPRESS_CONFIG_EXTRA` block, and the MU plugin directory contains the latter. The PHP local-config file documents the equivalent constants. Never include either file in a distributed plugin ZIP.

Two task-owned, digest-pinned `alpine/socat` containers share WordPress's network namespace. `double-entitle-saas-test-wordpress-relay-1` forwards `127.0.0.1:3211` to `host.docker.internal:3211`, preserving the canonical package origin. `double-entitle-saas-test-wordpress-loopback-1` forwards `127.0.0.1:8088` to Apache on `127.0.0.1:80`, allowing the automatic updater's real fatal-error loopback check. Neither container changes production architecture.

For this fixture, `node scripts/wordpress-run.mjs check --activate` obtains the latest `demo@example.test` license key from local Mailpit directly into the subprocess environment, never a command argument or log. Run it only after key rotation has finished. Later modes omit `--activate`. Its logs go to `/Volumes/Scratch/double-entitle-wp/reports/wordpress/`. `node --env-file=SCRATCH_ENV scripts/wordpress-publish.mjs VERSION SCRATCH_ZIP` publishes a generated ZIP with `TENANT_SLUG` and `TENANT_API_KEY`, without printing the key. `SCRATCH_ENV` is the disposable environment file under Scratch, not the user's `.env`.

## Verified SaaS result

The 2026-10-21 run used WordPress 7.1.3, PHP 8.3.35, Node 26.12.0 and real private MinIO storage. Its canonical API is `http://localhost:3211/api/v1/tenants/primary`; the WordPress site is `http://localhost:8088`. The application database, WordPress files, PHP temporary files, ZIPs, private environment and evidence all live under `/Volumes/Scratch/double-entitle-wp/`. Other projects' containers were left untouched.

The seller was verified through actual Mailpit email and same-browser preauth consumption, then assigned primary ownership through the authenticated platform operator API. The isolated application bootstrap inserted one expiring tenant API key directly into its disposable database. Product setup, local fixture purchase and all three release publications used the tenant seller API or CLI. Local billing creates fixture grants; this run involved no Stripe payment.

The running PHP client passed its security/cache regression checks. Real activation retries preserved the token and installation UUID. Real `wp_update_plugins`, `plugins_api`, license-form/update-row rendering and WordPress HTTP SHA-256 package downloads passed. Native `wp plugin update double-entitle-example` installed 1.0.0 to 1.1.0. `WP_Automatic_Updater` then installed 1.1.0 to 1.2.0 under `DOING_CRON=true`, preserving the active plugin. This calls the real automatic updater in cron context; it does not claim an elapsed scheduled cron invocation.

The automatic test also downloaded the previous release's unchanged stable package URL after publishing the newer release. Application package access returned 401 without credentials and 200 with the activation token; unsigned direct MinIO object access returned 403. The downloaded 1.3.0 bytes matched the original ZIP and the published SHA-256. Client metadata contained an application tenant URL without credentials, query parameters or S3 URLs.

Stopping only the task WordPress licensing relay caused a real HTTP outage. Cached metadata, the exact activation token, installation UUID and installed shortcode remained intact. The relay was restored immediately in a `finally` block and the app readiness probe returned 200 afterward.

The first CLI activation attempt exposed a fixture mismatch: Apache received `WORDPRESS_CONFIG_EXTRA` but WP-CLI did not. Sharing that exact configuration block fixed the mismatch; no SDK workaround was needed.

The root reviewer then used the T3 browser on the real WordPress Plugins screen, confirmed active 1.2.0 with the 1.3.0 offer, and clicked the normal "Update Double Entitle example now" link. The page showed version 1.3.0, "Updated!" and an active plugin. The application, WordPress and relays remain running for the remaining seller/buyer browser review. License deactivation is deliberately left until those checks finish. This run does not qualify multisite, other WP/PHP versions, live Stripe commerce or a scheduled cron interval.

The private fixture environment is `/Volumes/Scratch/double-entitle-wp/data/saas-20261021/wordpress-app.env`, mode 0600. It holds the disposable WordPress administrator password and API/seller credentials; do not print or commit it. Load it with Node's `--env-file` for the fixture commands. The S3 environment is the separate `/Volumes/Scratch/double-entitle-wp/data/local-s3/integration.env` file. Reports are under `/Volumes/Scratch/double-entitle-wp/reports/wordpress-saas-20261021/`, with the complete handoff at `/Volumes/Scratch/double-entitle-wp/reports/saas-wordpress-report.md`.

The separate `examples/wordpress/tests/wordpress-hook-test.php` fixture expects an isolated HTTP server on host.docker.internal:3213. It is not part of this running matrix; the real installation and automatic-update paths above exercised the actual client download hook against the tenant API and private object store.
