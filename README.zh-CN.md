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

## 发布

两个 GitHub 仓库、同一对签名密钥（`npx tauri signer generate` 生成，密钥务必保存在仓库之外）：

- **`deepseek-harness-desktop`** — 壳发布。`npm run release:desktop -- --version <v>`
  自动 bump 版本、带 `createUpdaterArtifacts` 构建、上传 NSIS 安装包 + `latest.json`。
- **`deepseek-harness-runtime`** — 运行时工件发布。`npm run release:runtime` 打包
  `sidecar/runtime/`、签名并上传 `dsh-runtime-<v>.tar.gz` + `.sha256` + `.minisig`。

需要环境变量 `GITHUB_TOKEN`（repo scope）。

## 协议

MIT — 见 [LICENSE](LICENSE)。
