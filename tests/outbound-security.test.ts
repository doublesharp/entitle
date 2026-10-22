import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { operationsFixture } from "./operations-fixtures.test.ts";
import { OutboundWebhooks, isPublicWebhookAddress, verifyWebhookSignature, type WebhookRequest } from "../src/outbound-webhooks.ts";
const secret="42".repeat(32);
const publicAddress={address:"93.184.216.34",family:4};

test("public destination guard rejects reserved IPv4, IPv6 and alternate representations",()=>{
  for(const ip of ["127.0.0.1","0.0.0.0","10.2.3.4","100.64.0.1","169.254.169.254","172.16.2.3","192.0.0.1","192.0.2.1","192.88.99.1","192.168.1.1","198.18.0.1","198.51.100.1","203.0.113.1","224.0.0.1","255.255.255.255","::1","::","fe80::1","fc00::1","::ffff:8.8.8.8","2001:db8::1","2001::1","2002:808:808::","3fff::1","garbage"])
    assert.equal(isPublicWebhookAddress(ip),false,ip);
  for(const ip of ["8.8.8.8","1.1.1.1","2606:4700:4700::1111","2001:4860:4860::8888"])
    assert.equal(isPublicWebhookAddress(ip),true,ip);
});
test("endpoint validation refuses unsafe syntax, mixed DNS, disallowed hosts, and rebinding",async()=>operationsFixture(async(db,tenant)=>{
  let addresses=[publicAddress]; let sends=0;
  const service=new OutboundWebhooks(db,tenant.id,secret,{network:{resolve:async()=>addresses,send:async()=>{sends++;return 204;}}});
  for(const url of ["http://example.com/hook","https://user:secret@example.com/","https://example.com/?token=x","https://example.com/#fragment","https://example.com/?","https://example.com/#","https://127.1/","https://[::ffff:8.8.8.8]/","https://example.com/\n"])
    await assert.rejects(service.createEndpoint({url,events:["license.created"]}));
  await assert.rejects(service.createEndpoint({url:"https://example.com/",events:["unknown"]}));
  addresses=[]; await assert.rejects(service.createEndpoint({url:"https://example.com/",events:["license.created"]}));
  addresses=[publicAddress,{address:"127.0.0.1",family:4}]; await assert.rejects(service.createEndpoint({url:"https://example.com/",events:["license.created"]}));
  const restricted=new OutboundWebhooks(db,tenant.id,secret,{allowHosts:["allowed.example"],network:{resolve:async()=>[publicAddress],send:async()=>204}});
  await assert.rejects(restricted.createEndpoint({url:"https://other.example/",events:["license.created"]}));
  addresses=[publicAddress];
  await service.createEndpoint({url:"https://example.com/hook",events:["license.created"]});
  await service.enqueue({id:"event",type:"license.created",resourceId:"license",occurredAt:Date.now()});
  addresses=[{address:"169.254.169.254",family:4}]; await service.run();
  assert.equal(sends,0); assert.equal((await service.deliveries())[0]!.lastError,"delivery_failed");
}));
test("signature binds raw body, timestamp and event ID with constant-time verification",()=>{
  const timestamp="1800000000",eventId="event",body='{"hello":"world"}',key="hook_secret";
  const signature="v1="+createHmac("sha256",key).update(`${timestamp}.${eventId}.${body}`).digest("hex");
  assert.equal(verifyWebhookSignature(key,timestamp,eventId,body,signature,1800000000000),true);
  for(const [t,id,b,s,now] of [[timestamp,"other",body,signature,1800000000000],[timestamp,eventId,body+" ",signature,1800000000000],[timestamp,eventId,body,signature,1800000301000],[timestamp,eventId,body,"v1=no",1800000000000],["NaN",eventId,body,signature,1800000000000]] as const)
    assert.equal(verifyWebhookSignature(key,t,id,b,s,now),false);
});
test("durable event IDs, secret rotation, leases and tenant isolation survive retries",async()=>operationsFixture(async(db,tenant,other)=>{
  let now=1800000000000; const sent:WebhookRequest[]=[];
  const options={now:()=>now,network:{resolve:async()=>[publicAddress],send:async(request:WebhookRequest)=>{sent.push(request);return 204;}}};
  const service=new OutboundWebhooks(db,tenant.id,secret,options), foreign=new OutboundWebhooks(db,other.id,secret,options);
  const endpoint=await service.createEndpoint({url:"https://example.com/hook",events:["license.created","activation.changed"]});
  assert.ok(endpoint.secret); assert.equal(JSON.stringify(await service.listEndpoints()).includes(endpoint.secret),false);
  assert.notEqual((await db("outbound_endpoints").where({id:endpoint.id}).first()).secret_cipher,endpoint.secret);
  const event={id:"event",type:"license.created" as const,resourceId:"license",occurredAt:now};
  await Promise.all([service.enqueue(event),service.enqueue(event)]);
  assert.equal((await service.deliveries()).length,1);
  await assert.rejects(service.enqueue({...event,resourceId:"different"}));
  await foreign.enqueue(event); assert.equal((await foreign.deliveries()).length,0);
  await Promise.all([service.run(),service.run()]); assert.equal(sent.length,1);
  const request=sent[0]!;
  assert.equal(verifyWebhookSignature(endpoint.secret,request.headers["x-entitle-timestamp"]!,event.id,request.rawBody,request.headers["x-entitle-signature"]!,now),true);
  assert.deepEqual(JSON.parse(request.rawBody),{...event,tenantId:tenant.id});
  await service.enqueue(event); assert.equal((await service.deliveries()).length,1);
  await service.enqueue({...event,id:"rotation"});
  const rotated=await service.rotateSecret(endpoint.id); assert.notEqual(rotated.secret,endpoint.secret);
  await service.run(); assert.equal(sent.length,2);
  now++; await service.enqueue({...event,id:"new-generation",occurredAt:now}); await service.run();
  assert.equal(sent.length,3);
  assert.equal(verifyWebhookSignature(rotated.secret,sent[2]!.headers["x-entitle-timestamp"]!,"new-generation",sent[2]!.rawBody,sent[2]!.headers["x-entitle-signature"]!,now),true);
  await assert.rejects(foreign.rotateSecret(endpoint.id)); await assert.rejects(foreign.deleteEndpoint(endpoint.id));
  await service.deleteEndpoint(endpoint.id); assert.equal((await service.listEndpoints())[0]!.active,false);
  await assert.rejects(service.rotateSecret(endpoint.id));
}));

