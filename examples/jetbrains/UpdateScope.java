package example.licensing;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Set;
import java.util.regex.Pattern;

/** Pure credential scope, shared by repository discovery and package download requests. */
public final class UpdateScope {
    private UpdateScope() {}
    private static int port(URI uri) { return uri.getPort() == -1 ? 443 : uri.getPort(); }
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
    public static boolean permits(String api, String product, String candidate) {
        try {
            URI base = URI.create(api), url = URI.create(candidate);
            if (!"https".equals(url.getScheme()) || url.getHost() == null || !url.getHost().equalsIgnoreCase(base.getHost()) || port(url) != port(base)
                    || url.getRawUserInfo() != null || url.getRawFragment() != null) return false;
            String feed = base.getRawPath() + "/updates/jetbrains/" + product + "/updatePlugins.xml";
            if (feed.equals(url.getRawPath())) return nativeQuery(url.getRawQuery());
            String prefix = base.getRawPath() + "/packages/" + product + "/assets/";
            return url.getRawQuery() == null && url.getRawPath().matches(Pattern.quote(prefix) + "[A-Za-z0-9-]+/[A-Za-z0-9._-]+");
        } catch (IllegalArgumentException ignored) { return false; }
    }
}
