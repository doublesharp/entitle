import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { runMaintenance, maintenanceStorage } from "../src/maintenance-cli.ts";
import { loadConfig } from "../src/config.ts";
import { createDb, migrate, type Tenant } from "../src/db.ts";
import { Portability } from "../src/portability.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";

// Opt in only to the local fixture; this test never calls Stripe, SMTP or production S3.
test(
  "real local private MinIO import streams immutable artifacts and rejects populated destinations",
  { skip: process.env.TEST_S3_INTEGRATION !== "true" },
  async (t) => {
    const endpoint = new URL(process.env.TEST_S3_ENDPOINT!);
    assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname));
    await mkdir(
      "/Volumes/Scratch/entitle/tmp/saas-features-20261021/r3-fixes/privacy/maintenance-cli",
      {
        recursive: true,
        mode: 0o700,
      },
    );
    const root = await mkdtemp(
      "/Volumes/Scratch/entitle/tmp/saas-features-20261021/r3-fixes/privacy/maintenance-cli/minio-",
    );
    const bucket = `maintenance-${randomUUID()}`;
    const sdk = new S3Client({
      endpoint: endpoint.href,
      region: "us-east-1",
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY!,
      },
      maxAttempts: 1,
    });
    const db = createDb(`sqlite:${root}/source`);
    t.after(async () => {
      await db.destroy();
      try {
        for (const object of (
          await sdk.send(new ListObjectsV2Command({ Bucket: bucket }))
        ).Contents ?? [])
          await sdk.send(
            new DeleteObjectCommand({ Bucket: bucket, Key: object.Key! }),
          );
        await sdk.send(new DeleteBucketCommand({ Bucket: bucket }));
      } finally {
        sdk.destroy();
        await rm(root, { recursive: true, force: true });
      }
    });
    await sdk.send(new CreateBucketCommand({ Bucket: bucket }));
    await migrate(db);
    const tenant = (await db<Tenant>("tenants").first())!,
      product = randomUUID(),
      release = randomUUID();
    const bytes = Buffer.from("immutable imported artifact"),
      checksum = createHash("sha256").update(bytes).digest("hex");
    await db("products").insert({
      tenant_id: "primary",
      id: product,
      slug: "portable",
      name: "Portable",
    });
    await db("releases").insert({
      tenant_id: "primary",
      id: release,
      product_id: product,
      version: "1.0.0",
      changelog: "",
      published_at: 1,
      withdrawn: 0,
      size: bytes.length,
      checksum,
      min_wp: "",
      min_php: "",
      min_free: "",
      tested: "",
    });
    const store = new InMemoryArtifactStore();
    await store.put("primary", release, bytes, checksum);
    const dir = `${root}/exports`;
    await mkdir(dir, { mode: 0o700 });
    const exporter = new Portability({
      db,
      store,
      secret: "21".repeat(32),
      directory: dir,
      sourceStripeAccountId: "acct_merchant",
    });
    t.after(() => exporter.close());
    const exported = await exporter.createExport(
      tenant.id,
      "private transfer phrase",
    );
    const phrase = `${root}/phrase`;
    await writeFile(phrase, "private transfer phrase\n", { mode: 0o600 });
    const env = {
      APP_SECRET: "31".repeat(32),
      OPERATOR_TOKEN: "private operator credential".repeat(2),
      STRIPE_SECRET_KEY: "sk_test_fixture",
      DATABASE_URL: `sqlite:${root}/destination`,
      WORK_DIR: `${root}/work`,
      S3_BUCKET: bucket,
      S3_REGION: "us-east-1",
      S3_ENDPOINT: endpoint.href,
      S3_ACCESS_KEY_ID: process.env.TEST_S3_ACCESS_KEY_ID!,
      S3_SECRET_ACCESS_KEY: process.env.TEST_S3_SECRET_ACCESS_KEY!,
      S3_FORCE_PATH_STYLE: "true",
      S3_ALLOW_HTTP: "true",
    };
    const output: string[] = [],
      errors: string[] = [];
    const args = [
      "import",
      "--bundle",
      `${dir}/${exported.id}`,
      "--directory",
      `${root}/plaintext`,
      "--operator",
      "local-operator",
      "--quiesced",
      "--expected-stripe-account",
      "acct_merchant",
    ];
    const fd = openSync(phrase, "r");
    try {
      assert.equal(
        await runMaintenance(
          [...args, "--passphrase-fd", String(fd)],
          env,
          {
            out: (value) => output.push(value),
            error: (value) => errors.push(value),
          },
          {
            stripe: () => ({
              stripe: {
                accounts: { retrieve: async () => ({ id: "acct_merchant" }) },
                events: {
                  retrieve: async () => {
                    throw Error("unexpected event");
                  },
                },
              },
              snapshot: async () => {
                throw Error("unexpected snapshot");
              },
              resolveSubscription: async () => {
                throw Error("unexpected event");
              },
            }),
          },
        ),
        0,
        errors.join(""),
      );
    } finally {
      closeSync(fd);
    }
    const destination = createDb(env.DATABASE_URL);
    try {
      assert.equal((await destination("tenants").first()).suspended, 1);
      assert.equal((await destination("releases").first()).checksum, checksum);
    } finally {
      await destination.destroy();
    }
    const object = await sdk.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: `tenants/primary/releases/${release}.zip`,
      }),
    );
    assert.deepEqual(
      Buffer.from(await object.Body!.transformToByteArray()),
      bytes,
    );
    const anonymous = await fetch(
      `${endpoint.origin}/${bucket}/tenants/primary/releases/${release}.zip`,
    );
    assert.equal(anonymous.status, 403);
    await anonymous.body?.cancel();
    const adapter = maintenanceStorage(loadConfig(env));
    try {
      await assert.rejects(adapter.verifyEmpty());
      await assert.rejects(
        adapter.store.put(
          "primary",
          release,
          Buffer.from("collision"),
          createHash("sha256").update("collision").digest("hex"),
        ),
      );
    } finally {
      adapter.close();
    }
    await sdk.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: "unrelated-owned-fixture",
        Body: "keep",
      }),
    );
    const collisionStore = maintenanceStorage(loadConfig(env));
    try {
      await assert.rejects(collisionStore.verifyEmpty());
    } finally {
      collisionStore.close();
    }
    assert.equal(JSON.parse(output[0]!).requiresReconciliation, true);
  },
);
