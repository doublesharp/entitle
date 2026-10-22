# Doublesharp Entitle branding

Approved on 2026-10-21: the public product name is Doublesharp Entitle, paired
with the geometric double-sharp mark from logo option 1. First-party npm
packages use the `@0xdoublesharp` scope. The private app package is
`@0xdoublesharp/entitle`.

The mark uses an ivory symbol on a forest-green rounded square. Use the same
SVG for the header and favicon so the geometry stays consistent at small sizes.
The text beside the mark supplies its accessible name; the image is decorative.

## Homepage visual direction

The public homepage uses a deep forest-green hero, ivory text, and a restrained
warm-gold accent for the main action and highlighted license step. Feature cards
have stronger borders and clearer icon contrast. Keep the existing content and
navigation, and scope these styles to `.home-page`. At narrow widths, stack the
hero and reduce its inset padding. Avoid decorative animation and keep keyboard
focus indicators visible.

Apply the changes in the existing homepage CSS, then verify the actual rendered
homepage at desktop and mobile widths, run the existing UI tests and lint, and
build to an isolated Scratch directory. Preserve the running service and other
agents' changes.

## Implementation plan

- [x] Add `web/public/favicon.svg` and reference it from `web/index.html` and
  the public, seller, and customer headers in `web/site.ts` and `web/main.ts`.
- [x] Update the brand CSS and let mobile navigation wrap below the longer name.
- [x] Update `src/site.ts`, branded email subjects, the private package name,
  current overview documentation, and existing expectations for public copy.
  Preserve technical identifiers, integration settings, and historical records.
- [x] Run the existing UI and email/API tests, typecheck, lint, and a build in
  an isolated Scratch directory. Inspect desktop and mobile layouts and confirm
  that the built favicon is served as SVG.

This checkout has no Git repository. Edit in place, keep all build and preview
output on Scratch, and preserve the existing application process on port 3211.

## Verification

The 141 focused UI, API, authentication, licensing, and tenant tests pass.
Lint and the isolated Vite frontend build pass. The header fits at 375px and
728px, and the favicon returns HTTP 200 with `image/svg+xml` in the isolated
preview. Typecheck and the full build are blocked by TS2322 in
`src/seller-api.ts:179`, outside the branding changes: a nullable Stripe account
ID loses its narrowing inside an async cache callback. That file was left
unchanged. The existing application process was not restarted.

The subsequent homepage polish passes the full build, lint, and all 88 existing
UI tests. Visual checks at 320, 375, 728, 768, and 1280px show no horizontal
overflow. The updated hero text and primary action exceed 4.5:1 contrast.
The local service on port 3211 serves the verified stylesheet; no process
restart was needed. The earlier typecheck blocker has been resolved by other
workspace work.
