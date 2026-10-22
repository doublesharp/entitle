import type { Framework, FrameworkProduct, Installation } from "./api.ts";

export const frameworkInfo: Record<
  Framework,
  { name: string; targets: string[]; accept: string; signature: boolean }
> = {
  wordpress: {
    name: "WordPress",
    targets: [],
    accept: ".zip,application/zip",
    signature: false,
  },
  joomla: {
    name: "Joomla",
    targets: ["any"],
    accept: ".zip,application/zip",
    signature: false,
  },
  electron: {
    name: "Electron",
    targets: [
      "windows-x64",
      "windows-arm64",
      "darwin-x64",
      "darwin-arm64",
      "linux-x64",
      "linux-arm64",
    ],
    accept: ".exe,.zip,.dmg,.AppImage,.deb,.rpm,.tar.gz",
    signature: false,
  },
  tauri: {
    name: "Tauri",
    targets: [
      "windows-x86_64",
      "windows-aarch64",
      "windows-i686",
      "darwin-x86_64",
      "darwin-aarch64",
      "linux-x86_64",
      "linux-aarch64",
      "linux-i686",
      "linux-armv7",
    ],
    accept: ".exe,.msi,.zip,.tar.gz,.AppImage",
    signature: true,
  },
  sparkle: {
    name: "Sparkle",
    targets: ["darwin-x64", "darwin-arm64", "darwin-universal"],
    accept: ".zip,.dmg,.pkg",
    signature: true,
  },
  jetbrains: {
    name: "JetBrains",
    targets: ["any"],
    accept: ".zip,.jar",
    signature: false,
  },
  generic: { name: "Generic", targets: [], accept: "", signature: false },
};
export const frameworkOf = (product?: FrameworkProduct): Framework =>
  product?.framework || "wordpress";
export const seatUnit = (product: FrameworkProduct): "site" | "device" =>
  frameworkOf(product) === "wordpress" ||
  frameworkOf(product) === "joomla" ||
  product.frameworkConfig?.activationKind === "site"
    ? "site"
    : "device";
export const installationName = (installation: Installation): string =>
  installation.label || installation.site_url.replace(/^device:/, "");

const feedPaths: Record<Exclude<Framework, "wordpress">, string> = {
  joomla: "joomla/{product}.xml",
  electron: "electron/{product}/windows-x64/latest.yml",
  tauri: "tauri/{product}/windows-x86_64/{currentVersion}",
  sparkle: "sparkle/{product}/darwin-x64/appcast.xml",
  jetbrains: "jetbrains/{product}/updatePlugins.xml",
  generic: "generic/{product}/{target}",
};
export function setupConfiguration(
  product: FrameworkProduct | undefined,
  origin: string,
  tenant: string,
  slug: string,
): string {
  const base = `${origin}/api/v1/tenants/${encodeURIComponent(tenant)}`;
  const framework = frameworkOf(product);
  if (framework === "wordpress")
    return `// Tenant API URL. No seller or operator credentials belong in your plugin.\n$api_url = '${base}';\n$product_slug = '${slug}';\n// Configure the example PHP client with these values. Each buyer supplies their own license key.`;
  const feed = `${base}/updates/${feedPaths[framework].replace("{product}", encodeURIComponent(slug))}`;
  return (
    JSON.stringify(
      { framework, apiUrl: base, product: slug, feedUrl: feed },
      null,
      2,
    ) +
    `\n\nUse the ${frameworkInfo[framework].name} client example. Each buyer supplies their own license key.\nActivate through ${base}/activate. Send the returned activation token in the Authorization: Bearer header to this product's feed and package URLs only.\n${seatUnit(product!) === "site" ? "Send installationId and siteUrl for site activation." : "Persist a random installationId across updates. Send installationId and optional installationLabel for device activation."}\nReplace target and currentVersion placeholders or the example platform target for your build. Never embed seller or operator credentials. Native updaters must verify the seller's signatures where required.`
  );
}
