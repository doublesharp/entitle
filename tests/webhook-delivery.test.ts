import test from "node:test";
import assert from "node:assert/strict";
import { WebhookDeliveryPool } from "../src/webhook-delivery.ts";

test("slow webhook delivery has bounded concurrency and does not block another tenant's core work",async()=>{
  const errors:string[]=[];
  const pool=new WebhookDeliveryPool(id=>{errors.push(id);},2);
  let unblock:()=>void=()=>{};
  const blocked=new Promise<void>(resolve=>{unblock=resolve;});
  let started=0;
  assert.equal(pool.start("slow",async()=>{started++;await blocked;}),true);
  assert.equal(pool.start("slow",async()=>{throw Error("duplicate");}),false);
  assert.equal(pool.start("second",async()=>{started++;await blocked;}),true);
  assert.equal(pool.start("third",async()=>{throw Error("over capacity");}),false);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(started,2);
  let mailDelivered=false;
  await (async()=>{mailDelivered=true;})();assert.equal(mailDelivered,true);
  let closed=false;const closing=pool.close().then(()=>{closed=true;});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);
  assert.equal(pool.start("late",async()=>{}),false);
  unblock();await closing;assert.deepEqual(errors,[]);
});

test("failed delivery frees its slot, hides exception details and survives a failing logger",async()=>{
  const errors:string[]=[];
  const pool=new WebhookDeliveryPool(id=>{errors.push(id);throw Error("logger failure");},1);
  pool.start("tenant",async()=>{throw Error("private credentials");});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(errors,["tenant"]);
  let ran=false;assert.equal(pool.start("next",async()=>{ran=true;}),true);
  await pool.close();assert.equal(ran,true);
  await pool.close();
  assert.throws(()=>new WebhookDeliveryPool(()=>{},0),/concurrency/);
  const defaults=new WebhookDeliveryPool(()=>{});await defaults.close();
});

test("blocked tenant leaves real work/email queues and another tenant's webhook runnable",async t=>{
  const {operationsFixture,seedOperationLicense}=await import("./operations-fixtures.test.ts");
  const {OutboundWebhooks}=await import("../src/outbound-webhooks.ts");
  const {Outbox,enqueueEmail}=await import("../src/email.ts");
  const {runQueue}=await import("../src/queue.ts");
  await operationsFixture(async(db,tenant,other)=>{
    const secret="42".repeat(32),ids=await seedOperationLicense(db,other),errors:string[]=[];
    await enqueueEmail(db,secret,"login",ids.customer,null,"login",{to:"buyer@example.test",subject:"Sign in",text:"Verified login link"},other.id);
    await db("work").insert({tenant_id:other.id,id:"billing",kind:"billing",payload:"{}",created_at:Date.now()});
    let entered:()=>void=()=>{},delivered:()=>void=()=>{};
    const blocked=new Promise<void>(resolve=>{entered=resolve;}),healthy=new Promise<void>(resolve=>{delivered=resolve;});
    const base={resolve:async()=>[{address:"8.8.8.8",family:4}]};
    const a=new OutboundWebhooks(db,tenant.id,secret,{runBudgetMs:50,network:{...base,send:async()=>{entered();return new Promise(()=>{});}}});
    const b=new OutboundWebhooks(db,other.id,secret,{network:{...base,send:async()=>{delivered();return 204;}}});
    for(const service of [a,b]){await service.createEndpoint({url:"https://example.com/",events:["license.created"]});await service.enqueue({id:"event",type:"license.created",resourceId:"license",occurredAt:Date.now()});}
    t.mock.timers.enable({apis:["setTimeout"]});
    const pool=new WebhookDeliveryPool(id=>{errors.push(id);},2);
    pool.start(tenant.id,()=>a.run());await blocked;
    assert.equal(pool.start(other.id,()=>b.run()),true);await healthy;
    let billing=0,mail=0;
    await runQueue(db,"work",async()=>{billing++;},1,other.id);
    await new Outbox(db,secret,{send:async()=>{mail++;}},other).run();
    assert.equal(billing,1);assert.equal(mail,1);
    const closing=pool.close();t.mock.timers.tick(50);await closing;
    assert.deepEqual(errors,[]);assert.equal((await a.deliveries())[0]!.state,"pending");assert.equal((await b.deliveries())[0]!.state,"sent");
  });
});
