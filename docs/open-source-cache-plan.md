# Historical licensing plan and optional adaptive caching

The AGPL decision below was superseded by the authorized source-available
license change in [license-review.md](license-review.md). Cache requirements
remain applicable.

Approved by the user: AGPL-3.0 for the service/dashboard and MIT for our client
adapters/examples. Use the exact SPDX identifier AGPL-3.0-only. The project is
not being published to a remote repository. Preserve third-party notices.

The licensing boundary is root LICENSE/NOTICE and examples/LICENSE, plus license
copies in distributable adapter directories. Keep npm private=true to prevent
accidental package publication. Built distributions provide license texts,
third-party notices and a source download from a safe explicit source manifest;
never package .env, .npmrc, caches, reports, release storage or credentials. Link
source/license information in the public docs and both account interfaces.

The user also requested adaptive-cache and optional Redis. Use the published
@0xdoublesharp/adaptive-cache0.1.1, not the unrelated unpublished0.2.0 local tree.
Node>=22 and Fastify5 are compatible with pinned Node26/Fastify5. Exact peers:
@0xdoublesharp/lru-cache-clustered2.1.2 and lru-cache11.5.3. Do not modify that
library's workspace. Default is bounded host-memory caching, with optional
CACHE_REDIS_URL enabling Redis-backed caching. Redis is never required.

Cache annual Stripe price-picker data to avoid repeated provider pagination,
and pure framework feed formatting keyed by the complete freshly authorized
input. Keys include tenant and scope; price keys include connected account and
live/test mode. Authorization, license entitlement, subscription/payment state,
revocation/suspension, fresh release selection, withdrawal and download integrity
remain uncached. No HTTP response-cache middleware, package bytes or stale/error
serving. Fail back to the underlying read once when the cache fails. Close cache
and any owned Redis connection during application shutdown. Keep Redis secrets
out of logs and require only operator-provided environment configuration.

Write failing isolation/coalescing/fallback tests before source implementation.
Verify real Redis hit/recovery behavior in an isolated loopback fixture, alongside
Redis-free tests. Run strict TypeScript7, lint, build, source-package leak checks,
full real DB/S3/PHP100% per-module coverage and a read-only Opus5.5 review. Leave
local fixtures intact, and report any untested external integration.

The optional-Redis shutdown test exposed an offline Pub/Sub subscriber leak in
the published0.1.1 L1 mode. Use the simpler Redis-only backend when configured;
keep bounded clustered-LRU for the default. Do not patch the other library repo.
The service owns and disconnects its only Redis client. The unpublished local
0.2.0 tree is not silently substituted for the registry package.


## Adaptive-cache 0.2.1 upgrade

The user explicitly requested the published 0.2.1 release, superseding the
0.1.1 pin above. Keep the existing LRU 2.1.2 peer and Redis-only price backend;
feed caches remain in process. Use the `adaptive-v2:` key namespace recommended
for upgrades across 0.2.0's cache-format boundary. Test helpers now pass the
loader AbortSignal. A subprocess regression must prove the affected L1 Redis
shutdown path releases its internal subscriber with Redis unreachable, while
caller-owned Redis connections remain the caller's responsibility. No changes
to either library repository are part of this dependency upgrade.
