import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, copyFile, rm, symlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Artifacts } from "../src/artifacts.ts";
import { VerifiedArtifactCache } from "../src/artifact-streams.ts";
import type { ArtifactStore } from "../src/storage.ts";
import { isolatedDatabase } from "./helpers/database.ts";
import { migrate } from "../src/db.ts";
import { primaryTenant } from "./helpers/tenant.ts";
import { verifyArtifact } from "../src/package-validation.ts";
import { zipBytes } from "./helpers/zip.ts";
async function fixture(t: import("node:test").TestContext) {
  const directory = await mkdtemp(
    "/Volumes/Scratch/double-entitle-wp/tmp/streaming-publication-",
  );
  const fixture = await isolatedDatabase("sqlite:" + directory + "/db");
  const { db } = fixture;
  await migrate(db);
  await db("products").insert({
    tenant_id: "primary",
    id: "p",
    slug: "app",
    name: "App",
    framework: "generic",
    framework_config: "{}",
  });
  const file = directory + "/upload";
  await writeFile(file, "native artifact");
  const stored = directory + "/stored";
  const store = {
    putFile: async (_t: string, _id: string, source: string) => {
      await copyFile(source, stored);
    },
    getToFile: async (
      _t: string,
      _id: string,
      _c: string,
      _s: number,
      destination: string,
    ) => {
      await copyFile(stored, destination);
    },
    delete: async () => rm(stored, { force: true }),
  } as unknown as ArtifactStore;
  const cache = new VerifiedArtifactCache({ directory: directory + "/cache" });
  const service = new Artifacts(
    db,
    store,
    primaryTenant,
    undefined,
    undefined,
    cache,
  );
  t.after(async () => {
    await cache.close();
    await fixture.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    service,
    db,
    store,
    file,
    directory,
    input: {
      product: "app",
      version: "1.0.0",
      file,
      target: "linux-x64",
      filename: "app.bin",
      changelog: "",
    },
  };
}
test("publication uses file store and independently verifies readback before database visibility", async (t) => {
  const f = await fixture(t);
  const { asset } = await f.service.publish(f.input);
  assert.equal(
    asset.checksum,
    createHash("sha256").update("native artifact").digest("hex"),
  );
  const response = await f.service.open(asset, 0, 5);
  const chunks = [];
  for await (const value of response.stream) chunks.push(value);
  assert.equal(Buffer.concat(chunks).toString(), "native");
  await assert.rejects(f.service.open({ ...asset, tenant_id: "other" }), {
    code: "not_found",
  });
  await assert.rejects(
    new Artifacts(f.db, f.store, primaryTenant).open(asset),
    { code: "artifact_cache_configuration" },
  );
});
test("corrupt file readback never commits and releases the reservation", async (t) => {
  const f = await fixture(t);
  f.store.getToFile = async (_t, _i, _c, _s, destination) => {
    await writeFile(destination, "broken content!");
  };
  await assert.rejects(f.service.publish(f.input), {
    code: "artifact_integrity",
  });
  assert.equal((await f.db("release_assets")).length, 0);
  assert.equal((await f.db("upload_reservations")).length, 0);
});
test("file validators inspect distant PE headers, DMG footer, ZIP and TAR without buffering the archive", async (t) => {
  const f = await fixture(t);
  const file = f.directory + "/formats";
  const pe = Buffer.alloc(2048);
  pe.write("MZ");
  pe.writeUInt32LE(1500, 60);
  pe.write("PE\0\0", 1500);
  for (const [filename, bytes] of [
    ["app.exe", pe],
    [
      "app.dmg",
      Buffer.concat([
        Buffer.alloc(1024),
        Buffer.from("koly"),
        Buffer.alloc(508),
      ]),
    ],
    ["app.zip", zipBytes([{ name: "app/file", data: "x" }])],
  ] as const) {
    await writeFile(file, bytes);
    await verifyArtifact(
      "electron",
      {},
      "1.0.0",
      { target: "darwin-arm64", filename, changelog: "" },
      file,
    );
  }
  await symlink(file, f.directory + "/link");
  const { hashArtifactFile } = await import("../src/artifact-streams.ts");
  await assert.rejects(hashArtifactFile(f.directory + "/link", 1));
});
test("file TAR validation handles source failure and expansion deadlines", async (t) => {
  const f = await fixture(t);
  const { Readable } = await import("node:stream");
  const fs = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const source = t.mock.method(
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
  try {
    await assert.rejects(
      verifyArtifact(
        "electron",
        {},
        "1.0.0",
        { target: "linux-x64", filename: "app.tar.gz", changelog: "" },
        f.file,
      ),
      { code: "invalid_package" },
    );
  } finally {
    source.mock.restore();
    syncBuiltinESMExports();
  }
  const stalled = t.mock.method(
    fs.default,
    "createReadStream",
    () => new Readable({ read() {} }),
  );
  syncBuiltinESMExports();
  const original = setTimeout;
  t.mock.method(globalThis, "setTimeout", ((callback: () => void) =>
    original(callback, 0)) as typeof setTimeout);
  try {
    await assert.rejects(
      verifyArtifact(
        "electron",
        {},
        "1.0.0",
        { target: "linux-x64", filename: "app.tar.gz", changelog: "" },
        f.file,
      ),
      { code: "invalid_package" },
    );
  } finally {
    stalled.mock.restore();
    syncBuiltinESMExports();
  }
});
test("ZIP validation enforces its deadline when archive iteration stalls", async (t) => {
  const f = await fixture(t);
  const yauzl = (await import("yauzl")).default;
  const source = zipBytes([{ name: "file", data: "x" }]);
  t.mock.method(yauzl.ZipFile.prototype, "readEntry", () => {});
  const original = setTimeout;
  t.mock.method(globalThis, "setTimeout", ((callback: () => void) =>
    original(callback, 0)) as typeof setTimeout);
  await assert.rejects(
    verifyArtifact(
      "electron",
      {},
      "1.0.0",
      { target: "darwin-arm64", filename: "app.zip", changelog: "" },
      source,
    ),
    { code: "invalid_package" },
  );
  void f;
});
test("publication cannot validate substituted bytes and then commit the original unvalidated archive", async (t) => {
  const f = await fixture(t),
    yauzl = (await import("yauzl")).default,
    fs = await import("node:fs");
  const bad = zipBytes([{ name: "../escape", data: "unsafe" }]),
    good = zipBytes([{ name: "safe.txt", data: "safe" }]);
  await writeFile(f.file, bad);
  const original = yauzl.open;
  const mock = t.mock.method(yauzl, "open", ((
    path: string,
    options: import("yauzl").Options,
    callback: (error: Error | null, zip: import("yauzl").ZipFile) => void,
  ) => {
    fs.writeFileSync(path, good);
    original(path, options, (error, zip) => {
      if (zip)
        zip.prependOnceListener("end", () => fs.writeFileSync(path, bad));
      callback(error, zip);
    });
  }) as unknown as typeof yauzl.open);
  try {
    await assert.rejects(
      f.service.publish({ ...f.input, filename: "app.zip" }),
      { code: "artifact_integrity" },
    );
    assert.equal((await f.db("release_assets")).length, 0);
  } finally {
    mock.mock.restore();
  }
});
test("publication reservation budgets scale beyond fifteen minutes for larger verified files", async (t) => {
  const f = await fixture(t),
    { open } = await import("node:fs/promises");
  const file = await open(f.file, "w");
  await file.truncate(32 * 1024 ** 2);
  await file.close();
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  const original = f.store.getToFile!;
  f.store.getToFile = async (...args) => {
    await original(...args);
    now += 900001;
  };
  const result = await f.service.publish(f.input);
  assert.equal(Number(result.asset.size), 32 * 1024 ** 2);
});
