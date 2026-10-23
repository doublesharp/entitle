import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { packageSource, browserNotices } from "./distribution.ts";
import { renderPageMetadata } from "../web/metadata.ts";
const out = resolve(
  process.env.BUILD_DIR ?? "/Volumes/Scratch/entitle/build/main",
);
const requireWeb = createRequire(resolve("apps/web/package.json"));
const { build } = (await import(
  pathToFileURL(requireWeb.resolve("vite")).href
)) as typeof import("vite");
const browserModules = new Set<string>();
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
          html.replace(
            "<!-- PAGE_METADATA -->",
            renderPageMetadata("home", process.env.WEB_PUBLIC_ORIGIN),
          ),
      },
    },
  ],
});

// Reuse Vite's final script/style URLs, with metadata present before JavaScript runs.
const home = await readFile(`${out}/web/index.html`, "utf8");
const homeMetadata = renderPageMetadata("home", process.env.WEB_PUBLIC_ORIGIN);
if (!home.includes(homeMetadata))
  throw new Error("Built HTML is missing the expected page metadata.");
for (const page of ["docs", "seller", "customer"] as const)
  await writeFile(
    `${out}/web/${page}.html`,
    home.replace(
      homeMetadata,
      renderPageMetadata(page, process.env.WEB_PUBLIC_ORIGIN),
    ),
  );

await packageSource(process.cwd(), `${out}/web`);
await writeFile(
  `${out}/web/legal/THIRD-PARTY.txt`,
  await browserNotices([...browserModules], process.cwd()),
);
