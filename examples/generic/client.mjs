/**
 * @file A framework-independent client for license activation and update downloads.
 * Use it from update settings; installed app features do not depend on this client.
 * The license key is sent only during activation. Later requests use a stored token.
 */
/**
 * Storage supplied by the host app. Scope every value to the tenant/product namespace.
 * Keep the random installation UUID across upgrades and deactivation. Store tokens
 * in the platform credential vault, and delete a token when its value is undefined.
 *
 * @typedef {Object} UpdateStorage
 * @property {(namespace: string) => Promise<string>} getOrCreateId Atomically read or create a UUID.
 * @property {(namespace: string) => Promise<string | undefined>} getToken Read the activation token.
 * @property {(value: string | undefined, namespace: string) => Promise<void>} setToken Save or delete the token.
 */

/**
 * @typedef {Object} UpdateClient
 * @property {string} api Validated tenant API base.
 * @property {string} product Configured product slug.
 * @property {string} installationId Persistent random UUID.
 * @property {() => Promise<string>} token Read the validated activation token.
 * @property {(key: string, installationLabel?: string) => Promise<void>} activate Exchange a key for a token.
 * @property {() => Promise<void>} deactivate Release access and delete the token.
 * @property {() => Promise<Object | undefined>} status Read activation details.
 * @property {(target: string, currentVersion?: string) => Promise<Object | undefined>} updates Check release metadata.
 * @property {(url: string) => Promise<Object<string, string>>} headersFor Build scoped credentials.
 * @property {(url: string) => Promise<Response>} download Fetch a trusted package.
 */

/**
 * Validate configuration and load this installation's persistent identity.
 * Creating the client does not activate a license or make a network request.
 *
 * @param {Object} options Host application configuration.
 * @param {string} options.api HTTPS tenant API URL without a trailing slash.
 * @param {string} options.product Product slug, for example `my-app`.
 * @param {UpdateStorage} options.storage Persistent identity and credential storage.
 * @param {typeof fetch} [options.fetcher=fetch] Fetch implementation, replaceable in tests.
 * @param {string} [options.siteUrl] Real site URL for products configured for site activation.
 * @returns {Promise<UpdateClient>} Methods bound to this tenant, product, and installation.
 * @throws {Error} If configuration is invalid or the stored identity cannot be loaded.
 */
export async function createClient({
  api,
  product,
  storage,
  fetcher = fetch,
  siteUrl,
}) {
  // Step 1: reject malformed configuration before using it in authenticated URLs.
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
  // Step 2: reuse the same random identity, including after deactivation.
  const installationId = await storage.getOrCreateId(`${api}|${product}`);
  /**
   * Read and validate the saved credential immediately before an authenticated request.
   * @returns {Promise<string>} Activation token, never the buyer's license key.
   * @throws {Error} If activation is missing or the stored token is malformed.
   */
  async function token() {
    const value = await storage.getToken(`${api}|${product}`);
    if (!value || !/^[A-Za-z0-9_-]{1,1024}$/.test(value))
      throw Error("Activate updates first.");
    return value;
  }
  /**
   * Decide whether a URL may receive this product's bearer token.
   * @param {string} url Candidate metadata or immutable asset URL.
   * @returns {boolean} Whether the HTTPS origin and exact product path are allowed.
   */
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
  /**
   * Send a bounded request without redirects or browser cookies.
   * Network and server failures become fixed messages so credentials stay out of errors.
   *
   * @param {string} url Internally constructed API URL or validated asset URL.
   * @param {Object} [options] Request settings.
   * @param {string} [options.method="GET"] HTTP method.
   * @param {*} [options.body] JSON payload, omitted for bodyless requests.
   * @param {boolean} [options.authenticated=true] Attach the stored activation token.
   * @param {boolean} [options.raw=false] Return a Response instead of decoding JSON.
   * @returns {Promise<*>} Decoded JSON, a raw Response, or undefined for HTTP 204.
   * @throws {Error} If credentials, transport, HTTP status, or JSON decoding fail.
   */
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
  // Step 3: expose the lifecycle and update operations for the host app's settings UI.
  return {
    api,
    product,
    installationId,
    token,
    /**
     * Exchange a user-entered key for an installation token and save only that token.
     * @param {string} key License key from the settings form; clear the form afterward.
     * @param {string} [installationLabel] Optional friendly name, such as "Work laptop".
     * @returns {Promise<void>} Resolves once the activation response is validated and saved.
     */
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
      // Accept only a valid token issued for the identity we sent in this request.
      if (
        !result ||
        !/^[A-Za-z0-9_-]{1,1024}$/.test(result.token ?? "") ||
        result.installationId !== installationId
      )
        throw Error("Invalid activation response");
      await storage.setToken(result.token, `${api}|${product}`);
    },
    /**
     * Release update access on the server, then delete the local token but keep the UUID.
     * @returns {Promise<void>} Resolves after both operations succeed.
     */
    async deactivate() {
      await request(`${api}/deactivate`, { method: "POST", body: {} });
      await storage.setToken(undefined, `${api}|${product}`);
    },
    /** @returns {Promise<Object | undefined>} Activation details, or undefined for HTTP 204. */
    status() {
      return request(`${api}/activation`);
    },
    /**
     * Check for an eligible release without downloading or installing it.
     * @param {string} target Published platform target, such as `linux-x64`.
     * @param {string} [currentVersion] Installed version used to filter the offer.
     * @returns {Promise<Object | undefined>} Release metadata, or undefined for HTTP 204.
     */
    updates(target, currentVersion) {
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(target)) throw Error("Invalid target");
      const query = currentVersion
        ? `?currentVersion=${encodeURIComponent(currentVersion)}`
        : "";
      return request(`${api}/updates/generic/${product}/${target}${query}`);
    },
    /**
     * Build credentials for a host app's own transport only when its URL is trusted.
     * @param {string} url Candidate metadata or asset URL.
     * @returns {Promise<Object<string, string>>} Authorization header, or an empty object.
     */
    async headersFor(url) {
      return trusted(url) ? { Authorization: `Bearer ${await token()}` } : {};
    },
    /**
     * Fetch an allowed asset. The caller must stage it, verify its checksum and publisher
     * signature, and obtain user consent before handing it to a trusted installer.
     * @param {string} url Immutable asset URL from release metadata.
     * @returns {Promise<Response>} Response whose body contains the package bytes.
     */
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
