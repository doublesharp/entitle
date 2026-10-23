#!/usr/bin/env node
// Standalone Node CLI. Archives are uncompressed USTAR, not gzip or arbitrary tar.
// Limits: 10,000 files, 64 MiB/file, 192 MiB payload, 256 MiB archive.
// A single host account must own root and its ancestors. Do not share writable
// release storage with the runtime or untrusted users. The mkdir lock serializes
// activate/rollback/prune. Publication waits up to 60 seconds; prune refuses
// an occupied lock immediately; a crash leaves it fail-closed. An operator
// may remove .frontend-release.lock only after checking owner.json and confirming
// that its process is no longer running. Never remove a live process's lock.
import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const MiB = 1024 * 1024;
const MAX_FILE = 64 * MiB;
const MAX_TOTAL = 192 * MiB;
const MAX_ARCHIVE = 256 * MiB;
const MAX_FILES = 10000;
const MANIFEST = "release-manifest.json";
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const RELEASE = /^[a-f0-9]{40}-[a-f0-9]{64}$/;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const fail = (message) => {
  throw new Error(message);
};
const exists = (name) =>
  fs.lstat(name).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });

function safePath(name) {
  if (
    typeof name !== "string" ||
    name.length > 240 ||
    !name
      .split("/")
      .every((segment) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment))
  ) {
    fail("Unsafe release path");
  }
  if (name === MANIFEST || name.startsWith(`${MANIFEST}/`))
    fail("Reserved manifest path");
  return name;
}

async function readRegular(name, limit) {
  const handle = await fs.open(
    name,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > limit)
      fail("Unsafe file or size limit exceeded");
    const bytes = await handle.readFile();
    if (bytes.length !== info.size || bytes.length > limit)
      fail("File changed while reading");
    return bytes;
  } finally {
    await handle.close();
  }
}

async function walk(dir, prefix = "") {
  const info = await fs.lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink())
    fail("Unsafe release directory");
  const files = [];
  for (const name of (await fs.readdir(dir)).sort(compare)) {
    const relative = prefix ? `${prefix}/${name}` : name;
    safePath(relative);
    const child = path.join(dir, name);
    const entry = await fs.lstat(child);
    if (entry.isSymbolicLink()) fail("Symlinks are forbidden");
    if (entry.isDirectory()) files.push(...(await walk(child, relative)));
    else if (entry.isFile() && entry.nlink === 1) files.push(relative);
    else fail("Only regular files with one link are allowed");
    if (files.length > MAX_FILES) fail("File count limit exceeded");
  }
  return files.sort(compare);
}

function makeManifest(sourceSha, files) {
  if (!SHA.test(sourceSha))
    fail("source-sha must be 40 lowercase hexadecimal characters");
  const provenance = { schemaVersion: 1, sourceSha, files };
  const releaseId = `${sourceSha}-${hash(JSON.stringify(provenance))}`;
  return { schemaVersion: 1, releaseId, sourceSha, files };
}
const manifestBytes = (manifest) =>
  Buffer.from(`${JSON.stringify(manifest)}\n`);

function parseManifest(bytes) {
  if (bytes.length > 4 * MiB) fail("Manifest size limit exceeded");
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (
    manifest?.schemaVersion !== 1 ||
    !SHA.test(manifest.sourceSha) ||
    !Array.isArray(manifest.files) ||
    !manifest.files.length ||
    manifest.files.length > MAX_FILES
  ) {
    fail("Invalid manifest schema");
  }
  let total = 0;
  let previous = "";
  for (const file of manifest.files) {
    safePath(file.path);
    if (
      compare(previous, file.path) >= 0 ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_FILE ||
      !DIGEST.test(file.sha256) ||
      Object.keys(file).join(",") !== "path,size,sha256"
    )
      fail("Invalid manifest file");
    previous = file.path;
    total += file.size;
    if (total > MAX_TOTAL) fail("Expanded size limit exceeded");
  }
  if (!manifest.files.some((file) => file.path === "index.html"))
    fail("index.html is required");
  const expected = makeManifest(manifest.sourceSha, manifest.files);
  if (!bytes.equals(manifestBytes(expected)))
    fail("Noncanonical or inconsistent manifest provenance");
  return expected;
}

