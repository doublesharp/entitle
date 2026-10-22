# Toolchain verification

Verified on 2026-10-20 using Node's release index and npm registry metadata, then installed and executed locally.

| Component  | Pin     | Verification                                                                                                         |
| ---------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| Node.js    | 26.12.0 | Current stable release from `https://nodejs.org/dist/index.json`; downloaded arm64 archive matched published SHA-256 |
| pnpm       | 12.14.0 | Registry latest; install and frozen lockfile supported                                                               |
| TypeScript | 7.0.2   | Stable `typescript` package; actual `tsc --version` prints 7.0.2                                                     |
| Fastify    | 5.12.7  | Installed server and inject tests                                                                                    |
| Vue        | 3.5.44  | Production bundle and browser checks                                                                                 |
| Vite       | 8.3.4   | Production bundle on Node 26                                                                                         |
| ESLint     | 10.13.0 | Flat configuration with Babel 8 syntax parser                                                                        |
| Knex       | 3.3.0   | Real SQLite/PostgreSQL/MySQL migrations and shared tests                                                             |
| Stripe SDK | 23.0.0  | API version pinned to `2026-09-30.endive`; SDK exercised against a local HTTP fixture                                |

TypeScript 7 is the application compiler and checker. No TypeScript 5/6 compiler or preview compiler is substituted. All application TypeScript uses strict checking, unchecked indexed-access checks, exact optional properties and unused-code checks. Vite transpiles the browser entry; the separate TS7 check covers it before builds.

The compatibility issue is the former JavaScript compiler API. TypeScript 7.0 does not provide the old API used by tools such as typescript-eslint and vue-tsc. The published typescript-eslint support range is `>=4.8.4 <6.1.0`. Installing it with TS7 and ignoring the warning would conceal that mismatch.

The resolution here is plain TypeScript Vue render components, rather than single-file components requiring vue-tsc, and ESLint's flat configuration using Babel's TypeScript syntax parser. ESLint supplies syntax/control-flow rules; TS7 supplies semantic and unused-code checks. This keeps the requested compiler and avoids a second older compiler. Revisit SFC/type-aware lint support when the tools officially support the native compiler API. Babel and all other dependencies are pinned in package.json and pnpm-lock.yaml.

Primary references: [Node current release](https://nodejs.org/en/download/current), [TypeScript 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/), [typescript-eslint supported dependencies](https://typescript-eslint.io/users/dependency-versions/), [Vue TypeScript tooling](https://vuejs.org/guide/typescript/overview.html), [Vite getting started](https://vite.dev/guide/).

The optional native MinIO fixture in `scripts/local-s3.ts` requires exactly **Go 1.27.1**. The fixture defaults to `/opt/homebrew/bin/go`; set `GO_BINARY` to the Go 1.27.1 executable when it is elsewhere. Using an existing S3-compatible service through the [manual setup](getting-started.md#run-the-local-fixture) needs no Go installation.
