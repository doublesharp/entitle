import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { DB, Tenant } from "./db.ts";
import type { Config } from "./config.ts";
import type { PlatformBilling } from "./platform-billing.ts";
import { bearer } from "./auth.ts";
import { equal, hash } from "./crypto.ts";
import { check } from "./errors.ts";

export async function operatorRoutes(app:FastifyInstance,db:DB,config:Config,payments:PlatformBilling,tick:()=>Promise<void>){
  app.addHook("onRequest",async req=>{check(equal(hash(bearer(req)),hash(config.operatorToken)),401,"operator_required","Platform operator credentials are required.");});
  const audit=async(tenantId:string|null,action:string,details:Record<string,string>)=>{await db("audit_events").insert({id:randomUUID(),tenant_id:tenantId,actor_type:"operator",actor_id:"platform",action,details:JSON.stringify(details),created_at:Date.now()});};
  app.get("/tenants",async()=>({tenants:await db("tenants").orderBy("created_at")}));
  app.post("/tenants/:id/status",async req=>{
    const {id}=z.object({id:z.string().min(1).max(64)}).parse(req.params);
    const b=z.object({suspended:z.boolean().optional(),exempt:z.boolean().optional(),maxProducts:z.number().int().min(1).max(10000).optional(),maxStorageBytes:z.number().int().min(1).max(1024**5).optional()}).strict().refine(v=>Object.keys(v).length>0).parse(req.body);
    const update={...(b.suspended===undefined?{}:{suspended:b.suspended?1:0}),...(b.exempt===undefined?{}:{exempt:b.exempt?1:0}),...(b.maxProducts===undefined?{}:{max_products:b.maxProducts}),...(b.maxStorageBytes===undefined?{}:{max_storage_bytes:b.maxStorageBytes})};
    check(await db("tenants").where({id}).update(update),404,"not_found","Tenant not found.");await audit(id,"tenant.status_changed",Object.fromEntries(Object.entries(update).map(([key,value])=>[key,String(value)])));return {ok:true};
  });
  app.post("/tenants/:id/owner",async req=>{
    const {id}=z.object({id:z.string().min(1).max(64)}).parse(req.params),{email}=z.object({email:z.email().max(254)}).strict().parse(req.body);
    await db.transaction(async tx=>{
      check(await tx("tenants").where({id}).first(),404,"not_found","Tenant not found.");
      const user=await tx("seller_users").where({email:email.toLowerCase()}).whereNotNull("verified_at").first();
      check(user,409,"seller_not_verified","The seller must first verify this email through seller sign-in.");
      await tx("seller_memberships").insert({tenant_id:id,user_id:user.id,role:"owner",created_at:Date.now()}).onConflict(["tenant_id","user_id"]).ignore();
      await tx("audit_events").insert({id:randomUUID(),tenant_id:id,actor_type:"operator",actor_id:"platform",action:"membership.granted",details:JSON.stringify({user_id:user.id}),created_at:Date.now()});
    });return {ok:true};
  });
  app.post("/tenants/:id/reconcile",async req=>{z.object({}).strict().parse(req.body);const {id}=z.object({id:z.string().min(1).max(64)}).parse(req.params);await payments.reconcile(id);return {ok:true};});
  app.get("/jobs",async()=>({work:await db("platform_work").select("id","kind","state","attempts","available_at","last_error"),emails:await db("platform_emails").select("id","kind","state","attempts","available_at","last_error")}));
  app.post("/jobs/run",async req=>{z.object({}).strict().parse(req.body);check(config.serverRole!=="api",409,"jobs_disabled","Job execution is disabled for the API server role.");await tick();return {ok:true};});
  app.post("/jobs/:table/:id/retry",async req=>{
    z.object({}).strict().parse(req.body);const {table,id}=z.object({table:z.enum(["platform_work","platform_emails"]),id:z.string().min(1).max(150)}).parse(req.params);
    check(await db(table).where({id,state:"failed"}).update({state:"pending",attempts:0,available_at:0,lease_until:0,lease_owner:null,last_error:null,created_at:Date.now()}),404,"not_found","Failed job not found.");
    await audit(null,"job.retry_requested",{job_id:id,queue:table});return {ok:true};
  });
  app.post("/jobs/:table/retry-failed",async req=>{
    const {table}=z.object({table:z.enum(["platform_work","platform_emails"])}).parse(req.params);
    const {limit}=z.object({limit:z.number().int().min(1).max(500).default(100)}).strict().parse(req.body);
    const jobs=await db(table).where({state:"failed"}).orderBy("created_at").limit(limit).select("id");
    const queued=await db(table).where({state:"failed"}).whereIn("id",jobs.map(j=>j.id)).update({state:"pending",attempts:0,available_at:0,lease_until:0,lease_owner:null,last_error:null,created_at:Date.now()});
    await audit(null,"jobs.retry_requested",{queue:table,count:String(queued)});return {queued};
  });
  if(config.localBilling&&!config.production)app.post("/local/tenants/:id",async req=>{
    const {id}=z.object({id:z.string().min(1).max(64)}).parse(req.params);
    const b=z.object({connected:z.boolean().optional(),paidDays:z.number().int().min(0).max(3650).optional()}).strict().refine(v=>Object.keys(v).length>0).parse(req.body);
    const tenant=await db<Tenant>("tenants").where({id}).first();check(tenant,404,"not_found","Tenant not found.");
    await db("tenants").where({id}).update({...(b.connected===undefined?{}:{stripe_account_id:tenant.stripe_account_id??`acct_local${hash(id)}`,stripe_status:b.connected?"connected":"disconnected"}),...(b.paidDays===undefined?{}:{billing_status:b.paidDays?"active":"past_due",paid_through:Date.now()+b.paidDays*86400000})});
    await audit(id,"local.tenant_fixture",{});return {ok:true,localMode:true};
  });
}
