#!/usr/bin/env node
// Release the desktop shell to GitHub Releases (deepseek-harness-desktop).
//
// Pipeline: bump versions → build (createUpdaterArtifacts + signing env) →
// write latest.json → create release `v<version>` → upload bundle assets.
//
// Usage:
//   node scripts/release-desktop.mjs --version 0.2.0 [--notes "..."] [--notes-file f]
//       [--owner alanpeng] [--platform windows-x86_64] [--no-sidecar]
//       [--skip-build] [--skip-upload] [--upload-only] [--upload-exe]
//       [--fragment] [--release-tag v0.2.0] [--config <json>] [--download-base <url>]
//       [--clone <dsh clone dir>]
// Requires GITHUB_TOKEN. Signing key defaults to D:\secrets\dsh-updater.key
// (+ .pass), or TAURI_SIGNING_PRIVATE_KEY[_PATH].
//
// Platform model (CI runs one job per platform, all uploading to the same
// release v<version>):
//   windows-x86_64   bundles nsis, updater keys windows-x86_64(-nsis),
//                    payload setup.exe(.nsis.zip)
//   macos-x86_64     bundles app,dmg, updater key macos-x86_64,
//                    payload <app>.app.tar.gz, dmg uploaded as extra asset
//   macos-aarch64    same, key macos-aarch64
//   linux-x86_64     bundles deb,appimage, updater key linux-x86_64,
//                    payload .AppImage, deb uploaded as extra asset
//
// CI workflow (release.yml): a `create-release` job POSTs the release first;
// each build job runs with --fragment + --release-tag v<v> so it builds and
// uploads without racing on tag creation, then the finalize job merges the
// latest-<platform>.json fragments into the final latest.json and uploads it.
// Local runs (no --fragment) keep the old behavior: create the release here
// and upload latest.json directly.

import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC_TAURI = join(ROOT, 'src-tauri')
// Windows: `npx` is a .cmd shim that CreateProcess refuses through
// execFileSync — invoke the real JS entry via the current node instead.
const TAURI_CLI = join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
const KEY_PATH = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || 'D:\\secrets\\dsh-updater.key'
const PASS_PATH = 'D:\\secrets\\dsh-updater.key.pass'

const args = parseArgs(process.argv.slice(2))
const VERSION = args.version
const OWNER = args.owner || process.env.DSH_REPO_OWNER || 'alanpeng'
const REPO = 'deepseek-harness-desktop'
const TOKEN = process.env.GITHUB_TOKEN
const PLATFORM = args.platform || 'windows-x86_64'

const PLATFORMS = {
  'windows-x86_64': {
    bundles: 'nsis',
    keys: ['windows-x86_64-nsis', 'windows-x86_64'],
    // bundle subdir → match pattern → updater payload (sig = payload + '.sig')
    bundleDirs: ['nsis'],
  },
  'macos-x86_64': { bundles: 'app,dmg', keys: ['macos-x86_64'], bundleDirs: ['macos'] },
  'macos-aarch64': { bundles: 'app,dmg', keys: ['macos-aarch64'], bundleDirs: ['macos'] },
  'linux-x86_64': { bundles: 'deb,appimage', keys: ['linux-x86_64'], bundleDirs: ['appimage', 'deb'] },
}
if (!PLATFORMS[PLATFORM]) fail(`未知平台 ${PLATFORM}（可用: ${Object.keys(PLATFORMS).join(', ')}）`)

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

