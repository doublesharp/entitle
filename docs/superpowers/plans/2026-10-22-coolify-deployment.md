# Entitle deployment implementation plan

The approved design is public source and CI, private production deployment,
independent frontend artifacts and server images, hosted at
`https://entitle.doublesharp.com` on the existing Coolify server.

## Constraints

- Build outputs, temporary data and evidence belong under `/Volumes/Scratch/entitle`.
- Preserve existing application behavior, same-origin authentication and security headers.
- PostgreSQL is authoritative. Redis is an optional cache and must fail safely.
- Public CI contains no host, Coolify, database, SMTP or Stripe credentials.
- Production promotion verifies source commit, successful CI and immutable output identities.
- Preserve source distributions, licenses and third-party notices.
- Use shared PostgreSQL with a dedicated database/role and dedicated memory-limited Redis.

## 1. Independent builds

- [x] Separate server/frontend dependency and build targets in a pnpm workspace.
- [x] Add regression coverage for independent build outputs and dependency boundaries.
- [x] Preserve root development, CLI, typecheck, lint, test and combined build commands.
- [x] Build server and frontend independently; run the existing suite.

## 2. Static publication

- [x] Add a portable manifest-based frontend pack/verify/activate tool.
- [x] Test checksums, unsafe files, failed publication, atomic activation, previous assets and rollback.
- [x] Add a stable unprivileged Nginx runtime serving immutable releases and proxying `/api/`.
- [x] Verify headers, frontend navigation and API routing with real local HTTP requests.

## 3. GitHub delivery

- [x] Add public CI with dependency and BuildKit caching and affected-target detection.
- [ ] Publish immutable frontend artifacts, server images and runtime images.
- [x] Create private deployment repository with verified dispatch/promotion and serialized release activation.
- [x] Review source/history and source distribution before making the source repository public.

## 4. Host resources and deployment

- [x] Provision the Entitle PostgreSQL database/role and dedicated Redis cache.
- [ ] Register Coolify resources, persistent paths, secrets, health checks and backups.
- [ ] Configure DNS, trigger GitHub delivery, and deploy the exact verified outputs.
- [ ] Verify public HTTPS, frontend routes, API readiness, PostgreSQL and Redis access.
- [ ] Demonstrate a frontend-only publication without changing backend image or container.

Production requires genuine Stripe, SMTP and private S3 credentials. Missing credentials
are a deployment blocker; preserve production validation instead of inserting fixtures.
