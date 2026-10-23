import { spawnSync } from "node:child_process";
for (const target of ["server", "web"]) {
  const result = spawnSync(process.execPath, [`scripts/build-${target}.ts`], {
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
