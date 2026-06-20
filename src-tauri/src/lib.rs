use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use keyring::Entry;
use rand::RngCore;
use reqwest::blocking::Client;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

const APP_ID: &str = "com.anotherpanacea.apodictic";

/// Securely get an existing 32-byte B64 string from OS Keychain, or generate a high-entropy one.
fn get_or_create_keychain_secret(
    service: &str,
    user: &str,
    length: usize,
) -> Result<String, String> {
    let entry = Entry::new(service, user).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(pw) => Ok(pw),
        Err(_) => {
            // Cryptographically secure OS entropy — NOT fastrand (explicitly non-cryptographic).
            // These bytes back the Stronghold vault key and the credential-encryption DEK, so a
            // CSPRNG is required (Codex P1, 2026-06-19).
            let mut random_bytes = vec![0u8; length];
            rand::rngs::OsRng.fill_bytes(&mut random_bytes);
            let secret = BASE64.encode(&random_bytes);
            entry.set_password(&secret).map_err(|e| e.to_string())?;
            Ok(secret)
        }
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
        .env("CREDENTIAL_ENCRYPTION_KEY", dek);

    let (mut rx, mut _child) = sidecar_command
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
                println!("[Main] Sidecar healthy!");
                break;
            }
        }
        if attempts > 60 {
            // Give up after 30 seconds
            eprintln!("[Main] Sidecar failed to report healthy within 30 seconds");
            return Err("Sidecar health check failed".to_string());
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
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
