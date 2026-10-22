# Admin readability and layout pass

User requested a clearer, less cluttered admin interface and generic software licensing/update positioning with first-class WordPress support. Routine design decisions are authorized by the project brief. Preserve the green/neutral brand, API contracts, scope, security confirmations and customer functionality.

Use a desktop sidebar and focused sections for Overview, Products, Releases, Client setup, Licenses, API keys and Billing. On narrow screens navigation wraps into a readable grid. Keep form state when switching sections, disable navigation during pending mutations and reset the selected section when changing workspaces/signing out. A compact workspace selector replaces the full-width workspace panel; put new-workspace creation behind a disclosure. All server authority remains unchanged.

Overview emphasizes four useful metrics and places detailed counts in a disclosure. Retain all exact values and separate currency totals. Product/release/key creation forms use explicit disclosures while existing records remain easy to scan. Use calmer secondary actions, consistent spacing, accessible focus, horizontally contained tables and readable wrapping for identifiers. Keep sign-in narrow and centered. Public headline becomes Software licensing and updates, with a clear first-class WordPress description.

Implementation and verification:

1. Add failing interaction tests for navigation visibility, retained form state, workspace/session reset, pending actions and disclosures; update the existing public positioning assertion.
2. Update web/site.ts and scoped web/style.css without adding dependencies or backend changes. The directory has no Git repository, so preserve an exact task-owned baseline under Scratch instead of creating a worktree.
3. Run seller/buyer/checkout regressions, TS7/lint/build, retain 100% coverage per executable module, inspect the actual browser at desktop/mobile widths and record findings on Scratch.


Implementation and final browser checks are complete. All 501 tests passed with
100% lines, branches and functions in each of 40 application modules. TS7, lint
and the production build passed. Opus 5.5 accepted round 2 after the first-time
seller empty-state and recovery/refresh heading fixes. The actual built app was
checked at desktop/mobile widths, including real first-time seller email login.
See [verification](verification.md) and the Scratch admin-style report directory.
