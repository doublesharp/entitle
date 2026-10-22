import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  GetBucketPolicyCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { S3ArtifactStore } from "../src/storage.ts";
import { createDb, createTenant, migrate } from "../src/db.ts";
import { Releases } from "../src/releases.ts";
import { zipBytes } from "./helpers/zip.ts";

const enabled = process.env.TEST_S3_INTEGRATION === "true";
test(
  "actual local S3 engine preserves private immutable tenant artifacts",
  { skip: !enabled },
  async (t) => {
    const endpoint = process.env.TEST_S3_ENDPOINT;
    assert.ok(endpoint, "TEST_S3_ENDPOINT is required");
    const url = new URL(endpoint);
    assert.ok(
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
      "S3 integration writes are limited to a local fixture",
    );
    assert.ok(!url.username && !url.password && !url.search && !url.hash);
    const accessKeyId = process.env.TEST_S3_ACCESS_KEY_ID,
      secretAccessKey = process.env.TEST_S3_SECRET_ACCESS_KEY;
    assert.ok(
      accessKeyId && secretAccessKey,
      "Explicit local fixture credentials are required",
    );
    const credentials = { accessKeyId, secretAccessKey };
    const bucket = `entitle-it-${randomUUID()}`;
    const client = new S3Client({
      endpoint,
      region: "us-east-1",
      credentials,
      forcePathStyle: true,
      maxAttempts: 1,
      requestHandler: {
        connectionTimeout: 3000,
        requestTimeout: 10000,
        throwOnRequestTimeout: true,
        socketTimeout: 3000,
      },
    });
    const store = new S3ArtifactStore({
      endpoint,
      region: "us-east-1",
      credentials,
      bucket,
      forcePathStyle: true,
      allowInsecureLocalDevelopment: true,
      timeoutMs: 3000,
    });
    const root = await mkdtemp(
      "/Volumes/Scratch/double-entitle-wp/tmp/s3-integration-",
    );
    const tenant = randomUUID(),
      other = randomUUID(),
      release = randomUUID();
    const bytes = Buffer.from("real provider private artifact"),
      checksum = createHash("sha256").update(bytes).digest("hex");
    let created = false;
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      created = true;
      await t.test("readiness and private anonymous access", async () => {
        await store.ready();
        assert.equal(
          (await client.send(new ListObjectsV2Command({ Bucket: bucket })))
            .KeyCount,
          0,
        );
        await assert.rejects(
          client.send(new GetBucketPolicyCommand({ Bucket: bucket })),
          (error: unknown) =>
            (error as { name: string }).name === "NoSuchBucketPolicy",
        );
        const anonymous = await fetch(`${endpoint}/${bucket}`, {
          signal: AbortSignal.timeout(3000),
        });
        assert.equal(anonymous.status, 403);
        await anonymous.body?.cancel();
      });
      await t.test(
        "conditional publication is immutable and verifies upload SHA256",
        async () => {
          await assert.rejects(
            store.put(tenant, release, bytes, "0".repeat(64)),
            { code: "artifact_integrity" },
          );
          await store.put(tenant, release, bytes, checksum);
          await assert.rejects(
            store.put(
              tenant,
              release,
              Buffer.from("replacement"),
              createHash("sha256").update("replacement").digest("hex"),
            ),
            { status: 409, code: "artifact_exists" },
          );
          assert.deepEqual(
            await store.get(tenant, release, checksum, bytes.length),
            bytes,
          );
          const anonymous = await fetch(
            `${endpoint}/${bucket}/tenants/${tenant}/releases/${release}.zip`,
            { signal: AbortSignal.timeout(3000) },
          );
          assert.equal(anonymous.status, 403);
          await anonymous.body?.cancel();
        },
      );
      await t.test(
        "concurrent conditional writes select one immutable winner",
        async () => {
          const id = randomUUID(),
            alternatives = [
              Buffer.from("first contender"),
              Buffer.from("second contender"),
            ];
          const hashes = alternatives.map((value) =>
            createHash("sha256").update(value).digest("hex"),
          );
          const outcomes = await Promise.allSettled(
            alternatives.map((value, index) =>
              store.put(tenant, id, value, hashes[index]!),
            ),
          );
          const winner = outcomes.findIndex(
            (value) => value.status === "fulfilled",
          );
          assert.equal(
            outcomes.filter((value) => value.status === "fulfilled").length,
            1,
          );
          const rejected = outcomes.find(
            (value) => value.status === "rejected",
          ) as PromiseRejectedResult;
          assert.equal(rejected.reason.code, "artifact_exists");
          assert.deepEqual(
            await store.get(
              tenant,
              id,
              hashes[winner]!,
              alternatives[winner]!.length,
            ),
            alternatives[winner],
          );
        },
      );
      await t.test(
        "provider rejects an incorrect declared SHA256",
        async () => {
          const Key = `tenants/${tenant}/releases/${randomUUID()}.zip`;
          await assert.rejects(
            client.send(
              new PutObjectCommand({
                Bucket: bucket,
                Key,
                Body: bytes,
                IfNoneMatch: "*",
                ChecksumSHA256: Buffer.alloc(32).toString("base64"),
              }),
            ),
            (error: unknown) =>
              (error as { $metadata?: { httpStatusCode?: number } }).$metadata
                ?.httpStatusCode === 400,
          );
          const objects = await client.send(
            new ListObjectsV2Command({ Bucket: bucket }),
          );
          assert.equal(
            objects.Contents?.some((object) => object.Key === Key) ?? false,
            false,
          );
        },
      );
      await t.test(
        "same release ID remains isolated between tenants",
        async () => {
          await assert.rejects(
            store.get(other, release, checksum, bytes.length),
          );
          const otherBytes = Buffer.from("other tenant"),
            hash = createHash("sha256").update(otherBytes).digest("hex");
          await store.put(other, release, otherBytes, hash);
          assert.deepEqual(
            await store.get(other, release, hash, otherBytes.length),
            otherBytes,
          );
          assert.deepEqual(
            await store.get(tenant, release, checksum, bytes.length),
            bytes,
          );
        },
      );
      await t.test(
        "corruption and unexpected sizes fail before returning bytes",
        async () => {
          await assert.rejects(
            store.get(tenant, release, checksum, bytes.length + 1),
            { code: "artifact_integrity" },
          );
          await assert.rejects(
            store.get(tenant, release, "0".repeat(64), bytes.length),
            { code: "artifact_integrity" },
          );
          const corruptId = randomUUID();
          await client.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: `tenants/${tenant}/releases/${corruptId}.zip`,
              Body: Buffer.alloc(bytes.length),
              IfNoneMatch: "*",
            }),
          );
          await assert.rejects(
            store.get(tenant, corruptId, checksum, bytes.length),
            { code: "artifact_integrity" },
          );
        },
      );
      await t.test(
        "withdrawal preserves the verified stored release",
        async () => {
          const db = createDb(`sqlite:${root}/db`);
          try {
            await migrate(db);
            const publisher = await createTenant(db, {
              id: randomUUID(),
              slug: `s3-${randomUUID()}`,
              name: "S3 publisher",
              exempt: 1,
            });
            await db("products").insert({
              tenant_id: publisher.id,
              id: randomUUID(),
              slug: "s3-plugin",
              name: "S3 plugin",
            });
            const file = `${root}/plugin.zip`;
            const archive = zipBytes([
              {
                name: "s3-plugin/s3-plugin.php",
                data: "<?php\n/*\nPlugin Name: S3 plugin\nVersion: 1.0.0\n*/",
              },
            ]);
            await writeFile(file, archive);
            const releases = new Releases(db, store, publisher, root);
            const published = await releases.publish({
              product: "s3-plugin",
              version: "1.0.0",
              file,
              changelog: "S3 integration",
              minWp: "6.0",
              minPhp: "8.0",
              minFree: "0.0.0",
              tested: "7.0",
            });
            await releases.withdraw(published.id);
            assert.equal(
              (
                await db("releases")
                  .where({ tenant_id: publisher.id, id: published.id })
                  .first()
              ).withdrawn,
              1,
            );
            assert.equal(
              await releases.latest(published.product_id),
              undefined,
            );
            assert.deepEqual(await releases.read(published), archive);
          } finally {
            await db.destroy();
          }
        },
      );
      await t.test(
        "delete is idempotent and removes only the selected tenant object",
        async () => {
          await store.delete(tenant, release);
          await store.delete(tenant, release);
          await assert.rejects(
            store.get(tenant, release, checksum, bytes.length),
          );
          const keys = await client.send(
            new ListObjectsV2Command({ Bucket: bucket }),
          );
          assert.ok(
            keys.Contents?.some(
              (object) =>
                object.Key === `tenants/${other}/releases/${release}.zip`,
            ),
          );
        },
      );
    } finally {
      if (created) {
        const objects = await client.send(
          new ListObjectsV2Command({ Bucket: bucket }),
        );
        if (objects.Contents?.length)
          await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: {
                Objects: objects.Contents.map((object) => ({
                  Key: object.Key!,
                })),
              },
            }),
          );
        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
      }
      client.destroy();
      await rm(root, { recursive: true, force: true });
    }
  },
);
