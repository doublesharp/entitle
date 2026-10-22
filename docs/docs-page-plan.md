# Guide-first documentation page

Approved October 21, 2026. Keep the existing forest-green branding and make
`/docs` a practical guide for a seller setting up their first product.

## Implementation

- Move public documentation rendering from `web/site.ts` to `web/docs.ts`.
  Keep the existing public header, footer, API request and retry behavior.
- Lead with a setup walkthrough. Explain workspaces, products, plans, licenses
  and installations before introducing API credentials.
- Add a seven-framework comparison, publishing instructions, current-origin
  HTTP examples, billing/access rules, live server limits and troubleshooting.
- Preserve `getting-started`, `framework-support`, `server-limits`, `billing`
  and `licensing` anchors and all existing source/license download links.
- Scope styling to `.docs-page`. Use a sticky grouped contents menu on desktop,
  a compact menu on mobile, readable line lengths, tables and code examples.
- Keep credentials as illustrative placeholders. Examples must use actual
  tenant-scoped endpoints and distinguish buyer activation tokens from seller
  automation keys. Do not add dependencies or change business behavior.

## Verification and delivery

- Run the existing seller/public UI tests, TypeScript check and lint with the
  pinned Node 26.12.0 runtime. Build into Scratch.
- Check desktop and mobile in a real browser, including anchor navigation,
  framework/reference tables, code overflow, and server-limit failure/retry.
- Update the frontend files served by the existing port 3211 process without
  restarting it. Preserve other work in this checkout, which has no Git repo.
- All temporary output and run evidence belongs under
  `/Volumes/Scratch/double-entitle/`. Remove task-owned temporary outputs after
  validation, keeping the live frontend build and short source documentation.

## Result

Implemented all sections and preserved existing deep links and license downloads.
The desktop contents menu stays visible while scrolling; mobile uses a native
collapsible menu. The public docs still load if server-limit retrieval fails.

99 focused UI, API-client and source-distribution tests passed. The docs module
has 100% lines, branches and functions under the existing seller UI suite.
Lint passed. The full build passed before concurrent deployment-mode work began;
its later shared-checkout type errors are outside this docs change. The final
frontend was built independently. Live browser checks passed at 320, 390, 580,
768, 850, 1024 and 1440 pixels, including mobile contents navigation, direct
section links, troubleshooting panels, limits failure/retry and a changed cap.