function writeTar(entries) {
  const parts = [];
  for (const [name, bytes] of entries) {
    const header = Buffer.alloc(512);
    let short = name;
    if (name.length > 100) {
      const split = name.lastIndexOf("/", 155);
      if (split < 0 || name.length - split - 1 > 100)
        fail("Path too long for USTAR");
      header.write(name.slice(0, split), 345, 155, "ascii");
      short = name.slice(split + 1);
    }
    header.write(short, 0, 100, "ascii");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(bytes.length.toString(8).padStart(11, "0") + "\0", 124);
    header.write("00000000000\0", 136);
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    header.write(
      header
        .reduce((sum, value) => sum + value, 0)
        .toString(8)
        .padStart(6, "0") + "\0 ",
      148,
    );
    parts.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  const result = Buffer.concat([...parts, Buffer.alloc(1024)]);
  if (result.length > MAX_ARCHIVE) fail("Archive size limit exceeded");
  return result;
}

function tarString(bytes) {
  const end = bytes.indexOf(0);
  if (end >= 0 && bytes.subarray(end).some((byte) => byte !== 0))
    fail("Ambiguous tar header");
  const value = end < 0 ? bytes : bytes.subarray(0, end);
  if (value.some((byte) => byte < 32 || byte > 126))
    fail("Non-ASCII tar header");
  return value.toString("ascii");
}
function octal(bytes) {
  // latin1 preserves high bits instead of silently masking them as ASCII does.
  const value = bytes.toString("latin1");
  if (!/^[0-7]+[\0 ]*$/.test(value)) fail("Invalid tar numeric field");
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) fail("Tar size overflow");
  return number;
}

function parseTar(bytes) {
  if (bytes.length > MAX_ARCHIVE || bytes.length % 512 !== 0)
    fail("Invalid archive size");
  const entries = new Map();
  let offset = 0;
  let total = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (
        bytes.length - offset < 1024 ||
        bytes.subarray(offset).some((byte) => byte !== 0)
      )
        fail("Invalid tar trailer");
      return entries;
    }
    const checksum = octal(header.subarray(148, 156));
    const sum = header.reduce(
      (value, byte, index) => value + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (sum !== checksum) fail("Tar header checksum mismatch");
    if (
      !header.subarray(257, 263).equals(Buffer.from("ustar\0")) ||
      !header.subarray(263, 265).equals(Buffer.from("00")) ||
      header[156] !== 48 ||
      header.subarray(157, 257).some((byte) => byte !== 0) ||
      header.subarray(500).some((byte) => byte !== 0)
    )
      fail("Only regular USTAR files are allowed");
    if (octal(header.subarray(100, 108)) & 0o7000) fail("Unsafe tar mode");
    // Validate ignored metadata too; no malformed field is allowed to hide
    // behind the fact that extraction deliberately discards ownership/mtime.
    octal(header.subarray(108, 116));
    octal(header.subarray(116, 124));
    octal(header.subarray(136, 148));
    tarString(header.subarray(265, 297));
    tarString(header.subarray(297, 329));
    for (const field of [
      header.subarray(329, 337),
      header.subarray(337, 345),
    ]) {
      if (field.some((byte) => byte !== 0) && octal(field) !== 0) {
        fail("Unexpected tar device metadata");
      }
    }
    const prefix = tarString(header.subarray(345, 500));
    const short = tarString(header.subarray(0, 100));
    const name = prefix ? `${prefix}/${short}` : short;
    if (name !== MANIFEST) {
      if (!name.startsWith("web/")) fail("Unexpected tar path");
      safePath(name.slice(4));
    }
    if (entries.has(name) || entries.size >= MAX_FILES + 1)
      fail("Duplicate entry or file count limit exceeded");
    const size = octal(header.subarray(124, 136));
    total += size;
    if (
      size > (name === MANIFEST ? 4 * MiB : MAX_FILE) ||
      total > MAX_TOTAL + 4 * MiB
    )
      fail("Expanded size limit exceeded");
    const start = offset + 512;
    const end = start + size;
    offset = start + Math.ceil(size / 512) * 512;
    if (
      offset > bytes.length ||
      bytes.subarray(end, offset).some((byte) => byte !== 0)
    )
      fail("Truncated file or invalid padding");
    entries.set(name, bytes.subarray(start, end));
  }
  fail("Missing tar trailer");
}

