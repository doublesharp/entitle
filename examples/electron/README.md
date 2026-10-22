# Electron

Use `electron-updater` with electron-builder 26, not Electron's built-in
`autoUpdater`. Add both example modules and `../generic/client.mjs` to the main
process. Keep all license requests and tokens out of the renderer. Register a
small, validated IPC settings action for activation and deactivation.

```js
import { app, safeStorage } from 'electron';
import electronUpdater from 'electron-updater';
import { join } from 'node:path';
import { createClient } from '../generic/client.mjs';
import { electronStorage } from './storage.mjs';
import { configureElectronUpdater } from './updater.mjs';
// Step 1: wait for Electron's OS credential services, then load this product's identity.
await app.whenReady();
const client = await createClient({ api, product: 'my-app',
  storage: electronStorage(join(app.getPath('userData'), 'my-app-license'), safeStorage) });
// Step 2: activate from a settings action; clear the key input after the request.
await client.activate(licenseKeyFromSettings, 'Work laptop');
// Step 3: choose this build's published target and configure authenticated native checks.
const target = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
const updater = await configureElectronUpdater(client, electronUpdater.autoUpdater, target, showUpdateError);
// Step 4: check for an offer. Configuration keeps automatic downloads disabled.
await updater.checkForUpdates();
// After user accepts an update, await updater.downloadUpdate().
// Once update-downloaded fires and user accepts restart, updater.quitAndInstall().
// On settings deactivation, stop scheduling checks, clear updater.requestHeaders,
// then await client.deactivate(). Do not disable installed functionality.
```

Reconfigure headers from the stored token on each launch and after activation.
Settings errors should display a fixed message without the native exception.
Use a single-instance application lock to serialize settings writes. The UUID
file is published atomically after exclusive creation and survives upgrades and deactivation. Tokens use
Electron safeStorage, which refuses the insecure Linux `basic_text` backend.

Build NSIS `.exe` for Windows, an updater ZIP for macOS, or `.AppImage` for Linux.
Set generic publish URL to the target directory used above. Publish the final
artifact bytes through `publish-asset`; the service renders latest YAML from
those exact bytes. Native requests use `latest.yml`, `latest-mac.yml`, or
`latest-linux.yml`. Differential downloads are disabled because this service
does not publish blockmaps. macOS updates require seller code signing; keep
Windows publisher/signature verification configured in electron-builder.
Never send unsigned bundles as substitutes for a working signing setup.
No cross-origin release URLs or redirects are used.

Official interfaces: [electron-builder 26 auto update](https://www.electron.build/v26/docs/features/auto-update/)
and [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).
Qualification: tests execute generic transport and native updater configuration
against a test object. Actual Electron packaged application download, signature
validation, restart and installation remain unqualified.

Linux ARM64 clients request `latest-linux-arm64.yml`; `latest-linux.yml` is reserved for Linux x64.
