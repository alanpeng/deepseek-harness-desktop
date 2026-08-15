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

/// Shared host state managed by Tauri.
pub struct HostState {
    /// Port the web host was spawned on (Some once the host is up).
    pub port: Mutex<Option<u16>>,
    /// Live host child process, if any.
    pub child: Mutex<Option<CommandChild>>,
    /// Set when the user chose to quit; window close then exits instead of hiding.
    pub quitting: AtomicBool,
}

impl Default for HostState {
    fn default() -> Self {
        Self {
            port: Mutex::new(None),
            child: Mutex::new(None),
            quitting: AtomicBool::new(false),
        }
    }
}

/// `%APPDATA%\dsh-desktop\dsh-home` — all harness state lives here so the app
/// install directory stays read-only and dsh keeps its self-update capability
/// (creator mode, preset authoring, plugin install, settings).
pub fn dsh_home() -> PathBuf {
    let appdata = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(appdata).join("dsh-desktop").join("dsh-home")
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

/// Spawn the dsh web host and return its port once it is listening.
pub fn start_host(app: &AppHandle) -> Result<u16, String> {
    let port = pick_free_port();

    let mut command = if cfg!(debug_assertions) {
        // Dev: run the CLI bin from the dsh clone under the system Node.
        // Override the clone location with DSH_DESKTOP_CLONE when needed.
        let clone = std::env::var("DSH_DESKTOP_CLONE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("..")
                    .join("..")
                    .join("deepseek-harness")
            });
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
        // apart during CommandLineToArgvW-style splitting).
        let dir = exe_dir()?.join("dsh-runtime");
        let node = dir.join("node.exe");
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
        .args([
            "--profile",
            "web",
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
        ])
        .env("DSH_HOME", dsh_home().to_str().unwrap_or("."))
        .env("DSH_TELEMETRY_DISABLED", "1")
        .current_dir(std::env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string()));

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
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW — no console flash
            .status();
        let _ = child.kill();
    }
}

/// Kill, respawn, and re-navigate the window to the new host port.
/// Shared by the tray "restart" item and the runtime hot-update swap.
/// On failure the window is pointed at the splash error page.
pub fn restart_host(app: &AppHandle) -> Result<u16, String> {
    kill_host(app);
    let port = start_host(app)?;
    if let Some(window) = app.get_webview_window("main") {
        let url = format!("http://127.0.0.1:{port}").parse().unwrap();
        let _ = window.navigate(url);
        let _ = window.show();
    }
    Ok(port)
}
