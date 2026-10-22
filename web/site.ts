import {
  createApp,
  defineComponent,
  h,
  onMounted,
  onUnmounted,
  ref,
} from "vue";
import { ApiClient, ApiError, errorMessage } from "./api.ts";
import {
  frameworkInfo,
  frameworkOf,
  seatUnit,
  setupConfiguration,
} from "./frameworks.ts";
import type { Framework, FrameworkProduct, ReleaseAsset } from "./api.ts";
import type { Tenant } from "../src/db.ts";
import { site } from "../src/site.ts";
import { SellerFeaturePanel, verifiedRequest } from "./features.ts";
import { publicDocs } from "./docs.ts";

interface Info {
  deploymentMode: "standalone" | "hosted";
  applicationFeePercent: number;
  maxUploadBytes: number;
  maxNativeUploadBytes?: number;
  databaseEngines: string[];
}
interface Seller {
  user: { id: string; email: string };
  csrfToken: string;
  tenants: Tenant[];
}
interface SellerProduct extends FrameworkProduct {
  id: string;
  slug: string;
  name: string;
  plugin_basename: string;
  tax_code?: string | null;
  plans: {
    id: string;
    name: string;
    site_allowance: number;
    stripe_price_id: string;
  }[];
}
interface Overview {
  tenant: Tenant;
  sandbox?: {
    isSandbox: boolean;
    parentSlug: string;
    sandboxSlug: string;
    mode: "fixture" | "stripe";
  } | null;
  products: SellerProduct[];
  licenses: {
    id: string;
    product_name: string;
    customer_email: string;
    plan_name: string;
    site_allowance: number;
    paid_through: number | null;
    billing_status: string;
    revoked: boolean;
    suspended: boolean;
  }[];
  releases: {
    id: string;
    product_id: string;
    version: string;
    withdrawn: boolean;
    assets?: ReleaseAsset[];
  }[];
  metrics: {
    licenses: Record<string, number>;
    installations: Record<string, number>;
    seats: Record<string, number>;
    releases: Record<string, number>;
    storage: Record<string, number>;
    downloads: Record<string, number>;
    payments: {
      currency: string;
      paidMinor: string;
      refundedMinor: string;
      netMinor: string;
    }[];
  };
}
interface Price {
  id: string;
  productName: string;
  nickname: string | null;
  unit_amount: number | null;
  currency: string;
  interval: string;
}
interface Key {
  display_prefix: string;
  scopes: string;
  expires_at: number | null;
  last_used_at: number | null;
  id: string;
  name: string;
  created_at: number;
  revoked_at: number | null;
}

const sellerPages = [
  { id: "overview", label: "Overview" },
  { id: "products", label: "Products" },
  { id: "releases", label: "Releases" },
  { id: "licenses", label: "Licenses" },
  { id: "setup", label: "Client setup" },
  { id: "keys", label: "API keys" },
  { id: "billing", label: "Billing" },
  { id: "commerce", label: "Tax settings" },
  { id: "sandbox", label: "Sandbox" },
  { id: "operations", label: "Operations" },
  { id: "webhooks", label: "Webhooks" },
  { id: "security", label: "Account security" },
  { id: "export", label: "Export" },
] as const;
const sellerPageGroups = [
  {
    label: "Store",
    pages: ["products", "releases", "licenses", "billing", "commerce"],
  },
  { label: "Integrations", pages: ["setup", "keys", "webhooks", "sandbox"] },
  { label: "Workspace", pages: ["operations", "security", "export"] },
];
type SellerPage = (typeof sellerPages)[number]["id"];

const hasPlatformSubscription = (tenant: Tenant | undefined) =>
  !!tenant?.platform_subscription_id &&
  !["canceled", "incomplete_expired"].includes(tenant.billing_status);
const stripeStatusLabel = (status: string) =>
  (
    ({
      connected: "Connected",
      restricted: "Action needed",
      unconnected: "Not connected",
      disconnected: "Disconnected",
      platform: "Platform account",
    }) as Record<string, string>
  )[status] || status.replaceAll("_", " ");
const billingStatusLabel = (status: string) =>
  (
    ({
      active: "Active",
      trial: "Trial",
      trialing: "Trial",
      past_due: "Payment overdue",
      unpaid: "Payment required",
      canceled: "Canceled",
      incomplete: "Payment pending",
      incomplete_expired: "Payment expired",
      paused: "Paused",
    }) as Record<string, string>
  )[status] || status.replaceAll("_", " ");
const readableBytes = (bytes: number) => {
  const [size, unit] =
    bytes >= 1073741824
      ? ([1073741824, "GiB"] as const)
      : bytes >= 1048576
        ? ([1048576, "MiB"] as const)
        : bytes >= 1024
          ? ([1024, "KiB"] as const)
          : ([1, "B"] as const);
  return `${(bytes / size).toLocaleString("en-US", { maximumFractionDigits: 1 })} ${unit}`;
};
const btn = (label: string, action: () => void, disabled = false) =>
  h("button", { type: "button", onClick: action, disabled }, label);
const header = (docs = false) =>
  h("header", { class: "site-header" }, [
    h("a", { class: "brand", href: "/" }, [
      h("img", {
        class: "brand-mark",
        src: "/favicon.svg",
        alt: "",
        width: 36,
        height: 36,
        "aria-hidden": "true",
      }),
      site.name,
    ]),
    h("nav", { "aria-label": "Main navigation" }, [
      h("a", { href: "/#features" }, "Features"),
      h("a", { href: "/#hosting" }, "Hosting"),
      h(
        "a",
        { href: "/docs", "aria-current": docs ? "page" : undefined },
        "Docs",
      ),
      h("a", { href: "/docs#troubleshooting" }, "Help"),
      h("a", { href: "/seller" }, "Seller dashboard"),
    ]),
  ]);
const section = (title: string, children: unknown[]) =>
  h("section", { class: "panel seller-panel" }, [
    h("h2", title),
    ...children,
  ] as Parameters<typeof h>[2]);
const money = (currency: string, minor: string) => {
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
  });
  const digits = formatter.resolvedOptions().maximumFractionDigits!;
  const value = BigInt(minor),
    scale = 10n ** BigInt(digits),
    negative = value < 0n,
    absolute = negative ? -value : value;
  const whole = absolute / scale,
    fraction = (absolute % scale).toString().padStart(digits, "0");
  return (
    (negative ? "-" : "") +
    formatter
      .formatToParts(whole)
      .map((part) => (part.type === "fraction" ? fraction : part.value))
      .join("")
  );
};

const SellerConfirmation = defineComponent({
  props: {
    title: { type: String, required: true },
    label: { type: String, required: true },
  },
  emits: ["confirm", "cancel"],
  setup(props, { emit }) {
    const dialog = ref<HTMLDialogElement>();
    onMounted(() => dialog.value!.showModal());
    return () =>
      h(
        "dialog",
        {
          ref: dialog,
          class: "confirm-dialog",
          "aria-labelledby": "seller-confirm-title",
          onCancel: (event: Event) => {
            event.preventDefault();
            emit("cancel");
          },
        },
        [
          h("h2", { id: "seller-confirm-title" }, props.title),
          h("p", "This changes access immediately. Confirm to continue."),
          h("div", { class: "button-row" }, [
            h(
              "button",
              {
                type: "button",
                autofocus: true,
                class: "button-secondary",
                onClick: () => emit("cancel"),
              },
              "Cancel",
            ),
            btn(props.label, () => emit("confirm")),
          ]),
        ],
      );
  },
});

// Public illustrations are native SVG/HTML, never fetched customer records.
const publicIcon = (path: string) =>
  h(
    "svg",
    {
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": 1.6,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
      focusable: "false",
    },
    [h("path", { d: path })],
  );
