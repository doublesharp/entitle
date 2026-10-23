import { h } from "vue";
import { site } from "../packages/shared/site.ts";
import { applicationAsset, applicationHref } from "./navigation.ts";

export const appHeader = (docs = false) =>
  h("header", { class: "site-header" }, [
    h("a", { class: "brand", href: applicationHref("/") }, [
      h("img", {
        class: "brand-mark",
        src: applicationAsset("/favicon.svg"),
        alt: "",
        width: 36,
        height: 36,
        "aria-hidden": "true",
      }),
      site.name,
    ]),
    h("nav", { "aria-label": "Main navigation" }, [
      h("a", { href: applicationHref("/seller") }, "Dashboard"),
      h(
        "a",
        {
          href: applicationHref("/docs"),
          "aria-current": docs ? "page" : undefined,
        },
        "Docs",
      ),
      h("a", { href: applicationHref("/docs#troubleshooting") }, "Help"),
    ]),
  ]);
