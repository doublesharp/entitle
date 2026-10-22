import assert from "node:assert/strict";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, writeFile, rm, chmod } from "node:fs/promises";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createServer } from "node:https";
import { request } from "node:http";
import { join, resolve } from "node:path";
import mysql from "mysql2/promise";
import { buildApp } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { createDb, migrate } from "../src/db.ts";
import { InMemoryArtifactStore } from "../src/storage.ts";
import { hash, unseal } from "../src/crypto.ts";

// Explicit opt-in fixture. Joomla source, secrets, TLS material and output stay on Scratch.
assert.equal(
  process.env.QUALIFY_JOOMLA,
  "1",
  "Set QUALIFY_JOOMLA=1 to run the isolated native fixture.",
);
process.env.NODE_ENV = "test";
const scratch = "/Volumes/Scratch/entitle";
const root = resolve(
  process.env.JOOMLA_FIXTURE_ROOT ?? `${scratch}/tmp/joomla-native-20261021`,
);
assert.ok(root.startsWith(`${scratch}/tmp/joomla-native-`));
const siteRoot = join(root, "site"),
  reports = `${scratch}/reports/joomla-native-20261021`;
const archive = process.env.JOOMLA_ARCHIVE ?? join(root, "joomla-6.1.3.tar.gz");
assert.ok(resolve(archive).startsWith(`${scratch}/`));
const run = promisify(execFile);
await mkdir(root, { recursive: true });
await mkdir(reports, { recursive: true });
const env = {
  ...process.env,
  TMPDIR: root,
  SSL_CERT_FILE: join(root, "localhost.crt"),
};
const command = async (
  file: string,
  args: string[],
  label: string,
  cwd = root,
) => {
  try {
    const result = await run(file, args, {
      cwd,
      env,
      maxBuffer: 8 * 1024 * 1024,
    });
    await writeFile(
      join(reports, `${label}.log`),
      result.stdout + result.stderr,
      { mode: 0o600 },
    );
    return result.stdout;
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; code?: number };
    await writeFile(
      join(reports, `${label}.log`),
      (result.stdout ?? "") + (result.stderr ?? ""),
      { mode: 0o600 },
    );
    // eslint-disable-next-line preserve-caught-error -- execFile errors contain secret command arguments.
    throw Error(
      `${label} failed with exit ${result.code}. See private Scratch log.`,
    );
  }
};
const archiveBytes = await readFile(archive);
assert.equal(
  createHash("sha1").update(archiveBytes).digest("hex"),
  "a82d1de02f1b826eacd3d990888f9f75bd49c707",
);
await rm(siteRoot, { recursive: true, force: true });
await mkdir(siteRoot, { recursive: true });
await command("tar", ["-xzf", archive, "-C", siteRoot], "unpack-joomla");
const dbName = `entitle_joomla_${randomUUID().replaceAll("-", "")}`;
const admin = await mysql.createConnection({
  host: "127.0.0.1",
  port: 53306,
  user: "root",
  password: process.env.JOOMLA_MYSQL_PASSWORD ?? "entitle-test",
});
let app: Awaited<ReturnType<typeof buildApp>> | undefined;
let db: ReturnType<typeof createDb> | undefined;
let upstreamPort = 0;
const requests: {
  method: string;
  path: string;
  authorized: boolean;
  status: number;
}[] = [];
await command(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    join(root, "localhost.key"),
    "-out",
    join(root, "localhost.crt"),
    "-days",
    "1",
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
  ],
  "certificate",
);
await chmod(join(root, "localhost.key"), 0o600);
const tls = createServer(
  {
    key: await readFile(join(root, "localhost.key")),
    cert: await readFile(join(root, "localhost.crt")),
  },
  (req, res) => {
    const forwarded = request(
      {
        hostname: "127.0.0.1",
        port: upstreamPort,
        path: req.url,
        method: req.method,
        headers: req.headers,
      },
      (reply) => {
        requests.push({
          method: req.method!,
          path: req.url!,
          authorized: !!req.headers.authorization,
          status: reply.statusCode!,
        });
        res.writeHead(reply.statusCode!, reply.headers);
        reply.pipe(res);
      },
    );
    forwarded.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(forwarded);
  },
);
await new Promise<void>((resolve) => tls.listen(0, "127.0.0.1", resolve));
const address = tls.address();
assert.ok(address && typeof address !== "string");
const origin = `https://localhost:${address.port}`,
  prefix = "/api/v1/tenants/primary",
  slug = "native-library";
