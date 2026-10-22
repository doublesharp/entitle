// Local fixture helper. Tenant publication key stays in a header and is never printed.
import { readFile } from 'node:fs/promises';
const [version, zip] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || !zip?.startsWith('/Volumes/Scratch/double-entitle-wp/')) {
  throw new Error('Usage: node --env-file=SCRATCH_ENV scripts/wordpress-publish.mjs VERSION SCRATCH_ZIP');
}
const origin = process.env.PUBLIC_ORIGIN;
const tenant=process.env.TENANT_SLUG, token=process.env.TENANT_API_KEY;
if (!origin || new URL(origin).hostname !== 'localhost' || !tenant || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tenant) || !token) throw new Error('Local origin and tenant publication credentials required');
const metadata = { changelog: `<p>Local WordPress integration ${version}</p>`, minWp: '6.0', minPhp: '7.4', minFree: '0.0.0', tested: '7.0' };
const response = await fetch(`${origin}/api/v1/tenants/${tenant}/seller/releases/double-entitle-example/${version}`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/zip', 'x-release-metadata': Buffer.from(JSON.stringify(metadata)).toString('base64url') }, body: await readFile(zip),
});
if (!response.ok) throw new Error(`Local release publication failed: HTTP ${response.status}`);
const result = await response.json();
console.log(JSON.stringify({ published: version, status: response.status, releaseId: result.id ?? result.release?.id }));
