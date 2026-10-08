use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use keyring::Entry;
use rand::RngCore;
use reqwest::blocking::Client;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::UpdaterExt;

const APP_ID: &str = "com.anotherpanacea.apodictic";

/// The running sidecar, kept so an update can stop it before the installer replaces its binary
/// (Windows will not overwrite a running executable).
struct Sidecar(Mutex<Option<CommandChild>>);

#[derive(Debug, Deserialize)]
struct SidecarHealth {
    runtime_mode: Option<String>,
    bind_scope: Option<String>,
}

fn is_expected_local_health(health: &SidecarHealth) -> bool {
    health.runtime_mode.as_deref() == Some("local")
        && health.bind_scope.as_deref() == Some("loopback")
}

/// Retrieve the existing keychain secret, creating one only when the entry is absent.
fn get_or_create_keychain_secret(
    service: &str,
    user: &str,
    length: usize,
) -> Result<String, String> {
    let entry = Entry::new(service, user)
        .map_err(|_| "Failed to initialize keychain entry.".to_string())?;
    resolve_keychain_secret(
        entry.get_password(),
        length,
        |bytes| {
            // These bytes back the Stronghold vault key and credential-encryption DEK.
            rand::rngs::OsRng.fill_bytes(bytes);
        },
        |secret| entry.set_password(secret),
    )
}

fn resolve_keychain_secret(
    read_result: keyring::Result<String>,
    length: usize,
    fill_entropy: impl FnOnce(&mut [u8]),
    store: impl FnOnce(&str) -> keyring::Result<()>,
) -> Result<String, String> {
    match read_result {
        Ok(secret) => Ok(secret),
        Err(keyring::Error::NoEntry) => {
            let mut random_bytes = vec![0u8; length];
            fill_entropy(&mut random_bytes);
            let secret = BASE64.encode(&random_bytes);
            store(&secret).map_err(|_| "Failed to store keychain secret.".to_string())?;
            Ok(secret)
        }
        // Keyring errors can include credential data; never expose their payloads.
        Err(_) => Err("Failed to read keychain secret.".to_string()),
    }
}

/// Bridge command so the JS frontend can bootstrap Stronghold using an OS-keychain backed password.
#[tauri::command]
fn get_vault_password() -> Result<String, String> {
    get_or_create_keychain_secret(APP_ID, "stronghold_vault_key", 32)
}

#[tauri::command]
fn open_browser(url: String, app: AppHandle) -> Result<(), String> {
    // TODO(apodictic-tauri#follow-up): migrate to tauri-plugin-opener; `Shell::open` is deprecated
    // in tauri-plugin-shell 2.x. Suppressed (not migrated) here to keep this extraction
    // behavior-identical to APODICTIC-Gemini's working shell; migration is a separate change.
    #[allow(deprecated)]
    app.shell().open(&url, None).map_err(|e| e.to_string())
}

fn start_sidecar(app: &AppHandle) -> Result<(), String> {
    if cfg!(debug_assertions) {
        println!("[Main] Dev Mode: Skipping bundled Sidecar startup. Relying on TSX dev:server instead!");
        return Ok(());
    }

    let app_data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| PathBuf::from("./data"));
    let pub_resources_dir = app
        .path()
        .resource_dir()
        .unwrap_or_else(|_| PathBuf::from("./public"));

    let dek = get_or_create_keychain_secret(APP_ID, "credential_encryption_key", 32)
        .map_err(|e| format!("Failed to get or create DEK from keychain: {}", e))?;

    let sidecar_command = app
        .shell()
        .sidecar("app-sidecar")
        .map_err(|e| format!("Failed to create sidecar command: {}", e))?
        .env("APP_DATA_PATH", app_data_dir.to_string_lossy().to_string())
        .env(
            "PUBLIC_RESOURCES_PATH",
            pub_resources_dir.to_string_lossy().to_string(),
        )
        .env("APODICTIC_RUNTIME_MODE", "local")
        .env("CREDENTIAL_ENCRYPTION_KEY", dek);

    let (mut rx, child) = sidecar_command
        .spawn()
        .map_err(|e| format!("Failed to spawn sidecar: {}", e))?;

    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            if let CommandEvent::Stdout(line) = event {
                println!("[Sidecar] {}", String::from_utf8_lossy(&line));
            } else if let CommandEvent::Stderr(line) = event {
                eprintln!("[Sidecar Error] {}", String::from_utf8_lossy(&line));
            }
        }
    });

    // Block logic until sidecar provides 200 OK
    println!("[Main] Waiting for sidecar to become healthy...");
    let client = Client::builder()
        .timeout(Duration::from_secs(1))
        .build()
        .unwrap();

    let mut attempts = 0;
    loop {
        attempts += 1;
        if let Ok(res) = client.get("http://127.0.0.1:3001/api/health").send() {
            if res.status().is_success() {
                match res.json::<SidecarHealth>() {
                    Ok(health) if is_expected_local_health(&health) => {
                        println!("[Main] Sidecar healthy in local/loopback mode!");
                        break;
                    }
                    Ok(_) | Err(_) => {
                        let kill_error = child.kill().err();
                        let suffix = kill_error
                            .map(|error| format!(" Failed to stop incompatible sidecar: {error}"))
                            .unwrap_or_default();
                        return Err(format!(
                            "Sidecar runtime contract mismatch; expected local/loopback health.{suffix}"
                        ));
                    }
                }
            }
        }
        if attempts > 60 {
            // Give up after 30 seconds
            eprintln!("[Main] Sidecar failed to report healthy within 30 seconds");
            let kill_error = child.kill().err();
            let suffix = kill_error
                .map(|error| format!(" Failed to stop unhealthy sidecar: {error}"))
                .unwrap_or_default();
            return Err(format!("Sidecar health check failed.{suffix}"));
        }
        std::thread::sleep(Duration::from_millis(500));
    }

    *app.state::<Sidecar>().0.lock().unwrap() = Some(child);
    Ok(())
}