const icons = {
  key: "M14 5a5 5 0 1 1-2 8L5 20H2v-3l7-7a5 5 0 0 1 5-5Z M16 7h.01",
  box: "m3 7 9-5 9 5v10l-9 5-9-5Z m0 0 9 5 9-5 M12 12v10 M7.5 4.5l9 5",
  card: "M3 4h18v16H3Z M3 9h18 M7 15h4",
  chart: "M4 3v17h17 M8 15v-4 M13 15V7 M18 15V4",
  layers: "m2 7 10-5 10 5-10 5Z M2 12l10 5 10-5 M2 17l10 5 10-5",
  code: "m8 5-6 7 6 7 m8-14 6 7-6 7 M14 3l-4 18",
  arrow: "M4 12h16 m-6-6 6 6-6 6",
  check: "m5 12 4 4 10-10",
};
const publicHome = () => [
  h("section", { class: "saas-hero", "aria-labelledby": "home-title" }, [
    h("div", { class: "hero-copy" }, [
      h("p", { class: "eyebrow" }, "Software licensing and updates"),
      h("h1", { id: "home-title" }, [
        "Your software. ",
        h("span", "Ready to sell."),
      ]),
      h(
        "p",
        { class: "intro" },
        "Turn your plugin or app into a software business. Connect payments, license access and private updates in one place, so you can get back to building.",
      ),
      h("div", { class: "button-row hero-actions" }, [
        h("a", { href: "/seller", class: "button" }, "Create your workspace"),
        h("a", { href: "#how-it-works", class: "home-secondary" }, [
          "See how it works",
          publicIcon(icons.arrow),
        ]),
      ]),
      h(
        "p",
        { class: "hero-note" },
        "Your Stripe account. Your customers. Your next release.",
      ),
    ]),
    h(
      "figure",
      { class: "release-illustration", "aria-labelledby": "workflow-caption" },
      [
        h("div", { class: "illustration-top" }, [
          h(
            "span",
            { class: "illustration-dots", "aria-hidden": "true" },
            "● ● ●",
          ),
          h("span", "From purchase to update"),
        ]),
        h("div", { class: "workflow-stack" }, [
          h("div", { class: "workflow-node" }, [
            h("span", { class: "workflow-icon" }, publicIcon(icons.card)),
            h("div", [
              h("span", { class: "workflow-overline" }, "01 / PAYMENT"),
              h("strong", "A customer checks out"),
              h("span", "Your product. Your Stripe account."),
            ]),
            h(
              "span",
              { class: "workflow-check", "aria-hidden": "true" },
              publicIcon(icons.check),
            ),
          ]),
          h("div", { class: "workflow-connector", "aria-hidden": "true" }, "↓"),
          h("div", { class: "workflow-node workflow-license" }, [
            h("span", { class: "workflow-icon" }, publicIcon(icons.key)),
            h("div", [
              h("span", { class: "workflow-overline" }, "02 / LICENSE"),
              h("strong", "Paid access, delivered"),
              h("span", "License key + site or device seats"),
            ]),
            h(
              "span",
              { class: "workflow-check", "aria-hidden": "true" },
              publicIcon(icons.check),
            ),
          ]),
          h("div", { class: "workflow-connector", "aria-hidden": "true" }, "↓"),
          h("div", { class: "workflow-node" }, [
            h("span", { class: "workflow-icon" }, publicIcon(icons.box)),
            h("div", [
              h("span", { class: "workflow-overline" }, "03 / UPDATE"),
              h("strong", "Your next release arrives"),
              h("span", "Private package. Entitlement checked."),
            ]),
            h(
              "span",
              { class: "workflow-check", "aria-hidden": "true" },
              publicIcon(icons.check),
            ),
          ]),
        ]),
        h(
          "figcaption",
          { id: "workflow-caption" },
          `Illustrative workflow · powered by ${site.name}`,
        ),
      ],
    ),
  ]),
  h(
    "section",
    { class: "framework-strip", "aria-label": "Supported framework adapters" },
    [
      h("p", "For the software you ship"),
      h(
        "ul",
        [
          "WordPress",
          "Joomla",
          "Electron",
          "Tauri",
          "Sparkle",
          "JetBrains",
          "Generic",
        ].map((name) =>
          h("li", [
            h(
              "span",
              { class: "framework-glyph", "aria-hidden": "true" },
              name.slice(0, 1),
            ),
            name,
          ]),
        ),
      ),
      h(
        "a",
        { href: "/docs#framework-support", class: "small" },
        "Explore adapters and runtime requirements →",
      ),
    ],
  ),
  h(
    "section",
    {
      id: "how-it-works",
      class: "home-section",
      "aria-labelledby": "journey-title",
    },
    [
      h("div", { class: "home-section-heading" }, [
        h("p", { class: "eyebrow" }, "Less admin. More building."),
        h("h2", { id: "journey-title" }, "One connected customer journey."),
        h(
          "p",
          "From the first purchase to the next release, give your customers a clear path forward.",
        ),
      ]),
      h(
        "ol",
        { class: "journey-grid" },
        [
          [
            "01",
            "Sell on your terms",
            "Use Stripe Checkout or style your own form with Stripe Elements. Payments go to your connected Stripe account.",
          ],
          [
            "02",
            "Make access automatic",
            "Confirmed payments create licenses. Renewals and paid plan changes keep entitlement and seat allowances in step.",
          ],
          [
            "03",
            "Keep good software moving",
            "Publish private releases. Customers get eligible updates and manage their keys, downloads and installations.",
          ],
        ].map(([number, title, copy]) =>
          h("li", [
            h(
              "span",
              { class: "journey-number", "aria-hidden": "true" },
              number,
            ),
            h("h3", title),
            h("p", copy),
          ]),
        ),
      ),
    ],
  ),
  h(
    "section",
    {
      id: "features",
      class: "home-section",
      "aria-labelledby": "features-title",
    },
    [
      h("div", { class: "home-section-heading" }, [
        h("p", { class: "eyebrow" }, "The tools behind your business"),
        h(
          "h2",
          { id: "features-title" },
          "A lot to manage. One place to do it.",
        ),
        h(
          "p",
          "Keep the connection between payments, people and software without stitching together a storefront and a licensing server.",
        ),
      ]),
      h(
        "div",
        { class: "home-feature-grid" },
        [
          [
            icons.key,
            "Licenses that follow payment",
            "Annual entitlements, site or device allowances, renewals, refunds and disputes. Installed software stays available after a license expires.",
          ],
          [
            icons.box,
            "Private releases, ready to ship",
            "Immutable packages, checksums and framework metadata. Each download checks current entitlement before the bytes leave private storage.",
          ],
          [
            icons.card,
            "Your customers, your Stripe",
            "Use your own Stripe account for buyer checkout and billing. Your platform subscription is billed separately.",
          ],
          [
            icons.chart,
            "See what is happening",
            "See paid licenses, seats, storage and served downloads. Track payments by currency, spot failed work and review daily bandwidth with Hosted Pro.",
          ],
          [
            icons.layers,
            "Room for your next product",
            "Manage different plugins, apps, plans and purchase flows. Isolated workspaces keep each seller's customers and releases separate.",
          ],
          [
            icons.code,
            "A dashboard when you need it. An API when you don’t.",
            "Publish through the dashboard or a scoped CI key. Test purchases in an isolated sandbox and connect Hosted Pro signed events to your own tools.",
          ],
        ].map(([icon, title, copy]) =>
          h("article", { class: "home-feature" }, [
            h("span", { class: "feature-icon" }, publicIcon(icon!)),
            h("h3", title),
            h("p", copy),
          ]),
        ),
      ),
    ],
  ),
  h(
    "section",
    { class: "wordpress-feature", "aria-labelledby": "wordpress-title" },
    [
      h("div", [
        h("p", { class: "eyebrow" }, "Built to feel at home"),
        h("h2", { id: "wordpress-title" }, "First-class WordPress support"),
        h(
          "p",
          "Sell your Pro plugin with the update experience your customers already know. Site activations, compatibility checks and authenticated packages work with the normal WordPress update screen. Your free plugin can stay on WordPress.org.",
        ),
        h("a", { href: "/docs#framework-support" }, [
          "Explore WordPress support",
          publicIcon(icons.arrow),
        ]),
      ]),
      h("div", { class: "wordpress-art", "aria-hidden": "true" }, [
        h("div", { class: "wordpress-orbit" }, [h("span", "W")]),
        h("div", { class: "wordpress-update" }, [
          publicIcon(icons.box),
          h("div", [
            h("strong", "A new release is available"),
            h("span", "Same familiar update experience."),
          ]),
        ]),
      ]),
    ],
  ),
  h(
    "section",
    {
      class: "home-section home-confidence",
      "aria-labelledby": "confidence-title",
    },
    [
      h("div", [
        h("p", { class: "eyebrow" }, "Built around trust"),
        h(
          "h2",
          { id: "confidence-title" },
          "Protect access. Respect your customers.",
        ),
        h(
          "p",
          "Expired subscriptions stop access to new downloads and updates. They never remotely disable installed functionality. Server outages should not get in the way of using software your customers already installed.",
        ),
      ]),
      h("div", { class: "confidence-details" }, [
        h("p", [
          publicIcon(icons.check),
          "Scoped, revocable activation tokens",
        ]),
        h("p", [publicIcon(icons.check), "Private packages with checksums"]),
        h("p", [
          publicIcon(icons.check),
          "Customer-controlled keys and installations",
        ]),
        h(
          "a",
          { href: "/docs#server-limits" },
          "Read the operational details →",
        ),
      ]),
    ],
  ),
  h(
    "section",
    {
      id: "hosting",
      class: "home-section",
      "aria-labelledby": "hosting-title",
    },
    [
      h("div", { class: "home-section-heading" }, [
        h("p", { class: "eyebrow" }, "Choose who runs it"),
        h("h2", { id: "hosting-title" }, "Your business. Your way to run it."),
        h(
          "p",
          "Use the same licensing engine and framework adapters with hosted publishing or your own standalone installation.",
        ),
      ]),
      h("div", { class: "hosting-grid" }, [
        h("article", { class: "hosting-option" }, [
          h("p", { class: "eyebrow" }, "Focus on your products"),
          h("h3", "Hosted service"),
          h(
            "p",
            "Create a publisher workspace and connect your own Stripe account. The service operator runs the app, private storage and backups.",
          ),
          h("ul", [
            h(
              "li",
              "Starter includes licensing, private updates, buyer accounts, recovery and sandbox testing.",
            ),
            h(
              "li",
              "Hosted Pro adds signed webhooks and advanced daily bandwidth reports.",
            ),
          ]),
          h(
            "p",
            { class: "hosting-cost" },
            "Platform subscription and configured application fee, plus separate Stripe fees. Subscription amounts are shown at checkout; the dashboard shows the fee rate.",
          ),
          h("a", { href: "/seller", class: "button" }, "Open seller dashboard"),
          h(
            "a",
            { href: "/docs#hosted-tiers" },
            "Compare hosted capabilities →",
          ),
        ]),
        h("article", { class: "hosting-option" }, [
          h("p", { class: "eyebrow" }, "Run your own infrastructure"),
          h("h3", "Self-hosted standalone"),
          h(
            "p",
            "Run Entitle for your own software business. Manage multiple products with your own Stripe account, database and private S3-compatible storage.",
          ),
          h("ul", [
            h(
              "li",
              "All local capabilities, including signed events and advanced reports.",
            ),
            h("li", "One app serves the API and dashboard. Redis is optional."),
          ]),
          h(
            "p",
            { class: "hosting-cost" },
            "No platform subscription or application fee. You supply hosting, storage, email and backups, and pay your provider and Stripe costs.",
          ),
          h(
            "a",
            { href: "/docs#self-hosting", class: "button-secondary" },
            "Read the deployment guide",
          ),
          h(
            "a",
            { href: "/docs#licensing" },
            "View source and publisher license →",
          ),
        ]),
      ]),
    ],
  ),
  h(
    "section",
    {
      id: "questions",
      class: "home-section home-questions",
      "aria-labelledby": "questions-title",
    },
    [
      h("div", { class: "home-section-heading" }, [
        h("p", { class: "eyebrow" }, "Before your first release"),
        h(
          "h2",
          { id: "questions-title" },
          "A few things you might be wondering.",
        ),
      ]),
      ...[
        [
          "Can I keep my own website and checkout design?",
          "Yes. Your storefront can start Stripe Checkout or use Stripe Elements for a styled payment form. Entitle controls prices and paid access on the server.",
          "/docs#checkout",
          "Explore checkout integration",
        ],
        [
          "What happens when a customer stops renewing?",
          "They keep access to downloads through their paid period. Installed software keeps working after expiry and during licensing-server outages.",
          "/docs#billing",
          "Understand billing and access",
        ],
        [
          "Can I use this beyond WordPress?",
          "Yes. Choose adapters for Joomla, Electron, Tauri, Sparkle and JetBrains, or integrate a generic client through the API. WordPress has its own site activation and update flow.",
          "/docs#framework-support",
          "Find your framework",
        ],
        [
          "How do customers recover a key or move a site?",
          "Their workspace customer page provides email sign-in, license replacement, installation deactivation, downloads and billing management. Publishers can check access and payment state without asking for secret keys.",
          "/docs#customer-accounts",
          "Read the buyer support guide",
        ],
      ].map(([question, answer, href, label]) =>
        h("details", { class: "home-question" }, [
          h("summary", question),
          h("p", answer),
          h("a", { href }, label),
        ]),
      ),
    ],
  ),
  h("section", { class: "home-cta", "aria-labelledby": "start-title" }, [
    h("div", [
      h("p", { class: "eyebrow" }, "Your next release starts here"),
      h("h2", { id: "start-title" }, "Build the software. Grow the business."),
      h(
        "p",
        "Bring your product and your Stripe account. Give your customers a better way to buy, activate and stay up to date.",
      ),
    ]),
    h("div", { class: "home-cta-actions" }, [
      h("a", { href: "/seller", class: "button" }, "Create your workspace"),
      h("a", { href: "/docs#getting-started" }, "Read the setup guide →"),
      h("a", { href: "/docs#licensing" }, "Public source and license terms →"),
    ]),
  ]),
];

