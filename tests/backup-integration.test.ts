import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { buildApp } from "../src/app.ts";
import {
  Billing,
  type BillingEvent,
  type BillingSnapshot,
} from "../src/billing.ts";
import { loadConfig } from "../src/config.ts";
import { unseal } from "../src/crypto.ts";
import {
  createDb,
  createTenant,
  migrate,
  type DB,
  type License,
  type Release,
  type Tenant,
} from "../src/db.ts";
import type { Message } from "../src/email.ts";
import { Licenses } from "../src/licensing.ts";
import { Releases } from "../src/releases.ts";
import {
  S3ArtifactStore,
  type S3ArtifactStoreOptions,
} from "../src/storage.ts";
import { zipBytes } from "./helpers/zip.ts";

const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
interface Publisher {
  tenant: Tenant;
  release: Release;
  withdrawn: Release;
  archive: Buffer;
  snapshot: BillingSnapshot;
  event: BillingEvent;
  processedAt: number;
  licenseId: string;
  grantId: string;
  installationId: string;
  key: string;
  token: string;
  workState: string;
}
interface SavedObject {
  tenantId: string;
  releaseId: string;
  key: string;
  checksum: string;
  size: number;
  withdrawn: number;
  file: string;
}
async function seed(
  db: DB,
  store: S3ArtifactStore,
  secret: string,
  root: string,
  label: string,
): Promise<Publisher> {
  const tenant = await createTenant(db, {
    id: randomUUID(),
    slug: `restore-${randomUUID()}`,
    name: `Restore ${label}`,
    exempt: 1,
  });
  const productId = randomUUID(),
    planId = randomUUID();
  await db("products").insert({
    tenant_id: tenant.id,
    id: productId,
    slug: "backup-plugin",
    name: `Backup ${label}`,
  });
  await db("plans").insert({
    tenant_id: tenant.id,
    id: planId,
    product_id: productId,
    name: "Paid fixture",
    site_allowance: 1,
    stripe_price_id: "price_restore",
  });
  const releases = new Releases(db, store, tenant, `${root}/work-source`);
  async function publish(version: string) {
    const archive = zipBytes([
      {
        name: "backup-plugin/backup-plugin.php",
        data: `<?php\n/*\nPlugin Name: Backup ${label}\nVersion: ${version}\n*/`,
      },
    ]);
    const file = `${root}/${tenant.id}-${version}.zip`;
    await writeFile(file, archive);
    const release = await releases.publish({
      product: "backup-plugin",
      version,
      file,
      changelog: "Restore drill",
      minWp: "6.0",
      minPhp: "8.0",
      minFree: "0.0.0",
      tested: "7.0",
    });
    return { release, archive };
  }
  const current = await publish("1.0.0"),
    old = await publish("0.9.0");
  await releases.withdraw(old.release.id);
  const now = Date.now();
  const snapshot: BillingSnapshot = {
    subscriptionId: "sub_restore",
    customerId: "cus_restore",
    email: "restore@example.test",
    billingStatus: "active",
    suspended: false,
    fullyRefunded: false,
    grants: [
      {
        id: "il_restore",
        invoiceId: "in_restore",
        priceId: "price_restore",
        periodStart: now - 1000,
        periodEnd: now + 86400000,
        paidAt: now,
        settled: true,
      },
    ],
    invoices: [
      {
        invoiceId: "in_restore",
        currency: "usd",
        paidMinor: 1000,
        refundedMinor: 0,
      },
    ],
  };
  const licensing = new Licenses(db, secret, [], tenant);
  const billing = new Billing(db, licensing, {
    snapshot: async () => structuredClone(snapshot),
  });
  const event: BillingEvent = {
    id: "evt_restore_paid",
    type: "invoice.paid",
    data: { object: { id: "in_restore" } },
  };
  await billing.receive(event);
  await billing.run(async () => snapshot.subscriptionId);
  const license = await db<License>("licenses")
    .where({ tenant_id: tenant.id })
    .first();
  assert.ok(license);
  const grant = await db("grants")
    .where({ tenant_id: tenant.id, license_id: license.id })
    .first();
  assert.ok(grant);
  const message = await db("emails")
    .where({ tenant_id: tenant.id, kind: "license_key" })
    .first();
  assert.ok(message);
  const key = /DE-[A-Za-z0-9_-]+/.exec(
    unseal<Message>(message.payload, secret).text,
  )?.[0];
  assert.ok(key);
  const receipt = await db("billing_events")
    .where({ tenant_id: tenant.id, id: event.id })
    .first();
  assert.ok(receipt?.processed_at);
  const work = await db("work")
    .where({ tenant_id: tenant.id, id: event.id })
    .first();
  assert.ok(work);
  return {
    tenant,
    release: current.release,
    withdrawn: old.release,
    archive: current.archive,
    snapshot,
    event,
    processedAt: Number(receipt.processed_at),
    licenseId: license.id,
    grantId: grant.id,
    installationId: randomUUID(),
    key,
    token: "",
    workState: work.state,
  };
}