/// Ask the release feed for a newer version and, if the user agrees, install it and restart.
/// Runs from Rust so the sidecar page never needs updater permissions. A failed check is logged
/// and otherwise ignored: an offline launch must still work.
fn check_for_update(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let update = match app.updater() {
            Ok(updater) => match updater.check().await {
                Ok(Some(update)) => update,
                Ok(None) => return,
                Err(error) => {
                    eprintln!("[Updater] Check failed: {error}");
                    return;
                }
            },
            Err(error) => {
                eprintln!("[Updater] Unavailable: {error}");
                return;
            }
        };
        let handle = app.clone();
        app.dialog()
            .message(format!(
                "APODICTIC {} is available. You have {}.\n\nInstall it now? APODICTIC will restart.",
                update.version, update.current_version
            ))
            .title("Update available")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "Install and restart".into(),
                "Later".into(),
            ))
            .show(move |install| {
                if !install {
                    return;
                }
                tauri::async_runtime::spawn(async move {
                    if let Some(child) = handle.state::<Sidecar>().0.lock().unwrap().take() {
                        let _ = child.kill();
                    }
                    match update.download_and_install(|_, _| {}, || {}).await {
                        Ok(()) => handle.restart(),
                        Err(error) => {
                            handle
                                .dialog()
                                .message(format!(
                                    "The update couldn't be installed: {error}\n\nRestart APODICTIC to keep using this version."
                                ))
                                .title("Update failed")
                                .kind(MessageDialogKind::Error)
                                .show(|_| {});
                        }
                    }
                });
            });
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Sidecar(Mutex::new(None)))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_stronghold::Builder::new(|password| {
                // We use SHA-256 here since `password` is already a 44-character B64 high entropy string
                // directly pulled from the OS Keychain.
                let mut hasher = Sha256::new();
                hasher.update(password.as_bytes());
                let result = hasher.finalize();
                let mut key = [0u8; 32];
                key.copy_from_slice(&result);
                key.to_vec()
            })
            .build(),
        )
        .invoke_handler(tauri::generate_handler![get_vault_password, open_browser])
        .setup(|app| {
            let result = start_sidecar(app.handle());

            // Dev Mode serves from localhost:3000 (Vite)
            // Prod Mode serves from localhost:3001 (Node Sidecar)
            // Note: Since Tauri limits window navigation dynamically, we might need 
            // to simply set a redirect script on the default html loaded, or eval:
            if !cfg!(debug_assertions) {
                if let Some(window) = app.get_webview_window("main") {
                    match result {
                        Ok(_) => {
                            println!("[Main] Redirecting window to local sidecar UI");
                            let _ = window.eval("window.location.replace('http://127.0.0.1:3001')");
                            check_for_update(app.handle().clone());
                        }
                        Err(e) => {
                            let error_html = format!("document.body.innerHTML = '<div style=\"padding:40px;font-family:sans-serif;color:white;background:#b91c1c;min-height:100vh;\"><h2>Startup Error</h2><p>{}</p></div>';", e);
                            let _ = window.eval(&error_html);
                        }
                    }
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{is_expected_local_health, resolve_keychain_secret, SidecarHealth, BASE64};
    use base64::Engine as _;
    use keyring::{credential::CredentialApi, mock::MockCredential, Entry, Error};
    use std::cell::Cell;

    fn read_errors() -> Vec<Error> {
        let ambiguous = MockCredential::default();
        ambiguous.set_password("ambiguous-secret-marker").unwrap();
        vec![
            Error::PlatformFailure(Box::new(std::io::Error::other("platform-secret-marker"))),
            Error::NoStorageAccess(Box::new(std::io::Error::other("access-secret-marker"))),
            Error::BadEncoding(b"encoding-secret-marker".to_vec()),
            Error::TooLong("attribute-secret-marker".to_string(), 12),
            Error::Invalid(
                "invalid-secret-marker".to_string(),
                "reason-secret-marker".to_string(),
            ),
            Error::Ambiguous(vec![Box::new(ambiguous)]),
        ]
    }

    #[test]
    fn existing_keychain_secret_is_returned_verbatim_without_effects() {
        for secret in ["", "existing-secret-marker", "\0unusual\n非base64"] {
            let entropy_calls = Cell::new(0);
            let store_calls = Cell::new(0);
            let result = resolve_keychain_secret(
                Ok(secret.to_string()),
                32,
                |_| entropy_calls.set(entropy_calls.get() + 1),
                |_| {
                    store_calls.set(store_calls.get() + 1);
                    Ok(())
                },
            );
            assert_eq!(result.unwrap(), secret);
            assert_eq!((entropy_calls.get(), store_calls.get()), (0, 0));
        }
    }

    #[test]
    fn missing_keychain_entry_generates_and_stores_once_at_requested_length() {
        for length in [0, 1, 32] {
            let entropy_calls = Cell::new(0);
            let store_calls = Cell::new(0);
            let expected = BASE64.encode(vec![0xa5; length]);
            let result = resolve_keychain_secret(
                Err(Error::NoEntry),
                length,
                |bytes| {
                    entropy_calls.set(entropy_calls.get() + 1);
                    assert_eq!(bytes.len(), length);
                    bytes.fill(0xa5);
                },
                |secret| {
                    store_calls.set(store_calls.get() + 1);
                    assert_eq!(secret, expected);
                    Ok(())
                },
            );
            assert_eq!(result.unwrap(), expected);
            assert_eq!((entropy_calls.get(), store_calls.get()), (1, 1));
        }
    }

    #[test]
    fn keychain_read_errors_refuse_creation_and_hide_payloads() {
        for error in read_errors() {
            let entropy_calls = Cell::new(0);
            let store_calls = Cell::new(0);
            let result = resolve_keychain_secret(
                Err(error),
                32,
                |_| entropy_calls.set(entropy_calls.get() + 1),
                |_| {
                    store_calls.set(store_calls.get() + 1);
                    Ok(())
                },
            );
            assert_eq!((entropy_calls.get(), store_calls.get()), (0, 0));
            assert_eq!(result.unwrap_err(), "Failed to read keychain secret.");
        }
    }

    #[test]
    fn keychain_store_failure_returns_sanitized_error_after_one_attempt() {
        for error in read_errors().into_iter().chain([Error::NoEntry]) {
            let entropy_calls = Cell::new(0);
            let store_calls = Cell::new(0);
            let result = resolve_keychain_secret(
                Err(Error::NoEntry),
                32,
                |bytes| {
                    entropy_calls.set(entropy_calls.get() + 1);
                    bytes.fill(0xa5);
                },
                |secret| {
                    store_calls.set(store_calls.get() + 1);
                    assert_eq!(secret, BASE64.encode([0xa5; 32]));
                    Err(error)
                },
            );
            assert_eq!((entropy_calls.get(), store_calls.get()), (1, 1));
            assert_eq!(result.unwrap_err(), "Failed to store keychain secret.");
        }
    }

    #[test]
    fn transient_keyring_read_error_preserves_existing_password() {
        let entry = Entry::new_with_credential(Box::new(MockCredential::default()));
        entry.set_password("existing-secret-marker").unwrap();
        let credential = entry
            .get_credential()
            .downcast_ref::<MockCredential>()
            .unwrap();
        credential.set_error(Error::NoStorageAccess(Box::new(std::io::Error::other(
            "transient-secret-marker",
        ))));
        let entropy_calls = Cell::new(0);
        let store_calls = Cell::new(0);
        let result = resolve_keychain_secret(
            entry.get_password(),
            32,
            |bytes| {
                entropy_calls.set(entropy_calls.get() + 1);
                bytes.fill(0xa5);
            },
            |secret| {
                store_calls.set(store_calls.get() + 1);
                entry.set_password(secret)
            },
        );
        assert_eq!(entry.get_password().unwrap(), "existing-secret-marker");
        assert_eq!((entropy_calls.get(), store_calls.get()), (0, 0));
        assert_eq!(result.unwrap_err(), "Failed to read keychain secret.");
    }

    #[test]
    fn accepts_only_exact_local_loopback_health() {
        assert!(is_expected_local_health(&SidecarHealth {
            runtime_mode: Some("local".to_string()),
            bind_scope: Some("loopback".to_string()),
        }));
        assert!(!is_expected_local_health(&SidecarHealth {
            runtime_mode: Some("hosted".to_string()),
            bind_scope: Some("all_interfaces".to_string()),
        }));
        assert!(!is_expected_local_health(&SidecarHealth {
            runtime_mode: None,
            bind_scope: None,
        }));
    }
}
