#!/usr/bin/env node
// Merge the per-platform latest.json fragments produced by
// release-desktop.mjs --fragment into the final latest.json and upload it to
// the GitHub release `v<version>` (deepseek-harness-desktop).
//
// Usage (finalize job of release.yml):
//   node scripts/merge-latest.mjs --dir <fragments dir> --version 0.1.1
//       [--owner alanpeng]
// Requires GITHUB_TOKEN (repo scope). The fragments dir contains the four
// latest-<platform>.json files downloaded from the build jobs.

import { createReadStream, existsSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const args = parseArgs(process.argv.slice(2))
const FRAG_DIR = args.dir
const VERSION = args.version
const OWNER = args.owner || process.env.DSH_REPO_OWNER || 'alanpeng'
const REPO = 'deepseek-harness-desktop'
const TOKEN = process.env.GITHUB_TOKEN

if (!FRAG_DIR) fail('--dir 必填（fragments 目录）')
if (!VERSION) fail('--version 必填')
if (!TOKEN) fail('GITHUB_TOKEN 未设置（repo scope）')

// Every platform the shell updater can ask for — CI must produce all of them,
// or a client on that platform silently never finds updates.
// (macos-x86_64 absent: GitHub has no free Intel macOS runner as of 2026-08.)
const REQUIRED = ['windows-x86_64-nsis', 'windows-x86_64', 'macos-aarch64', 'linux-x86_64']

function fail(msg) {
  console.error(`[merge-latest] ${msg}`)
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

// ── merge ────────────────────────────────────────────────────────────────
const platforms = {}
let notes = null
let pub_date = null
for (const f of ['windows-x86_64', 'macos-aarch64', 'linux-x86_64']) {
  const path = join(FRAG_DIR, `latest-${f}.json`)
  if (!existsSync(path)) fail(`缺少 fragment: ${path}（对应 build job 未产出）`)
  const frag = JSON.parse(readFileSync(path, 'utf8'))
  if (frag.version !== VERSION) fail(`fragment ${f} 版本 ${frag.version} ≠ ${VERSION} —— build 与 finalize 版本不一致`)
  if (frag.notes) notes ||= frag.notes
  if (frag.pub_date) pub_date ||= frag.pub_date
  for (const [key, entry] of Object.entries(frag.platforms)) platforms[key] = entry
}

const missing = REQUIRED.filter((k) => !platforms[k])
if (missing.length) fail(`合并后缺少平台条目: ${missing.join(', ')}`)

const manifest = {
  version: VERSION,
  notes,
  pub_date: pub_date || new Date().toISOString(),
  platforms,
}
const outPath = join(ROOT, 'latest.json')
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n')
console.log(`合并 ${Object.keys(platforms).length} 个平台条目 → ${outPath}`)

// ── upload ───────────────────────────────────────────────────────────────
const rel = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/v${VERSION}`, {
  headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-desktop-release' },
}).catch(() => null)
if (!rel || !rel.ok) fail(`release v${VERSION} 不存在（create-release job 失败？）`)
const release = await rel.json()

const url = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=latest.json`
const size = statSync(outPath).size
const res = await fetch(url, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/octet-stream',
    'User-Agent': 'dsh-desktop-release',
    'Content-Length': String(size),
  },
  body: createReadStream(outPath),
  duplex: 'half',
})
if (!res.ok) {
  const text = await res.text()
  fail(`上传 latest.json 失败: ${res.status} ${text.slice(0, 300)}`)
}
rmSync(outPath, { force: true })
console.log(`已上传 latest.json → https://github.com/${OWNER}/${REPO}/releases/download/v${VERSION}/latest.json`)
