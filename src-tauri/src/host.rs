//! Host process management: pick a free port, spawn the dsh web host,
//! wait until it listens, and tear the process tree down on exit.

use std::fs::{create_dir_all, File, OpenOptions};
use std::io::Write;
use std::net::{TcpListener, TcpStream};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// Platform node binary name inside dsh-runtime/ (shared with runtime_update).
#[cfg(windows)]
pub const NODE_BIN: &str = "node.exe";
#[cfg(not(windows))]
pub const NODE_BIN: &str = "node";

/// User home directory (shared with runtime_update's data-root resolution).
#[cfg(windows)]
pub fn user_home() -> PathBuf {
    PathBuf::from(std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into()))
}
#[cfg(not(windows))]
pub fn user_home() -> PathBuf {
    PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| ".".into()))
}

/// Shared data root for dsh_home: %APPDATA% on Windows, XDG data dir elsewhere.
#[cfg(windows)]
pub fn data_root() -> PathBuf {
    PathBuf::from(std::env::var("APPDATA").unwrap_or_else(|_| ".".into()))
}
#[cfg(not(windows))]
pub fn data_root() -> PathBuf {
    std::env::var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| user_home().join(".local").join("share"))
}

/// Shared host state managed by Tauri.
pub struct HostState {
    /// Port the web host was spawned on (Some once the host is up).
    pub port: Mutex<Option<u16>>,
    /// Live host child process, if any.
    pub child: Mutex<Option<CommandChild>>,
    /// Web URL announced by the sidecar's `dsh web:` line (token-carrying on
    /// 0.1.2+, bare on older hosts). None until that line is seen.
    pub web_url: Mutex<Option<String>>,
    /// Set when the user chose to quit; window close then exits instead of hiding.
    pub quitting: AtomicBool,
}

impl Default for HostState {
    fn default() -> Self {
        Self {
            port: Mutex::new(None),
            child: Mutex::new(None),
            web_url: Mutex::new(None),
            quitting: AtomicBool::new(false),
        }
    }
}

/// `%APPDATA%\dsh-desktop\dsh-home` — all harness state lives here so the app
/// install directory stays read-only and dsh keeps its self-update capability
/// (creator mode, preset authoring, plugin install, settings).
pub fn dsh_home() -> PathBuf {
    data_root().join("dsh-desktop").join("dsh-home")
}

/// Directory holding the installed executable — Windows keeps bundle resources
/// (`dsh-runtime/`) next to the exe. Derived from `current_exe` (not
/// `resource_dir()`, which returns `\\?\`-verbatim-prefixed paths that break
/// node's argv parsing).
pub fn exe_dir() -> Result<PathBuf, String> {
    std::env::current_exe()
        .map_err(|e| e.to_string())?
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "failed to locate executable directory".to_string())
}

/// The ACTIVE runtime directory (`dsh-runtime/` containing node + the deploy
/// tree), resolved per platform:
///
/// - Windows: bundle resources sit next to the exe (tauri-utils platform.rs);
///   `resource_dir()` there returns `\\?\`-verbatim paths that break node's
///   argv parsing, so derive from `current_exe`.
/// - Linux/macOS: tauri bundles resources under `<exe>/../lib/<product>`
///   (deb: `/usr/lib/dsh-desktop`, AppImage: `$APPDIR/usr/lib/dsh-desktop`,
///   macOS: `.app/Contents/Resources`). The bundle dir is root-owned, so
///   runtime self-updates land in `runtime_overlay_dir()` instead — once that
///   overlay is populated it shadows the bundle.
pub fn runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let bundle = if cfg!(windows) {
        exe_dir()?.join("dsh-runtime")
    } else {
        app.path()
            .resource_dir()
            .map_err(|e| e.to_string())?
            .join("dsh-runtime")
    };
    if cfg!(windows) {
        return Ok(bundle);
    }
    let overlay = runtime_overlay_dir();
    if overlay.join("entry.mjs").exists() {
        Ok(overlay)
    } else {
        Ok(bundle)
    }
}

