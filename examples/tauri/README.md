# Tauri 2

Copy `updates.rs` into `src-tauri/src/`, set its build-time API/product constants,
and merge the config fragment. Replace the public key with the updater public
key from your signing workflow. Signing is mandatory. Keep the private signing
key entirely in your build system. Publish the exact updater artifact and the
contents of its `.sig` file. Use native target values such as `darwin-aarch64`,
`windows-x86_64` and `linux-x86_64`.

Add `tauri-plugin-updater` 2.14.x, `reqwest` with `json`, `serde_json`, `uuid` with `v4`,
`fs2`, and `tokio` with `sync` to your desktop Cargo dependencies. Add `keyring`
with the backend for your platform, for example `apple-native` on macOS,
`windows-native` on Windows, and a supported Secret Service backend on Linux.
Pin the updater and reqwest minor versions together in your lockfile because
`configure_client` exposes the updater's reqwest type. Use the current supported
Tauri 2 SDK. The updater initialization in `lib.rs` is:

```rust
mod updates;
// In the existing tauri::Builder chain:
// Step 1: enable the native updater that verifies signed packages.
.plugin(tauri_plugin_updater::Builder::new().build())
// Step 2: keep the pending update in Rust, shared across serialized settings commands.
.manage(updates::Updates(tokio::sync::Mutex::new(None)))
// Step 3: expose the lifecycle to your local settings UI, with install consent in that UI.
.invoke_handler(tauri::generate_handler![
    updates::activate, updates::deactivate, updates::activation_status,
    updates::check_update, updates::install_update
])
```

Invoke these commands from your local settings UI, using `key` and optional
`label` for activation. Show only their returned fixed errors. Do not expose
commands to remote content. Restrict the window capability to your application
and keep update/install actions behind user interaction. `check_update` returns
version/notes or null; ask for consent before `install_update`. The native updater
verifies signatures, stages and installs; Windows exits during installation.
After successful installation on other platforms, offer an app restart using
your existing restart command.

A randomly generated UUID is stored in app data under a file lock and survives
updates and deactivation. Tokens live in the operating-system credential vault.
No hardware fingerprint is collected. Deactivation clears any pending update.
Network requests reject redirects, including native package downloads. The
updater rejects metadata pointing outside this product's configured asset path.
License expiration or failed requests never disable installed app functionality.

Official interfaces: [Tauri updater](https://v2.tauri.app/plugin/updater/),
[updater Rust API](https://docs.rs/tauri-plugin-updater/2.14.0/tauri_plugin_updater/struct.UpdaterBuilder.html),
[updater Rust source](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/updater/src/updater.rs).
Qualification: the service's native JSON/signature metadata is unit tested.
The Rust template is syntax checked when rustfmt is available. A linked Tauri
application, OS credential backends, signed bundle download and native
installation remain unqualified; run them in the seller's own app on every target.
