# Stripe Elements checkout

User requested implementation on 2026-10-21 as an addition to the approved SaaS design.

Use the Payment Element with Checkout Sessions, preserving server-controlled annual
prices, customer mappings, subscriptions and the connected seller account. A raw
PaymentIntent integration would duplicate subscription orchestration; a full
embedded Checkout page offers less control over form layout. Elements is the
selected approach for custom forms and styling.

The tenant checkout endpoint accepts `uiMode: "elements" | "hosted"`. Omitting it
keeps the API's hosted flow; the customer interface explicitly requests Elements.
Elements sessions return a short-lived session client secret, the platform's
publishable key, the connected account ID and a server-controlled return URL.
These values are returned only in the no-store response, never logged or stored
in browser persistence. Prices, amounts and account IDs are never accepted from
the caller. The client initializes Stripe.js for that same connected account.

The Vue form renders the Payment Element with an Appearance configuration matching
the site, a canonical Stripe order total, loading/validation errors, retry and
cancel controls. Prevent duplicate confirmation and discard late initialization
after cancellation or sign-out. Destroy Elements on cancellation/unmount. Display
payment submission as pending confirmation; never issue a license from browser
success, return parameters or a claimed Session status. Existing signed webhooks
and canonical invoice reconciliation remain the entitlement authority.

Use the official `@stripe/stripe-js` loader, exactly 10.1.0, verified from npm on
2026-10-21. It loads Stripe.js from Stripe's origin; it does not bundle card fields
into our application. With Stripe Node 23.0.0 and API `2026-09-30.endive`, the
supported names are `ui_mode: "elements"` and `initCheckoutElementsSdk`; older
examples using `custom`/`initCheckout` do not match these pinned declarations.
Production requires `STRIPE_PUBLISHABLE_KEY` and narrowly scoped Stripe CSP
origins. No card data reaches Double Entitle.

External seller websites can render a guest Elements form through their backend
or same-origin proxy, preserving the encrypted HttpOnly checkout cookie on both
successful and failed responses. The browser claim permits retries only for the
customer it created while that customer has no licenses. It never authenticates
a paid customer or grants access to the customer dashboard. Existing customers
must sign in through the hosted buyer flow, or use an integration proxying the
complete same-origin session flow. A general cross-domain customer authentication
bridge is not implemented. Preserve account scoping, keep the client secret in
memory and use the returned canonical `${PUBLIC_ORIGIN}/t/SLUG` return URL.
Customer-session CORS remains disabled. Seller API keys never go into checkout
forms. Hosted platform subscription checkout and Customer Portal remain separate.

Verify session parameters and account headers with the real server SDK against a
local HTTP fixture; test rejected/missing configuration and provider secrets.
Exercise Elements mount, Appearance, amount display, confirmation errors,
pending/completed results, retries, cancellation and teardown with typed browser
doubles, preserving the 100% per-module coverage gate. Real Stripe test-account
card/3DS confirmation requires supplied credentials and must be reported separately
if unexercised. No live charges or production deployment are authorized.

References: [Elements integration index](https://docs.stripe.com/payments/accept-a-payment?platform=web&ui=embedded-components),
[Connect client account scoping](https://docs.stripe.com/connect/direct-charges?platform=web&ui=elements),
[CSP requirements](https://docs.stripe.com/security/guide.md), and the installed
official SDK declarations for the exact pinned Endive integration names.
