import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { primaryTenant } from "./helpers/tenant.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import type { Readable } from "node:stream";
import yauzl from "yauzl";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { createDb, migrate, reset } from "../src/db.ts";
import { Releases, type Publication } from "../src/releases.ts";
import { zipBytes, type ZipEntry } from "./helpers/zip.ts";
const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/releases-");
const db = createDb(`sqlite:${root}/db`);
class FixtureStore extends InMemoryArtifactStore {
  readonly ids = new Set<string>();
  override async put(
    tenantId: string,
    releaseId: string,
    bytes: Buffer,
    checksum: string,
  ) {
    await super.put(tenantId, releaseId, bytes, checksum);
    this.ids.add(releaseId);
  }
  override async delete(tenantId: string, releaseId: string) {
    await super.delete(tenantId, releaseId);
    this.ids.delete(releaseId);
  }
  async replace(releaseId: string, bytes: Buffer) {
    await this.delete(primaryTenant.id, releaseId);
    await this.put(
      primaryTenant.id,
      releaseId,
      bytes,
      createHash("sha256").update(bytes).digest("hex"),
    );
  }
}
const store = new FixtureStore();
const releases = new Releases(db, store, primaryTenant, `${root}/artifacts`);
before(async () => {
  await migrate(db);
});
after(async () => {
  await db.destroy();
  await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await reset(db);
  for (const id of store.ids) await store.delete(primaryTenant.id, id);
  await rm(`${root}/artifacts`, { recursive: true, force: true });
  await db("products").insert({
    tenant_id: "primary",
    id: "product",
    slug: "product",
    name: "Product",
  });
});
async function input(
  entries: ZipEntry[] = [
    {
      name: "product/product.php",
      data: "<?php\n/*\nPlugin Name: Product\nVersion: 1.0.0\n*/",
    },
  ],
  version = "1.0.0",
): Promise<Publication> {
  const file = `${root}/input.zip`;
  await writeFile(file, zipBytes(entries));
  return {
    product: "product",
    version,
    file,
    changelog: "Release",
    minWp: "6.0",
    minPhp: "8.0",
    minFree: "0.0.0",
    tested: "7.0",
  };
}
async function noPublishedArtifact() {
  assert.equal((await db("releases")).length, 0);
  assert.equal(store.ids.size, 0);
  assert.equal((await db("upload_reservations")).length, 0);
  assert.deepEqual(await readdir(`${root}/artifacts`).catch(() => []), []);
}
test("ZIP open callback failures reject publication and remove the copied artifact", async (t) => {
  const publication = await input();
  for (const failure of [new Error("reader unavailable"), null]) {
    await t.test(
      failure ? "reader error" : "missing archive result",
      async (t) => {
        t.mock.method(
          yauzl,
          "open",
          (
            _file: string,
            _options: yauzl.Options,
            callback: (error: Error | null, zip?: yauzl.ZipFile) => void,
          ) => callback(failure),
        );
        await assert.rejects(releases.publish(publication), {
          status: 400,
          code: "invalid_zip",
          message: "ZIP integrity or safety validation failed.",
        });
        await noPublishedArtifact();
      },
    );
  }
});
test("a missing entry stream closes the real archive and cannot publish an unchecked release", async (t) => {
  const publication = await input();
  let archive: yauzl.ZipFile | undefined;
  // Fault injection at the reader boundary: retain actual ZIP parsing and
  // resource ownership, but violate the callback's promised stream result.
  t.mock.method(
    yauzl.ZipFile.prototype,
    "openReadStream",
    function (
      this: yauzl.ZipFile,
      _entry: yauzl.Entry,
      callback: (error: Error | null, stream?: Readable) => void,
    ) {
      archive = this;
      callback(null);
    },
  );
  await assert.rejects(releases.publish(publication), {
    status: 400,
    code: "invalid_zip",
    message: "ZIP integrity or safety validation failed.",
  });
  assert.ok(archive);
  assert.equal(archive.isOpen, false);
  await noPublishedArtifact();
});
test("empty, corrupt and unsafe ZIPs never publish metadata or retain partial artifacts", async () => {
  const archives = [
    zipBytes([]),
    Buffer.alloc(0),
    Buffer.from("not a zip"),
    zipBytes([{ name: "../escape.php", data: "bad" }]),
    zipBytes([{ name: "/absolute.php", data: "bad" }]),
    zipBytes([{ name: "C:\\escape.php", data: "bad" }]),
    zipBytes([
      { name: "product/same.php", data: "first" },
      { name: "product/same.php", data: "last" },
    ]),
    zipBytes([
      {
        name: "product/link.php",
        attributes: (0xa1ff << 16) >>> 0,
        data: "../outside",
      },
    ]),
    zipBytes([{ name: "product/bad-crc.php", data: "actual", crc: 0 }]),
    zipBytes([{ name: "product/encrypted.php", data: "secret", flags: 1 }]),
    zipBytes([
      { name: "product/unsupported-compression.php", data: "data", method: 99 },
    ]),
    zipBytes([
      {
        name: "product/broken-deflate.php",
        method: 8,
        data: "expected",
        compressed: Buffer.from([0xff, 0xff]),
      },
    ]),
    zipBytes([{ name: "product/file.php", data: "data" }], true),
    zipBytes([
      {
        name: "product/oversized.php",
        method: 8,
        declaredSize: 251 * 1024 * 1024,
        data: "small",
      },
    ]),
    zipBytes(
      Array.from({ length: 2001 }, (_, n) => ({
        name: `product/folder${n}/`,
      })),
    ),
  ];
  const publication = await input();
  for (const archive of archives) {
    await writeFile(publication.file, archive);
    await assert.rejects(
      releases.publish(publication),
      (error) =>
        error instanceof Error &&
        (archive.length === 0
          ? "code" in error && error.code === "upload_limit"
          : error.message === "ZIP integrity or safety validation failed."),
    );
    await noPublishedArtifact();
  }
});
test("valid nested directories and compressed entries publish and verify with semantic version ordering", async () => {
  const publication = await input([
    { name: "product/" },
    { name: "product/assets/" },
    {
      name: "product/assets/file.php",
      method: 8,
      data: '<?php echo "release";',
    },
    {
      name: "product/product.php",
      method: 8,
      data: "<?php\n/*\nPlugin Name: Product\nVersion: 1.0.0\n*/",
    },
  ]);
  const first = await releases.publish(publication);
  assert.deepEqual(
    await releases.read(first),
    await readFile(publication.file),
  );
  const next = await releases.publish(
    await input(
      [
        {
          name: "product/product.php",
          data: "<?php\n/*\nPlugin Name: Product\nVersion: 1.10.0\n*/",
        },
      ],
      "1.10.0",
    ),
  );
  await releases.publish(
    await input(
      [
        {
          name: "product/product.php",
          data: "<?php\n/*\nPlugin Name: Product\nVersion: 1.2.0\n*/",
        },
      ],
      "1.2.0",
    ),
  );
  assert.equal((await releases.latest("product"))!.id, next.id);
  await releases.withdraw(next.id);
  assert.equal((await releases.latest("product"))!.version, "1.2.0");
  assert.equal((await releases.read(next)).length, Number(next.size));
});
test("concurrent duplicate publication creates one immutable artifact and reports a conflict for the loser", async () => {
  const publication = await input();
  const result = await Promise.allSettled([
    releases.publish(publication),
    releases.publish(publication),
  ]);
  assert.equal(result.filter((r) => r.status === "fulfilled").length, 1);
  const failed = result.find((r) => r.status === "rejected");
  assert.ok(failed && failed.status === "rejected");
  assert.equal(failed.reason.status, 409);
  assert.equal((await db("releases")).length, 1);
  assert.equal(store.ids.size, 1);
  assert.deepEqual(await readdir(`${root}/artifacts`), []);
});
test("a database failure without a provider error code removes the verified artifact and preserves the failure", async () => {
  const publication = await input();
  const rejectInsert = (query: { sql: string }) => {
    if (query.sql.startsWith("insert into `releases`"))
      throw new Error("Database connection unavailable");
  };
  db.on("query", rejectInsert);
  try {
    await assert.rejects(
      releases.publish(publication),
      /Database connection unavailable/,
    );
  } finally {
    db.off("query", rejectInsert);
  }
  await noPublishedArtifact();
});
test("publication validation and missing source files do not expose private paths or create releases", async () => {
  const publication = await input();
  await assert.rejects(
    releases.publish({ ...publication, minPhp: "invalid" }),
    /Compatibility versions/,
  );
  await assert.rejects(
    releases.publish({ ...publication, product: "missing" }),
    /Product not found/,
  );
  await assert.rejects(
    releases.publish({ ...publication, file: `${root}/missing.zip` }),
    /ENOENT/,
  );
  await assert.rejects(releases.withdraw("missing"), /Release not found/);
  await assert.rejects(
    store.get(primaryTenant.id, "../../secret", "0".repeat(64), 1),
    /Invalid artifact identifier/,
  );
  await noPublishedArtifact();
});
test("a changed or truncated stored artifact is rejected before any download bytes can be returned", async () => {
  const publication = await input();
  const release = await releases.publish(publication);
  const bytes = await releases.read(release);
  const changed = Buffer.from(bytes);
  changed[30] = changed[30]! ^ 1;
  await store.replace(release.id, changed);
  await assert.rejects(releases.read(release), /integrity verification/);
  await store.replace(release.id, bytes.subarray(0, 10));
  await assert.rejects(releases.read(release), /integrity verification/);
  await store.replace(release.id, bytes);
  assert.deepEqual(await releases.read(release), bytes);
});

