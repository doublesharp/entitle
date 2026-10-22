import assert from "node:assert/strict";
import { test } from "node:test";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { renderUpdate, type UpdateInput } from "../src/update-adapters.ts";

function input(
  framework: UpdateInput["framework"],
  config: Record<string, unknown> = {},
): UpdateInput {
  return {
    framework,
    product: {
      slug: "example",
      name: `Example & <"'>`,
      frameworkConfig: config,
    },
    release: {
      version: "2.0.0",
      changelog: `Safe <script> & "notes"\nnext`,
      published_at: Date.UTC(2026, 9, 21),
    },
    assets: [
      {
        id: "asset-1",
        target: "any",
        filename: "example.zip",
        size: 123,
        checksum: "a".repeat(64),
        sha512: Buffer.alloc(64, 2).toString("base64"),
        signature: "native-signature",
        min_system_version: "13.0.0",
        url: "https://updates.example/api/v1/tenants/vendor/packages/example/assets/asset-1/example.zip",
      },
    ],
  };
}
function xml(i: UpdateInput): string {
  const rendered = renderUpdate(i);
  assert.match(rendered.contentType, /xml/);
  assert.equal(typeof rendered.body, "string");
  return rendered.body as string;
}

test("Joomla native update XML preserves extension identity, requirements and safe text", () => {
  const body = xml(
    input("joomla", {
      extensionType: "plugin",
      element: "example",
      folder: "system",
      client: "administrator",
      joomlaMajor: 5,
    }),
  );
  for (const expected of [
    "<updates>",
    "<element>example</element>",
    "<type>plugin</type>",
    "<folder>system</folder>",
    "<client>administrator</client>",
    'name="joomla" version="5\\..*"',
    'type="full" format="zip"',
    "<version>2.0.0</version>",
    "&amp; &lt;&quot;&apos;&gt;",
    "<sha256>" + "a".repeat(64),
  ])
    assert.ok(body.includes(expected), expected);
  assert.ok(!body.includes("<script>"));
  const component = xml(
    input("joomla", {
      extensionType: "component",
      element: "com_example",
      joomlaMajor: 6,
    }),
  );
  assert.ok(!component.includes("<folder>"));
  assert.ok(!component.includes("<client>"));
});

test("Electron generic YAML has native SHA512 metadata and cannot inject YAML fields", () => {
  const i = input("electron");
  i.release.changelog = "notes\nurl: https://attacker.invalid/\n---\n";
  const rendered = renderUpdate(i);
  assert.match(rendered.contentType, /yaml/);
  const body = rendered.body as string;
  assert.match(body, /version: "2.0.0"/);
  assert.match(body, /files:\n {2}- url:/);
  assert.ok(body.includes(`sha512: "${i.assets[0]!.sha512}"`));
  assert.ok(body.includes("size: 123"));
  assert.ok(body.includes(`path: "${i.assets[0]!.url}"`));
  assert.ok(body.includes('releaseDate: "2026-10-21T00:00:00.000Z"'));
  assert.ok(!body.includes("\nurl: https://attacker"));
});

test("Tauri dynamic feed returns the signature contents and RFC3339 date", () => {
  const i = input("tauri");
  assert.deepEqual(renderUpdate(i), {
    contentType: "application/json; charset=utf-8",
    body: {
      version: "2.0.0",
      notes: i.release.changelog,
      pub_date: "2026-10-21T00:00:00.000Z",
      url: i.assets[0]!.url,
      signature: "native-signature",
    },
  });
});

test("Sparkle appcast uses EdDSA enclosure, version, byte size and optional OS floor", () => {
  const i = input("sparkle");
  const body = xml(i);
  for (const expected of [
    'xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"',
    "<sparkle:version>2.0.0</sparkle:version>",
    'sparkle:edSignature="native-signature"',
    'length="123"',
    "<sparkle:minimumSystemVersion>13.0.0</sparkle:minimumSystemVersion>",
    "<pubDate>Wed, 21 Oct 2026 00:00:00 GMT</pubDate>",
  ])
    assert.ok(body.includes(expected), expected);
  assert.ok(!body.includes("<script>"));
  const without = input("sparkle");
  without.assets = [{ ...without.assets[0]!, min_system_version: null }];
  assert.ok(!xml(without).includes("minimumSystemVersion"));
});

