import Foundation
import Security
import Sparkle

/// Reject API redirects so an authenticated request cannot be forwarded elsewhere.
private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    /// Returning nil tells URLSession to stop at the redirect response.
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

/// Connect license settings to Sparkle's native check, download, and install UI.
///
/// Retain one instance in the app. Activate from settings, restore updates on launch
/// with `startUpdates()`, and wire the menu action to `checkForUpdates()`.
/// The UUID lives in user defaults; the token lives in Keychain. Installed app
/// features remain available regardless of update access or network availability.
@MainActor
final class LicenseUpdates: NSObject, SPUUpdaterDelegate {
    private let api = URL(string: "https://licenses.example.com/api/v1/tenants/publisher")!
    private let product = "my-app"
    private let target: String
    private let defaults = UserDefaults.standard
    private let redirectBlocker = NoRedirects()
    private let session = URLSession(configuration: .ephemeral)
    private var started = false
    /// Set this callback to display fixed update errors in the app's settings UI.
    var showError: (String) -> Void = { _ in }
    private lazy var controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)

    /// Select the published architecture matching this bundle, such as `darwin-universal`.
    /// - Parameter target: One of the supported macOS feed targets listed below.
    init(target: String) {
        precondition(["darwin-x64", "darwin-arm64", "darwin-universal"].contains(target))
        self.target = target
        super.init()
    }
    /// Build a displayable error without including request headers or provider responses.
    private func error(_ message: String = "Update request failed. Check your license or try again later.") -> NSError {
        NSError(domain: "DoubleEntitle", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
    /// Reuse a random UUID scoped to this API/product, including after deactivation.
    private var installationId: String {
        let key = "DoubleEntitle.\(api.absoluteString).\(product).installationId"
        if let existing = defaults.string(forKey: key) { return existing }
        let value = UUID().uuidString.lowercased(); defaults.set(value, forKey: key)
        return value
    }
    /// Identify this product's Keychain entry without putting a token in its name.
    private var keychainQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: api.absoluteString,
         kSecAttrAccount as String: product]
    }
    /// Read the saved activation token, or ask the user to activate when it cannot be read.
    private func token() throws -> String {
        var query = keychainQuery; query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data, let value = String(data: data, encoding: .utf8) else { throw error("Activate updates first.") }
        return value
    }
    /// Update or create a device-local Keychain item; passing nil deletes it.
    /// - Parameter value: Activation token from the server, never the original license key.
    private func saveToken(_ value: String?) throws {
        guard let value else {
            let result = SecItemDelete(keychainQuery as CFDictionary)
            guard result == errSecSuccess || result == errSecItemNotFound else { throw error() }
            return
        }
        let attributes = [kSecValueData as String: Data(value.utf8)]
        let result = SecItemUpdate(keychainQuery as CFDictionary, attributes as CFDictionary)
        if result == errSecItemNotFound {
            var query = keychainQuery
            query.merge(attributes) { _, new in new }
            query[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else { throw error() }
        } else if result != errSecSuccess { throw error() }
    }
    /// Send an API request with a timeout and no redirects, returning a JSON object.
    /// - Parameters:
    ///   - path: Fixed API path appended to the configured tenant URL.
    ///   - body: JSON POST payload, or nil for a GET request.
    ///   - authenticated: Whether to attach the saved token; false during activation.
    /// - Throws: A fixed error if transport, HTTP status, or JSON decoding fails.
    private func request(_ path: String, body: [String: Any]? = nil, authenticated: Bool = true) async throws -> [String: Any] {
        var request = URLRequest(url: URL(string: api.absoluteString + path)!)
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if authenticated { request.setValue("Bearer \(try token())", forHTTPHeaderField: "Authorization") }
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        do {
            let (data, response) = try await session.data(for: request, delegate: redirectBlocker)
            guard let response = response as? HTTPURLResponse, (200..<300).contains(response.statusCode),
                  let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw error() }
            return result
        } catch { throw self.error() }
    }
    /// Exchange a settings-form key for update access, then start Sparkle.
    /// - Parameters:
    ///   - key: User-entered license key. Clear the form field after this call.
    ///   - label: Friendly installation name shown in the buyer's account.
    /// - Throws: If activation, response validation, token storage, or updater startup fails.
    func activate(key: String, label: String) async throws {
        // Step 1: send the key with the persistent UUID, without an existing token.
        let result = try await request("/activate", body: ["key": key, "product": product, "installationId": installationId, "installationLabel": label], authenticated: false)
        // Step 2: bind the returned token to this installation before saving it.
        guard result["installationId"] as? String == installationId, let value = result["token"] as? String,
              value.range(of: "^[A-Za-z0-9_-]{1,1024}$", options: .regularExpression) != nil else { throw error() }
        try saveToken(value)
        // Step 3: give Sparkle the saved credential and start its update lifecycle.
        try startUpdates()
    }
    /// Fetch activation details for settings without downloading or installing anything.
    func status() async throws -> [String: Any] { try await request("/activation") }
    /// Release update access and clear credentials after any active update finishes.
    /// The persistent UUID and installed features are retained.
    func deactivate() async throws {
        guard !controller.updater.sessionInProgress else { throw error("Finish or cancel the current update first.") }
        _ = try await request("/deactivate", body: [:])
        try saveToken(nil)
        controller.updater.automaticallyChecksForUpdates = false
        controller.updater.httpHeaders = nil
    }
    /// Restore authentication on launch or after activation, and start Sparkle once.
    /// System-profile collection is disabled; Sparkle handles native update consent.
    func startUpdates() throws {
        controller.updater.httpHeaders = ["Authorization": "Bearer \(try token())"]
        controller.updater.sendsSystemProfile = false
        if !started { try controller.updater.start(); started = true }
    }
    /// Supply this product/architecture's appcast through Sparkle's delegate API.
    func feedURLString(for updater: SPUUpdater) -> String? {
        api.absoluteString + "/updates/sparkle/\(product)/\(target)/appcast.xml"
    }
    /// Open Sparkle's user-facing update check from the app's menu action.
    func checkForUpdates() { controller.checkForUpdates(nil) }
    /// Ignore ordinary no-update/cancellation outcomes and display safe errors otherwise.
    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        let native = error as NSError
        if native.domain == SUSparkleErrorDomain,
           native.code == SUError.noUpdateError.rawValue || native.code == SUError.installationCanceledError.rawValue { return }
        // Native errors may carry request data. Display a fixed message only.
        showError("Update check failed. Reconnect your license or try again later.")
    }
}