async function verify(archive, sha256) {
  if (!DIGEST.test(sha256))
    fail("sha256 must be 64 lowercase hexadecimal characters");
  const bytes = await readRegular(archive, MAX_ARCHIVE);
  if (hash(bytes) !== sha256) fail("Archive SHA-256 mismatch");
  const entries = parseTar(bytes);
  if (!entries.has(MANIFEST)) fail("Missing release manifest");
  const manifest = parseManifest(entries.get(MANIFEST));
  if (entries.size !== manifest.files.length + 1)
    fail("Unlisted archive entries");
  for (const file of manifest.files) {
    const data = entries.get(`web/${file.path}`);
    if (!data || data.length !== file.size || hash(data) !== file.sha256)
      fail("File checksum mismatch");
    // A regular file cannot also be the parent of another file.
    const segments = file.path.split("/");
    while (segments.length > 1) {
      segments.pop();
      if (entries.has(`web/${segments.join("/")}`))
        fail("Conflicting archive paths");
    }
  }
  return { manifest, entries };
}

async function pack(input, output, sourceSha) {
  const files = [];
  const entries = [];
  let total = 0;
  for (const name of await walk(input)) {
    const bytes = await readRegular(path.join(input, name), MAX_FILE);
    total += bytes.length;
    if (total > MAX_TOTAL) fail("Expanded size limit exceeded");
    files.push({ path: name, size: bytes.length, sha256: hash(bytes) });
    entries.push([`web/${name}`, bytes]);
  }
  const manifest = makeManifest(sourceSha, files);
  parseManifest(manifestBytes(manifest));
  const archive = writeTar([[MANIFEST, manifestBytes(manifest)], ...entries]);
  // Exclusive creation preserves an already published artifact.
  await fs.writeFile(output, archive, { flag: "wx", mode: 0o644 });
  return {
    archive: path.resolve(output),
    sha256: hash(archive),
    releaseId: manifest.releaseId,
    sourceSha,
  };
}

async function directory(name) {
  await fs.mkdir(name).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const info = await fs.lstat(name);
  if (!info.isDirectory() || info.isSymbolicLink())
    fail("Unsafe storage directory");
}
async function parents(base, relative) {
  let current = base;
  for (const segment of relative.split("/").slice(0, -1)) {
    current = path.join(current, segment);
    await directory(current);
  }
}
async function withLock(root, operation, wait = true) {
  await fs.mkdir(root, { recursive: true });
  await directory(root);
  const lock = path.join(root, ".frontend-release.lock");
  const deadline = Date.now() + 60000;
  while (true) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!wait || Date.now() >= deadline)
        fail(
          "Release lock timed out; inspect .frontend-release.lock/owner.json",
        );
      await delay(100);
    }
  }
  try {
    await fs.writeFile(
      path.join(lock, "owner.json"),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      { flag: "wx" },
    );
    return await operation();
  } finally {
    await fs.rm(lock, { recursive: true });
  }
}

async function checkRelease(dir, expectedId) {
  const info = await fs.lstat(dir);
  if (!info.isDirectory() || info.isSymbolicLink())
    fail("Unsafe release directory");
  const manifest = parseManifest(
    await readRegular(path.join(dir, MANIFEST), 4 * MiB),
  );
  if (manifest.releaseId !== expectedId) fail("Release identity mismatch");
  // Walk also rejects symlinks and unlisted files; the manifest is a reserved path.
  async function checkTree(base, prefix = "") {
    const found = [];
    for (const name of await fs.readdir(base)) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const info = await fs.lstat(path.join(base, name));
      if (info.isDirectory() && !info.isSymbolicLink())
        found.push(...(await checkTree(path.join(base, name), relative)));
      else if (info.isFile() && info.nlink === 1) found.push(relative);
      else fail("Unsafe stored release entry");
      if (found.length > MAX_FILES + 1)
        fail("Stored file count limit exceeded");
    }
    return found;
  }
  const found = (await checkTree(dir)).sort(compare);
  const listed = [MANIFEST, ...manifest.files.map((file) => file.path)].sort(
    compare,
  );
  if (JSON.stringify(found) !== JSON.stringify(listed))
    fail("Stored release has unlisted files");
  for (const file of manifest.files) {
    const bytes = await readRegular(path.join(dir, file.path), MAX_FILE);
    if (bytes.length !== file.size || hash(bytes) !== file.sha256)
      fail("Stored release checksum mismatch");
  }
  return manifest;
}

