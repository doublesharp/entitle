/**
 * @file Connect the generic client's activation token to electron-updater.
 * Run in Electron's main process; keep credentials out of renderer IPC responses.
 */
const configuredUpdaters = new WeakSet();
/**
 * Configure native update checks after activation or when restoring a saved token.
 * Call again after the token changes. This configures the updater without checking,
 * downloading, or installing anything; the host app controls those user actions.
 *
 * @param {import('../generic/client.mjs').UpdateClient} client Generic update client.
 * @param {import('electron-updater').AppUpdater} autoUpdater Use electron-updater's instance.
 * @param {string} target Published target, such as `windows-x64` or `darwin-arm64`.
 * @param {(message: string) => void} showError Display a fixed message in update settings.
 * @returns {Promise<import('electron-updater').AppUpdater>} The configured updater instance.
 * @throws {Error} If the target is unsupported or no valid activation token is stored.
 */
export async function configureElectronUpdater(
  client,
  autoUpdater,
  target,
  showError,
) {
  // Step 1: select a supported feed and load the credential in the main process.
  if (!/^(windows|darwin|linux)-(x64|arm64)$/.test(target))
    throw Error("Unsupported update target");
  const token = await client.token();
  // Step 2: require download consent and fetch whole published artifacts.
  autoUpdater.autoDownload = false;
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.requestHeaders = { Authorization: `Bearer ${token}` };
  // Step 3: use this tenant/product/target's native feed for metadata and packages.
  autoUpdater.setFeedURL({
    provider: "generic",
    url: `${client.api}/updates/electron/${client.product}/${target}`,
    useMultipleRangeRequest: false,
  });
  // Step 4: attach one safe error handler, even if settings reconfigure this instance.
  // Native updater error objects can contain request headers. Never show/log them.
  if (!configuredUpdaters.has(autoUpdater)) {
    autoUpdater.on("error", () =>
      showError("Update check failed. Try again later."),
    );
    configuredUpdaters.add(autoUpdater);
  }
  return autoUpdater;
}