const bootstrap =
  "<?php\n/**\n * Plugin Name: Product\n * Version: 1.0.0\n */\n";
test("publication rejects plugin identity and header mismatches before exposing metadata", async (t) => {
  const cases: [string, ZipEntry[]][] = [
    ["different plugin", [{ name: "other/other.php", data: bootstrap }]],
    ["different root PHP", [{ name: "product/other.php", data: bootstrap }]],
    [
      "extra top-level file",
      [
        { name: "product/product.php", data: bootstrap },
        { name: "readme.txt", data: "outside" },
      ],
    ],
    [
      "extra plugin directory",
      [
        { name: "product/product.php", data: bootstrap },
        { name: "other/asset.txt" },
      ],
    ],
    [
      "dot alias",
      [
        { name: "product/product.php", data: bootstrap },
        {
          name: "product/./product.php",
          data: bootstrap.replace("1.0.0", "9.0.0"),
        },
      ],
    ],
    [
      "empty segment alias",
      [
        { name: "product/product.php", data: bootstrap },
        {
          name: "product//product.php",
          data: bootstrap.replace("1.0.0", "9.0.0"),
        },
      ],
    ],
    [
      "encrypted directory",
      [
        { name: "product/product.php", data: bootstrap },
        { name: "product/assets/", flags: 1 },
      ],
    ],
    [
      "nul path",
      [
        { name: "product/product.php", data: bootstrap },
        { name: "product/asset\0.txt", data: "bad" },
      ],
    ],
    [
      "parent path",
      [
        { name: "product/product.php", data: bootstrap },
        { name: "product/../outside", data: "bad" },
      ],
    ],
    [
      "missing header",
      [{ name: "product/product.php", data: "<?php echo 'hello';" }],
    ],
    [
      "empty plugin name",
      [
        {
          name: "product/product.php",
          data: bootstrap.replace("Product", "  "),
        },
      ],
    ],
    [
      "missing version",
      [
        {
          name: "product/product.php",
          data: bootstrap.replace(" * Version: 1.0.0\n", ""),
        },
      ],
    ],
    [
      "wrong version",
      [
        {
          name: "product/product.php",
          data: bootstrap.replace("1.0.0", "1.1.0"),
        },
      ],
    ],
    [
      "version prefix",
      [
        {
          name: "product/product.php",
          data: bootstrap.replace("1.0.0", "v1.0.0"),
        },
      ],
    ],
    [
      "second root plugin",
      [
        { name: "product/product.php", data: bootstrap },
        { name: "product/second.php", data: bootstrap },
      ],
    ],
    [
      "late header",
      [
        {
          name: "product/product.php",
          data: "<?php\n" + " ".repeat(8192) + bootstrap,
        },
      ],
    ],
    [
      "unanchored header",
      [
        {
          name: "product/product.php",
          data: "<?php\n/* prose Plugin Name: Fake\nVersion: 1.0.0\n*/",
        },
      ],
    ],
  ];
  for (const [name, entries] of cases)
    await t.test(name, async () => {
      await assert.rejects(releases.publish(await input(entries)), {
        status: 400,
        code: "invalid_zip",
      });
      await noPublishedArtifact();
    });
});
test("publication accepts WordPress comment prefixes, nested assets and only bounded initial PHP headers", async () => {
  for (const [n, source] of [
    "<?php\r/*\rPlugin Name: Product */\r/* Version: VERSION */",
    "<?php\n// Plugin Name: Product\n# Version: VERSION",
    "<?php\n/**\n * @Plugin Name: Product\n * @Version: VERSION\n */",
    bootstrap.replace("1.0.0", "VERSION") + "x".repeat(200000),
    bootstrap.replace("1.0.0", "VERSION") +
      `\n$x = "escaped \\" quote";\n$x = 'escaped \\' quote';\n$x = \`\n/* Plugin Name: Fake */\n\`;`,
  ].entries()) {
    const version = `1.0.${n}`;
    await releases.publish(
      await input(
        [
          {
            name: "product/product.php",
            data: source.replace("VERSION", version),
            method: n === 3 ? 0 : 8,
          },
          { name: "product/library.php", data: "<?php // ordinary helper" },
          { name: "product/vendor/nested.php", data: bootstrap },
        ],
        version,
      ),
    );
  }
  assert.equal((await db("releases")).length, 5);
});
test("an explicit product basename controls publication even when the catalog slug differs", async () => {
  await db("products")
    .where({ id: "product" })
    .update({ plugin_basename: "installed/bootstrap.php" });
  await assert.rejects(releases.publish(await input()), {
    code: "invalid_zip",
  });
  await noPublishedArtifact();
  const release = await releases.publish(
    await input([{ name: "installed/bootstrap.php", data: bootstrap }]),
  );
  assert.equal(release.product_id, "product");
});

