import { randomUUID, createHash } from "node:crypto";
import {
  constants,
  createReadStream,
  createWriteStream,
  fstatSync,
  readSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { isatty } from "node:tty";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import {
  S3Client,
  HeadBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { z } from "zod";
import { loadConfig, type Config } from "./config.ts";
import { createDb, migrate, type DB, type Tenant } from "./db.ts";
import { AppError, check } from "./errors.ts";
import { unseal } from "./crypto.ts";
import { Auth } from "./auth.ts";
import { CustomerAccounts } from "./account-management.ts";
import { Billing, type BillingEvent } from "./billing.ts";
import { Licenses } from "./licensing.ts";
import { StripeBilling } from "./stripe.ts";
import { hashArtifactFile } from "./artifact-streams.ts";
import {
  MAX_NATIVE_ARTIFACT_BYTES,
  MAX_ARTIFACT_BYTES,
  type ArtifactStore,
} from "./storage.ts";
import {
  importPortability,
  completePortabilityImport,
  verifyEmptyPrivatePortabilityBucket,
} from "./portability.ts";

const identifier = z.string().trim().min(1).max(200);
const receiptSchema = z
  .object({
    version: z.literal(1),
    operatorId: identifier,
    tenantId: identifier,
    customerId: identifier,
    requestId: identifier,
    stripeLiveMode: z.boolean().optional(),
    approval: z
      .object({
        quiesced: z.literal(true),
        stripeReconciled: z.literal(true),
        retentionReviewed: z.literal(true),
        reference: identifier,
        stripeCustomerId: z.string().min(1).max(150).nullable(),
        eventIds: z.array(identifier).max(1000),
        workIds: z.array(identifier).max(1000),
        auditIds: z.array(identifier).max(1000),
        outgoingEventIds: z.array(identifier).max(1000),
      })
      .strict(),
  })
  .strict();
const eventSchema = z.object({
  id: identifier,
  type: identifier,
  data: z.object({ object: z.record(z.string(), z.unknown()) }),
});
const commands = {
  import: ["bundle", "directory", "expected-stripe-account", "passphrase-fd"],
  finalize: ["expected-stripe-account"],
  closures: ["tenant", "limit", "after"],
  "closure-inspect": ["tenant", "customer", "request"],
  "closure-reconcile": ["tenant", "customer", "request", "receipt"],
  "closure-approve": ["tenant", "customer", "request", "receipt"],
  "closure-attribution-upgrade": ["tenant", "customer", "request", "receipt"],
} as const;
type Command = keyof typeof commands;

function options(argv: string[]) {
  const parsed = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      operator: { type: "string" },
      quiesced: { type: "boolean" },
      tenant: { type: "string" },
      customer: { type: "string" },
      request: { type: "string" },
      receipt: { type: "string" },
      bundle: { type: "string" },
      directory: { type: "string" },
      "expected-stripe-account": { type: "string" },
      "passphrase-fd": { type: "string" },
      limit: { type: "string" },
      after: { type: "string" },
    },
  });
  const command = parsed.positionals[0];
  check(
    parsed.positionals.length === 1 &&
      command !== undefined &&
      Object.hasOwn(commands, command),
    400,
    "maintenance_usage",
    "Choose a maintenance command.",
  );
  const selected = command as Command;
  for (const key of Object.keys(parsed.values))
    check(
      ["operator", "quiesced", ...commands[selected]].includes(key),
      400,
      "maintenance_usage",
      "Unexpected command option.",
    );
  check(
    parsed.values.quiesced === true,
    409,
    "maintenance_required",
    "Stop all writers and wait for in-flight Stripe/SMTP calls first.",
  );
  const operator = identifier.parse(parsed.values.operator);
  return { command: selected, values: parsed.values, operator };
}

/** Reads inherited descriptors only. Never prompts on a terminal or reads env/argv secrets. */
export function readMaintenancePassphrase(fd: number) {
  check(
    Number.isSafeInteger(fd) && fd >= 0 && !isatty(fd),
    400,
    "private_input_required",
    "Use a private pipe or file descriptor.",
  );
  const info = fstatSync(fd);
  check(
    (info.isFile() || info.isFIFO()) &&
      info.uid === process.getuid!() &&
      (info.mode & 0o077) === 0,
    400,
    "private_input_required",
    "Use an owner-only file or pipe.",
  );
  const bytes = Buffer.alloc(4099);
  try {
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    const value = bytes
      .subarray(0, size)
      .toString("utf8")
      .replace(/\r?\n$/, "");
    check(
      size < bytes.length &&
        Buffer.from(bytes.subarray(0, size).toString("utf8")).equals(
          bytes.subarray(0, size),
        ) &&
        value.length >= 12 &&
        value.length <= 1024 &&
        !/[\r\n\0]/.test(value),
      400,
      "private_input_required",
      "Passphrase must be one UTF-8 line of 12-1024 characters.",
    );
    return value;
  } finally {
    bytes.fill(0);
  }
}

