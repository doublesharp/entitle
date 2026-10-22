import test from "node:test";
import assert from "node:assert/strict";
import {
  businessFixture,
  tenant,
  outbound,
} from "./business-events-fixtures.test.ts";
import { up } from "../src/migrations/012_business_events.ts";
import { BusinessEvents, recordBusinessEvent } from "../src/business-events.ts";

for (const [engine, url] of [
  ["PostgreSQL", process.env.TEST_POSTGRES_DATABASE_URL],
  ["MySQL", process.env.TEST_MYSQL_DATABASE_URL],
] as const)
  test(
    `business events on isolated real ${engine}: schema replay, FK, durable dispatch`,
    { skip: !url },
    async () => {
      const previous = process.env.TEST_SAAS_DATABASE_URL;
      process.env.TEST_SAAS_DATABASE_URL = url;
      try {
        await businessFixture(async (db) => {
          if (engine === "MySQL") {
            const table = await db("information_schema.TABLES")
              .where({
                TABLE_SCHEMA: db.raw("database()"),
                TABLE_NAME: "business_events",
              })
              .first();
            assert.equal(table.TABLE_COLLATION, "utf8mb4_bin");
            // Simulate independent MySQL DDL interruption, then repair both FK and index.
            await db.raw("ALTER TABLE ?? DROP FOREIGN KEY ??", [
              "business_events",
              "business_events_tenant_id_foreign",
            ]);
            await db.raw("ALTER TABLE ?? DROP INDEX ??", [
              "business_events",
              "business_events_tenant_id_state_available_at_index",
            ]);
            await up(db);
            await up(db);
          }
          await db.transaction((tx) =>
            recordBusinessEvent(
              tx,
              tenant.id,
              "license.created",
              "Case",
              "transition",
              10,
            ),
          );
          await db.transaction((tx) =>
            recordBusinessEvent(
              tx,
              tenant.id,
              "license.created",
              "case",
              "transition",
              10,
            ),
          );
          assert.equal((await db("business_events")).length, 2);
          await assert.rejects(
            db.transaction((tx) =>
              recordBusinessEvent(tx, "missing", "license.created", "orphan"),
            ),
          );
          const worker = new BusinessEvents(db, tenant.id, outbound(db));
          assert.equal((await worker.dispatch(true)).dispatched, 2);
          assert.equal((await db("outbound_events")).length, 2);
          // Renewal retention uses the same short transaction/lock on each
          // real engine. No delivery occurs before strict Pro resumes.
          let now = 110;
          const renewalWorker = new BusinessEvents(
            db,
            tenant.id,
            outbound(db, () => now),
            () => now,
          );
          const gap = await db.transaction((tx) =>
            recordBusinessEvent(
              tx,
              tenant.id,
              "license.created",
              "gap",
              "gap",
              now,
            ),
          );
          assert.equal(
            (
              await renewalWorker.dispatch(false, 100, 50, {
                paidThrough: 100,
                retainUntil: 200,
              })
            ).deferred,
            1,
          );
          assert.equal(
            (await db("business_events").where({ id: gap }).first()).state,
            "pending",
          );
          now = 150;
          assert.equal(
            (await renewalWorker.dispatch(true, 100, 50)).dispatched,
            1,
          );
          now = 210;
          await db.transaction((tx) =>
            recordBusinessEvent(
              tx,
              tenant.id,
              "license.created",
              "expire",
              "expire",
              now,
            ),
          );
          await renewalWorker.dispatch(false, 100, 50, {
            paidThrough: 200,
            retainUntil: 300,
          });
          now = 300;
          assert.equal(
            (await renewalWorker.dispatch(false, 100, 50)).suppressed,
            1,
          );
          const before = (await db("business_events")).length;
          await up(db);
          assert.equal((await db("business_events")).length, before);
        });
      } finally {
        if (previous === undefined) delete process.env.TEST_SAAS_DATABASE_URL;
        else process.env.TEST_SAAS_DATABASE_URL = previous;
      }
    },
  );
