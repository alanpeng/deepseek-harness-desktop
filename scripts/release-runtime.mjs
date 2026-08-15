#!/usr/bin/env node
// Publish a dsh runtime artifact to GitHub Releases (deepseek-harness-runtime).
//
// Pipeline: build the sidecar runtime → tarball → sha256 → minisign sign →
// create release `dsh-runtime-<v>` → upload tar.gz + .sha256 + .minisig.
//
// Usage:
//   node scripts/release-runtime.mjs [--owner alanpeng] [--key <path>]
//                                    [--skip-upload] [--upload-only]
// Requires GITHUB_TOKEN (repo scope). Signing key defaults to
// D:\secrets\dsh-updater.key (+ .pass), or TAURI_SIGNING_PRIVATE_KEY[_PATH].

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TAR = 'C:\\Windows\\System32\\tar.exe'
const DIST = join(ROOT, 'sidecar', 'dist')
// Windows: `npx` is a .cmd shim that CreateProcess refuses through
// execFileSync — invoke the real JS entry via the current node instead.
const TAURI_CLI = join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')

const args = parseArgs(process.argv.slice(2))
const OWNER = args.owner || process.env.DSH_REPO_OWNER || 'alanpeng'
const REPO = 'deepseek-harness-runtime'
const TOKEN = process.env.GITHUB_TOKEN
if (!TOKEN && !args['skip-upload']) fail('GITHUB_TOKEN 未设置（repo scope）')
const KEY_PATH = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || 'D:\\secrets\\dsh-updater.key'
if (!process.env.TAURI_SIGNING_PRIVATE_KEY && !process.env.TAURI_SIGNING_PRIVATE_KEY_PATH && !existsSync(KEY_PATH)) {
  fail(`签名密钥不存在: ${KEY_PATH}（或用 TAURI_SIGNING_PRIVATE_KEY 环境变量）`)
}

function fail(msg) {
  console.error(`[release-runtime] ${msg}`)
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

// ── 1. build the runtime dir ─────────────────────────────────────────────
if (!args['upload-only'] && !args['skip-build']) {
  console.log('[1/4] Building sidecar runtime…')
  execFileSync(process.execPath, [join(ROOT, 'sidecar', 'build-sidecar.mjs')], { stdio: 'inherit' })
}

// ── 2. read the dsh version ──────────────────────────────────────────────
const pjPath = join(ROOT, 'sidecar', 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
if (!existsSync(pjPath)) fail(`dsh package.json not found at ${pjPath}`)
const VERSION = JSON.parse(readFileSync(pjPath, 'utf8')).version
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(VERSION)) fail(`bad dsh version: ${VERSION}`)
const TAG = `dsh-runtime-${VERSION}`
console.log(`[2/4] dsh version: ${VERSION} (tag ${TAG})`)

// ── 3. tarball + hashes + signature ──────────────────────────────────────
mkdirSync(DIST, { recursive: true })
const GZ = join(DIST, `${TAG}.tar.gz`)
const SHA = join(DIST, `${TAG}.tar.gz.sha256`)
const SIG = join(DIST, `${TAG}.tar.gz.minisig`)

if (!args['upload-only']) {
  console.log('[3/4] Packing + signing…')
  rmSync(GZ, { force: true })
  // Top-level dir is `runtime/` (the app resolves it via find_top_dir).
  const rc = spawnSync(TAR, ['-czf', GZ, '-C', join(ROOT, 'sidecar'), 'runtime'], { stdio: 'inherit' })
  if (rc.status !== 0) fail(`tar pack failed (exit ${rc.status})`)

  const hex = createHash('sha256').update(readFileSync(GZ)).digest('hex')
  writeFileSync(SHA, `${hex}  ${TAG}.tar.gz\n`)

  const keyPath = KEY_PATH
  const passPath = 'D:\\secrets\\dsh-updater.key.pass'
  const pass = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    || (existsSync(passPath) ? readFileSync(passPath, 'utf8').trim() : '')
  execFileSync(process.execPath, [TAURI_CLI, 'signer', 'sign', '-f', keyPath, '-p', pass, GZ], { stdio: 'inherit' })
  // tauri signer writes <file>.sig as base64 of the standard minisign text on
  // a single line (that's the format the shell updater's latest.json wants).
  // The runtime updater (minisign-verify Signature::from_file) needs the
  // standard 4-line text — decode one layer when writing .minisig.
  rmSync(SIG, { force: true })
  if (existsSync(`${GZ}.sig`)) {
    const raw = readFileSync(`${GZ}.sig`, 'utf8').trim()
    const text = Buffer.from(raw, 'base64').toString('utf8')
    if (!text.startsWith('untrusted comment:')) fail(`签名解码异常: ${text.slice(0, 60)}`)
    writeFileSync(SIG, text.endsWith('\n') ? text : text + '\n')
  }
  if (!existsSync(SIG)) fail('minisign 签名未生成（.minisig 缺失）')
}

const gzSizeMB = existsSync(GZ) ? Math.round(statSync(GZ).size / 1048576) : 0

// ── 4. GitHub release + upload ───────────────────────────────────────────
let releaseId = null
if (args['skip-upload']) {
  // Fully offline: artifacts only, no GitHub API calls.
  console.log('[4/4] Skipping GitHub (--skip-upload)')
} else if (args['upload-only']) {
  const rel = await api(`/repos/${OWNER}/${REPO}/releases/tags/${TAG}`).catch(() => null)
  if (!rel) fail(`release ${TAG} 不存在，无法 --upload-only`)
  releaseId = rel.id
} else {
  console.log('[4/4] Creating release + uploading…')
  const rel = await api(`/repos/${OWNER}/${REPO}/releases`, {
    method: 'POST',
    body: {
      tag_name: TAG,
      name: TAG,
      body: `dsh runtime ${VERSION}\n\nSource: npm @deepseek-ai/dsh@${VERSION}`,
    },
  })
  releaseId = rel.id
}

async function upload(file, name) {
  const url = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`
  const size = file.stat ? file.stat.size : file.length
  console.log(`  uploading ${name} (${Math.round(size / 1048576)} MB)…`)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/octet-stream',
      'User-Agent': 'dsh-desktop-release',
    },
    body: file,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`upload ${name} failed: ${res.status} ${text.slice(0, 300)}`)
  }
  console.log(`  uploaded ${name}`)
}

if (args['skip-upload']) {
  console.log(`\n--skip-upload：工件已就绪（${GZ} + .sha256 + .minisig）`)
  console.log(`完整发布：GITHUB_TOKEN=... node scripts/release-runtime.mjs --upload-only --skip-build`)
} else {
  await upload(createReadStream(GZ), `${TAG}.tar.gz`)
  await upload(createReadStream(SHA), `${TAG}.tar.gz.sha256`)
  await upload(createReadStream(SIG), `${TAG}.tar.gz.minisig`)
}

// ── hygiene: the artifacts live on GitHub now ────────────────────────────
if (!args['skip-upload']) {
  rmSync(GZ, { force: true })
  rmSync(SHA, { force: true })
  rmSync(SIG, { force: true })
  console.log(`\n已发布 https://github.com/${OWNER}/${REPO}/releases/tag/${TAG}`)
  console.log(`客户端将检查 npm dist-tag 并下载 ${TAG}.tar.gz`)
}