test("JetBrains repository has exact plugin and IDE build identity with XML escaping", () => {
  const body = xml(
    input("jetbrains", {
      pluginId: 'org.example."&',
      sinceBuild: "241",
      untilBuild: "251.*",
    }),
  );
  for (const expected of [
    "<plugins>",
    'id="org.example.&quot;&amp;"',
    'version="2.0.0"',
    '<idea-version since-build="241" until-build="251.*"/>',
  ])
    assert.ok(body.includes(expected), expected);
  assert.ok(
    !xml(
      input("jetbrains", { pluginId: "org.example", sinceBuild: "241" }),
    ).includes("until-build"),
  );
});

test("Generic feed exposes immutable asset metadata without internal IDs or keys", () => {
  const i = input("generic");
  assert.deepEqual(renderUpdate(i).body, {
    version: "2.0.0",
    notes: i.release.changelog,
    publishedAt: "2026-10-21T00:00:00.000Z",
    assets: [
      {
        target: "any",
        filename: "example.zip",
        size: 123,
        sha256: "a".repeat(64),
        sha512: i.assets[0]!.sha512,
        signature: "native-signature",
        minSystemVersion: "13.0.0",
        url: i.assets[0]!.url,
      },
    ],
  });
});

test("Renderer rejects empty assets, unknown frameworks, WordPress and missing native signatures", () => {
  const empty = input("generic");
  empty.assets = [];
  assert.throws(() => renderUpdate(empty), /asset/i);
  assert.throws(() => renderUpdate(input("wordpress")), /framework/i);
  assert.throws(
    () =>
      renderUpdate({
        ...input("generic"),
        framework: "other" as UpdateInput["framework"],
      }),
    /framework/i,
  );
  for (const framework of ["tauri", "sparkle"] as const) {
    const i = input(framework);
    i.assets = [{ ...i.assets[0]!, signature: null }];
    assert.throws(() => renderUpdate(i), /signature/i);
  }
});

test("Joomla plugin feed defaults client to site when configuration omits it", () => {
  const body = xml(
    input("joomla", {
      extensionType: "plugin",
      element: "example",
      folder: "system",
      joomlaMajor: 5,
    }),
  );
  assert.ok(body.includes("<client>site</client>"));
});

test("Native XML feeds parse as documents and roundtrip malicious text safely", () => {
  for (const [framework, config] of [
    [
      "joomla",
      {
        extensionType: "plugin",
        element: "example",
        folder: "system",
        joomlaMajor: 5,
      },
    ],
    ["sparkle", {}],
    ["jetbrains", { pluginId: "org.example", sinceBuild: "241" }],
  ] as const) {
    const body = xml(input(framework, config));
    assert.equal(XMLValidator.validate(body), true);
    const document = new XMLParser({ ignoreAttributes: false }).parse(body);
    assert.equal(typeof document, "object");
  }
});

test("Electron YAML escapes non-printable Unicode rejected by native YAML parsers", () => {
  const i = input("electron");
  i.release.changelog = "notes\u007f\u0085\u009f\ufffe\uffff";
  const body = renderUpdate(i).body as string;
  assert.ok(!/[\u007f-\u009f\ufffe\uffff]/.test(body));
  assert.ok(body.includes("\\u009f"));
  const notes = body.split("releaseNotes: ")[1]!.trim();
  assert.equal(JSON.parse(notes), i.release.changelog);
});

test("Joomla collection discovery points to immutable public details with matching native identity", () => {
  for (const config of [
    {
      extensionType: "plugin",
      element: "example",
      folder: "system",
      joomlaMajor: 6,
    },
    { extensionType: "component", element: "com_example", joomlaMajor: 6 },
    {
      extensionType: "package",
      element: "pkg_example",
      joomlaMajor: 6,
      client: "site",
    },
    {
      extensionType: "library",
      element: "example",
      joomlaMajor: 6,
      client: "site",
    },
  ]) {
    const i = input("joomla", config);
    i.detailsUrl = "https://updates.example/details.xml";
    const body = xml(i);
    assert.equal(XMLValidator.validate(body), true);
    const document = new XMLParser({ ignoreAttributes: false }).parse(body);
    const extension = document.extensionset.extension;
    assert.equal(extension["@_detailsurl"], i.detailsUrl);
    assert.equal(extension["@_element"], config.element);
    assert.equal(extension["@_type"], config.extensionType);
    assert.equal(
      extension["@_client"],
      config.client ??
        (config.extensionType === "plugin" ? "site" : "administrator"),
    );
    assert.ok(!body.includes(i.assets[0]!.url));
    assert.equal(extension["@_targetplatformversion"], "6\\..*");
  }
});
