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
  stat,
  writeFile,
} from "node:fs/promises";
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetBucketPolicyCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { buildApp } from "../src/app.ts";
import { Artifacts } from "../src/artifacts.ts";
import { loadConfig } from "../src/config.ts";
import { hash, unseal } from "../src/crypto.ts";
import {
  createDb,
  createTenant,
  migrate,
  type DB,
  type License,
  type Release,
  type ReleaseAsset,
  type Tenant,
} from "../src/db.ts";
import { Licenses } from "../src/licensing.ts";
import { Releases } from "../src/releases.ts";
import {
  S3ArtifactStore,
  type S3ArtifactStoreOptions,
} from "../src/storage.ts";

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const sha512 = (bytes: Buffer) =>
  createHash("sha512").update(bytes).digest("base64");
interface PublishedAsset {
  asset: ReleaseAsset;
  bytes: Buffer;
}
interface Publisher {
  tenant: Tenant;
  productId: string;
  licenseId: string;
  customerId: string;
  key: string;
  session: string;
  intruderSession: string;
  installationId: string;
  token: string;
  release: Release;
  assets: PublishedAsset[];
  withdrawn: Release;
  withdrawnAsset: PublishedAsset;
  cachedPaths: Map<string, string>;
}
interface SavedObject {
  tenantId: string;
  assetId: string;
  releaseId: string;
  target: string;
  key: string;
  filename: string;
  checksum: string;
  sha512: string;
  size: number;
  withdrawn: number;
  file: string;
}
interface Manifest {
  databaseChecksum: string;
  migrations: string[];
  objects: SavedObject[];
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
    slug: `framework-restore-${randomUUID()}`,
    name: `Restore ${label}`,
    exempt: 1,
  });
  const productId = randomUUID(),
    planId = randomUUID(),
    customerId = randomUUID(),
    licenseId = randomUUID();
  const now = Date.now(),
    paidThrough = now + 86400000;
  const key = `DE-${randomBytes(32).toString("base64url")}`;
  const session = randomBytes(32).toString("base64url"),
    intruderSession = randomBytes(32).toString("base64url");
  const intruderId = randomUUID();
  const license: License = {
    tenant_id: tenant.id,
    id: licenseId,
    product_id: productId,
    customer_id: customerId,
    plan_id: planId,
    site_allowance: 2,
    paid_through: paidThrough,
    billing_status: "active",
    subscription_id: "sub_framework_restore",
    key_hash: hash(key),
    revoked: 0,
    refund_revoked: 0,
    suspended: 0,
    lock_version: 0,
  };
  await db.transaction(async (tx) => {
    await tx("products").insert({
      tenant_id: tenant.id,
      id: productId,
      slug: "desktop-app",
      name: `Desktop ${label}`,
      framework: "generic",
      framework_config: JSON.stringify({ activationKind: "device" }),
    });
    await tx("plans").insert({
      tenant_id: tenant.id,
      id: planId,
      product_id: productId,
      name: "Paid fixture",
      site_allowance: 2,
      stripe_price_id: "price_framework_restore",
    });
    await tx("customers").insert([
      {
        tenant_id: tenant.id,
        id: customerId,
        email: "buyer@example.test",
        stripe_id: "cus_framework_restore",
      },
      {
        tenant_id: tenant.id,
        id: intruderId,
        email: "intruder@example.test",
        stripe_id: null,
      },
    ]);
    await tx("licenses").insert(license);
    await tx("grants").insert({
      tenant_id: tenant.id,
      id: randomUUID(),
      license_id: licenseId,
      plan_id: planId,
      invoice_id: "invoice_framework_restore",
      period_start: now - 1000,
      period_end: paidThrough,
      paid_at: now,
    });
    await new Licenses(db, secret, [], tenant).keyEmail(tx, license, key);
    await tx("sessions").insert([
      {
        tenant_id: tenant.id,
        id: hash(session),
        customer_id: customerId,
        expires_at: paidThrough,
      },
      {
        tenant_id: tenant.id,
        id: hash(intruderSession),
        customer_id: intruderId,
        expires_at: paidThrough,
      },
    ]);
  });
  const artifacts = new Artifacts(db, store, tenant);
  async function publish(version: string, target: string) {
    const bytes = Buffer.concat([
      Buffer.from(`framework restore ${label} ${version} ${target}\n`),
      randomBytes(64),
    ]);
    const file = `${root}/${tenant.id}-${version}-${target}.bin`;
    await writeFile(file, bytes, { mode: 0o600 });
    const result = await artifacts.publish({
      product: "desktop-app",
      version,
      file,
      target,
      filename: `${target}.bin`,
      changelog: "Immutable restore drill",
      minSystemVersion: "1.0",
    });
    return { ...result, bytes };
  }
  const first = await publish("1.0.0", "linux-x64");
  const second = await publish("1.0.0", "darwin-arm64");
  const old = await publish("0.9.0", "linux-x64");
  assert.equal(first.release.id, second.release.id);
  assert.equal(
    Number(second.release.size),
    first.bytes.length + second.bytes.length,
  );
  assert.equal(second.release.checksum, first.asset.checksum);
  assert.notEqual(second.asset.checksum, first.asset.checksum);
  await new Releases(db, store, tenant, `${root}/publication-work`).withdraw(
    old.release.id,
  );
  return {
    tenant,
    productId,
    customerId,
    licenseId,
    key,
    session,
    intruderSession,
    installationId: randomUUID(),
    token: "",
    release: second.release,
    assets: [
      { asset: first.asset, bytes: first.bytes },
      { asset: second.asset, bytes: second.bytes },
    ],
    withdrawn: old.release,
    withdrawnAsset: { asset: old.asset, bytes: old.bytes },
    cachedPaths: new Map(),
  };
}

