# Coverage improvement plan

Target 100% (raised from the original 95% floor by the user) line, branch and function coverage for each application TypeScript module in `src/` and `web/`, with tests and declaration-only files outside the denominator. Include files never loaded by tests. Keep real external integrations separately identified.

1. Add behavior tests for Vue rendering and customer interactions, including loading, error, confirmation and session states. Exercise the real Vue components against a local DOM and controlled HTTP responses.
2. Exercise operator setup, inspection, revocation, reconciliation, job execution, upload validation, customer mutations and API failures through Fastify.
3. Expand Stripe SDK HTTP fixtures for event families, payment intents, invalid/empty provider responses, Portal and checkout variants. Exercise CLI commands and server startup/shutdown through testable entry functions, retaining actual process entry points.
4. Cover core billing conflict/retry paths, configuration variants, SQL dialect selection, outbox cancellation, activation edge cases, and malformed/corrupt release artifacts.
5. Add an automated coverage command and thresholds, run strict TS7/lint/build and the database regression matrix, document measured results, then remove disposable fixtures.

Tests must assert observable outcomes. Do not exclude difficult application modules, suppress coverage around ordinary branches, or remove validation to raise percentages. Any refactor needs existing behavior preserved and regression evidence. Bulky output and temporary data belong on Scratch.
