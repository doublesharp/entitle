import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import {
  S3ArtifactStore,
  InMemoryArtifactStore,
  type ArtifactStore,
  type S3ArtifactStoreOptions,
} from "../src/storage.ts";
const tenant = "b8627a80-72d5-47d9-9156-0e788f693abc",
  release = "a2d3182f-39b9-4666-a44b-1fced71a8eed";
const data = Buffer.from("verified private plugin bytes");
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const checksum = digest(data);
const objects = new Map<string, Buffer>();
let status = 0,
  response: Buffer | undefined,
  requests = 0,
  stall = false,
  responseChunkBytes = 0,
  responseIntervalMs = 0;
const seen: {
  method: string;
  path: string;
  headers: import("node:http").IncomingHttpHeaders;
}[] = [];
const server = createServer(async (req, res) => {
  requests++;
  seen.push({ method: req.method!, path: req.url!, headers: req.headers });
  if (stall) return;
  if (status) {
    res.writeHead(status, { "Content-Type": "application/xml" });
    res.end(
      `<Error><Code>SecretFailure</Code><Message>credential-secret-url</Message></Error>`,
    );
    return;
  }
  const key = req.url!.split("?")[0]!;
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  if (req.method === "PUT") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    if (objects.has(key)) {
      res.writeHead(412);
      res.end();
      return;
    }
    objects.set(key, Buffer.concat(chunks));
    res.end();
    return;
  }
  if (req.method === "DELETE") {
    objects.delete(key);
    res.writeHead(204);
    res.end();
    return;
  }
  const body = response ?? objects.get(key);
  if (!body) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.setHeader("Content-Length", body.length);
  if (responseChunkBytes) {
    for (let offset = 0; offset < body.length; offset += responseChunkBytes) {
      if (res.destroyed) return;
      res.write(body.subarray(offset, offset + responseChunkBytes));
      await new Promise((resolve) => setTimeout(resolve, responseIntervalMs));
    }
    res.end();
    return;
  }
  res.end(body);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as import("node:net").AddressInfo;
const endpoint = `http://127.0.0.1:${address.port}`;
const options: S3ArtifactStoreOptions = {
  bucket: "private-artifacts",
  region: "us-east-1",
  endpoint,
  credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" },
  forcePathStyle: true,
  allowInsecureLocalDevelopment: true,
  timeoutMs: 1000,
};
after(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
);
beforeEach(() => {
  objects.clear();
  seen.length = 0;
  requests = 0;
  status = 0;
  response = undefined;
  stall = false;
  responseChunkBytes = 0;
  responseIntervalMs = 0;
});
for (const kind of ["s3", "memory"]) {
  const store: ArtifactStore =
    kind === "s3"
      ? new S3ArtifactStore(options)
      : new InMemoryArtifactStore(options);
  test(`${kind} stores immutable tenant artifacts and returns verified copies`, async () => {
    await store.ready();
    await store.put(tenant, release, data, checksum);
    const got = await store.get(tenant, release, checksum, data.length);
    assert.deepEqual(got, data);
    got.fill(0);
    assert.deepEqual(
      await store.get(tenant, release, checksum, data.length),
      data,
    );
    await assert.rejects(store.put(tenant, release, data, checksum), {
      code: "artifact_exists",
    });
    await assert.rejects(store.get("primary", release, checksum, data.length));
    await store.delete(tenant, release);
    await store.delete(tenant, release);
    await assert.rejects(store.get(tenant, release, checksum, data.length));
  });
  test(`${kind} rejects unsafe keys and invalid integrity metadata`, async () => {
    for (const value of [
      "../escape",
      "a/b",
      "a\\b",
      "x\0y",
      "",
      "tenant?x=1",
    ]) {
      await assert.rejects(store.put(value, release, data, checksum));
      await assert.rejects(store.get(tenant, value, checksum, data.length));
      await assert.rejects(store.delete(value, release));
    }
    await assert.rejects(store.put(tenant, release, data, "0".repeat(64)), {
      code: "artifact_integrity",
    });
    await assert.rejects(
      store.put(tenant, release, Buffer.alloc(0), digest(Buffer.alloc(0))),
    );
    for (const size of [-1, 0, NaN, Infinity, 100 * 1024 * 1024 + 1])
      await assert.rejects(store.get(tenant, release, checksum, size));
    await assert.rejects(store.get(tenant, release, "bad", data.length));
    await store.put(tenant, release, data, checksum);
    await assert.rejects(
      store.get(tenant, release, checksum, data.length + 1),
      { code: "artifact_integrity" },
    );
    await assert.rejects(
      store.get(tenant, release, "0".repeat(64), data.length),
      { code: "artifact_integrity" },
    );
  });
}
test("S3 uses private generated keys, SHA256 conditional uploads and signed requests", async () => {
  const store = new S3ArtifactStore(options);
  await store.put("primary", release, data, checksum);
  const request = seen[0]!;
  assert.equal(request.method, "PUT");
  assert.equal(
    request.path,
    "/private-artifacts/tenants/primary/releases/" +
      release +
      ".zip?x-id=PutObject",
  );
  assert.equal(request.headers["if-none-match"], "*");
  assert.equal(
    request.headers["x-amz-checksum-sha256"],
    Buffer.from(checksum, "hex").toString("base64"),
  );
  assert.equal(request.headers["x-amz-acl"], undefined);
  assert.match(request.headers.authorization!, /^AWS4-HMAC-SHA256/);
});
test("S3 rejects unsafe operator endpoint configuration and invalid caps", () => {
  for (const endpoint of [
    "http://example.com",
    "https://u:p@example.com",
    "https://example.com/?x=y",
    "https://example.com/#x",
    "ftp://example.com",
    "not-a-url",
  ])
    assert.throws(
      () =>
        new S3ArtifactStore({
          ...options,
          endpoint,
          allowInsecureLocalDevelopment: false,
        }),
    );
  for (const maxBytes of [0, -1, Infinity, NaN, 100 * 1024 * 1024 + 1])
    assert.throws(() => new S3ArtifactStore({ ...options, maxBytes }));
  for (const timeoutMs of [0, -1, Infinity, NaN])
    assert.throws(() => new S3ArtifactStore({ ...options, timeoutMs }));
  assert.throws(() => new S3ArtifactStore({ ...options, bucket: "" }));
});
test("S3 verifies download size and SHA256 before releasing bytes", async () => {
  const store = new S3ArtifactStore(options);
  await store.put(tenant, release, data, checksum);
  for (const bytes of [
    Buffer.from("wrong"),
    Buffer.alloc(data.length),
    Buffer.alloc(data.length + 1),
  ]) {
    response = bytes;
    await assert.rejects(store.get(tenant, release, checksum, data.length), {
      code: "artifact_integrity",
    });
  }
});
test("S3 limits uploads before making any network request", async () => {
  const store = new S3ArtifactStore({ ...options, maxBytes: 2 });
  await assert.rejects(store.put(tenant, release, data, checksum));
  assert.equal(requests, 0);
  await assert.rejects(
    store.get(tenant, release, checksum, 100 * 1024 * 1024 + 1),
  );
  assert.equal(requests, 0);
});
test("S3 readiness and operation failures expose safe generic errors", async () => {
  const store = new S3ArtifactStore(options);
  status = 403;
  for (const op of [
    () => store.ready(),
    () => store.put(tenant, release, data, checksum),
    () => store.get(tenant, release, checksum, data.length),
    () => store.delete(tenant, release),
  ])
    await assert.rejects(op(), {
      code: "storage_unavailable",
      message: "Artifact storage is unavailable.",
    });
});
test("S3 enforces finite request deadlines", async () => {
  const store = new S3ArtifactStore({ ...options, timeoutMs: 30 });
  stall = true;
  await assert.rejects(store.ready(), { code: "storage_unavailable" });
});
test("S3 rejects even empty query and fragment markers in endpoints", () => {
  for (const endpoint of ["https://example.com/?", "https://example.com/#"])
    assert.throws(() => new S3ArtifactStore({ ...options, endpoint }));
});

test("S3 supports ambient operator credentials and default endpoint settings without contacting AWS", async (t) => {
  t.mock.method(S3Client.prototype, "send", async () => ({}));
  const store = new S3ArtifactStore({
    bucket: "private-artifacts",
    region: "us-east-1",
  });
  await store.ready();
  new InMemoryArtifactStore();
});
test("S3 rejects HTTP in production even with the local-development override", () => {
  const previous = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    assert.throws(() => new S3ArtifactStore(options));
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
test("S3 rejects malformed response bodies and transport errors without provider metadata", async (t) => {
  const store = new S3ArtifactStore(options);
  const send = t.mock.method(S3Client.prototype, "send", async () => ({}));
  await assert.rejects(store.get(tenant, release, checksum, data.length), {
    code: "storage_unavailable",
  });
  send.mock.mockImplementation(async () => {
    throw Error("secret");
  });
  await assert.rejects(store.ready(), {
    code: "storage_unavailable",
    message: "Artifact storage is unavailable.",
  });
});
test("S3 bounds chunked downloads and rejects truncation before returning any bytes", async (t) => {
  const store = new S3ArtifactStore(options);
  const send = t.mock.method(S3Client.prototype, "send", async () => ({
    Body: Readable.from([data]),
  }));
  assert.deepEqual(
    await store.get(tenant, release, checksum, data.length),
    data,
  );
  for (const bytes of [
    Buffer.alloc(data.length + 1),
    Buffer.alloc(data.length - 1),
  ]) {
    send.mock.mockImplementation(async () => ({
      Body: Readable.from([bytes]),
    }));
    await assert.rejects(store.get(tenant, release, checksum, data.length), {
      code: "artifact_integrity",
    });
  }
});
test("S3 terminates stalled response streams at the idle deadline", async (t) => {
  const stream = new Readable({ read() {} });
  t.mock.method(S3Client.prototype, "send", async () => ({ Body: stream }));
  const store = new S3ArtifactStore({ ...options, timeoutMs: 30 });
  await assert.rejects(store.get(tenant, release, checksum, data.length), {
    code: "storage_unavailable",
  });
  assert.equal(stream.destroyed, true);
});

test("S3 normalizes non-Error transport rejections", async (t) => {
  const store = new S3ArtifactStore(options);
  const send = t.mock.method(S3Client.prototype, "send", async () => {
    throw null;
  });
  for (const failure of [null, undefined, "secret-provider-details", 42]) {
    send.mock.mockImplementation(async () => {
      throw failure;
    });
    await assert.rejects(store.ready(), {
      code: "storage_unavailable",
      message: "Artifact storage is unavailable.",
    });
  }
});

test("S3 permits active SDK downloads beyond the base timeout using a size-scaled budget", async () => {
  const bytes = Buffer.alloc(1024 * 1024, 7);
  response = bytes;
  responseChunkBytes = 32768;
  responseIntervalMs = 8;
  const store = new S3ArtifactStore({ ...options, timeoutMs: 100 });
  const start = Date.now();
  assert.deepEqual(
    await store.get(tenant, release, digest(bytes), bytes.length),
    bytes,
  );
  assert.ok(Date.now() - start > 100);
});
test("S3 permits uploads to finish beyond the base timeout within their size budget", async (t) => {
  const bytes = Buffer.alloc(256 * 1024, 7);
  t.mock.method(
    S3Client.prototype,
    "send",
    async (_command: unknown, request: { requestTimeout: number }) => {
      assert.equal(request.requestTimeout, 280);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {};
    },
  );
  const store = new S3ArtifactStore({ ...options, timeoutMs: 30 });
  await store.put(tenant, release, bytes, digest(bytes));
});
test("S3 maps conditional 409 to immutable conflict and leaves existing bytes unchanged", async () => {
  const store = new S3ArtifactStore(options);
  await store.put(tenant, release, data, checksum);
  status = 409;
  await assert.rejects(store.put(tenant, release, data, checksum), {
    status: 409,
    code: "artifact_exists",
  });
  status = 0;
  assert.deepEqual(
    await store.get(tenant, release, checksum, data.length),
    data,
  );
});
test("lowering upload limits preserves access to existing larger paid artifacts", async () => {
  const writer = new S3ArtifactStore(options);
  await writer.put(tenant, release, data, checksum);
  const reader = new S3ArtifactStore({ ...options, maxBytes: 2 });
  assert.deepEqual(
    await reader.get(tenant, release, checksum, data.length),
    data,
  );
});

test("S3 validates bounded transfer-rate configuration", () => {
  for (const minBytesPerSecond of [
    0,
    -1,
    NaN,
    Infinity,
    65535,
    64 * 1024 * 1024 + 1,
    65536.5,
  ])
    assert.throws(() => new S3ArtifactStore({ ...options, minBytesPerSecond }));
  new S3ArtifactStore({ ...options, minBytesPerSecond: 64 * 1024 });
});
test("S3 stops endless progress when the size-scaled total deadline expires", async (t) => {
  const bytes = Buffer.alloc(64 * 1024);
  let aborted: AbortSignal | undefined;
  const body = Readable.from(
    (async function* () {
      for (let offset = 0; offset < bytes.length; offset += 4096) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        yield bytes.subarray(offset, offset + 4096);
      }
    })(),
  );
  t.mock.method(
    S3Client.prototype,
    "send",
    async (_command: unknown, request: { abortSignal: AbortSignal }) => {
      aborted = request.abortSignal;
      return { Body: body };
    },
  );
  const store = new S3ArtifactStore({
    ...options,
    timeoutMs: 80,
    minBytesPerSecond: 4 * 1024 * 1024,
  });
  await assert.rejects(
    store.get(tenant, release, digest(bytes), bytes.length),
    { code: "storage_unavailable" },
  );
  assert.equal(aborted?.aborted, true);
  assert.equal(body.destroyed, true);
});
test("S3 times out stalled response headers even with a large transfer budget", async (t) => {
  t.mock.method(S3Client.prototype, "send", async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { Body: Readable.from([data]) };
  });
  const store = new S3ArtifactStore({ ...options, timeoutMs: 30 });
  await assert.rejects(store.get(tenant, release, checksum, 1024 * 1024), {
    code: "storage_unavailable",
  });
});
test("only conditional uploads convert 409 or 412 into an artifact conflict", async () => {
  const store = new S3ArtifactStore(options);
  for (const conflict of [409, 412]) {
    status = conflict;
    await assert.rejects(store.ready(), { code: "storage_unavailable" });
    await assert.rejects(store.delete(tenant, release), {
      code: "storage_unavailable",
    });
  }
});
test("memory read metadata uses the hard read ceiling after a lower upload cap", async () => {
  const store = new InMemoryArtifactStore({ maxBytes: 1 });
  await assert.rejects(store.get(tenant, release, checksum, data.length), {
    code: "storage_unavailable",
  });
});

test("S3 discards a late response body after the header deadline aborts", async (t) => {
  let reads = 0;
  const body = new Readable({
    read() {
      reads++;
    },
  });
  t.mock.method(S3Client.prototype, "send", async () => {
    await new Promise((resolve) => setTimeout(resolve, 70));
    return { Body: body };
  });
  const store = new S3ArtifactStore({ ...options, timeoutMs: 20 });
  await assert.rejects(store.get(tenant, release, checksum, 1024 * 1024), {
    code: "storage_unavailable",
  });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(reads, 0);
  assert.equal(body.destroyed, true);
});

test("S3 aborts a download that stops making progress after its first chunk", async (t) => {
  const body = Readable.from(
    (async function* () {
      yield Buffer.alloc(16384);
      await new Promise((resolve) => setTimeout(resolve, 100));
      yield Buffer.alloc(16384);
    })(),
  );
  t.mock.method(S3Client.prototype, "send", async () => ({ Body: body }));
  const store = new S3ArtifactStore({ ...options, timeoutMs: 30 });
  await assert.rejects(store.get(tenant, release, checksum, 1024 * 1024), {
    code: "storage_unavailable",
  });
  assert.equal(body.destroyed, true);
});

test("S3 retries one pre-header connection reset on idempotent reads", async (t) => {
  const attempts = new Map<string, number>();
  t.mock.method(
    S3Client.prototype,
    "send",
    async (command: { constructor: { name: string } }) => {
      const name = command.constructor.name,
        count = (attempts.get(name) ?? 0) + 1;
      attempts.set(name, count);
      if (count === 1)
        throw Object.assign(Error("provider closed keepalive socket"), {
          code: "ECONNRESET",
        });
      return name === "GetObjectCommand" ? { Body: Readable.from([data]) } : {};
    },
  );
  const store = new S3ArtifactStore(options);
  await store.ready();
  assert.deepEqual(
    await store.get(tenant, release, checksum, data.length),
    data,
  );
  assert.equal(attempts.get("HeadBucketCommand"), 2);
  assert.equal(attempts.get("GetObjectCommand"), 2);
});

test("S3 never retries reads more than once or replays writes after a reset", async (t) => {
  let attempts = 0;
  t.mock.method(S3Client.prototype, "send", async () => {
    attempts++;
    throw Object.assign(Error("reset"), { code: "ECONNRESET" });
  });
  const store = new S3ArtifactStore(options);
  for (const run of [
    () => store.ready(),
    () => store.get(tenant, release, checksum, data.length),
  ]) {
    attempts = 0;
    await assert.rejects(run(), { code: "storage_unavailable" });
    assert.equal(attempts, 2);
  }
  for (const run of [
    () => store.put(tenant, release, data, checksum),
    () => store.delete(tenant, release),
  ]) {
    attempts = 0;
    await assert.rejects(run(), { code: "storage_unavailable" });
    assert.equal(attempts, 1);
  }
});
test("S3 does not retry after read headers or after the operation aborts", async (t) => {
  let attempts = 0;
  const send = t.mock.method(S3Client.prototype, "send", async () => {
    attempts++;
    return {
      Body: new Readable({
        read() {
          this.destroy(
            Object.assign(Error("body reset"), { code: "ECONNRESET" }),
          );
        },
      }),
    };
  });
  const store = new S3ArtifactStore({ ...options, timeoutMs: 20 });
  await assert.rejects(store.get(tenant, release, checksum, data.length), {
    code: "storage_unavailable",
  });
  assert.equal(attempts, 1);
  attempts = 0;
  send.mock.mockImplementation(async () => {
    attempts++;
    await new Promise((resolve) => setTimeout(resolve, 40));
    throw Object.assign(Error("late reset"), { code: "ECONNRESET" });
  });
  await assert.rejects(store.ready(), { code: "storage_unavailable" });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(attempts, 1);
});
