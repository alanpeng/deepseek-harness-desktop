//! dsh runtime hot-update: detect a newer `@deepseek-ai/dsh` on the npm
//! registry, download the signed tarball from the runtime release repo,
//! verify sha256 + minisign, atomically swap `dsh-runtime/`, restart the host.
//!
//! Independent from the shell updater (tauri-plugin-updater): the runtime can
//! hot-swap without reinstalling the app, so upstream dsh rc releases land in
//! days instead of waiting for a desktop release. Same keypair signs both
//! channels; the public key is read from `plugins.updater.pubkey`.

use std::io::Read;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::Engine;
use futures_util::StreamExt;
use tauri::{AppHandle, Manager};

use crate::host;
use crate::updates;

/// Managed by Tauri; guards concurrent runtime updates.
pub struct RuntimeState {
    pub busy: AtomicBool,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            busy: AtomicBool::new(false),
        }
    }
}

const NPM_REGISTRY: &str = "https://registry.npmjs.org/@deepseek-ai/dsh";
const RELEASE_BASE: &str =
    "https://github.com/alanpeng/deepseek-harness-runtime/releases/download";
#[cfg(windows)]
const TAR_EXE: &str = "C:\\Windows\\System32\\tar.exe";
#[cfg(not(windows))]
const TAR_EXE: &str = "tar";
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Platform suffix for runtime artifacts (mirrors the release workflow matrix).
pub fn platform_suffix() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => "windows-x86_64",
        ("macos", "x86_64") => "macos-x86_64",
        ("macos", "aarch64") => "macos-aarch64",
        ("linux", "x86_64") => "linux-x86_64",
        ("linux", "aarch64") => "linux-aarch64",
        (os, arch) => {
            // Unknown combo: still build a stable (if wrong) URL so the check
            // fails loudly against a 404 instead of panicking.
            let _ = (os, arch);
            "unknown"
        }
    }
}

/// Dev/test override hooks (zero production risk).
fn registry_url() -> String {
    std::env::var("DSH_RUNTIME_REGISTRY_URL").unwrap_or_else(|_| NPM_REGISTRY.to_string())
}
fn artifact_base_url() -> String {
    std::env::var("DSH_RUNTIME_ARTIFACT_BASE_URL").unwrap_or_else(|_| RELEASE_BASE.to_string())
}

/// Staging dir on the same volume as the install dir (rename swap, no copy).
#[cfg(windows)]
fn staging_dir() -> PathBuf {
    let local = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    PathBuf::from(local).join("dsh-desktop").join("update-staging")
}
#[cfg(not(windows))]
fn staging_dir() -> PathBuf {
    let cache = std::env::var("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| crate::host::user_home().join(".cache"));
    cache.join("dsh-desktop").join("update-staging")
}

/// Runtime version, read from the ACTIVE closure's package.json (the runtime
/// dir passed in — bundle dir on Windows, bundle-or-overlay on Linux/macOS).
pub fn bundled_dsh_version(runtime: &Path) -> Result<semver::Version, String> {
    let pj = runtime
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("package.json");
    let text = std::fs::read_to_string(&pj)
        .map_err(|e| format!("cannot read bundled dsh version at {}: {e}", pj.display()))?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("bad package.json: {e}"))?;
    let s = v
        .get("version")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "dsh package.json has no version".to_string())?;
    semver::Version::parse(s).map_err(|e| format!("unparsable dsh version {s}: {e}"))
}

