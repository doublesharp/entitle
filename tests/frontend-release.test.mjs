import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tool = path.join(repo, "scripts/deployment/frontend-release.mjs");
const scratch = "/Volumes/Scratch/entitle/tmp/frontend-release";
const sha = "a".repeat(40);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
function cli(...args) {
  return spawnSync(process.execPath, [tool, ...args], { encoding: "utf8" });
}
function ok(...args) {
  const result = cli(...args);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function bad(...args) {
  const result = cli(...args);
  assert.notEqual(result.status, 0, result.stdout);
  return result;
}
async function fixture(t) {
  await fs.access("/Volumes/Scratch");
  await fs.mkdir(scratch, { recursive: true });
  const dir = await fs.realpath(await fs.mkdtemp(path.join(scratch, "case-")));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, "web");
  const root = path.join(dir, "root");
  await fs.mkdir(path.join(input, "assets"), { recursive: true });
  await fs.mkdir(path.join(input, "legal"));
  await fs.writeFile(
    path.join(input, "legal/THIRD-PARTY.txt"),
    "third-party notices",
  );
  await fs.writeFile(
    path.join(input, "index.html"),
    "<html>release one</html>",
  );
  await fs.writeFile(path.join(input, "assets/app-one.js"), "console.log(1);");
  await fs.writeFile(path.join(input, "privacy.html"), "privacy policy");
  const pack = (name = "release.tar") =>
    ok(
      "pack",
      "--input",
      input,
      "--output",
      path.join(dir, name),
      "--source-sha",
      sha,
    );
  const activate = (release) =>
    ok(
      "activate",
      "--archive",
      release.archive,
      "--sha256",
      release.sha256,
      "--root",
      root,
    );
  return { dir, input, root, pack, activate };
}

