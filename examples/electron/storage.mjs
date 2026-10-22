import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, unlink, link } from "node:fs/promises";
import { join } from "node:path";

// Create one instance per configured tenant/product, after app.whenReady().
export function electronStorage(directory, safeStorage) {
  const identity = join(directory, "installation-id");
  const secret = join(directory, "activation-token");
  return {
    async getOrCreateId() {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // Link a fully written file so concurrent readers never observe a partial UUID.
      const candidate = join(directory, `installation-id-${randomUUID()}`);
      await writeFile(candidate, randomUUID(), { flag: "wx", mode: 0o600 });
      try {
        try {
          await link(candidate, identity);
        } catch (e) {
          if (e.code !== "EEXIST") throw e;
        }
      } finally {
        await unlink(candidate);
      }
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
