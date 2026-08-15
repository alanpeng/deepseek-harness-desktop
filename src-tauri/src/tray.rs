//! System tray: host status, show/hide, check updates, restart, open the data dir, quit.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::host;
use crate::updates;

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", "Host: 运行中", false, None::<&str>)?;
    // Hand the status item to the update flows so they can publish live text.
    let ustate = app.state::<updates::UpdateState>();
    *ustate.status_item.lock().unwrap() = Some(status.clone());

    let check = MenuItem::with_id(app, "check-update", "检查更新…", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "显示 / 隐藏", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "重启 Host", true, None::<&str>)?;
    let open_home = MenuItem::with_id(app, "open-home", "打开 DSH Home", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&status, &separator, &check, &toggle, &restart, &open_home, &separator, &quit],
    )?;

    let _tray = TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().expect("default window icon").clone())
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => toggle_window(app),
            "check-update" => {
                tauri::async_runtime::spawn(updates::check_all(app.clone(), true));
            }
            "restart" => {
                // If an update swap is in flight, ignore the click rather than
                // racing it (the host would come back under a new runtime).
                let ustate = app.state::<updates::UpdateState>();
                if ustate.lock.try_lock().is_err() {
                    return;
                }
                match host::restart_host(app) {
                    Ok(_port) => updates::set_tray_status(app, "Host: 运行中"),
                    Err(err) => {
                        eprintln!("[dsh-desktop] restart failed: {err}");
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.navigate(crate::splash_error_url(&err));
                            let _ = window.show();
                        }
                    }
                }
            }
            "open-home" => {
                // Opener plugin (capability-gated) instead of a raw explorer spawn:
                // reveals the folder and selects it in the file manager.
                let _ = tauri_plugin_opener::open_path(host::dsh_home(), None::<&str>);
            }
            "quit" => {
                host::kill_host(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => toggle_window(tray.app_handle()),
            // Windows convention: double-click also toggles the window.
            TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => toggle_window(tray.app_handle()),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

fn toggle_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
}
