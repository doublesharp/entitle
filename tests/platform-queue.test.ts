import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createDb, migrate } from "../src/db.ts";
import { runQueue } from "../src/queue.ts";

test("platform email delivery erases the encrypted credential payload after success", async () => {
  const directory = await mkdtemp("/Volumes/Scratch/entitle/tmp/platform-queue-");
  const db = createDb(`sqlite:${directory}/db`);
  try {
    await migrate(db);
    await assert.rejects(runQueue(db,"emails",async()=>{}),/Tenant context/);
    if (!(await db.schema.hasTable("platform_emails")))
      await db.schema.createTable("platform_emails", (t) => {
        t.string("id").primary();
        t.string("kind");
        t.text("payload");
        t.string("state").defaultTo("pending");
        t.integer("attempts").defaultTo(0);
        t.double("available_at").defaultTo(0);
        t.double("lease_until").defaultTo(0);
        t.string("lease_owner").nullable();
        t.string("last_error").nullable();
        t.double("created_at");
      });
    await db("platform_emails").insert({
      id: "email", kind: "login", payload: "encrypted-one-time-secret", created_at: Date.now(),
    });
    const delivered: string[] = [];
    await runQueue(db, "platform_emails", async (job) => { delivered.push(job.payload); });
    assert.deepEqual(delivered, ["encrypted-one-time-secret"]);
    const row = await db("platform_emails").where({ id: "email" }).first();
    assert.equal(row.state, "sent");
    assert.equal(row.payload, "");
    assert.equal(row.lease_owner, null);
  } finally {
    await db.destroy();
    await rm(directory, { recursive: true, force: true });
  }
});
test("jobs beyond the retry window retain retryable encrypted payloads", async () => {
  const directory = await mkdtemp("/Volumes/Scratch/entitle/tmp/queue-deadletter-");
  const db = createDb(`sqlite:${directory}/db`);
  try {
    await migrate(db);
    await db("platform_emails").insert({id:"poison",kind:"login",payload:"encrypted-key",attempts:11,created_at:Date.now()-72*3600000-1});
    let attempts=0;
    await runQueue(db,"platform_emails",async()=>{attempts++;throw Error("provider credential must not be persisted");});
    const row=await db("platform_emails").where({id:"poison"}).first();
    assert.equal(row.state,"failed");
    assert.equal(row.attempts,12);
    assert.equal(row.payload,"encrypted-key");
    assert.equal(row.last_error,"processing_failed");
    await runQueue(db,"platform_emails",async()=>{attempts++;});
    assert.equal(attempts,1);
  }finally{await db.destroy();await rm(directory,{recursive:true,force:true});}
});
test("a multi-hour provider outage remains pending until its seventy-two-hour retry window",async()=>{
  const directory=await mkdtemp("/Volumes/Scratch/entitle/tmp/queue-outage-");
  const db=createDb(`sqlite:${directory}/db`),original=Date.now;
  let now=original();
  try{
    await migrate(db);
    const created=now;
    Date.now=()=>now;
    await db("platform_emails").insert({id:"outage",kind:"license_key",payload:"encrypted-only-key",created_at:created});
    for(let n=0;n<14;n++){
      await runQueue(db,"platform_emails",async()=>{throw Error("SMTP outage");},1);
      const row=await db("platform_emails").where({id:"outage"}).first();
      assert.equal(row.state,"pending");
      assert.equal(row.payload,"encrypted-only-key");
      now=Number(row.available_at)+1;
    }
    now=created+72*3600000+1;
    await runQueue(db,"platform_emails",async()=>{throw Error("still unavailable");},1);
    assert.equal((await db("platform_emails").where({id:"outage"}).first()).state,"failed");
  }finally{Date.now=original;await db.destroy();await rm(directory,{recursive:true,force:true});}
});
