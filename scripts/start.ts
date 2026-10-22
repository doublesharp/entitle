import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const out = resolve(
  process.env.BUILD_DIR ?? "/Volumes/Scratch/double-entitle-wp/build/main",
);
const { startServer } = await import(
  pathToFileURL(`${out}/src/server.js`).href
);
await startServer();
