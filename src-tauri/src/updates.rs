//! Update orchestration: runtime channel first (fast npm query, hot-swap),
//! then the shell channel (tauri-plugin-updater, full reinstall).
//!
//! Startup check is silent — a newer runtime is applied automatically
//! (the swap + host restart is invisible enough to be safe at launch), a
//! newer shell only updates the tray status text. The manual tray check
//! asks before doing anything.

use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::time::Duration;

use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult};
use tauri_plugin_updater::UpdaterExt;

use crate::host;
use crate::runtime_update;

/// Managed by Tauri. `lock` serializes ALL update work (shell + runtime) and
/// the tray host restart, so a swap can never race a manual restart.
/// tokio Mutex: the guard is held across awaits in check_all and must be Send.
pub struct UpdateState {
    pub lock: tokio::sync::Mutex<()>,
    /// Handle to the tray status item, for live progress text.
    pub status_item: std::sync::Mutex<Option<MenuItem<tauri::Wry>>>,
}

impl Default for UpdateState {
    fn default() -> Self {
        Self {
            lock: tokio::sync::Mutex::new(()),
            status_item: std::sync::Mutex::new(None),
        }
    }
}

/// Update the tray status line (no-op when the item handle isn't stored yet).
pub fn set_tray_status(app: &AppHandle, text: &str) {
    let state = app.state::<UpdateState>();
    let guard = state.status_item.lock().unwrap();
    if let Some(item) = guard.as_ref() {
        let _ = item.set_text(text);
    }
}

/// Blocking yes/no dialog, run off the main thread (dialog plugin requirement).
fn ask(app: &AppHandle, title: &str, message: &str, yes: &str, no: &str) -> bool {
    let (tx, rx) = mpsc::channel();
    let app2 = app.clone();
    // Own the strings: the worker thread requires 'static. Clone into the
    // thread; the owned copies stay alive here for the label comparison.
    let title = title.to_string();
    let message = message.to_string();
    let yes_owned = yes.to_string();
    let no_owned = no.to_string();
    let yes_thread = yes_owned.clone();
    let no_thread = no_owned.clone();
    std::thread::spawn(move || {
        let result = app2
            .dialog()
            .message(message)
            .title(title)
            .kind(MessageDialogKind::Info)
            // Two buttons only: rfd's YesNoCancelCustom mapping proved
            // unreliable on Windows (Yes-button click returned non-Yes).
            // OkCancelCustom keeps an unambiguous OK path.
            .buttons(MessageDialogButtons::OkCancelCustom(
                yes_thread,
                no_thread,
            ))
            .blocking_show_with_result();
        let _ = tx.send(result);
    });
    let result = rx.recv();
    log(&format!("ask() raw result: {result:?}"));
    // rfd returns Custom(button text) for text-customised buttons, never
    // Ok/Yes — match on the affirmative label (verified via ask() raw log:
    // clicking the "下载" button yields Ok(Custom("下载"))).
    match result {
        Ok(MessageDialogResult::Custom(t)) => t.as_str() == yes_owned.as_str(),
        Ok(MessageDialogResult::Ok) | Ok(MessageDialogResult::Yes) => true,
        _ => false,
    }
}

/// Non-blocking info/error dialog.
fn info(app: &AppHandle, title: &str, message: &str, kind: MessageDialogKind) {
    let app2 = app.clone();
    let message = message.to_string();
    let title = title.to_string();
    tauri::async_runtime::spawn(async move {
        app2.dialog()
            .message(message)
            .title(title)
            .kind(kind)
            .show(|_| {});
    });
}

/// Log a line to host.log (same sink as the host sidecar).
fn log(line: &str) {
    if let Some(mut f) = host::log_file() {
        use std::io::Write;
        let _ = writeln!(f, "[update] {line}");
    }
}

/// Called from setup(): waits 15 s, then a fully silent check.
pub fn startup_auto_check(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(15));
        tauri::async_runtime::block_on(check_all(app, false));
    });
}

