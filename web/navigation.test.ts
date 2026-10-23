import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  applicationBasePath,
  applicationRoute,
  applicationHref,
  applicationAsset,
} from "./navigation.ts";
const previousDocument = Object.getOwnPropertyDescriptor(
  globalThis,
  "document",
);
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const values = new Map<string, string>();
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    querySelector: (selector: string) => {
      const name = /name="([^"]+)"/.exec(selector)?.[1];
      const content = values.get(name ?? "");
      return content === undefined ? null : { content };
    },
  },
});
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { location: { origin: "https://example.test", pathname: "/" } },
});
after(() => {
  if (previousDocument)
    Object.defineProperty(globalThis, "document", previousDocument);
  else delete (globalThis as Record<string, unknown>).document;
  if (previousWindow)
    Object.defineProperty(globalThis, "window", previousWindow);
  else delete (globalThis as Record<string, unknown>).window;
});
test("standalone navigation defaults to local root and hosted navigation preserves the app mount", () => {
  values.clear();
  assert.equal(applicationBasePath(), "");
  assert.equal(applicationRoute(), "/");
  assert.equal(applicationHref("/seller"), "/seller");
  values.set("entitle-app-base", "/app");
  assert.equal(applicationRoute("/app/t/alpha"), "/t/alpha");
  assert.equal(applicationRoute("/app"), "/");
  assert.equal(applicationRoute("/application"), "/application");
  assert.equal(
    applicationHref("/seller?tenant=alpha#seller-login=secret"),
    "/app/seller?tenant=alpha#seller-login=secret",
  );
  assert.equal(applicationAsset("/favicon.svg"), "/app/favicon.svg");
});
test("marketing destinations can move from a path to a separate application origin", () => {
  values.clear();
  values.set("entitle-app-url", "/app/");
  assert.equal(applicationHref("/seller"), "/app/seller");
  values.set("entitle-app-url", "https://dashboard.example.test/console/");
  assert.equal(
    applicationHref("/t/alpha"),
    "https://dashboard.example.test/console/t/alpha",
  );
  for (const invalid of [
    "javascript:alert(1)",
    "//other.example.test/app",
    "relative/path",
    "/app/../other",
    "https://example.test/app/../other",
    "https://example.test\\other/app",
    " https://example.test/app",
    "https://user:secret@example.test/",
    "https://example.test/app?secret=1",
    "https://example.test/app#secret",
  ]) {
    values.set("entitle-app-url", invalid);
    assert.throws(() => applicationHref("/seller"));
  }
});
