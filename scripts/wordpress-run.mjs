// Secret-safe local runner. --activate uses the newest license email in local Mailpit.
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { site } from '../src/site.ts';
const [mode, activate] = process.argv.slice(2);
if (!['check', 'manual', 'native', 'automatic', 'outage', 'deactivate'].includes(mode) || (activate && activate !== '--activate')) throw new Error('Use check|manual|native|automatic|outage|deactivate [--activate]');
const env = { ...process.env };
if (activate) {
  const inbox = await (await fetch('http://localhost:8025/api/v1/messages')).json();
  const message = inbox.messages.find(m => [
    `Your ${site.name} license key`,
    'Your Double Entitle license key',
  ].includes(m.Subject) && m.To.some(to => to.Address === 'demo@example.test'));
  if (!message) throw new Error('No local demo license key email');
  const body = await (await fetch(`http://localhost:8025/api/v1/message/${message.ID}`)).json();
  const key = body.Text.match(/Your license key is ([A-Za-z0-9_-]+)/)?.[1];
  if (!key) throw new Error('Local email did not contain expected key format');
  env.DOUBLE_ENTITLE_TEST_KEY = key;
}
const wrapper = fileURLToPath(new URL('./wordpress-cli.sh', import.meta.url));
const command = mode === 'native' ? ['--user=admin', 'plugin', 'update', 'double-entitle-example'] : ['--user=admin', 'eval-file', '/workspace/scripts/wordpress-integration.php', mode];
const result = spawnSync(wrapper, command, { env, encoding: 'utf8' });
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
// Credentials must never appear in saved evidence, even when a subprocess fails.
if (env.DOUBLE_ENTITLE_TEST_KEY && output.includes(env.DOUBLE_ENTITLE_TEST_KEY)) throw new Error('Subprocess emitted a license credential; output suppressed');
const reports = process.env.WORDPRESS_REPORT_DIR ?? '/Volumes/Scratch/double-entitle-wp/reports/wordpress';
if (!reports.startsWith('/Volumes/Scratch/double-entitle-wp/reports/')) throw new Error('WordPress reports must remain on project Scratch storage');
mkdirSync(reports, { recursive: true });
writeFileSync(`${reports}/${mode}.log`, output, { mode: 0o600 });
process.stdout.write(output);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
