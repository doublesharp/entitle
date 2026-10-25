# WordPress example

`examples/wordpress/entitle-example/` is an installable plugin, version 1.0.0. It requires WordPress 6.0 and PHP 7.4. Copy that directory into `wp-content/plugins/` and activate it. This is a single-site example; a multisite product needs an explicit network license and option ownership policy.

Configure the service before entering a license key in **Settings > Doublesharp Entitle license**:

```php
// wp-config.php, before WordPress loads.
define('ENTITLE_API_URL', 'https://entitle.doublesharp.com/api/v1/tenants/your-publisher');
define('ENTITLE_PRODUCT', 'entitle-example');
```

The corresponding option names are `entitle_api_url` and `entitle_product`. Constants take precedence. The API product may instead be `validated-field-pro`; configure seller product setup with `"pluginBasename": "entitle-example/entitle-example.php"` so its releases install into the example's directory. With no explicit basename, publication expects `<product-slug>/<product-slug>.php`. Setup retries preserve the configured basename when `pluginBasename` is omitted. A successful publication saves the effective basename, including the implicit default, and that identity stays immutable while any release exists, including withdrawn releases. Every ZIP entry must be inside that directory. Exactly one root PHP file must have a nonempty WordPress Plugin Name header, at the configured basename, with Version equal to the published version. Headers are read from the initial 8 KiB using WordPress get_file_data matching and cleanup, including optional PHP opening tags. WordPress also recognizes header-shaped lines inside strings and templates; those lines therefore participate in the version and duplicate-plugin checks. Replace the plugin directory, basename and headers when adapting this client to the real product.

The license form checks administrator capability and a WordPress nonce. Keys go in a JSON POST body and are never stored. The installation token and a SHA-256 key fingerprint are stored in non-autoloaded options. The fingerprint permits same-key activation retries without storing the raw key. Treat database copies and backups as credentials.

Deactivate the current license before entering a different key so its seat is released. Existing activations without a fingerprint also require deactivation before entering a key. The client creates its installation UUID once with atomic `add_option`; license deactivation and plugin deactivation preserve it. No plugin activation/deactivation hook silently consumes or releases a license seat.

Transport failures and unconfirmed deactivation retain the token for retry. An exact `401 invalid_activation` response confirms that the token is already invalid, allowing an explicit deactivation retry to clear local credentials and cached offers.

For an intentionally independent clone, explicitly deactivate its copied license state and generate a new installation UUID before activation. Do not reset IDs on routine plugin updates or URL changes. Keep the API URL and product stable for an activated installation; deactivate against the original service before changing either setting.

## Update behavior

The updater registers on every plugin load, before any product feature or compatibility gate. There are no remote feature gates. The example shortcode `[entitle_example]` keeps working without a license, after expiry or deactivation, and during service outages.

