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

/** Compile against the IDE SDK you ship for; the documented auth EP is marked Internal upstream. */
@Service(Service.Level.APP)
class LicenseUpdates {
    companion object {
        const val API = "https://licenses.example.com/api/v1/tenants/publisher"
        const val PRODUCT = "my-plugin"
        val repositoryUrl = "$API/updates/jetbrains/$PRODUCT/updatePlugins.xml"
        private val identityLock = Any()
        fun permits(url: String): Boolean = UpdateScope.permits(API, PRODUCT, url)
    }
    private val credentials = CredentialAttributes("DoubleEntitle:$API:$PRODUCT")
    private val client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER)
        .connectTimeout(Duration.ofSeconds(20)).build()
    private val installationId: String get() = synchronized(identityLock) {
        val properties = PropertiesComponent.getInstance()
        val name = "DoubleEntitle:$API:$PRODUCT:installationId"
        properties.getValue(name) ?: UUID.randomUUID().toString().also { properties.setValue(name, it) }
    }
    fun token(): String? = PasswordSafe.instance.getPassword(credentials)
    private fun authChanged() {
        ApplicationManager.getApplication().invokeLater { PluginRepositoryAuthListener.notifyAuthChanged() }
    }
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
    @Synchronized fun activate(key: String, label: String?) {
        val id = installationId
        val data = JsonObject().apply {
            addProperty("key", key); addProperty("product", PRODUCT); addProperty("installationId", id)
            if (!label.isNullOrBlank()) addProperty("installationLabel", label)
        }
        val result = request("/activate", data, false)
        val value = result.get("token")?.takeIf { it.isJsonPrimitive }?.asString
        if (result.get("installationId")?.takeIf { it.isJsonPrimitive }?.asString != id || value == null || !value.matches(Regex("[A-Za-z0-9_-]{1,1024}"))) {
            throw IllegalStateException("Invalid activation response.")
        }
        PasswordSafe.instance.set(credentials, Credentials("activation", value))
        authChanged()
    }
    fun status(): JsonObject = request("/activation")
    @Synchronized fun deactivate() {
        request("/deactivate", JsonObject())
        PasswordSafe.instance.set(credentials, null)
        authChanged()
    }
}

class LicenseRepositoryAuth : PluginRepositoryAuthProvider {
    override fun canHandle(url: String): Boolean = LicenseUpdates.permits(url)
    override fun getAuthHeaders(url: String): Map<String, String> {
        if (!canHandle(url)) return emptyMap()
        val value = service<LicenseUpdates>().token() ?: return emptyMap()
        return mapOf("Authorization" to "Bearer $value")
    }
}
