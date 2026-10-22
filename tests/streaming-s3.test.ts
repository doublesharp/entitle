import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, open, rm, readFile, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";
import { S3ArtifactStore } from "../src/storage.ts";
import {
  hashArtifactFile,
  VerifiedArtifactCache,
} from "../src/artifact-streams.ts";
const tenant = "primary",
  id = randomUUID();
const options = {
  bucket: "streaming-fixture",
  region: "us-east-1",
  endpoint: "http://127.0.0.1:1",
  allowInsecureLocalDevelopment: true,
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
  forcePathStyle: true,
  timeoutMs: 1000,
};
async function files(t: import("node:test").TestContext) {
  const directory = await mkdtemp(
    "/Volumes/Scratch/entitle/tmp/streaming-s3-",
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = directory + "/source";
  await writeFile(file, "artifact");
  const hash = await hashArtifactFile(file, 8);
  return { directory, file, ...hash };
}
test("S3 file writes pin digest, size, upload ceiling and immutable conditions", async (t) => {
  const f = await files(t);
  let seen = 0;
  t.mock.method(
    S3Client.prototype,
    "send",
    async (command: {
      input: { Body: Readable; IfNoneMatch: string; ContentLength: number };
    }) => {
      seen++;
      assert.equal(command.input.IfNoneMatch, "*");
      assert.equal(command.input.ContentLength, 8);
      let length = 0;
      for await (const value of command.input.Body) length += value.length;
      assert.equal(length, 8);
      return {};
    },
  );
  const store = new S3ArtifactStore(options);
  await store.putFile(tenant, id, f.file, f.checksum, 8);
  assert.equal(seen, 1);
  await assert.rejects(store.putFile(tenant, id, f.file, "0".repeat(64), 8), {
    code: "artifact_integrity",
  });
  await assert.rejects(
    new S3ArtifactStore({ ...options, maxNativeBytes: 7 }).putFile(
      tenant,
      id,
      f.file,
      f.checksum,
      8,
    ),
  );
  for (const maxNativeBytes of [0, NaN, Infinity, 2048 * 1024 ** 2 + 1])
    assert.throws(() => new S3ArtifactStore({ ...options, maxNativeBytes }));
});
test("S3 file reads reject truncation, oversize, digest mismatch and provider errors without leaving spools", async (t) => {
  const f = await files(t);
  const store = new S3ArtifactStore(options);
  let body = Buffer.from("artifact");
  let length: number | undefined = 8;
  const send = t.mock.method(S3Client.prototype, "send", async () => ({
    Body: Readable.from([body]),
    ContentLength: length,
  }));
  const destination = f.directory + "/download";
  await store.getToFile(tenant, id, f.checksum, 8, destination);
  assert.equal((await readFile(destination)).toString(), "artifact");
  await assert.rejects(store.getToFile(tenant, id, f.checksum, 8, destination));
  assert.equal((await readFile(destination)).toString(), "artifact");
  await rm(destination);
  for (const value of [
    Buffer.from("otherxxx"),
    Buffer.from("short"),
    Buffer.from("too long content"),
  ]) {
    body = value;
    length = undefined;
    await assert.rejects(
      store.getToFile(tenant, id, f.checksum, 8, destination),
      { code: "artifact_integrity" },
    );
    await assert.rejects(readFile(destination), { code: "ENOENT" });
  }
  length = 9;
  await assert.rejects(
    store.getToFile(tenant, id, f.checksum, 8, destination),
    { code: "artifact_integrity" },
  );
  send.mock.mockImplementation(async () => ({
    Body: {} as Readable,
    ContentLength: 8,
  }));
  await assert.rejects(
    store.getToFile(tenant, id, f.checksum, 8, destination),
    { code: "storage_unavailable" },
  );
});
test("S3 file upload and read deadlines destroy active streams and preserve immutable conflicts", async (t) => {
  const f = await files(t);
  const store = new S3ArtifactStore({ ...options, timeoutMs: 20 });
  const send = t.mock.method(S3Client.prototype, "send", async () => {
    throw { $metadata: { httpStatusCode: 412 } };
  });
  await assert.rejects(store.putFile(tenant, id, f.file, f.checksum, 8), {
    code: "artifact_exists",
  });
  const body = new Readable({ read() {} });
  send.mock.mockImplementation(async () => ({ Body: body }));
  await assert.rejects(
    store.getToFile(tenant, id, f.checksum, 8, f.directory + "/download"),
    { code: "storage_unavailable" },
  );
  assert.equal(body.destroyed, true);
  await assert.rejects(readFile(f.directory + "/download"), { code: "ENOENT" });
});
test(
  "local MinIO streams artifacts above the legacy 100 MiB ceiling with verified range cache",
  { skip: process.env.TEST_S3_INTEGRATION !== "true" },
  async (t) => {
    const endpoint = process.env.TEST_S3_ENDPOINT!;
    assert.ok(
      ["127.0.0.1", "localhost", "[::1]"].includes(new URL(endpoint).hostname),
    );
    const credentials = {
      accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY!,
    };
    const bucket = "entitle-stream-" + randomUUID();
    const client = new S3Client({
      endpoint,
      region: "us-east-1",
      credentials,
      forcePathStyle: true,
    });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    const store = new S3ArtifactStore({
      ...options,
      endpoint,
      credentials,
      bucket,
      maxNativeBytes: 102 * 1024 ** 2,
      timeoutMs: 3000,
    });
    const f = await files(t);
    const size = 101 * 1024 ** 2;
    const handle = await open(f.file, "w");
    await handle.truncate(size);
    await handle.write(Buffer.from("native-start"), 0, 12, 0);
    await handle.close();
    const { checksum } = await hashArtifactFile(f.file, size);
    t.after(async () => {
      await store.delete(tenant, id);
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
      client.destroy();
    });
    await store.putFile(tenant, id, f.file, checksum, size);
    await assert.rejects(store.putFile(tenant, id, f.file, checksum, size), {
      code: "artifact_exists",
    });
    const cache = new VerifiedArtifactCache({
      directory: f.directory + "/cache",
      maxBytes: 2 * size,
      maxInflightBytes: size,
    });
    t.after(() => cache.close());
    const a = await cache.open(
      store,
      { tenantId: tenant, id, checksum, size },
      0,
      11,
    );
    const chunks = [];
    for await (const value of a.stream) chunks.push(value);
    assert.equal(Buffer.concat(chunks).toString(), "native-start");
    // A cached request must succeed even with provider reads disabled.
    t.mock.method(store, "getToFile", async () => {
      throw Error("Unexpected provider read");
    });
    const b = await cache.open(
      store,
      { tenantId: tenant, id, checksum, size },
      size - 2,
      size - 1,
    );
    for await (const value of b.stream)
      assert.deepEqual(value, Buffer.alloc(2));
  },
);
test("S3 file reads respect caller cancellation before and during streaming", async (t) => {
  const f = await files(t);
  const store = new S3ArtifactStore(options);
  const controller = new AbortController();
  controller.abort();
  const send = t.mock.method(S3Client.prototype, "send", async () => ({
    Body: Readable.from([Buffer.from("artifact")]),
  }));
  await assert.rejects(
    store.getToFile(
      tenant,
      id,
      f.checksum,
      8,
      f.directory + "/cancelled",
      controller.signal,
    ),
    { code: "storage_unavailable" },
  );
  const active = new AbortController();
  let reading!: () => void;
  const began = new Promise<void>((resolve) => {
    reading = resolve;
  });
  send.mock.mockImplementation(async () => ({
    Body: new Readable({
      read() {
        reading();
      },
    }),
  }));
  const pending = store.getToFile(
    tenant,
    id,
    f.checksum,
    8,
    f.directory + "/cancelled",
    active.signal,
  );
  await began;
  active.abort();
  await assert.rejects(pending, { code: "storage_unavailable" });
});
test("S3 upload source failures destroy transfer streams", async (t) => {
  const f = await files(t);
  const fs = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const mock = t.mock.method(
    fs.default,
    "createReadStream",
    () =>
      new Readable({
        read() {
          this.destroy(Error("source failed"));
        },
      }),
  );
  syncBuiltinESMExports();
  t.mock.method(
    S3Client.prototype,
    "send",
    async (command: { input: { Body: Readable } }) => {
      for await (const chunk of command.input.Body) void chunk;
      return {};
    },
  );
  try {
    await assert.rejects(
      new S3ArtifactStore(options).putFile(tenant, id, f.file, f.checksum, 8),
      { code: "storage_unavailable" },
    );
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});
