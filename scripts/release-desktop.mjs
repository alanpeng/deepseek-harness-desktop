#!/usr/bin/env node
// Release the desktop shell to GitHub Releases (deepseek-harness-desktop).
//
// Pipeline: bump versions → build (createUpdaterArtifacts + signing env) →
// write latest.json → create release `v<version>` → upload nsis.zip + latest.json.
//
// Usage:
//   node scripts/release-desktop.mjs --version 0.2.0 [--notes "..."] [--notes-file f]
//       [--owner alanpeng] [--no-sidecar] [--skip-build] [--skip-upload] [--upload-only] [--upload-exe]
//       [--config <json>] [--download-base <url>]
// Requires GITHUB_TOKEN. Signing key defaults to D:\secrets\dsh-updater.key
// (+ .pass), or TAURI_SIGNING_PRIVATE_KEY[_PATH].

import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC_TAURI = join(ROOT, 'src-tauri')
// Windows: `npx` is a .cmd shim that CreateProcess refuses through
// execFileSync — invoke the real JS entry via the current node instead.
const TAURI_CLI = join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
const BUNDLE_DIR = join(SRC_TAURI, 'target', 'release', 'bundle', 'nsis')
const KEY_PATH = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || 'D:\\secrets\\dsh-updater.key'
const PASS_PATH = 'D:\\secrets\\dsh-updater.key.pass'

const args = parseArgs(process.argv.slice(2))
const VERSION = args.version
const OWNER = args.owner || process.env.DSH_REPO_OWNER || 'alanpeng'
const REPO = 'deepseek-harness-desktop'
const TOKEN = process.env.GITHUB_TOKEN

if (!VERSION) fail('--version 必填（如 0.2.0）')
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(VERSION)) fail(`非法版本号: ${VERSION}`)
if (!TOKEN && !args['skip-upload']) fail('GITHUB_TOKEN 未设置（repo scope）')
if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH) {
  if (!existsSync(KEY_PATH)) fail(`签名密钥不存在: ${KEY_PATH}（或用 TAURI_SIGNING_PRIVATE_KEY 环境变量）`)
}

const NOTES = args['notes'] || (args['notes-file'] && existsSync(args['notes-file']) ? readFileSync(args['notes-file'], 'utf8') : '')

function fail(msg) {
  console.error(`[release-desktop] ${msg}`)
  process.exit(1)
}

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) { out[key] = next; i++ } else out[key] = true
    }
  }
  return out
}

const api = async (path, opts = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    method: opts.method || 'GET',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'dsh-desktop-release',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`GitHub API ${opts.method || 'GET'} ${path}: ${res.status} ${text.slice(0, 300)}`)
  }
  return res.status === 204 ? null : res.json()
}

