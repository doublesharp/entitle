import test from "node:test";
import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = process.cwd();
const scratch = "/Volumes/Scratch/entitle/tmp/coolify-split";
const json = async (path: string) => JSON.parse(await readFile(path, "utf8"));

test("workspace owns separate server and browser dependency closures", async () => {
  const server = await json("apps/server/package.json");
  const web = await json("apps/web/package.json");
  const shared = await json("packages/shared/package.json");
  assert.equal(server.dependencies.fastify, "5.12.7");
  assert.equal(web.dependencies.vue, "3.5.44");
  for (const dep of ["vue", "@stripe/stripe-js", "vite", "happy-dom"])
    assert.ok(!server.dependencies[dep] && !server.devDependencies[dep], dep);
  for (const dep of [
    "fastify",
    "knex",
    "better-sqlite3",
    "stripe",
    "@aws-sdk/client-s3",
  ])
    assert.ok(!web.dependencies[dep] && !web.devDependencies[dep], dep);
  assert.deepEqual(shared.dependencies ?? {}, {});
});

test("server builds without browser, tests or docs and runs with no static directory", async (t) => {
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, "server-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const path of [
    "package.json",
    "tsconfig.json",
    "apps/server",
    "packages/shared",
    "src",
    "scripts/build-server.ts",
  ])
    await cp(join(root, path), join(dir, path), {
      recursive: true,
      filter: (p) => !p.includes("node_modules"),
    });
  await symlink(
    resolve("apps/server/node_modules"),
    join(dir, "apps/server/node_modules"),
    "dir",
  );
  const out = join(dir, "output");
  const result = spawnSync(process.execPath, ["scripts/build-server.ts"], {
    cwd: dir,
    env: { ...process.env, BUILD_DIR: out },
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(
    await readFile(join(out, "server/package.json"), "utf8")
      .then(JSON.parse)
      .then((p) => p.type),
    "module",
  );
  assert.ok((await readdir(join(out, "server/src"))).includes("server.js"));
  assert.ok(!(await readdir(out)).includes("web"));
  assert.ok(!(await readdir(join(out, "server"))).includes("tests"));
  const { startServer } = await import(
    pathToFileURL(join(out, "server/src/server.js")).href
  );
  const { loadConfig } = await import(
    pathToFileURL(join(out, "server/src/config.js")).href
  );
  const config = loadConfig({
    APP_SECRET: "ab".repeat(32),
    OPERATOR_TOKEN: "build-test-".repeat(4),
    DATA_DIR: join(dir, "data"),
    WEB_DIR: join(dir, "absent-static"),
    DATABASE_URL: "sqlite::memory:",
  });
  const runtime = await startServer({ ...config, port: 0 });
  t.after(() => runtime.stop());
  const address = runtime.app.server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(
    `http://127.0.0.1:${address.port}/api/v1/health`,
  );
  assert.equal(response.status, 200);
  // No S3 service is supplied by this build fixture; readiness must fail closed.
  assert.equal(
    (await fetch(`http://127.0.0.1:${address.port}/api/v1/ready`)).status,
    503,
  );
  assert.equal((await fetch(`http://127.0.0.1:${address.port}/`)).status, 404);
});

test("frontend builds with invalid server source and includes hashed assets and legal distribution", async (t) => {
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, "web-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const paths = (await readFile("scripts/source-files.txt", "utf8"))
    .trim()
    .split(/\r?\n/);
  for (const path of paths)
    await cp(join(root, path), join(dir, path), { recursive: true });
  await writeFile(join(dir, "src/server.ts"), "invalid server TypeScript {{\n");
  // Expose only this workspace package's installed closure, never root tools or server dependencies.
  await symlink(
    resolve("apps/web/node_modules"),
    join(dir, "apps/web/node_modules"),
    "dir",
  );
  const requireWeb = createRequire(join(dir, "apps/web/package.json"));
  for (const name of [
    "fastify",
    "knex",
    "better-sqlite3",
    "stripe",
    "@aws-sdk/client-s3",
  ])
    assert.throws(() => requireWeb.resolve(name), { code: "MODULE_NOT_FOUND" });
  const out = join(dir, "output");
  const result = spawnSync(process.execPath, ["scripts/build-web.ts"], {
    cwd: dir,
    env: { ...process.env, BUILD_DIR: out },
    encoding: "utf8",
    timeout: 120000,
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(await readdir(out), ["web"]);
  const html = await readFile(join(out, "web/index.html"), "utf8");
  assert.match(html, /assets\/[^" ]+-[\w-]+\.js/);
  assert.doesNotMatch(html, /%SITE_/);
  for (const file of [
    "source.tar.gz",
    "THIRD-PARTY.txt",
    "Elastic-2.0.txt",
    "NOTICE.txt",
  ])
    assert.ok((await readFile(join(out, "web/legal", file))).length > 0, file);
  assert.match(
    await readFile(join(out, "web/legal/THIRD-PARTY.txt"), "utf8"),
    /vue/,
  );
});