This small example uses native WordPress hooks instead of bundling an update-checker dependency. Its responsibilities are limited to one product, JSON metadata and authenticated packages. [`pre_set_site_transient_update_plugins`](https://developer.wordpress.org/reference/hooks/pre_set_site_transient_transient/) adds offers to WordPress's normal cache; `plugins_api` supplies the details modal. [`http_request_args`](https://developer.wordpress.org/reference/hooks/http_request_args/) attaches Bearer only during this client’s own synchronous verified download, for its exact package URL at the configured origin and API prefix. It never authenticates unrelated global HTTP requests. URLs with credentials, query strings, fragments, encoded path components or extra path segments do not receive the token. All authenticated HTTP requests disable redirects. WordPress admin, WP-CLI and cron use these same hooks.

Package URLs contain no credentials and have no client expiration. The server rechecks entitlement at download time, so a cached offer does not bypass expiry, token rotation or withdrawal. Metadata is cached for one hour and retained for at most one day. Temporary request failures can reuse that validated cache; explicit 401/403 removes the offer. Installed features and activation state remain intact. Metadata and transport errors displayed to administrators are fixed local messages, without raw service responses.

Explicit foreign-plugin hook attribution preserves the preceding handler result. Own-plugin packages fail closed after an endpoint/configuration change and reject files returned by an earlier handler without this client’s verification. Unattributed other-product packages remain untouched.

The `upgrader_pre_download` hook downloads with WordPress's `download_url`, checks SHA-256, removes a failed temporary file, and returns the verified file to the normal upgrader. Minimum WP/PHP versions remain in update offers. The client separately checks `min_free` and blocks installation with an actionable message while keeping the offer visible. Set `ENTITLE_FREE_VERSION` to the actual installed Free plugin version before the client loads, or provide `entitle_free_version`; the default is `0.0.0`. Publish minimum Free `0.0.0` if the example has no Free dependency. A real product should read the installed Free plugin's version rather than asking users to maintain this option.

Future releases can require a newer PHP/WP/Free version than the installed release. Those requirements do not stop this updater from registering or hide the newer release. The bootstrap itself must remain parseable on its declared supported PHP version. Keep this distinction when adapting the example.

## Local verification

The isolated test uses small WordPress API doubles for boundary checks. It does not claim to replace a running WordPress installation:

```sh
php examples/wordpress/tests/client-test.php
php -l examples/wordpress/entitle-example/class-entitle-client.php
php -l examples/wordpress/entitle-example/entitle-example.php
php -l scripts/wordpress-integration.php
```

Generate disposable real plugin releases under Scratch. Each ZIP contains the actual client and a matching plugin version header:

```sh
python3 scripts/wordpress-build-fixture.py --version 1.1.0 --output /Volumes/Scratch/entitle/tmp/wordpress/1.1.0.zip
python3 scripts/wordpress-build-fixture.py --version 1.2.0 --output /Volumes/Scratch/entitle/tmp/wordpress/1.2.0.zip
```

Use the application's normal release publisher to publish 1.1.0 first, with product `entitle-example`, minimum WP `6.0`, minimum PHP `7.4` and minimum Free `0.0.0`. Provision a local fixture license with purchased time. No Stripe payment or production secret is needed. The ZIP helper refuses outputs outside the project's Scratch directory and refuses to overwrite an existing ZIP.

Mount WordPress's writable files, temporary directory and evidence directory from Scratch. For local plain HTTP only, set `ENTITLE_ALLOW_HTTP=true`. A private Docker service hostname or custom port also needs a local-only WordPress MU configuration permitting exactly that hostname with `http_request_host_is_external` and its port with `http_allowed_safe_ports`. Keep that override out of production. Set `WP_TEMP_DIR` to the Scratch-backed container temporary directory; the PHP client leaves temporary-file location to WordPress.

Run the following through the local WordPress container's WP-CLI. `/workspace` below means the repository mounted read-only in that container; use its actual mount path. Provide the disposable license key through the container environment as `ENTITLE_TEST_KEY`, without echoing it or putting it on a command line. All modes require `ENTITLE_INTEGRATION=1` and an administrator user:

```sh
wp --user=admin eval-file /workspace/scripts/wordpress-integration.php check
wp --user=admin eval-file /workspace/scripts/wordpress-integration.php manual
# Publish 1.2.0 using the normal release CLI before this next command.
wp --user=admin eval-file /workspace/scripts/wordpress-integration.php automatic
wp --user=admin eval-file /workspace/scripts/wordpress-integration.php deactivate
```

`check` activates twice to check idempotency when a key is supplied, verifies the UUID, calls real `wp_update_plugins` and `plugins_api`, renders the actual admin plugin update row and license form, and downloads the authenticated package with real WordPress HTTP. The package's SHA-256 must match. `manual` uses [`Plugin_Upgrader::upgrade`](https://developer.wordpress.org/reference/classes/plugin_upgrader/upgrade/) and confirms installed file headers changed to the offered version. `automatic` temporarily opts this plugin into automatic updates, calls [`WP_Automatic_Updater::update`](https://developer.wordpress.org/reference/classes/wp_automatic_updater/update/), and checks the installed version. It retains WordPress's filesystem, compatibility and automatic-update policy checks, so an unsuitable local installation fails instead of silently bypassing them. `deactivate` checks that the UUID and installed shortcode survive license deactivation.

These checks render real admin components in PHP. They do not prove browser login, CSS layout or an elapsed cron schedule; inspect the local admin screen separately and record those results separately. A normal `wp plugin update entitle-example` is another useful CLI entrypoint after publishing a later release. Save logs/screenshots only under `/Volumes/Scratch/entitle/reports/`. Do not store keys or tokens in committed evidence.

The checked local Docker fixture uses WordPress on `http://localhost:8088`, the licensing service on `http://localhost:3211`, and the disposable administrator `admin`. `scripts/wordpress-cli.sh` runs the CLI image with the WordPress container's network namespace, task-owned mounts and database settings. `scripts/wordpress-local-config.php` and `scripts/wordpress-local-mu.php` are fixture-only files; the Compose WordPress and WP-CLI services share the same `WORDPRESS_CONFIG_EXTRA` block, and the MU plugin directory contains the latter. The PHP local-config file documents the equivalent constants. Never include either file in a distributed plugin ZIP.

Two task-owned, digest-pinned `alpine/socat` containers share WordPress's network namespace. `entitle-saas-test-wordpress-relay-1` forwards `127.0.0.1:3211` to `host.docker.internal:3211`, preserving the canonical package origin. `entitle-saas-test-wordpress-loopback-1` forwards `127.0.0.1:8088` to Apache on `127.0.0.1:80`, allowing the automatic updater's real fatal-error loopback check. Neither container changes production architecture.

For this fixture, `node scripts/wordpress-run.mjs check --activate` obtains the latest `demo@example.test` license key from local Mailpit directly into the subprocess environment, never a command argument or log. Run it only after key rotation has finished. Later modes omit `--activate`. Its logs go to `/Volumes/Scratch/entitle/reports/wordpress/`. `node --env-file=SCRATCH_ENV scripts/wordpress-publish.mjs VERSION SCRATCH_ZIP` publishes a generated ZIP with `TENANT_SLUG` and `TENANT_API_KEY`, without printing the key. `SCRATCH_ENV` is the disposable environment file under Scratch, not the user's `.env`.
