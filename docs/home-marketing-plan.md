# Marketing home and public docs

The user requested a more graphical home page, then clarified that it should
explain the product through marketing and sales and lead visitors to sign up.
The screenshot's practical limits and guided setup belong in a separate docs
section. Routine design decisions remain authorized by the original project brief.

Use a product-led narrative with an illustrated purchase/license/update journey,
a clear developer audience, benefit-led feature cards, supported-framework
badges and a first-class WordPress feature panel. Keep the existing green brand
with richer mint, lime and dark-green panels. Repeat the real /seller workspace
entry action at the top and bottom. A secondary action explains how it works.
Do not add invented testimonials, customer counts, traffic metrics, guarantees
or unapproved pricing. All illustrative data must be labelled as an example.

Compared with a purely decorative hero or a dense dashboard screenshot, a
lightweight workflow illustration explains what the app does to a first-time
visitor. Prefer native HTML/CSS and outline SVG, with no dependencies, fonts,
analytics, raster downloads or animation requirement. Preserve accessibility,
responsive layouts, actual signup flow, tenant boundaries and customer APIs.

Add /docs and /docs/ with direct HTTP shell routes and shared navigation.
Move practical limits, the three setup steps, billing caveats and detailed native
adapter qualification to that page. The public home requires no API fetch;
only docs fetches public server limits with the existing error/retry behavior.
Docs links must reach real sections, not pretend to expose repository Markdown.

Implementation:

1. Update public UI tests to require signup/docs navigation, a labelled example
   workflow and no limits/private requests on home. Verify that docs and its
   trailing-slash route show the setup guide and real server limits, including
   retry after a failed request. Extend actual server shell route checks. Run
   these tests red before changing source.
2. Update web/site.ts public rendering and scoped CSS; add /docs routes in
   src/app.ts. Keep seller and buyer behavior unchanged. No Git repository is
   present, so exact task-owned source baselines are retained on Scratch.
3. Run focused tests, strict TS7, ESLint and build. Visually check actual
   home/docs at desktop/mobile, verify links and bounds. Run the full actual
   database/S3/PHP coverage gate at 100% per executable module. Freeze hashes,
   obtain the standing Opus 5.5 read-only review and resolve verified findings.
4. Record results and integration limits in the verification docs, keeping raw
   output on Scratch. Do not deploy or charge anyone.

Completed with 503 tests passing, no failures/skips and 100% lines, branches and
functions in all 40 application modules. Strict TS7, lint and production build
passed. Opus 5.5 accepted both rounds. Technical content moved to public /docs;
marketing/signup links and supported claims were verified. See
[verification](verification.md) for exact evidence and browser/integration limits.
