# Documentation

Doublesharp Entitle sells annual software licenses and delivers private updates.
The same application runs as a standalone publisher installation or a hosted
platform. Start with the workflow you need. The public `/docs` guide also ships
in the application and requires no account.

## Start selling

- [Getting started](getting-started.md): choose a deployment, run locally, and
  complete your first purchase, activation and update.
- [Seller guide](seller-guide.md): products, annual plans, immutable releases,
  customer support, account security, sandboxes and tax settings.
- [Hosted tiers and fees](hosted-pricing.md): platform subscriptions, application
  fees, Pro access, renewals and refunds.

## Integrate your software

- [Client integration](client-integration.md): credentials, stable installation
  IDs, activation, update checks, downloads and failure handling.
- [Framework support](platform-support.md): seven adapters, exact targets and
  package requirements, with links to client examples.
- [WordPress integration](wordpress.md): the PHP updater and recorded real
  WordPress qualification.
- [API v1](api.md): route tables, authentication, scopes and request formats.
- [CLI reference](cli.md): publisher automation, publication and reconciliation.
- [Outgoing webhooks](webhooks.md): event contracts, signature verification,
  deduplication, retries and secret rotation.

## Run the service

- [Deployment](deployment.md): standalone and hosted production infrastructure,
  Stripe endpoints, private storage, upgrades and transfer budgets.
- [Configuration reference](configuration.md): environment variables, defaults,
  validation rules and capacity relationships.
- [Backup and restore](backup.md): consistent database, object and secret backups.
- [Publisher portability](portability.md): encrypted exports and migration to a
  fresh standalone installation.
- [Offline operator maintenance](operator-maintenance.md): import/finalize and
  reviewed customer closure commands.
- [Troubleshooting](troubleshooting.md): diagnose authentication, billing,
  activation, publication, delivery and infrastructure failures.

## Develop and qualify changes

- [Contributing](../CONTRIBUTING.md) and [toolchain](toolchain.md): contribution
  terms, pinned tools and local development constraints.
- [Verification](verification.md): recorded checks and runtime qualification
  limits. These results describe their recorded runs, not every deployment.
- [Coverage](coverage.md) and [invariant testing](invariant-testing.md): the
  per-module coverage gate, generated operation sequences and replay.
- [Branding](branding.md) and [license review](license-review.md): project naming
  and the source/client licensing split.

Design and plan files in this directory record implementation decisions. Use the
task guides above for current instructions and source code for exact behavior.
A plan is not evidence that a deployment or external integration passed.

## Terms used throughout these guides

| Term                  | Meaning                                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| Workspace / tenant    | A publisher's isolated products, customers and releases. Public URLs use its immutable slug.   |
| Product               | One application or extension, with a framework-specific identity.                              |
| Plan                  | An annual Stripe price mapped to an installation allowance for a product.                      |
| License               | A customer's product rights, paid periods and installation allowance.                          |
| Installation          | A site or device registered to a license, with its own activation token.                       |
| Release / asset       | An immutable software version and its package bytes. Native releases can have several targets. |
| Entitlement           | Whether current paid rights and restrictions permit a download now.                            |
| Platform subscription | A hosted publisher's service subscription, separate from buyer licenses.                       |

Use the origin of your deployment in examples. `primary` is the default standalone
workspace slug; a portability import can preserve a different public slug. The
operator's internal tenant IDs and public slugs are different identifiers.
