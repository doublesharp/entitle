package example.licensing

import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.Credentials
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.ide.plugins.auth.PluginRepositoryAuthListener
import com.intellij.ide.plugins.auth.PluginRepositoryAuthProvider
import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.UUID

/**
 * Application service for activation settings and native private-repository updates.
 *
 * Call [activate], [status], and [deactivate] from an IDE background task because
 * network and PasswordSafe access block. Clear the settings key input afterward.
 * The random UUID stays in PropertiesComponent; only the token goes in PasswordSafe.
 * Installed plugin functionality must not depend on these update operations.
 *
 * Compile against the IDE SDK you ship for; the auth extension API is marked Internal upstream.
 */
@Service(Service.Level.APP)
class LicenseUpdates {
    companion object {
        const val API = "https://licenses.example.com/api/v1/tenants/publisher"
        const val PRODUCT = "my-plugin"
        /** Add this credential-free URL in Manage Plugin Repositories after installing the bootstrap. */
        val repositoryUrl = "$API/updates/jetbrains/$PRODUCT/updatePlugins.xml"
        private val identityLock = Any()
        /** Return whether [url] may receive this tenant/product's activation token. */
        fun permits(url: String): Boolean = UpdateScope.permits(API, PRODUCT, url)
    }
    private val credentials = CredentialAttributes("DoubleEntitle:$API:$PRODUCT")
    private val client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER)
        .connectTimeout(Duration.ofSeconds(20)).build()
    /** Create the installation UUID once under a lock; retain it after deactivation. */
    private val installationId: String get() = synchronized(identityLock) {
        val properties = PropertiesComponent.getInstance()
        val name = "DoubleEntitle:$API:$PRODUCT:installationId"
        properties.getValue(name) ?: UUID.randomUUID().toString().also { properties.setValue(name, it) }
    }
    /** Read the activation credential, or return null if no token is stored. */
    fun token(): String? = PasswordSafe.instance.getPassword(credentials)
    /** Schedule native repository-auth cache invalidation on the UI thread. */
    private fun authChanged() {
        ApplicationManager.getApplication().invokeLater { PluginRepositoryAuthListener.notifyAuthChanged() }
    }
    /**
     * Send a bounded request to a fixed API [path], with redirects disabled.
     * A non-null [body] selects JSON POST; otherwise the request is GET.
     * [authenticated] is false only when exchanging a license key during activation.
     *
     * @return Decoded JSON object for settings or activation processing.
     * @throws IllegalStateException If credentials are absent or the request/response fails.
     */
    private fun request(path: String, body: JsonObject? = null, authenticated: Boolean = true): JsonObject {
        val builder = HttpRequest.newBuilder(URI(API + path)).timeout(Duration.ofSeconds(30)).header("Accept", "application/json")
        if (authenticated) {
            val value = token() ?: throw IllegalStateException("Activate updates first.")
            builder.header("Authorization", "Bearer $value")
        }
        if (body != null) builder.header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body.toString()))
        try {
            val response = client.send(builder.build(), HttpResponse.BodyHandlers.ofString())
            if (response.statusCode() !in 200..299) throw IllegalStateException()
            return JsonParser.parseString(response.body()).asJsonObject
        } catch (exception: Exception) { throw IllegalStateException("Update request failed. Check your license or try again later.") }
    }
    /**
     * Exchange [key] for a validated token, save it, and refresh IDE repository auth.
     * [label] is an optional friendly installation name. The raw key is not retained.
     */
    @Synchronized fun activate(key: String, label: String?) {
        // Step 1: identify the installation and build the one-time key exchange.
        val id = installationId
        val data = JsonObject().apply {
            addProperty("key", key); addProperty("product", PRODUCT); addProperty("installationId", id)
            if (!label.isNullOrBlank()) addProperty("installationLabel", label)
        }
        val result = request("/activate", data, false)
        // Step 2: reject a malformed token or a response for a different installation.
        val value = result.get("token")?.takeIf { it.isJsonPrimitive }?.asString
        if (result.get("installationId")?.takeIf { it.isJsonPrimitive }?.asString != id || value == null || !value.matches(Regex("[A-Za-z0-9_-]{1,1024}"))) {
            throw IllegalStateException("Invalid activation response.")
        }
        // Step 3: save only the token, then tell native update requests to reload auth.
        PasswordSafe.instance.set(credentials, Credentials("activation", value))
        authChanged()
    }
    /** Fetch activation details for settings; this does not gate installed features. */
    fun status(): JsonObject = request("/activation")
    /** Release server access before deleting the token; keep the UUID for reactivation. */
    @Synchronized fun deactivate() {
        request("/deactivate", JsonObject())
        PasswordSafe.instance.set(credentials, null)
        authChanged()
    }
}

/**
 * Native repository authentication hook registered through plugin.fragment.xml.
 * Both feed discovery and package downloads pass through the same URL scope check.
 */
class LicenseRepositoryAuth : PluginRepositoryAuthProvider {
    /** Match only this product's allowed repository and immutable asset URLs. */
    override fun canHandle(url: String): Boolean = LicenseUpdates.permits(url)
    /** Return a bearer header only for an allowed URL with a saved activation token. */
    override fun getAuthHeaders(url: String): Map<String, String> {
        if (!canHandle(url)) return emptyMap()
        val value = service<LicenseUpdates>().token() ?: return emptyMap()
        return mapOf("Authorization" to "Bearer $value")
    }
}
