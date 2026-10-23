# Blue/green deployment design

Approved by the owner on 2026-10-23, including production activation after verification.

Keep immutable frontend publication and exact successful source-run verification. Run two independently managed API slots behind a stable internal router. Warm and probe the inactive slot before switching; drain the previous slot and retain its digest for rollback. A dedicated worker service runs background jobs, with the old worker stopped and verified exited before its replacement starts. API slots never run jobs or apply migrations.

Server roles are `all` (legacy default), `api`, `worker`, and `migrate`. API and worker startup verify that all bundled migrations are already applied; explicit migration execution uses the migrate role. Automatic blue/green promotion requires identical migration fingerprints to the healthy deployment. Schema changes require an explicit maintenance migration procedure and matching backup, never automatic down migrations.

The stable router reads an atomically replaced, validated slot file from a read-only parent mount. It reloads gracefully, exposes the selected slot for bounded observation, and retains the last working configuration when candidate validation fails. Production promotion verifies candidate readiness, worker handoff, routed slot identity, public smoke checks and final observed digests before publishing the healthy receipt. Failure restores the previous route, frontend and worker where safe; uncertain state fails closed and remains observable.

CI builds images concurrently with checks, but release publication and reusable input tags remain gated on checks. Tests retain full coverage with independent shards and isolated Scratch directories. Existing dependency and BuildKit caching remain. The measured baseline is source run 39937185893: 4m40s overall, 2m31s checks, then 57s image build. Promotion run 39937764691 took 1m38s. The frontend build took one second, so redundant packaging is not the first optimization.

All disposable files, dependency stores and evidence belong on mounted /Volumes/Scratch. No secrets or run evidence enter Git. Source checks, container integration and production acceptance are separate gates.