/// User-writable runtime overlay — the target of runtime self-updates on
/// Linux/macOS, where the bundled `dsh-runtime/` is root-owned. Sits next to
/// `dsh_home()` under the shared data root.
pub fn runtime_overlay_dir() -> PathBuf {
    data_root().join("dsh-desktop").join("dsh-runtime")
}

/// Dev-mode clone location (see start_host). Shared with the version probe.
fn dev_clone_dir() -> PathBuf {
    std::env::var("DSH_DESKTOP_CLONE")
        .map(PathBuf::from)
        .unwrap_or_else(|_| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("..")
                .join("..")
                .join("deepseek-harness")
        })
}

/// Parse `(major, minor, patch)` from a package.json's `"version"` field.
/// Segment 3 may carry a prerelease suffix (e.g. `0.1.2-rc.1`) — only the
/// leading digits are read. `None` when no parseable version is found.
fn parse_dsh_version(json: &str) -> Option<(u32, u32, u32)> {
    let mut rest = json;
    while let Some(at) = rest.find("\"version\"") {
        rest = &rest[at + "\"version\"".len()..];
        let after = rest.trim_start_matches(|c: char| c.is_whitespace());
        let Some(after_colon) = after.strip_prefix(':') else { continue };
        let quoted = after_colon.trim_start_matches(|c: char| c.is_whitespace());
        let Some(after_quote) = quoted.strip_prefix('"') else { continue };
        let end = after_quote.find('"')?;
        let seg = |s: &str| -> Option<u32> {
            let digits: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
            digits.parse().ok()
        };
        let mut parts = after_quote[..end].split('.');
        let (maj, min, pat) = (seg(parts.next()?)?, seg(parts.next()?)?, seg(parts.next()?)?);
        return Some((maj, min, pat));
    }
    None
}

/// Read the dsh package version of the runtime this build will spawn — dev:
/// the clone's workspace install (pnpm links it under root node_modules);
/// release: the bundled/overlay runtime tree, same layout start_host spawns.
fn runtime_dsh_version(app: &AppHandle) -> Option<(u32, u32, u32)> {
    let pj = if cfg!(debug_assertions) {
        dev_clone_dir()
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("package.json")
    } else {
        runtime_dir(app).ok()?.join("node_modules").join("@deepseek-ai").join("dsh").join("package.json")
    };
    parse_dsh_version(&std::fs::read_to_string(pj).ok()?)
}

/// Whether the runtime about to spawn speaks the 0.1.2+ web contract:
/// accepts `--no-open` and prints a token-carrying `dsh web:` URL.
/// 0.1.2-rc.1 introduced the launch-token auth AND the flag together; older
/// runtimes may reject unknown flags (commander is strict), so never pass
/// `--no-open` to them — their bare-URL behavior is what the shell already
/// targets. Missing/unreadable version metadata counts as old.
fn runtime_auth_capable(app: &AppHandle) -> bool {
    runtime_dsh_version(app).is_some_and(|(maj, min, pat)| (maj, min, pat) >= (0, 1, 2))
}

/// Append host sidecar output to `%APPDATA%\dsh-desktop\dsh-home\logs\host.log`.
/// The GUI app has no console, so this file is the only place a clean-machine
/// failure can be inspected after the fact.
pub fn log_file() -> Option<File> {
    let dir = dsh_home().join("logs");
    create_dir_all(&dir).ok()?;
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("host.log"))
        .ok()
}

/// Unix-ish timestamp for log lines (no chrono dep).
fn now_ts() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "?".into())
}

/// Pick an unused loopback port by binding port 0 and reading what the OS gave.
pub fn pick_free_port() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind 127.0.0.1:0");
    listener.local_addr().expect("local_addr").port()
}

