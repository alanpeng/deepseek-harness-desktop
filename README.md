# dsh-desktop

**English** · [简体中文](README.zh-CN.md)

A Tauri 2 desktop shell for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).
Ships the dsh web host as a bundled Node sidecar, hosts the web app in a native window, and
self-updates **both** the shell and the bundled runtime independently.

## Features

- **Web host sidecar** — a stock Node 24 + pnpm-deployed closure (`dsh-runtime/`) spawns the dsh
  web host on a free loopback port; the window navigates there. No pkg-style snapshots, so dsh's
  runtime plugin resolution (dynamic import) works exactly like dev.
- **Independent self-update channels**:
  - *Shell*: `tauri-plugin-updater` pulls `*.nsis.zip` from GitHub Releases, runs the NSIS
    installer passively, and relaunches the app itself.
  - *Runtime*: checks the npm registry (`@deepseek-ai/dsh` dist-tags) for a newer version,
    downloads a signed tarball from the [dsh-runtime release repo](https://github.com/alanpeng/deepseek-harness-runtime),
    verifies sha256 + minisign, atomically swaps `dsh-runtime/`, and restarts the host.
  - Startup silent check (after 15 s) + manual "检查更新…" from the tray.
- **Tray UI** — status, show/hide, restart host, open DSH Home, quit (close hides to tray).
- **`dshdesktop://` deep link** — re-registered on every launch, so it self-heals after updates.
- **DSH Home** (`%APPDATA%\dsh-desktop\dsh-home`) — harness state, logs, and dsh's own
  self-updatable plugins/presets/config live outside the install dir.

## Architecture

```
┌───────────────────────────────┐
│   dsh-desktop (Tauri 2, NSIS) │
│  window ──http──► dsh web host│
│  tray · deep-link · updater   │
│  plugins: shell, updater,     │
│           dialog, opener,     │
│           single-instance     │
└──────────┬────────────────────┘
           │ spawn (release):
           │   <exe>\dsh-runtime\node.exe entry.mjs --profile web
           ▼
┌───────────────────────────────┐
│ dsh-runtime (sidecar)         │
│ node.exe + pnpm-deploy tree   │
│ @deepseek-ai/dsh + plugins    │
└───────────────────────────────┘
```

## Development

Requirements: Node 24, pnpm, Rust toolchain, [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
# dev (uses system node + the dsh clone at ../deepseek-harness; override with DSH_DESKTOP_CLONE)
npm run dev

# build the bundled runtime dir (pnpm deploy + node.exe)
npm run sidecar:build

# release installer (requires TAURI_SIGNING_PRIVATE_KEY[_PASSWORD])
npm run build
```

## Release & update mechanism

### Automated three-platform releases (GitHub Actions)

Releases are fully handled by CI: push a `v*` tag or trigger manually via Actions
(`workflow_dispatch` with a version) → `release.yml` builds and publishes on three
platforms in parallel:

| Platform | Runner | Artifacts |
|---|---|---|
| Windows | windows-latest | `dsh-desktop_<v>_win_x64-setup.exe` (NSIS) |
| macOS | macos-latest (Apple Silicon, unsigned) | `dsh-desktop_<v>_macos-aarch64.app.tar.gz` + `.dmg` |
| Linux | ubuntu-24.04 | `dsh-desktop_<v>_linux_amd64.AppImage` + `.deb` |

- Assets are uniformly named `dsh-desktop_<version>_<platform>`; a finalize job merges the
  per-platform fragments into `latest.json`, which the shell updater hits directly.
- macOS builds are **unsigned** (no Apple certificate): Gatekeeper requires right-click open.
- Linux builds on ubuntu-24.04 (the current tauri chain requires webkit2gtk-4.1, which 22.04
  cannot provide); artifacts carry glibc 2.39 and are **not guaranteed** on RHEL 9 (glibc 2.34).
- Re-running the same version is idempotent: same-name assets are deleted and re-uploaded.

### Auto-tracking official dsh (runtime channel)

`auto-update-dsh.yml` polls npm for `@deepseek-ai/dsh` every hour:

- Accepts stable (`x.y.z`) and RC (`x.y.z-rc.N`) versions; ignores `-dev`/`-alpha`/`-beta` etc.
- On an acceptable new version: bumps `sidecar/runtime-manifest` + refreshes the lockfile,
  commits, then builds and publishes `dsh-runtime-<v>-<platform>.tar.gz` (+ `.sha256` +
  `.minisig` signature) to `deepseek-harness-runtime` on all three platforms.

### Client updates: whole-closure swap, zero compilation

Two independent channels — **the shell version does not gate runtime updates**:

- **Shell**: `tauri-plugin-updater` downloads the installer from GitHub Releases, runs NSIS
  passively, and relaunches the app itself.
- **Runtime**: 15 s after startup (and on manual "check for updates") it queries npm dist-tags
  (`latest`/`next`) → on a newer version it downloads the **pre-built closure** (node binary +
  the full node_modules, assembled by CI) → verifies sha256 + minisign → atomically swaps
  `dsh-runtime/` → restarts the host. Nothing is compiled or installed on the client.
- Timing: the artifacts must exist first (hourly cron + ~30 min build). If a client checks
  before they are ready, the download 404s → the old version is kept and the next launch retries.

### Signing & keys

- The shell and runtime share one minisign keypair (`npx tauri signer generate`); the private
  key lives only in CI secrets (`TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]`) and the local key file,
  never in the repo.
- Cross-repo runtime uploads need the `GH_PAT` (repo scope) secret.

### Local debugging / re-runs

Releases default to CI; the scripts can still be run locally (requires `GITHUB_TOKEN` and the
signing key):

- Shell: `npm run release:desktop -- --version <v>` — bumps versions, builds with
  `createUpdaterArtifacts`, uploads the installer + `latest.json`.
- Runtime: `npm run release:runtime` — packs `sidecar/runtime/`, signs, and uploads
  `dsh-runtime-<v>.tar.gz` + `.sha256` + `.minisig`.

## License

MIT — see [LICENSE](LICENSE).
