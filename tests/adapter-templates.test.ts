import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { readFile, writeFile, mkdtemp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";

const base = "https://updates.example/api/v1/tenants/vendor";
const asset = `${base}/packages/example/assets/asset-1/example.zip`;
async function moduleAt(path: string) {
  return import(new URL(`../examples/${path}`, import.meta.url).href);
}
function store() {
  let id: string | undefined;
  let token: string | undefined;
  return {
    async getOrCreateId() {
      return (id ??= "43dd1633-bf3a-4ba7-8dd8-ab8b19b941cf");
    },
    async getToken() {
      return token;
    },
    async setToken(value: string | undefined) {
      token = value;
    },
  };
}
test("Generic client persists device identity and completes activation/status/download/deactivation", async () => {
  const { createClient } = await moduleAt("generic/client.mjs");
  const storage = store();
  const requests: { url: string; options: RequestInit }[] = [];
  const fetcher = async (url: string, options: RequestInit) => {
    requests.push({ url, options });
    if (url.endsWith("/activate"))
      return Response.json({
        token: "activation_token",
        installationId: "43dd1633-bf3a-4ba7-8dd8-ab8b19b941cf",
      });
    if (url === asset) return new Response("bundle");
    if (url.includes("/updates/"))
      return Response.json({ version: "2.0.0", assets: [{ url: asset }] });
    return Response.json({ ok: true });
  };
  const client = await createClient({
    api: base,
    product: "example",
    storage,
    fetcher,
  });
  await client.activate("license-key", "Work laptop");
  const body = JSON.parse(requests[0]!.options.body as string);
  assert.equal(body.installationLabel, "Work laptop");
  assert.equal(body.siteUrl, undefined);
  assert.equal(body.installationId, client.installationId);
  await client.status();
  await client.updates("linux-x64", "1.0.0");
  await client.download(asset);
  await client.deactivate();
  for (const req of requests.slice(1)) {
    assert.equal(
      new Headers(req.options.headers).get("Authorization"),
      "Bearer activation_token",
    );
    assert.equal(req.options.redirect, "error");
  }
  const reopened = await createClient({
    api: base,
    product: "example",
    storage,
    fetcher,
  });
  assert.equal(reopened.installationId, client.installationId);
  await assert.rejects(() => reopened.status(), /Activate updates/);
});

test("Generic client restricts Bearer credentials to exact configured product routes", async () => {
  const { createClient } = await moduleAt("generic/client.mjs");
  const storage = store();
  await storage.setToken("activation_token");
  const client = await createClient({
    api: base,
    product: "example",
    storage,
    fetcher: async () => new Response("ok"),
  });
  assert.deepEqual(await client.headersFor(asset), {
    Authorization: "Bearer activation_token",
  });
  for (const url of [
    asset.replace("updates.example", "evil.example"),
    asset.replace("/example/", "/other/"),
    `${base}/seller/products`,
    `${asset}?token=secret`,
    `${asset}#fragment`,
    asset.replace("https:", "http:"),
    asset.replace("https://", "https://user:pass@"),
    `${base}/packages/example/assets/../../seller`,
    `${base}/updates/generic/example-other/linux-x64`,
  ]) {
    assert.deepEqual(await client.headersFor(url), {}, url);
    await assert.rejects(
      () => client.download(url),
      /Untrusted update URL/,
      url,
    );
  }
  for (const api of [
    base.replace("https:", "http:"),
    `${base}?token=secret`,
    `${base}/extra`,
    base.replace("https://", "https://user:pass@"),
  ])
    await assert.rejects(
      () => createClient({ api, product: "example", storage }),
      /configuration/i,
    );
  await assert.rejects(
    () => createClient({ api: base, product: "../bad", storage }),
    /configuration/i,
  );
});

test("Client errors are sanitized; malformed responses never replace stored activation", async () => {
  const { createClient } = await moduleAt("generic/client.mjs");
  const storage = store();
  await storage.setToken("existing_token");
  let response = Response.json({ token: "stolen", installationId: "other" });
  const client = await createClient({
    api: base,
    product: "example",
    storage,
    fetcher: async () => response,
  });
  await assert.rejects(
    () => client.activate("key"),
    /Invalid activation response/,
  );
  assert.equal(await storage.getToken(), "existing_token");
  response = new Response("secret provider detail", { status: 403 });
  await assert.rejects(() => client.deactivate(), /Update access denied/);
  assert.equal(await storage.getToken(), "existing_token");
  response = new Response(null, { status: 204 });
  assert.equal(await client.updates("linux-x64"), undefined);
  response = new Response("invalid json");
  await assert.rejects(() => client.status(), /Invalid service response/);
  const offline = await createClient({
    api: base,
    product: "example",
    storage,
    fetcher: async () => {
      throw new Error("secret token");
    },
  });
  await assert.rejects(
    () => offline.status(),
    /^Error: Licensing service unavailable$/,
  );
});

test("Generic site products submit a real site URL only when explicitly configured", async () => {
  const { createClient } = await moduleAt("generic/client.mjs");
  let body: Record<string, unknown> = {};
  const client = await createClient({
    api: base,
    product: "example",
    storage: store(),
    siteUrl: "https://site.example",
    fetcher: async (_url: string, o: RequestInit) => {
      body = JSON.parse(o.body as string);
      return Response.json({
        token: "token",
        installationId: body.installationId,
      });
    },
  });
  await client.activate("key");
  assert.equal(body.siteUrl, "https://site.example");
});

test("Electron integration configures authenticated generic native updater without differential fallback", async () => {
  const { configureElectronUpdater } = await moduleAt("electron/updater.mjs");
  const calls: unknown[] = [];
  const updater = {
    requestHeaders: {},
    disableDifferentialDownload: false,
    autoDownload: true,
    setFeedURL(v: unknown) {
      calls.push(v);
    },
    on(_event: string, fn: (e: Error) => void) {
      fn(new Error("secret"));
    },
    checkForUpdates() {
      calls.push("check");
    },
  };
  const client = {
    api: base,
    product: "example",
    async token() {
      return "activation_token";
    },
  };
  const configured = await configureElectronUpdater(
    client,
    updater,
    "darwin-arm64",
    () => {
      calls.push("Update check failed. Try again later.");
    },
  );
  assert.equal(configured, updater);
  assert.equal(updater.disableDifferentialDownload, true);
  assert.equal(updater.autoDownload, false);
  assert.deepEqual(updater.requestHeaders, {
    Authorization: "Bearer activation_token",
  });
  assert.ok(
    JSON.stringify(calls).includes(
      `${base}/updates/electron/example/darwin-arm64`,
    ),
  );
});

test("Native templates include authenticated lifecycle and documented integration boundaries", async () => {
  for (const [folder, source] of [
    ["joomla", "src/Extension/DoubleEntitle.php"],
    ["tauri", "updates.rs"],
    ["sparkle", "LicenseUpdates.swift"],
    ["jetbrains", "LicenseUpdates.kt"],
  ]) {
    const text = await readFile(
      new URL(`../examples/${folder}/${source}`, import.meta.url),
      "utf8",
    );
    for (const marker of ["activate", "deactivate", "Bearer", "installationId"])
      assert.ok(text.includes(marker), `${folder}: ${marker}`);
    const readme = await readFile(
      new URL(`../examples/${folder}/README.md`, import.meta.url),
      "utf8",
    );
    assert.match(readme, /qualification/i);
    assert.match(readme, /https:\/\//);
  }
});

test("Joomla installer events scope credentials to the configured product", (t) => {
  const result = spawnSync(
    "php",
    [fileURLToPath(new URL("./joomla-template.test.php", import.meta.url))],
    { encoding: "utf8" },
  );
  if (
    result.error &&
    "code" in result.error &&
    result.error.code === "ENOENT"
  ) {
    t.skip("PHP is unavailable; native event template contract not executed");
    return;
  }
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /contracts passed/);
});

test("JetBrains URL scope supports the IDE native query without authenticating unrelated requests", async (t) => {
  const home =
    process.env.JAVA_TEST_HOME ??
    "/Applications/Android Studio.app/Contents/jbr/Contents/Home";
  if (!existsSync(`${home}/bin/javac`)) {
    t.skip("JDK unavailable; Java URL scope contract not executed");
    return;
  }
  const base = "/Volumes/Scratch/double-entitle-wp/tmp/framework-protocols";
  await mkdir(base, { recursive: true });
  const output = await mkdtemp(`${base}/jetbrains-`);
  try {
    const compile = spawnSync(
      `${home}/bin/javac`,
      [
        `-J-Djava.io.tmpdir=${base}`,
        "-d",
        output,
        fileURLToPath(
          new URL("../examples/jetbrains/UpdateScope.java", import.meta.url),
        ),
        fileURLToPath(new URL("./JetBrainsScopeTest.java", import.meta.url)),
      ],
      { encoding: "utf8" },
    );
    assert.equal(compile.status, 0, compile.stderr);
    const run = spawnSync(
      `${home}/bin/java`,
      [
        `-Djava.io.tmpdir=${base}`,
        "-cp",
        output,
        "example.licensing.JetBrainsScopeTest",
      ],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /contracts passed/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("Electron storage refuses corrupt identities and insecure credential storage", async () => {
  const { electronStorage } = await moduleAt("electron/storage.mjs");
  const base = "/Volumes/Scratch/double-entitle-wp/tmp/framework-protocols";
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(`${base}/electron-`);
  try {
    const insecure = electronStorage(directory, {
      isEncryptionAvailable() {
        return true;
      },
      getSelectedStorageBackend() {
        return "basic_text";
      },
    });
    await assert.rejects(
      () => insecure.getToken(),
      /Secure credential storage unavailable/,
    );
    await assert.rejects(
      () => insecure.setToken("token"),
      /Secure credential storage unavailable/,
    );
    await writeFile(`${directory}/installation-id`, "");
    await assert.rejects(
      () => insecure.getOrCreateId(),
      /Invalid stored installation ID/,
    );
    await rm(`${directory}/installation-id`);
    const identities = await Promise.all(
      Array.from({ length: 50 }, () => insecure.getOrCreateId()),
    );
    assert.equal(new Set(identities).size, 1);
    assert.match(identities[0]!, /^[a-f0-9-]{36}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Electron updater reconfiguration registers one error listener", async () => {
  const { configureElectronUpdater } = await moduleAt("electron/updater.mjs");
  const updater = Object.assign(new EventEmitter(), { setFeedURL() {} });
  const client = {
    api: base,
    product: "example",
    async token() {
      return "activation_token";
    },
  };
  let shown = 0;
  await configureElectronUpdater(client, updater, "darwin-arm64", () => {
    shown++;
  });
  await configureElectronUpdater(client, updater, "darwin-arm64", () => {
    shown++;
  });
  assert.equal(updater.listenerCount("error"), 1);
  updater.emit("error", new Error("secret native response"));
  assert.equal(shown, 1);
});

test("Sparkle uses delegate feed selection and ignores normal no-update/cancellation outcomes", async () => {
  const text = await readFile(
    new URL("../examples/sparkle/LicenseUpdates.swift", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(text, /\.feedURL\s*=/);
  assert.match(text, /func feedURLString\(for updater: SPUUpdater\)/);
  assert.match(text, /SUSparkleErrorDomain/);
  assert.match(text, /SUError\.noUpdateError\.rawValue/);
  assert.match(text, /SUError\.installationCanceledError\.rawValue/);
});