test("publication rechecks product identity under the catalog lock before inserting release metadata", async (t) => {
  const publication = await input();
  const original = yauzl.open;
  t.mock.method(
    yauzl,
    "open",
    (
      file: string,
      options: yauzl.Options,
      callback: (error: Error | null, zip?: yauzl.ZipFile) => void,
    ) => {
      void db("products")
        .where({ id: "product" })
        .update({ plugin_basename: "changed/main.php" })
        .then(() => original(file, options, callback));
    },
  );
  await assert.rejects(releases.publish(publication), {
    status: 409,
    code: "plugin_identity_changed",
  });
  await noPublishedArtifact();
});

test("publication follows actual WordPress raw header parsing for inline PHP and quoted/template content", async () => {
  const valid = [
    "<?php /* Plugin Name: Product */\n/* Version: 1.0.0 */",
    "<?php // Plugin Name: Product\n// Version: 1.0.0",
    "A visitor's text before PHP\n<?php\n/*\nPlugin Name: Product\nVersion: 1.0.0\n*/",
    "<? /* Plugin Name: Product */\n/* Version: 1.0.0 */",
    `<?php\n$x = "\n/*\nPlugin Name: Product\nVersion: 1.0.0\n*/";`,
    `<?php\n$x = '\n/*\nPlugin Name: Product\nVersion: 1.0.0\n*/';`,
    `<?php\n$x = <<<TEXT\n/*\nPlugin Name: Product\nVersion: 1.0.0\n*/\nTEXT;`,
    `<?php\n$x = <<<'TEXT'\n/*\nPlugin Name: Product\nVersion: 1.0.0\n*/\nTEXT;`,
  ];
  for (const data of valid) {
    const publication = await input([{ name: "product/product.php", data }]);
    const release = await releases.publish(publication);
    assert.equal(release.version, "1.0.0");
    await db("releases").delete();
    await store.delete(primaryTenant.id, release.id);
  }
});

