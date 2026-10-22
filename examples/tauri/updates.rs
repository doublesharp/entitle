//! Add to src-tauri/src/updates.rs. Configure API/product at build time.
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
pub struct Updates(pub Mutex<Option<Update>>);
fn failure<E>(_: E) -> String {
    "Update request failed. Check your license or try again later.".into()
}
fn vault() -> Result<keyring::Entry, String> {
    keyring::Entry::new(API, PRODUCT).map_err(failure)
}
fn token() -> Result<String, String> {
    vault()?.get_password().map_err(failure)
}

fn installation_id(app: &AppHandle) -> Result<String, String> {
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

#[tauri::command]
pub async fn activate(
    app: AppHandle,
    state: State<'_, Updates>,
    key: String,
    label: Option<String>,
) -> Result<(), String> {
    let mut pending = state.0.lock().await;
    let id = installation_id(&app)?;
    let mut body = json!({"key": key, "product": PRODUCT, "installationId": id});
    if let Some(label) = label {
        body["installationLabel"] = json!(label);
    }
    let result = request("/activate", Some(body), false).await?;
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
    *pending = None;
    Ok(())
}

#[tauri::command]
pub async fn deactivate(state: State<'_, Updates>) -> Result<(), String> {
    let mut pending = state.0.lock().await;
    request("/deactivate", Some(json!({})), true).await?;
    vault()?.delete_credential().map_err(failure)?;
    *pending = None;
    Ok(())
}

#[tauri::command]
pub async fn activation_status() -> Result<Value, String> {
    request("/activation", None, true).await
}

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

#[tauri::command]
pub async fn check_update(
    app: AppHandle,
    state: State<'_, Updates>,
) -> Result<Option<Value>, String> {
    let mut pending = state.0.lock().await;
    *pending = None;
    let endpoint = format!(
        "{API}/updates/tauri/{PRODUCT}/{{{{target}}}}-{{{{arch}}}}/{{{{current_version}}}}"
    );
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
