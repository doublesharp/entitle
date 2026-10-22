import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createDb, createTenant, migrate } from "../src/db.ts";
import { Releases } from "../src/releases.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import { zipBytes } from "./helpers/zip.ts";

test("concurrent publication reserves tenant storage and keeps private immutable S3 objects", async () => {
  const root = await mkdtemp("/Volumes/Scratch/entitle/tmp/tenant-publication-");
  const db = createDb(`sqlite:${root}/db`), store = new InMemoryArtifactStore();
  try {
    await migrate(db);
    const bytes = zipBytes([{ name: "plugin/main.php", data: "<?php /* Plugin Name: Plugin\nVersion: 1.0.0\n*/" }]);
    const a = await createTenant(db, { id: randomUUID(), slug: "alpha", name: "A", max_storage_bytes: bytes.length });
    const b = await createTenant(db, { id: randomUUID(), slug: "beta", name: "B" });
    for (const tenant of [a,b]) await db("products").insert({ tenant_id: tenant.id, id: randomUUID(), slug: "plugin", name: "Plugin", plugin_basename: "plugin/main.php" });
    const input = { product: "plugin", version: "1.0.0", file: `${root}/input.zip`, changelog: "First", minWp: "6.0", minPhp: "8.0", minFree: "0.0.0", tested: "7.0" };
    await writeFile(input.file, bytes);
    const aa = new Releases(db, store, a, `${root}/work`);
    const bb = new Releases(db, store, b, `${root}/work`);
    const results = await Promise.allSettled([aa.publish(input),aa.publish(input)]);
    assert.equal(results.filter(r=>r.status === "fulfilled").length,1);
    const release = await aa.latest((await db("products").where({ tenant_id:a.id }).first()).id);
    assert.ok(release);
    assert.deepEqual(await aa.read(release), bytes);
    await assert.rejects(bb.read(release), /another tenant/);
    await aa.withdraw(release.id);
    assert.deepEqual(await aa.read(release), bytes, "withdrawal preserves operator recovery bytes");
    assert.equal(await aa.latest(release.product_id), undefined);
    assert.equal((await db("upload_reservations")).length,0);
    const independent = await bb.publish(input);
    assert.deepEqual(await bb.read(independent),bytes);
    const betaFile=`${root}/beta.zip`;
    await writeFile(betaFile,zipBytes([{name:"plugin/main.php",data:"<?php /* Plugin Name: Plugin\nVersion: 2.0.0-beta.1\n*/"}]));
    await assert.rejects(bb.publish({...input,file:betaFile,version:"2.0.0-beta.1"}),{code:"invalid_version"});
  } finally { await db.destroy(); await rm(root,{recursive:true,force:true}); }
});
