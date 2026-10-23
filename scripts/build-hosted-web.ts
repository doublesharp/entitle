import { resolve, join } from "node:path";
import { readdir, readFile, cp, rm, mkdir } from "node:fs/promises";
import { buildFrontend } from "./frontend-build.ts";
import { normalizeAppBasePath } from "../packages/shared/app-path.ts";
const out = resolve(
  process.env.BUILD_DIR ?? "/Volumes/Scratch/entitle/build/main",
);
const base = normalizeAppBasePath(process.env.WEB_APP_BASE_PATH ?? "/app");
if (!base)
  throw new Error(
    "Hosted marketing and app require a non-root application mount",
  );
await buildFrontend({ kind: "app", output: `${out}/web` });
await buildFrontend({
  kind: "app",
  output: `${out}/hosted-app`,
  basePath: base,
});
await buildFrontend({
  kind: "marketing",
  output: `${out}/marketing`,
  applicationUrl: process.env.WEB_APP_URL ?? base + "/",
});
const hosted = `${out}/hosted-web`;
await rm(hosted, { recursive: true, force: true });
await mkdir(hosted, { recursive: true });
await cp(`${out}/marketing`, hosted, { recursive: true });
await cp(`${out}/hosted-app`, `${hosted}/app`, { recursive: true });
// The publication engine retains hashed assets in one immutable shared pool.
// Keep nested copies as well so the hosted archive also works on a plain server.
for (const name of await readdir(`${out}/hosted-app/assets`)) {
  const source = join(out, "hosted-app/assets", name),
    destination = join(hosted, "assets", name);
  const existing = await readFile(destination).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    },
  );
  if (existing && !existing.equals(await readFile(source)))
    throw new Error(`Immutable asset collision: ${name}`);
  if (!existing) await cp(source, destination);
}
console.log(
  `Independent app, marketing and hosted artifacts ready under ${out}`,
);
