//! System tray: host status, show/hide, check updates, restart, open the data dir, quit.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

use crate::host;
use crate::runtime_update;
use crate::updates;

pub fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let status = MenuItem::with_id(app, "status", "Host: 运行中", false, None::<&str>)?;
    // Hand the status item to the update flows so they can publish live text.
    let ustate = app.state::<updates::UpdateState>();
    *ustate.status_item.lock().unwrap() = Some(status.clone());

    let check = MenuItem::with_id(app, "check-update", "检查更新…", true, None::<&str>)?;
    let version_info = MenuItem::with_id(app, "version-info", "版本信息…", true, None::<&str>)?;
    let about = MenuItem::with_id(app, "about", "关于…", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "显示 / 隐藏", true, None::<&str>)?;
    let restart = MenuItem::with_id(app, "restart", "重启 Host", true, None::<&str>)?;
    let open_home = MenuItem::with_id(app, "open-home", "打开 DSH Home", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&status, &separator, &check, &version_info, &about, &separator, &toggle, &restart, &open_home, &separator, &quit],
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
            "version-info" => {
                // Shell version + bundled dsh version + latest npm version
                // (registry query fails fast; the dialog still shows the rest).
                let app2 = app.clone();
                tauri::async_runtime::spawn(async move {
                    let shell = app2.package_info().version.to_string();
                    let bundled = runtime_update::bundled_dsh_version(&host::exe_dir().unwrap_or_default())
                        .map(|v| v.to_string())
                        .unwrap_or_else(|e| format!("未知（{e}）"));
                    let latest = match runtime_update::check_runtime_update(&app2).await {
                        Ok(Some(v)) => v.to_string(),
                        Ok(None) => bundled.clone(),
                        Err(_) => "查询失败".to_string(),
                    };
                    updates::info(
                        &app2,
                        "版本信息",
                        &format!(
                            "桌面壳：v{shell}\n捆绑 dsh 运行时：{bundled}\nnpm 最新版本：{latest}"
                        ),
                        tauri_plugin_dialog::MessageDialogKind::Info,
                    );
                });
            }
            "about" => {
                updates::info(
                    app,
                    "关于",
                    "DeepSeek Harness 桌面壳（dsh-desktop）\n\n作者：Alan（peng.alan@gmail.com）\n开发工具：DeepSeek-V4-Flash + Claude Code",
                    tauri_plugin_dialog::MessageDialogKind::Info,
                );
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
