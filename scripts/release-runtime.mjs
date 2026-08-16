#!/usr/bin/env node
// Publish a dsh runtime artifact to GitHub Releases (deepseek-harness-runtime).
//
// Pipeline: build the sidecar runtime (build-sidecar.mjs, which also packs the
// tarball) → sha256 → minisign sign → create release
// `dsh-runtime-<v>-<platform>` → upload tar.gz + .sha256 + .minisig.
//
// Usage:
//   node scripts/release-runtime.mjs [--owner alanpeng] [--key <path>]
//                                    [--platform windows-x86_64] [--node-from-exec]
//                                    [--skip-upload] [--upload-only] [--skip-build]
// --platform        artifact/tag platform suffix; default windows-x86_64
// --node-from-exec  passed through to build-sidecar (CI: node 24 from setup-node)
// Requires GITHUB_TOKEN (repo scope). Signing key defaults to
// D:\secrets\dsh-updater.key (+ .pass), or TAURI_SIGNING_PRIVATE_KEY[_PATH].

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DIST = join(ROOT, 'sidecar', 'dist')
// Windows: `npx` is a .cmd shim that CreateProcess refuses through
// execFileSync — invoke the real JS entry via the current node instead.
const TAURI_CLI = join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')

const args = parseArgs(process.argv.slice(2))
const PLATFORM = args.platform || 'windows-x86_64'
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

// ── 1. build the runtime dir + tarball ───────────────────────────────────
// build-sidecar.mjs now packs sidecar/dist/dsh-runtime-<v>-<platform>.tar.gz
// itself (same `runtime/` top-level layout).
if (!args['upload-only'] && !args['skip-build']) {
  console.log('[1/4] Building sidecar runtime…')
  const flags = ['--platform', PLATFORM]
  if (args['node-from-exec']) flags.push('--node-from-exec')
  execFileSync(process.execPath, [join(ROOT, 'sidecar', 'build-sidecar.mjs'), ...flags], { stdio: 'inherit' })
}

// ── 2. read the dsh version ──────────────────────────────────────────────
const pjPath = join(ROOT, 'sidecar', 'runtime', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
if (!existsSync(pjPath)) fail(`dsh package.json not found at ${pjPath}`)
const VERSION = JSON.parse(readFileSync(pjPath, 'utf8')).version
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(VERSION)) fail(`bad dsh version: ${VERSION}`)
const TAG = `dsh-runtime-${VERSION}-${PLATFORM}`
console.log(`[2/4] dsh version: ${VERSION} (tag ${TAG})`)

// ── 3. sha256 + signature over the packed tarball ────────────────────────
mkdirSync(DIST, { recursive: true })
const GZ = join(DIST, `${TAG}.tar.gz`)
const SHA = join(DIST, `${TAG}.tar.gz.sha256`)
const SIG = join(DIST, `${TAG}.tar.gz.minisig`)

if (!args['upload-only']) {
  if (!existsSync(GZ)) fail(`tarball not found at ${GZ}（先运行 build-sidecar.mjs）`)
  console.log('[3/4] Signing…')

  const hex = createHash('sha256').update(readFileSync(GZ)).digest('hex')
  writeFileSync(SHA, `${hex}  ${TAG}.tar.gz\n`)

  // CI injects the key CONTENT via TAURI_SIGNING_PRIVATE_KEY (the local
  // D:\secrets path does not exist there) — materialize it into a temp file
  // the tauri CLI can open.
  let keyPath = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || KEY_PATH
  if (!process.env.TAURI_SIGNING_PRIVATE_KEY_PATH && process.env.TAURI_SIGNING_PRIVATE_KEY) {
    keyPath = join(DIST, '.dsh-updater.key.tmp')
    writeFileSync(keyPath, process.env.TAURI_SIGNING_PRIVATE_KEY)
  }
  const passPath = 'D:\\secrets\\dsh-updater.key.pass'
  const pass = process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    || (existsSync(passPath) ? readFileSync(passPath, 'utf8').trim() : '')
  // The tauri CLI reads TAURI_SIGNING_PRIVATE_KEY[_PATH] from the environment
  // itself; CI injects the key content as a secret, so both our -f argument
  // and the env var would be active and the CLI rejects the combination
  // ("cannot be used with"). We already pass the key location explicitly —
  // strip both vars so the CLI only sees -f.
  const signerEnv = { ...process.env }
  delete signerEnv.TAURI_SIGNING_PRIVATE_KEY
  delete signerEnv.TAURI_SIGNING_PRIVATE_KEY_PATH
  execFileSync(process.execPath, [TAURI_CLI, 'signer', 'sign', '-f', keyPath, '-p', pass, GZ],
    { stdio: 'inherit', env: signerEnv })
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
  // Idempotent: re-running the same version (CI matrix re-run, tag rebuild)
  // uploads onto the existing release instead of failing on a duplicate tag.
  const rel = await api(`/repos/${OWNER}/${REPO}/releases`, {
    method: 'POST',
    body: {
      tag_name: TAG,
      name: TAG,
      body: `dsh runtime ${VERSION}\n\nSource: npm @deepseek-ai/dsh@${VERSION}`,
    },
  }).catch(async (err) => {
    const existing = await api(`/repos/${OWNER}/${REPO}/releases/tags/${TAG}`).catch(() => null)
    if (!existing) throw err
    console.log(`  release ${TAG} 已存在，复用现有 release`)
    return existing
  })
  releaseId = rel.id
}

async function upload(file, name) {
  const url = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`
  const size = statSync(file).size
  console.log(`  uploading ${name} (${Math.round(size / 1048576)} MB)…`)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/octet-stream',
      'User-Agent': 'dsh-desktop-release',
      // GitHub uploads API rejects chunked transfer — send an explicit
      // Content-Length (stream length is known via statSync).
      'Content-Length': String(size),
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
  console.log(`\n--skip-upload：工件已就绪（${GZ} + .sha256 + .minisig）`)
  console.log(`完整发布：GITHUB_TOKEN=... node scripts/release-runtime.mjs --upload-only --skip-build`)
} else {
  await upload(GZ, `${TAG}.tar.gz`)
  await upload(SHA, `${TAG}.tar.gz.sha256`)
  await upload(SIG, `${TAG}.tar.gz.minisig`)
}

// ── hygiene: the artifacts live on GitHub now ────────────────────────────
if (!args['skip-upload']) {
  rmSync(GZ, { force: true })
  rmSync(SHA, { force: true })
  rmSync(SIG, { force: true })
  console.log(`\n已发布 https://github.com/${OWNER}/${REPO}/releases/tag/${TAG}`)
  console.log(`客户端将检查 npm dist-tag 并下载 ${TAG}.tar.gz`)
}
