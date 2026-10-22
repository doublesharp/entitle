import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpsRequest } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createWebhookNetwork, OutboundWebhooks, verifyWebhookSignature, type WebhookRequestFactory } from "../src/outbound-webhooks.ts";
import { operationsFixture } from "./operations-fixtures.test.ts";

test("real TLS loopback receiver observes signed raw bytes and redirect responses never trigger another request",async()=>operationsFixture(async(db,tenant)=>{
  const directory=await mkdtemp("/Volumes/Scratch/entitle/tmp/outbound-tls-");
  execFileSync("/usr/bin/openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",`${directory}/key.pem`,"-out",`${directory}/cert.pem`,"-days","1","-subj","/CN=localhost","-addext","subjectAltName=DNS:localhost"],{stdio:"ignore"});
  const key=await readFile(`${directory}/key.pem`),cert=await readFile(`${directory}/cert.pem`);
  const received:{body:string;headers:Record<string,string|string[]|undefined>}[]=[];let responseStatus=204;
  const server=createServer({key,cert},(req,res)=>{let body="";req.setEncoding("utf8");req.on("data",chunk=>{body+=chunk;});req.on("end",()=>{received.push({body,headers:req.headers});res.writeHead(responseStatus,{location:"https://127.0.0.1/forbidden"});res.end();});});
  try {
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address();assert.ok(address && typeof address!=="string");
    // Explicit transport-only injection. Destination validation still sees and requires public DNS answers.
    const request:WebhookRequestFactory=(url,options,callback)=>{
      assert.equal(options.hostname,"93.184.216.34"); assert.equal(options.servername,"example.com");assert.equal(options.agent,false);
      return httpsRequest(url,{...options,hostname:"127.0.0.1",port:address.port,servername:"localhost",ca:cert},callback);
    };
    const network=createWebhookNetwork(request);
    const service=new OutboundWebhooks(db,tenant.id,"42".repeat(32),{network:{...network,resolve:async()=>[{address:"93.184.216.34",family:4}]}});
    const endpoint=await service.createEndpoint({url:"https://example.com/hook",events:["release.published"]});
    await service.enqueue({id:"tls",type:"release.published",resourceId:"release",occurredAt:Date.now()});await service.run();
    assert.equal(received.length,1);const first=received[0]!;
    assert.equal(first.headers.host,"example.com");assert.equal(first.headers["content-length"],String(Buffer.byteLength(first.body)));
    assert.equal(verifyWebhookSignature(endpoint.secret,first.headers["x-entitle-timestamp"] as string,"tls",first.body,first.headers["x-entitle-signature"] as string),true);
    assert.equal((await service.deliveries())[0]!.state,"sent");
    responseStatus=302;await service.enqueue({id:"redirect",type:"release.published",resourceId:"release",occurredAt:Date.now()});await service.run();
    assert.equal(received.length,2);assert.equal((await service.deliveries()).find(d=>d.eventId==="redirect")!.state,"pending");
  } finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(directory,{recursive:true,force:true}); }
}));

test("transport enforces its wall clock timeout and propagates connection failures",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const req=new EventEmitter() as EventEmitter & {end:(body:string)=>void;destroy:(error:Error)=>void};
  req.end=()=>{};req.destroy=error=>{req.emit("error",error);req.emit("close");};
  const factory=(()=>req) as unknown as WebhookRequestFactory;
  const result=createWebhookNetwork(factory).send({url:new URL("https://example.com/"),addresses:[{address:"93.184.216.34",family:4}],rawBody:"{}",headers:{}});
  const rejection=assert.rejects(result,/deadline exceeded/);t.mock.timers.tick(10000);await rejection;
});
test("transport treats absent status as a failure code",async()=>{
  const req=new EventEmitter() as EventEmitter & {end:(body:string)=>void};
  const factory:WebhookRequestFactory=(_url,_options,callback)=>{
    req.end=()=>{callback!({destroy:()=>{},statusCode:undefined} as never);req.emit("close");};return req as never;
  };
  for(const url of ["https://example.com/","https://8.8.8.8/","https://[2606:4700:4700::1111]/"])
    assert.equal(await createWebhookNetwork(factory).send({url:new URL(url),addresses:[{address:"93.184.216.34",family:4}],rawBody:"{}",headers:{}}),0);
  new OutboundWebhooks({} as never,"tenant","42".repeat(32));
});
