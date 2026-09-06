//! Pre-boot repair of the dsh session root.
//!
//! Every dsh runtime this shell ships (0.1.0 through 0.1.2-rc.1) runs the web
//! profile's JSONL session backend in zstd mode, and its root-encoding check
//! kills the host at boot when a session directory holds a plaintext
//! `session.jsonl` next to (or instead of) `session.jsonl.zstd`. Upstream
//! explicitly does not migrate compression, so this module heals the root
//! before `start_host` spawns: the embedded `session_repair.mjs` (run with
//! the same node the host would use) deletes header stubs that are provably
//! redundant and transcodes plaintext-only session logs into zstd frames —
//! both lossless — and reports everything it leaves alone.
//!
//! Runs on every start (cold boot and runtime self-update restarts alike, both
//! of which funnel through `host::start_host`). Never blocks startup: failures
//! are logged to `logs/session-repair.log` and the host spawn proceeds — when
//! repair cannot help, the runtime's own error message surfaces as before.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime};

use tauri::AppHandle;

use crate::host;

/// The repair script, embedded so a runtime swap can never orphan it.
pub(crate) const SESSION_REPAIR_JS: &str = include_str!("session_repair.mjs");

/// All runtimes ≥ 0.1.0 default to zstd-encoded session roots (the web profile
/// never configured `compression: none`), so plaintext artifacts there are
/// always legacy leftovers worth repairing. Older runtimes predate the
/// encoding and are left untouched; unknown/missing version metadata is
/// conservative and skips repair too.
pub(crate) fn should_repair(version: Option<(u32, u32, u32)>) -> bool {
    version.is_some_and(|v| v >= (0, 1, 0))
}

/// Heal encoding-incompatible artifacts under `DSH_HOME/sessions`. Log-only;
/// returns nothing and never fails the caller.
pub(crate) fn repair_session_root(app: &AppHandle) {
    let Some(version) = host::runtime_dsh_version(app) else {
        return; // no version metadata → don't guess
    };
    if !should_repair(Some(version)) {
        return;
    }
    let sessions = host::dsh_home().join("sessions");
    if !sessions.is_dir() {
        return;
    }

    // Same node the host would spawn: the bundled runtime node in release
    // builds (Node 24 ships zstd in node:zlib); PATH node in dev builds — the
    // script self-reports when the zstd APIs are missing.
    let node = if cfg!(debug_assertions) {
        PathBuf::from("node")
    } else {
        match host::runtime_dir(app) {
            Ok(dir) => dir.join(host::NODE_BIN),
            Err(_) => return,
        }
    };
    if !node.exists() {
        eprintln!("[dsh-desktop] session repair: node not found at {}", node.display());
        return;
    }

    // Materialize the embedded script; stdout/stderr go to temp files so a
    // large report can never deadlock an unread pipe.
    let script = std::env::temp_dir().join(format!("dsh-session-repair-{}.mjs", std::process::id()));
    let out_file = std::env::temp_dir().join(format!("dsh-session-repair-{}.out", std::process::id()));
    let err_file = std::env::temp_dir().join(format!("dsh-session-repair-{}.err", std::process::id()));
    if fs::write(&script, SESSION_REPAIR_JS).is_err() {
        return;
    }
    let _ = fs::remove_file(&out_file);
    let _ = fs::remove_file(&err_file);

    let spawned = || -> Result<std::process::Child, String> {
        let out = OpenOptions::new()
            .create(true)
            .write(true)
            .open(&out_file)
            .map_err(|e| e.to_string())?;
        let err = OpenOptions::new()
            .create(true)
            .write(true)
            .open(&err_file)
            .map_err(|e| e.to_string())?;
        Command::new(&node)
            .arg(&script)
            .arg(&sessions)
            .stdin(Stdio::null())
            .stdout(Stdio::from(out))
            .stderr(Stdio::from(err))
            .spawn()
            .map_err(|e| e.to_string())
    };

    match spawned() {
        Err(e) => eprintln!("[dsh-desktop] session repair: spawn failed: {e}"),
        Ok(mut child) => {
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => {
                        if Instant::now() >= deadline {
                            let _ = child.kill();
                            eprintln!("[dsh-desktop] session repair: timed out after 20s");
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    Err(e) => {
                        eprintln!("[dsh-desktop] session repair: wait failed: {e}");
                        break;
                    }
                }
            }
            let report = fs::read_to_string(&out_file).unwrap_or_default();
            let err = fs::read_to_string(&err_file).unwrap_or_default();
            for line in report.lines() {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                    if v["action"] == "summary" {
                        continue;
                    }
                }
                append_report(line);
            }
            if !err.is_empty() {
                for line in err.lines() {
                    append_report(&format!("[stderr] {line}"));
                }
            }
            let counts = count_actions(&report);
            eprintln!(
                "[dsh-desktop] session repair: removed={} transcoded={} kept={} (see logs/session-repair.log)",
                counts.0, counts.1, counts.2
            );
        }
    }

    let _ = fs::remove_file(&script);
    let _ = fs::remove_file(&out_file);
    let _ = fs::remove_file(&err_file);
}

fn count_actions(report: &str) -> (usize, usize, usize) {
    let mut c = (0, 0, 0);
    for line in report.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        match v["action"].as_str() {
            Some("removed") => c.0 += 1,
            Some("transcoded") => c.1 += 1,
            Some("kept") => c.2 += 1,
            _ => {}
        }
    }
    c
}

/// Append one line to `logs/session-repair.log` (same directory as host.log).
fn append_report(line: &str) {
    let dir = host::dsh_home().join("logs");
    if fs::create_dir_all(&dir).is_err() {
        return;
    }
    let ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs().to_string())
        .unwrap_or_else(|_| "?".into());
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(dir.join("session-repair.log")) {
        let _ = writeln!(f, "[{ts}] {line}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repairs_from_0_1_0_onward() {
        assert!(!should_repair(None));
        assert!(!should_repair(Some((0, 0, 8))));
        assert!(should_repair(Some((0, 1, 0))));
        assert!(should_repair(Some((0, 1, 2))));
    }
}