// ── 1. bump versions ─────────────────────────────────────────────────────
if (!args['upload-only']) {
  console.log('[1/5] Bumping versions…')

  // package.json
  const pkgPath = join(ROOT, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.version = VERSION
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')

  // tauri.conf.json
  const confPath = join(SRC_TAURI, 'tauri.conf.json')
  const conf = JSON.parse(readFileSync(confPath, 'utf8'))
  conf.version = VERSION
  writeFileSync(confPath, JSON.stringify(conf, null, 2) + '\n')

  // Cargo.toml [package] version
  const cargoPath = join(SRC_TAURI, 'Cargo.toml')
  let cargo = readFileSync(cargoPath, 'utf8')
  cargo = cargo.replace(/^(version\s*=\s*")[^"]+(")/m, `$1${VERSION}$2`)
  if (!cargo.includes(`version = "${VERSION}"`)) fail('Cargo.toml 版本替换失败')
  writeFileSync(cargoPath, cargo)

  // Cargo.lock first [package] block
  const lockPath = join(SRC_TAURI, 'Cargo.lock')
  let lock = readFileSync(lockPath, 'utf8')
  lock = lock.replace(/^(\[\[package\]\]\nname = "dsh-desktop"\nversion = ")[^"]+(")/m, `$1${VERSION}$2`)
  writeFileSync(lockPath, lock)
  console.log(`  version → ${VERSION} (package.json / tauri.conf.json / Cargo.toml / Cargo.lock)`)
}

// ── 2. build (signed, createUpdaterArtifacts) ────────────────────────────
// Payload selection: tauri bundler 2.11.x only emits the bare setup.exe
// (+.sig) — never setup.exe.nsis.zip (checked nsis/mod.rs at tauri-cli-v2.11.4:
// no zip generation). The updater plugin accepts a bare .exe payload
// (infer::archive::is_zip check → falls back to write_to_temp + NSIS /UPDATE),
// so prefer the zip when a future bundler produces it, else the raw exe.
const SETUP = join(BUNDLE_DIR, `dsh-desktop_${VERSION}_x64-setup.exe`)
const ZIP = join(BUNDLE_DIR, `dsh-desktop_${VERSION}_x64-setup.exe.nsis.zip`)
let payload, payloadName, sig

if (args['upload-only']) {
  payload = existsSync(ZIP) ? ZIP : SETUP
  payloadName = payload === ZIP
    ? `dsh-desktop_${VERSION}_x64-setup.exe.nsis.zip`
    : `dsh-desktop_${VERSION}_x64-setup.exe`
  sig = `${payload}.sig`
  if (!existsSync(payload) || !existsSync(sig)) {
    fail(`--upload-only 但工件缺失: ${payload}`)
  }
} else {
  if (!args['no-sidecar']) {
    console.log('[2/5] Building sidecar runtime…')
    execFileSync(process.execPath, [join(ROOT, 'sidecar', 'build-sidecar.mjs')], { stdio: 'inherit' })
  }
  if (!args['skip-build']) {
    console.log('[3/5] tauri build (signed)…')
    const pass = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD
      || (existsSync(PASS_PATH) ? readFileSync(PASS_PATH, 'utf8').trim() : '')
    const buildArgs = ['build', '--bundles', 'nsis']
    // --config <json>: override config at build time (e.g. point the updater
    // endpoint at a local dev server for E2E testing).
    if (args.config) buildArgs.push('--config', args.config)
    execFileSync(process.execPath, [TAURI_CLI, ...buildArgs], {
      stdio: 'inherit',
      cwd: SRC_TAURI,
      env: {
        ...process.env,
        TAURI_SIGNING_PRIVATE_KEY: process.env.TAURI_SIGNING_PRIVATE_KEY || KEY_PATH,
        TAURI_SIGNING_PRIVATE_KEY_PASSWORD: pass,
      },
    })
  } else {
    console.log('[3/5] Skipping tauri build (--skip-build)…')
  }
  // Decide payload AFTER the build so a future bundler that emits the zip
  // still gets picked up; 2.11.x falls through to the bare exe.
  payload = existsSync(ZIP) ? ZIP : SETUP
  payloadName = payload === ZIP
    ? `dsh-desktop_${VERSION}_x64-setup.exe.nsis.zip`
    : `dsh-desktop_${VERSION}_x64-setup.exe`
  sig = `${payload}.sig`
  for (const f of [payload, sig]) {
    if (!existsSync(f)) fail(`构建产物缺失: ${f}`)
  }
}

// ── 3. latest.json ───────────────────────────────────────────────────────
console.log('[4/5] Writing latest.json…')
const signature = readFileSync(sig, 'utf8').trim()
// --download-base overrides asset URLs (local dev server / mirrors / E2E).
const downloadBase = args['download-base']
  || `https://github.com/${OWNER}/${REPO}/releases/download/v${VERSION}`
const manifest = {
  version: VERSION,
  notes: NOTES || null,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64-nsis': {
      url: `${downloadBase}/${payloadName}`,
      signature,
    },
    'windows-x86_64': {
      url: `${downloadBase}/${payloadName}`,
      signature,
    },
  },
}
const manifestPath = join(BUNDLE_DIR, 'latest.json')
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')

// ── 4. release + upload ──────────────────────────────────────────────────
let releaseId = null
if (args['skip-upload']) {
  // Fully offline: build only, no GitHub API calls at all.
} else if (args['upload-only']) {
  const rel = await api(`/repos/${OWNER}/${REPO}/releases/tags/v${VERSION}`).catch(() => null)
  if (!rel) fail(`release v${VERSION} 不存在，无法 --upload-only`)
  releaseId = rel.id
} else {
  console.log('[5/5] Creating release + uploading…')
  const rel = await api(`/repos/${OWNER}/${REPO}/releases`, {
    method: 'POST',
    body: {
      tag_name: `v${VERSION}`,
      name: `v${VERSION}`,
      body: NOTES || `dsh-desktop ${VERSION}`,
    },
  })
  releaseId = rel.id
}

async function upload(file, name) {
  const url = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`
  console.log(`  uploading ${name} (${Math.round(statSync(file).size / 1048576)} MB)…`)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/octet-stream',
      'User-Agent': 'dsh-desktop-release',
      // GitHub uploads API rejects chunked transfer — send an explicit
      // Content-Length (stream length is known via statSync).
      'Content-Length': String(statSync(file).size),
    },
    // undici fetch rejects stream bodies without the duplex flag (Node 18+).
    body: createReadStream(file),
    duplex: 'half',
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`upload ${name} failed: ${res.status} ${text.slice(0, 300)}`)
  }
  console.log(`  uploaded ${name}`)
}

if (args['skip-upload']) {
  console.log(`\n--skip-upload：工件已就绪（${payload} + ${manifestPath}）`)
  console.log(`本地 E2E：dev-update-server 直接服务 ${manifestPath}（无需 GitHub）`)
  console.log(`正式发布：GITHUB_TOKEN=... node scripts/release-desktop.mjs --version ${VERSION} --no-sidecar`)
} else {
  await upload(payload, payloadName)
  if (args['upload-exe'] && payload === ZIP && existsSync(SETUP)) {
    await upload(SETUP, `dsh-desktop_${VERSION}_x64-setup.exe`)
  }
  await upload(manifestPath, 'latest.json')
}

// ── 5. hygiene (artifacts live on GitHub; C: is tight) ───────────────────
if (!args['skip-upload']) {
  rmSync(payload, { force: true })
  rmSync(sig, { force: true })
  rmSync(manifestPath, { force: true })
  console.log(`\n已发布 https://github.com/${OWNER}/${REPO}/releases/tag/v${VERSION}`)
  console.log(`客户端更新端点: ${downloadBase}/latest.json`)
}
