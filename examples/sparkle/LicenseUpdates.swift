import Foundation
import Security
import Sparkle

private final class NoRedirects: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest,
                    completionHandler: @escaping @Sendable (URLRequest?) -> Void) { completionHandler(nil) }
}

@MainActor
final class LicenseUpdates: NSObject, SPUUpdaterDelegate {
    private let api = URL(string: "https://licenses.example.com/api/v1/tenants/publisher")!
    private let product = "my-app"
    private let target: String
    private let defaults = UserDefaults.standard
    private let redirectBlocker = NoRedirects()
    private let session = URLSession(configuration: .ephemeral)
    private var started = false
    var showError: (String) -> Void = { _ in }
    private lazy var controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)

    init(target: String) {
        precondition(["darwin-x64", "darwin-arm64", "darwin-universal"].contains(target))
        self.target = target
        super.init()
    }
    private func error(_ message: String = "Update request failed. Check your license or try again later.") -> NSError {
        NSError(domain: "DoubleEntitle", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }
    private var installationId: String {
        let key = "DoubleEntitle.\(api.absoluteString).\(product).installationId"
        if let existing = defaults.string(forKey: key) { return existing }
        let value = UUID().uuidString.lowercased(); defaults.set(value, forKey: key)
        return value
    }
    private var keychainQuery: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: api.absoluteString,
         kSecAttrAccount as String: product]
    }
    private func token() throws -> String {
        var query = keychainQuery; query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data, let value = String(data: data, encoding: .utf8) else { throw error("Activate updates first.") }
        return value
    }
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
    func activate(key: String, label: String) async throws {
        let result = try await request("/activate", body: ["key": key, "product": product, "installationId": installationId, "installationLabel": label], authenticated: false)
        guard result["installationId"] as? String == installationId, let value = result["token"] as? String,
              value.range(of: "^[A-Za-z0-9_-]{1,1024}$", options: .regularExpression) != nil else { throw error() }
        try saveToken(value)
        try startUpdates()
    }
    func status() async throws -> [String: Any] { try await request("/activation") }
    func deactivate() async throws {
        guard !controller.updater.sessionInProgress else { throw error("Finish or cancel the current update first.") }
        _ = try await request("/deactivate", body: [:])
        try saveToken(nil)
        controller.updater.automaticallyChecksForUpdates = false
        controller.updater.httpHeaders = nil
    }
    func startUpdates() throws {
        controller.updater.httpHeaders = ["Authorization": "Bearer \(try token())"]
        controller.updater.sendsSystemProfile = false
        if !started { try controller.updater.start(); started = true }
    }
    func feedURLString(for updater: SPUUpdater) -> String? {
        api.absoluteString + "/updates/sparkle/\(product)/\(target)/appcast.xml"
    }
    func checkForUpdates() { controller.checkForUpdates(nil) }
    func updater(_ updater: SPUUpdater, didAbortWithError error: Error) {
        let native = error as NSError
        if native.domain == SUSparkleErrorDomain,
           native.code == SUError.noUpdateError.rawValue || native.code == SUError.installationCanceledError.rawValue { return }
        // Native errors may carry request data. Display a fixed message only.
        showError("Update check failed. Reconnect your license or try again later.")
    }
}
