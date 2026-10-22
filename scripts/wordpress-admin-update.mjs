// Exercise WordPress's real authenticated browser AJAX updater against the local fixture.
import { mkdirSync, writeFileSync } from 'node:fs';
const origin = 'http://localhost:8088';
const jar = new Map();
async function request(path, options = {}) {
  const response = await fetch(origin + path, { ...options, redirect: 'manual', headers: { ...options.headers, Cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') } });
  for (const cookie of response.headers.getSetCookie()) {
    const first = cookie.split(';', 1)[0];
    const split = first.indexOf('=');
    jar.set(first.slice(0, split), first.slice(split + 1));
  }
  return response;
}
await request('/wp-login.php');
const password = process.env.ENTITLE_WP_ADMIN_PASSWORD ?? 'local-entitle-admin-only';
const login = await request('/wp-login.php', { method: 'POST', body: new URLSearchParams({ log: 'admin', pwd: password, 'wp-submit': 'Log In', testcookie: '1', redirect_to: origin + '/wp-admin/plugins.php' }) });
if (login.status !== 302 || ![...jar.keys()].some(name => name.startsWith('wordpress_logged_in_'))) throw new Error('Local WordPress browser login failed');
const page = await request('/wp-admin/plugins.php');
const html = await page.text();
const settings = html.match(/var _wpUpdatesSettings = (.+);/);
if (!settings) throw new Error('Admin plugins page did not contain WordPress update nonce settings');
const nonce = JSON.parse(settings[1]).ajax_nonce;
if (!nonce) throw new Error('Admin plugins page did not supply update nonce');
const response = await request('/wp-admin/admin-ajax.php', { method: 'POST', body: new URLSearchParams({ action: 'update-plugin', _ajax_nonce: nonce, plugin: 'entitle-example/entitle-example.php', slug: 'entitle-example' }) });
const result = await response.json();
if (!response.ok || !result.success) throw new Error(`Real admin AJAX update failed: HTTP ${response.status}; code ${String(result.data?.errorCode ?? 'unknown')}`);
const summary = { path: 'authenticated admin-ajax.php update-plugin', success: true, oldVersion: result.data?.oldVersion, newVersion: result.data?.newVersion };
const output = JSON.stringify(summary) + '\n';
const reports = process.env.WORDPRESS_REPORT_DIR ?? '/Volumes/Scratch/entitle/reports/wordpress';
if (!reports.startsWith('/Volumes/Scratch/entitle/reports/')) throw new Error('WordPress reports must remain on project Scratch storage');
mkdirSync(reports, { recursive: true });
writeFileSync(`${reports}/admin-ajax.log`, output, { mode: 0o600 });
process.stdout.write(output);
