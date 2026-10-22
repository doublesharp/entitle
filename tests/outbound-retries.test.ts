import test from "node:test";
import assert from "node:assert/strict";
import { operationsFixture } from "./operations-fixtures.test.ts";
import { OutboundWebhooks } from "../src/outbound-webhooks.ts";
const secret="42".repeat(32);
const publicAddress={address:"93.184.216.34",family:4};

test("delivery backoff, terminal attempts, deadline and manual retry are durable and bounded",async()=>operationsFixture(async(db,tenant,other)=>{
  let now=1800000000000,status=503,calls=0;
  const options={now:()=>now,network:{resolve:async()=>[publicAddress],send:async()=>{calls++;return status;}}};
  const service=new OutboundWebhooks(db,tenant.id,secret,options),foreign=new OutboundWebhooks(db,other.id,secret,options);
  const endpoint=await service.createEndpoint({url:"https://example.com/hook",events:["license.created"]});
  await service.enqueue({id:"event",type:"license.created",resourceId:"license",occurredAt:now});
  for(let attempt=1;attempt<=12;attempt++){
    await service.run(); const delivery=(await service.deliveries())[0]!;
    assert.equal(delivery.attempts,attempt); assert.equal(delivery.state,attempt===12?"failed":"pending");
    assert.equal(delivery.availableAt,now+Math.min(3600000,5000*2**Math.min(attempt-1,10)));
    await service.run(); assert.equal(calls,attempt); now=delivery.availableAt;
  }
  const id=(await service.deliveries())[0]!.id;
  await assert.rejects(foreign.retry(id));await service.retry(id);status=204;await service.run();
  assert.equal((await service.deliveries())[0]!.state,"sent");assert.equal((await service.deliveries())[0]!.attempts,1);
  await assert.rejects(service.retry(id));
  await service.enqueue({id:"deadline",type:"license.created",resourceId:"license",occurredAt:now});
  const deadline=(await service.deliveries()).find(d=>d.eventId==="deadline")!;
  now=deadline.deadlineAt;await service.run();assert.equal(calls,13);
  assert.equal((await service.deliveries()).find(d=>d.id===deadline.id)!.lastError,"retry_expired");
  await service.rotateSecret(endpoint.id);await service.retry(deadline.id);
  await assert.rejects(service.run(21));await assert.rejects(service.deliveries(101));
}));

test("expired worker claims are recovered while stale owners cannot settle newer leases",async()=>operationsFixture(async(db,tenant)=>{
  let now=1800000000000,calls=0;
  let resolveFirst:()=>void=()=>{};const blocked=new Promise<void>(resolve=>{resolveFirst=resolve;});
  const service=new OutboundWebhooks(db,tenant.id,secret,{now:()=>now,network:{resolve:async()=>[publicAddress],send:async()=>{calls++;if(calls===1) await blocked;return 204;}}});
  await service.createEndpoint({url:"https://example.com/hook",events:["license.created"]});
  await service.enqueue({id:"event",type:"license.created",resourceId:"license",occurredAt:now});
  const first=service.run(1);
  while(calls===0) await new Promise(resolve=>setImmediate(resolve));
  await service.run();assert.equal(calls,1);now+=30001;
  await service.run();assert.equal(calls,2);resolveFirst();await first;
  assert.equal((await service.deliveries())[0]!.attempts,2);assert.equal((await service.deliveries())[0]!.state,"sent");
}));

test("rotation during DNS resolution invalidates old claims and preserves the new generation",async()=>operationsFixture(async(db,tenant)=>{
  let calls=0,rotate=false;let endpointId="";
  const service=new OutboundWebhooks(db,tenant.id,secret,{network:{resolve:async()=>{if(rotate){rotate=false;await service.rotateSecret(endpointId);}return [publicAddress];},send:async()=>{calls++;return 204;}}});
  endpointId=(await service.createEndpoint({url:"https://example.com/hook",events:["license.created"]})).id;
  await service.enqueue({id:"event",type:"license.created",resourceId:"license",occurredAt:Date.now()});rotate=true;
  await service.run();assert.equal(calls,1);assert.equal((await service.deliveries())[0]!.state,"sent");
  await service.enqueue({id:"legacy",type:"license.created",resourceId:"license",occurredAt:Date.now()});
  // Simulate legacy data whose endpoint changed without canceling its queue row.
  await db("outbound_endpoints").where({tenant_id:tenant.id,id:endpointId}).increment("generation",1);
  await service.run();assert.equal((await service.deliveries()).find(d=>d.eventId==="legacy")!.lastError,"endpoint_changed");
}));

