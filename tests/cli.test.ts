import test, { before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { runCli } from "../src/cli.ts";
const directory = await mkdtemp(
  "/Volumes/Scratch/double-entitle-wp/tmp/saas-cli-",
);
const calls: {
  path: string;
  method: string;
  authorization: string | undefined;
  body: Buffer;
  type: string | undefined;
  metadata: string | undefined;
}[] = [];
let status = 200,
  responseBody = '{"ok":true}';
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c);
  calls.push({
    path: req.url!,
    method: req.method!,
    authorization: req.headers.authorization,
    body: Buffer.concat(chunks),
    type: req.headers["content-type"],
    metadata: req.headers["x-release-metadata"] as string | undefined,
  });
  res.writeHead(status, { "content-type": "application/json" });
  res.end(responseBody);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const key = `DE-TK-${"k".repeat(43)}`,
  operatorToken = "operator-secret-".repeat(3);
const tenantEnv = {
  PUBLIC_ORIGIN: origin,
  TENANT_SLUG: "alpha-team",
  TENANT_API_KEY: key,
};
const operatorEnv = { PUBLIC_ORIGIN: origin, OPERATOR_TOKEN: operatorToken };
const output: string[] = [],
  errors: string[] = [];
const io = {
  log: (v: string) => output.push(v),
  error: (v: string) => errors.push(v),
};
const file = (name: string) => join(directory, name);
before(async () => {
  await writeFile(
    file("product.json"),
    JSON.stringify({ slug: "plugin", name: "Plugin", plans: [] }),
  );
  await writeFile(
    file("status.json"),
    JSON.stringify({ maxProducts: 40, exempt: true }),
  );
  await writeFile(
    file("local.json"),
    JSON.stringify({ connected: true, paidDays: 30 }),
  );
  await writeFile(
    file("metadata.json"),
    JSON.stringify({ changelog: "Unicode é\nLiteral `ticks` $()" }),
  );
  await writeFile(file("release.zip"), Buffer.from([0, 1, 2, 255]));
});
beforeEach(() => {
  calls.length = 0;
  output.length = 0;
  errors.length = 0;
  status = 200;
  responseBody = '{"ok":true}';
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(directory, { recursive: true, force: true });
});
test("remote seller commands use only tenant credentials, scoped routes and exact request bodies without application secrets", async () => {
  const cases: { args: string[]; path: string; body?: unknown }[] = [
    { args: ["licenses"], path: "/overview" },
    { args: ["jobs"], path: "/jobs" },
    { args: ["work"], path: "/jobs/run", body: {} },
    {
      args: ["revoke", "license/one"],
      path: "/licenses/license%2Fone/revoke",
      body: { revoked: true },
    },
    {
      args: ["restore", "license/one"],
      path: "/licenses/license%2Fone/revoke",
      body: { revoked: false },
    },
    {
      args: ["withdraw", "release/one"],
      path: "/releases/release%2Fone/withdraw",
      body: {},
    },
    { args: ["reconcile"], path: "/reconcile", body: {} },
    {
      args: ["reconcile", "sub_1"],
      path: "/reconcile",
      body: { subscriptionId: "sub_1" },
    },
    {
      args: ["demo-purchase", "plan", "buyer@example.test"],
      path: "/local/purchase",
      body: { planId: "plan", email: "buyer@example.test" },
    },
    {
      args: ["product", file("product.json")],
      path: "/products",
      body: { slug: "plugin", name: "Plugin", plans: [] },
    },
  ];
  for (const example of cases) {
    assert.equal(
      await runCli(
        example.args,
        {
          ...tenantEnv,
          OPERATOR_TOKEN: operatorToken,
          OPERATOR_ORIGIN: "https://wrong.example",
        },
        io,
      ),
      0,
    );
    const call = calls.at(-1)!;
    assert.equal(call.path, `/api/v1/tenants/alpha-team/seller${example.path}`);
    assert.equal(call.authorization, `Bearer ${key}`);
    assert.equal(call.method, example.body === undefined ? "GET" : "POST");
    assert.equal(
      call.body.toString(),
      example.body === undefined ? "" : JSON.stringify(example.body),
    );
  }
  assert.equal(errors.length, 0);
});
test("framework asset publication sends exact raw bytes and metadata through the tenant API", async () => {
  assert.equal(await runCli(["publish-asset","desktop","1.2.3",file("release.zip"),file("metadata.json")],tenantEnv,io),0);
  const call=calls.at(-1)!;
  assert.equal(call.path,"/api/v1/tenants/alpha-team/seller/assets/desktop/1.2.3");
  assert.equal(call.type,"application/octet-stream");
  assert.deepEqual(call.body,Buffer.from([0,1,2,255]));
  assert.equal(call.authorization,`Bearer ${key}`);
  assert.deepEqual(JSON.parse(Buffer.from(call.metadata!,"base64url").toString()),{changelog:"Unicode é\nLiteral `ticks` $()"});
  for (const args of [[],["desktop"],["desktop","1.2.3"],["desktop","1.2.3",file("release.zip")]])
    assert.equal(await runCli(["publish-asset",...args],tenantEnv,io),1);
});
test("platform commands use operator routes and never substitute tenant API keys", async () => {
  const cases: { args: string[]; path: string; body?: unknown }[] = [
    { args: ["tenants"], path: "/tenants" },
    {
      args: ["tenant-status", "tenant/one", file("status.json")],
      path: "/tenants/tenant%2Fone/status",
      body: { maxProducts: 40, exempt: true },
    },
    {
      args: ["tenant-owner", "tenant/one", "owner@example.test"],
      path: "/tenants/tenant%2Fone/owner",
      body: { email: "owner@example.test" },
    },
    {
      args: ["platform-reconcile", "tenant/one"],
      path: "/tenants/tenant%2Fone/reconcile",
      body: {},
    },
    { args: ["platform-jobs"], path: "/jobs" },
    { args: ["platform-work"], path: "/jobs/run", body: {} },
    {
      args: ["local-tenant", "tenant/one", file("local.json")],
      path: "/local/tenants/tenant%2Fone",
      body: { connected: true, paidDays: 30 },
    },
  ];
  for (const example of cases) {
    assert.equal(
      await runCli(
        example.args,
        {
          ...operatorEnv,
          TENANT_API_KEY: key,
          OPERATOR_ORIGIN: origin,
          PUBLIC_ORIGIN: "https://unused.example",
        },
        io,
      ),
      0,
    );
    const call = calls.at(-1)!;
    assert.equal(call.path, `/api/v1/operator${example.path}`);
    assert.equal(call.authorization, `Bearer ${operatorToken}`);
    assert.equal(
      call.body.toString(),
      example.body === undefined ? "" : JSON.stringify(example.body),
    );
  }
});
test("seller namespace and credentials reject missing, malformed and path-selected values before HTTP", async () => {
  for (const env of [
    {},
    { TENANT_SLUG: "alpha" },
    { TENANT_API_KEY: key },
    { TENANT_SLUG: "../operator", TENANT_API_KEY: key },
    { TENANT_SLUG: "Alpha", TENANT_API_KEY: key },
    { TENANT_SLUG: "a".repeat(101), TENANT_API_KEY: key },
    { TENANT_SLUG: "alpha", TENANT_API_KEY: operatorToken },
  ]) {
    assert.equal(
      await runCli(["licenses"], { PUBLIC_ORIGIN: origin, ...env }, io),
      1,
    );
  }
  assert.equal(await runCli(["tenants"], tenantEnv, io), 1);
  assert.equal(calls.length, 0);
  assert.ok(
    errors.every((v) => !v.includes(key) && !v.includes(operatorToken)),
  );
});