/// Poll until something accepts TCP connections on the port (i.e. the host is listening).
pub fn wait_ready(port: u16, timeout: Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

/// Extract the web URL from a sidecar stdout line, if it announces OUR port.
///
/// 0.1.2+ hosts print `dsh web: http://127.0.0.1:<port>/?token=<X>` once their
/// Loader tree settles — the readiness signal that the auth middleware is
/// mounted and the launch token is available. Older hosts print the same line
/// without the token query. The line may carry a ` (LAN: …)` suffix; the URL
/// ends at the first whitespace.
fn parse_web_url_line(line: &str, port: u16) -> Option<String> {
    let marker = format!("http://127.0.0.1:{port}");
    let start = line.find(&marker)?;
    let rest = &line[start..];
    let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
    Some(rest[..end].to_string())
}

/// Spawn the dsh web host and return its port once it is listening.
pub fn start_host(app: &AppHandle) -> Result<u16, String> {
    let port = pick_free_port();

    // A previous process's announced URL must never leak into this launch —
    // clear it before spawning so navigate_web only ever sees this child's
    // `dsh web:` line (its token is process-scoped).
    {
        let state = app.state::<HostState>();
        *state.web_url.lock().unwrap() = None;
    }

    let mut command = if cfg!(debug_assertions) {
        // Dev: run the CLI bin from the dsh clone under the system Node.
        // Override the clone location with DSH_DESKTOP_CLONE when needed.
        let clone = dev_clone_dir();
        let bin = clone.join("apps").join("cli").join("lib").join("bin.js");
        if !bin.exists() {
            return Err(format!(
                "dsh CLI bin not found at {} (build the clone first, or set DSH_DESKTOP_CLONE)",
                bin.display()
            ));
        }
        let mut c = app.shell().command("node");
        c = c.arg(bin.to_str().unwrap().to_string());
        c
    } else {
        // Release: bundled stock Node + deploy tree in resources/dsh-runtime.
        // The host is a directory, not a packaged exe — dsh is a cordis plugin
        // host whose runtime plugin resolution (dynamic import) cannot work
        // inside pkg-style snapshots, so we ship real node + node_modules.
        // Windows keeps bundle resources in the executable's own directory
        // (tauri-utils platform.rs: "Windows also includes the resources in
        // the executable folder"), so derive the runtime dir from current_exe
        // instead of app.path().resource_dir() — that resolver returns
        // `\\?\`-verbatim-prefixed paths, and node's argv parsing breaks on
        // them (clean machine: EISDIR lstat 'C:' because `\\?\C:\...` comes
        // apart during CommandLineToArgvW-style splitting). Linux/macOS
        // bundle resources under `<exe>/../lib/<product>` (deb:
        // /usr/lib/dsh-desktop, AppImage: $APPDIR/usr/lib/dsh-desktop),
        // resolved by runtime_dir() — with the user-writable overlay
        // shadowing the bundle once a self-update landed.
        let dir = runtime_dir(app)?;
        let node = dir.join(NODE_BIN);
        if !node.exists() {
            return Err(format!(
                "dsh runtime not found at {} (resources missing from install?)",
                node.display()
            ));
        }
        let mut c = app.shell().command(node.to_str().unwrap().to_string());
        c = c.arg(dir.join("entry.mjs").to_str().unwrap().to_string());
        c
    };

    command = command
        .arg("--profile")
        .arg("web")
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string());
    // 0.1.2+ hosts open the default browser after announcing unless told not
    // to — wrong for a desktop shell whose window IS the browser. Gated on the
    // runtime version: older runtimes may reject the unknown flag outright.
    if runtime_auth_capable(app) {
        command = command.arg("--no-open");
    }
    command = command
        .env("DSH_HOME", dsh_home().to_str().unwrap_or("."))
        .env("DSH_TELEMETRY_DISABLED", "1")
        .current_dir(user_home());

    let (mut rx, child) = command.spawn().map_err(|e| e.to_string())?;

    // Shared tail buffer: the last sidecar output, surfaced in the error
    // message if the host never comes up (splash page shows the real cause).
    let tail: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));

    // Drain the child's stdout/stderr, mirror it to the console, persist it to
    // logs/host.log, and clear state when it terminates. The shell plugin's
    // receiver is async; drain it on the Tauri runtime.
    {
        let app2 = app.clone();
        let tail2 = Arc::clone(&tail);
        tauri::async_runtime::spawn(async move {
            let mut file = log_file();
            let mut record = |tag: &str, line: &str| {
                let line = line.trim_end_matches(['\n', '\r']);
                let full = format!("[{tag}] {line}\n");
                if let Some(f) = file.as_mut() {
                    let _ = write!(f, "{} {full}", now_ts());
                }
                let mut t = tail2.lock().unwrap();
                if t.len() > 8192 {
                    t.clear(); // keep only the most recent output
                }
                t.push_str(&full);
            };
            loop {
                match rx.recv().await {
                    Some(CommandEvent::Terminated(payload)) => {
                        let state = app2.state::<HostState>();
                        *state.child.lock().unwrap() = None;
                        record("host", &format!("terminated: {payload:?}"));
                        eprintln!("[dsh-desktop] host terminated: {payload:?}");
                        break;
                    }
                    Some(CommandEvent::Stdout(line)) => {
                        let line = String::from_utf8_lossy(&line);
                        println!("[host] {line}");
                        record("host", &line);
                        // The `dsh web:` announce (bare on old hosts, token-
                        // carrying on 0.1.2+) is the readiness signal navigate_web
                        // waits on — record the first one for our port.
                        if let Some(url) = parse_web_url_line(&line, port) {
                            let state = app2.state::<HostState>();
                            let mut slot = state.web_url.lock().unwrap();
                            if slot.is_none() {
                                *slot = Some(url);
                            }
                        }
                    }
                    Some(CommandEvent::Stderr(line)) => {
                        let line = String::from_utf8_lossy(&line);
                        eprintln!("[host-err] {line}");
                        record("host-err", &line);
                    }
                    Some(_) => {}
                    None => break,
                }
            }
        });
    }

    {
        let state = app.state::<HostState>();
        *state.child.lock().unwrap() = Some(child);
        *state.port.lock().unwrap() = Some(port);
    }

    if !wait_ready(port, Duration::from_secs(60)) {
        // Tear the sidecar down so a tray restart starts from a clean state,
        // and report what the sidecar actually printed (if anything) — on a
        // clean machine that output is the only clue to what went wrong.
        kill_host(app);
        let tail = tail.lock().unwrap().clone();
        let tail = if tail.trim().is_empty() {
            "no sidecar output captured".to_string()
        } else {
            tail
        };
        return Err(format!(
            "dsh host did not start listening on port {port} within 60s.\nLast sidecar output:\n{tail}"
        ));
    }
    Ok(port)
}

