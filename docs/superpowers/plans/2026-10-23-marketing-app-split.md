# Marketing and application split

The hosted site keeps marketing and public documentation at `/`. Seller and buyer accounts live at `/app/`. API endpoints remain under `/api/`. Self-hosted builds contain only the application and its local documentation. A later domain move changes the configured application URL and mount, rather than application structure.

## Build and routing contracts

- `build:web` produces the standalone app in `BUILD_DIR/web`, default mount `/`.
- `build:marketing` produces static marketing in `BUILD_DIR/marketing`, with `WEB_APP_URL` as its dashboard destination.
- `build:hosted-web` independently builds both, builds the app for `WEB_APP_BASE_PATH=/app`, and assembles `BUILD_DIR/hosted-web`. It merges immutable assets and keeps app shells under `app/`.
- Public CI publishes standalone, marketing, and hosted artifacts separately. Private promotion prefers the hosted artifact while retaining verified legacy artifact fallback for rollback.
- `APP_BASE_PATH` controls generated login, verification, checkout, and portal URLs; it defaults to `/app` in hosted mode and empty in standalone mode. `PUBLIC_ORIGIN` remains an origin used for CSRF checks and API links.
- The runtime serves `/app/` from the nested app shells. Legacy account routes redirect only when the hosted app is present. Standalone artifacts open the dashboard at `/` and do not load marketing.
- Marketing does not load customer, seller, or payment UI. Its documentation remains static; live deployment limits are available in app documentation.

## Implementation and acceptance

1. Extract marketing from seller code, add explicit app and marketing entry points, and split scoped marketing styles.
2. Add shared validated path helpers and prefix every app-generated account/checkout link without changing API paths.
3. Add independent build targets, artifact assembly, source/license packaging, CI publishing and retention-compatible asset routing.
4. Test root and `/app` mounting, configurable URLs, isolated bundles, redirects with query/fragment context, login/checkout, static headers, and production HTML.
5. Run application tests, strict typing/lint/build checks and an independent review. Commit and merge public and private changes through required CI.
6. Promote verified source artifacts with the existing serialized private workflow, verify public marketing/app pages and API readiness, and preserve a usable rollback receipt.

Production configuration, secrets, host access, and promotion receipts remain in the private deployment repository. Disposable output and verification evidence stay on Scratch.