test("origins reject URL credentials and routing components before sending bearer credentials", async () => {
  for (const value of [
    "ftp://example.test",
    "http://user@example.test",
    "http://:password@example.test",
    "https://example.test/path",
    "https://example.test?query=1",
    "https://example.test#fragment",
    "not a URL",
  ]) {
    assert.equal(
      await runCli(["licenses"], { ...tenantEnv, PUBLIC_ORIGIN: value }, io),
      1,
    );
  }
  for (const command of [
    ["revoke", "."],
    ["restore", ".."],
    ["withdraw", ".."],
  ])
    assert.equal(await runCli(command, tenantEnv, io), 1);
  assert.equal(calls.length, 0);
});
test("operator arguments and credentials fail closed without making requests", async () => {
  for (const args of [
    ["tenant-status"],
    ["tenant-status", "id"],
    ["tenant-owner"],
    ["tenant-owner", "id"],
    ["platform-reconcile"],
    ["local-tenant"],
    ["local-tenant", "id"],
  ])
    assert.equal(await runCli(args, operatorEnv, io), 1);
  assert.equal(
    await runCli(["tenants"], { ...operatorEnv, OPERATOR_TOKEN: "short" }, io),
    1,
  );
  assert.equal(calls.length, 0);
});
test("remote results and errors redact configured credentials, including provider echoes", async () => {
  const secret = "ab".repeat(32);
  const sensitive = { tenantKey: key, operator: operatorToken, secret };
  responseBody = JSON.stringify(sensitive);
  const env = {
    ...tenantEnv,
    OPERATOR_TOKEN: operatorToken,
    APP_SECRET: secret,
  };
  assert.equal(await runCli(["licenses"], env, io), 0);
  status = 403;
  assert.equal(await runCli(["licenses"], env, io), 1);
  for (const message of [...output, ...errors]) {
    assert.ok(!message.includes(key));
    assert.ok(!message.includes(operatorToken));
    assert.ok(!message.includes(secret));
    assert.ok(message.includes("[redacted]"));
  }
  assert.equal(calls[0]!.authorization, `Bearer ${key}`);
});
test("remote defaults use local origin, operator origin falls back to public origin, and redirects stay disabled", async (t) => {
  const captured: { url: string; options: RequestInit | undefined }[] = [];
  const fake = t.mock.method(
    globalThis,
    "fetch",
    async (url: string | URL | Request, options?: RequestInit) => {
      captured.push({ url: String(url), options });
      return new Response('{"ok":true}', {
        headers: { "content-type": "application/json" },
      });
    },
  );
  assert.equal(
    await runCli(
      ["licenses"],
      { TENANT_SLUG: "alpha", TENANT_API_KEY: key, APP_SECRET: "" },
      io,
    ),
    0,
  );
  assert.equal(
    captured[0]!.url,
    "http://localhost:3211/api/v1/tenants/alpha/seller/overview",
  );
  assert.equal(await runCli(["tenants"], operatorEnv, io), 0);
  assert.equal(captured[1]!.url, `${origin}/api/v1/operator/tenants`);
  assert.ok(captured.every((call) => call.options!.redirect === "error"));
  fake.mock.restore();
});
test('native CLI sends a bounded file stream with explicit length and duplex mode',async t=>{
 t.mock.method(globalThis,'fetch',async(_url:unknown,options:RequestInit & {duplex?:string})=>{
  assert.equal(options.headers && (options.headers as Record<string,string>)['content-length'],'4');assert.equal(options.duplex,'half');assert.ok(options.body && !(options.body instanceof Uint8Array));
  const reader=(options.body as ReadableStream<Uint8Array>).getReader();let length=0;while(true){const value=await reader.read();if(value.done)break;length+=value.value.byteLength;}assert.equal(length,4);
  return new Response('{"ok":true}');
 });
 assert.equal(await runCli(['publish-asset','app','1.0.0',file('release.zip'),file('metadata.json')],tenantEnv,io),0);
});
