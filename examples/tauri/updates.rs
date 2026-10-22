//! License activation and signed native updates for a Tauri desktop app.
//!
//! Copy to `src-tauri/src/updates.rs` and configure API/product at build time.
//! Register the updater plugin, shared [`Updates`] state, and commands as shown
//! in the README. Call activation from local settings, check for an update,
//! show its version/notes, then call installation only after the user agrees.
//! The random installation ID stays in app data; only the activation token
//! goes in the OS credential vault. Installed features never require a license check.
use fs2::FileExt;
use serde_json::{json, Value};
use std::{
    fs::OpenOptions,
    io::{Read, Seek, Write},
    time::Duration,
};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Mutex;

const API: &str = "https://licenses.example.com/api/v1/tenants/publisher";
const PRODUCT: &str = "my-app";
/// Shared pending update, kept in Rust so frontend code cannot replace its URL.
///
/// The mutex serializes activation, deactivation, checks, and installation.
/// Register an initial `Mutex::new(None)` with the Tauri builder's `manage` method.
pub struct Updates(pub Mutex<Option<Update>>);
/// Replace underlying errors with a message safe to return to the settings UI.
fn failure<E>(_: E) -> String {
    "Update request failed. Check your license or try again later.".into()
}
/// Select the OS credential entry scoped to this tenant API and product.
fn vault() -> Result<keyring::Entry, String> {
    keyring::Entry::new(API, PRODUCT).map_err(failure)
}
/// Load the activation token for a request; the original license key is never saved.
fn token() -> Result<String, String> {
    vault()?.get_password().map_err(failure)
}

/// Read or create a random UUID under a file lock, preserving it across deactivation.
///
/// Returns an error for invalid stored data instead of silently changing identity.
fn installation_id(app: &AppHandle) -> Result<String, String> {
    // Lock before reading so concurrent calls agree on one persisted identity.
    let directory = app.path().app_data_dir().map_err(failure)?;
    std::fs::create_dir_all(&directory).map_err(failure)?;
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(directory.join("update-installation-id"))
        .map_err(failure)?;
    file.lock_exclusive().map_err(failure)?;
    let mut id = String::new();
    file.read_to_string(&mut id).map_err(failure)?;
    if id.is_empty() {
        id = uuid::Uuid::new_v4().to_string();
        file.rewind().map_err(failure)?;
        file.write_all(id.as_bytes()).map_err(failure)?;
        file.sync_all().map_err(failure)?;
    }
    uuid::Uuid::parse_str(&id).map_err(failure)?;
    Ok(id) // OS releases the lock on drop; retain the UUID across updates/deactivation.
}

/// Call a fixed API path with a 30-second timeout and no redirects.
///
/// `Some(body)` sends JSON via POST; `None` sends GET. Set `authenticated` to
/// false only for activation, which exchanges the submitted key for a token.
/// Successful responses must contain JSON; failures return a fixed UI message.
async fn request(path: &str, body: Option<Value>, authenticated: bool) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(failure)?;
    let url = format!("{API}{path}");
    let mut req = if let Some(data) = body {
        client.post(url).json(&data)
    } else {
        client.get(url)
    };
    if authenticated {
        req = req.bearer_auth(token()?);
    }
    let response = req.send().await.map_err(failure)?;
    if !response.status().is_success() {
        return Err(failure(()));
    }
    response.json().await.map_err(failure)
}

