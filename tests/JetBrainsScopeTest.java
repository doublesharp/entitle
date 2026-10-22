package example.licensing;

public final class JetBrainsScopeTest {
    public static void main(String[] args) {
        String api = "https://updates.example/api/v1/tenants/vendor";
        String feed = api + "/updates/jetbrains/example/updatePlugins.xml";
        String asset = api + "/packages/example/assets/uuid-1/example.zip";
        for (String url : new String[] {feed, feed + "?build=AI-261.123&os=Mac%20OS%20X&arch=ARM64", asset}) {
            if (!UpdateScope.permits(api, "example", url)) throw new AssertionError("Expected scoped URL accepted: " + url);
        }
        for (String url : new String[] {feed + "?token=secret", feed + "?build=x&build=y", feed + "?build=%0d%0a", asset + "?build=x", asset.replace("updates.example", "attacker.example"), asset.replace("/example/", "/other/"), feed + "#fragment", asset.replace("https://", "https://user@"), api + "/seller/products", "not a URL"}) {
            if (UpdateScope.permits(api, "example", url)) throw new AssertionError("Expected untrusted URL rejected: " + url);
        }
        System.out.println("JetBrains native query and URL scope contracts passed");
    }
}