async function reviewedReceipt(file: string) {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    check(
      info.isFile() &&
        info.uid === process.getuid!() &&
        (info.mode & 0o077) === 0 &&
        info.size <= 262144,
      400,
      "private_receipt_required",
      "Use an owner-only regular JSON file, at most 256 KiB.",
    );
    const bytes = Buffer.alloc(262145);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    check(
      bytesRead <= 262144,
      400,
      "private_receipt_required",
      "Receipt is too large.",
    );
    return receiptSchema.parse(
      JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")),
    );
  } finally {
    await handle.close();
  }
}

type S3 = Pick<S3Client, "send" | "destroy">;
/** Import-only adapter. The caller owns this SDK client and closes it in finally. */
export function maintenanceStorage(config: Config, client?: S3) {
  check(
    config.s3,
    500,
    "storage_configuration",
    "Configure private S3 storage.",
  );
  const settings = config.s3;
  const sdk =
    client ??
    new S3Client({
      ...settings,
      maxAttempts: 1,
      followRegionRedirects: false,
      requestHandler: {
        connectionTimeout: 10000,
        requestTimeout: 120000,
        socketTimeout: 120000,
        throwOnRequestTimeout: true,
      },
    });
  const key = (tenant: string, id: string) => {
    check(
      tenant === "primary" &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id),
      400,
      "invalid_artifact_key",
      "Invalid import artifact.",
    );
    return `tenants/${tenant}/releases/${id}.zip`;
  };
  const sendOptions = () => ({ abortSignal: AbortSignal.timeout(120000) });
  const metadata = (checksum: string, size: number, max: number) =>
    check(
      /^[a-f0-9]{64}$/.test(checksum) &&
        Number.isSafeInteger(size) &&
        size > 0 &&
        size <= max,
      400,
      "invalid_artifact",
      "Invalid import artifact.",
    );
  // Match the artifact store's idle/size deadline policy without sharing SDK ownership.
  const transfer = async <T>(
    size: number,
    work: (
      signal: AbortSignal,
      progress: () => void,
      totalMs: number,
    ) => Promise<T>,
  ) => {
    const controller = new AbortController();
    const totalMs = 120000 + Math.ceil((1000 * size) / (1024 * 1024));
    let idleTimer: NodeJS.Timeout;
    let totalTimer: NodeJS.Timeout;
    let expire!: () => void;
    const deadline = new Promise<never>((_resolve, reject) => {
      expire = () => {
        controller.abort();
        reject(controller.signal.reason);
      };
      totalTimer = setTimeout(expire, totalMs);
    });
    const progress = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(expire, 120000);
    };
    progress();
    try {
      return await Promise.race([
        work(controller.signal, progress, totalMs),
        deadline,
      ]);
    } finally {
      clearTimeout(idleTimer!);
      clearTimeout(totalTimer!);
    }
  };
  const put = async (
    tenant: string,
    id: string,
    body: Buffer | Readable,
    checksum: string,
    size: number,
  ) => {
    const source = Buffer.isBuffer(body) ? Readable.from([body]) : body;
    try {
      await transfer(size, async (signal, progress, totalMs) => {
        let count = 0;
        const upload = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            count += chunk.length;
            if (count > size) {
              done(
                new AppError(
                  503,
                  "artifact_integrity",
                  "Artifact exceeds expected size.",
                ),
              );
              return;
            }
            progress();
            done(null, chunk);
          },
          flush(done) {
            done(
              count === size
                ? null
                : new AppError(
                    503,
                    "artifact_integrity",
                    "Artifact length changed.",
                  ),
            );
          },
        });
        try {
          await Promise.all([
            sdk.send(
              new PutObjectCommand({
                Bucket: settings.bucket,
                Key: key(tenant, id),
                Body: upload,
                ContentLength: size,
                ContentType: "application/octet-stream",
                ChecksumSHA256: Buffer.from(checksum, "hex").toString("base64"),
                IfNoneMatch: "*",
              }),
              { abortSignal: signal, requestTimeout: totalMs },
            ),
            pipeline(source, upload, { signal }),
          ]);
        } finally {
          upload.destroy();
        }
      });
    } finally {
      source.destroy();
    }
  };
  const get = async (
    tenant: string,
    id: string,
    checksum: string,
    size: number,
    destination?: string,
  ) => {
    metadata(
      checksum,
      size,
      destination === undefined
        ? MAX_ARTIFACT_BYTES
        : MAX_NATIVE_ARTIFACT_BYTES,
    );
    return transfer(size, async (signal, progress, totalMs) => {
      const response = await sdk.send(
        new GetObjectCommand({ Bucket: settings.bucket, Key: key(tenant, id) }),
        { abortSignal: signal, requestTimeout: totalMs },
      );
      const body = response.Body;
      check(
        body instanceof Readable,
        503,
        "artifact_integrity",
        "Invalid storage response.",
      );
      const chunks: Buffer[] = [];
      let count = 0;
      const digest = createHash("sha256");
      const guard = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          count += chunk.length;
          if (count > size) {
            done(
              new AppError(
                503,
                "artifact_integrity",
                "Artifact exceeds expected size.",
              ),
            );
            return;
          }
          digest.update(chunk);
          progress();
          done(null, chunk);
        },
      });
      try {
        if (destination !== undefined)
          await pipeline(
            body,
            guard,
            createWriteStream(destination, { flags: "wx", mode: 0o600 }),
            { signal },
          );
        else
          await pipeline(
            body,
            guard,
            new Writable({
              write(chunk: Buffer, _encoding, done) {
                chunks.push(Buffer.from(chunk));
                done();
              },
            }),
            { signal },
          );
        check(
          count === size && digest.digest("hex") === checksum,
          503,
          "artifact_integrity",
          "Artifact integrity mismatch.",
        );
        return Buffer.concat(chunks);
      } finally {
        body.destroy();
        guard.destroy();
      }
    });
  };
  const store: ArtifactStore = {
    ready: async () => {
      await sdk.send(
        new HeadBucketCommand({ Bucket: settings.bucket }),
        sendOptions(),
      );
    },
    put: async (tenant, id, bytes, checksum) => {
      metadata(checksum, bytes.length, MAX_ARTIFACT_BYTES);
      check(
        createHash("sha256").update(bytes).digest("hex") === checksum,
        503,
        "artifact_integrity",
        "Artifact integrity mismatch.",
      );
      await put(tenant, id, bytes, checksum, bytes.length);
    },
    putFile: async (tenant, id, file, checksum, size) => {
      metadata(checksum, size, MAX_NATIVE_ARTIFACT_BYTES);
      check(
        (await hashArtifactFile(file, size)).checksum === checksum,
        503,
        "artifact_integrity",
        "Artifact integrity mismatch.",
      );
      const body = createReadStream(file);
      try {
        await put(tenant, id, body, checksum, size);
      } finally {
        body.destroy();
      }
    },
    get: (tenant, id, checksum, size) => get(tenant, id, checksum, size),
    getToFile: async (tenant, id, checksum, size, file) => {
      await get(tenant, id, checksum, size, file);
    },
    delete: async (tenant, id) => {
      await sdk.send(
        new DeleteObjectCommand({
          Bucket: settings.bucket,
          Key: key(tenant, id),
        }),
        sendOptions(),
      );
    },
  };
  return {
    store,
    verifyEmpty: () =>
      verifyEmptyPrivatePortabilityBucket(sdk, settings.bucket),
    close: () => sdk.destroy(),
  };
}

