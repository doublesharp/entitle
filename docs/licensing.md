# Licensing and contributions

The canonical terms are the files linked below. Preserve them with distributions;
this guide does not replace or expand their permissions.

| Material | Terms |
| --- | --- |
| Service and dashboard | [Elastic License 2.0](../LICENSE) plus the [Doublesharp Entitle Publisher Use Permission](../ADDITIONAL-PERMISSION.md) |
| Client adapters and examples | [MIT](../examples/LICENSE), with per-adapter copies |
| Generated integration snippets | The additional [Zero-Clause BSD grant](../examples/GENERATED-CODE-LICENSE) |
| Dependencies | Their own licenses and notices; see [NOTICE](../NOTICE) and built browser notices |

Describe the service as **source available**. Its restrictions mean it should not
be advertised as OSI open source. Read the publisher permission before self-hosting,
modifying, redistributing or providing a service to other publishers. Deployment
mode flags configure the application; they do not grant license rights.

## Distributing a build

Keep copyright, license and third-party notices. The build creates
`/legal/source.tar.gz`, license text downloads and `THIRD-PARTY.txt` for browser
modules. Its explicit source allowlist excludes private configuration, customer
records and release artifacts. See [development](development.md#source-distributions)
for updating packaging when files move.

The external MinIO development fixture is not part of the application image or
source archive. Review the licenses of the infrastructure and dependencies you
actually deploy; a package metadata scan does not establish every file's authorship.

## Contributions and hosted operation

Follow [the contribution policy](../.github/CONTRIBUTING.md). Service contributions
and MIT adapter contributions have separate paths. Do not treat receiving a patch
as a signed contributor agreement or permission to relicense it.

A software license is separate from hosted seller terms, privacy/data-processing
terms, fees and refund policies. Obtain appropriate review for your intended
operation and distribution. Engineering tests and code reviews do not establish
legal enforceability or ownership of third-party contributions.