test("payload schemas reject PII fields and endpoint changes never replay an already recorded event",async()=>operationsFixture(async(db,tenant)=>{
  const options={network:{resolve:async()=>[publicAddress],send:async()=>204}},service=new OutboundWebhooks(db,tenant.id,secret,options);
  const event={id:"event",type:"license.revoked",resourceId:"license",occurredAt:Date.now()};
  await assert.rejects(service.enqueue({...event,email:"buyer@example.com"}));await assert.rejects(service.enqueue({...event,resourceId:"https://site.example"}));
  assert.equal(await service.enqueue(event),true);
  await service.createEndpoint({url:"https://8.8.8.8/hook",events:["license.revoked"]});
  assert.equal(await service.enqueue(event),false);assert.deepEqual(await service.deliveries(),[]);
  const allow=new OutboundWebhooks(db,tenant.id,secret,{...options,allowHosts:["allowed.example"]});
  await allow.createEndpoint({url:"https://allowed.example/hook",events:["license.created"]});
  for(const url of ["not-a-url","https://@example.com","https://example.com/@fine?token=bad"])
    await assert.rejects(service.createEndpoint({url,events:["license.revoked"]}));
}));

test("endpoint and pending outbox limits reject atomically and manual retries respect the same budget",async()=>operationsFixture(async(db,tenant)=>{
  const service=new OutboundWebhooks(db,tenant.id,secret,{network:{resolve:async()=>[publicAddress],send:async()=>204}});
  const endpoint=await service.createEndpoint({url:"https://example.com/hook",events:["license.created"]});
  for(let i=1;i<10;i++) await service.createEndpoint({url:`https://example.com/${i}`,events:["activation.changed"]});
  await assert.rejects(service.createEndpoint({url:"https://example.com/overflow",events:["activation.changed"]}),/ten active/);
  const now=Date.now();
  for(let offset=0;offset<1000;offset+=100){
    const events=Array.from({length:100},(_,index)=>({tenant_id:tenant.id,id:`event_${index+offset}`,payload:"{}",created_at:now}));
    await db("outbound_events").insert(events);
    await db("outbound_deliveries").insert(events.map(e=>({tenant_id:tenant.id,id:e.id,event_id:e.id,endpoint_id:endpoint.id,generation:1,available_at:now,deadline_at:now+100000,created_at:now})));
  }
  await assert.rejects(service.enqueue({id:"overflow",type:"license.created",resourceId:"license",occurredAt:now}),/outbox is full/);
  assert.equal(await db("outbound_events").where({tenant_id:tenant.id,id:"overflow"}).first(),undefined);
  await db("outbound_events").insert({tenant_id:tenant.id,id:"failed",payload:"{}",created_at:now});
  await db("outbound_deliveries").insert({tenant_id:tenant.id,id:"failed",event_id:"failed",endpoint_id:endpoint.id,generation:1,state:"failed",available_at:now,deadline_at:now+100000,created_at:now});
  await assert.rejects(service.retry("failed"),/outbox is full/);
  await service.deleteEndpoint(endpoint.id);await assert.rejects(service.retry("failed"),/disabled/);
}));
