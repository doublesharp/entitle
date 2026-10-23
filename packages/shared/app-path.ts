export function normalizeAppBasePath(value: string | undefined): string {
  if (value === undefined || value === "" || value === "/") return "";
  const normalized = value.endsWith("/") ? value.slice(0, -1) : value;
  if (
    value.length > 128 ||
    !normalized.startsWith("/") ||
    normalized
      .slice(1)
      .split("/")
      .some((segment) => !segment || /[^A-Za-z0-9_-]/u.test(segment))
  )
    throw Error(
      "APP_BASE_PATH must be empty or an absolute path of ASCII letters, digits, underscores and hyphens, at most 128 characters, with one optional trailing slash",
    );
  return normalized;
}

export function appPath(path: string, basePath?: string): string {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[\\\p{Cc}]/u.test(path)
  )
    throw Error(
      "Application path must begin with a single slash and contain no backslashes or control characters",
    );
  return `${normalizeAppBasePath(basePath)}${path}`;
}

// The caller supplies an origin already validated by configuration.
export function appUrl(
  config: { origin: string; appBasePath?: string },
  path: string,
): string {
  return `${config.origin}${appPath(path, config.appBasePath)}`;
}

export function normalizeApplicationUrl(value: string): string {
  const relative = value.startsWith("/");
  const absolute = /^https?:\/\/[^/?#]+(.*)$/u.exec(value);
  if ((!relative && !absolute) || /[\\\s\p{Cc}]/u.test(value))
    throw Error(
      "Application URL must be an HTTP(S) URL or absolute local path",
    );
  const rawPath = relative ? value : absolute![1] || "/";
  const path = normalizeAppBasePath(rawPath) + "/";
  const url = new URL(value, "https://configuration.invalid");
  if (url.username || url.password || url.search || url.hash)
    throw Error(
      "Application URL cannot include credentials, a query or a fragment",
    );
  return relative ? path : url.origin + path;
}