// Deliberately independent USTAR fixture writer. No extraction tool is used by tests.
function tar(entries) {
  const blocks = [];
  for (const {
    name,
    body = Buffer.alloc(0),
    type = "0",
    size = body.length,
    link = "",
  } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "ascii");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(size.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header.write(type, 156);
    header.write(link, 157, 100, "ascii");
    header.write("ustar\0", 257);
    header.write("00", 263);
    const sum = header.reduce((a, b) => a + b, 0);
    header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

function fixtureEntries(bytes) {
  const entries = [];
  let offset = 0;
  while (bytes[offset] !== 0) {
    const name = bytes
      .subarray(offset, offset + 100)
      .toString("ascii")
      .replace(/\0.*$/, "");
    const size = Number.parseInt(
      bytes.subarray(offset + 124, offset + 136).toString("ascii"),
      8,
    );
    entries.push({
      name,
      body: bytes.subarray(offset + 512, offset + 512 + size),
    });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

test("non-USTAR high-bit header fields are rejected even with a valid checksum", async (t) => {
  const f = await fixture(t);
  const a = f.pack();
  for (const offset of [
    100, 108, 116, 124, 136, 257, 263, 265, 297, 329, 337,
  ]) {
    const bytes = await fs.readFile(a.archive);
    bytes[offset] |= 128;
    bytes.fill(32, 148, 156);
    const sum = bytes.subarray(0, 512).reduce((total, byte) => total + byte, 0);
    bytes.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    const archive = path.join(f.dir, `high-bit-${offset}.tar`);
    await fs.writeFile(archive, bytes);
    bad("verify", "--archive", archive, "--sha256", digest(bytes));
  }
});

test("FIFO archive and stored asset inputs are rejected without blocking", async (t) => {
  const f = await fixture(t);
  const a = f.pack();
  const fifo = path.join(f.dir, "archive.fifo");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  const rejected = spawnSync(
    process.execPath,
    [tool, "verify", "--archive", fifo, "--sha256", a.sha256],
    { encoding: "utf8", timeout: 1200 },
  );
  assert.equal(rejected.status, 1, `FIFO archive blocked: ${rejected.error}`);
  assert.match(rejected.stderr, /Unsafe file/);
  f.activate(a);
  const asset = path.join(f.root, "shared/assets/app-one.js");
  await fs.rm(asset);
  assert.equal(spawnSync("mkfifo", [asset]).status, 0);
  const stored = spawnSync(
    process.execPath,
    [
      tool,
      "activate",
      "--archive",
      a.archive,
      "--sha256",
      a.sha256,
      "--root",
      f.root,
    ],
    { encoding: "utf8", timeout: 1200 },
  );
  assert.equal(stored.status, 1, `FIFO asset blocked: ${stored.error}`);
  assert.match(stored.stderr, /Unsafe file/);
  assert.equal(
    await fs.readlink(path.join(f.root, "current")),
    `releases/${a.releaseId}`,
  );
  assert.equal(
    await fs
      .lstat(path.join(f.root, ".frontend-release.lock"))
      .catch(() => null),
    null,
  );
});

test("pack is deterministic, carries file checksums/provenance and verifies in a subprocess", async (t) => {
  const f = await fixture(t);
  const a = f.pack();
  const b = f.pack("second.tar");
  assert.equal(a.sourceSha, sha);
  assert.match(a.releaseId, new RegExp(`^${sha}-[a-f0-9]{64}$`));
  assert.equal(a.sha256, b.sha256);
  const result = ok("verify", "--archive", a.archive, "--sha256", a.sha256);
  assert.equal(result.releaseId, a.releaseId);
  assert.equal(result.sourceSha, sha);
  assert.equal(result.fileCount, 4);
});

test("activate retains previous assets, swaps current, is idempotent and supports rollback", async (t) => {
  const f = await fixture(t);
  const a = f.pack();
  f.activate(a);
  assert.equal(
    await fs.readlink(path.join(f.root, "current")),
    `releases/${a.releaseId}`,
  );
  const manifest = JSON.parse(
    await fs.readFile(path.join(f.root, "current/release-manifest.json")),
  );
  assert.equal(
    manifest.files.find((file) => file.path === "index.html").sha256,
    digest("<html>release one</html>"),
  );
  assert.equal(
    (await fs.stat(path.join(f.root, "current/index.html"))).mode & 0o222,
    0,
  );
  await fs.writeFile(
    path.join(f.input, "index.html"),
    "<html>release two</html>",
  );
  await fs.rm(path.join(f.input, "assets/app-one.js"));
  await fs.writeFile(
    path.join(f.input, "assets/app-two.js"),
    "console.log(2);",
  );
  const b = f.pack("two.tar");
  f.activate(b);
  f.activate(b);
  assert.equal(
    await fs.readFile(path.join(f.root, "shared/assets/app-one.js"), "utf8"),
    "console.log(1);",
  );
  assert.equal(
    await fs.readFile(path.join(f.root, "shared/assets/app-two.js"), "utf8"),
    "console.log(2);",
  );
  ok("rollback", "--root", f.root, "--release", a.releaseId);
  assert.equal(
    await fs.readFile(path.join(f.root, "current/index.html"), "utf8"),
    "<html>release one</html>",
  );
});

test("digest/content corruption and immutable asset collisions cannot change current", async (t) => {
  const f = await fixture(t);
  const a = f.pack();
  f.activate(a);
  const before = await fs.readlink(path.join(f.root, "current"));
  bad(
    "activate",
    "--archive",
    a.archive,
    "--sha256",
    "0".repeat(64),
    "--root",
    f.root,
  );
  const bytes = await fs.readFile(a.archive);
  const index = bytes.indexOf(Buffer.from("<html>release one</html>"));
  assert.ok(index > 0);
  bytes[index] ^= 1;
  const corrupted = path.join(f.dir, "corrupt.tar");
  await fs.writeFile(corrupted, bytes);
  bad(
    "activate",
    "--archive",
    corrupted,
    "--sha256",
    digest(bytes),
    "--root",
    f.root,
  );
  await fs.writeFile(
    path.join(f.input, "assets/app-one.js"),
    "different bytes",
  );
  const b = f.pack("collision.tar");
  const collision = bad(
    "activate",
    "--archive",
    b.archive,
    "--sha256",
    b.sha256,
    "--root",
    f.root,
  );
  assert.match(collision.stderr, /collision/i);
  assert.equal(await fs.readlink(path.join(f.root, "current")), before);
  await fs.chmod(path.join(f.root, "current/index.html"), 0o644);
  await fs.writeFile(path.join(f.root, "current/index.html"), "tampered");
  bad("rollback", "--root", f.root, "--release", a.releaseId);
  assert.equal(await fs.readlink(path.join(f.root, "current")), before);
});

test("pack rejects symlinks/hardlinks and refuses overwriting archives", async (t) => {
  const f = await fixture(t);
  await fs.symlink("/etc/passwd", path.join(f.input, "linked"));
  bad(
    "pack",
    "--input",
    f.input,
    "--output",
    path.join(f.dir, "bad.tar"),
    "--source-sha",
    sha,
  );
  await fs.rm(path.join(f.input, "linked"));
  await fs.link(
    path.join(f.input, "index.html"),
    path.join(f.input, "hardlink"),
  );
  bad(
    "pack",
    "--input",
    f.input,
    "--output",
    path.join(f.dir, "bad.tar"),
    "--source-sha",
    sha,
  );
  await fs.rm(path.join(f.input, "hardlink"));
  f.pack();
  bad(
    "pack",
    "--input",
    f.input,
    "--output",
    path.join(f.dir, "release.tar"),
    "--source-sha",
    sha,
  );
});

test("unsafe, ambiguous, truncated and excessive archives fail before extraction", async (t) => {
  const f = await fixture(t);
  const a = f.pack();
  f.activate(a);
  const before = await fs.readlink(path.join(f.root, "current"));
  const valid = fixtureEntries(await fs.readFile(a.archive));
  const attacks = [
    [{ name: "../escape", body: Buffer.from("bad") }],
    [{ name: "/absolute" }],
    [{ name: "web/../escape" }],
    [{ name: "web/large", size: 1024 ** 3 }],
    [{ name: "web/index.html" }, { name: "web/index.html" }],
  ].map((entries) => tar([...valid, ...entries]));
  for (const type of ["1", "2", "3", "4", "5", "6", "x", "g", "L", "K"]) {
    // Keep the file's valid bytes/checksum so rejection must inspect its type.
    attacks.push(
      tar(
        valid.map((entry) =>
          entry.name === "web/index.html"
            ? { ...entry, type, link: "/etc/passwd" }
            : entry,
        ),
      ),
    );
  }
  const changedManifest = JSON.parse(valid[0].body);
  changedManifest.sourceSha = "b".repeat(40);
  attacks.push(
    tar([
      {
        ...valid[0],
        body: Buffer.from(JSON.stringify(changedManifest) + "\n"),
      },
      ...valid.slice(1),
    ]),
  );
  attacks.push(
    tar([
      ...valid,
      ...Array.from({ length: 10000 }, (_, index) => ({
        name: `web/file-${index}`,
      })),
    ]),
  );
  attacks.push((await fs.readFile(a.archive)).subarray(0, 700));
  attacks.push(
    Buffer.concat([
      await fs.readFile(a.archive),
      Buffer.from("trailing garbage"),
    ]),
  );
  for (let i = 0; i < attacks.length; i++) {
    const archive = path.join(f.dir, `attack-${i}.tar`);
    await fs.writeFile(archive, attacks[i]);
    bad(
      "activate",
      "--archive",
      archive,
      "--sha256",
      digest(attacks[i]),
      "--root",
      f.root,
    );
    assert.equal(await fs.readlink(path.join(f.root, "current")), before);
  }
  assert.deepEqual((await fs.readdir(path.join(f.root, "releases"))).sort(), [
    a.releaseId,
  ]);
  assert.equal(
    await fs.stat(path.join(f.dir, "escape")).catch(() => null),
    null,
  );
});

test("activation waits for the host lock and rejects symlinked storage", async (t) => {
  const f = await fixture(t);
  const a = f.pack();
  await fs.mkdir(path.join(f.root, ".frontend-release.lock"), {
    recursive: true,
  });
  const child = spawn(process.execPath, [
    tool,
    "activate",
    "--archive",
    a.archive,
    "--sha256",
    a.sha256,
    "--root",
    f.root,
  ]);
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((resolve) => child.on("exit", resolve));
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(
    await fs.lstat(path.join(f.root, "current")).catch(() => null),
    null,
  );
  await fs.rmdir(path.join(f.root, ".frontend-release.lock"));
  assert.equal(await done, 0, stderr);
  const other = path.join(f.dir, "other");
  await fs.mkdir(other);
  const unsafeRoot = path.join(f.dir, "unsafe");
  await fs.mkdir(unsafeRoot);
  await fs.symlink(other, path.join(unsafeRoot, "releases"));
  bad(
    "activate",
    "--archive",
    a.archive,
    "--sha256",
    a.sha256,
    "--root",
    unsafeRoot,
  );
  assert.deepEqual(await fs.readdir(other), []);
  await fs.rm(path.join(unsafeRoot, "releases"));
  await fs.symlink(other, path.join(unsafeRoot, "shared"));
  bad(
    "activate",
    "--archive",
    a.archive,
    "--sha256",
    a.sha256,
    "--root",
    unsafeRoot,
  );
  assert.deepEqual(await fs.readdir(other), []);
});

test("long USTAR paths round-trip and invalid provenance/CLI flags fail closed", async (t) => {
  const f = await fixture(t);
  const nested = `${"a".repeat(75)}/${"b".repeat(90)}.js`;
  await fs.mkdir(path.dirname(path.join(f.input, nested)), { recursive: true });
  await fs.writeFile(path.join(f.input, nested), "long path");
  const a = f.pack();
  f.activate(a);
  assert.equal(
    await fs.readFile(path.join(f.root, "current", nested), "utf8"),
    "long path",
  );
  bad(
    "pack",
    "--input",
    f.input,
    "--output",
    path.join(f.dir, "bad-sha.tar"),
    "--source-sha",
    "main",
  );
  bad(
    "verify",
    "--archive",
    a.archive,
    "--sha256",
    a.sha256,
    "--extract",
    f.root,
  );
  bad("rollback", "--root", f.root, "--release", "../current");
  assert.equal(
    await fs.readlink(path.join(f.root, "current")),
    `releases/${a.releaseId}`,
  );
});

test("parallel activations/rollback keep current readable and publish complete releases", async (t) => {
  const f = await fixture(t);
  const a = f.pack();
  f.activate(a);
  const releases = [a];
  for (let index = 0; index < 3; index++) {
    await fs.writeFile(
      path.join(f.input, "index.html"),
      `<html>release ${index}</html>`,
    );
    await fs.writeFile(
      path.join(f.input, `assets/parallel-${index}.js`),
      String(index),
    );
    releases.push(f.pack(`parallel-${index}.tar`));
  }
  const commands = releases.map((release) => [
    "activate",
    "--archive",
    release.archive,
    "--sha256",
    release.sha256,
    "--root",
    f.root,
  ]);
  commands.push(["rollback", "--root", f.root, "--release", a.releaseId]);
  let finished = false;
  const work = Promise.all(
    commands.map(
      (args) =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, [tool, ...args]);
          let stderr = "";
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.on("error", reject);
          child.on("exit", (code) =>
            code === 0 ? resolve() : reject(new Error(stderr)),
          );
        }),
    ),
  ).finally(() => {
    finished = true;
  });
  while (!finished) {
    assert.match(
      await fs.readFile(path.join(f.root, "current/index.html"), "utf8"),
      /^<html>release (one|[0-2])<\/html>$/,
    );
    const pointer = await fs.readlink(path.join(f.root, "current"));
    assert.ok(
      releases.some((release) => pointer === `releases/${release.releaseId}`),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await work;
  assert.equal(
    (await fs.readdir(path.join(f.root, "releases"))).length,
    releases.length,
  );
  assert.equal(
    await fs
      .lstat(path.join(f.root, ".frontend-release.lock"))
      .catch(() => null),
    null,
  );
});

test(
  "filtered frontend install runs checks and rejects invalid code and failing client tests",
  {
    skip: process.env.FRONTEND_CHECKS_SMOKE !== "1",
    timeout: 180000,
  },
  async (t) => {
    const f = await fixture(t);
    const isolated = path.join(f.dir, "isolated");
    const sources = (
      await fs.readFile(path.join(repo, "scripts/source-files.txt"), "utf8")
    )
      .trim()
      .split(/\r?\n/);
    for (const source of sources)
      await fs.cp(path.join(repo, source), path.join(isolated, source), {
        recursive: true,
      });
    const pkg = JSON.parse(
      await fs.readFile(path.join(isolated, "apps/web/package.json")),
    );
    for (const script of ["typecheck", "lint", "test"])
      assert.ok(pkg.scripts[script], `frontend ${script} script must exist`);
    function pnpm(...args) {
      const env = {
        ...process.env,
        NODE_ENV: "production",
        BUILD_DIR: path.join(f.dir, "build"),
      };
      // These are independent test-runner processes, not children in this suite.
      delete env.NODE_TEST_CONTEXT;
      return spawnSync("pnpm", args, {
        cwd: isolated,
        encoding: "utf8",
        timeout: 120000,
        env,
      });
    }
    const install = pnpm(
      "--filter",
      "@entitle/web...",
      "install",
      "--prod",
      "--frozen-lockfile",
      "--ignore-scripts",
      "--store-dir",
      "/Volumes/Scratch/entitle/cache/pnpm",
    );
    assert.equal(install.status, 0, install.stdout + install.stderr);
    for (const name of [
      "fastify",
      "better-sqlite3",
      "knex",
      "@aws-sdk/client-s3",
    ]) {
      assert.equal(
        await fs
          .lstat(path.join(isolated, "node_modules", name))
          .catch(() => null),
        null,
      );
      assert.equal(
        await fs
          .lstat(path.join(isolated, "apps/web/node_modules", name))
          .catch(() => null),
        null,
      );
    }
    for (const script of [
      "typecheck:web",
      "lint:web",
      "test:web",
      "build:web",
    ]) {
      const result = pnpm(script);
      assert.equal(
        result.status,
        0,
        `${script}: ${result.stdout}${result.stderr}`,
      );
      if (script === "test:web")
        assert.match(
          result.stdout + result.stderr,
          /login secrets are extracted/,
        );
      t.diagnostic(`${script}: exit ${result.status}`);
    }
    const slots = await fs.readdir(path.join(isolated, "node_modules/.pnpm"));
    assert.equal(
      slots.some((name) =>
        /^(better-sqlite3|fastify|knex|@aws-sdk\+client-s3)@/.test(name),
      ),
      false,
    );
    t.diagnostic(
      "filtered install and all checks/build: no backend dependencies linked or stored",
    );
    const invalid = path.join(isolated, "web/check-regression.ts");
    await fs.writeFile(
      invalid,
      'export const invalid: number = "not a number";\n',
    );
    const typecheck = pnpm("typecheck:web");
    assert.notEqual(typecheck.status, 0);
    assert.match(
      typecheck.stdout + typecheck.stderr,
      /not assignable to type 'number'/,
    );
    t.diagnostic(
      `invalid TypeScript: exit ${typecheck.status}, expected number assignment error`,
    );
    await fs.writeFile(invalid, "debugger;\n");
    const lint = pnpm("lint:web");
    assert.notEqual(lint.status, 0);
    assert.match(lint.stdout + lint.stderr, /no-debugger/);
    t.diagnostic(
      `lint violation: exit ${lint.status}, expected no-debugger error`,
    );
    await fs.rm(invalid);
    await fs.appendFile(
      path.join(isolated, "web/api.test.ts"),
      '\ntest("existing client test regression", () => { assert.fail("client-regression-sentinel"); });\n',
    );
    const client = pnpm("test:web");
    assert.notEqual(client.status, 0);
    assert.match(client.stdout + client.stderr, /client-regression-sentinel/);
    t.diagnostic(
      `failure appended to existing web/api.test.ts: exit ${client.status}, expected client-regression-sentinel`,
    );
  },
);

test(
  "real Nginx serves releases and safely proxies API with a read-only filesystem",
  {
    skip: process.env.FRONTEND_RUNTIME_SMOKE !== "1",
    timeout: 180000,
  },
  async (t) => {
    const f = await fixture(t);
    const suffix = `${process.pid}-${Date.now()}`;
    const image = `entitle-runtime-smoke:${suffix}`;
    const network = `entitle-runtime-${suffix}`;
    const backend = `entitle-api-${suffix}`;
    const runtime = `entitle-web-${suffix}`;
    const ingress = `entitle-ingress-${suffix}`;
    const volume = `entitle-releases-${suffix}`;
    function docker(...args) {
      const result = spawnSync("docker", args, {
        encoding: "utf8",
        timeout: 120000,
      });
      assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
      return (result.stdout + (args[0] === "logs" ? result.stderr : "")).trim();
    }
    t.after(() => {
      spawnSync("docker", ["rm", "-f", runtime, backend, ingress]);
      spawnSync("docker", ["network", "rm", network]);
      spawnSync("docker", ["volume", "rm", volume]);
      spawnSync("docker", ["image", "rm", image]);
    });
    docker(
      "build",
      "-f",
      path.join(repo, "deploy/runtime.Dockerfile"),
      "-t",
      image,
      repo,
    );
    docker("network", "create", "--internal", network);
    docker("volume", "create", volume);
    const invalidConfigurations = [
      {
        title: "missing canonical host",
        env: ["ENTITLE_PUBLIC_HOST="],
        message: /ENTITLE_PUBLIC_HOST is required/,
      },
      {
        title: "multiline host",
        env: [
          "ENTITLE_PUBLIC_HOST=entitle.example\n;\nproxy_set_header X-Injected yes;\n#",
        ],
        message: /Invalid ENTITLE_PUBLIC_HOST/,
      },
      {
        title: "multiline upstream",
        env: [
          "ENTITLE_PUBLIC_HOST=entitle.example",
          "ENTITLE_API_UPSTREAM=entitle-api:3211\n;\n#",
        ],
        message: /Invalid ENTITLE_API_UPSTREAM/,
      },
    ];
    for (const cidrs of [
      "0.0.0.0/0; include /evil;",
      "localhost/32",
      "10.0.0.1",
      "999.0.0.1/32",
      "10.0.0.1/33",
      "::1/129",
      "::::/64",
      "10.0.0.1/32\nset_real_ip_from 0.0.0.0/0;",
      "10.0.0.1/32,",
    ]) {
      invalidConfigurations.push({
        title: `invalid trusted ingress ${JSON.stringify(cidrs)}`,
        env: [
          "ENTITLE_PUBLIC_HOST=entitle.example",
          `ENTITLE_TRUSTED_PROXY_CIDRS=${cidrs}`,
        ],
        message: /Invalid ENTITLE_TRUSTED_PROXY_CIDRS/,
      });
    }
    for (let i = 0; i < invalidConfigurations.length; i++) {
      const invalid = invalidConfigurations[i];
      await t.test(invalid.title, () => {
        const name = `${runtime}-invalid-${i}`;
        const result = spawnSync(
          "docker",
          [
            "run",
            "--rm",
            "--name",
            name,
            "--network",
            "none",
            "--read-only",
            "--tmpfs",
            "/runtime:uid=101,gid=101,mode=0700",
            "--tmpfs",
            "/cache:uid=101,gid=101,mode=0700",
            ...invalid.env.flatMap((entry) => ["-e", entry]),
            image,
          ],
          { encoding: "utf8", timeout: 2500 },
        );
        spawnSync("docker", ["rm", "-f", name]);
        assert.equal(
          result.status,
          1,
          `Configuration was not rejected: ${result.error ?? result.stderr}`,
        );
        assert.match(result.stderr, invalid.message);
      });
    }
    // Run publication on a Linux volume, as on the production host. Docker
    // Desktop's macOS bind filesystem returns EINVAL following replaced symlinks.
    function publish(...args) {
      return JSON.parse(
        docker(
          "run",
          "--rm",
          "--read-only",
          "--network",
          "none",
          "--mount",
          `type=bind,src=${tool},dst=/frontend-release.mjs,readonly`,
          "--mount",
          `type=bind,src=${f.dir},dst=/fixture,readonly`,
          "--mount",
          `type=volume,src=${volume},dst=/releases`,
          "--entrypoint",
          "node",
          "node:26.12.0-alpine",
          "/frontend-release.mjs",
          ...args,
        ),
      );
    }
    const promote = (release) =>
      publish(
        "activate",
        "--archive",
        `/fixture/${path.basename(release.archive)}`,
        "--sha256",
        release.sha256,
        "--root",
        "/releases",
      );
    const backendConfig = path.join(f.dir, "backend.conf");
    await fs.writeFile(
      backendConfig,
      `pid /runtime/nginx.pid;
error_log /dev/stderr notice; events {} http { access_log off;
client_body_temp_path /cache/client; proxy_temp_path /cache/proxy;
fastcgi_temp_path /cache/fastcgi; uwsgi_temp_path /cache/uwsgi; scgi_temp_path /cache/scgi;
server { listen 3211;
location = /api/echo { default_type application/json;
add_header Set-Cookie "seller_session=smoke; HttpOnly; Secure; SameSite=Lax";
return 200 '{"host":"$http_host","proto":"$http_x_forwarded_proto","forwarded":"$http_forwarded","xfh":"$http_x_forwarded_host","xff":"$http_x_forwarded_for","real":"$http_x_real_ip","origin":"$http_origin","cookie":"$http_cookie","authorization":"$http_authorization","uri":"$request_uri"}'; }
location / { default_type application/json; return 404 '{"error":"api_not_found"}'; }
} }`,
    );
    docker(
      "run",
      "-d",
      "--name",
      backend,
      "--network",
      network,
      "--network-alias",
      "entitle-api",
      "--read-only",
      "--tmpfs",
      "/runtime:uid=101,gid=101,mode=0700",
      "--tmpfs",
      "/cache:uid=101,gid=101,mode=0700",
      "--mount",
      `type=bind,src=${backendConfig},dst=/backend.conf,readonly`,
      "--entrypoint",
      "nginx",
      image,
      "-c",
      "/backend.conf",
      "-g",
      "daemon off;",
    );
    const a = f.pack();
    promote(a);
    function startRuntime(cidrs = "") {
      docker(
        "run",
        "-d",
        "--name",
        runtime,
        "--network",
        network,
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--tmpfs",
        "/runtime:uid=101,gid=101,mode=0700",
        "--tmpfs",
        "/cache:uid=101,gid=101,mode=0700",
        "--mount",
        `type=volume,src=${volume},dst=/releases,readonly`,
        "-e",
        "ENTITLE_PUBLIC_HOST=entitle.example",
        "-e",
        `ENTITLE_TRUSTED_PROXY_CIDRS=${cidrs}`,
        image,
      );
    }
    startRuntime();
    function request(
      uri,
      headers = [],
      host = "entitle.example",
      client = runtime,
      address = "http://127.0.0.1:8080",
    ) {
      const result = spawnSync(
        "docker",
        [
          "exec",
          client,
          "wget",
          "-S",
          "-O",
          "-",
          "--header",
          `Host: ${host}`,
          ...headers.flatMap((header) => ["--header", header]),
          `${address}${uri}`,
        ],
        { encoding: "utf8" },
      );
      const status = Number(result.stderr.match(/HTTP\/1\.1 (\d+)/)?.[1]);
      const parsed = Object.fromEntries(
        [...result.stderr.matchAll(/^\s+([A-Za-z-]+): (.*)$/gm)].map(
          (match) => [match[1].toLowerCase(), match[2].trim()],
        ),
      );
      return { status, headers: parsed, body: result.stdout };
    }
    let home;
    for (let i = 0; i < 30; i++) {
      home = request("/");
      if (home.status === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(home.status, 200, docker("logs", runtime));
    for (const uri of ["/", "/seller", "/t/example", "/docs", "/docs/"]) {
      const response = request(uri);
      assert.equal(response.status, 200, uri);
      assert.equal(response.body, "<html>release one</html>");
      assert.equal(response.headers["referrer-policy"], "no-referrer");
      assert.equal(response.headers["x-content-type-options"], "nosniff");
      assert.equal(response.headers["x-frame-options"], "SAMEORIGIN");
      assert.equal(
        response.headers["cross-origin-opener-policy"],
        "same-origin",
      );
      assert.equal(
        response.headers["cross-origin-resource-policy"],
        "same-origin",
      );
      assert.match(
        response.headers["strict-transport-security"],
        /max-age=31536000/,
      );
      assert.match(
        response.headers["content-security-policy"],
        /script-src 'self' https:\/\/js.stripe.com/,
      );
      assert.match(
        response.headers["content-security-policy"],
        /object-src 'none'/,
      );
      assert.match(
        response.headers["content-security-policy"],
        /upgrade-insecure-requests/,
      );
      assert.match(response.headers["cache-control"], /no-cache/);
    }
    assert.equal(request("/privacy.html").body, "privacy policy");
    assert.equal(request("/legal/THIRD-PARTY.txt").body, "third-party notices");
    assert.equal(request("/unknown-route").status, 404);
    assert.equal(request("/release-manifest.json").status, 404);
    assert.equal(request("/assets/missing.js").status, 404);
    assert.match(
      request("/assets/app-one.js").headers["cache-control"],
      /immutable/,
    );
    const api = request("/api/echo?query=retained", [
      "Origin: https://entitle.example",
      "Cookie: seller_session=smoke",
      "Authorization: Bearer smoke",
      "X-Forwarded-Host: attacker.example",
      "X-Forwarded-Proto: http",
      "Forwarded: host=attacker.example;proto=http",
      "X-Forwarded-For: 1.2.3.4",
    ]);
    assert.equal(
      api.status,
      200,
      `backend: ${docker("logs", backend)}\nruntime: ${docker("logs", runtime)}`,
    );
    const forwarded = JSON.parse(api.body);
    assert.equal(forwarded.host, "entitle.example");
    assert.equal(forwarded.xfh, "entitle.example");
    assert.equal(forwarded.proto, "https");
    assert.equal(forwarded.forwarded, "");
    assert.notEqual(forwarded.xff, "1.2.3.4");
    assert.equal(forwarded.origin, "https://entitle.example");
    assert.equal(forwarded.cookie, "seller_session=smoke");
    assert.equal(forwarded.authorization, "Bearer smoke");
    assert.equal(forwarded.uri, "/api/echo?query=retained");
    assert.equal(
      JSON.parse(request("/api/echo", [], "attacker.example").body).host,
      "entitle.example",
    );
    assert.match(api.headers["set-cookie"], /seller_session=smoke/);
    assert.equal(request("/api/missing").status, 404);
    assert.equal(request("/api").status, 404);
    const ingressConfig = path.join(f.dir, "ingress.conf");
    await fs.writeFile(
      ingressConfig,
      `pid /runtime/nginx.pid;
events {} http { access_log off; resolver 127.0.0.11 ipv6=off;
client_body_temp_path /cache/client; proxy_temp_path /cache/proxy;
fastcgi_temp_path /cache/fastcgi; uwsgi_temp_path /cache/uwsgi; scgi_temp_path /cache/scgi;
server { listen 8081; location / {
set $upstream "http://${runtime}:8080"; proxy_pass $upstream;
proxy_set_header X-Forwarded-For "$http_x_forwarded_for, $http_x_test_client_ip";
proxy_set_header X-Forwarded-Host attacker.example;
proxy_set_header X-Forwarded-Proto http;
proxy_set_header Forwarded "host=attacker.example;proto=http";
} } }`,
    );
    docker(
      "run",
      "-d",
      "--name",
      ingress,
      "--network",
      network,
      "--read-only",
      "--tmpfs",
      "/runtime:uid=101,gid=101,mode=0700",
      "--tmpfs",
      "/cache:uid=101,gid=101,mode=0700",
      "--mount",
      `type=bind,src=${ingressConfig},dst=/ingress.conf,readonly`,
      "--entrypoint",
      "nginx",
      image,
      "-c",
      "/ingress.conf",
      "-g",
      "daemon off;",
    );
    const ingressIp = docker(
      "inspect",
      "--format",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      ingress,
    );
    const throughIngress = (ip) =>
      request(
        "/api/echo",
        [`X-Test-Client-IP: ${ip}`, "X-Forwarded-For: 192.0.2.99"],
        "attacker.example",
        backend,
        `http://${ingress}:8081`,
      );
    // No configured trust: even the ingress cannot choose a client address.
    let untrusted;
    for (let i = 0; i < 30; i++) {
      untrusted = throughIngress("198.51.100.1");
      if (untrusted.status === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(untrusted.status, 200, docker("logs", ingress));
    assert.equal(JSON.parse(untrusted.body).xff, ingressIp);
    docker("rm", "-f", runtime);
    startRuntime(`${ingressIp}/32,::1/128`);
    for (let i = 0; i < 30 && request("/").status !== 200; i++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    for (const ip of ["198.51.100.1", "203.0.113.2", "2001:db8::23"]) {
      const response = throughIngress(ip);
      assert.equal(response.status, 200, response.body);
      const echo = JSON.parse(response.body);
      assert.equal(echo.xff, ip);
      assert.equal(echo.real, ip);
      assert.equal(echo.host, "entitle.example");
      assert.equal(echo.xfh, "entitle.example");
      assert.equal(echo.proto, "https");
      assert.equal(echo.forwarded, "");
      t.diagnostic(
        `trusted ingress -> runtime -> backend: XFF and X-Real-IP = ${ip}`,
      );
    }
    const recursive = throughIngress(`198.51.100.1, ${ingressIp}`);
    assert.equal(recursive.status, 200, recursive.body);
    assert.equal(JSON.parse(recursive.body).xff, "198.51.100.1");
    // A direct network client is outside the exact ingress /32, even with trust enabled.
    const direct = request(
      "/api/echo",
      ["X-Forwarded-For: 192.0.2.99", "X-Real-IP: 192.0.2.99"],
      "attacker.example",
      backend,
      `http://${runtime}:8080`,
    );
    const directIp = docker(
      "inspect",
      "--format",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      backend,
    );
    assert.equal(JSON.parse(direct.body).xff, directIp);
    assert.equal(JSON.parse(direct.body).real, directIp);
    t.diagnostic(
      `untrusted direct client: forged 192.0.2.99 ignored; backend received TCP peer ${directIp}`,
    );
    await fs.writeFile(
      path.join(f.input, "index.html"),
      "<html>release two</html>",
    );
    await fs.rm(path.join(f.input, "assets/app-one.js"));
    await fs.writeFile(
      path.join(f.input, "assets/app-two.js"),
      "console.log(2);",
    );
    const b = f.pack("two.tar");
    promote(b);
    const promoted = request("/");
    assert.equal(promoted.status, 200, JSON.stringify(promoted));
    assert.equal(
      promoted.body,
      "<html>release two</html>",
      JSON.stringify(promoted),
    );
    assert.equal(request("/assets/app-one.js").body, "console.log(1);");
    assert.equal(request("/assets/app-two.js").body, "console.log(2);");
    publish("rollback", "--root", "/releases", "--release", a.releaseId);
    assert.equal(request("/").body, "<html>release one</html>");
    request("/seller?token=must-not-appear-in-logs");
    request("/missing?token=must-not-appear-in-logs");
    assert.doesNotMatch(docker("logs", runtime), /must-not-appear-in-logs/);
    assert.equal(docker("exec", runtime, "id", "-u"), "101");
    assert.equal(
      docker(
        "inspect",
        "--format",
        "{{json .HostConfig.PortBindings}}",
        runtime,
      ),
      "{}",
    );
    const write = spawnSync("docker", [
      "exec",
      runtime,
      "touch",
      "/releases/write-must-fail",
    ]);
    assert.notEqual(write.status, 0);
  },
);

const pruneArgs = (root, ...extra) => [
  "prune",
  "--root",
  root,
  "--keep",
  "20",
  "--minimum-age-days",
  "30",
  "--apply",
  "false",
  ...extra,
];
async function retentionFixture(t, count = 24, retiredAsset = false) {
  const f = await fixture(t);
  const releases = [];
  for (let i = 0; i < count; i++) {
    if (retiredAsset && i === 0)
      await fs.writeFile(
        path.join(f.input, "assets/retired.js"),
        "retired asset",
      );
    if (retiredAsset && i === 1)
      await fs.unlink(path.join(f.input, "assets/retired.js"));
    await fs.writeFile(path.join(f.input, "index.html"), `release ${i}`);
    const release = f.pack(`release-${i}.tar`);
    f.activate(release);
    const date = new Date(Date.now() - (100 - i) * 86400000);
    await fs.utimes(
      path.join(f.root, "releases", release.releaseId),
      date,
      date,
    );
    releases.push(release.releaseId);
  }
  return { ...f, releases };
}

test("prune dry-run and apply preserve newest twenty, old current, recent and protected rollback releases", async (t) => {
  const f = await retentionFixture(t, 25);
  ok("rollback", "--root", f.root, "--release", f.releases[0]);
  const recent = path.join(f.root, "releases", f.releases[1]);
  await fs.utimes(recent, new Date(), new Date());
  const args = pruneArgs(f.root, "--protect-release", f.releases[2]);
  const plan = ok(...args);
  assert.equal(plan.dryRun, true);
  assert.deepEqual(plan.deleteReleases.sort(), f.releases.slice(3, 6).sort());
  assert.equal((await fs.readdir(path.join(f.root, "releases"))).length, 25);
  args[args.indexOf("--apply") + 1] = "true";
  const applied = ok(...args);
  assert.equal(applied.dryRun, false);
  assert.deepEqual(
    (await fs.readdir(path.join(f.root, "releases"))).sort(),
    f.releases.filter((_, i) => i !== 3 && i !== 4 && i !== 5).sort(),
  );
  assert.equal(
    await fs.readlink(path.join(f.root, "current")),
    `releases/${f.releases[0]}`,
  );
});

test("prune retains referenced assets and young orphans while removing old unreferenced assets", async (t) => {
  const f = await retentionFixture(t, 21, true);
  const pool = path.join(f.root, "shared/assets");
  const old = new Date(Date.now() - 90 * 86400000);
  for (const name of [
    "app-one.js",
    "orphan-old.js",
    "orphan-young.js",
    "retired.js",
  ]) {
    if (!["app-one.js", "retired.js"].includes(name))
      await fs.writeFile(path.join(pool, name), name);
    if (name !== "orphan-young.js")
      await fs.utimes(path.join(pool, name), old, old);
  }
  const args = pruneArgs(f.root);
  const planned = ok(...args);
  assert.deepEqual(planned.deleteAssets, ["orphan-old.js", "retired.js"]);
  assert.equal(
    await fs.readFile(path.join(pool, "orphan-old.js"), "utf8"),
    "orphan-old.js",
  );
  args[args.indexOf("--apply") + 1] = "true";
  ok(...args);
  assert.deepEqual((await fs.readdir(pool)).sort(), [
    "app-one.js",
    "orphan-young.js",
  ]);
});

test("prune refuses weak policy, missing protections and traversal before deleting anything", async (t) => {
  const f = await retentionFixture(t, 1);
  for (const [flag, value] of [
    ["--keep", "19"],
    ["--minimum-age-days", "29"],
    ["--apply", "yes"],
    ["--root", `${f.root}/../root`],
  ]) {
    const args = pruneArgs(f.root);
    args[args.indexOf(flag) + 1] = value;
    assert.equal(cli(...args).status, 1);
  }
  assert.equal(
    cli(...pruneArgs(f.root, "--protect-release", "../current")).status,
    1,
  );
  assert.equal(
    cli(...pruneArgs(f.root, "--protect-release", `${sha}-${"0".repeat(64)}`))
      .status,
    1,
  );
  assert.equal((await fs.readdir(path.join(f.root, "releases"))).length, 1);
});

test("prune fails closed on unsafe inventory before removing any candidate", async (t) => {
  const seed = await retentionFixture(t, 21);
  for (const sabotage of [
    "extra",
    "symlink",
    "manifest",
    "current",
    "asset",
    "missing-asset",
    "shared",
    "root-link",
    "empty-directory",
    "writable-root",
    "writable-asset",
    "writable-release-file",
    "corrupt-asset",
    "release-link",
  ]) {
    await t.test(sabotage, async (t) => {
      const f = { ...(await fixture(t)), releases: seed.releases };
      await fs.cp(seed.root, f.root, {
        recursive: true,
        verbatimSymlinks: true,
      });
      for (const id of f.releases) {
        const info = await fs.stat(path.join(seed.root, "releases", id));
        await fs.utimes(
          path.join(f.root, "releases", id),
          info.atime,
          info.mtime,
        );
      }
      assert.deepEqual(ok(...pruneArgs(f.root)).deleteReleases, [
        f.releases[0],
      ]);
      const release = path.join(f.root, "releases", f.releases[20]);
      let root = f.root;
      if (sabotage === "writable-root") await fs.chmod(f.root, 0o777);
      if (sabotage === "writable-asset")
        await fs.chmod(path.join(f.root, "shared/assets/app-one.js"), 0o666);
      if (sabotage === "writable-release-file")
        await fs.chmod(path.join(release, "index.html"), 0o666);
      if (sabotage === "release-link") {
        await fs.rm(release, { recursive: true });
        await fs.symlink(f.input, release);
      }
      if (sabotage === "corrupt-asset") {
        await fs.chmod(path.join(f.root, "shared/assets/app-one.js"), 0o644);
        await fs.writeFile(
          path.join(f.root, "shared/assets/app-one.js"),
          "corrupt",
        );
      }
      if (sabotage === "extra")
        await fs.writeFile(path.join(f.root, "unexpected"), "keep me");
      if (sabotage === "symlink")
        await fs.symlink(f.input, path.join(f.root, "releases/foreign"));
      if (sabotage === "manifest") {
        await fs.chmod(path.join(release, "release-manifest.json"), 0o644);
        await fs.writeFile(path.join(release, "release-manifest.json"), "{}");
      }
      if (sabotage === "empty-directory")
        await fs.mkdir(path.join(release, "unlisted"));
      if (sabotage === "current") {
        await fs.unlink(path.join(f.root, "current"));
        await fs.symlink(f.input, path.join(f.root, "current"));
      }
      if (sabotage === "asset")
        await fs.symlink(
          path.join(f.input, "index.html"),
          path.join(f.root, "shared/assets/evil.js"),
        );
      if (sabotage === "missing-asset")
        await fs.unlink(path.join(f.root, "shared/assets/app-one.js"));
      if (sabotage === "shared")
        await fs.writeFile(path.join(f.root, "shared/foreign"), "keep me");
      if (sabotage === "root-link") {
        root = path.join(f.dir, "root-link");
        await fs.symlink(f.root, root);
      }
      const args = pruneArgs(root);
      args[args.indexOf("--apply") + 1] = "true";
      assert.equal(cli(...args).status, 1);
      assert.equal(
        (await fs.readdir(path.join(f.root, "releases"))).includes(
          f.releases[0],
        ),
        true,
      );
    });
  }
});

test("prune refuses an occupied publication lock promptly and leaves it intact", async (t) => {
  const f = await retentionFixture(t, 1);
  const lock = path.join(f.root, ".frontend-release.lock");
  await fs.mkdir(lock);
  await fs.writeFile(
    path.join(lock, "owner.json"),
    JSON.stringify({ pid: process.pid }),
  );
  const result = spawnSync(process.execPath, [tool, ...pruneArgs(f.root)], {
    encoding: "utf8",
    timeout: 1500,
  });
  assert.equal(result.status, 1, `${result.error}`);
  assert.match(result.stderr, /lock/i);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(lock, "owner.json"))).pid,
    process.pid,
  );
});
