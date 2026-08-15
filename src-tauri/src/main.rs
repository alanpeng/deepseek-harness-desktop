#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod deep_link;
mod host;
mod tray;

use tauri::{Manager, RunEvent};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second launch was requested: hand any dshdesktop:// URL over
            // to the running instance (logged; the web app has no routing yet)
            // and surface the window. The plugin exits the second instance.
            if let Some(url) = deep_link::parse_deep_link(&argv) {
                eprintln!("[dsh-desktop] deep link (second instance): {url}");
            }
            deep_link::activate(app);
        }))
        .manage(host::HostState::default())
        .setup(|app| {
            // Keep the dshdesktop:// registration pointing at this exe.
            if let Ok(exe) = std::env::current_exe() {
                deep_link::register_protocol(&exe);
            }
            let args: Vec<String> = std::env::args().skip(1).collect();
            if let Some(url) = deep_link::parse_deep_link(&args) {
                eprintln!("[dsh-desktop] deep link (cold start): {url}");
            }
            match host::start_host(app.handle()) {
                Ok(port) => {
                    let url = format!("http://127.0.0.1:{port}").parse().unwrap();
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.navigate(url);
                        let _ = window.show();
                    }
                }
                Err(err) => {
                    eprintln!("[dsh-desktop] host start failed: {err}");
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.navigate(splash_error_url(&err));
                        let _ = window.show();
                    }
                }
            }
            tray::setup_tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<host::HostState>();
                if !state.quitting.load(std::sync::atomic::Ordering::SeqCst) {
                    // Close to tray: hide instead of quitting.
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| match event {
            RunEvent::ExitRequested { .. } => host::kill_host(app),
            _ => {}
        });
}

/// Percent-encode a string for a query value (RFC 3986 unreserved chars only).
fn url_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// Error page URL: the dev splash server in dev builds, the bundled page in release.
pub(crate) fn splash_error_url(message: &str) -> tauri::Url {
    let base = if cfg!(debug_assertions) {
        "http://127.0.0.1:1420"
    } else {
        // Windows' default Tauri 2 asset protocol; `tauri://localhost` is
        // macOS-only and navigates to a dead URL (blank window) on Windows.
        "http://tauri.localhost"
    };
    format!("{base}/?error={}", url_encode(message)).parse().unwrap()
}