test("publication rejects a version or second plugin header that WordPress sees inside strings and templates", async () => {
  const bootstrap = "<?php\n/*\nPlugin Name: Product\nVersion: 1.0.0\n*/";
  for (const entries of [
    [
      {
        name: "product/product.php",
        data: '<?php\n$x="\nVersion: 0.9.0\n";\n' + bootstrap,
      },
    ],
    [
      { name: "product/product.php", data: bootstrap },
      {
        name: "product/loader.php",
        data: "<?php\n$x=<<<'CODE'\n/*\n * Plugin Name: Loader\n * Version: 1.0.0\n */\nCODE;",
      },
    ],
    [{ name: "product/product.php", data: bootstrap.replace("Product", "0") }],
    [
      {
        name: "product/product.php",
        data: bootstrap.replace("Product", "\0\v "),
      },
    ],
    [
      {
        name: "product/product.php",
        data: bootstrap.replace("1.0.0", "1.0.0\u2028ignored-by-js-dot"),
      },
    ],
    [
      {
        name: "product/product.php",
        data: bootstrap.replace("1.0.0", "1.0.0\u00a0"),
      },
    ],
  ]) {
    await assert.rejects(releases.publish(await input(entries)), {
      status: 400,
      code: "invalid_zip",
    });
    await noPublishedArtifact();
  }
});
