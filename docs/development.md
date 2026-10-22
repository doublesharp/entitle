# Development

## Toolchain

Use the exact Node version in [`.node-version`](../.node-version), the pnpm
version in [`package.json`](../package.json), and the frozen
[`pnpm-lock.yaml`](../pnpm-lock.yaml). These are the repository's supported pins,
not claims about the latest upstream release. Rebuild native dependencies after
changing Node or the operating system.

TypeScript 7 is the sole application compiler and semantic checker. Strict
checking includes indexed access, exact optional properties and unused code.
Vue components use TypeScript render functions. ESLint's flat configuration uses
Babel for syntax rules; TypeScript checks semantics separately. The build does
not use `vue-tsc` or a second older TypeScript compiler. Treat changes to Vue SFC
or type-aware lint tooling as a compatibility change and verify their compiler
support before adopting them.

The optional source-built S3 fixture requires exactly Go 1.27.1. Set `GO_BINARY`
to that executable if it is not `/opt/homebrew/bin/go`. An existing private
S3-compatible service does not require Go. PHP and a JDK enable the corresponding
client-template tests; additional native toolchains are needed to qualify actual
signed desktop installations.

## Set up locally

Follow [Getting started](getting-started.md#run-the-local-fixture). Keep local
billing enabled only for disposable development. Its synthetic purchases do not
contact Stripe or establish real-payment qualification. Use the provided local
mail sink and private S3 fixture, or explicitly configure your own test services.

On the macOS workspace, `/Volumes/Scratch` must be mounted. The project default
is `/Volumes/Scratch/entitle`; build/cache/temp/evidence output belongs there.
The setup and S3 helpers intentionally require Scratch. Use the
[manual setup](getting-started.md#manual-setup) on other hosts.

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/` | Server, domain services and migrations |
| `web/` | Vue interfaces, shared API client, public copy and assets |
| `examples/` | Framework integrations, sample metadata and client licenses |
| `tests/` | Behavioral, security, migration, integration and property tests |
| `scripts/` | Build, coverage, local fixtures and native qualification helpers |
| `deploy/` | Production/test Compose configuration and HTTPS proxy settings |
| `docs/` | Maintained guides and reference |
| `.github/` | Contribution instructions and GitHub-specific files |

The root keeps the README, build/package/configuration entrypoints and canonical
license files. Put supporting material in its owning directory.

## Work on a change

```sh
pnpm typecheck
pnpm lint
pnpm test
BUILD_DIR=/Volumes/Scratch/entitle/build/development pnpm build
```

Use `pnpm dev` with a private `.env` for source execution. `pnpm start` runs the
built application; `BUILD_DIR` selects its output. Both serve API and frontend
from one process. Public names and the hosted link come from
[`src/site.ts`](../src/site.ts); runtime links use `PUBLIC_ORIGIN`.

Run relevant tests first, then the [coverage and integration checks](testing.md)
needed for the changed behavior. Preserve tenant boundaries and existing tests;
write a reproducing regression for a confirmed defect before fixing it.

## Source distributions

Every build produces `/legal/source.tar.gz` and browser dependency notices.
[`scripts/source-files.txt`](../scripts/source-files.txt) is an explicit allowlist,
not a directory dump. Add new project files and remove renamed/deleted paths.
Keep the packager's allowed roots and Docker COPY inputs aligned with the manifest.
The distribution test compares the real tree with the manifest and checks those
Docker inputs.

Never include `.env`, credentials, customer data, plugin release packages,
`node_modules`, screenshots or run logs in Git or the source package. Store
machine-generated evidence on Scratch. Keep documentation about how to verify
behavior; keep a particular run's counts, timestamps and provider results with
that run's evidence.

Contribution terms are in [`.github/CONTRIBUTING.md`](../.github/CONTRIBUTING.md).
