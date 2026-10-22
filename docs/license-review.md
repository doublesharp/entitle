# License change review

The owner confirmed on 2026-10-21 that Justin Silver owns the rights needed to
relicense this code and no AGPL version was shared or deployed. This records
the owner's confirmation, not an independently established chain of title.
If that changes, preserve any previously granted AGPL rights and resolve
third-party ownership before releasing.

Opus reviewed ELv2 and the publisher-use boundary against the primary license
texts. The implementation uses unmodified ELv2 and a separate versioned grant
that only adds rights. It explicitly permits buyer portals, checkout,
activation, updates, downloads, publisher license changes, branding changes,
forks and security fixes. Agency work for client-owned products is explicitly
excluded from the agency's own software, and ordinary affiliate fees and
exclusive licensing with royalties remain allowed. Contractor administration is limited to infrastructure
and hosting accounts controlled by the publisher. Client adapters retain MIT licensing; generated client integration snippets
also have an attribution-free Zero-Clause BSD grant.

ELv2 restricts hosted/managed access to a substantial set of features. It is not
a blanket prohibition on every competing business or an independently written
replacement implementation. A small hosted subset may not meet that threshold.
The additional permission cannot narrow ELv2's existing rights. Source is
available for inspection; describing these restricted terms as OSI open source
would be inaccurate. Deployment flags select operation, not legal permission.

No new third-party service contributions may be accepted before a separate
written contributor agreement grants rights needed for hosted operation and
commercial/relicensing uses. CONTRIBUTING.md records that policy; it is not a
completed contributor agreement.

Before public release, qualified counsel should review the Your Software
definition, contractors, substantial-set threshold, license-key carve-out,
branding/notices, authorship and enforceability. Opus's review is engineering
analysis, not a legal opinion or a guarantee that competition is prevented.
The installed dependency license inventory and built browser notices must also
be checked. AGPL MinIO is an external development fixture, never included in
the application image or source archive.

The installed inventory checked during this change contains 322 packages and
no declared GPL, AGPL, SSPL or BUSL dependencies. Two MPL-2.0 packages,
lightningcss and lightningcss-darwin-arm64, are Vite build tools, not code copied
into the browser application. One package uses CC-BY-4.0 data; third-party
license/attribution terms remain applicable. This is a metadata inventory,
not proof that every upstream file's license or authorship is correct.

A second Opus review accepted the local implementation, then identified agency
ownership, royalties/affiliate fees, UI notice removal, generated snippet
attribution, plain distribution, precedence and permission duration ambiguities
that were resolved in the local terms. The software license is not hosted
seller terms: those must separately cover application fees, refunds, privacy
and data processing before a public hosted launch.

The final Opus recheck accepted the corrected local text with no blockers.
Two optional wording clarifications were also applied: contributor terms refer
to CONTRIBUTING.md's separate service/adapter paths, and the Zero-Clause BSD
grant expressly describes generated client output. Counsel review is still
required before treating the terms as ready for public release.
