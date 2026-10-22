# Joomla 5.4 and 6

Package this directory as an installer plugin, install and enable it. Its
configuration stores the tenant API URL and product slug. The plugin must be
installed before using the authenticated update site. Keep it installed when the
licensed extension updates. Its version is independent of the product version.

Add this to the licensed extension's manifest, with your publisher/product:

```xml
<updateservers><server type="collection" priority="1" name="Product updates">https://licenses.example.com/api/v1/tenants/publisher/updates/joomla/my-extension.xml</server></updateservers>
```

From your existing administrator settings controller, require Joomla's CSRF token
and `core.manage` permission, serialize license changes, then obtain the enabled
plugin with `$app->bootPlugin('doubleentitle', 'installer')`. Call
`$plugin->activate($keyFromForm)`, `$plugin->status()` or `$plugin->deactivate()`.
Catch RuntimeException and display its fixed message. Never echo raw HTTP errors,
log headers or retain the key. Clear the form key after the request.

The UUID and token persist in this installer plugin row's `custom_data` JSON
under the reserved `double_entitle` object, as `installation_id` and
`activation_token`. Form-managed `params` contains only API/product settings, so
saving the plugin configuration cannot erase the activation. Unknown custom data
keys are preserved; non-object or malformed existing custom data is left
untouched and produces an error. Legacy prototype state in params is migrated
on first use before a later form save. Protect database backups and restrict
plugin settings to administrators, since activation tokens are stored in the
database. Do not run activation from public/front-end hooks.

The authenticated collection feed points at immutable, credential-free version
details XML. That version details route carries update metadata only; package
downloads still require the activation token. Joomla natively reloads those
details without the discovery request headers.

Both native installer events use `getHeaders()` / `updateHeaders()` to attach
Bearer headers only for the exact configured product feed and asset path.
No token appears in the manifest URL. A failed check or expired subscription
leaves installed extension functionality available. Feed failures should appear
in Joomla's normal update UI; the protected settings screen handles activation
and reconnection errors.

Publish `any` target ZIPs whose manifest element/type/folder/version match the
configured product. Modules, templates, libraries and packages require an explicit
`client`; plugins
default to `site` when omitted. Joomla verifies the feed's SHA-256 package checksum.

Official sources: [Joomla update servers](https://manual.joomla.org/docs/4.4/building-extensions/install-update/update-server/),
[5.4 feed event](https://github.com/joomla/joomla-cms/blob/5.4-dev/libraries/src/Event/Installer/BeforeUpdateSiteDownloadEvent.php)
and [package event](https://github.com/joomla/joomla-cms/blob/5.4-dev/libraries/src/Event/Installer/BeforePackageDownloadEvent.php).
Qualification: a local Joomla 6.1.3/PHP 8.5.11 library fixture passed native
plugin boot, HTTPS activation/status, authenticated collection discovery,
installer package checksum verification and installation of version 2.0.0.
A new PHP process after replacing form params retained the UUID and token;
unrelated custom data survived, params held no secrets, and deactivation cleared
update access while preserving the UUID and installed functionality.
Joomla 5.4 and other extension types remain unqualified. The PHP stand-in tests
also cover scoped headers, prototype-state migration, malformed custom data and
settings persistence. See the task's `framework-joomla-integration-report.md`
under the Scratch reports directory for the native runtime receipt.
