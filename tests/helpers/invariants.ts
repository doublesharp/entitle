import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import * as fc from "fast-check";
import { Billing, type BillingSnapshot } from "../../src/billing.ts";
import { unseal } from "../../src/crypto.ts";
import {
  createTenant,
  migrate,
  type DB,
  type License,
  type TenantContext,
} from "../../src/db.ts";
import type { Message } from "../../src/email.ts";
import { Licenses } from "../../src/licensing.ts";
import { isolatedDatabase } from "./database.ts";

export const secret = "c7".repeat(32);
export const epoch = 2_000_000_000_000;
export const slug = "invariant-pro";

function integer(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (
    !/^-?\d+$/.test(raw) ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw Error(`${name} must be an integer between ${min} and ${max}`);
  return value;
}

export const commandLimit = integer("FUZZ_COMMANDS", 30, 1, 1000);
export function parameters<T>(examples?: T[]): fc.Parameters<T> {
  return {
    numRuns: integer("FUZZ_RUNS", 30, 1, 100_000),
    verbose: 1,
    ...(process.env.FUZZ_SEED === undefined
      ? {}
      : {
          seed: integer("FUZZ_SEED", 0, -2147483648, 2147483647),
        }),
    ...(process.env.FUZZ_PATH === undefined
      ? {}
      : { path: process.env.FUZZ_PATH }),
    ...(examples ? { examples } : {}),
  };
}

export function sequence<T>(action: fc.Arbitrary<T>) {
  return fc.array(action, {
    minLength: 1,
    maxLength: commandLimit,
    size: "max",
  });
}

// Shrinking can reset the database immediately after an assertion rejects.
// Drain siblings first, including when only one of several operations fails.
export async function allCompleted<T>(operations: Promise<T>[]): Promise<T[]> {
  const results = await Promise.allSettled(operations);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return results.map((result) => {
    assert.equal(result.status, "fulfilled");
    return result.value;
  });
}

// One disposable database per test file, reset before EVERY sample and shrink.
// TEST_DATABASE_URL is deliberately ignored: it can point at retained data.
export async function invariantDatabase() {
  await access("/Volumes/Scratch");
  const temporary = "/Volumes/Scratch/double-entitle-wp/tmp";
  await mkdir(temporary, { recursive: true });
  const root = await mkdtemp(`${temporary}/invariants-`);
  let database: Awaited<ReturnType<typeof isolatedDatabase>> | undefined;
  try {
    database = await isolatedDatabase(`sqlite:${root}/db`);
    await migrate(database.db);
  } catch (error) {
    await database?.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    db: database.db,
    close: async () => {
      try {
        await database.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

export interface Merchant {
  tenant: TenantContext;
  clock: { now: number };
  licensing: Licenses;
  billing: Billing;
  snapshot: BillingSnapshot;
}

export async function merchant(db: DB, id = "primary"): Promise<Merchant> {
  const tenant = { id, slug: id, name: id };
  if (id !== "primary") await createTenant(db, { ...tenant, exempt: 1 });
  await db("products").insert({
    tenant_id: id,
    id: `${id}-product`,
    slug,
    name: "Invariant product",
  });
  await db("plans").insert(
    [1, 3].map((allowance) => ({
      tenant_id: id,
      id: `${id}-plan-${allowance}`,
      product_id: `${id}-product`,
      name: `${allowance} seats`,
      site_allowance: allowance,
      stripe_price_id: `price_${allowance}`,
    })),
  );
  const clock = { now: epoch };
  const licensing = new Licenses(
    db,
    secret,
    ["test.local"],
    tenant,
    () => clock.now,
  );
  const snapshot: BillingSnapshot = {
    subscriptionId: "sub_same",
    customerId: "cus_same",
    email: "same@example.test",
    billingStatus: "active",
    suspended: false,
    fullyRefunded: false,
    grants: [
      {
        id: "grant_initial",
        invoiceId: "invoice_initial",
        priceId: "price_1",
        periodStart: epoch - 100,
        periodEnd: epoch + 100,
        paidAt: epoch - 100,
        settled: true,
      },
    ],
  };
  const billing = new Billing(db, licensing, {
    snapshot: async () => structuredClone(snapshot),
  });
  return { tenant, clock, licensing, billing, snapshot };
}

export async function purchase(db: DB, m: Merchant) {
  await m.billing.reconcile(m.snapshot.subscriptionId);
  const license = await db<License>("licenses")
    .where({ tenant_id: m.tenant.id })
    .first();
  assert.ok(license);
  const email = await db("emails")
    .where({ tenant_id: m.tenant.id, kind: "license_key", state: "pending" })
    .first();
  assert.ok(email);
  const key = /DE-[A-Za-z0-9_-]+/.exec(
    unseal<Message>(email.payload, secret).text,
  )?.[0];
  assert.ok(key);
  return { license, key };
}

// Compare complete tenant-owned business records, including encrypted payloads.
// Locks are excluded because a valid operation can acquire a mutex without a change.
export async function businessState(db: DB, tenantId: string) {
  const result: Record<string, unknown> = {};
  for (const table of [
    "customers",
    "licenses",
    "grants",
    "installations",
    "emails",
    "billing_events",
    "work",
  ])
    result[table] = await db(table)
      .where({ tenant_id: tenantId })
      .orderBy("id");
  return result;
}

export async function denied(operation: Promise<unknown>, code: string) {
  await assert.rejects(operation, { code });
}
