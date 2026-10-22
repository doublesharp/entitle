# Framework adapter implementation plan

Execute the user's adapter implementation request continuously using
[framework-adapters-design.md](framework-adapters-design.md). No Git repository
exists; preserve the shared checkout and use disjoint file ownership. Do not touch
the Validated Field repository, existing environment files or production services.

1. Schema/publication worker owns `src/db.ts`, migration007, `src/frameworks.ts`,
   `src/artifacts.ts`, package validation helpers, focused `src/releases.ts`
   integration, and new framework schema/publication tests. Reproduce missing
   schema, type validation, immutable multi-target publication and unsafe package
   failures first. Implement the contracts in the design. Retain MySQL resumable
   migrations and prove real-engine constraints/quotas. Reach per-owned-module100%.
2. Protocol/client worker owns `src/update-adapters.ts`, new framework examples
   excluding existing WordPress, and new renderer/template tests. Implement native
   XML/YAML/JSON formats from official docs and scoped credential handling. Keep
   package signatures in the seller's build system. Verify current dependencies,
   templates and supported upstream interfaces. Reach renderer100% and distinguish
   source/template tests from actual runtime integrations.
3. UI worker owns `web/*` except shared API test helpers outside web, and existing
   UI tests. Add product framework selection, specific config/targets/signatures,
   multi-target download selection, device labels and setup snippets using the
   design's endpoints. Preserve Elements/security fixes and relative API links.
   Add failing interaction tests, then implement and reach web100%.
4. Root owns HTTP integration, device activation, CLI, security admission, docs and
   new API tests. Integrate strict product DTOs/config immutability, release-assets
   upload authentication/memory admission, feed access/current versions, range/HEAD
   and buyer downloads. Preserve billing and prior review fixes. Add red/green
   security and API regressions, including actual engine fixtures.
5. Freeze source after focused checks. Run full TS7/lint/build, all suites and the
   100% per-module gate with real PG/MySQL/S3 enabled. Exercise local browser and
   available native clients; record unavailable desktop code-signing/install paths.
   Fix bugs demonstrated by tests, update documentation and prepare source hashes.
6. Request fresh Opus5.5 whole-system review with original SaaS requirements, prior
   review findings/responses, adapter design and frozen verification receipts.
   Fix verified blockers and repeat affected gates. No deployment/live charges.

Progress: schema/publication, HTTP APIs, native renderers/client templates,
device activation, CLI and UI are implemented. Focused checks passed, including
real SQLite/PostgreSQL/MySQL API cases and native Joomla update installation.
Review regressions corrected Sparkle API usage, Joomla activation persistence and
native details discovery, Electron ARM filenames and YAML control characters.
Final whole-system verification passed495tests with no failures/skips and100%
coverage in all40 application modules. Opus5.5 round3 accepted the source and its
full-gate/hash conditions were met. Native Joomla, WordPress, private S3 restore
and production-mode Docker checks passed within their documented limits.
The project folder is now `double-entitle`; Scratch paths retain
the existing `double-entitle-wp` prefix to preserve shared caches and evidence.
