#!/usr/bin/env node
// Complete the runtime manifest so the deployed closure is fully declared —
// the auto-heal counterpart to build-sidecar.mjs's completeness gate.
//
// Why: when an official @deepseek-ai release adds NEW packages to the runtime
// closure (0.1.2-rc.1 added dsh-attachment / dsh-jobs / … — 7 in total), the
// auto-update workflow's bump only re-pins already-declared deps. The gate in
// build-sidecar.mjs then fails on all three platforms and the hourly cron
// loops on empty "rebuild" commits until a human declares the packages
// (0.1.1-rc.1: dsh-authorization, manual fix; 0.1.2-rc.1: 23 hours of 空转).
//
// This script materializes the closure exactly like build-sidecar does,
// runs the same scan (shared via sidecar/closure-check.mjs), and declares
// each missing published package at its highest acceptable version
// (x.y.z / x.y.z-rc.N — same filter as the workflow). Idempotent: declares
// nothing and exits 0 when the closure is whole.
//
// Usage: node scripts/complete-closure.mjs   # from the dsh-desktop repo root

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolvePnpmEntry, scanMissing, KNOWN_UNPUBLISHED } from '../sidecar/closure-check.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url)) // dsh-desktop/
const MANIFEST_DIR = join(ROOT, 'sidecar', 'runtime-manifest')
const STAGING = join(ROOT, 'sidecar', 'staging')
const RUNTIME_DIR = join(STAGING, 'dsh-desktop-runtime')
const PNPM = resolvePnpmEntry()
if (!PNPM) fail('pnpm 未找到：请先 npm install -g pnpm@11（Windows 需要 pnpm.mjs 文件路径）')

function fail(msg) {
  console.error(`[complete-closure] ${msg}`)
  process.exit(1)
}

function runPnpm(args) {
  // Windows: execFileSync can't run .cmd shims — invoke pnpm.mjs via node.
  const argv = process.platform === 'win32' ? [PNPM, ...args] : args
  execFileSync(process.platform === 'win32' ? process.execPath : PNPM, argv, { stdio: 'inherit' })
}

// Highest acceptable version on npm (x.y.z / x.y.z-rc.N, semver order with
// 正式版 > same-base rc), or null when the package has none.
async function bestAcceptable(pkg) {
  const doc = await (await fetch(`https://registry.npmjs.org/${pkg.replace('/', '%2F')}`)).json()
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(rc)\.(\d+))?$/.exec(v)
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === 'rc' ? Number(m[5]) : Infinity] : null
  }
  const entries = Object.entries(doc.versions).map(([v]) => [v, parse(v)]).filter(([, p]) => p)
  entries.sort((a, b) => {
    for (let i = 0; i < 4; i++) if (a[1][i] !== b[1][i]) return a[1][i] - b[1][i]
    return 0
  })
  return entries.length ? entries[entries.length - 1][0] : null
}

// ── 1. materialize the closure (mirror of build-sidecar's [1/4]) ─────────
console.log('[1/2] Installing runtime closure…')
rmSync(STAGING, { recursive: true, force: true })
mkdirSync(STAGING, { recursive: true })
cpSync(MANIFEST_DIR, RUNTIME_DIR, { recursive: true })
runPnpm(['--dir', RUNTIME_DIR, 'install', '--prod', '--node-linker=hoisted',
  '--config.auto-install-peers=false', '--config.confirmModulesPurge=false',
  // minimum-release-age=0: the workflow resolves freshly-published official
  // RCs; pnpm 11's default 24h supply-chain cutoff would reject them.
  '--config.minimum-release-age=0', '--frozen-lockfile'])

// ── 2. scan + declare whatever the gate would flag ───────────────────────
const missing = scanMissing(join(RUNTIME_DIR, 'node_modules'))
const hard = missing.filter(([name]) => name.startsWith('@deepseek-ai/') && !KNOWN_UNPUBLISHED.has(name))
if (!hard.length) {
  console.log('[2/2] closure complete — nothing to declare')
  process.exit(0)
}

console.log(`[2/2] ${hard.length} undeclared closure package(s), querying npm…`)
const pjPath = join(MANIFEST_DIR, 'package.json')
const j = JSON.parse(readFileSync(pjPath, 'utf8'))
let failures = 0
for (const [name, from] of hard) {
  if (j.dependencies[name]) continue
  const best = await bestAcceptable(name)
  if (!best) {
    console.error(`  ! ${name} (needed by ${from.join(', ')}) has no acceptable npm version — declare manually`)
    failures++
    continue
  }
  j.dependencies[name] = best
  console.log(`  declare ${name}@${best} <- ${from.join(', ')}`)
}
writeFileSync(pjPath, JSON.stringify(j, null, 2) + '\n')
if (failures) fail(`${failures} package(s) still undeclared — see above`)
console.log(`  wrote ${pjPath} — run 'pnpm install --lockfile-only' in sidecar/runtime-manifest to sync the lockfile`)
