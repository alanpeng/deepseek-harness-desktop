//! `dshdesktop://` protocol: HKCU registration (no admin needed), argv
//! parsing, and window activation.
//!
//! Windows-only module: HKCU registration needs winreg, which does not
//! compile on other platforms. Declared as #[cfg(windows)] in main.rs.
#![cfg(windows)]
//!
//! The dsh web app is a state-driven SPA without URL routing, so a deep link
//! currently means "bring the window to the foreground" — the URL itself is
//! logged and kept for a future client routing integration. Navigation is
//! deliberately NOT repeated on activation: reloading the page would discard
//! in-progress UI state for no routing gain.

use std::path::Path;

use tauri::{AppHandle, Manager};
use winreg::enums::{HKEY_CURRENT_USER, KEY_WRITE};
use winreg::RegKey;

pub const PROTOCOL: &str = "dshdesktop";

/// Register the running exe as the handler for `dshdesktop://` under HKCU.
/// Idempotent and re-run on every launch so an updated/moved install keeps a
/// current command line. HKCU\Software\Classes needs no elevation.
pub fn register_protocol(exe: &Path) {
    let exe_quoted = format!("\"{}\"", exe.display());
    let classes = match RegKey::predef(HKEY_CURRENT_USER).open_subkey_with_flags(
        "Software\\Classes",
        KEY_WRITE,
    ) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("[dsh-desktop] cannot open HKCU\\Software\\Classes: {e}");
            return;
        }
    };
    // Root class entry marks this as a URL protocol for the OS.
    let class = match classes.create_subkey(PROTOCOL) {
        Ok((k, _)) => k,
        Err(e) => {
            eprintln!("[dsh-desktop] cannot create protocol key: {e}");
            return;
        }
    };
    let _ = class.set_value("", &"URL:dshdesktop Protocol");
    let _ = class.set_value("URL Protocol", &"");
    // DefaultIcon shows the app icon for protocol links in Explorer etc.
    let _ = class
        .create_subkey("DefaultIcon")
        .and_then(|(icon, _)| icon.set_value("", &format!("{exe_quoted},0")));
    // "%1" receives the full dshdesktop:// URL from the OS.
    let _ = class.create_subkey("shell").and_then(|(shell, _)| {
        shell.create_subkey("open").and_then(|(open, _)| {
            open.create_subkey("command")
                .and_then(|(command, _)| command.set_value("", &format!("{exe_quoted} \"%1\"")))
        })
    });
}

/// Find a `dshdesktop://...` argument in a process argv (what the OS passes
/// when the protocol is invoked on a cold start, or a second instance passes
/// through to the first).
pub fn parse_deep_link(argv: &[String]) -> Option<String> {
    argv.iter().find(|a| a.starts_with(&format!("{PROTOCOL}://"))).cloned()
}

/// Show and focus the main window (no-op if already visible).
pub fn activate(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if !window.is_visible().unwrap_or(true) {
            let _ = window.show();
        }
        let _ = window.set_focus();
    }
}
