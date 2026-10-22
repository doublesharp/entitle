# Generic update client

Copy `client.mjs` into the application. Supply an HTTPS tenant API URL such as
`https://licenses.example.com/api/v1/tenants/publisher`, a product slug and a
storage object. `getOrCreateId(namespace)` must atomically create and persist a
random UUID, using the existing winner if another process creates it first.
`getToken(namespace)` and `setToken(value, namespace)` use the platform credential
vault. Delete a token when value is undefined. Never store the buyer's license key.
Keep the UUID when deactivating or upgrading. Do not derive it from hardware.

```js
import { createClient } from './client.mjs';
const updates = await createClient({ api, product: 'my-app', storage });
await updates.activate(licenseKeyFromSettings, 'Work laptop');
const status = await updates.status();
const release = await updates.updates('linux-x64', installedVersion);
if (release) {
  const response = await updates.download(release.assets[0].url);
  // Write to the app's staging area, verify release.assets[0].sha256, then
  // hand the file to the application's signed-package installer after consent.
}
await updates.deactivate();
```

For products explicitly configured as site activations, pass the real `siteUrl`.
All other installations submit only the persistent UUID and optional label.
Display caught error messages in update settings. An expired license or service
failure affects update downloads only. Installed functionality continues.

Generic metadata has no universal install protocol. Integrators must implement
their own trusted installer, rollback and staging; SHA-256 alone does not
authenticate software publishers. Keep signing keys in the build system.
The server accepts only bundles within its configured upload limit, 25 MiB by
default and at most 100 MiB.

Qualification: lifecycle, request authentication, credential scoping, malformed
responses and error handling execute in Node tests against in-memory HTTP
responses. No operating-system installation is claimed.