test(
  "stopped SQLite and private S3 backups restore paid downloads and event deduplication for two tenants",
  { skip: process.env.TEST_S3_INTEGRATION !== "true" },
  async (t) => {
    const endpoint = process.env.TEST_S3_ENDPOINT;
    assert.ok(endpoint, "TEST_S3_ENDPOINT is required");
    const url = new URL(endpoint);
    assert.ok(
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname),
      "Restore writes require an explicit local fixture",
    );
    assert.ok(
      ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash,
    );
    const accessKeyId = process.env.TEST_S3_ACCESS_KEY_ID,
      secretAccessKey = process.env.TEST_S3_SECRET_ACCESS_KEY;
    assert.ok(
      accessKeyId && secretAccessKey,
      "Explicit fixture credentials are required",
    );
    const credentials = { accessKeyId, secretAccessKey },
      id = randomUUID();
    const sourceBucket = `restore-src-${id}`,
      targetBucket = `restore-dst-${id}`;
    const options: Omit<S3ArtifactStoreOptions, "bucket"> = {
      endpoint,
      credentials,
      region: "us-east-1",
      forcePathStyle: true,
      allowInsecureLocalDevelopment: true,
      timeoutMs: 3000,
    };
    const client = new S3Client({
      ...options,
      maxAttempts: 1,
      requestHandler: {
        connectionTimeout: 3000,
        requestTimeout: 10000,
        throwOnRequestTimeout: true,
        socketTimeout: 3000,
      },
    });
    const sourceStore = new S3ArtifactStore({
      ...options,
      bucket: sourceBucket,
    });
    const root = await mkdtemp(
      "/Volumes/Scratch/double-entitle-wp/tmp/backup-restore-",
    );
    const originalDirectory = `${root}/original-db`,
      backup = `${root}/backup`,
      restoredDirectory = `${root}/restored-db`;
    const ownedBuckets: string[] = [];
    let db: DB | undefined,
      app: Awaited<ReturnType<typeof buildApp>> | undefined;
    const secret = randomBytes(32).toString("hex"),
      operatorToken = randomBytes(32).toString("hex");
    function config(directory: string, key: string, bucket: string) {
      return loadConfig({ DEPLOYMENT_MODE: "hosted",
        NODE_ENV: "test",
        APP_SECRET: key,
        OPERATOR_TOKEN: operatorToken,
        PUBLIC_ORIGIN: "http://localhost:3211",
        DATABASE_URL: `sqlite:${directory}/entitle.sqlite`,
        DATA_DIR: directory,
        WORK_DIR: `${directory}/work`,
        WEB_DIR: `${root}/web`,
        LOCAL_BILLING: "true",
        S3_ENDPOINT: endpoint!,
        S3_BUCKET: bucket,
        S3_REGION: "us-east-1",
        S3_ACCESS_KEY_ID: accessKeyId!,
        S3_SECRET_ACCESS_KEY: secretAccessKey!,
        S3_FORCE_PATH_STYLE: "true",
        S3_ALLOW_HTTP: "true",
      });
    }
    async function get(base: string, path: string, token?: string) {
      const response = await fetch(base + path, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      return {
        status: response.status,
        bytes: Buffer.from(await response.arrayBuffer()),
        headers: response.headers,
      };
    }
    async function activate(base: string, publisher: Publisher, key: string) {
      const response = await fetch(
        `${base}/api/v1/tenants/${publisher.tenant.slug}/activate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            key,
            product: "backup-plugin",
            installationId: publisher.installationId,
            siteUrl: "https://restore.example.test",
          }),
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        },
      );
      assert.equal(response.status, 200);
      return ((await response.json()) as { token: string }).token;
    }
    try {
      await client.send(new CreateBucketCommand({ Bucket: sourceBucket }));
      ownedBuckets.push(sourceBucket);
      db = createDb(`sqlite:${originalDirectory}/entitle.sqlite`);
      await migrate(db);
      const publishers: Publisher[] = [
        await seed(db, sourceStore, secret, root, "A"),
        await seed(db, sourceStore, secret, root, "B"),
      ];
      app = await buildApp(
        config(originalDirectory, secret, sourceBucket),
        db,
        { send: async () => {} },
        { store: sourceStore },
      );
      const sourceBase = await app.listen({ host: "127.0.0.1", port: 0 });
      for (const publisher of publishers) {
        publisher.token = await activate(sourceBase, publisher, publisher.key);
        const path = `/api/v1/tenants/${publisher.tenant.slug}/packages/${publisher.release.id}`;
        assert.equal((await get(sourceBase, path)).status, 401);
        const response = await get(sourceBase, path, publisher.token);
        assert.equal(response.status, 200);
        assert.equal(digest(response.bytes), publisher.release.checksum);
      }
      const migrations = (
        await db("knex_migrations").select("name").orderBy("name")
      ).map((row) => row.name as string);
      const rows = await db<Release>("releases").select("*").orderBy("id");
      assert.equal(rows.length, 4);
      const sqlite = (await db.raw("select sqlite_version() as version"))[0]
        .version as string;
      await app.close();
      app = undefined;
      await db.destroy();
      db = undefined;
      t.diagnostic(
        "Stopped only the isolated HTTP app and SQLite pool before taking the matching backup.",
      );
      await mkdir(`${backup}/objects`, { recursive: true, mode: 0o700 });
      await cp(originalDirectory, `${backup}/database`, {
        recursive: true,
        preserveTimestamps: true,
      });
      const databaseChecksum = digest(
        await readFile(`${backup}/database/entitle.sqlite`),
      );
      assert.equal(
        databaseChecksum,
        digest(await readFile(`${originalDirectory}/entitle.sqlite`)),
      );
      const objects: SavedObject[] = [];
      for (const release of rows) {
        const bytes = await sourceStore.get(
          release.tenant_id,
          release.id,
          release.checksum,
          Number(release.size),
        );
        const file = `objects/${release.id}.zip`;
        await writeFile(`${backup}/${file}`, bytes, { mode: 0o600 });
        objects.push({
          tenantId: release.tenant_id,
          releaseId: release.id,
          key: `tenants/${release.tenant_id}/releases/${release.id}.zip`,
          checksum: release.checksum,
          size: Number(release.size),
          withdrawn: release.withdrawn,
          file,
        });
      }
      const keys = (
        await client.send(new ListObjectsV2Command({ Bucket: sourceBucket }))
      ).Contents?.map((object) => object.Key!).sort();
      assert.deepEqual(keys, objects.map((object) => object.key).sort());
      await writeFile(`${backup}/app-secret`, secret, { mode: 0o600 });
      await writeFile(
        `${backup}/manifest.json`,
        JSON.stringify({ sqlite, migrations, databaseChecksum, objects }),
        { mode: 0o600 },
      );
      t.diagnostic(
        "Backed up two tenant namespaces and four exact generated keys, including two withdrawn artifacts.",
      );
      for (const object of objects) {
        await sourceStore.delete(object.tenantId, object.releaseId);
        await assert.rejects(
          sourceStore.get(
            object.tenantId,
            object.releaseId,
            object.checksum,
            object.size,
          ),
        );
      }
      assert.equal(
        (await client.send(new ListObjectsV2Command({ Bucket: sourceBucket })))
          .KeyCount,
        0,
      );
      await rm(originalDirectory, { recursive: true, force: true });
      await assert.rejects(access(`${originalDirectory}/entitle.sqlite`), {
        code: "ENOENT",
      });
      t.diagnostic(
        "Deleted only the isolated original database directory and its four source objects before restoring.",
      );
      const saved = JSON.parse(
        await readFile(`${backup}/manifest.json`, "utf8"),
      ) as {
        sqlite: string;
        migrations: string[];
        databaseChecksum: string;
        objects: SavedObject[];
      };
      assert.equal(
        digest(await readFile(`${backup}/database/entitle.sqlite`)),
        saved.databaseChecksum,
      );
      await cp(`${backup}/database`, restoredDirectory, {
        recursive: true,
        preserveTimestamps: true,
      });
      assert.equal(
        digest(await readFile(`${restoredDirectory}/entitle.sqlite`)),
        saved.databaseChecksum,
      );
      await client.send(new CreateBucketCommand({ Bucket: targetBucket }));
      ownedBuckets.push(targetBucket);
      const restoredStore = new S3ArtifactStore({
        ...options,
        bucket: targetBucket,
      });
      for (const object of saved.objects) {
        const bytes = await readFile(`${backup}/${object.file}`);
        assert.equal(bytes.length, object.size);
        assert.equal(digest(bytes), object.checksum);
        await restoredStore.put(
          object.tenantId,
          object.releaseId,
          bytes,
          object.checksum,
        );
      }
      assert.deepEqual(
        (
          await client.send(new ListObjectsV2Command({ Bucket: targetBucket }))
        ).Contents?.map((object) => object.Key!).sort(),
        keys,
      );
      const anonymous = await fetch(
        `${endpoint}/${targetBucket}/${saved.objects[0]!.key}`,
        { signal: AbortSignal.timeout(3000) },
      );
      assert.equal(anonymous.status, 403);
      await anonymous.body?.cancel();
      db = createDb(`sqlite:${restoredDirectory}/entitle.sqlite`);
      await migrate(db);
      assert.deepEqual(
        (await db("knex_migrations").select("name").orderBy("name")).map(
          (row) => row.name,
        ),
        saved.migrations,
      );
      assert.equal(
        (await db.raw("pragma integrity_check"))[0].integrity_check,
        "ok",
      );
      assert.deepEqual(await db.raw("pragma foreign_key_check"), []);
      const restoredSecret = await readFile(`${backup}/app-secret`, "utf8");
      app = await buildApp(
        config(restoredDirectory, restoredSecret, targetBucket),
        db,
        { send: async () => {} },
        { store: restoredStore },
      );
      const restoredBase = await app.listen({ host: "127.0.0.1", port: 0 });
      assert.equal((await get(restoredBase, "/api/v1/ready")).status, 200);
      for (const publisher of publishers) {
        const tenant: Tenant | undefined = await db<Tenant>("tenants")
          .where({ id: publisher.tenant.id })
          .first();
        assert.ok(tenant);
        const message: { payload: string } | undefined = await db<{
          payload: string;
          tenant_id: string;
          kind: string;
        }>("emails")
          .where({ tenant_id: tenant.id, kind: "license_key" })
          .first();
        assert.ok(message);
        const restoredKey: string | undefined = /DE-[A-Za-z0-9_-]+/.exec(
          unseal<Message>(message.payload, restoredSecret).text,
        )?.[0];
        assert.ok(restoredKey);
        assert.equal(
          await activate(restoredBase, publisher, restoredKey),
          publisher.token,
        );
        const path: string = `/api/v1/tenants/${tenant.slug}/packages/${publisher.release.id}`;
        assert.equal((await get(restoredBase, path)).status, 401);
        const response = await get(restoredBase, path, publisher.token);
        assert.equal(response.status, 200);
        assert.deepEqual(response.bytes, publisher.archive);
        assert.equal(response.bytes.length, Number(publisher.release.size));
        assert.equal(digest(response.bytes), publisher.release.checksum);
        assert.equal(
          response.headers.get("x-checksum-sha256"),
          publisher.release.checksum,
        );
        const other: Publisher = publishers.find(
          (value) => value.tenant.id !== tenant.id,
        )!;
        assert.equal((await get(restoredBase, path, other.token)).status, 401);
        assert.equal(
          (
            await get(
              restoredBase,
              `/api/v1/tenants/${tenant.slug}/packages/${publisher.withdrawn.id}`,
              publisher.token,
            )
          ).status,
          404,
        );
        const withdrawn: Release | undefined = await db<Release>("releases")
          .where({ tenant_id: tenant.id, id: publisher.withdrawn.id })
          .first();
        assert.equal(withdrawn?.withdrawn, 1);
        assert.equal(
          digest(
            await restoredStore.get(
              tenant.id,
              withdrawn!.id,
              withdrawn!.checksum,
              Number(withdrawn!.size),
            ),
          ),
          withdrawn!.checksum,
        );
        let resolved = 0,
          snapshots = 0;
        const billing = new Billing(
          db,
          new Licenses(db, restoredSecret, [], tenant),
          {
            snapshot: async () => {
              snapshots++;
              return structuredClone(publisher.snapshot);
            },
          },
        );
        await billing.receive(publisher.event);
        await billing.run(async () => {
          resolved++;
          return publisher.snapshot.subscriptionId;
        });
        assert.equal(resolved, 0);
        assert.equal(snapshots, 0);
        assert.deepEqual(
          (await db<License>("licenses").where({ tenant_id: tenant.id })).map(
            (row) => row.id,
          ),
          [publisher.licenseId],
        );
        assert.deepEqual(
          (await db("grants").where({ tenant_id: tenant.id })).map(
            (row) => row.id,
          ),
          [publisher.grantId],
        );
        assert.equal(
          (
            await db("billing_events").where({
              tenant_id: tenant.id,
              id: publisher.event.id,
            })
          ).length,
          1,
        );
        assert.equal(
          Number(
            (
              await db("billing_events")
                .where({ tenant_id: tenant.id, id: publisher.event.id })
                .first()
            ).processed_at,
          ),
          publisher.processedAt,
        );
        assert.equal(
          (
            await db("work")
              .where({ tenant_id: tenant.id, id: publisher.event.id })
              .first()
          ).state,
          publisher.workState,
        );
      }
      t.diagnostic(
        `Restored SQLite ${saved.sqlite}: authenticated HTTP package size/SHA256, tenant isolation, withdrawn retention, original activation tokens and processed-event deduplication verified.`,
      );
    } finally {
      try {
        await app?.close();
      } finally {
        try {
          await db?.destroy();
        } finally {
          try {
            for (const bucket of ownedBuckets) {
              const list = await client.send(
                new ListObjectsV2Command({ Bucket: bucket }),
              );
              assert.ok(!list.IsTruncated);
              if (list.Contents?.length)
                await client.send(
                  new DeleteObjectsCommand({
                    Bucket: bucket,
                    Delete: {
                      Objects: list.Contents.map((object) => ({
                        Key: object.Key!,
                      })),
                    },
                  }),
                );
              await client.send(new DeleteBucketCommand({ Bucket: bucket }));
            }
          } finally {
            client.destroy();
            await rm(root, { recursive: true, force: true });
          }
        }
      }
    }
  },
);