/// Activate update access from a local settings form, retaining only the returned token.
///
/// `key` is the user-entered license key and `label` is an optional friendly name.
/// Clear the key input after the call. Errors leave installed functionality available.
#[tauri::command]
pub async fn activate(
    app: AppHandle,
    state: State<'_, Updates>,
    key: String,
    label: Option<String>,
) -> Result<(), String> {
    // Step 1: serialize license changes and identify this installation.
    let mut pending = state.0.lock().await;
    let id = installation_id(&app)?;
    let mut body = json!({"key": key, "product": PRODUCT, "installationId": id});
    if let Some(label) = label {
        body["installationLabel"] = json!(label);
    }
    // Step 2: exchange the key without requiring an existing activation token.
    let result = request("/activate", Some(body), false).await?;
    // Step 3: validate the installation and token before writing to the OS vault.
    if result["installationId"].as_str() != Some(id.as_str()) {
        return Err(failure(()));
    }
    let value = result["token"].as_str().ok_or_else(|| failure(()))?;
    if value.is_empty()
        || value.len() > 1024
        || !value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err(failure(()));
    }
    vault()?.set_password(value).map_err(failure)?;
    // Step 4: discard any update selected under the previous credential.
    *pending = None;
    Ok(())
}

/// Release server-side update access, then delete the token and pending update.
///
/// The installation UUID stays on disk. A failed request keeps local credentials
/// so the user can retry; this operation never disables installed app features.
#[tauri::command]
pub async fn deactivate(state: State<'_, Updates>) -> Result<(), String> {
    let mut pending = state.0.lock().await;
    request("/deactivate", Some(json!({})), true).await?;
    vault()?.delete_credential().map_err(failure)?;
    *pending = None;
    Ok(())
}

/// Return activation details for local settings without changing the license.
#[tauri::command]
pub async fn activation_status() -> Result<Value, String> {
    request("/activation", None, true).await
}

/// Allow only HTTPS package URLs under this tenant/product's immutable asset path.
/// Credentials, query strings, fragments, and percent-encoded paths are rejected.
fn trusted_asset(url: &reqwest::Url) -> bool {
    let base = reqwest::Url::parse(API).expect("build-time API URL");
    let prefix = format!("{}/packages/{PRODUCT}/assets/", base.path());
    url.origin() == base.origin()
        && url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path().starts_with(&prefix)
        && url.path()[prefix.len()..].split('/').count() == 2
        && !url.path().contains('%')
}

/// Check the native updater feed and retain an allowed update for later installation.
///
/// Returns version/notes as `Some`, or `None` when no update is offered. No package
/// is installed here. The UI must ask for consent before calling [`install_update`].
#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    state: State<'_, Updates>,
) -> Result<Option<Value>, String> {
    // Step 1: remove a stale offer and let Tauri substitute its native target/version.
    let mut pending = state.0.lock().await;
    *pending = None;
    let endpoint = format!(
        "{API}/updates/tauri/{PRODUCT}/{{{{target}}}}-{{{{arch}}}}/{{{{current_version}}}}"
    );
    // Step 2: check with the stored token; reject redirects for updater requests.
    let update = app
        .updater_builder()
        .endpoints(vec![endpoint.parse().map_err(failure)?])
        .map_err(failure)?
        .header("Authorization", format!("Bearer {}", token()?))
        .map_err(failure)?
        .timeout(Duration::from_secs(30))
        .configure_client(|client| client.redirect(reqwest::redirect::Policy::none()))
        .build()
        .map_err(failure)?
        .check()
        .await
        .map_err(failure)?;
    // Step 3: validate the package destination before retaining the native update.
    if let Some(update) = update {
        if !trusted_asset(&update.download_url) {
            return Err("Untrusted update URL".into());
        }
        let details = json!({"version": update.version, "notes": update.body});
        *pending = Some(update);
        Ok(Some(details))
    } else {
        Ok(None)
    }
}

/// Consume the last checked update and let Tauri download, verify, and install it.
///
/// Invoke only after user consent. Returns an error if no update is pending or
/// installation fails. Windows may exit during installation; other platforms
/// should offer a restart after success, as described in the README.
#[tauri::command]
pub async fn install_update(state: State<'_, Updates>) -> Result<(), String> {
    // Invoke only after the user accepts installation. Native updater verifies its signature.
    let mut pending = state.0.lock().await;
    let update = pending.take().ok_or("Check for updates first")?;
    update
        .download_and_install(|_bytes, _total| {}, || {})
        .await
        .map_err(failure)
}
