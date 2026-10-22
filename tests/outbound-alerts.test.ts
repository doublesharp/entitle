import test from "node:test";
import assert from "node:assert/strict";
import { Operations } from "../src/operations.ts";
import { OutboundWebhooks } from "../src/outbound-webhooks.ts";
import { AppError } from "../src/errors.ts";
import { operationsFixture } from "./operations-fixtures.test.ts";

test("alert cooldown and durable forwarding survive quota failures, recovery and replay",async()=>operationsFixture(async(db,tenant,other)=>{
  const now=Date.now(),operations=new Operations(db,tenant.id);
  await operations.configure({cooldownMs:1000});
  await db("work").insert({tenant_id:tenant.id,id:"failed",kind:"test",payload:"{}",state:"failed",created_at:now});
  const alerts=await operations.alerts(now);assert.equal(alerts.length,1);
  let error:Error|undefined=new AppError(429,"webhook_budget","full"),calls=0;
  const target={tenantId:tenant.id,enqueue:async()=>{calls++;if(error) throw error;return true;}};
  assert.deepEqual(await operations.forwardAlerts(target),{forwarded:0,deferred:1});
  assert.equal(calls,1);
  // While one condition is waiting for forwarding, neither recovery nor a new
  // cooldown interval can overwrite the first durable event.
  await db("work").where({tenant_id:tenant.id}).update({state:"sent"});await operations.alerts(now+1001);
  await db("work").where({tenant_id:tenant.id}).update({state:"failed"});assert.equal((await operations.alerts(now+2001)).length,1);
  error=Error("database unavailable");await assert.rejects(operations.forwardAlerts(target),/database unavailable/);
  error=undefined;assert.deepEqual(await operations.forwardAlerts(target),{forwarded:1,deferred:0});
  assert.deepEqual(await operations.forwardAlerts(target),{forwarded:0,deferred:0});
  assert.equal((await operations.alerts(now+3002)).length,1);
  const service=new OutboundWebhooks(db,tenant.id,"42".repeat(32),{network:{resolve:async()=>[{address:"8.8.8.8",family:4}],send:async()=>204}});
  await service.createEndpoint({url:"https://example.com/",events:["alert.raised"]});
  const race=await Promise.all([operations.forwardAlerts(service),operations.forwardAlerts(service)]);
  assert.equal(race.reduce((sum,row)=>sum+row.forwarded,0),1);
  assert.equal((await service.deliveries()).length,1);
  const event=await db("outbound_events").where({tenant_id:tenant.id}).first();assert.equal(JSON.parse(event.payload).type,"alert.raised");
  await assert.rejects(operations.forwardAlerts({...target,tenantId:other.id}),/tenant/i);
  await assert.rejects(operations.forwardAlerts(target,0));
  assert.equal((await db("operation_alerts").where({tenant_id:tenant.id}).andWhere("id","like","forward_%")).length,1);
}));
