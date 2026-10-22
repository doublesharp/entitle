import test from "node:test";
import assert from "node:assert/strict";
import type {FastifyRequest,FastifyReply} from "fastify";
import {Auth} from "../src/auth.ts";
import {createDb} from "../src/db.ts";
import {loadConfig} from "../src/config.ts";
import {seal} from "../src/crypto.ts";

test("guest checkout proof is tenant and purpose bound, expiring, secure and never a buyer session",async()=>{
  const db=createDb("sqlite::memory:");
  const config=loadConfig({ DEPLOYMENT_MODE: "hosted",APP_SECRET:"44".repeat(32),OPERATOR_TOKEN:"root".repeat(8)});
  const auth=new Auth(db,{...config,production:true},{id:"primary",slug:"primary",name:"Primary"});
  let value="",name="",options:Record<string,unknown>={};
  const reply={setCookie:(n:string,v:string,o:Record<string,unknown>)=>{name=n;value=v;options=o;}} as unknown as FastifyReply;
  const req=(v?:string)=>({cookies:v?{[auth.checkoutCookieName]:v}:{},headers:{}}) as FastifyRequest;
  try{
    auth.issueCheckoutClaim("customer-one",reply);
    assert.equal(name,"__Host-de-checkout-primary");
    assert.equal(options.httpOnly,true);assert.equal(options.secure,true);assert.equal(options.sameSite,"lax");
    assert.equal(auth.checkoutCustomer(req(value)),"customer-one");
    assert.equal(auth.checkoutCustomer(req()),undefined);
    assert.equal(auth.checkoutCustomer(req("invalid")),undefined);
    for(const patch of [{purpose:"login"},{tenantId:"another"},{customerId:42},{expiresAt:Date.now()-1}]){
      const token=seal({purpose:"checkout",tenantId:"primary",customerId:"customer-one",expiresAt:Date.now()+10000,...patch},config.secret);
      assert.equal(auth.checkoutCustomer(req(token)),undefined);
    }
    await assert.rejects(auth.customer(req(value)),{code:"login_required"});
  }finally{await db.destroy();}
});