const secrets = {
  adminPassword: randomBytes(24).toString("base64url"),
  secret: randomBytes(32).toString("hex"),
  operator: randomBytes(32).toString("base64url"),
  sellerKey: `DE-TK-${randomBytes(32).toString("base64url")}`,
};
await writeFile(join(root, "fixture-secrets.json"), JSON.stringify(secrets), {
  mode: 0o600,
});
try {
  await admin.query(`CREATE DATABASE \`${dbName}\``);
  await rm(join(siteRoot, "configuration.php"), { force: true });
  await command(
    "php",
    [
      join(siteRoot, "installation/joomla.php"),
      "install",
      "--no-interaction",
      "--site-name=Doublesharp Entitle native fixture",
      "--admin-user=Fixture administrator",
      "--admin-username=fixtureadmin",
      `--admin-password=${secrets.adminPassword}`,
      "--admin-email=fixture@example.test",
      "--db-type=mysqli",
      "--db-host=127.0.0.1:53306",
      "--db-user=root",
      `--db-pass=${process.env.JOOMLA_MYSQL_PASSWORD ?? "entitle-test"}`,
      `--db-name=${dbName}`,
      "--db-prefix=fixture_",
    ],
    "install-joomla",
  );
  console.log("Real Joomla6.1.3 installation completed.");
  const config = loadConfig({
    PUBLIC_ORIGIN: origin,
    APP_SECRET: secrets.secret,
    OPERATOR_TOKEN: secrets.operator,
    DATA_DIR: join(root, "service"),
    LOCAL_BILLING: "true",
  });
  await rm(join(root, "service"), { recursive: true, force: true });
  await mkdir(join(root, "service"), { recursive: true });
  db = createDb(config.databaseUrl);
  await migrate(db);
  await db("tenant_api_keys").insert({
    id: randomUUID(),
    tenant_id: "primary",
    name: "Native Joomla fixture",
    key_hash: hash(secrets.sellerKey),
    scopes: JSON.stringify([
      "read",
      "catalog:write",
      "releases:write",
      "licenses:write",
    ]),
    display_prefix: secrets.sellerKey.slice(0, 14),
    created_at: Date.now(),
    expires_at: Date.now() + 86400000,
    revoked_at: null,
    last_used_at: null,
  });
  app = await buildApp(
    config,
    db,
    { send: async () => {} },
    { store: new InMemoryArtifactStore() },
  );
  await app.listen({ port: 0, host: "127.0.0.1" });
  const appAddress = app.server.address();
  assert.ok(appAddress && typeof appAddress !== "string");
  upstreamPort = appAddress.port;
  const headers = { authorization: `Bearer ${secrets.sellerKey}` };
  const configured = await app.inject({
    method: "POST",
    url: prefix + "/seller/products",
    headers,
    payload: {
      name: "Native library",
      slug,
      framework: "joomla",
      frameworkConfig: {
        extensionType: "library",
        element: "entitlefixture",
        client: "site",
        joomlaMajor: 6,
      },
      plans: [
        { name: "Annual", siteAllowance: 2, priceId: "price_native_fixture" },
      ],
    },
  });
  assert.equal(configured.statusCode, 200, configured.body);
  const paid = await app.inject({
    method: "POST",
    url: prefix + "/seller/local/purchase",
    headers,
    payload: {
      planId: configured.json().plans[0].id,
      email: "joomla@example.test",
    },
  });
  assert.equal(paid.statusCode, 200, paid.body);
  const license = await db("licenses")
    .where({ tenant_id: "primary", product_id: configured.json().product.id })
    .first();
  const email = await db("emails")
    .where({
      tenant_id: "primary",
      license_id: license.id,
      kind: "license_key",
    })
    .first();
  const key = /Your license key is (DE-[A-Za-z0-9_-]+)/.exec(
    unseal<{ text: string }>(email.payload, config.secret).text,
  )![1]!;
  const feed = origin + prefix + `/updates/joomla/${slug}.xml`;
  for (const version of ["1.0.0", "2.0.0"]) {
    const dir = join(root, `library-${version}`);
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(
      join(dir, "entitlefixture.xml"),
      `<?xml version="1.0"?><extension type="library" method="upgrade"><name>Doublesharp Entitle fixture</name><libraryname>entitlefixture</libraryname><version>${version}</version><files><folder>src</folder></files><updateservers><server type="collection" priority="1" name="Fixture updates">${feed}</server></updateservers></extension>`,
    );
    await writeFile(join(dir, "src/version.txt"), version);
    await writeFile(join(dir, "src/fixture.php"), `<?php return '${version}';`);
    await command(
      "zip",
      ["-qr", join(root, `library-${version}.zip`), "."],
      `zip-${version}`,
      dir,
    );
  }
  const bytes = await readFile(join(root, "library-2.0.0.zip"));
  const published = await app.inject({
    method: "POST",
    url: prefix + `/seller/assets/${slug}/2.0.0`,
    headers: {
      ...headers,
      "content-type": "application/octet-stream",
      "x-release-metadata": Buffer.from(
        JSON.stringify({
          target: "any",
          filename: "library-2.0.0.zip",
          changelog: "Native qualification update",
        }),
      ).toString("base64url"),
    },
    payload: bytes,
  });
  assert.equal(published.statusCode, 200, published.body);
  await writeFile(
    join(root, "native-config.json"),
    JSON.stringify({
      root: siteRoot,
      repo: process.cwd(),
      apiBase: origin + prefix,
      product: slug,
      key,
      feed,
      assetUrl:
        origin +
        prefix +
        `/packages/${slug}/assets/${published.json().asset.id}/library-2.0.0.zip`,
      checksum: published.json().asset.checksum,
      library: join(root, "library-1.0.0"),
      work: root,
    }),
    { mode: 0o600 },
  );
  await writeFile(join(root, "native.php"), nativeHarness(), { mode: 0o600 });
  const bundledCa = join(
    siteRoot,
    "libraries/vendor/composer/ca-bundle/res/cacert.pem",
  );
  const originalCa = await readFile(bundledCa);
  // Joomla's deprecated CMS HTTP transport forces its bundled CA file. Trust only
  // this disposable copied runtime while its one fixture PHP process executes.
  const php = async (action: string) => {
    await writeFile(
      bundledCa,
      Buffer.concat([originalCa, await readFile(join(root, "localhost.crt"))]),
    );
    let output: string;
    try {
      output = await command(
        "php",
        [
          "-d",
          `curl.cainfo=${join(root, "localhost.crt")}`,
          "-d",
          `openssl.cafile=${join(root, "localhost.crt")}`,
          "-d",
          `session.save_path=${root}`,
          join(root, "native.php"),
          action,
          join(root, "native-config.json"),
        ],
        `native-${action}`,
      );
    } finally {
      await writeFile(bundledCa, originalCa);
    }
    const result = /QUALIFICATION_RESULT:(.*)/.exec(output);
    assert.ok(result, output);
    return JSON.parse(result[1]!);
  };
  console.log("Native extension install:", await php("install"));
  const result = await php("update");
  result.reconnect = await php("reconnect");
  console.log("Native update result:", JSON.stringify(result));
  await writeFile(
    join(reports, "requests.json"),
    JSON.stringify(requests, null, 2),
  );
  const sourceHashes: Record<string, string> = {};
  for (const file of [
    "scripts/qualify-joomla.ts",
    "src/framework-api.ts",
    "src/update-adapters.ts",
    "src/frameworks.ts",
    "examples/joomla/src/Extension/Entitle.php",
    "examples/joomla/services/provider.php",
    "examples/joomla/entitle.xml",
  ])
    sourceHashes[file] = createHash("sha256")
      .update(await readFile(resolve(file)))
      .digest("hex");
  for (const file of [
    "libraries/src/Updater/Update.php",
    "libraries/src/Updater/UpdateAdapter.php",
    "libraries/src/Updater/Adapter/CollectionAdapter.php",
    "libraries/src/Updater/Adapter/ExtensionAdapter.php",
    "libraries/src/Installer/InstallerHelper.php",
    "administrator/components/com_installer/src/Model/UpdateModel.php",
  ])
    sourceHashes[`Joomla6.1.3/${file}`] = createHash("sha256")
      .update(await readFile(join(siteRoot, file)))
      .digest("hex");
  const caBundleRestored = (await readFile(bundledCa)).equals(originalCa);
  assert.equal(caBundleRestored, true);
  await writeFile(
    join(reports, "result.json"),
    JSON.stringify(
      {
        joomla: "6.1.3",
        php: "8.5.11",
        archiveSha256: createHash("sha256").update(archiveBytes).digest("hex"),
        sourceHashes,
        caBundleRestored,
        result,
        requests,
      },
      null,
      2,
    ),
  );
  assert.equal(result.pluginBooted, true);
  assert.equal(result.activated, true);
  assert.equal(result.discovery, true);
  assert.equal(result.discoveredVersion, "2.0.0");
  assert.equal(result.nativePackageDownloaded, true);
  assert.equal(result.nativePackageSha256Matches, true);
  assert.equal(result.foreignHeadersUntouched, true);
  assert.equal(result.detailsLoaded, true);
  assert.equal(result.nativeUpdateResult, 1);
  assert.equal(result.installedVersion, "2.0.0");
  assert.equal(result.reconnect.installationId, result.installationId);
  assert.equal(result.reconnect.status.entitled, true);
  assert.equal(result.reconnect.stableAfterDeactivate, true);
  assert.equal(result.reconnect.deactivated, true);
  assert.equal(result.reconnect.customDataPreserved, true);
  assert.equal(result.reconnect.paramsContainNoSecrets, true);
  assert.equal(result.reconnect.installedFeatureAfterDeactivate, "2.0.0");
  if (
    requests.some(
      (r) =>
        r.path.includes("/updates/joomla/") &&
        !r.authorized &&
        r.status === 401,
    )
  )
    console.log(
      "REPRODUCED: native details reload omitted Authorization and was denied.",
    );
} finally {
  await writeFile(
    join(reports, "requests.json"),
    JSON.stringify(requests, null, 2),
  );
  await app?.close();
  await db?.destroy();
  await new Promise<void>((resolve) => tls.close(() => resolve()));
  await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  const [remaining] = await admin.query("SHOW DATABASES LIKE ?", [dbName]);
  assert.equal((remaining as unknown[]).length, 0);
  await admin.end();
  await rm(root, { recursive: true, force: true });
  await writeFile(
    join(reports, "cleanup.json"),
    JSON.stringify(
      {
        database: dbName,
        databaseDropped: true,
        serviceClosed: true,
        tlsListenerClosed: true,
        taskRoot: root,
        temporaryRootRemoved: true,
      },
      null,
      2,
    ),
  );
  console.log(
    "Task-owned service, TLS listener, unique Joomla database and temporary source/secrets cleaned.",
  );
}

