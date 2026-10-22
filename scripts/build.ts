import { writeFile } from "node:fs/promises";
import { packageSource, browserNotices } from "./distribution.ts";
import { spawnSync } from "node:child_process";
import { mkdirSync, existsSync, symlinkSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "vite";
import { site } from "../src/site.ts";
const out = resolve(
  process.env.BUILD_DIR ?? "/Volumes/Scratch/double-entitle-wp/build/main",
);
mkdirSync(out, { recursive: true });
if (!existsSync(`${out}/node_modules`))
  symlinkSync(resolve("node_modules"), `${out}/node_modules`, "dir");
const result = spawnSync(
  process.execPath,
  [resolve("node_modules/typescript/bin/tsc"), "--outDir", out],
  {
    stdio: "inherit",
    env: process.env,
  },
);
if (result.status !== 0) process.exit(result.status ?? 1);
const browserModules = new Set<string>();
const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
await build({
  root: "web",
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
