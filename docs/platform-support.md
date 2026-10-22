# Platforms and client adapters

Doublesharp Entitle uses shared checkout, billing, customer accounts, licenses,
activation tokens and private storage across software frameworks. The product's
`framework` selects package validation, native feed output, setup snippets and
site/device activation policy. Runtime APIs remain tenant-scoped.

## Product types

| Framework | Activation                           | Native update format                     | Example                                                     |
| --------- | ------------------------------------ | ---------------------------------------- | ----------------------------------------------------------- |
| WordPress | Site                                 | WordPress update metadata and plugin ZIP | [PHP plugin](../examples/wordpress/double-entitle-example/) |
| Joomla    | Site                                 | Extension update XML and ZIP             | [Installer plugin](../examples/joomla/)                     |
| Electron  | Device                               | Generic provider `latest*.yml`           | [JavaScript updater](../examples/electron/)                 |
| Tauri     | Device                               | Dynamic JSON with detached signature     | [Rust updater](../examples/tauri/)                          |
| Sparkle   | Device                               | Appcast with EdDSA enclosure signature   | [Swift integration](../examples/sparkle/)                   |
| JetBrains | Device                               | Custom repository `updatePlugins.xml`    | [Kotlin/Java integration](../examples/jetbrains/)           |
| Generic   | Device by default; configurable site | JSON with target/checksum metadata       | [HTTP JavaScript client](../examples/generic/)              |

Each example includes configuration and integration instructions. The examples
are starting points for a software vendor's protected settings and updater flow,
not complete applications. Existing installed functionality never depends on a
successful licensing-server response.

Joomla requires the installer plugin for authentication on collection discovery and
package requests. Its native installer separately reloads a public immutable
version-details document, containing no buyer information or credentials. JetBrains uses a repository authentication provider and allows
the bounded build/os/arch parameters that the IDE adds. Electron examples target
stable electron-builder26 interfaces and disable differential download. Tauri and
Sparkle require detached signature metadata and seller-embedded public keys.
Seller signing keys stay in the build system, outside Doublesharp Entitle.

## Products and releases

Create products through the seller UI, product API or CLI JSON. A product's
framework identity locks after its first license or release, protecting existing
buyers and installed clients. WordPress has `pluginBasename`; Joomla has extension
identity/major-version settings; JetBrains has plugin ID and IDE build bounds.
Generic products can choose site or device activation. Plans retain the shared
`siteAllowance` API field, displayed as sites, devices or installations.

WordPress retains its dedicated ZIP publication. Other frameworks publish raw
assets to the asset endpoint, with a safe filename and target. Additional targets
may join a version, but existing bytes and release notes cannot change. Each asset
is offered only after validation, private storage verification and database
commit. Clients requesting a missing target receive no update. Withdrawal applies
to every target and retains the private objects and quota charge.

WordPress ZIPs default to 25 MiB with a 100 MiB hard ceiling. Native assets
have a separate 100 MiB default and 2 GiB hard ceiling. They spool to private
files with bounded disk reservations and progress/total receive deadlines.
Publication and verified-download caches have separate budgets; see
[configuration](configuration.md#upload-disk-and-transfer-budgets).

ZIP/TAR checks bound paths, entry counts, expansion and processing time. Native
expansion is capped at the greater of 250 MiB or package size. Desktop bundles
permit only verified internal symlinks. Extended TAR records and hard links are
rejected. Preserve archive permissions/links and test your actual build toolchain.
Authenticated native GET/HEAD and single byte ranges are supported. A cold
request verifies the full stored object into a bounded disk cache before serving
bytes; warm requests still check access. Multipart ranges, native S3 range
forwarding, delta/blockmap generation and a public CDN are not included.

## Exact targets and package names

| Framework | Targets                                                      | Accepted filename endings                                         |
| --------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| Joomla    | `any`                                                        | `.zip`                                                            |
| JetBrains | `any`                                                        | `.zip`, `.jar`                                                    |
| Electron  | `windows-x64`, `windows-arm64`                               | `.exe`, `.zip`                                                    |
| Electron  | `darwin-x64`, `darwin-arm64`                                 | `.zip`, `.dmg`, `.pkg`, `.tar.gz`                                 |
| Electron  | `linux-x64`, `linux-arm64`                                   | `.AppImage`, `.AppImage.tar.gz`, `.tar.gz`, `.deb`, `.rpm`        |
| Tauri     | `windows-x86_64`, `windows-aarch64`, `windows-i686`          | `.exe`, `.msi`, `.nsis.zip`, `.msi.zip`                           |
| Tauri     | `darwin-x86_64`, `darwin-aarch64`                            | `.app.tar.gz`                                                     |
| Tauri     | `linux-x86_64`, `linux-aarch64`, `linux-i686`, `linux-armv7` | `.AppImage`, `.AppImage.tar.gz`                                   |
| Sparkle   | `darwin-x64`, `darwin-arm64`, `darwin-universal`             | `.zip`, `.dmg`, `.pkg`, `.tar.gz`                                 |
| Generic   | Vendor-defined safe target, 1-100 characters                 | Safe filename without a framework-specific extension restriction. |

Targets start with an ASCII letter/digit and otherwise allow letters, digits,
underscores and hyphens. Filenames start with a letter/digit, permit letters,
digits, periods, underscores and hyphens, end with a letter/digit, and are at
most 200 characters. Windows reserved names are refused. Matching is case
sensitive, including `.AppImage`. An accepted extension is not enough for
publication; framework package-content/identity validation still applies.

Tauri metadata requires the base64-encoded complete minisign signature text.
Sparkle requires a canonical base64 64-byte EdDSA signature. Format validation
on the server does not replace signature verification by the native updater.
The signing private key stays in your build system; install the trusted public
key in the application. See [client integration](client-integration.md) for
activation, feed paths and protected package handling.

## Integration and qualification

Server feed formatting, strict package checks, shared entitlement logic and client
transport contracts have automated tests. In a recorded historical run,
Joomla6.1.3/PHP8.5.11 installed a real 1.0.0-to-2.0.0 update, including package
authentication/checksum and activation
persistence through settings saves. In a separate recorded historical run, the
Swift example passed typechecking against a real Sparkle2.9.1 framework.
PHP/Java scope contracts execute with local runtimes;
Rust has parser/format checks and Kotlin has not been compiled against an IDE SDK. Those tests do not prove
native installation, OS signing, notarization, platform key storage or relaunch.
See [verification](verification.md) for the current full-system and actual runtime
results. Do not infer all-platform certification from API coverage.

Official references checked2026-10-21:

- Joomla [update servers](https://manual.joomla.org/docs/building-extensions/install-update/update-server/), [plugin examples](https://manual.joomla.org/docs/building-extensions/plugins/plugin-examples/) and [installer events](https://manual.joomla.org/docs/5.4/building-extensions/plugins/plugin-events/installer/).
- JetBrains [custom repositories and authentication](https://plugins.jetbrains.com/docs/intellij/custom-plugin-repository.html) and [plugin template](https://github.com/JetBrains/intellij-platform-plugin-template).
- Tauri [updater](https://v2.tauri.app/plugin/updater/) and [project generator](https://v2.tauri.app/start/create-project/).
- Electron [stable v26 generic updater](https://www.electron.build/v26/docs/features/auto-update/) and [Forge templates](https://www.electronforge.io/). Unversioned builder docs currently describe unreleasedv27.
- Sparkle [setup, signing and appcast guide](https://sparkle-project.org/documentation/).
