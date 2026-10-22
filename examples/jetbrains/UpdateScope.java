package example.licensing;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Decide which native repository requests may receive an activation token.
 * This helper performs no I/O and is shared by feed discovery and package downloads.
 */
public final class UpdateScope {
    private UpdateScope() {}
    /** Normalize an omitted HTTPS port so it compares equal to an explicit port 443. */
    private static int port(URI uri) { return uri.getPort() == -1 ? 443 : uri.getPort(); }
    /** Accept only bounded, unique build/os/arch query fields added by the IDE. */
    private static boolean nativeQuery(String raw) {
        if (raw == null) return true;
        if (raw.length() > 1024 || raw.isEmpty()) return false;
        Set<String> seen = new HashSet<>();
        for (String item : raw.split("&", -1)) {
            String[] pair = item.split("=", 2);
            if (pair.length != 2 || !Set.of("build", "os", "arch").contains(pair[0]) || !seen.add(pair[0])) return false;
            String value = URLDecoder.decode(pair[1], StandardCharsets.UTF_8);
            if (!value.matches("[A-Za-z0-9._* +\\-]{1,200}")) return false;
        }
        return true;
    }
    /**
     * Check a candidate against the configured product before attaching credentials.
     * Feed requests may include the IDE's supported query fields. Package requests
     * must use a direct immutable asset path with no query string.
     *
     * @param api trusted build-time tenant API URL
     * @param product configured product slug
     * @param candidate URL proposed by the native updater
     * @return true only for an allowed HTTPS origin and product path; false for malformed URLs
     */
    public static boolean permits(String api, String product, String candidate) {
        try {
            // Step 1: require the same HTTPS host/port, with no URL credentials or fragment.
            URI base = URI.create(api), url = URI.create(candidate);
            if (!"https".equals(url.getScheme()) || url.getHost() == null || !url.getHost().equalsIgnoreCase(base.getHost()) || port(url) != port(base)
                    || url.getRawUserInfo() != null || url.getRawFragment() != null) return false;
            // Step 2: allow native discovery query fields only on the exact feed.
            String feed = base.getRawPath() + "/updates/jetbrains/" + product + "/updatePlugins.xml";
            if (feed.equals(url.getRawPath())) return nativeQuery(url.getRawQuery());
            // Step 3: accept only this product's asset-id/filename package paths.
            String prefix = base.getRawPath() + "/packages/" + product + "/assets/";
            return url.getRawQuery() == null && url.getRawPath().matches(Pattern.quote(prefix) + "[A-Za-z0-9-]+/[A-Za-z0-9._-]+");
        } catch (IllegalArgumentException ignored) { return false; }
    }
}
