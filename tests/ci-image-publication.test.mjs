import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

// Optional local integration with the real Buildx client and a disposable, in-memory
// OCI registry. No daemon, external registry, credentials, or production writes.
test(
  "real Buildx publication preserves both single-manifest and index digests",
  {
    skip: process.env.CI_BUILDX_SMOKE !== "1",
    timeout: 30000,
  },
  async (t) => {
    const digest = (bytes) =>
      `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    const manifestType = "application/vnd.oci.image.manifest.v1+json";
    const indexType = "application/vnd.oci.image.index.v1+json";
    const config = Buffer.from(
      JSON.stringify({
        architecture: "amd64",
        os: "linux",
        config: {},
        rootfs: { type: "layers", diff_ids: [] },
      }),
    );
    const manifest = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: manifestType,
        config: {
          mediaType: "application/vnd.oci.image.config.v1+json",
          digest: digest(config),
          size: config.length,
        },
        layers: [],
      }),
    );
    const index = Buffer.from(
      JSON.stringify({
        schemaVersion: 2,
        mediaType: indexType,
        manifests: [
          {
            mediaType: manifestType,
            digest: digest(manifest),
            size: manifest.length,
            platform: { architecture: "amd64", os: "linux" },
          },
        ],
      }),
    );
    const manifests = new Map([
      [digest(manifest), manifest],
      [digest(index), index],
    ]);
    const server = createServer(async (req, res) => {
      res.setHeader("Docker-Distribution-Api-Version", "registry/2.0");
      if (req.url === "/v2/") {
        res.end("{}");
        return;
      }
      const reference = req.url.match(/^\/v2\/ci\/manifests\/(.+)$/)?.[1];
      if (reference && req.method === "PUT") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        manifests.set(reference, bytes);
        res.setHeader("Docker-Content-Digest", digest(bytes));
        res.writeHead(201).end();
        return;
      }
      const bytes =
        manifests.get(reference) ??
        (req.url === `/v2/ci/blobs/${digest(config)}` ? config : undefined);
      if (!bytes) {
        res.writeHead(404).end("{}");
        return;
      }
      res.setHeader(
        "Content-Type",
        reference ? JSON.parse(bytes).mediaType : "application/octet-stream",
      );
      res.setHeader("Content-Length", bytes.length);
      res.setHeader("Docker-Content-Digest", digest(bytes));
      res.end(req.method === "HEAD" ? undefined : bytes);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/ci-buildx-");
    t.after(() => rm(root, { recursive: true, force: true }));
    const workflow = await readFile(
      new URL("../.github/workflows/ci.yml", import.meta.url),
      "utf8",
    );
    const publish = workflow
      .split("- name: Publish qualified tags")[1]
      .match(/run: \|\n((?:          .*\n|\n)+)/)[1]
      .replace(/^          /gm, "");
    for (const original of [manifest, index]) {
      const selected = digest(original);
      const env = {
        ...process.env,
        IMAGE: `127.0.0.1:${server.address().port}/ci`,
        DIGEST: selected,
        SOURCE_SHA: "b".repeat(40),
        INPUT_HASH: "c".repeat(64),
      };
      const child = spawn("bash", ["-c", publish], {
        cwd: root,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
      });
      child.stderr.on("data", (chunk) => {
        output += chunk;
      });
      const status = await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("close", resolve);
      });
      assert.equal(status, 0, output);
      assert.equal(
        (await readFile(join(root, "server-digest.txt"), "utf8")).trim(),
        selected,
      );
      for (const tag of [
        `source-${env.SOURCE_SHA}`,
        `input-${env.INPUT_HASH}`,
      ]) {
        assert.equal(digest(manifests.get(tag)), selected);
      }
    }
  },
);