test(
  "stopped SQLite and exact private S3 asset backups restore multi-target framework downloads and isolation",
  { skip: process.env.TEST_S3_INTEGRATION !== "true" },
  async (t) => {
    const endpoint = process.env.TEST_S3_ENDPOINT;
    assert.ok(endpoint, "TEST_S3_ENDPOINT is required");
    const endpointUrl = new URL(endpoint);
    assert.ok(
      ["127.0.0.1", "localhost", "[::1]"].includes(endpointUrl.hostname),
      "Restore writes require the explicit local fixture",
    );
    assert.ok(
      ["http:", "https:"].includes(endpointUrl.protocol) &&
        !endpointUrl.username &&
        !endpointUrl.password &&
        !endpointUrl.search &&
        !endpointUrl.hash,
    );
    const accessKeyId = process.env.TEST_S3_ACCESS_KEY_ID,
      secretAccessKey = process.env.TEST_S3_SECRET_ACCESS_KEY;
    assert.ok(
      accessKeyId && secretAccessKey,
      "Explicit local fixture credentials are required",
    );
    const options: Omit<S3ArtifactStoreOptions, "bucket"> = {
      endpoint,
      region: "us-east-1",
      credentials: { accessKeyId, secretAccessKey },
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
        socketTimeout: 3000,
        throwOnRequestTimeout: true,
      },
    });
    const sourceBucket = `framework-src-${randomUUID()}`,
      targetBucket = `framework-dst-${randomUUID()}`;
    const sourceStore = new S3ArtifactStore({
      ...options,
      bucket: sourceBucket,
    });
    const root = await mkdtemp(
      "/Volumes/Scratch/entitle/tmp/framework-backup-",
    );
    const originalDirectory = `${root}/original`,
      backup = `${root}/backup`,
      restoredDirectory = `${root}/restored`;
    const ownedBuckets = new Set<string>();
    const secret = randomBytes(32).toString("hex"),
      operatorToken = randomBytes(32).toString("hex");
    let db: DB | undefined,
      app: Awaited<ReturnType<typeof buildApp>> | undefined;
    function config(directory: string, restoredSecret: string, bucket: string) {
      return loadConfig({ DEPLOYMENT_MODE: "hosted",
        NODE_ENV: "test",
        APP_SECRET: restoredSecret,
        OPERATOR_TOKEN: operatorToken,
        DATABASE_URL: `sqlite:${directory}/entitle.sqlite`,
        DATA_DIR: directory,
        WORK_DIR: `${directory}/work`,
        WEB_DIR: `${root}/web`,
        PUBLIC_ORIGIN: "http://localhost:3211",
        LOCAL_BILLING: "true",
        S3_ENDPOINT: endpoint!,
        S3_REGION: "us-east-1",
        S3_BUCKET: bucket,
        S3_ACCESS_KEY_ID: accessKeyId!,
        S3_SECRET_ACCESS_KEY: secretAccessKey!,
        S3_FORCE_PATH_STYLE: "true",
        S3_ALLOW_HTTP: "true",
      });
    }
    async function get(
      base: string,
      path: string,
      headers: Record<string, string> = {},
      method: "GET" | "HEAD" = "GET",
    ) {
      const response = await fetch(base + path, {
        method,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      return {
        status: response.status,
        headers: response.headers,
        bytes: Buffer.from(await response.arrayBuffer()),
      };
    }
    async function activate(
      base: string,
      publisher: Publisher,
      licenseKey: string,
    ) {
      const response = await fetch(
        `${base}/api/v1/tenants/${publisher.tenant.slug}/activate`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            key: licenseKey,
            product: "desktop-app",
            installationId: publisher.installationId,
            installationLabel: "Restore laptop",
          }),
          redirect: "error",
          signal: AbortSignal.timeout(10000),
        },
      );
      assert.equal(
        response.status,
        200,
        "Paid device activation must survive restore",
      );
      return ((await response.json()) as { token: string }).token;
    }
    const assetPath = (publisher: Publisher, asset: ReleaseAsset) =>
      `/api/v1/tenants/${publisher.tenant.slug}/packages/desktop-app/assets/${asset.id}/${encodeURIComponent(asset.filename)}`;
    async function bucketKeys(bucket: string) {
      const list = await client.send(
        new ListObjectsV2Command({ Bucket: bucket }),
      );
      assert.ok(
        !list.IsTruncated,
        "The isolated six-object inventory must be complete",
      );
      return (list.Contents ?? []).map((object) => object.Key!).sort();
    }
    async function destroyBucket(bucket: string) {
      assert.ok(
        ownedBuckets.has(bucket),
        "Only task-created buckets may be deleted",
      );
      const keys = await bucketKeys(bucket);
      if (keys.length) {
        const result = await client.send(
          new DeleteObjectsCommand({
            Bucket: bucket,
            Delete: { Objects: keys.map((Key) => ({ Key })) },
          }),
        );
        assert.deepEqual(result.Errors ?? [], []);
      }
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
      ownedBuckets.delete(bucket);
    }
    async function anonymousDenied(bucket: string, key: string) {
      const response = await fetch(`${endpoint}/${bucket}/${key}`, {
        redirect: "error",
        signal: AbortSignal.timeout(3000),
      });
      assert.equal(response.status, 403);
      await response.body?.cancel();
    }
    try {
      await client.send(new CreateBucketCommand({ Bucket: sourceBucket }));
      ownedBuckets.add(sourceBucket);
      await assert.rejects(
        client.send(new GetBucketPolicyCommand({ Bucket: sourceBucket })),
        { name: "NoSuchBucketPolicy" },
      );
      await sourceStore.ready();
      db = createDb(`sqlite:${originalDirectory}/entitle.sqlite`);
      await migrate(db);
      await writeFile(`${originalDirectory}/APP_SECRET`, secret, {
        mode: 0o600,
        flag: "wx",
      });
      const publishers = [
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
        for (const { asset, bytes } of publisher.assets) {
          const headers = { authorization: `Bearer ${publisher.token}` };
          const response = await get(
            sourceBase,
            assetPath(publisher, asset),
            headers,
          );
          assert.equal(response.status, 200);
          assert.deepEqual(response.bytes, bytes);
          const feed = await get(
            sourceBase,
            `/api/v1/tenants/${publisher.tenant.slug}/updates/generic/desktop-app/${asset.target}`,
            headers,
          );
          assert.equal(feed.status, 200);
          const value = JSON.parse(feed.bytes.toString()) as {
            version: string;
            assets: {
              target: string;
              filename: string;
              size: number;
              sha256: string;
              sha512: string;
              url: string;
            }[];
          };
          assert.equal(value.version, "1.0.0");
          assert.equal(value.assets.length, 1);
          assert.equal(value.assets[0]!.target, asset.target);
          assert.equal(value.assets[0]!.filename, asset.filename);
          assert.equal(value.assets[0]!.size, Number(asset.size));
          assert.equal(value.assets[0]!.sha256, asset.checksum);
          assert.equal(value.assets[0]!.sha512, asset.sha512);
          const url = new URL(value.assets[0]!.url);
          assert.ok(!url.username && !url.password && !url.search && !url.hash);
          assert.equal(url.pathname, assetPath(publisher, asset));
          publisher.cachedPaths.set(asset.id, url.pathname);
        }
      }
      const migrations = (await db("knex_migrations")
        .orderBy("name")
        .pluck("name")) as string[];
      const assetRows = await db<ReleaseAsset>("release_assets").orderBy("id");
      const releaseRows = await db<Release>("releases").orderBy("id");
      assert.equal(assetRows.length, 6);
      assert.equal(releaseRows.length, 4);
      const trackedTables = [
        "products",
        "plans",
        "customers",
        "licenses",
        "grants",
        "installations",
        "emails",
        "sessions",
        "releases",
        "release_assets",
      ];
      const before = new Map<string, unknown[]>();
      for (const table of trackedTables)
        before.set(table, await db(table).orderBy("id"));
      await app.close();
      app = undefined;
      await db.destroy();
      db = undefined;
      t.diagnostic(
        "Stopped only the isolated app/SQLite pool before copying the complete directory and APP_SECRET.",
      );
      await mkdir(`${backup}/objects`, { recursive: true, mode: 0o700 });
      await cp(originalDirectory, `${backup}/database`, {
        recursive: true,
        preserveTimestamps: true,
      });
      const databaseChecksum = sha256(
        await readFile(`${backup}/database/entitle.sqlite`),
      );
      assert.equal(
        databaseChecksum,
        sha256(await readFile(`${originalDirectory}/entitle.sqlite`)),
      );
      assert.equal(
        (await stat(`${backup}/database/APP_SECRET`)).mode & 0o777,
        0o600,
      );
      const objects: SavedObject[] = [];
      for (const asset of assetRows) {
        const release = releaseRows.find(
          (value) => value.id === asset.release_id,
        )!;
        assert.notEqual(
          asset.id,
          release.id,
          "Framework objects use asset IDs, not parent release IDs",
        );
        const bytes = await sourceStore.get(
          asset.tenant_id,
          asset.id,
          asset.checksum,
          Number(asset.size),
        );
        assert.equal(sha512(bytes), asset.sha512);
        const file = `objects/${asset.id}.bin`;
        await writeFile(`${backup}/${file}`, bytes, {
          mode: 0o600,
          flag: "wx",
        });
        objects.push({
          tenantId: asset.tenant_id,
          assetId: asset.id,
          releaseId: asset.release_id,
          target: asset.target,
          key: `tenants/${asset.tenant_id}/releases/${asset.id}.zip`,
          filename: asset.filename,
          checksum: asset.checksum,
          sha512: asset.sha512,
          size: Number(asset.size),
          withdrawn: release.withdrawn,
          file,
        });
      }
      const keys = objects.map((object) => object.key).sort();
      assert.deepEqual(await bucketKeys(sourceBucket), keys);
      assert.equal(objects.filter((object) => object.withdrawn).length, 2);
      await anonymousDenied(sourceBucket, objects[0]!.key);
      await writeFile(
        `${backup}/manifest.json`,
        JSON.stringify({
          databaseChecksum,
          migrations,
          objects,
        } satisfies Manifest),
        { mode: 0o600, flag: "wx" },
      );
      t.diagnostic(
        "Exported all six exact generated asset object keys, including both second targets and both withdrawn objects.",
      );
      await destroyBucket(sourceBucket);
      await rm(originalDirectory, { recursive: true, force: true });
      await assert.rejects(access(`${originalDirectory}/entitle.sqlite`), {
        code: "ENOENT",
      });
      await assert.rejects(access(`${originalDirectory}/APP_SECRET`), {
        code: "ENOENT",
      });
      t.diagnostic(
        "Deleted the isolated original private bucket and original SQLite/secret directory before restoration.",
      );
      const saved = JSON.parse(
        await readFile(`${backup}/manifest.json`, "utf8"),
      ) as Manifest;
      assert.equal(
        sha256(await readFile(`${backup}/database/entitle.sqlite`)),
        saved.databaseChecksum,
      );
      await cp(`${backup}/database`, restoredDirectory, {
        recursive: true,
        preserveTimestamps: true,
      });
      assert.equal(
        sha256(await readFile(`${restoredDirectory}/entitle.sqlite`)),
        saved.databaseChecksum,
      );
      const restoredSecret = await readFile(
        `${restoredDirectory}/APP_SECRET`,
        "utf8",
      );
      assert.ok(
        hash(restoredSecret) === hash(secret),
        "The matching APP_SECRET must restore without logging its value",
      );
      assert.equal(
        (await stat(`${restoredDirectory}/APP_SECRET`)).mode & 0o777,
        0o600,
      );
      await client.send(new CreateBucketCommand({ Bucket: targetBucket }));
      ownedBuckets.add(targetBucket);
      await assert.rejects(
        client.send(new GetBucketPolicyCommand({ Bucket: targetBucket })),
        { name: "NoSuchBucketPolicy" },
      );
      const restoredStore = new S3ArtifactStore({
        ...options,
        bucket: targetBucket,
      });
      for (const object of saved.objects) {
        const bytes = await readFile(`${backup}/${object.file}`);
        assert.equal(bytes.length, object.size);
        assert.equal(sha256(bytes), object.checksum);
        assert.equal(sha512(bytes), object.sha512);
        assert.equal(
          object.key,
          `tenants/${object.tenantId}/releases/${object.assetId}.zip`,
        );
        await restoredStore.put(
          object.tenantId,
          object.assetId,
          bytes,
          object.checksum,
        );
      }
      assert.deepEqual(await bucketKeys(targetBucket), keys);
      for (const object of saved.objects)
        await anonymousDenied(targetBucket, object.key);
      db = createDb(`sqlite:${restoredDirectory}/entitle.sqlite`);
      await migrate(db);
      assert.deepEqual(
        await db("knex_migrations").orderBy("name").pluck("name"),
        saved.migrations,
      );
      assert.equal(
        (await db.raw("pragma integrity_check"))[0].integrity_check,
        "ok",
      );
      assert.deepEqual(await db.raw("pragma foreign_key_check"), []);
      for (const table of trackedTables)
        assert.deepEqual(
          await db(table).orderBy("id"),
          before.get(table),
          `${table} rows must restore exactly`,
        );
      assert.equal((await db("upload_reservations")).length, 0);
      app = await buildApp(
        config(restoredDirectory, restoredSecret, targetBucket),
        db,
        { send: async () => {} },
        { store: restoredStore },
      );
      const restoredBase = await app.listen({ host: "127.0.0.1", port: 0 });
      assert.equal((await get(restoredBase, "/api/v1/ready")).status, 200);
      for (const publisher of publishers) {
        const other = publishers.find(
          (value) => value.tenant.id !== publisher.tenant.id,
        )!;
        const email: { payload: string } | undefined = await db("emails")
          .where({
            tenant_id: publisher.tenant.id,
            license_id: publisher.licenseId,
            kind: "license_key",
          })
          .first();
        assert.ok(email);
        const message: { text: string } = unseal<{ text: string }>(
          email.payload,
          restoredSecret,
        );
        const restoredKey: string | undefined =
          /Your license key is (DE-[A-Za-z0-9_-]+)/.exec(message.text)?.[1];
        assert.ok(
          restoredKey && restoredKey === publisher.key,
          "The restored secret must decrypt the original license-key email",
        );
        const restoredToken = await activate(
          restoredBase,
          publisher,
          restoredKey,
        );
        assert.ok(
          restoredToken === publisher.token,
          "Reactivation must decrypt and return the pre-backup device token",
        );
        const installation:
          { site_url: string; label: string | null } | undefined = await db(
          "installations",
        )
          .where({
            tenant_id: publisher.tenant.id,
            installation_id: publisher.installationId,
          })
          .first();
        assert.ok(installation);
        assert.equal(
          installation.site_url,
          `device:${publisher.installationId}`,
        );
        assert.equal(installation.label, "Restore laptop");
        const headers = { authorization: `Bearer ${publisher.token}` };
        for (const { asset, bytes } of publisher.assets) {
          const path = publisher.cachedPaths.get(asset.id)!;
          assert.equal((await get(restoredBase, path)).status, 401);
          const response = await get(restoredBase, path, headers);
          assert.equal(response.status, 200);
          assert.deepEqual(response.bytes, bytes);
          assert.equal(response.bytes.length, Number(asset.size));
          assert.equal(sha256(response.bytes), asset.checksum);
          assert.equal(sha512(response.bytes), asset.sha512);
          assert.equal(
            response.headers.get("content-length"),
            String(asset.size),
          );
          assert.equal(
            response.headers.get("x-checksum-sha256"),
            asset.checksum,
          );
          assert.equal(response.headers.get("cache-control"), "no-store");
          const ranged = await get(restoredBase, path, {
            ...headers,
            range: "bytes=1-7",
          });
          assert.equal(ranged.status, 206);
          assert.deepEqual(ranged.bytes, bytes.subarray(1, 8));
          assert.equal(
            ranged.headers.get("content-range"),
            `bytes 1-7/${asset.size}`,
          );
          assert.equal(ranged.headers.get("content-length"), "7");
          const head = await get(restoredBase, path, headers, "HEAD");
          assert.equal(head.status, 200);
          assert.equal(head.bytes.length, 0);
          assert.equal(head.headers.get("content-length"), String(asset.size));
          assert.equal(
            (
              await get(restoredBase, path, {
                authorization: `Bearer ${other.token}`,
              })
            ).status,
            401,
          );
          const wrongTenant = path.replace(
            publisher.tenant.slug,
            other.tenant.slug,
          );
          assert.equal(
            (await get(restoredBase, wrongTenant, headers)).status,
            401,
          );
          assert.equal(
            (
              await get(restoredBase, wrongTenant, {
                authorization: `Bearer ${other.token}`,
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await get(
                restoredBase,
                path.replace(asset.filename, "wrong.bin"),
                headers,
              )
            ).status,
            404,
          );
          assert.equal(
            (
              await get(
                restoredBase,
                path.replace("/packages/desktop-app/", "/packages/wrong-app/"),
                headers,
              )
            ).status,
            403,
          );
          const buyerPath = `/api/v1/tenants/${publisher.tenant.slug}/licenses/${publisher.licenseId}/assets/${asset.id}/download`;
          const buyer = await get(restoredBase, buyerPath, {
            cookie: `de-session-${publisher.tenant.id}=${publisher.session}`,
          });
          assert.equal(buyer.status, 200);
          assert.deepEqual(buyer.bytes, bytes);
          assert.equal(
            (
              await get(restoredBase, buyerPath, {
                cookie: `de-session-${publisher.tenant.id}=${publisher.intruderSession}`,
              })
            ).status,
            404,
          );
          const feed = await get(
            restoredBase,
            `/api/v1/tenants/${publisher.tenant.slug}/updates/generic/desktop-app/${asset.target}`,
            headers,
          );
          assert.equal(feed.status, 200);
          const value = JSON.parse(feed.bytes.toString()) as {
            version: string;
            assets: {
              target: string;
              filename: string;
              size: number;
              sha256: string;
              sha512: string;
              url: string;
            }[];
          };
          assert.equal(value.version, "1.0.0");
          assert.equal(value.assets[0]!.target, asset.target);
          assert.equal(value.assets[0]!.filename, asset.filename);
          assert.equal(value.assets[0]!.size, Number(asset.size));
          assert.equal(value.assets[0]!.sha256, asset.checksum);
          assert.equal(value.assets[0]!.sha512, asset.sha512);
          assert.equal(new URL(value.assets[0]!.url).pathname, path);
        }
        const oldAsset = publisher.withdrawnAsset.asset;
        assert.equal(
          (await get(restoredBase, assetPath(publisher, oldAsset), headers))
            .status,
          404,
        );
        const oldBuyerPath = `/api/v1/tenants/${publisher.tenant.slug}/licenses/${publisher.licenseId}/assets/${oldAsset.id}/download`;
        assert.equal(
          (
            await get(restoredBase, oldBuyerPath, {
              cookie: `de-session-${publisher.tenant.id}=${publisher.session}`,
            })
          ).status,
          404,
        );
        assert.deepEqual(
          await restoredStore.get(
            publisher.tenant.id,
            oldAsset.id,
            oldAsset.checksum,
            Number(oldAsset.size),
          ),
          publisher.withdrawnAsset.bytes,
        );
        const parent: Release | undefined = await db<Release>("releases")
          .where({ tenant_id: publisher.tenant.id, id: publisher.withdrawn.id })
          .first();
        assert.equal(parent!.withdrawn, 1);
        const total: { bytes?: number | string | null } | undefined = await db(
          "releases",
        )
          .where({ tenant_id: publisher.tenant.id })
          .sum({ bytes: "size" })
          .first();
        assert.equal(
          Number(total!.bytes),
          publisher.assets.reduce((sum, item) => sum + item.bytes.length, 0) +
            publisher.withdrawnAsset.bytes.length,
        );
      }
      assert.deepEqual(
        await bucketKeys(targetBucket),
        keys,
        "HTTP denial and parent withdrawal must retain all restored objects",
      );
      t.diagnostic(
        "Fresh private-bucket restore passed real HTTP GET/SHA256/SHA512/size, HEAD/ranges, original activation-token decryption, cached URLs, buyer/tenant isolation, immutable target identity and withdrawn-object retention.",
      );
    } finally {
      try {
        await app?.close();
      } finally {
        try {
          await db?.destroy();
        } finally {
          try {
            for (const bucket of [...ownedBuckets]) await destroyBucket(bucket);
          } finally {
            client.destroy();
            await rm(root, { recursive: true, force: true });
          }
        }
      }
    }
  },
);
