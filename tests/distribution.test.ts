import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { packageSource } from "../scripts/distribution.ts";

test("source distribution includes reviewed files and excludes private configuration and runtime data", async (t) => {
  const dir = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/distribution-",
  );
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = dir + "/source",
    out = dir + "/build/web";
  for (const d of ["scripts", "src", "examples"])
    await mkdir(root + "/" + d, { recursive: true });
  const files = [
    "ADDITIONAL-PERMISSION.md",
    "LICENSE",
    "NOTICE",
    "src/app.ts",
    "examples/LICENSE",
    "examples/GENERATED-CODE-LICENSE",
    "scripts/source-files.txt",
  ];
  for (const file of files)
    await writeFile(
      root + "/" + file,
      file === "scripts/source-files.txt"
        ? files.join("\n") + "\n"
        : "public source\n",
    );
  await writeFile(root + "/.env", "PRIVATE_SENTINEL");
  await writeFile(root + "/src/local.env", "PRIVATE_SENTINEL");
  await packageSource(root, out);
  const list = spawnSync("tar", ["-tzf", out + "/legal/source.tar.gz"], {
    encoding: "utf8",
  });
  assert.equal(list.status, 0);
  assert.deepEqual(list.stdout.trim().split("\n").sort(), files.sort());
  const data = spawnSync("tar", ["-xOzf", out + "/legal/source.tar.gz"], {
    encoding: "utf8",
  });
  assert.doesNotMatch(data.stdout, /PRIVATE_SENTINEL/);
  assert.equal(
    await readFile(out + "/legal/MIT.txt", "utf8"),
    "public source\n",
  );
  assert.equal(
    await readFile(out + "/legal/Elastic-2.0.txt", "utf8"),
    "public source\n",
  );
  assert.equal(
    await readFile(out + "/legal/ADDITIONAL-PERMISSION.txt", "utf8"),
    "public source\n",
  );
  assert.equal(
    await readFile(out + "/legal/0BSD.txt", "utf8"),
    "public source\n",
  );
  for (const bad of [
    "../.env",
    "/etc/passwd",
    ".env",
    "src/.env",
    "src/key.pem",
    "src/local.env",
    "src/../.env",
    "src/credentials.key",
    "src/app.ts\nsrc/app.ts",
  ]) {
    await writeFile(root + "/scripts/source-files.txt", bad + "\n");
    await assert.rejects(packageSource(root, out), /manifest/);
  }
  await symlink(root + "/.env", root + "/src/link.ts");
  await writeFile(root + "/scripts/source-files.txt", "src/link.ts\n");
  await assert.rejects(packageSource(root, out));
  await mkdir(dir + "/outside");
  await writeFile(dir + "/outside/private.ts", "PRIVATE_SENTINEL");
  await symlink(dir + "/outside", root + "/src/linked");
  await writeFile(
    root + "/scripts/source-files.txt",
    "src/linked/private.ts\n",
  );
  await assert.rejects(packageSource(root, out), /Symbolic links/);
});

test("real source manifest contains the complete reviewed tree and Docker supplies all root inputs", async () => {
  const { sourceFiles } = await import("../scripts/distribution.ts");
  const expected = (await readFile("scripts/source-files.txt", "utf8"))
    .trim()
    .split(/\r?\n/)
    .sort();
  assert.deepEqual(await sourceFiles(process.cwd()), expected);
  for (const path of [".github/CONTRIBUTING.md", "deploy/compose.yaml", "deploy/compose.test.yaml"])
    assert.ok(expected.includes(path), `Source archive omits relocated ${path}`);
  const docker = (await readFile("Dockerfile", "utf8")).split("\nFROM ")[0]!;
  const copied = docker
    .split("\n")
    .filter((l) => l.startsWith("COPY "))
    .flatMap((l) => l.slice(5).trim().split(/\s+/).slice(0, -1));
  for (const path of expected)
    assert.ok(copied.some((input) => input === path || path.startsWith(`${input}/`)), `Dockerfile does not supply ${path}`);
});

for (const status of [200, 503]) {
  test(`Docker healthcheck follows PORT and reports HTTP ${status} correctly`, async (t) => {
    const dockerfile = await readFile("Dockerfile", "utf8");
    const probe = /^HEALTHCHECK .* CMD node -e "([^"\n]+)"$/m.exec(
      dockerfile,
    )?.[1];
    assert.ok(probe, "Dockerfile must contain an executable Node healthcheck");
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      res.writeHead(status).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const child = spawn(process.execPath, ["-e", probe], {
      env: { ...process.env, PORT: String(address.port) },
      stdio: "ignore",
      timeout: 5000,
    });
    const [code] = await once(child, "exit");
    assert.deepEqual(
      requests,
      ["/api/v1/ready"],
      "probe must reach the configured application port",
    );
    assert.equal(code, status === 200 ? 0 : 1);
  });
}