function nativeHarness() {
  return String.raw`<?php
error_reporting(E_ALL & ~E_DEPRECATED);
$c=json_decode(file_get_contents($argv[2]),true);
$_SERVER['HTTP_HOST']='localhost';$_SERVER['HTTPS']='on';$_SERVER['SERVER_PORT']='443';$_SERVER['REQUEST_URI']='/administrator/index.php';$_SERVER['SCRIPT_NAME']='/administrator/index.php';
define('_JEXEC',1);define('JPATH_BASE',$c['root'].'/administrator');
require JPATH_BASE.'/includes/defines.php';require JPATH_BASE.'/includes/framework.php';
$container=Joomla\CMS\Factory::getContainer();
$container->alias('session.web','session.web.administrator')->alias('session','session.web.administrator')->alias(Joomla\CMS\Session\Session::class,'session.web.administrator')->alias(Joomla\Session\Session::class,'session.web.administrator')->alias(Joomla\Session\SessionInterface::class,'session.web.administrator');
$app=$container->get(Joomla\CMS\Application\AdministratorApplication::class);Joomla\CMS\Factory::$application=$app;
$app->getConfig()->set('tmp_path',$c['work']);$app->getConfig()->set('log_path',$c['work'].'/logs');
$db=$container->get(Joomla\Database\DatabaseInterface::class);
$admin=$db->setQuery('SELECT id FROM #__users WHERE username='.$db->quote('fixtureadmin'))->loadResult();
$app->loadIdentity($container->get(Joomla\CMS\User\UserFactoryInterface::class)->loadUserById((int)$admin));
$app->createExtensionNamespaceMap();
$result=[];
try {
if($argv[1]==='install') {
  $installer=Joomla\CMS\Installer\Installer::getInstance();
  if(!$installer->install($c['repo'].'/examples/joomla'))throw new RuntimeException('Installer transport install failed.');
  if(!$installer->install($c['library']))throw new RuntimeException('Fixture library install failed.');
  $params=json_encode(['api_base'=>$c['apiBase'],'product'=>$c['product']]);
  $db->setQuery('UPDATE #__extensions SET enabled=1,params='.$db->quote($params).' WHERE type='.$db->quote('plugin').' AND folder='.$db->quote('installer').' AND element='.$db->quote('entitle'))->execute();
  $db->setQuery('UPDATE #__extensions SET custom_data='.$db->quote(json_encode(['fixture_kept'=>'keep'])).' WHERE type='.$db->quote('plugin').' AND folder='.$db->quote('installer').' AND element='.$db->quote('entitle'))->execute();
  $result=['installed'=>true];
} elseif($argv[1]==='reconnect') {
  $plugin=$app->bootPlugin('entitle','installer');
  $result['installationId']=$plugin->installationId();$result['status']=$plugin->status();
  $row=$db->setQuery('SELECT params,custom_data FROM #__extensions WHERE type='.$db->quote('plugin').' AND folder='.$db->quote('installer').' AND element='.$db->quote('entitle'))->loadAssoc();
  $custom=json_decode($row['custom_data'],true);$params=json_decode($row['params'],true);
  $result['customDataPreserved']=($custom['fixture_kept']??'')==='keep';
  $result['paramsContainNoSecrets']=!isset($params['activation_token'])&&!isset($params['installation_id']);
  $plugin->deactivate();$result['stableAfterDeactivate']=$plugin->installationId()===$result['installationId'];
  try{$plugin->status();$result['deactivated']=false;}catch(RuntimeException $e){$result['deactivated']=$e->getMessage()==='Activate updates first.';}
  $result['installedFeatureAfterDeactivate']=include $c['root'].'/libraries/entitlefixture/src/fixture.php';
} else {
  $plugin=$app->bootPlugin('entitle','installer');$result['pluginBooted']=get_class($plugin)==='Entitle\\Plugin\\Installer\\Entitle\\Extension\\Entitle';
  $plugin->activate($c['key']);$result['activated']=true;$result['installationId']=$plugin->installationId();$result['status']=$plugin->status();
  $id=$db->setQuery('SELECT extension_id FROM #__extensions WHERE type='.$db->quote('library').' AND element='.$db->quote('entitlefixture'))->loadResult();
  $result['discovery']=Joomla\CMS\Updater\Updater::getInstance()->findUpdates((int)$id,0);
  $update=$db->setQuery('SELECT update_id,detailsurl,version FROM #__updates WHERE extension_id='.(int)$id)->loadObject();
  $result['discoveredVersion']=$update->version??null;
  $package=Joomla\CMS\Installer\InstallerHelper::downloadPackage($c['assetUrl']);
  $result['nativePackageDownloaded']=(bool)$package;
  if($package){$result['nativePackageSha256Matches']=hash_file('sha256',$c['work'].'/'.$package)===$c['checksum'];}
  $foreign=new Joomla\CMS\Event\Installer\BeforePackageDownloadEvent('onInstallerBeforePackageDownload',['url'=>'https://example.invalid/file.zip','headers'=>['Accept'=>'keep']]);
  $plugin->headers($foreign);$result['foreignHeadersUntouched']=$foreign->getHeaders()===['Accept'=>'keep'];

  $result['extensionRow']=$db->setQuery('SELECT extension_id,element,type,folder,client_id,manifest_cache FROM #__extensions WHERE extension_id='.(int)$id)->loadAssoc();
  $result['updateRows']=$db->setQuery('SELECT update_id,extension_id,name,element,type,folder,client_id,version,detailsurl FROM #__updates')->loadAssocList();
  if(!$update){throw new RuntimeException('Native updater failed to map the installed extension.');}

  $nativeUpdate=new Joomla\CMS\Updater\Update();$result['detailsLoaded']=$nativeUpdate->loadFromXml($update->detailsurl);
  $model=$app->bootComponent('com_installer')->getMVCFactory()->createModel('Update','Administrator',['ignore_request'=>true]);
  $model->update([(int)$update->update_id]);$result['nativeUpdateResult']=$model->getState('result');
  $result['installedVersion']=file_get_contents($c['root'].'/libraries/entitlefixture/src/version.txt');
  $params=json_encode(['api_base'=>$c['apiBase'],'product'=>$c['product']]);
  $db->setQuery('UPDATE #__extensions SET params='.$db->quote($params).' WHERE type='.$db->quote('plugin').' AND folder='.$db->quote('installer').' AND element='.$db->quote('entitle'))->execute();
}
}catch(Throwable $e){$result['error']=get_class($e).': '.$e->getMessage();}
echo 'QUALIFICATION_RESULT:'.json_encode($result,JSON_THROW_ON_ERROR).PHP_EOL;
`;
}