// Discover bundle outputs. Payload = the updater artifact (setup.exe /
// .app.tar.gz / .AppImage) with its `payload + '.sig'`; extras = installers
// the updater doesn't consume but users want in the release (dmg, deb).
function findPayloads() {
  const base = join(SRC_TAURI, 'target', 'release', 'bundle')
  const candidates = []
  for (const sub of PLATFORMS[PLATFORM].bundleDirs) {
    const dir = join(base, sub)
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) candidates.push(join(dir, f))
  }
  let payload = null
  if (PLATFORM.startsWith('windows')) {
    const zip = candidates.find((f) => f.endsWith('.exe.nsis.zip') && f.includes(`_${VERSION}_`))
    const exe = candidates.find((f) => f.endsWith('-setup.exe') && f.includes(`_${VERSION}_`))
    payload = zip || exe
  } else if (PLATFORM.startsWith('macos')) {
    payload = candidates.find((f) => f.endsWith('.app.tar.gz'))
  } else {
    payload = candidates.find((f) => f.endsWith('.AppImage'))
  }
  if (!payload) fail(`未找到 ${PLATFORM} 的 updater payload（bundle 目录: ${base}）`)
  const sig = `${payload}.sig`
  if (!existsSync(sig)) fail(`签名缺失: ${sig}`)
  const extras = PLATFORM.startsWith('macos')
    ? candidates.filter((f) => f.endsWith('.dmg'))
    : PLATFORM.startsWith('linux')
      ? candidates.filter((f) => f.endsWith('.deb'))
      : []
  return { payload, sig, extras }
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
if (!args['upload-only']) {
  if (!args['no-sidecar']) {
    console.log('[2/5] Building sidecar runtime…')
    const flags = ['--platform', PLATFORM]
    if (args['node-from-exec']) flags.push('--node-from-exec')
    if (args.clone) flags.push('--clone', args.clone)
    execFileSync(process.execPath, [join(ROOT, 'sidecar', 'build-sidecar.mjs'), ...flags], { stdio: 'inherit' })
  }
  if (!args['skip-build']) {
    console.log('[3/5] tauri build (signed)…')
    const pass = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD
      || (existsSync(PASS_PATH) ? readFileSync(PASS_PATH, 'utf8').trim() : '')
    const buildArgs = ['build', '--bundles', PLATFORMS[PLATFORM].bundles]
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
}
const { payload, sig, extras } = findPayloads()

// ── 3. latest.json (fragment when --fragment) ────────────────────────────
// --download-base overrides asset URLs (local dev server / mirrors / E2E).
const downloadBase = args['download-base']
  || `https://github.com/${OWNER}/${REPO}/releases/download/v${VERSION}`
// tauri asset names carry architecture (x64 / aarch64 / amd64) but not the
// platform, and the macOS updater artifact is bare <app>.app.tar.gz. Prefix
// a platform segment so release assets are self-describing:
//   dsh-desktop_<v>_win_x64-setup.exe
//   dsh-desktop_<v>_macos-aarch64.app.tar.gz   (+ _macos-aarch64.dmg)
//   dsh-desktop_<v>_linux_amd64.AppImage       (+ _linux_amd64.deb)
// "linux" (not "ubuntu"): the AppImage runs on any distro with glibc ≥2.35.
// Signatures are content-bound, not name-bound, so renaming is safe;
// latest.json URLs follow.
function qualifyAssetName(fname) {
  if (PLATFORM === 'windows-x86_64') return fname.replace('_x64-setup', '_win_x64-setup')
  if (PLATFORM === 'macos-aarch64') {
    if (fname === 'dsh-desktop.app.tar.gz') return `dsh-desktop_${VERSION}_macos-aarch64.app.tar.gz`
    return fname.replace('_aarch64.dmg', '_macos-aarch64.dmg')
  }
  if (PLATFORM === 'linux-x86_64') return fname.replace('_amd64.', '_linux_amd64.')
  return fname
}
let payloadName = qualifyAssetName(payload.split(/[\\/]/).pop())
const signature = readFileSync(sig, 'utf8').trim()
const fragment = {
  version: VERSION,
  notes: NOTES || null,
  pub_date: new Date().toISOString(),
  platforms: {},
}
for (const key of PLATFORMS[PLATFORM].keys) {
  fragment.platforms[key] = { url: `${downloadBase}/${payloadName}`, signature }
}
const fragmentName = args.fragment ? `latest-${PLATFORM}.json` : 'latest.json'
const manifestPath = join(SRC_TAURI, 'target', 'release', 'bundle', fragmentName)
writeFileSync(manifestPath, JSON.stringify(fragment, null, 2) + '\n')
console.log(`[4/5] Wrote ${fragmentName} (${Object.keys(fragment.platforms).join(', ')})`)

// ── 4. release + upload ──────────────────────────────────────────────────
let releaseId = null
if (args['skip-upload']) {
  // Fully offline: build only, no GitHub API calls at all.
} else if (args['upload-only']) {
  const rel = await api(`/repos/${OWNER}/${REPO}/releases/tags/v${VERSION}`).catch(() => null)
  if (!rel) fail(`release v${VERSION} 不存在，无法 --upload-only`)
  releaseId = rel.id
} else if (args['release-tag']) {
  // CI build job: the create-release job already made the tag; upload onto it.
  const rel = await api(`/repos/${OWNER}/${REPO}/releases/tags/${args['release-tag']}`).catch(() => null)
  if (!rel) fail(`release ${args['release-tag']} 不存在（先跑 create-release job）`)
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
    // Idempotent re-runs: same version re-triggered, asset already on the
    // release — treat same-size duplicates as success instead of failing.
    if (res.status === 422) {
      const existing = await api(`/repos/${OWNER}/${REPO}/releases/${releaseId}/assets`).catch(() => [])
      const hit = existing.find((a) => a.name === name)
      if (hit && hit.size === statSync(file).size) {
        console.log(`  ${name} 已存在（同尺寸），跳过`)
        return
      }
    }
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
  if (args['upload-exe'] && payloadName.endsWith('.zip')) {
    await upload(payload.replace(/\.zip$/, ''), payloadName.replace(/\.nsis\.zip$/, ''))
  }
  for (const extra of extras) await upload(extra, qualifyAssetName(extra.split(/[\\/]/).pop()))
  // Fragment mode: the finalize job merges fragments and uploads latest.json.
  if (!args.fragment) await upload(manifestPath, 'latest.json')
}

// ── 5. hygiene (artifacts live on GitHub; C: is tight) ───────────────────
if (!args['skip-upload']) {
  rmSync(payload, { force: true })
  rmSync(sig, { force: true })
  // Keep the fragment in place — the CI finalize job needs it after this job
  // ends (it is picked up by upload-artifact, which runs later in the job).
  if (!args.fragment) rmSync(manifestPath, { force: true })
  console.log(`\n已发布 https://github.com/${OWNER}/${REPO}/releases/tag/v${VERSION}`)
  console.log(`客户端更新端点: ${downloadBase}/latest.json`)
}
