# dsh-desktop

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

## Releasing

Two GitHub repos, one signing keypair (`npx tauri signer generate` — keep it outside this repo):

- **`deepseek-harness-desktop`** — shell releases. `npm run release:desktop -- --version <v>`
  bumps versions, builds with `createUpdaterArtifacts`, uploads the NSIS zip + `latest.json`.
- **`deepseek-harness-runtime`** — runtime tarballs. `npm run release:runtime` packs
  `sidecar/runtime/`, signs it, and uploads `dsh-runtime-<v>.tar.gz` + `.sha256` + `.minisig`.

Requires `GITHUB_TOKEN` (repo scope) in the environment.

## License

MIT — see [LICENSE](LICENSE).
