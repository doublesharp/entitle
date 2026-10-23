import { resolve } from "node:path";
import { buildFrontend } from "./frontend-build.ts";
const out = resolve(
  process.env.BUILD_DIR ?? "/Volumes/Scratch/entitle/build/main",
);
await buildFrontend({
  kind: "app",
  output: `${out}/web`,
  basePath: process.env.WEB_APP_BASE_PATH,
});