async function checkAssets(root, manifest, releaseDir, publish) {
  const shared = path.join(root, "shared");
  await directory(shared);
  const pool = path.join(shared, "assets");
  await directory(pool);
  for (const file of manifest.files.filter((entry) =>
    entry.path.startsWith("assets/"),
  )) {
    const name = file.path.slice(7);
    await parents(pool, name);
    const target = path.join(pool, name);
    const existing = await exists(target);
    if (existing) {
      const bytes = await readRegular(target, MAX_FILE);
      if (bytes.length !== file.size || hash(bytes) !== file.sha256)
        fail(`Immutable asset collision: ${name}`);
    } else if (publish) {
      const bytes = await readRegular(
        path.join(releaseDir, file.path),
        MAX_FILE,
      );
      if (bytes.length !== file.size || hash(bytes) !== file.sha256)
        fail("Asset source checksum mismatch");
      // Publish with an atomic no-replace link. Partial writes never occupy a
      // permanent asset URL, even if the process crashes. No archive hardlinks
      // are accepted and the temporary hardlink is removed before proceeding.
      const temporary = path.join(pool, `.asset-${randomUUID()}`);
      try {
        await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o444 });
        await fs.link(temporary, target);
      } finally {
        await fs.rm(temporary, { force: true });
      }
    }
  }
}

async function swap(root, releaseId) {
  const current = path.join(root, "current");
  const info = await exists(current);
  if (info && !info.isSymbolicLink()) fail("current must be a symlink");
  const temporary = path.join(root, `.current-${randomUUID()}`);
  try {
    await fs.symlink(`releases/${releaseId}`, temporary);
    await fs.rename(temporary, current);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function activate(archive, sha256, root) {
  // All archive validation precedes extraction, storage writes and lock creation.
  const { manifest, entries } = await verify(archive, sha256);
  return withLock(root, async () => {
    const releases = path.join(root, "releases");
    await directory(releases);
    const target = path.join(releases, manifest.releaseId);
    await checkAssets(root, manifest, target, false);
    if (await exists(target)) await checkRelease(target, manifest.releaseId);
    else {
      const stage = path.join(releases, `.stage-${randomUUID()}`);
      await fs.mkdir(stage);
      try {
        await fs.writeFile(
          path.join(stage, MANIFEST),
          manifestBytes(manifest),
          { flag: "wx", mode: 0o444 },
        );
        for (const file of manifest.files) {
          await parents(stage, file.path);
          await fs.writeFile(
            path.join(stage, file.path),
            entries.get(`web/${file.path}`),
            { flag: "wx", mode: 0o444 },
          );
        }
        await checkRelease(stage, manifest.releaseId);
        await fs.rename(stage, target);
      } finally {
        await fs.rm(stage, { recursive: true, force: true });
      }
    }
    await checkAssets(root, manifest, target, true);
    await swap(root, manifest.releaseId);
    return {
      releaseId: manifest.releaseId,
      sourceSha: manifest.sourceSha,
      sha256,
    };
  });
}

async function rollback(root, releaseId) {
  if (!RELEASE.test(releaseId)) fail("Invalid release ID");
  return withLock(root, async () => {
    await directory(path.join(root, "releases"));
    const target = path.join(root, "releases", releaseId);
    const manifest = await checkRelease(target, releaseId);
    await checkAssets(root, manifest, target, false);
    await checkAssets(root, manifest, target, true);
    await swap(root, releaseId);
    return { releaseId, sourceSha: manifest.sourceSha };
  });
}

// Pruning accepts only an existing, private publication tree. In particular it
// must never create a root merely because an operator misspelled its path.
async function pruneRoot(root) {
  if (!path.isAbsolute(root) || path.normalize(root) !== root || root === "/")
    fail("Unsafe prune root");
  let current = "/";
  for (const segment of root.split("/").filter(Boolean)) {
    current = path.join(current, segment);
    const info = await fs.lstat(current);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.uid !== 0 && info.uid !== process.getuid()) ||
      info.mode & 0o022
    )
      fail("Unsafe prune root ancestry");
  }
  const info = await fs.lstat(root);
  if (info.uid !== process.getuid())
    fail("Prune root must be owned by publisher");
}

