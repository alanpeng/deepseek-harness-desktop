# dsh-desktop

[English](README.md) · **简体中文**

基于 [Tauri 2](https://v2.tauri.app) 的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）桌面壳。
将 dsh Web Host 以 Node sidecar 方式内置，在原生窗口中托管 Web 应用，并支持**桌面壳**与**内置运行时**两条互相独立的自动更新通道。

## 功能特性

- **Web Host Sidecar** — 内置官方 Node 24 + pnpm deploy 产物（`dsh-runtime/`），在回环地址空闲端口上启动 dsh Web Host，窗口直接导航过去。不使用 pkg 类快照，dsh 运行时的插件动态加载（dynamic import）与开发环境完全一致。
- **独立双通道自更新**：
  - *壳（Shell）*：`tauri-plugin-updater` 从 GitHub Releases 拉取安装包，静默调用 NSIS 安装器并自动重启应用。
  - *运行时（Runtime）*：查询 npm registry（`@deepseek-ai/dsh` dist-tags）发现新版本，从 [dsh-runtime 发布仓库](https://github.com/alanpeng/deepseek-harness-runtime) 下载签名工件，校验 sha256 + minisign 后原子替换 `dsh-runtime/` 并重启 Host。
  - 启动 15 秒后静默检查（运行时自动应用，壳仅标记托盘状态）+ 托盘手动「检查更新…」。
- **系统托盘** — 状态文本、版本信息、关于、显示 / 隐藏、重启 Host、打开 DSH Home、退出（关闭窗口最小化到托盘）。
- **`dshdesktop://` 深度链接** — 每次启动自动重新注册，更新后自愈。
- **DSH Home**（`%APPDATA%\dsh-desktop\dsh-home`）— 会话状态、日志、以及 dsh 自身可更新的插件 / 预设 / 配置都保存在安装目录之外。

## 架构

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

## 开发

环境要求：Node 24、pnpm、Rust 工具链、[Tauri 前置依赖](https://v2.tauri.app/start/prerequisites/)。

```bash
# 开发模式（使用系统 node + ../deepseek-harness 的 dsh 克隆；可用 DSH_DESKTOP_CLONE 覆盖）
npm run dev

# 构建内置运行时目录（pnpm deploy + node.exe）
npm run sidecar:build

# 发布安装包（需要 TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]）
npm run build
```

## 发布与更新机制

### 三平台自动发布（GitHub Actions）

发布完全由 CI 承担：push `v*` tag 或 Actions 手动触发（workflow_dispatch 填版本号）→ `release.yml` 在三平台并行构建并发布到 GitHub Releases：

| 平台 | runner | 产物 |
|---|---|---|
| Windows | windows-latest | `dsh-desktop_<v>_win_x64-setup.exe`（NSIS） |
| macOS | macos-latest（Apple Silicon，未签名） | `dsh-desktop_<v>_macos-aarch64.app.tar.gz` + `.dmg` |
| Linux | ubuntu-24.04 | `dsh-desktop_<v>_linux_amd64.AppImage` + `.deb` |

- 资产统一 `dsh-desktop_<版本>_<平台>` 命名；`latest.json` 由 finalize job 合并各平台片段后上传，壳更新直接命中
- macOS 无 Apple 证书，包**未签名**：Gatekeeper 下需右键打开
- Linux 构建机为 ubuntu-24.04（当前 tauri 链要求 webkit2gtk-4.1，22.04 无法编译）；产物 glibc 2.39，**不保证** RHEL 9 系（glibc 2.34）兼容
- 同一版本重跑幂等：同名资产删除后重传

### 自动跟进官方 dsh（运行时通道）

`auto-update-dsh.yml` 每小时检查 npm 的 `@deepseek-ai/dsh`：

- 接受正式版（`x.y.z`）与 RC（`x.y.z-rc.N`），忽略 `-dev`/`-alpha`/`-beta` 等
- 发现可接受的新版本 → 自动 bump `sidecar/runtime-manifest` + 更新 lockfile → 提交 → 三平台构建并发布 `dsh-runtime-<v>-<platform>.tar.gz`（+ `.sha256` + `.minisig` 签名）到 `deepseek-harness-runtime`

### 客户端更新：整包替换，零编译

两条独立通道，**桌面壳不升级不影响运行时升级**：

- **壳**：`tauri-plugin-updater` 从 GitHub Releases 下载安装包，NSIS 静默安装 + 自动重启
- **运行时**：启动 15 秒后（及手动"检查更新"）查 npm dist-tags（`latest`/`next`）→ 发现新版下载**预打包闭包**（node 二进制 + 全部 node_modules 已在 CI 构建完毕）→ sha256 + minisign 校验 → 原子替换 `dsh-runtime/` → 重启 Host。用户端无任何编译/安装动作
- 时序：资产需先由 CI 发布（cron 每小时 + 构建约 30 分钟）；若用户先于资产就绪检查到新版，下载 404 → 保留旧版本，下次启动重试

### 签名与密钥

- 壳与运行时共用一对 minisign 密钥（`npx tauri signer generate` 生成）；私钥只存在于 CI secrets（`TAURI_SIGNING_PRIVATE_KEY[_PASSWORD]`）与本机密钥文件，永不入库
- 运行时跨仓库上传需要 `GH_PAT`（repo scope）secret

### 本地调试 / 重跑

发布默认走 CI；本地调试或重跑时也可直接调用发布脚本（需要 `GITHUB_TOKEN` 与签名密钥）：

- 壳：`npm run release:desktop -- --version <v>` — bump 版本、带 `createUpdaterArtifacts` 构建、上传安装包 + `latest.json`
- 运行时：`npm run release:runtime` — 打包 `sidecar/runtime/`、签名并上传 `dsh-runtime-<v>.tar.gz` + `.sha256` + `.minisig`

## 协议

MIT — 见 [LICENSE](LICENSE)。