/// Query the npm registry; return the newest dist-tag version newer than the
/// bundled one (prereleases included — rc.6 > rc.5 for the same family).
pub async fn check_runtime_update(app: &AppHandle) -> Result<Option<semver::Version>, String> {
    let current = bundled_dsh_version(&host::runtime_dir(app)?)?;
    let client = http_client(Duration::from_secs(20))?;
    let resp = client
        .get(registry_url())
        .send()
        .await
        .map_err(|e| format!("npm registry request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("npm registry responded {}", resp.status()));
    }
    let packument: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("npm registry payload invalid: {e}"))?;
    let mut best: Option<semver::Version> = None;
    if let Some(tags) = packument.get("dist-tags") {
        for key in ["latest", "next"] {
            if let Some(s) = tags.get(key).and_then(|x| x.as_str()) {
                if let Ok(v) = semver::Version::parse(s) {
                    if v > current && best.as_ref().map_or(true, |b| v > *b) {
                        best = Some(v);
                    }
                }
            }
        }
    }
    Ok(best)
}

/// Download + verify + swap + restart host. Returns Err on any failure; the
/// previous runtime is always restored unless the failure is pre-swap.
pub async fn apply_runtime_update(app: &AppHandle, target: &semver::Version) -> Result<(), String> {
    let rstate = app.state::<RuntimeState>();
    if rstate.busy.swap(true, Ordering::SeqCst) {
        return Err("另一个运行时更新正在进行中".to_string());
    }
    let result = do_apply(app, target).await;
    rstate.busy.store(false, Ordering::SeqCst);
    result
}