async function prune(root, keep, minimumAgeDays, apply, protectedIds) {
  const integer = (value, minimum, maximum) =>
    /^[1-9][0-9]*$/.test(value) &&
    Number.isSafeInteger(Number(value)) &&
    Number(value) >= minimum &&
    Number(value) <= maximum;
  if (
    !integer(keep, 20, MAX_FILES) ||
    !integer(minimumAgeDays, 30, 36500) ||
    !["true", "false"].includes(apply)
  )
    fail("Invalid prune policy or apply flag");
  if (
    protectedIds.length > MAX_FILES ||
    protectedIds.some((id) => !RELEASE.test(id))
  )
    fail("Invalid protected release IDs");
  await pruneRoot(root);
  return withLock(
    root,
    async () => {
      await pruneRoot(root);
      const entries = (await fs.readdir(root)).sort(compare);
      if (
        JSON.stringify(entries) !==
        JSON.stringify([
          ".frontend-release.lock",
          "current",
          "releases",
          "shared",
        ])
      )
        fail("Unexpected publication root entries");
      async function storedDirectory(dir) {
        const info = await fs.lstat(dir);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          info.uid !== process.getuid() ||
          info.mode & 0o022
        )
          fail("Unsafe prune directory");
        return info;
      }
      const releases = path.join(root, "releases");
      const shared = path.join(root, "shared");
      const pool = path.join(shared, "assets");
      await storedDirectory(releases);
      await storedDirectory(shared);
      await storedDirectory(pool);
      if (
        JSON.stringify(await fs.readdir(shared)) !== JSON.stringify(["assets"])
      )
        fail("Unexpected shared entries");
      const link = path.join(root, "current");
      if (!(await fs.lstat(link)).isSymbolicLink())
        fail("current must be a symlink");
      const target = await fs.readlink(link);
      if (!/^releases\/[a-f0-9]{40}-[a-f0-9]{64}$/.test(target))
        fail("Unsafe current target");
      const currentId = target.slice(9);
      const names = (await fs.readdir(releases)).sort(compare);
      if (
        !names.length ||
        names.length > MAX_FILES ||
        names.some((id) => !RELEASE.test(id))
      )
        fail("Invalid release inventory");
      if (![currentId, ...protectedIds].every((id) => names.includes(id)))
        fail("Current or protected release missing");
      const inventory = [];
      for (const id of names) {
        const dir = path.join(releases, id);
        const info = await storedDirectory(dir);
        const manifest = await checkRelease(dir, id);
        // Empty and unlisted directories are unexpected too, even if the files
        // alone happen to match the manifest.
        async function directories(base, prefix = "") {
          for (const name of await fs.readdir(base)) {
            const relative = prefix ? `${prefix}/${name}` : name;
            if (relative !== MANIFEST) safePath(relative);
            const child = path.join(base, name);
            const stat = await fs.lstat(child);
            if (stat.uid !== process.getuid() || stat.mode & 0o022)
              fail("Unsafe stored release ownership or permissions");
            if (stat.isDirectory()) {
              await storedDirectory(child);
              if (
                !manifest.files.some((file) =>
                  file.path.startsWith(`${relative}/`),
                )
              )
                fail("Unlisted release directory");
              await directories(child, relative);
            }
          }
        }
        await directories(dir);
        inventory.push({ id, mtime: info.mtimeMs, manifest });
      }
      const cutoff = Date.now() - Number(minimumAgeDays) * 86400000;
      inventory.sort((a, b) => b.mtime - a.mtime || compare(a.id, b.id));
      const retained = new Set([
        currentId,
        ...protectedIds,
        ...inventory.slice(0, Number(keep)).map((item) => item.id),
      ]);
      for (const item of inventory)
        if (item.mtime >= cutoff) retained.add(item.id);
      const referenced = new Map();
      for (const item of inventory.filter((item) => retained.has(item.id))) {
        for (const file of item.manifest.files.filter((file) =>
          file.path.startsWith("assets/"),
        )) {
          const name = file.path.slice(7);
          if (
            referenced.has(name) &&
            referenced.get(name).sha256 !== file.sha256
          )
            fail("Conflicting retained asset provenance");
          referenced.set(name, file);
        }
      }
      const assets = [];
      let assetCount = 0;
      async function assetTree(base, prefix = "") {
        for (const name of (await fs.readdir(base)).sort(compare)) {
          if (++assetCount > MAX_FILES) fail("Asset inventory limit exceeded");
          const relative = prefix ? `${prefix}/${name}` : name;
          safePath(relative);
          const child = path.join(base, name);
          const info = await fs.lstat(child);
          if (info.isSymbolicLink()) fail("Unsafe asset entry");
          if (info.isDirectory()) {
            await storedDirectory(child);
            await assetTree(child, relative);
          } else {
            if (
              !info.isFile() ||
              info.nlink !== 1 ||
              info.uid !== process.getuid() ||
              info.mode & 0o022
            )
              fail("Unsafe asset entry");
            const bytes = await readRegular(child, MAX_FILE);
            const reference = referenced.get(relative);
            if (
              reference &&
              (reference.size !== bytes.length ||
                reference.sha256 !== hash(bytes))
            )
              fail("Retained asset checksum mismatch");
            assets.push({ name: relative, mtime: info.mtimeMs });
          }
        }
      }
      await assetTree(pool);
      if (
        [...referenced.keys()].some(
          (name) => !assets.some((asset) => asset.name === name),
        )
      )
        fail("Missing retained asset");
      const result = {
        dryRun: apply === "false",
        currentRelease: currentId,
        retainedReleases: [...retained].sort(compare),
        deleteReleases: inventory
          .filter((item) => !retained.has(item.id))
          .map((item) => item.id)
          .sort(compare),
        deleteAssets: assets
          .filter(
            (asset) => !referenced.has(asset.name) && asset.mtime < cutoff,
          )
          .map((asset) => asset.name)
          .sort(compare),
      };
      // The complete release and asset inventory has passed before the first delete.
      // Storage is writable only by this publisher; the same lock guards all writers.
      if (!result.dryRun) {
        for (const id of result.deleteReleases)
          await fs.rm(path.join(releases, id), { recursive: true });
        for (const name of result.deleteAssets)
          await fs.unlink(path.join(pool, name));
      }
      return result;
    },
    false,
  );
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const flags = {};
  const allowed = {
    pack: ["input", "output", "source-sha"],
    verify: ["archive", "sha256"],
    activate: ["archive", "sha256", "root"],
    rollback: ["root", "release"],
    prune: ["root", "keep", "minimum-age-days", "apply", "protect-release"],
  }[command];
  if (!allowed)
    fail(
      "Usage: frontend-release.mjs pack|verify|activate|rollback|prune [flags]",
    );
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index].slice(2);
    if (
      !args[index].startsWith("--") ||
      !allowed.includes(name) ||
      (flags[name] && name !== "protect-release") ||
      !args[index + 1] ||
      args[index + 1].startsWith("--")
    )
      fail("Unknown, duplicate or missing CLI flag");
    if (name === "protect-release") (flags[name] ??= []).push(args[index + 1]);
    else flags[name] = args[index + 1];
  }
  if (allowed.some((name) => name !== "protect-release" && !flags[name]))
    fail(
      `Required flags: ${allowed
        .filter((name) => name !== "protect-release")
        .map((name) => `--${name}`)
        .join(" ")}`,
    );
  if (command === "prune")
    return prune(
      flags.root,
      flags.keep,
      flags["minimum-age-days"],
      flags.apply,
      flags["protect-release"] ?? [],
    );
  if (command === "pack")
    return pack(flags.input, flags.output, flags["source-sha"]);
  if (command === "verify") {
    const { manifest } = await verify(flags.archive, flags.sha256);
    return {
      releaseId: manifest.releaseId,
      sourceSha: manifest.sourceSha,
      sha256: flags.sha256,
      fileCount: manifest.files.length,
    };
  }
  if (command === "activate")
    return activate(flags.archive, flags.sha256, path.resolve(flags.root));
  return rollback(path.resolve(flags.root), flags.release);
}

main()
  .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
  .catch((error) => {
    // Never print archive contents, environment values or token-bearing URLs.
    process.stderr.write(`frontend-release: ${error.message}\n`);
    process.exitCode = 1;
  });
