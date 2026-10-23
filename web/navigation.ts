import {
  appPath,
  normalizeAppBasePath,
  normalizeApplicationUrl,
} from "../packages/shared/app-path.ts";

export function applicationBasePath() {
  return normalizeAppBasePath(
    document.querySelector<HTMLMetaElement>('meta[name="entitle-app-base"]')
      ?.content,
  );
}
export function applicationHref(path: string) {
  const destination = document.querySelector<HTMLMetaElement>(
    'meta[name="entitle-app-url"]',
  )?.content;
  if (!destination) return appPath(path, applicationBasePath());
  const normalized = normalizeApplicationUrl(destination);
  const url = new URL(normalized, window.location.origin);
  const pathname = appPath(path, normalizeAppBasePath(url.pathname));
  return destination.startsWith("/") ? pathname : url.origin + pathname;
}
export function applicationRoute(pathname = window.location.pathname) {
  const base = applicationBasePath();
  return base && (pathname === base || pathname.startsWith(base + "/"))
    ? pathname.slice(base.length) || "/"
    : pathname;
}
export const applicationAsset = (path: string) =>
  appPath(path, applicationBasePath());
