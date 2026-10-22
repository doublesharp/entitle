import { randomUUID } from "node:crypto";
import { createDb } from "../../src/db.ts";

// Every fixture receives its own database. Never reset the configured parent.
export async function isolatedDatabase(
  localUrl: string,
  parent = process.env.TEST_SAAS_DATABASE_URL,
) {
  if (!parent) {
    const db = createDb(localUrl);
    return { db, close: () => db.destroy() };
  }
  const url = new URL(parent);
  if (!["postgres:", "postgresql:", "mysql:"].includes(url.protocol))
    throw Error("TEST_SAAS_DATABASE_URL must select PostgreSQL or MySQL");
  const name = `entitle_case_${randomUUID().replaceAll("-", "")}`;
  const admin = createDb(parent);
  await admin.raw("CREATE DATABASE ??", [name]);
  url.pathname = `/${name}`;
  const db = createDb(url.toString());
  return {
    db,
    close: async () => {
      try {
        await db.destroy();
        await admin.raw("DROP DATABASE ??", [name]);
      } finally {
        await admin.destroy();
      }
    },
  };
}
