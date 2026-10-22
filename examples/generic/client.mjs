// An update client, never an application feature gate. No license keys are retained.
export async function createClient({
  api,
  product,
  storage,
  fetcher = fetch,
  siteUrl,
}) {
  const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const origin = new URL(api);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    !/^\/api\/v1\/tenants\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(origin.pathname) ||
    !slug.test(product)
  ) {
    throw Error("Invalid licensing configuration");
  }
  const installationId = await storage.getOrCreateId(`${api}|${product}`);
  async function token() {
    const value = await storage.getToken(`${api}|${product}`);
    if (!value || !/^[A-Za-z0-9_-]{1,1024}$/.test(value))
      throw Error("Activate updates first.");
    return value;
  }
  function trusted(url) {
    try {
      const u = new URL(url);
      return (
        u.protocol === "https:" &&
        u.origin === origin.origin &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        (new RegExp(
          `^${origin.pathname}/packages/${product}/assets/[A-Za-z0-9-]+/[^/%?#]+$`,
        ).test(u.pathname) ||
          new RegExp(
            `^${origin.pathname}/updates/generic/${product}/[A-Za-z0-9_-]+$`,
          ).test(u.pathname))
      );
    } catch {
      return false;
    }
  }
  async function request(
    url,
    { method = "GET", body, authenticated = true, raw = false } = {},
  ) {
    const headers = {
      Accept: raw ? "application/octet-stream" : "application/json",
    };
    if (authenticated) headers.Authorization = `Bearer ${await token()}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response;
    try {
      response = await fetcher(url, {
        method,
        headers,
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(30000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw Error("Licensing service unavailable");
    }
    if (!response.ok)
      throw Error(
        [401, 403].includes(response.status)
          ? "Update access denied. Reconnect your license."
          : "Licensing request failed. Try again later.",
      );
    if (response.status === 204) return undefined;
    if (raw) return response;
    try {
      return await response.json();
    } catch {
      throw Error("Invalid service response");
    }
  }
  return {
    api,
    product,
    installationId,
    token,
    async activate(key, installationLabel) {
      const result = await request(`${api}/activate`, {
        method: "POST",
        authenticated: false,
        body: {
          key,
          product,
          installationId,
          ...(siteUrl ? { siteUrl } : {}),
          ...(installationLabel ? { installationLabel } : {}),
        },
      });
      if (
        !result ||
        !/^[A-Za-z0-9_-]{1,1024}$/.test(result.token ?? "") ||
        result.installationId !== installationId
      )
        throw Error("Invalid activation response");
      await storage.setToken(result.token, `${api}|${product}`);
    },
    async deactivate() {
      await request(`${api}/deactivate`, { method: "POST", body: {} });
      await storage.setToken(undefined, `${api}|${product}`);
    },
    status() {
      return request(`${api}/activation`);
    },
    updates(target, currentVersion) {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(target)) throw Error("Invalid target");
      const query = currentVersion
        ? `?currentVersion=${encodeURIComponent(currentVersion)}`
        : "";
      return request(`${api}/updates/generic/${product}/${target}${query}`);
    },
    async headersFor(url) {
      return trusted(url) ? { Authorization: `Bearer ${await token()}` } : {};
    },
    download(url) {
      if (
        !trusted(url) ||
        !new URL(url).pathname.startsWith(`${origin.pathname}/packages/`)
      )
        return Promise.reject(Error("Untrusted update URL"));
      return request(url, { raw: true });
    },
  };
}
