import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const out = resolve(
  process.env.BUILD_DIR ?? "/Volumes/Scratch/entitle/build/main",
);
const { startRuntime } = await import(
  pathToFileURL(`${out}/server/src/server.js`).href
);
await startRuntime();