export function mountPublicSite(
  target: string | Element = "#app",
  transport?: typeof fetch,
) {
  const api = new ApiClient(transport, "/api/v1/platform");
  const docs = /^\/docs\/?$/.test(window.location.pathname);
  const app = createApp(
    defineComponent({
      setup() {
        const info = ref<Info | null>(null),
          error = ref("");
        const load = async () => {
          error.value = "";
          try {
            info.value = await api.get<Info>("/info");
          } catch (failure) {
            error.value = errorMessage(failure);
          }
        };
        onMounted(() => {
          if (docs) void load();
        });
        return () =>
          h("div", { class: docs ? "app docs-page" : "app home-page" }, [
            h("a", { href: "#main", class: "skip-link" }, "Skip to content"),
            header(docs),
            h(
              "main",
              { id: "main", class: "page-main" },
              docs
                ? publicDocs(info.value, error.value, () => void load())
                : publicHome(),
            ),
            h("footer", { class: "site-footer" }, [
              h("span", site.name),
              h("a", { href: "/docs" }, "Documentation"),
              h("a", { href: "/docs#troubleshooting" }, "Support guide"),
              h("a", { href: "/docs#licensing" }, "Source & licenses"),
              h(
                "a",
                { href: site.hostedOrigin },
                new URL(site.hostedOrigin).host,
              ),
            ]),
          ]);
      },
    }),
  );
  app.mount(target);
  return app;
}

