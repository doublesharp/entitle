import { readFile, writeFile, rename, rm, access } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { packageSource, browserNotices } from "./distribution.ts";
import { renderPageMetadata } from "../web/metadata.ts";
import {
  normalizeAppBasePath,
  normalizeApplicationUrl,
} from "../packages/shared/app-path.ts";

export function marketingApplicationUrl(input = "/app/") {
  return normalizeApplicationUrl(input);
}
export async function buildFrontend(options: {
  kind: "app" | "marketing";
  output: string;
  basePath?: string | undefined;
  applicationUrl?: string | undefined;
}) {
  if (resolve(options.output).startsWith("/Volumes/Scratch/"))
    await access("/Volumes/Scratch");
  const base = normalizeAppBasePath(options.basePath);
  const kind = options.kind;
  const packagePath = `apps/${kind === "app" ? "web" : "marketing"}/package.json`;
  const requireWeb = createRequire(resolve(packagePath));
  const { build } = (await import(
    pathToFileURL(requireWeb.resolve("vite")).href
  )) as typeof import("vite");
  const modules = new Set<string>();
  const page = kind === "app" ? "seller" : "home";
  const origin = process.env.WEB_PUBLIC_ORIGIN;
  const metadata = renderPageMetadata(page, origin, base);
  const appUrl = marketingApplicationUrl(options.applicationUrl);
  await build({
    root: "web",
    base: base + "/",
    resolve: {
      alias: {
        vue: requireWeb.resolve("vue/dist/vue.runtime.esm-bundler.js"),
        ...(kind === "app"
          ? {
              "@stripe/stripe-js/pure/index.js": requireWeb.resolve(
                "@stripe/stripe-js/pure/index.js",
              ),
            }
          : {}),
      },
    },
    build: {
      outDir: options.output,
      emptyOutDir: true,
      ...(kind === "marketing"
        ? { rollupOptions: { input: resolve("web/marketing.html") } }
        : {}),
    },
    plugins: [
      {
        name: "entitle-independent-frontend",
        generateBundle(_options, bundle) {
          for (const chunk of Object.values(bundle))
            if (chunk.type === "chunk")
              for (const id of Object.keys(chunk.modules)) modules.add(id);
        },
        transformIndexHtml: {
          order: "pre",
          handler: (html) =>
            html.replace(
              "<!-- PAGE_METADATA -->",
              `<meta name="${kind === "app" ? "entitle-app-base" : "entitle-app-url"}" content="${(kind === "app" ? base : appUrl).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}" />\n    ${metadata}`,
            ),
        },
      },
    ],
  });
  if (kind === "marketing")
    await rename(
      `${options.output}/marketing.html`,
      `${options.output}/index.html`,
    );
  const index = await readFile(`${options.output}/index.html`, "utf8");
  if (!index.includes(metadata))
    throw new Error("Built HTML is missing expected metadata");
  const pages =
    kind === "app"
      ? (["seller", "customer", "docs"] as const)
      : (["docs"] as const);
  for (const child of pages)
    await writeFile(
      `${options.output}/${child}.html`,
      index.replace(metadata, renderPageMetadata(child, origin, base)),
    );
  const unused = kind === "app" ? ["home"] : ["seller", "customer"];
  for (const image of unused)
    for (const extension of ["png", "svg"])
      await rm(`${options.output}/social/${image}.${extension}`, {
        force: true,
      });
  await packageSource(process.cwd(), options.output);
  await writeFile(
    `${options.output}/legal/THIRD-PARTY.txt`,
    await browserNotices([...modules], process.cwd(), packagePath),
  );
}
