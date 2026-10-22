// Call in Electron's main process. Import autoUpdater from electron-updater.
const configuredUpdaters = new WeakSet();
export async function configureElectronUpdater(
  client,
  autoUpdater,
  target,
  showError,
) {
  if (!/^(windows|darwin|linux)-(x64|arm64)$/.test(target))
    throw Error("Unsupported update target");
  const token = await client.token();
  autoUpdater.autoDownload = false;
  autoUpdater.disableDifferentialDownload = true;
  autoUpdater.requestHeaders = { Authorization: `Bearer ${token}` };
  autoUpdater.setFeedURL({
    provider: "generic",
    url: `${client.api}/updates/electron/${client.product}/${target}`,
    useMultipleRangeRequest: false,
  });
  // Native updater error objects can contain request headers. Never show/log them.
  if (!configuredUpdaters.has(autoUpdater)) {
    autoUpdater.on("error", () =>
      showError("Update check failed. Try again later."),
    );
    configuredUpdaters.add(autoUpdater);
  }
  return autoUpdater;
}
