import test from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  mkdtemp,
  mkdir,
  writeFile,
  rename,
  rm,
  chmod,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const entry = new URL("../deploy/api-router-entrypoint.sh", import.meta.url);
test("router implementation is distributed with the immutable runtime", async () => {
  const script = await readFile(entry, "utf8");
  assert.match(script, /nginx -t/);
  const dockerfile = await readFile(
    new URL("../deploy/runtime.Dockerfile", import.meta.url),
    "utf8",
  );
  assert.match(dockerfile, /api-router-entrypoint.sh/);
});

test(
  "router cuts over real HTTP, rejects invalid state, and preserves the old route on failed readiness",
  { skip: process.env.API_ROUTER_SMOKE !== "1", timeout: 180000 },
  async (t) => {
    const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/router-");
    await chmod(root, 0o755);
    const suffix = `${process.pid}-${Date.now()}`;
    const image = `entitle-router-test:${suffix}`,
      network = `entitle-router-${suffix}`;
    const containers = [];
    const docker = (...args) => {
      const result = spawnSync("docker", args, {
        encoding: "utf8",
        timeout: 120000,
      });
      assert.equal(
        result.status,
        0,
        result.stderr +
          containers
            .map(
              (name) =>
                spawnSync("docker", ["logs", name], { encoding: "utf8" })
                  .stderr,
            )
            .join("\n"),
      );
      return result.stdout.trim();
    };
    t.after(async () => {
      for (const name of containers.reverse())
        spawnSync("docker", ["rm", "-f", name]);
      spawnSync("docker", ["network", "rm", network]);
      spawnSync("docker", ["image", "rm", image]);
      await rm(root, { recursive: true, force: true });
    });
    docker("build", "-f", "deploy/runtime.Dockerfile", "-t", image, ".");
    docker("network", "create", network);
    const writeSlot = async (slot) => {
      await writeFile(join(root, "active-slot.new"), `${slot}\n`, {
        mode: 0o644,
      });
      await rename(join(root, "active-slot.new"), join(root, "active-slot"));
    };
    await writeSlot("blue");
    await mkdir(join(root, "backend"));
    for (const slot of ["blue", "green"]) {
      const name = `entitle-${slot}-${suffix}`;
      const config = `pid /runtime/nginx.pid; error_log /dev/null crit; events {} http { access_log off; server { listen 3211; location = /slow { limit_rate 256; return 200 '${slot}-${"x".repeat(1024)}'; } location / { add_header X-Backend ${slot}; add_header X-Entitle-Server-Role api; add_header X-Entitle-Deployment-Slot ${slot}; return 200 '${slot}'; } } }`;
      await writeFile(join(root, "backend", `${slot}.conf`), config);
      docker(
        "run",
        "-d",
        "--name",
        name,
        "--network",
        network,
        "--network-alias",
        `entitle-api-${slot}`,
        "--tmpfs",
        "/runtime:uid=101,gid=101,mode=0700",
        "--mount",
        `type=bind,src=${root}/backend/${slot}.conf,dst=/backend.conf,readonly`,
        "--entrypoint",
        "nginx",
        image,
        "-c",
        "/backend.conf",
        "-g",
        "daemon off;",
      );
      containers.push(name);
    }
    const router = `entitle-router-${suffix}`;
    docker(
      "run",
      "-d",
      "--name",
      router,
      "--network",
      network,
      "-p",
      "127.0.0.1::3211",
      "--read-only",
      "--tmpfs",
      "/runtime:uid=101,gid=101,mode=0700",
      "--tmpfs",
      "/cache:uid=101,gid=101,mode=0700",
      "--mount",
      `type=bind,src=${root},dst=/routing,readonly`,
      "--entrypoint",
      "/usr/local/bin/entitle-api-router",
      image,
    );
    containers.push(router);
    const port = docker("port", router, "3211/tcp").split(":").at(-1);
    const url = `http://127.0.0.1:${port}/api/v1/ready`;
    const waitFor = async (slot) => {
      for (let i = 0; i < 100; i++) {
        const response = await fetch(url).catch(() => null);
        if (
          response?.ok &&
          response.headers.get("x-entitle-slot") === slot &&
          (await response.text()) === slot
        )
          return;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.fail(`router did not serve ${slot}`);
    };
    await waitFor("blue");
    const greenConfig = join(root, "backend", "green.conf");
    const validConfig = await readFile(greenConfig, "utf8");
    await writeFile(
      greenConfig,
      validConfig.replace(
        "X-Entitle-Server-Role api",
        "X-Entitle-Server-Role worker",
      ),
    );
    docker("restart", `entitle-green-${suffix}`);
    await writeSlot("green");
    await new Promise((r) => setTimeout(r, 1500));
    await waitFor("blue");
    await writeSlot("blue");
    await waitFor("blue");
    const inFlight = await fetch(`http://127.0.0.1:${port}/slow`);
    assert.equal(inFlight.headers.get("x-entitle-slot"), "blue");
    await writeFile(greenConfig, validConfig);
    docker("restart", `entitle-green-${suffix}`);
    await writeSlot("green");
    await waitFor("green");
    assert.equal(await inFlight.text(), `blue-${"x".repeat(1024)}`);
    await writeSlot("invalid; injected");
    await new Promise((r) => setTimeout(r, 1500));
    await waitFor("green");
    docker("stop", `entitle-blue-${suffix}`);
    await writeSlot("blue");
    await new Promise((r) => setTimeout(r, 1500));
    await waitFor("green");
  },
);
