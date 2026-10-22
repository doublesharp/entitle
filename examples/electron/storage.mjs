/** @file Persist an installation UUID and an encrypted Electron activation token. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, unlink, link } from "node:fs/promises";
import { join } from "node:path";

/**
 * Create one storage adapter per tenant/product after app.whenReady(). Use a separate
 * directory for each adapter because its methods do not use the namespace argument
 * passed by the generic client. Serialize settings writes with an app instance lock.
 *
 * @param {string} directory Private directory within app.getPath('userData').
 * @param {import('electron').SafeStorage} safeStorage Electron's OS-backed encryption API.
 * @returns {import('../generic/client.mjs').UpdateStorage} Generic client storage adapter.
 */
export function electronStorage(directory, safeStorage) {
  const identity = join(directory, "installation-id");
  const secret = join(directory, "activation-token");
  return {
    /**
     * Publish a complete UUID atomically, or read the winner from another process.
     * @returns {Promise<string>} Persistent identity retained when a token is deleted.
     */
    async getOrCreateId() {
      // Step 1: create a private directory and a fully written candidate identity.
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // Link a fully written file so concurrent readers never observe a partial UUID.
      const candidate = join(directory, `installation-id-${randomUUID()}`);
      await writeFile(candidate, randomUUID(), { flag: "wx", mode: 0o600 });
      // Step 2: link without overwriting an existing identity, then remove the candidate.
      try {
        try {
          await link(candidate, identity);
        } catch (e) {
          if (e.code !== "EEXIST") throw e;
        }
      } finally {
        await unlink(candidate);
      }
      // Step 3: read the winning file and reject corruption instead of changing identity.
      const value = (await readFile(identity, "utf8")).trim();
      if (
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
          value,
        )
      )
        throw Error(
          "Invalid stored installation ID. Restore your app settings backup.",
        );
      return value;
    },
    /**
     * Decrypt the saved token, refusing unavailable or plaintext credential backends.
     * @returns {Promise<string | undefined>} Token, or undefined when no file exists.
     * @throws {Error} If secure storage is unavailable or decryption fails.
     */
    async getToken() {
      if (
        !safeStorage.isEncryptionAvailable() ||
        safeStorage.getSelectedStorageBackend?.() === "basic_text"
      )
        throw Error("Secure credential storage unavailable");
      try {
        return safeStorage.decryptString(await readFile(secret));
      } catch (e) {
        if (e.code === "ENOENT") return undefined;
        throw Error("Reconnect update license");
      }
    },
    /**
     * Encrypt a token before writing it, or delete its file after deactivation.
     * @param {string | undefined} token Activation token; undefined requests deletion.
     * @returns {Promise<void>} Resolves after the file operation succeeds.
     */
    async setToken(token) {
      if (token === undefined) {
        try {
          await unlink(secret);
        } catch (e) {
          if (e.code !== "ENOENT") throw e;
        }
        return;
      }
      if (
        !safeStorage.isEncryptionAvailable() ||
        safeStorage.getSelectedStorageBackend?.() === "basic_text"
      )
        throw Error("Secure credential storage unavailable");
      await writeFile(secret, safeStorage.encryptString(token), {
        mode: 0o600,
      });
    },
  };
}
