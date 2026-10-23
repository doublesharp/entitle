import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const out = resolve(
  process.env.BUILD_DIR ?? "/Volumes/Scratch/entitle/build/main",
  "server",
);
await mkdir(out, { recursive: true });
const modules = resolve(
  existsSync("apps/server/node_modules/typescript")
    ? "apps/server/node_modules"
    : "node_modules",
);
// Existing source paths stay stable, while compilation resolves only server dependencies.
const stage = await mkdtemp(`${out}/.source-`);
let status: number;
try {
  for (const path of [
    "src",
    "packages/shared",
    "tsconfig.json",
    "apps/server/tsconfig.json",
  ])
    await cp(path, `${stage}/${path}`, { recursive: true });
  await writeFile(`${stage}/package.json`, JSON.stringify({ type: "module" }));
  await symlink(modules, `${stage}/node_modules`, "dir");
  const result = spawnSync(
    process.execPath,
    [
      `${modules}/typescript/bin/tsc`,
      "--project",
      `${stage}/apps/server/tsconfig.json`,
      "--outDir",
      out,
    ],
    { stdio: "inherit", env: process.env },
  );
  status = result.status ?? 1;
} finally {
  await rm(stage, { recursive: true, force: true });
}
if (status !== 0) process.exit(status);
await writeFile(
  `${out}/package.json`,
  JSON.stringify({ type: "module" }) + "\n",
);
if (!existsSync(`${out}/node_modules`))
  await symlink(modules, `${out}/node_modules`, "dir");
