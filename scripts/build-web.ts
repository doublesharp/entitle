import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { packageSource, browserNotices } from "./distribution.ts";
import { site } from "../packages/shared/site.ts";
const out = resolve(
  process.env.BUILD_DIR ?? "/Volumes/Scratch/entitle/build/main",
);
const requireWeb = createRequire(resolve("apps/web/package.json"));
const { build } = (await import(
  pathToFileURL(requireWeb.resolve("vite")).href
)) as typeof import("vite");
const browserModules = new Set<string>();
const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
await build({
  root: "web",
  resolve: {
    alias: {
      vue: requireWeb.resolve("vue/dist/vue.runtime.esm-bundler.js"),
      "@stripe/stripe-js/pure/index.js": requireWeb.resolve(
        "@stripe/stripe-js/pure/index.js",
      ),
    },
  },
  build: { outDir: `${out}/web`, emptyOutDir: true },
  plugins: [
    {
      name: "shared-site-branding",
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle))
          if (output.type === "chunk")
            for (const id of Object.keys(output.modules))
              browserModules.add(id);
      },
      transformIndexHtml: {
        order: "pre",
        handler: (html) =>
          html
            .replaceAll("%SITE_NAME%", escapeHtml(site.name))
            .replaceAll("%SITE_TAGLINE%", escapeHtml(site.tagline))
            .replaceAll("%SITE_DESCRIPTION%", escapeHtml(site.description)),
      },
    },
  ],
});

await packageSource(process.cwd(), `${out}/web`);
await writeFile(
  `${out}/web/legal/THIRD-PARTY.txt`,
  await browserNotices([...browserModules], process.cwd()),
);
