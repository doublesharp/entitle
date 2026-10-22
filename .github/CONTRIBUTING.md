# Contributing

The service, web interfaces and repository infrastructure use Elastic License
2.0 plus the Publisher Use Permission in ADDITIONAL-PERMISSION.md. First-party
client adapters use MIT; generated client integration snippets also have a
Zero-Clause BSD grant.

Do not submit third-party code contributions for incorporation into the
service until a separate written contributor agreement has been signed with
Justin Silver. The agreement must establish the contributor's authority and
grant the rights needed to use, modify, distribute, sublicense, offer hosted
services and license the contribution under commercial or future terms.
Receiving a patch or publishing a fork does not itself grant those rights.
Until that process is in place, report problems and discuss proposed changes
without contributing service code. MIT adapter contributions may be submitted
under inbound-equals-outbound MIT terms, with an explicit statement that the
contributor has authority to license the contribution under MIT. This does not
open the service contribution process described above.
Preserve all copyright and third-party notices.

Use the pinned Node/pnpm versions, retain strict checking and the per-module
100% coverage gate, and use disposable external-service fixtures described in
the README. Never include credentials, customer data, release packages or run
evidence in a contribution. Update scripts/source-files.txt when adding source
files so build distributions include the complete reviewed source.
