import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { verifyZip } from "../src/releases.ts";
import { zipBytes, type ZipEntry } from "./helpers/zip.ts";
const root = await mkdtemp(
  "/Volumes/Scratch/entitle/tmp/zip-security-",
);
after(() => rm(root, { recursive: true, force: true }));
const plugin = {
  name: "product/product.php",
  data: "<?php\n/*\nPlugin Name: Product\nVersion: 1.0.0\n*/",
};
async function inspect(entries: ZipEntry[], maxBytes?: number) {
  const file = `${root}/input.zip`;
  await writeFile(file, zipBytes(entries));
  return verifyZip(file, "product/product.php", "1.0.0", maxBytes);
}
test("ZIP upload accepts configured byte cap and rejects excessive or invalid caps", async () => {
  await inspect([plugin], 1024);
  for (const limit of [1, 0, -1, NaN, Infinity, 100 * 1024 * 1024 + 1])
    await assert.rejects(inspect([plugin], limit));
});
test("ZIP rejects more than 2000 entries and expansion over 250 MiB", async () => {
  await assert.rejects(
    inspect([
      plugin,
      ...Array.from({ length: 2000 }, (_, n) => ({ name: `product/d${n}/` })),
    ]),
  );
  await assert.rejects(
    inspect([
      plugin,
      {
        name: "product/huge",
        data: "",
        method: 8,
        declaredSize: 251 * 1024 * 1024,
      },
    ]),
  );
});
test("ZIP rejects compression bombs while accepting ordinary small compressed PHP", async () => {
  await inspect([{ ...plugin, method: 8 }]);
  for (const size of [2048, 1024 * 1024]) {
    await assert.rejects(
      inspect([
        plugin,
        { name: "product/bomb", method: 8, data: "a".repeat(size) },
      ]),
    );
  }
});
test("ZIP rejects encrypted directories and Unix special files", async () => {
  for (const entry of [
    { name: "product/secret/", flags: 1 },
    ...[0xa000, 0x1000, 0x2000, 0x6000, 0xc000].map((mode) => ({
      name: "product/special",
      attributes: ((mode | 0o644) << 16) >>> 0,
      data: "x",
    })),
    {
      name: "product/not-directory/",
      attributes: ((0x8000 | 0o644) << 16) >>> 0,
    },
    { name: "product/not-file", attributes: ((0x4000 | 0o755) << 16) >>> 0 },
  ])
    await assert.rejects(inspect([plugin, entry]));
});
test("ZIP rejects unsafe paths, duplicates and corrupt CRC", async () => {
  for (const name of [
    "../outside",
    "/product/abs",
    "C:/product/drive",
    "product/../bad",
    "product/./bad",
    "product/a\\b",
    "product/a\0b",
    "product//bad",
  ])
    await assert.rejects(inspect([plugin, { name, data: "x" }]));
  await assert.rejects(inspect([plugin, plugin]));
  await assert.rejects(inspect([{ ...plugin, crc: 0 }]));
});
test("ZIP uses raw first 8 KiB headers and requires one configured plugin version", async () => {
  await inspect([
    {
      ...plugin,
      data: plugin.data + "\n<?php throw new Exception('NEVER EXECUTE');",
    },
  ]);
  await assert.rejects(
    inspect([{ ...plugin, data: " ".repeat(8192) + plugin.data }]),
  );
  await assert.rejects(
    inspect([{ ...plugin, data: plugin.data.replace("1.0.0", "2.0.0") }]),
  );
  await assert.rejects(
    inspect([plugin, { ...plugin, name: "product/other.php" }]),
  );
});
test("ZIP rejects directory entries carrying hidden data or a corrupt empty CRC", async () => {
  for (const entry of [
    { name: "product/hidden/", data: "hidden bytes" },
    { name: "product/bad-crc/", crc: 1 },
  ])
    await assert.rejects(inspect([plugin, entry]));
});

test("ZIP rejects names colliding after case folding or Unicode NFC normalization", async () => {
  for (const names of [
    ["product/A.txt", "product/a.txt"],
    ["product/caf\u00e9.txt", "product/cafe\u0301.txt"],
  ])
    await assert.rejects(
      inspect([
        plugin,
        ...names.map((name) => ({ name, data: "x", flags: 0x800 })),
      ]),
    );
});
test("ZIP rejects Windows-unsafe names and controls in every path segment", async () => {
  for (const name of [
    "product/a:b.txt",
    "product/control\t.txt",
    "product/a\u007f.txt",
    "product/a\u0085.txt",
    "product/file.",
    "product/file ",
    "product/dir./file",
    "product/dir /file",
    "product/CON",
    "product/nul.txt",
    "product/AUX/file",
    "product/LPT1.txt",
    "product/com9.bin",
    "product/COM\u00b9.txt",
    "product/CONIN$",
    "product/CONOUT$.txt",
    "product/NUL .txt",
  ])
    await assert.rejects(inspect([plugin, { name, data: "x", flags: 0x800 }]));
});
test("ZIP permits portable Unicode names and mixed-case assets while binding plugin case exactly", async () => {
  await inspect([
    plugin,
    { name: "product/ReadMe.TXT", data: "hello" },
    { name: "product/caf\u00e9.txt", data: "hello", flags: 0x800 },
  ]);
  await assert.rejects(inspect([{ ...plugin, name: "product/Product.php" }]));
});