async fn do_apply(app: &AppHandle, target: &semver::Version) -> Result<(), String> {
    // [1] fresh staging dir
    let staging = staging_dir();
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)
        .map_err(|e| format!("cannot create staging dir: {e}"))?;

    // [2] free-space preflight (staging peaks at tar.gz + extracted + .bak)
    let free = free_space_bytes()?;
    if free < 1_500_000_000 {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!(
            "磁盘空间不足：剩余 {:.1} GB，运行时更新需要 ≥ 1.5 GB",
            free as f64 / 1_000_000_000.0
        ));
    }

    let client = http_client(Duration::from_secs(300))?;
    // Artifacts are per-platform: dsh-runtime-<v>-<platform> release tag,
    // tarball + checksum + signature all carry the platform suffix.
    let plat = platform_suffix();
    let tag = format!("dsh-runtime-{target}-{plat}");
    let base = artifact_base_url();
    // 三件套 URL 都必须带 {tag}/ 目录段：GitHub release 资产路径是
    // {base}/{release_tag}/{asset_name}。sha/sig 曾漏掉目录段（自 ce8b5fc
    // 起），拼成 {base}/{tag}.tar.gz.sha256 —— release tag 不存在 → 404，
    // 自动更新永远卡在 gz 下载成功后、校验文件下载失败处。
    let gz_url = format!("{base}/{tag}/{tag}.tar.gz");
    let sha_url = format!("{base}/{tag}/{tag}.tar.gz.sha256");
    let sig_url = format!("{base}/{tag}/{tag}.tar.gz.minisig");
    let gz_path = staging.join(format!("{tag}.tar.gz"));
    let sha_path = staging.join(format!("{tag}.tar.gz.sha256"));
    let sig_path = staging.join(format!("{tag}.tar.gz.minisig"));

    // [3-4] downloads
    updates::set_tray_status(app, &format!("正在下载 dsh 运行时 v{target}…"));
    let app2 = app.clone();
    let mut last_mb = 0u64;
    download_file(&client, &gz_url, &gz_path, move |done| {
        let mb = done as u64 / 1_048_576;
        if mb != last_mb {
            last_mb = mb;
            updates::set_tray_status(&app2, &format!("正在下载 dsh 运行时 v{target}… {mb} MB"));
        }
    })
    .await?;
    download_file(&client, &sha_url, &sha_path, |_| {}).await?;
    download_file(&client, &sig_url, &sig_path, |_| {}).await?;

    // [5] sha256
    let expected = std::fs::read_to_string(&sha_path)
        .map_err(|e| format!("cannot read sha256 file: {e}"))?
        .trim()
        .split_whitespace()
        .next()
        .unwrap_or_default()
        .to_lowercase();
    if expected.is_empty() {
        return Err("sha256 校验文件为空".to_string());
    }
    let actual = sha256_hex(&gz_path)?;
    if actual != expected {
        return Err(format!("sha256 校验失败：\n期望 {expected}\n实际 {actual}"));
    }

    // [6] minisign (buffered — tauri signer does not prehash)
    let pubkey = pubkey_from_config(app)?;
    verify_minisig(&gz_path, &sig_path, &pubkey)?;

    // [7] internal version must match the tag (wrong artifact uploaded?)
    internal_version_matches(&gz_path, target)?;

    // [8-9] extract + sanity (spawn_blocking: ~2-4 min single-threaded tar)
    updates::set_tray_status(app, &format!("正在解压 dsh 运行时 v{target}（约 2 分钟）…"));
    let extracted = staging.join("extracted");
    let gz_path2 = gz_path.clone();
    let extracted2 = extracted.clone();
    tokio::task::spawn_blocking(move || {
        extract_tar_gz(&gz_path2, &extracted2)?;
        runtime_sanity(&extracted2)
    })
    .await
    .map_err(|e| format!("extract task panicked: {e}"))??;

    // [10] release locks on the live runtime. The swap target: the bundled
    // dir on Windows; on Linux/macOS the bundle dir is root-owned (deb:
    // /usr/lib/dsh-desktop, AppImage: $APPDIR/usr/lib/dsh-desktop), so the
    // update lands in the user-writable overlay, which then shadows the
    // bundle at next start (host::runtime_dir()).
    let install_dir = if cfg!(windows) {
        host::runtime_dir(app)?
    } else {
        host::runtime_overlay_dir()
    };
    host::kill_host(app);

    // [11] old → .bak (skipped on the first non-Windows update — no overlay
    // exists yet; the bundled runtime stays untouched)
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let parent = install_dir.parent().unwrap_or(&install_dir);
    let bak = parent.join(format!("dsh-runtime.bak.{ts}"));
    if install_dir.exists() && rename_with_retry(&install_dir, &bak).is_err() {
        // still locked: one more kill pass, then give up and restore service
        host::kill_host(app);
        std::thread::sleep(Duration::from_millis(500));
        if let Err(e2) = rename_with_retry(&install_dir, &bak) {
            let _ = host::restart_host(app);
            return Err(format!("旧运行时仍被占用，更新中止：{e2}"));
        }
    }

    // [12] new → dsh-runtime
    let top = find_top_dir(&extracted)?;
    let new_dir = extracted.join(&top);
    if let Err(e) = rename_with_retry(&new_dir, &install_dir) {
        let _ = std::fs::rename(&bak, &install_dir); // restore
        let _ = host::restart_host(app);
        return Err(format!("换入新运行时失败，已回滚：{e}"));
    }

    // [13] bring the host back
    match host::restart_host(app) {
        Ok(_) => {
            // [14] success — free the disk asynchronously
            let bak2 = bak.clone();
            let staging2 = staging.clone();
            tauri::async_runtime::spawn(async move {
                let _ = std::fs::remove_dir_all(&bak2);
                let _ = std::fs::remove_dir_all(&staging2);
            });
            updates::set_tray_status(app, &format!("Host: 运行中 · dsh v{target}"));
            Ok(())
        }
        Err(e) => {
            // [E4] host failed on the new runtime: full rollback
            host::kill_host(app);
            let _ = std::fs::remove_dir_all(&install_dir);
            let _ = std::fs::rename(&bak, &install_dir);
            let _ = host::restart_host(app);
            Err(format!("新运行时启动失败，已回滚：{e}"))
        }
    }
}

// ── helpers ───────────────────────────────────────────────────────────────

fn http_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("http client: {e}"))
}

