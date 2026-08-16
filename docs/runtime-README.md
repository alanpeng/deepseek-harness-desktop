# deepseek-harness-runtime

**English** · [简体中文](README.zh-CN.md)

Release artifacts for the **dsh web-host runtime** bundled by [dsh-desktop](https://github.com/alanpeng/deepseek-harness-desktop).

This repository contains **no source code** — only signed, versioned runtime bundles that
[dsh-desktop](https://github.com/alanpeng/deepseek-harness-desktop) downloads, verifies, and
hot-swaps into its `dsh-runtime/` directory at runtime.

## Artifacts

Each release `dsh-runtime-<version>` contains:

| File | Purpose |
|---|---|
| `dsh-runtime-<version>.tar.gz` | The runtime bundle: stock `node.exe` + the pnpm-deployed closure of `@deepseek-ai/dsh` and its plugins. |
| `dsh-runtime-<version>.tar.gz.sha256` | SHA-256 checksum of the tarball. |
| `dsh-runtime-<version>.tar.gz.minisig` | [minisign](https://github.com/jedisct1/minisign) signature of the tarball (same keypair that signs dsh-desktop updater artifacts). |

## How it's used

1. `dsh-desktop` starts and, after 15 s, silently queries the npm registry
   (`@deepseek-ai/dsh` `dist-tags`) for a newer version than the one it bundles.
2. On a newer version it downloads the tarball from the release URL,
   verifies **sha256 + minisign**, checks the internal version, and atomically
   swaps `dsh-runtime/` (old directory is kept as `.bak` until the swap succeeds).
3. The host restarts on the new runtime. The whole cycle is invisible to the user.

## Manual verification

```bash
# verify checksum
sha256sum -c dsh-runtime-<version>.tar.gz.sha256

# verify signature (public key below)
minisign -Vm dsh-runtime-<version>.tar.gz -P RWRF058FtWuPaj7n/70BzKaPw0WXTOTfSPjcPNUTiuCcL658k30XFQsH
```

Public key (also embedded in `dsh-desktop`'s `tauri.conf.json`):
`RWRF058FtWuPaj7n/70BzKaPw0WXTOTfSPjcPNUTiuCcL658k30XFQsH`

## Versioning

Versions mirror the upstream `@deepseek-ai/dsh` npm package versions (e.g. `0.1.0-rc.6`),
rebuilt from the official [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
repository — the runtime code itself is 100% upstream, unmodified.

## License

MIT