test("DNS latency cannot authorize a send after the lease or retry deadline expires",async()=>operationsFixture(async(db,tenant)=>{
  let now=1800000000000,advance=0,calls=0;
  const service=new OutboundWebhooks(db,tenant.id,secret,{now:()=>now,network:{resolve:async()=>{now+=advance;return [publicAddress];},send:async()=>{calls++;return 204;}}});
  await service.createEndpoint({url:"https://example.com/hook",events:["license.created"]});
  await service.enqueue({id:"lease",type:"license.created",resourceId:"license",occurredAt:now});advance=30001;
  await service.run(1);assert.equal(calls,0);
  advance=0;await service.run();assert.equal(calls,1);
  await service.enqueue({id:"deadline-dns",type:"license.created",resourceId:"license",occurredAt:now});advance=72*3600000+1;
  await service.run();assert.equal(calls,1);assert.equal((await service.deliveries()).find(d=>d.eventId==="deadline-dns")!.state,"failed");
}));

test("secret rotation preserves the undelivered backlog and retries it with the new generation",async()=>operationsFixture(async(db,tenant)=>{
  let now=1800000000000;
  const sent:import("../src/outbound-webhooks.ts").WebhookRequest[]=[];
  const service=new OutboundWebhooks(db,tenant.id,secret,{now:()=>now,network:{resolve:async()=>[publicAddress],send:async request=>{sent.push(request);return 204;}}});
  const endpoint=await service.createEndpoint({url:"https://example.com/hook",events:["license.created"]});
  await service.enqueue({id:"retained",type:"license.created",resourceId:"license",occurredAt:now});
  const before=(await service.deliveries())[0]!;
  await db("outbound_deliveries").where({tenant_id:tenant.id,id:before.id}).update({state:"failed"});
  now++;
  const rotated=await service.rotateSecret(endpoint.id);
  await service.retry(before.id);
  await service.run();
  assert.equal(sent.length,1,"rotation must retain failed and pending events");
  assert.equal((await service.deliveries())[0]!.state,"sent");
  const {verifyWebhookSignature}=await import("../src/outbound-webhooks.ts");
  const request=sent[0]!;
  assert.equal(verifyWebhookSignature(rotated.secret,request.headers["x-entitle-timestamp"]!,"retained",request.rawBody,request.headers["x-entitle-signature"]!,now),true);
  assert.equal(verifyWebhookSignature(endpoint.secret,request.headers["x-entitle-timestamp"]!,"retained",request.rawBody,request.headers["x-entitle-signature"]!,now),false);
}));

test("rotation never reactivates failed history or lets its manual retry bypass a full queue",async()=>operationsFixture(async(db,tenant)=>{
  const now=Date.now(),service=new OutboundWebhooks(db,tenant.id,secret,{network:{resolve:async()=>[publicAddress],send:async()=>204}});
  const endpoint=await service.createEndpoint({url:"https://example.com/",events:["license.created"]});
  for(let offset=0;offset<1100;offset+=100) {
    const events=Array.from({length:100},(_,i)=>({tenant_id:tenant.id,id:`history_${offset+i}`,payload:"{}",created_at:now}));
    await db("outbound_events").insert(events);
    await db("outbound_deliveries").insert(events.map((row,i)=>({tenant_id:tenant.id,id:row.id,event_id:row.id,endpoint_id:endpoint.id,generation:1,state:offset+i<1000?"pending":"failed",available_at:now,deadline_at:now+100000,created_at:now})));
  }
  await service.rotateSecret(endpoint.id);
  const counts=await db("outbound_deliveries").where({tenant_id:tenant.id}).select("state","generation").count("* as count").groupBy("state","generation");
  assert.deepEqual(counts.map(row=>({state:String(row.state),generation:Number(row.generation),count:Number(row.count)})).sort((a,b)=>a.state.localeCompare(b.state)),[{state:"failed",generation:2,count:100},{state:"pending",generation:2,count:1000}]);
  await assert.rejects(service.retry("history_1000"),/outbox is full/);
  await db("outbound_deliveries").where({tenant_id:tenant.id,id:"history_0"}).update({state:"sent"});
  await service.retry("history_1000");
  assert.equal(Number((await db("outbound_deliveries").where({tenant_id:tenant.id,state:"pending"}).count("* as count").first())!.count),1000);
}));
