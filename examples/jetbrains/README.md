# JetBrains IDE plugins

Copy `LicenseUpdates.kt` and `UpdateScope.java`, update its package/API/product, and merge the extension
registration into your plugin.xml. Compile against your supported IDE SDK and
its bundled Gson. Provide your normal plugin id/version/idea-version in the
actual manifest, matching the product's pluginId, sinceBuild and optional
untilBuild. Publish a native plugin ZIP or JAR as target `any`.

Ship this bootstrap authentication code in the initially installed plugin, then
add the credential-free `LicenseUpdates.repositoryUrl` in Settings > Plugins >
Manage Plugin Repositories. The first installation must come from the buyer's
authenticated download or a separately distributed bootstrap; an unauthenticated
IDE cannot discover this private feed before its auth provider is installed.

Connect settings Activate/Deactivate buttons to the application service's
`activate(key, label)` and `deactivate()`. Run those blocking network/PasswordSafe
calls in the IDE background task framework, never the event-dispatch thread.
Display only fixed errors on the UI thread, then clear the key input. `status()`
can populate update-account settings. Native Check for Updates and plugin update
UI handle repository lookup, download and installation. The auth provider adds
Bearer headers only to this product's exact feed and asset paths, including
package requests. Native `build`, `os` and `arch` query parameters are accepted
only on the exact feed path; package URLs reject all query parameters. It then notifies the IDE to invalidate auth caches after changes.

The random UUID persists in PropertiesComponent; the token uses PasswordSafe.
Deactivation preserves the UUID. Keys are never retained. Do not configure
credential-bearing repository URLs, external redirects or headers for a whole
host. Service failures and expiration affect updates only, never installed
plugin functionality. Sign your plugin in the seller build system and configure
certificate trust for a custom repository as required by your IDE customers.

Official interfaces: [Custom plugin repository](https://plugins.jetbrains.com/docs/intellij/custom-plugin-repository.html),
[auth provider source](https://github.com/JetBrains/intellij-community/blob/master/platform/platform-impl/src/com/intellij/ide/plugins/auth/PluginRepositoryAuthProvider.java).
Although the SDK documentation recommends this extension point, upstream marks
its provider/listener API Internal. Pin the IDE SDK and run Plugin Verifier for
every supported IDE version. It is available from platform 221 onward.
Qualification: the service repository XML is unit tested. This template has
source contract checks and an executable Java scope test against the installed
JDK. A full IDE SDK build, PasswordSafe backend, registered
extension and actual plugin installation/update remain unqualified.