/// Kill the host and its whole child-process tree (shell tools spawn grandchildren).
pub fn kill_host(app: &AppHandle) {
    let state = app.state::<HostState>();
    let child = state.child.lock().unwrap().take();
    if let Some(child) = child {
        let pid = child.pid();
        #[cfg(windows)]
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW — no console flash
            .status();
        #[cfg(not(windows))]
        {
            // Kill children first (pkill -P), then the parent via child.kill().
            let _ = std::process::Command::new("pkill")
                .args(["-TERM", "-P", &pid.to_string()])
                .status();
        }
        let _ = child.kill();
    }
}

/// Once the sidecar's `dsh web:` line arrives, navigate the window to it.
///
/// The 0.1.2+ launch token (`…/?token=…`) exists only in that line, and the
/// line itself only prints after the Loader tree settles — i.e. once the auth
/// middleware is mounted. Navigating before it would either race past auth
/// (serving the index without minting the cookie, then 401 on any reload) or
/// hit the bare-URL 401 wall head-on. Older hosts print the same line without
/// a token, so the stored URL works for every runtime. Falls back to the bare
/// URL after a timeout so a silent host still gets a window.
pub fn navigate_web(app: &AppHandle, port: u16) {
    let app = app.clone();
    std::thread::spawn(move || {
        let state = app.state::<HostState>();
        let deadline = std::time::Instant::now() + Duration::from_secs(45);
        let url = loop {
            {
                let slot = state.web_url.lock().unwrap();
                if let Some(url) = slot.clone() {
                    break url;
                }
            }
            if std::time::Instant::now() >= deadline {
                eprintln!("[dsh-desktop] no 'dsh web:' announce within 45s; navigating bare");
                break format!("http://127.0.0.1:{port}");
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        if let Some(window) = app.get_webview_window("main") {
            if let Ok(parsed) = url.parse::<tauri::Url>() {
                let _ = window.navigate(parsed);
            }
            let _ = window.show();
        }
    });
}

/// Kill, respawn, and re-navigate the window to the new host port.
/// Shared by the tray "restart" item and the runtime hot-update swap.
/// On failure the window is pointed at the splash error page.
pub fn restart_host(app: &AppHandle) -> Result<u16, String> {
    kill_host(app);
    let port = start_host(app)?;
    navigate_web(app, port);
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_token_url_line() {
        let line = "dsh web: http://127.0.0.1:1852/?token=LElOpXIzwnSGLI2ej8qv99nSMo9X2C2ViDv2dR3jf8s";
        assert_eq!(
            parse_web_url_line(line, 1852),
            Some("http://127.0.0.1:1852/?token=LElOpXIzwnSGLI2ej8qv99nSMo9X2C2ViDv2dR3jf8s".to_string())
        );
    }

    #[test]
    fn parses_bare_url_line() {
        // 0.1.1-era hosts announce without a token.
        assert_eq!(
            parse_web_url_line("dsh web: http://127.0.0.1:1852", 1852),
            Some("http://127.0.0.1:1852".to_string())
        );
    }

    #[test]
    fn cuts_lan_suffix() {
        let line = "dsh web: http://127.0.0.1:1852/?token=abc_XYZ-9 (LAN: http://10.0.0.4:1852/?token=abc_XYZ-9)";
        assert_eq!(
            parse_web_url_line(line, 1852),
            Some("http://127.0.0.1:1852/?token=abc_XYZ-9".to_string())
        );
    }

    #[test]
    fn ignores_other_ports_and_unrelated_lines() {
        assert_eq!(parse_web_url_line("dsh web: http://127.0.0.1:9999/?token=x", 1852), None);
        assert_eq!(parse_web_url_line("loader: tree settled in 812ms", 1852), None);
    }

    #[test]
    fn version_parses_prerelease_suffix() {
        let pj = r#"{ "name": "@deepseek-ai/dsh", "version": "0.1.2-rc.1" }"#;
        assert_eq!(parse_dsh_version(pj), Some((0, 1, 2)));
        assert_eq!(parse_dsh_version(r#"{ "name": "@deepseek-ai/dsh", "version": "0.1.1-rc.2" }"#), Some((0, 1, 1)));
        assert_eq!(parse_dsh_version(r#"{ "name": "@deepseek-ai/dsh", "version": "0.1.2-alpha.5" }"#), Some((0, 1, 2)));
        assert_eq!(parse_dsh_version("not json"), None);
        assert_eq!(parse_dsh_version(r#"{ "name": "@deepseek-ai/dsh" }"#), None);
    }

    #[test]
    fn auth_capability_threshold() {
        // Gate keeps old runtimes flag-free: anything below 0.1.2 is legacy.
        let cap = |v: &str| parse_dsh_version(v).is_some_and(|(a, b, c)| (a, b, c) >= (0, 1, 2));
        assert!(!cap(r#"{"version": "0.1.0-rc.6"}"#));
        assert!(!cap(r#"{"version": "0.1.1-rc.2"}"#));
        assert!(!cap(r#"{"version": "0.1.1"}"#));
        assert!(cap(r#"{"version": "0.1.2-rc.1"}"#));
        assert!(cap(r#"{"version": "0.1.3-alpha.1"}"#));
        assert!(cap(r#"{"version": "0.2.0"}"#));
    }
}
