# deepseek-harness-runtime

[English](README.md) · **简体中文**

[dsh-desktop](https://github.com/alanpeng/deepseek-harness-desktop) 内置 **dsh Web Host 运行时** 的发布工件仓库。

本仓库**不含源代码** —— 只存放签名、版本化的运行时压缩包，供
[dsh-desktop](https://github.com/alanpeng/deepseek-harness-desktop) 在运行时下载、校验并热替换到自己的 `dsh-runtime/` 目录。

## 发布内容

每个 release `dsh-runtime-<version>` 包含：

| 文件 | 用途 |
|---|---|
| `dsh-runtime-<version>.tar.gz` | 运行时压缩包：官方 `node.exe` + `@deepseek-ai/dsh` 及其插件的 pnpm deploy 闭包。 |
| `dsh-runtime-<version>.tar.gz.sha256` | 压缩包的 SHA-256 校验和。 |
| `dsh-runtime-<version>.tar.gz.minisig` | 压缩包的 [minisign](https://github.com/jedisct1/minisign) 签名（与 dsh-desktop 更新工件共用同一对密钥）。 |

## 使用流程

1. `dsh-desktop` 启动 15 秒后，静默查询 npm registry（`@deepseek-ai/dsh` 的 `dist-tags`），
   与内置版本比较是否有更新。
2. 发现新版本后下载对应压缩包，校验 **sha256 + minisign**、核对内部版本号，
   然后原子替换 `dsh-runtime/`（旧目录保留为 `.bak`，直到替换成功）。
3. Host 在新运行时上重启，全程对用户无感。

## 手动校验

```bash
# 校验校验和
sha256sum -c dsh-runtime-<version>.tar.gz.sha256

# 校验签名（公钥如下）
minisign -Vm dsh-runtime-<version>.tar.gz -P RWRF058FtWuPaj7n/70BzKaPw0WXTOTfSPjcPNUTiuCcL658k30XFQsH
```

公钥（同时内嵌在 `dsh-desktop` 的 `tauri.conf.json`）：
`RWRF058FtWuPaj7n/70BzKaPw0WXTOTfSPjcPNUTiuCcL658k30XFQsH`

## 版本策略

版本号与上游 `@deepseek-ai/dsh` npm 包版本一一对应（如 `0.1.0-rc.6`），
从官方 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 仓库重新构建 ——
运行时代码 100% 上游原样，不做任何修改。

## 协议

MIT