async fn download_file(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    mut on_bytes: impl FnMut(usize) + Send,
) -> Result<(), String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("下载 {url}: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载 {url}: HTTP {}", resp.status()));
    }
    let mut stream = resp.bytes_stream();
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("cannot create {}: {e}", dest.display()))?;
    let mut done = 0usize;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载 {url}: {e}"))?;
        done += chunk.len();
        tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
            .await
            .map_err(|e| format!("写盘 {}: {e}", dest.display()))?;
        on_bytes(done);
    }
    Ok(())
}

fn sha256_hex(path: &Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn verify_minisig(artifact: &Path, sig_path: &Path, pubkey_config: &str) -> Result<(), String> {
    // tauri signer writes the public key as base64 of the two-line minisign
    // text (single line, "double-encoded") — decode one layer, then parse
    // textually, mirroring tauri-plugin-updater's verify_signature exactly.
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(pubkey_config)
        .map_err(|e| format!("公钥 base64 无效: {e}"))?;
    let text = std::str::from_utf8(&decoded)
        .map_err(|e| format!("公钥文本无效: {e}"))?;
    let pk = minisign_verify::PublicKey::decode(text)
        .map_err(|e| format!("公钥无效: {e}"))?;
    let sig = minisign_verify::Signature::from_file(sig_path)
        .map_err(|e| format!("签名文件无效: {e}"))?;
    let bytes = std::fs::read(artifact)
        .map_err(|e| format!("cannot read artifact for verification: {e}"))?;
    pk.verify(&bytes, &sig, true)
        .map_err(|e| format!("minisign 签名验证失败: {e}"))
}

/// The tarball must carry node_modules/@deepseek-ai/dsh/package.json whose
/// version equals the release tag — rejects a mis-uploaded artifact early.
fn internal_version_matches(artifact: &Path, expected: &semver::Version) -> Result<(), String> {
    let gz = artifact.to_str().unwrap_or_default();
    let listing = std::process::Command::new(TAR_EXE)
        .args(["-tzf", gz])
        .output()
        .map_err(|e| format!("tar list failed: {e}"))?;
    let stdout = String::from_utf8_lossy(&listing.stdout);
    let pj_path = stdout
        .lines()
        .find(|l| l.ends_with("node_modules/@deepseek-ai/dsh/package.json"))
        .ok_or_else(|| "工件内未找到 dsh package.json".to_string())?;
    // bsdtar: options must precede the first operand, otherwise `-O` is
    // treated as a member name ("Not found in archive", empty stdout).
    let out = std::process::Command::new(TAR_EXE)
        .args(["-xzf", gz, "-O", pj_path])
        .output()
        .map_err(|e| format!("tar extract-to-stdout failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "tar extract failed (exit {}): {}",
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout)
        .map_err(|e| format!("工件内 package.json 无效: {e}"))?;
    let actual = v
        .get("version")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "工件内 dsh 无版本号".to_string())?;
    if actual != expected.to_string() {
        return Err(format!("工件内部版本 {actual} 与标签 {expected} 不符"));
    }
    Ok(())
}

fn extract_tar_gz(artifact: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest)
        .map_err(|e| format!("cannot create {}: {e}", dest.display()))?;
    let mut cmd = std::process::Command::new(TAR_EXE);
    cmd.args([
        "-xzf",
        artifact.to_str().unwrap_or_default(),
        "-C",
        dest.to_str().unwrap_or_default(),
    ]);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let status = cmd
        .status()
        .map_err(|e| format!("tar 解压启动失败: {e}"))?;
    if !status.success() {
        return Err(format!("tar 解压失败（exit {status}）"));
    }
    Ok(())
}

/// First subdirectory of the extraction root — the tarball's top dir is
/// `runtime/`, resolved dynamically so the packer never needs a rename.
fn find_top_dir(root: &Path) -> Result<String, String> {
    let entries = std::fs::read_dir(root).map_err(|e| e.to_string())?;
    for entry in entries.flatten() {
        if entry.path().is_dir() {
            return Ok(entry.file_name().to_string_lossy().to_string());
        }
    }
    Err("解压结果为空目录".to_string())
}

