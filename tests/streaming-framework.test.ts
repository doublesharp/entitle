import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import Fastify from "fastify";
import { frameworkRoutes } from "../src/framework-api.ts";
import { Artifacts } from "../src/artifacts.ts";
import { VerifiedArtifactCache } from "../src/artifact-streams.ts";
import { migrate } from "../src/db.ts";
import { AppError } from "../src/errors.ts";
import type { ArtifactStore } from "../src/storage.ts";
import type { TenantContextFor } from "../src/tenant-api.ts";
import { isolatedDatabase } from "./helpers/database.ts";
import { primaryTenant } from "./helpers/tenant.ts";
async function fixture(t: import("node:test").TestContext, streaming = true) {
  const directory = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/streaming-framework-",
  );
  const fixture = await isolatedDatabase("sqlite:" + directory + "/db");
  const { db } = fixture;
  await migrate(db);
  const bytes = Buffer.from("verified streaming bytes"),
    checksum = createHash("sha256").update(bytes).digest("hex");
  await db("products").insert({
    tenant_id: "primary",
    id: "p",
    slug: "app",
    name: "App",
    framework: "generic",
    framework_config: "{}",
  });
  const release = randomUUID(),
    id = randomUUID();
  await db("releases").insert({
    tenant_id: "primary",
    id: release,
    product_id: "p",
    version: "1.0.0",
    changelog: "",
    published_at: Date.now(),
    withdrawn: 0,
    checksum,
    size: bytes.length,
    min_wp: "",
    min_php: "",
    min_free: "",
    tested: "",
  });
  await db("release_assets").insert({
    tenant_id: "primary",
    id,
    release_id: release,
    target: "portable",
    filename: "app.bin",
    size: bytes.length,
    checksum,
    sha512: createHash("sha512").update(bytes).digest("base64"),
  });
  let reads = 0,
    enabled = true,
    corrupt = false;
  const admission: number[] = [],
    receipts: number[] = [];
  const store = {
    get: async () => {
      reads++;
      return corrupt ? Buffer.alloc(bytes.length) : bytes;
    },
    getToFile: async (
      _t: string,
      _i: string,
      _c: string,
      _s: number,
      file: string,
    ) => {
      reads++;
      await writeFile(file, corrupt ? Buffer.alloc(bytes.length) : bytes);
    },
  } as unknown as ArtifactStore;
  const cache = new VerifiedArtifactCache({ directory: directory + "/cache" }),
    artifacts = new Artifacts(
      db,
      store,
      primaryTenant,
      undefined,
      undefined,
      streaming ? cache : undefined,
    );
  const app = Fastify();
  let lastRequest: import("fastify").FastifyRequest | undefined;
  const context = ((req: import("fastify").FastifyRequest) => {
    lastRequest = req;
    return {
      db,
      tenant: primaryTenant,
      artifacts,
      licensing: {
        resolve: async () => ({ license: { product_id: "p" } }),
        effective: async (value: unknown) => value,
        entitled: () => enabled,
      },
    };
  }) as unknown as TenantContextFor;
  app.setErrorHandler((error, _req, reply) => {
    reply.code(error instanceof AppError ? error.status : 500).send({
      error: {
        code: error instanceof AppError ? error.code : "internal_error",
      },
    });
  });
  await frameworkRoutes(
    app,
    context,
    (_req, reply, _release, body, receipt) => {
      assert.ok(receipt);
      receipts.push(receipt.size);
      return reply.send(body);
    },
    (_req, _reply, size, receipt) => {
      assert.equal(receipt?.streaming, streaming);
      admission.push(size);
    },
  );
  t.after(async () => {
    await app.close();
    await cache.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    app,
    db,
    artifacts,
    id,
    release,
    bytes,
    admission,
    receipts,
    reads: () => reads,
    enable: (value: boolean) => {
      enabled = value;
    },
    corrupt: () => {
      corrupt = true;
    },
    lastRequest: () => lastRequest,
    url: `/packages/app/assets/${id}/app.bin`,
    headers: { authorization: "Bearer fixture" },
  };
}
test("streamed GET ranges are verified once, metered by range length, and HEAD authenticates without reading", async (t) => {
  const f = await fixture(t);
  const head = await f.app.inject({
    method: "HEAD",
    url: f.url,
    headers: f.headers,
  });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, "");
  assert.equal(f.reads(), 0);
  for (const [range, expected] of [
    ["bytes=0-7", "verified"],
    ["bytes=-5", "bytes"],
    ["bytes=9-", "streaming bytes"],
  ]) {
    const got = await f.app.inject({
      url: f.url,
      headers: { ...f.headers, range: range! },
    });
    assert.equal(got.statusCode, 206, got.body);
    assert.equal(got.body, expected);
  }
  assert.equal(f.reads(), 1);
  assert.deepEqual(f.receipts, [8, 5, 15]);
  assert.deepEqual(f.admission, f.receipts);
  for (const range of [
    "bytes=-0",
    "bytes=999-",
    "bytes=0-1,4-5",
    "bytes=9007199254740992-",
  ])
    assert.equal(
      (await f.app.inject({ url: f.url, headers: { ...f.headers, range } }))
        .statusCode,
      416,
    );
  f.enable(false);
  assert.equal(
    (await f.app.inject({ method: "HEAD", url: f.url, headers: f.headers }))
      .statusCode,
    403,
  );
  assert.equal(
    (await f.app.inject({ url: f.url, headers: f.headers })).statusCode,
    403,
  );
  f.enable(true);
  await f.db("releases").where({ id: f.release }).update({ withdrawn: 1 });
  assert.equal(
    (await f.app.inject({ url: f.url, headers: f.headers })).statusCode,
    404,
  );
  assert.equal(f.reads(), 1);
});
test("stream integrity failure exposes no attachment or range headers", async (t) => {
  const f = await fixture(t);
  f.corrupt();
  const got = await f.app.inject({
    url: f.url,
    headers: { ...f.headers, range: "bytes=0-7" },
  });
  assert.equal(got.statusCode, 503);
  assert.equal(got.headers["content-disposition"], undefined);
  assert.equal(got.headers["content-range"], undefined);
  assert.equal(got.headers["x-checksum-sha256"], undefined);
});
test("a request aborted during cache acquisition closes its stream lease", async (t) => {
  const f = await fixture(t);
  const original = f.artifacts.open.bind(f.artifacts);
  let stream: import("node:stream").Readable | undefined;
  t.mock.method(
    f.artifacts,
    "open",
    async (...args: Parameters<typeof original>) => {
      const result = await original(...args);
      stream = result.stream;
      f.lastRequest()!.raw.aborted = true;
      return result;
    },
  );
  await f.app.inject({ url: f.url, headers: f.headers });
  assert.equal(stream?.destroyed, true);
  if (stream && !stream.closed)
    await new Promise((resolve) => stream!.once("close", resolve));
});

test("legacy artifact stores still serve authenticated verified single ranges without a cache", async (t) => {
  const f = await fixture(t, false);
  const response = await f.app.inject({
    url: f.url,
    headers: { ...f.headers, range: "bytes=2-7" },
  });
  assert.equal(response.statusCode, 206, response.body);
  assert.deepEqual(response.rawPayload, f.bytes.subarray(2, 8));
  assert.deepEqual(f.admission, [f.bytes.length]);
  assert.deepEqual(f.receipts, [6]);
  assert.equal(f.reads(), 1);
});