type Merchant = Pick<StripeBilling, "snapshot" | "resolveSubscription"> & {
  stripe: {
    accounts: { retrieve: (id: null) => Promise<{ id: string }> };
    events: { retrieve: (id: string) => Promise<unknown> };
  };
};
export interface MaintenanceDependencies {
  connect?: (url: string) => DB;
  closeDatabase?: (db: DB) => Promise<void>;
  stripe?: (db: DB, config: Config, tenant: Tenant) => Merchant;
  storage?: (config: Config) => ReturnType<typeof maintenanceStorage>;
  passphrase?: (fd: number) => string;
}
export interface MaintenanceIO {
  out: (value: string) => void;
  error: (value: string) => void;
}
const defaultIO: MaintenanceIO = {
  out: (value) => console.log(value),
  error: (value) => console.error(value),
};

async function execute(
  argv: string[],
  env: NodeJS.ProcessEnv,
  deps: MaintenanceDependencies,
) {
  const { command, values, operator } = options(argv);
  // Possession of valid local operator configuration is the local auth boundary.
  const config = loadConfig(env);
  const providerCommand = command === "import" || command === "finalize";
  let expected = "";
  if (providerCommand) {
    check(
      config.deploymentMode === "standalone" && !config.localBilling,
      409,
      "standalone_provider_required",
      "Use standalone direct Stripe credentials without LOCAL_BILLING.",
    );
    check(
      env.STRIPE_SECRET_KEY &&
        /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(env.STRIPE_SECRET_KEY),
      400,
      "stripe_configuration",
      "Explicit direct Stripe credentials are required.",
    );
    expected = z
      .string()
      .regex(/^acct_[A-Za-z0-9]+$/)
      .parse(values["expected-stripe-account"]);
    check(
      !config.standaloneStripeAccountId ||
        config.standaloneStripeAccountId === expected,
      409,
      "stripe_account_mismatch",
      "Expected merchant differs from configuration.",
    );
  }
  const tenantId = providerCommand
    ? "primary"
    : identifier.parse(values.tenant);
  const db = (deps.connect ?? createDb)(config.databaseUrl);
  let storage: ReturnType<typeof maintenanceStorage> | undefined;
  try {
    await migrate(db);
    const tenant = await db<Tenant>("tenants").where({ id: tenantId }).first();
    check(tenant, 404, "tenant_not_found", "Tenant was not found.");
    const audit = async (action: string) => {
      await db("audit_events").insert({
        id: randomUUID(),
        tenant_id: tenant.id,
        actor_type: "operator",
        actor_id: operator,
        action,
        details: "{}",
        created_at: Date.now(),
      });
    };
    if (providerCommand) {
      check(
        !tenant.stripe_account_id,
        409,
        "standalone_tenant",
        "Direct merchant credentials are required.",
      );
      const source = (
        deps.stripe ??
        ((db, config, tenant) => new StripeBilling(db, config, tenant))
      )(db, config, tenant);
      const account = await source.stripe.accounts.retrieve(null);
      check(
        account.id === expected,
        409,
        "stripe_account_mismatch",
        "Stripe credentials do not match the expected merchant.",
      );
      if (command === "import") {
        const bundle = z.string().min(1).parse(values.bundle);
        const directory = z
          .string()
          .min(1)
          .parse(values.directory ?? join(config.storage, "portability"));
        check(
          isAbsolute(bundle) && isAbsolute(directory),
          400,
          "maintenance_usage",
          "Use absolute private bundle and working directories.",
        );
        // Require explicit S3 env, rather than the development bucket defaults.
        check(
          env.S3_BUCKET && env.S3_REGION,
          400,
          "storage_configuration",
          "Explicit private S3 bucket and region are required.",
        );
        const fd = z.coerce
          .number()
          .int()
          .min(0)
          .max(2147483647)
          .parse(values["passphrase-fd"] ?? "0");
        const passphrase = (deps.passphrase ?? readMaintenancePassphrase)(fd);
        storage = (deps.storage ?? maintenanceStorage)(config);
        const result = await importPortability({
          db,
          store: storage.store,
          secret: config.secret,
          directory,
          bundleDirectory: bundle,
          passphrase,
          expectedStripeAccountId: expected,
          deploymentMode: "standalone",
          verifyDestinationEmpty: storage.verifyEmpty,
        });
        await audit("portability.imported");
        return {
          tenantId: result.tenant.id,
          requiresReconciliation: true,
          subscriptionIds: result.subscriptionIds,
          pendingEventIds: result.pendingEventIds,
        };
      }
      check(
        tenant.suspended === 1,
        409,
        "maintenance_required",
        "Imported tenant must remain suspended until finalization.",
      );
      await audit("portability.finalize_requested");
      const billing = new Billing(
        db,
        new Licenses(db, config.secret, config.exemptSuffixes, tenant),
        source,
        { stripeLiveMode: config.stripeLiveMode === true },
      );
      await completePortabilityImport({
        db,
        secret: config.secret,
        expectedStripeAccountId: expected,
        reconcile: async (required) => {
          for (const subscription of required.subscriptionIds)
            await billing.reconcile(subscription);
          for (const id of required.pendingEventIds) {
            const row = await db("billing_events")
              .where({ tenant_id: tenant.id, id, processed_at: null })
              .first();
            check(
              row,
              409,
              "reconciliation_required",
              "Pending receipt changed during maintenance.",
            );
            const event = eventSchema.parse(
              unseal<BillingEvent>(row.payload, config.secret),
            );
            check(
              event.id === id && event.type === row.type,
              409,
              "reconciliation_required",
              "Receipt identity mismatch.",
            );
            check(
              /^(?:customer\.subscription|invoice|checkout\.session|charge|refund)\./.test(
                event.type,
              ),
              409,
              "unsupported_billing_event",
              "Review unsupported provider receipts before finalization.",
            );
            const authoritative = eventSchema.parse(
              await source.stripe.events.retrieve(id),
            );
            check(
              authoritative.id === id &&
                authoritative.type === event.type &&
                authoritative.data.object.id === event.data.object.id,
              409,
              "reconciliation_required",
              "Provider receipt identity mismatch.",
            );
            const subscription =
              await source.resolveSubscription(authoritative);
            if (subscription) await billing.reconcile(subscription);
            // A successful authoritative resolution may prove the receipt has no subscription.
            check(
              await db("billing_events")
                .where({
                  tenant_id: tenant.id,
                  id,
                  processed_at: null,
                  payload: row.payload,
                })
                .update({ processed_at: Date.now() }),
              409,
              "reconciliation_required",
              "Receipt changed during reconciliation.",
            );
          }
        },
      });
      return { tenantId: tenant.id, finalized: true };
    }
    if (command === "closures") {
      const limit = z.coerce
        .number()
        .int()
        .min(1)
        .max(500)
        .parse(values.limit ?? "100");
      const query = db("account_closures").where({ tenant_id: tenant.id });
      if (values.after !== undefined)
        query.andWhere("id", ">", identifier.parse(values.after));
      const requests = await query
        .orderBy("id")
        .limit(limit)
        .select(
          "id",
          "customer_id",
          "status",
          "blockers",
          "requested_at",
          "completed_at",
        );
      await audit("customer.closure.listed");
      return { requests };
    }
    const customer = identifier.parse(values.customer),
      request = identifier.parse(values.request);
    if (command === "closure-inspect") {
      const inspection = await new CustomerAccounts(
        db,
        new Auth(db, config, tenant),
      ).inspectClosure(customer, request);
      await audit("customer.closure.inspected");
      return inspection;
    }
    const receipt = await reviewedReceipt(
      z.string().min(1).parse(values.receipt),
    );
    check(
      receipt.operatorId === operator &&
        receipt.tenantId === tenant.id &&
        receipt.customerId === customer &&
        receipt.requestId === request,
      409,
      "receipt_mismatch",
      "Reviewed receipt must match operator, tenant, customer and request.",
    );
    const accounts = new CustomerAccounts(db, new Auth(db, config, tenant));
    if (command === "closure-attribution-upgrade") {
      check(
        typeof receipt.stripeLiveMode === "boolean",
        409,
        "privacy_attribution_mismatch",
        "The reviewed upgrade must specify stripeLiveMode.",
      );
      return await accounts.upgradeClosureAttribution(
        customer,
        request,
        operator,
        receipt.approval,
        receipt.stripeLiveMode,
      );
    }
    if (command === "closure-reconcile")
      return accounts.reconcileClosure(
        customer,
        request,
        operator,
        receipt.approval,
      );
    return accounts.approveClosure(customer, request, operator, {
      quiesced: true,
      stripeReconciled: true,
      retentionReviewed: true,
    });
  } finally {
    try {
      storage?.close();
    } finally {
      await (
        deps.closeDatabase ??
        (async (db) => {
          await db.destroy();
        })
      )(db);
    }
  }
}

/** Trusted DI is code-only. No HTTP endpoint or runtime provider override is exposed. */
export async function runMaintenance(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: MaintenanceIO = defaultIO,
  deps: MaintenanceDependencies = {},
) {
  try {
    io.out(JSON.stringify(await execute(argv, env, deps)));
    return 0;
  } catch (error) {
    io.error(
      JSON.stringify({
        error: error instanceof AppError ? error.code : "maintenance_failed",
      }),
    );
    return 1;
  }
}
if (import.meta.main)
  process.exitCode = await runMaintenance(process.argv.slice(2));