/// The swapped-in runtime must at least have the node binary + entry.mjs.
fn runtime_sanity(extracted: &Path) -> Result<(), String> {
    let top = find_top_dir(extracted)?;
    let dir = extracted.join(&top);
    if !dir.join(crate::host::NODE_BIN).exists() {
        return Err(format!(
            "解压后的运行时缺少 {}（{top}）",
            crate::host::NODE_BIN
        ));
    }
    if !dir.join("entry.mjs").exists() {
        return Err(format!("解压后的运行时缺少 entry.mjs（{top}）"));
    }
    Ok(())
}

fn rename_with_retry(from: &Path, to: &Path) -> Result<(), String> {
    for attempt in 0..10 {
        match std::fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(_e) if attempt < 9 => {
                std::thread::sleep(Duration::from_secs(1));
            }
            Err(e) => {
                return Err(format!(
                    "重命名 {} → {} 失败: {e}",
                    from.display(),
                    to.display()
                ))
            }
        }
    }
    unreachable!()
}

#[cfg(windows)]
fn free_space_bytes() -> Result<u64, String> {
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let local = std::env::var("LOCALAPPDATA").unwrap_or_else(|_| ".".into());
    let root: Vec<u16> = local.encode_utf16().chain(std::iter::once(0)).collect();
    let mut free: u64 = 0;
    let ok = unsafe { GetDiskFreeSpaceExW(root.as_ptr(), std::ptr::null_mut(), std::ptr::null_mut(), &mut free) };
    if ok == 0 {
        return Err("GetDiskFreeSpaceExW 失败".to_string());
    }
    Ok(free)
}

#[cfg(not(windows))]
fn free_space_bytes() -> Result<u64, String> {
    use std::ffi::CString;
    let cache = std::env::var("XDG_CACHE_HOME")
        .unwrap_or_else(|_| crate::host::user_home().join(".cache").to_string_lossy().into_owned());
    let root = CString::new(cache).map_err(|e| e.to_string())?;
    let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statvfs(root.as_ptr(), &mut st) };
    if rc != 0 {
        return Err("statvfs 失败".to_string());
    }
    Ok(st.f_bavail as u64 * st.f_frsize as u64)
}

/// Same keypair as the shell updater — single source of truth.
fn pubkey_from_config(app: &AppHandle) -> Result<String, String> {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|u| u.get("pubkey"))
        .and_then(|p| p.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "配置缺少 plugins.updater.pubkey".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cross-check a packed + minisigned runtime artifact through the exact
    /// verification path the app uses. Run with:
    ///   DSH_TEST_TARBALL=<abs path to *.tar.gz> cargo test --bin dsh-desktop
    #[test]
    fn verify_packed_artifact() {
        let Ok(gz) = std::env::var("DSH_TEST_TARBALL") else {
            return; // opt-in test; skipped without env
        };
        let sig = std::env::var("DSH_TEST_MINISIG").unwrap_or_else(|_| format!("{gz}.minisig"));
        // Pubkey straight from tauri.conf.json — the single source of truth.
        let conf: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string("tauri.conf.json").expect("tauri.conf.json"),
        )
        .expect("valid config json");
        let pk = conf["plugins"]["updater"]["pubkey"]
            .as_str()
            .expect("updater pubkey");
        verify_minisig(Path::new(&gz), Path::new(&sig), pk)
            .expect("minisign verification failed");

        // Optional: assert the tarball's internal dsh version matches a
        // reference version (the sidecar source tree it was packed from).
        if let Ok(want) = std::env::var("DSH_TEST_REF_VERSION") {
            let want = semver::Version::parse(&want).unwrap();
            internal_version_matches(Path::new(&gz), &want)
                .unwrap_or_else(|e| panic!("tarball internal version mismatch: {e}"));
        }
    }
}