/// Runtime phase first (fast), shell phase second. `manual` toggles dialogs
/// and auto-apply behaviour.
pub async fn check_all(app: AppHandle, manual: bool) {
    let state = app.state::<UpdateState>();
    let Ok(_guard) = state.lock.try_lock() else {
        if manual {
            info(&app, "检查更新", "正在执行其他更新操作，请稍后再试", MessageDialogKind::Info);
        }
        return;
    };

    // ── 1. runtime channel ────────────────────────────────────────────────
    let bundled = runtime_update::bundled_dsh_version(&host::exe_dir().unwrap_or_default())
        .map(|v| v.to_string())
        .unwrap_or_else(|e| format!("未知（{e}）"));
    match runtime_update::check_runtime_update(&app).await {
        Ok(Some(v)) => {
            log(&format!("runtime update available: {bundled} -> {v}"));
            if manual {
                let msg = format!(
                    "检测到 dsh 运行时更新 {bundled} → {v}\n更新期间 Host 会短暂重启。\n\n立即更新？"
                );
                if ask(&app, "发现运行时更新", &msg, "立即更新", "稍后") {
                    apply_runtime(&app, &v, false).await;
                }
            } else {
                // Silent startup path: apply without asking.
                log("auto-applying runtime update (startup check)");
                apply_runtime(&app, &v, true).await;
            }
        }
        Ok(None) => log("runtime up to date"),
        Err(e) => {
            log(&format!("runtime check failed: {e}"));
            if manual {
                info(&app, "检查更新", &format!("运行时更新检查失败：\n{e}"), MessageDialogKind::Error);
            }
        }
    }

    // ── 2. shell channel ──────────────────────────────────────────────────
    let pkg_version = app.package_info().version.to_string();
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            log(&format!("updater init failed: {e}"));
            if manual {
                info(&app, "检查更新", &format!("更新检查失败：\n{e}"), MessageDialogKind::Error);
            }
            return;
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            log(&format!(
                "shell update available: {} -> {}",
                update.current_version, update.version
            ));
            if !manual {
                // Silent: just flag it on the tray.
                set_tray_status(&app, &format!("发现新版本 v{}（托盘检查更新）", update.version));
                return;
            }
            let msg = format!(
                "发现新版本 dsh-desktop {}\n当前版本：{}\n捆绑 dsh 运行时：{}\n\n是否下载？",
                update.version, update.current_version, bundled
            );
            let download_now = ask(&app, "发现新版本", &msg, "下载", "取消");
            log(&format!("shell dialog result: download_now={download_now}"));
            if !download_now {
                return;
            }
            set_tray_status(&app, "正在下载更新…");
            let app3 = app.clone();
            let bytes = match update
                .download(
                    move |chunk, total| {
                        let mb = chunk as u64 / 1_048_576;
                        match total.map(|t| t as u64 / 1_048_576) {
                            Some(t) => set_tray_status(&app3, &format!("正在下载更新… {mb}/{t} MB")),
                            None => set_tray_status(&app3, &format!("正在下载更新… {mb} MB")),
                        }
                    },
                    || {},
                )
                .await
            {
                Ok(b) => {
                    log(&format!("shell download finished: {} bytes", b.len()));
                    b
                }
                Err(e) => {
                    log(&format!("shell download failed: {e}"));
                    set_tray_status(&app, "Host: 运行中");
                    info(&app, "下载失败", &format!("更新下载失败：\n{e}"), MessageDialogKind::Error);
                    return;
                }
            };
            set_tray_status(&app, "Host: 运行中");
            let mb = bytes.len() / 1_048_576;
            let msg = format!("更新已下载（约 {mb} MB）。\n立即安装？应用将自动重启。");
            if ask(&app, "下载完成", &msg, "安装并重启", "稍后") {
                // The updater plugin hard-exits the process after launching the
                // NSIS installer — RunEvent::ExitRequested never fires, so the
                // host must die here or the installer hits locked runtime files.
                let hs = app.state::<host::HostState>();
                hs.quitting.store(true, Ordering::SeqCst);
                host::kill_host(&app);
                let _ = update.install(bytes);
            }
        }
        Ok(None) => {
            if manual {
                let msg = format!("已是最新版本\n桌面壳 {pkg_version} · dsh 运行时 {bundled}");
                info(&app, "检查更新", &msg, MessageDialogKind::Info);
            }
        }
        Err(e) => {
            log(&format!("shell check failed: {e}"));
            if manual {
                info(&app, "检查更新", &format!("更新检查失败：\n{e}"), MessageDialogKind::Error);
            }
        }
    }
}

async fn apply_runtime(app: &AppHandle, v: &semver::Version, silent: bool) {
    match runtime_update::apply_runtime_update(app, v).await {
        Ok(()) => log("runtime update applied"),
        Err(e) => {
            log(&format!("runtime update failed: {e}"));
            // Startup auto-apply failures must not pop a dialog on an idle
            // user — the silent path only logs (retried next launch).
            if !silent {
                info(app, "运行时更新失败", &e, MessageDialogKind::Error);
            }
            set_tray_status(app, "Host: 运行中");
        }
    }
}