export function mountSellerApp(
  target: string | Element = "#app",
  transport?: typeof fetch,
) {
  const platform = new ApiClient(transport, "/api/v1/platform");
  const app = createApp(
    defineComponent({
      setup() {
        const activePage = ref<SellerPage>("overview"),
          recoveryOpen = ref(false),
          accountProof = ref(""),
          proofRound = ref(0),
          panelProof = ref<{ page: SellerPage; token: string } | null>(null),
          proofPurpose = ref("api_keys");
        const hosted = ref(true),
          applicationFeePercent = ref(0);
        const seller = ref<Seller | null>(null),
          selected = ref(""),
          overview = ref<Overview | null>(null),
          prices = ref<Price[]>([]),
          keys = ref<Key[]>([]),
          recovery = ref(false),
          localMode = ref(false),
          keyScopes = ref(["read", "releases:write"]);
        const loading = ref(true),
          busy = ref(false),
          error = ref(""),
          notice = ref(""),
          token = ref<string | null>(null),
          secret = ref("");
        const maxUpload = ref(26214400),
          file = ref<File | null>(null),
          confirmation = ref<{
            title: string;
            label: string;
            run: () => Promise<void>;
          } | null>(null);
        const fields = ref<Record<string, string>>({
          "seller-email": "",
          "tenant-name": "",
          "tenant-slug": "",
          "product-name": "",
          "product-slug": "",
          "plugin-basename": "",
          "product-framework": "wordpress",
          "joomla-extension-type": "plugin",
          "joomla-element": "",
          "joomla-folder": "",
          "joomla-client": "site",
          "joomla-major": "5",
          "jetbrains-plugin-id": "",
          "jetbrains-since-build": "",
          "jetbrains-until-build": "",
          "activation-kind": "device",
          "release-target": "",
          "release-signature": "",
          "release-min-system-version": "",
          "plan-name": "Annual",
          "site-allowance": "1",
          "price-id": "",
          "release-product": "",
          "release-version": "",
          "release-changelog": "",
          "release-min-wp": "",
          "release-min-php": "",
          "release-min-free": "",
          "release-tested": "",
          "key-verification-token": "",
          "release-verification-token": "",
          "key-name": "",
          "key-expiry": "90",
          "config-product": "",
        });
        const tenantApi = () => {
          const api = new ApiClient(
            transport,
            `/api/v1/tenants/${encodeURIComponent(selected.value)}/seller`,
          );
          api.csrfToken = platform.csrfToken;
          return api;
        };
        const clearSession = () => {
          activePage.value = "overview";
          seller.value = null;
          platform.csrfToken = "";
          accountProof.value = "";
          panelProof.value = null;
          recoveryOpen.value = false;
          overview.value = null;
          recovery.value = false;
          file.value = null;
          keys.value = [];
          prices.value = [];
          secret.value = "";
          fields.value["key-verification-token"] = "";
          fields.value["release-verification-token"] = "";
          selected.value = "";
        };
        const run = async (action: () => Promise<void>, expire = true) => {
          if (busy.value) return;
          busy.value = true;
          error.value = "";
          notice.value = "";
          try {
            await action();
          } catch (failure) {
            error.value = errorMessage(failure);
            if (expire && failure instanceof ApiError && failure.status === 401)
              clearSession();
          } finally {
            busy.value = false;
          }
        };
        const dashboard = async () => {
          panelProof.value = null;
          overview.value = null;
          recovery.value = false;
          file.value = null;
          keys.value = [];
          prices.value = [];
          secret.value = "";
          fields.value["key-verification-token"] = "";
          fields.value["release-verification-token"] = "";
          if (!seller.value || !selected.value) return;
          const api = tenantApi();
          try {
            const [data, priceData, keyData] = await Promise.all([
              api.get<Overview>("/overview"),
              api.get<{ prices: Price[]; localMode: boolean }>("/prices"),
              api.get<{ keys: Key[] }>("/keys"),
            ]);
            overview.value = data;
            prices.value = priceData.prices;
            localMode.value = priceData.localMode;
            keys.value = keyData.keys;
            fields.value["price-id"] = priceData.prices[0]?.id || "";
            fields.value["release-product"] = data.products[0]?.id || "";
            fields.value["release-target"] =
              frameworkInfo[frameworkOf(data.products[0])].targets[0] || "";
            fields.value["release-signature"] = "";
            fields.value["release-min-system-version"] = "";
            fields.value["config-product"] = data.products[0]?.slug || "";
          } catch (failure) {
            if (!(failure instanceof ApiError) || failure.status !== 403)
              throw failure;
            keys.value = (await api.get<{ keys: Key[] }>("/keys")).keys;
            recovery.value = true;
          }
        };
        const session = async () => {
          let value: Seller;
          try {
            value = await platform.get<Seller>("/me");
          } catch (failure) {
            if (!(failure instanceof ApiError) || failure.status !== 401)
              throw failure;
            clearSession();
            return;
          }
          if (
            !value.user.email ||
            !Array.isArray(value.tenants) ||
            typeof value.csrfToken !== "string"
          )
            throw new Error("Invalid seller session");
          seller.value = value;
          platform.csrfToken = value.csrfToken;
          const requested = new URLSearchParams(window.location.search).get(
            "tenant",
          );
          selected.value =
            value.tenants.find((item) => item.slug === requested)?.slug ||
            value.tenants[0]?.slug ||
            "";
          await dashboard();
        };
        const readToken = () => {
          const fragment = new URLSearchParams(window.location.hash.slice(1));
          if (fragment.has("account-verification")) {
            panelProof.value = null;
            accountProof.value = fragment.get("account-verification") || "";
            notice.value =
              "Verification link received. Choose the action you requested below.";
            activePage.value = "keys";
            window.history.replaceState(
              null,
              "",
              window.location.pathname + window.location.search,
            );
          }
          if (fragment.has("account-email-change")) {
            notice.value =
              "Open Account security and enter the request ID and both mailbox tokens to confirm your email change.";
            window.history.replaceState(
              null,
              "",
              window.location.pathname + window.location.search,
            );
          }
          if (fragment.has("seller-login")) {
            token.value = fragment.get("seller-login") || "";
            window.history.replaceState(
              null,
              "",
              window.location.pathname + window.location.search,
            );
          }
        };
        readToken();
        window.addEventListener("hashchange", readToken);
        onUnmounted(() => window.removeEventListener("hashchange", readToken));
        onMounted(() => {
          void run(async () => {
            const info = await platform.get<Info>("/info");
            hosted.value = info.deploymentMode !== "standalone";
            applicationFeePercent.value = info.applicationFeePercent ?? 0;
            maxUpload.value = info.maxUploadBytes;
            await session();
          }).finally(() => {
            loading.value = false;
          });
        });
        const field = (
          id: string,
          label: string,
          type = "text",
          required = true,
        ) =>
          h("div", { class: "form-field" }, [
            h("label", { for: id }, label),
            h("input", {
              id,
              type,
              required,
              value: fields.value[id],
              min: type === "number" ? 1 : undefined,
              onInput: (event: Event) => {
                fields.value[id] = (event.target as HTMLInputElement).value;
              },
            }),
          ]);
        const select = (
          id: string,
          label: string,
          options: { value: string; label: string }[],
        ) =>
          h("div", { class: "form-field" }, [
            h("label", { for: id }, label),
            h(
              "select",
              {
                id,
                required: true,
                value: fields.value[id],
                onChange: (event: Event) => {
                  fields.value[id] = (event.target as HTMLSelectElement).value;
                  if (id === "release-product") {
                    const product = overview.value!.products.find(
                      (p) => p.id === fields.value[id],
                    );
                    fields.value["release-target"] =
                      frameworkInfo[frameworkOf(product)].targets[0] || "";
                    fields.value["release-signature"] = "";
                    fields.value["release-min-system-version"] = "";
                    file.value = null;
                  }
                },
              },
              options.map((item) =>
                h("option", { value: item.value }, item.label),
              ),
            ),
          ]);
        const form = (
          id: string,
          action: () => Promise<void>,
          children: unknown[],
          label: string,
        ) => {
          const node = h(
            "form",
            {
              id,
              class: "seller-form",
              onSubmit: (event: Event) => {
                event.preventDefault();
                void run(action);
              },
            },
            [
              ...children,
              h("button", { type: "submit", disabled: busy.value }, label),
            ] as Parameters<typeof h>[2],
          );
          return ["product-create", "release-upload", "key-create"].includes(id)
            ? h("details", { id: `${id}-disclosure`, class: "seller-create" }, [
                h("summary", label),
                node,
              ])
            : node;
        };
        const redirect = async (api: ApiClient, path: string) => {
          const result = await api.post<{ url: string }>(path, {});
          window.location.assign(result.url);
        };
        const confirm = (
          title: string,
          label: string,
          action: () => Promise<void>,
        ) => {
          confirmation.value = {
            title,
            label,
            run: async () => {
              await action();
              await dashboard();
            },
          };
        };
        const copy = async (value: string, id: string) => {
          if (navigator.clipboard) {
            await navigator.clipboard.writeText(value);
            notice.value = "Copied.";
          } else {
            const input = document.getElementById(id) as HTMLInputElement;
            input.focus();
            input.select();
            notice.value = "Selected. Copy it using your keyboard.";
          }
        };
        const releaseProduct = () =>
          overview.value!.products.find(
            (p) => p.id === fields.value["release-product"],
          );
        const configProduct = () =>
          overview.value!.products.find(
            (p) => p.slug === fields.value["config-product"],
          );
        const config = () =>
          setupConfiguration(
            configProduct(),
            window.location.origin,
            selected.value,
            fields.value["config-product"] || "your-product",
          );
        const productConfig = () => {
          switch (fields.value["product-framework"]) {
            case "joomla":
              return {
                extensionType: fields.value["joomla-extension-type"],
                element: fields.value["joomla-element"],
                ...(fields.value["joomla-folder"]
                  ? { folder: fields.value["joomla-folder"] }
                  : {}),
                client: fields.value["joomla-client"],
                joomlaMajor: Number(fields.value["joomla-major"]),
              };
            case "jetbrains":
              return {
                pluginId: fields.value["jetbrains-plugin-id"],
                sinceBuild: fields.value["jetbrains-since-build"],
                ...(fields.value["jetbrains-until-build"]
                  ? { untilBuild: fields.value["jetbrains-until-build"] }
                  : {}),
              };
            case "generic":
              return { activationKind: fields.value["activation-kind"] };
            default:
              return {};
          }
        };
        const metric = (label: string, value: number | string) =>
          h("div", { class: "metric" }, [
            h("dt", label),
            h("dd", String(value)),
          ]);
        const keyVerification = () =>
          h("div", { class: "verification-proof" }, [
            h(
              "p",
              "API key changes require a fresh email verification token for purpose api_keys. Each token approves one action.",
            ),
            btn(
              "Email API key verification",
              () =>
                void run(async () => {
                  await platform.post("/account/verification/request", {
                    purpose: "api_keys",
                  });
                  notice.value =
                    "Check your email for the API key verification token.";
                }),
              busy.value,
            ),
            field(
              "key-verification-token",
              "API key email verification token",
              "password",
            ),
          ]);
        const renderKeyList = () =>
          h(
            "ul",
            { class: "record-list key-records" },
            keys.value.map((key) =>
              h("li", [
                `${key.name} · ${key.revoked_at ? "Revoked" : key.expires_at === null ? "Replace required" : key.expires_at <= Date.now() ? "Expired" : "Active"} `,
                h(
                  "p",
                  `Prefix: ${key.display_prefix} · Permissions: ${(JSON.parse(key.scopes) as string[]).join(", ")}`,
                ),
                h(
                  "p",
                  `Expires: ${key.expires_at === null ? "Unavailable" : new Date(key.expires_at).toLocaleDateString()} · Last used: ${key.last_used_at === null ? "Never" : new Date(key.last_used_at).toLocaleDateString()}`,
                ),
                !key.revoked_at &&
                  btn(
                    "Revoke API key",
                    () =>
                      confirm(
                        `Revoke API key ${key.name}?`,
                        "Confirm revoke API key",
                        async () => {
                          const proof =
                            fields.value["key-verification-token"] || "";
                          fields.value["key-verification-token"] = "";
                          await verifiedRequest(
                            platform,
                            tenantApi(),
                            "api_keys",
                            proof,
                            `/keys/${encodeURIComponent(key.id)}/revoke`,
                            {},
                          );
                        },
                      ),
                    busy.value,
                  ),
              ]),
            ),
          );
        const renderRecovery = () =>
          section("Workspace recovery", [
            h(
              "p",
              "Workspace access is restricted. Billing and API key revocation remain available. Contact the operator to restore business access.",
            ),
            hosted.value &&
              h("div", { class: "button-row" }, [
                btn(
                  `Subscribe to ${site.name}`,
                  () =>
                    void run(() => redirect(tenantApi(), "/platform/checkout")),
                  busy.value,
                ),
                btn(
                  "Platform billing",
                  () =>
                    void run(() => redirect(tenantApi(), "/platform/portal")),
                  busy.value,
                ),
              ]),
            keyVerification(),
            h("h3", "Tenant API keys"),
            renderKeyList(),
          ]);
        const panel = (id: SellerPage, title: string, children: unknown[]) =>
          h(
            "div",
            {
              id: `seller-panel-${id}`,
              class: "seller-view",
              role: "region",
              "aria-labelledby": `seller-nav-${id}`,
              hidden: activePage.value !== id,
            },
            [section(title, children)],
          );
        const renderDashboard = () => {
          const data = overview.value!,
            m = data.metrics;
          return [
            panel("billing", "Workspace status", [
              h("div", { class: "billing-layout" }, [
                h("section", { class: "feature-card" }, [
                  h("div", { class: "feature-section-heading" }, [
                    h("h3", "Customer payments"),
                    hosted.value &&
                      h(
                        "span",
                        { class: "feature-badge" },
                        stripeStatusLabel(data.tenant.stripe_status),
                      ),
                  ]),
                  h(
                    "p",
                    "Receive customer payments through your Stripe account.",
                  ),
                  hosted.value &&
                    h(
                      "p",
                      `${applicationFeePercent.value}% application fee on new customer subscriptions and their renewals. Stripe fees are separate.`,
                    ),
                  hosted.value
                    ? btn(
                        "Connect Stripe",
                        () =>
                          void run(() =>
                            redirect(tenantApi(), "/stripe/connect"),
                          ),
                        busy.value,
                      )
                    : h(
                        "p",
                        "Standalone: no platform subscription or application fees.",
                      ),
                ]),
                h("section", { class: "feature-card" }, [
                  h("div", { class: "feature-section-heading" }, [
                    h(
                      "h3",
                      hosted.value
                        ? "Workspace subscription"
                        : "Your installation",
                    ),
                    hosted.value &&
                      h(
                        "span",
                        { class: "feature-badge" },
                        `${billingStatusLabel(data.tenant.billing_status)}${data.tenant.suspended ? " · Suspended" : ""}`,
                      ),
                  ]),
                  h("dl", { class: "billing-allowances" }, [
                    h("div", [
                      h("dt", "Products"),
                      h(
                        "dd",
                        `${data.products.length} of ${data.tenant.max_products}`,
                      ),
                    ]),
                    h("div", [
                      h("dt", "Storage allowance"),
                      h("dd", readableBytes(data.tenant.max_storage_bytes)),
                    ]),
                  ]),

                  hosted.value &&
                    h("div", { class: "button-row" }, [
                      !hasPlatformSubscription(data.tenant) &&
                        btn(
                          `Subscribe to ${site.name}`,
                          () =>
                            void run(() =>
                              redirect(tenantApi(), "/platform/checkout"),
                            ),
                          busy.value,
                        ),
                      btn(
                        "Platform billing",
                        () =>
                          void run(() =>
                            redirect(tenantApi(), "/platform/portal"),
                          ),
                        busy.value,
                      ),
                    ]),
                  hosted.value &&
                    h("details", { class: "billing-plan-details" }, [
                      h("summary", "Plan and billing details"),
                      h(
                        "p",
                        `Platform trial ends: ${data.tenant.trial_ends_at ? new Date(data.tenant.trial_ends_at).toLocaleDateString() : "Not applicable"}.`,
                      ),
                      h(
                        "p",
                        "To change tiers, cancel renewal in Platform billing, then choose a new tier after your paid subscription ends.",
                      ),
                      h(
                        "a",
                        {
                          href: "/docs#hosted-tiers",
                          target: "_blank",
                          rel: "noopener",
                        },
                        "View plans and billing guide",
                      ),
                    ]),
                ]),
              ]),
              h("a", { href: `/t/${selected.value}` }, "Open buyer page"),
            ]),
            panel("overview", "Your workspace in numbers", [
              h(
                "p",
                { class: "muted" },
                "Your licenses, downloads and releases at a glance.",
              ),
              h("dl", { class: "overview-summary" }, [
                metric("Entitled licenses", m.licenses.entitled!),
                metric(
                  "Seats in use",
                  `${m.seats.used} / ${m.seats.allowance}`,
                ),
                metric("Downloads last 30 days", m.downloads.last30Days!),
                metric("Published releases", m.releases.published!),
              ]),
              h(
                "details",
                { id: "metrics-details", class: "metrics-details" },
                [
                  h("summary", "View all activity and storage metrics"),
                  h(
                    "p",
                    { class: "feature-description" },
                    "Downloads count successful server responses. Collected payments include taxes and exclude Stripe fees.",
                  ),
                  h("dl", { class: "metrics-grid" }, [
                    ...Object.entries(m.licenses).map(([label, value]) =>
                      metric(`Licenses ${label}`, value),
                    ),
                    ...Object.entries(m.installations).map(([label, value]) =>
                      metric(
                        `Installations ${label.replace(/([A-Z])/g, " $1").toLowerCase()}`,
                        value,
                      ),
                    ),
                    ...Object.entries(m.seats).map(([label, value]) =>
                      metric(`Seats ${label}`, value),
                    ),
                    ...Object.entries(m.releases).map(([label, value]) =>
                      metric(`Releases ${label}`, value),
                    ),
                    metric("Used storage bytes", m.storage.usedBytes!),
                    metric("Reserved storage bytes", m.storage.reservedBytes!),
                    metric("Storage limit bytes", m.storage.limitBytes!),
                    metric(
                      "Successful downloads",
                      m.downloads.successfulResponses!,
                    ),
                    metric("Downloads last 30 days", m.downloads.last30Days!),
                  ]),
                ],
              ),
              ...m.payments.map((payment) =>
                h("div", { class: "payment-totals" }, [
                  h("h3", payment.currency.toUpperCase()),
                  h("dl", { class: "metrics-grid" }, [
                    metric(
                      "Collected",
                      money(payment.currency, payment.paidMinor),
                    ),
                    metric(
                      "Refunded",
                      money(payment.currency, payment.refundedMinor),
                    ),
                    metric(
                      "Net collected",
                      money(payment.currency, payment.netMinor),
                    ),
                  ]),
                ]),
              ),
            ]),
            panel("products", "Products", [
              localMode.value &&
                h(
                  "p",
                  { class: "notice" },
                  "Local fixture prices. These are simulated, not live Stripe prices.",
                ),
              !prices.value.length &&
                h(
                  "p",
                  "Connect Stripe and create an active annual recurring price to add a product.",
                ),
              form(
                "product-create",
                async () => {
                  await tenantApi().post("/products", {
                    name: fields.value["product-name"],
                    slug: fields.value["product-slug"],
                    framework: fields.value["product-framework"],
                    frameworkConfig: productConfig(),
                    ...(fields.value["product-framework"] === "wordpress"
                      ? { pluginBasename: fields.value["plugin-basename"] }
                      : {}),
                    plans: [
                      {
                        name: fields.value["plan-name"],
                        siteAllowance: Number(fields.value["site-allowance"]),
                        priceId: fields.value["price-id"],
                      },
                    ],
                  });
                  await dashboard();
                  notice.value = "Product created.";
                },
                [
                  field("product-name", "Product name"),
                  field("product-slug", "Product slug"),
                  select(
                    "product-framework",
                    "Framework",
                    Object.entries(frameworkInfo).map(([value, info]) => ({
                      value,
                      label: info.name,
                    })),
                  ),
                  fields.value["product-framework"] === "wordpress" &&
                    field("plugin-basename", "Plugin basename", "text", false),
                  fields.value["product-framework"] === "joomla" &&
                    h("div", [
                      select(
                        "joomla-extension-type",
                        "Extension type",
                        [
                          "plugin",
                          "component",
                          "module",
                          "template",
                          "package",
                          "library",
                        ].map((value) => ({ value, label: value })),
                      ),
                      field("joomla-element", "Extension element"),
                      field(
                        "joomla-folder",
                        "Plugin folder",
                        "text",
                        fields.value["joomla-extension-type"] === "plugin",
                      ),
                      select(
                        "joomla-client",
                        "Joomla client",
                        ["site", "administrator"].map((value) => ({
                          value,
                          label: value,
                        })),
                      ),
                      field("joomla-major", "Joomla major version", "number"),
                    ]),
                  fields.value["product-framework"] === "jetbrains" &&
                    h("div", [
                      field("jetbrains-plugin-id", "JetBrains plugin ID"),
                      field("jetbrains-since-build", "Since build"),
                      field(
                        "jetbrains-until-build",
                        "Until build",
                        "text",
                        false,
                      ),
                    ]),
                  fields.value["product-framework"] === "generic" &&
                    select(
                      "activation-kind",
                      "Activation kind",
                      ["device", "site"].map((value) => ({
                        value,
                        label: value,
                      })),
                    ),
                  field("plan-name", "Plan name"),
                  field(
                    "site-allowance",
                    seatUnit({
                      framework: fields.value["product-framework"] as Framework,
                      frameworkConfig: {
                        activationKind: fields.value["activation-kind"] as
                          "site" | "device",
                      },
                    }) === "site"
                      ? "Site allowance"
                      : "Device allowance",
                    "number",
                  ),
                  select(
                    "price-id",
                    "Annual Stripe price",
                    prices.value.map((price) => ({
                      value: price.id,
                      label: `${price.productName} · ${price.nickname || price.id} · ${price.unit_amount === null ? "Custom price" : money(price.currency, String(price.unit_amount))}/${price.interval}`,
                    })),
                  ),
                ],
                "Create product",
              ),
              h(
                "p",
                "Framework identity cannot change after licenses or releases exist. Create another product when its framework or identity changes.",
              ),
              h(
                "ul",
                { class: "record-list product-records" },
                data.products.map((product) =>
                  h("li", [
                    h("strong", product.name),
                    ` · ${product.slug} · ${frameworkInfo[frameworkOf(product)].name}${frameworkOf(product) === "wordpress" ? ` · ${product.plugin_basename}` : ""}`,
                    h(
                      "ul",
                      product.plans.map((plan) =>
                        h(
                          "li",
                          `${plan.name} · ${plan.site_allowance} ${seatUnit(product)}${plan.site_allowance === 1 ? "" : "s"} · ${plan.stripe_price_id}`,
                        ),
                      ),
                    ),
                  ]),
                ),
              ),
            ]),
            panel("releases", "Private releases", [
              h(
                "p",
                `Maximum ${maxUpload.value / 1048576} MiB per asset. Framework package validation and tenant storage quotas are enforced by the server. Published version notes and target bytes cannot be replaced.`,
              ),
              form(
                "release-upload",
                async () => {
                  const framework = frameworkOf(releaseProduct());
                  if (!file.value)
                    throw new ApiError(
                      framework === "wordpress"
                        ? "Choose a plugin ZIP."
                        : "Choose a release asset.",
                    );
                  if (file.value.size > maxUpload.value)
                    throw new ApiError(
                      `Choose a ${framework === "wordpress" ? "ZIP" : "release asset"} no larger than ${maxUpload.value / 1048576} MiB.`,
                    );
                  if (
                    frameworkInfo[framework].signature &&
                    !fields.value["release-signature"]!.trim()
                  )
                    throw new ApiError(
                      "A detached signature is required for this framework.",
                    );
                  const requirements = Object.fromEntries<string>(
                    (
                      [
                        ["minWp", fields.value["release-min-wp"]!.trim()],
                        ["minPhp", fields.value["release-min-php"]!.trim()],
                        ["minFree", fields.value["release-min-free"]!.trim()],
                        ["tested", fields.value["release-tested"]!.trim()],
                      ] as [string, string][]
                    ).filter(([, value]) => value),
                  );
                  if (
                    framework === "wordpress" &&
                    Object.values(requirements).some(
                      (value) => !/^\d+\.\d+(?:\.\d+)?$/.test(value),
                    )
                  )
                    throw new ApiError(
                      "Use numeric versions such as 6.0 or 8.1.2 for release requirements.",
                    );
                  const metadata = {
                    changelog: fields.value["release-changelog"],
                    ...(framework === "wordpress"
                      ? requirements
                      : {
                          target: fields.value["release-target"],
                          filename: file.value.name,
                          ...(fields.value["release-signature"]
                            ? { signature: fields.value["release-signature"] }
                            : {}),
                          ...(fields.value["release-min-system-version"]
                            ? {
                                minSystemVersion:
                                  fields.value["release-min-system-version"],
                              }
                            : {}),
                        }),
                  };
                  const encoded = btoa(
                    Array.from(
                      new TextEncoder().encode(JSON.stringify(metadata)),
                      (byte) => String.fromCharCode(byte),
                    ).join(""),
                  )
                    .replaceAll("+", "-")
                    .replaceAll("/", "_")
                    .replace(/=+$/, "");
                  const uploadApi = tenantApi();
                  const uploadPath = `/${framework === "wordpress" ? "releases" : "assets"}/${encodeURIComponent(releaseProduct()!.slug)}/${encodeURIComponent(fields.value["release-version"]!)}`;
                  const uploadBody = await file.value.arrayBuffer();
                  const proof =
                    fields.value["release-verification-token"] || "";
                  fields.value["release-verification-token"] = "";
                  const grant = await platform.post<{ verification: string }>(
                    "/account/verification/consume",
                    { purpose: "release_publish", token: proof },
                  );
                  await uploadApi.request(uploadPath, {
                    method: "POST",
                    headers: {
                      "Content-Type":
                        framework === "wordpress"
                          ? "application/zip"
                          : "application/octet-stream",
                      "X-CSRF-Token": platform.csrfToken,
                      "X-Release-Metadata": encoded,
                      "X-Account-Verification": grant.verification,
                    },
                    body: uploadBody,
                  });
                  await dashboard();
                  notice.value = "Release published.";
                },
                [
                  h(
                    "p",
                    "Browser publication requires a fresh email token for purpose release_publish. Scoped API keys can publish from CI.",
                  ),
                  btn(
                    "Email release verification",
                    () =>
                      void run(async () => {
                        await platform.post("/account/verification/request", {
                          purpose: "release_publish",
                        });
                        notice.value =
                          "Check your email for the release publication token.";
                      }),
                    busy.value,
                  ),
                  field(
                    "release-verification-token",
                    "Release publication email verification token",
                    "password",
                  ),
                  select(
                    "release-product",
                    "Release product",
                    data.products.map((product) => ({
                      value: product.id,
                      label: product.name,
                    })),
                  ),
                  field("release-version", "Version"),
                  field("release-changelog", "Release notes", "text", false),
                  ...(frameworkOf(releaseProduct()) === "wordpress"
                    ? [
                        field(
                          "release-min-wp",
                          "Minimum WordPress",
                          "text",
                          false,
                        ),
                        field("release-min-php", "Minimum PHP", "text", false),
                        field(
                          "release-min-free",
                          "Minimum free plugin",
                          "text",
                          false,
                        ),
                        field(
                          "release-tested",
                          "Tested WordPress",
                          "text",
                          false,
                        ),
                      ]
                    : [
                        frameworkOf(releaseProduct()) === "generic"
                          ? field("release-target", "Target")
                          : select(
                              "release-target",
                              "Target",
                              frameworkInfo[
                                frameworkOf(releaseProduct())
                              ].targets.map((value) => ({
                                value,
                                label: value,
                              })),
                            ),
                        field(
                          "release-signature",
                          "Detached signature",
                          "text",
                          frameworkInfo[frameworkOf(releaseProduct())]
                            .signature,
                        ),
                        field(
                          "release-min-system-version",
                          "Minimum system version",
                          "text",
                          false,
                        ),
                      ]),
                  h("div", { class: "form-field" }, [
                    h(
                      "label",
                      { for: "release-file" },
                      frameworkOf(releaseProduct()) === "wordpress"
                        ? "Plugin ZIP"
                        : "Release asset",
                    ),
                    h("input", {
                      id: "release-file",
                      key: fields.value["release-product"]!,
                      type: "file",
                      accept:
                        frameworkInfo[frameworkOf(releaseProduct())].accept,
                      required: true,
                      onChange: (event: Event) => {
                        file.value =
                          (event.target as HTMLInputElement).files?.[0] || null;
                      },
                    }),
                  ]),
                ],
                "Publish release",
              ),
              h(
                "ul",
                { class: "record-list release-records" },
                data.releases.map((release) =>
                  h("li", [
                    `Version ${release.version} · ${release.withdrawn ? "Withdrawn" : "Published"} `,
                    h(
                      "ul",
                      release.assets?.map((asset) =>
                        h(
                          "li",
                          `${asset.target} · ${asset.filename} · ${readableBytes(asset.size)} · SHA-256 ${asset.checksum}`,
                        ),
                      ),
                    ),
                    !release.withdrawn &&
                      btn(
                        "Withdraw release",
                        () =>
                          confirm(
                            `Withdraw version ${release.version}?`,
                            "Confirm withdrawal",
                            async () => {
                              await tenantApi().post(
                                `/releases/${encodeURIComponent(release.id)}/withdraw`,
                                {},
                              );
                            },
                          ),
                        busy.value,
                      ),
                  ]),
                ),
              ),
            ]),
            panel("setup", "Client setup", [
              select(
                "config-product",
                "Configuration product",
                data.products.map((product) => ({
                  value: product.slug,
                  label: product.name,
                })),
              ),
              h(
                "label",
                { for: "php-config" },
                frameworkOf(configProduct()) === "wordpress"
                  ? "Tenant-specific PHP configuration"
                  : "Tenant-specific setup configuration",
              ),
              h("textarea", {
                id: "php-config",
                readonly: true,
                rows: 5,
                value: config(),
              }),
              btn(
                frameworkOf(configProduct()) === "wordpress"
                  ? "Copy PHP configuration"
                  : "Copy setup configuration",
                () => void run(() => copy(config(), "php-config")),
                busy.value,
              ),
            ]),
            panel("licenses", "Licenses", [
              h("div", { class: "table-scroll" }, [
                h("table", [
                  h("caption", "Customer entitlements for this workspace"),
                  h("thead", [
                    h(
                      "tr",
                      [
                        "Customer",
                        "Product and plan",
                        "Seats",
                        "Billing",
                        "Paid through",
                        "Access",
                        "Action",
                      ].map((label) => h("th", { scope: "col" }, label)),
                    ),
                  ]),
                  h(
                    "tbody",
                    data.licenses.map((license) =>
                      h("tr", [
                        h("td", license.customer_email),
                        h(
                          "td",
                          `${license.product_name} · ${license.plan_name}`,
                        ),
                        h("td", String(license.site_allowance)),
                        h("td", license.billing_status),
                        h(
                          "td",
                          license.paid_through
                            ? new Date(
                                license.paid_through,
                              ).toLocaleDateString()
                            : "Not yet available",
                        ),
                        h(
                          "td",
                          license.revoked
                            ? "Revoked"
                            : license.suspended
                              ? "Suspended"
                              : "See paid through",
                        ),
                        h(
                          "td",
                          btn(
                            license.revoked
                              ? "Restore license"
                              : "Revoke license",
                            () =>
                              confirm(
                                `${license.revoked ? "Restore" : "Revoke"} ${license.product_name} for ${license.customer_email}?`,
                                license.revoked
                                  ? "Confirm restore license"
                                  : "Confirm revoke license",
                                async () => {
                                  await tenantApi().post(
                                    `/licenses/${encodeURIComponent(license.id)}/revoke`,
                                    { revoked: !license.revoked },
                                  );
                                },
                              ),
                            busy.value,
                          ),
                        ),
                      ]),
                    ),
                  ),
                ]),
              ]),
            ]),
            panel("keys", "API keys", [
              keyVerification(),
              h(
                "p",
                "Use tenant API keys for server automation. Never include them in distributed plugins or browser code.",
              ),
              form(
                "key-create",
                async () => {
                  const proof = fields.value["key-verification-token"] || "";
                  fields.value["key-verification-token"] = "";
                  const result = await verifiedRequest<{ token: string }>(
                    platform,
                    tenantApi(),
                    "api_keys",
                    proof,
                    "/keys",
                    {
                      name: fields.value["key-name"],
                      scopes: keyScopes.value,
                      expiresInDays: Number(fields.value["key-expiry"]),
                    },
                  );
                  secret.value = result.token;
                  keys.value = (
                    await tenantApi().get<{ keys: Key[] }>("/keys")
                  ).keys;
                },
                [
                  field("key-name", "API key name"),
                  h("fieldset", [
                    h("legend", "API key permissions"),
                    ...[
                      ["read", "Read workspace data"],
                      ["catalog:write", "Manage products and plans"],
                      ["releases:write", "Publish and withdraw releases"],
                      ["licenses:write", "Manage licenses"],
                      ["billing:reconcile", "Reconcile billing"],
                      ["data:export", "Export encrypted tenant data"],
                      ["operations:write", "Manage operations and webhooks"],
                    ].map(([scope, label]) =>
                      h("label", [
                        h("input", {
                          type: "checkbox",
                          value: scope,
                          checked: keyScopes.value.includes(scope!),
                          onChange: (event: Event) => {
                            keyScopes.value = (event.target as HTMLInputElement)
                              .checked
                              ? [...keyScopes.value, scope!]
                              : keyScopes.value.filter(
                                  (value) => value !== scope,
                                );
                          },
                        }),
                        label,
                      ]),
                    ),
                  ]),
                  select(
                    "key-expiry",
                    "API key expires after",
                    [1, 7, 30, 90, 180, 365].map((days) => ({
                      value: String(days),
                      label: `${days} ${days === 1 ? "day" : "days"}`,
                    })),
                  ),
                ],
                "Create API key",
              ),
              secret.value &&
                h("div", { class: "key-notice" }, [
                  h(
                    "p",
                    "This API key is shown once. Save it securely before dismissing it.",
                  ),
                  h("label", { for: "new-api-key" }, "New tenant API key"),
                  h("input", {
                    id: "new-api-key",
                    readonly: true,
                    type: "text",
                    value: secret.value,
                    autocomplete: "off",
                    spellcheck: false,
                  }),
                  h("div", { class: "button-row" }, [
                    btn(
                      "Copy API key",
                      () => void run(() => copy(secret.value, "new-api-key")),
                      busy.value,
                    ),
                    btn("I saved my API key", () => {
                      secret.value = "";
                    }),
                  ]),
                ]),
              renderKeyList(),
            ]),
          ];
        };
        return () =>
          h("div", { class: "app seller-app" }, [
            h("a", { href: "#main", class: "skip-link" }, "Skip to content"),
            header(),
            h("main", { id: "main", class: "page-main seller-main" }, [
              h("div", { class: "page-heading" }, [
                h("div", [
                  h("p", { class: "eyebrow" }, "Seller workspace"),
                  h(
                    "h1",
                    overview.value
                      ? sellerPages.find(
                          (page) => page.id === activePage.value,
                        )!.label
                      : recovery.value
                        ? "Workspace recovery"
                        : "Your software business",
                  ),
                  seller.value && h("p", seller.value.user.email),
                ]),
                seller.value &&
                  btn(
                    "Sign out",
                    () =>
                      void run(async () => {
                        await platform.post("/auth/logout", {});
                        clearSession();
                      }),
                    busy.value,
                  ),
              ]),
              overview.value?.sandbox?.isSandbox &&
                h("div", { class: "notice sandbox-badge", role: "status" }, [
                  h("strong", "TEST WORKSPACE"),
                  h(
                    "p",
                    `${overview.value.sandbox.mode} sandbox for ${overview.value.sandbox.parentSlug}. Test data is separate from the publisher's live workspace.`,
                  ),
                  h(
                    "p",
                    `API origin: ${window.location.origin}/api/v1/tenants/${encodeURIComponent(selected.value)}`,
                  ),
                  h(
                    "a",
                    { href: `/t/${encodeURIComponent(selected.value)}` },
                    "Open test buyer page",
                  ),
                ]),
              error.value &&
                h("p", { role: "alert", class: "error-banner" }, error.value),
              notice.value &&
                h("p", { role: "status", class: "notice" }, notice.value),
              busy.value && h("p", { role: "status" }, "Working…"),
              token.value !== null &&
                section("Confirm seller sign in", [
                  h(
                    "p",
                    "Use your emailed link to sign in. The link is single-use.",
                  ),
                  btn(
                    "Confirm seller sign in",
                    () =>
                      void run(async () => {
                        await platform.post(
                          "/auth/consume",
                          { token: token.value },
                          false,
                        );
                        token.value = null;
                        clearSession();
                        await session();
                      }, false),
                    busy.value || !token.value,
                  ),
                  btn("Cancel sign in", () => {
                    token.value = null;
                  }),
                ]),
              loading.value
                ? h("p", { role: "status" }, "Loading seller session…")
                : !seller.value
                  ? section("Sign in to sell", [
                      h(
                        "p",
                        "Create your seller account or sign in with an email link.",
                      ),
                      form(
                        "seller-login",
                        async () => {
                          await platform.post(
                            "/auth/request",
                            { email: fields.value["seller-email"]!.trim() },
                            false,
                          );
                          notice.value = "Check your email for a sign-in link.";
                        },
                        [field("seller-email", "Email address", "email")],
                        "Email seller sign-in link",
                      ),
                      h(
                        "details",
                        {
                          class: "account-recovery",
                          onToggle: (event: Event) => {
                            recoveryOpen.value = (
                              event.target as HTMLDetailsElement
                            ).open;
                          },
                        },
                        [
                          h("summary", "Use a recovery code"),
                          recoveryOpen.value &&
                            h(SellerFeaturePanel, {
                              page: "recovery",
                              api: platform,
                              platform,
                              hosted: hosted.value,
                              products: [],
                              confirm,
                              onSignedOut: () => void run(session),
                            }),
                        ],
                      ),
                      error.value &&
                        btn(
                          "Retry session",
                          () => void run(session),
                          busy.value,
                        ),
                    ])
                  : h("div", { class: "seller-layout" }, [
                      h(
                        "aside",
                        {
                          class: "seller-sidebar",
                          "aria-label": "Workspace controls",
                        },
                        [
                          h("div", { class: "workspace-switcher" }, [
                            hosted.value &&
                              seller.value.tenants.length > 0 &&
                              h(
                                "label",
                                { for: "tenant-select" },
                                "Selected workspace",
                              ),
                            hosted.value &&
                              seller.value.tenants.length > 0 &&
                              h(
                                "select",
                                {
                                  id: "tenant-select",
                                  disabled: busy.value,
                                  value: selected.value,
                                  onChange: (event: Event) => {
                                    activePage.value = "overview";
                                    accountProof.value = "";
                                    panelProof.value = null;
                                    selected.value = (
                                      event.target as HTMLSelectElement
                                    ).value;
                                    void run(dashboard);
                                  },
                                },
                                seller.value.tenants.map((item) =>
                                  h("option", { value: item.slug }, item.name),
                                ),
                              ),
                            seller.value.tenants.length > 0 &&
                              btn(
                                "Refresh dashboard",
                                () => void run(dashboard),
                                busy.value,
                              ),
                            hosted.value &&
                              h(
                                "details",
                                {
                                  id: "workspace-create-disclosure",
                                  class: "workspace-create",
                                  open: seller.value.tenants.length === 0,
                                },
                                [
                                  h("summary", "New workspace"),
                                  form(
                                    "tenant-create",
                                    async () => {
                                      const result = await platform.post<{
                                        tenant: Tenant;
                                      }>("/tenants", {
                                        slug: fields.value["tenant-slug"],
                                        name: fields.value["tenant-name"],
                                      });
                                      seller.value!.tenants.push(result.tenant);
                                      activePage.value = "overview";
                                      selected.value = result.tenant.slug;
                                      await dashboard();
                                    },
                                    [
                                      field("tenant-name", "Workspace name"),
                                      field("tenant-slug", "Workspace slug"),
                                    ],
                                    "Create workspace",
                                  ),
                                ],
                              ),
                          ]),
                          overview.value &&
                            h(
                              "nav",
                              {
                                "aria-label": "Workspace navigation",
                                class: "seller-nav",
                              },
                              [
                                h(
                                  "label",
                                  {
                                    class: "seller-mobile-nav",
                                    for: "seller-mobile-page",
                                  },
                                  [
                                    "Go to",
                                    h(
                                      "select",
                                      {
                                        id: "seller-mobile-page",
                                        value: activePage.value,
                                        disabled: busy.value,
                                        onChange: (event: Event) => {
                                          activePage.value = (
                                            event.target as HTMLSelectElement
                                          ).value as SellerPage;
                                        },
                                      },
                                      sellerPages.map((page) =>
                                        h(
                                          "option",
                                          { value: page.id },
                                          page.label,
                                        ),
                                      ),
                                    ),
                                  ],
                                ),
                                h("div", { class: "seller-desktop-nav" }, [
                                  ...sellerPages
                                    .filter((page) => page.id === "overview")
                                    .map((page) =>
                                      h(
                                        "button",
                                        {
                                          id: `seller-nav-${page.id}`,
                                          type: "button",
                                          class: "seller-nav-link",
                                          "aria-controls": `seller-panel-${page.id}`,
                                          "aria-current":
                                            activePage.value === page.id
                                              ? "page"
                                              : undefined,
                                          disabled: busy.value,
                                          onClick: () => {
                                            activePage.value = page.id;
                                          },
                                        },
                                        page.label,
                                      ),
                                    ),
                                  ...sellerPageGroups.map((group) =>
                                    h("div", { class: "seller-nav-group" }, [
                                      h("p", group.label),
                                      ...sellerPages
                                        .filter((page) =>
                                          group.pages.includes(page.id),
                                        )
                                        .map((page) =>
                                          h(
                                            "button",
                                            {
                                              id: `seller-nav-${page.id}`,
                                              type: "button",
                                              class: "seller-nav-link",
                                              "aria-controls": `seller-panel-${page.id}`,
                                              "aria-current":
                                                activePage.value === page.id
                                                  ? "page"
                                                  : undefined,
                                              disabled: busy.value,
                                              onClick: () => {
                                                activePage.value = page.id;
                                              },
                                            },
                                            page.label,
                                          ),
                                        ),
                                    ]),
                                  ),
                                ]),
                              ],
                            ),
                        ],
                      ),
                      h("div", { class: "seller-content" }, [
                        seller.value.tenants.length === 0 &&
                          section("Create your first workspace", [
                            h(
                              "p",
                              "Use the workspace form to get started. Then connect Stripe, add your products and publish releases.",
                            ),
                          ]),
                        recovery.value && renderRecovery(),
                        (recovery.value || seller.value.tenants.length === 0) &&
                          btn(
                            "Account security",
                            () => {
                              activePage.value = "security";
                            },
                            busy.value,
                          ),
                        accountProof.value &&
                          h("div", { class: "panel verification-proof" }, [
                            h(
                              "p",
                              "Choose the purpose of the verification email you requested. The token can approve only that action in this browser.",
                            ),
                            h(
                              "select",
                              {
                                "aria-label": "Verification purpose",
                                value: proofPurpose.value,
                                onChange: (event: Event) => {
                                  proofPurpose.value = (
                                    event.target as HTMLSelectElement
                                  ).value;
                                },
                              },
                              [
                                h(
                                  "option",
                                  { value: "api_keys" },
                                  "API key change",
                                ),
                                h(
                                  "option",
                                  { value: "recovery_codes" },
                                  "Recovery codes",
                                ),
                                h(
                                  "option",
                                  { value: "release_publish" },
                                  "Publish a release",
                                ),
                                h(
                                  "option",
                                  { value: "tenant_transfer" },
                                  "Tenant export",
                                ),
                              ],
                            ),
                            btn(
                              "Continue with verification link",
                              () => {
                                if (proofPurpose.value === "api_keys") {
                                  fields.value["key-verification-token"] =
                                    accountProof.value;
                                  activePage.value = "keys";
                                } else if (
                                  proofPurpose.value === "release_publish"
                                ) {
                                  fields.value["release-verification-token"] =
                                    accountProof.value;
                                  activePage.value = "releases";
                                } else {
                                  const page =
                                    proofPurpose.value === "recovery_codes"
                                      ? "security"
                                      : "export";
                                  panelProof.value = {
                                    page,
                                    token: accountProof.value,
                                  };
                                  proofRound.value++;
                                  activePage.value = page;
                                }
                                accountProof.value = "";
                                notice.value = "";
                              },
                              busy.value,
                            ),
                          ]),
                        overview.value && renderDashboard(),
                        seller.value &&
                          [
                            "commerce",
                            "sandbox",
                            "operations",
                            "webhooks",
                            "security",
                            "export",
                          ].includes(activePage.value) &&
                          h(
                            "div",
                            {
                              id: `seller-panel-${activePage.value}`,
                              class: "seller-view",
                              role: "region",
                              "aria-labelledby": overview.value
                                ? `seller-nav-${activePage.value}`
                                : undefined,
                              "aria-label": sellerPages.find(
                                (page) => page.id === activePage.value,
                              )!.label,
                            },
                            [
                              h(SellerFeaturePanel, {
                                key: `${selected.value}:${activePage.value}:${proofRound.value}`,
                                page: activePage.value,
                                embedded: !!overview.value,
                                api: tenantApi(),
                                platform,
                                hosted: hosted.value,
                                subscribed: hasPlatformSubscription(
                                  overview.value?.tenant,
                                ),
                                products: overview.value?.products || [],
                                confirm: (
                                  title: string,
                                  label: string,
                                  action: () => Promise<void>,
                                ) => {
                                  confirmation.value = {
                                    title,
                                    label,
                                    run: action,
                                  };
                                },
                                initialToken:
                                  panelProof.value?.page === activePage.value
                                    ? panelProof.value.token
                                    : "",
                                invalidateProof: (
                                  page: string,
                                  token: string,
                                ) => {
                                  if (
                                    panelProof.value?.page === page &&
                                    panelProof.value.token === token
                                  )
                                    panelProof.value = null;
                                },
                                onExpired: clearSession,
                                onSignedOut: () => {
                                  clearSession();
                                  void run(session);
                                },
                              }),
                            ],
                          ),
                      ]),
                    ]),
              confirmation.value &&
                h(SellerConfirmation, {
                  title: confirmation.value.title,
                  label: confirmation.value.label,
                  onCancel: () => {
                    confirmation.value = null;
                  },
                  onConfirm: () => {
                    const action = confirmation.value!.run;
                    confirmation.value = null;
                    void run(action);
                  },
                }),
            ]),
            h("footer", { class: "site-footer" }, [
              h("a", { href: "/docs#licensing" }, "Source & licenses"),
            ]),
          ]);
      },
    }),
  );
  app.mount(target);
  return app;
}
