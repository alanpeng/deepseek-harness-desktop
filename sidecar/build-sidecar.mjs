#!/usr/bin/env node
// Build the dsh web host runtime directory for the desktop bundle.
//
// Pipeline:
//   1. `pnpm deploy` materializes the desktop-runtime closure manifest
//      (packages/desktop/desktop-runtime in the dsh clone) into a flat
//      hoisted node_modules tree — no devDeps, peers listed explicitly.
//   2. Assemble `sidecar/runtime/`: the deploy tree + a stock Node 24 exe.
//      Tauri's `bundle.resources` ships this directory inside the installer
//      as `dsh-runtime`, and the app spawns `node.exe entry.mjs` from there.
//
// Why a directory instead of a single packaged exe: dsh is a cordis plugin
// host whose loader resolves plugins by name at runtime (dynamic import), and
// pkg — in any mode — compiles modules with `vm`, which cannot execute
// dynamic import without an importModuleDynamicallyCallback it never
// provides. Worse, its --sea mode let dynamic imports fall back to the REAL
// filesystem, silently depending on the staging dir (present on dev
// machines, absent on clean installs). Running stock node against a bundled
// tree behaves exactly like dev and supports everything dsh needs (ESM,
// dynamic imports, native modules like sharp / node-pty).

import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)) // dsh-desktop/
const CLONE = resolve(ROOT, '..', 'deepseek-harness')
const RUNTIME_PKG = 'packages/desktop/desktop-runtime'
const STAGING = join(ROOT, 'sidecar', 'staging')
const RUNTIME_DIR = join(STAGING, 'dsh-desktop-runtime') // pnpm deploy names the target after the package
const RUNTIME_OUT = join(ROOT, 'sidecar', 'runtime') // what the installer ships as dsh-runtime
const NODE_EXE = 'C:\\Program Files\\nodejs\\node.exe' // stock Node 24, same family the dev flow uses

// Windows: never spawn `pnpm` by bare name — under Git Bash the PATH
// entries are POSIX shell scripts that CreateProcess refuses (EINVAL), and
// the .cmd shims are equally unreliable through execFileSync. Invoke the real
// JS entry via the current node instead.
const NODE = process.execPath
const PNPM_ENTRY = join(process.env.APPDATA, 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')

function requireEntry(entry, what) {
  if (!existsSync(entry)) throw new Error(`${what} entry not found at ${entry}`)
  return entry
}

function run(args, opts = {}) {
  console.log(`\n$ node ${args.join(' ')}`)
  execFileSync(NODE, args, { stdio: 'inherit', ...opts })
}

// ── 1. deploy the closure ────────────────────────────────────────────────
console.log('[1/3] Deploying desktop-runtime closure')
rmSync(STAGING, { recursive: true, force: true })
mkdirSync(STAGING, { recursive: true })
// pnpm 11 deploy: `--filter=<package name>` selects the project, `--legacy`
// opts out of the injected-workspace requirement (this workspace does not set
// inject-workspace-packages), the target dir is the only positional arg.
run([requireEntry(PNPM_ENTRY, 'pnpm'), '--dir', CLONE,
  '--filter=dsh-desktop-runtime',
  'deploy',
  '--legacy',
  '--prod',
  '--config.node-linker=hoisted',
  '--config.auto-install-peers=false',
  '--config.link-workspace-packages=true',
  RUNTIME_DIR,
])

// Sanity: the peers the web profile relies on must exist in the deployed tree.
for (const pkg of ['@deepseek-ai/dsh-shell-env', '@deepseek-ai/dsh-invariants', '@deepseek-ai/dsh-web-app']) {
  const probe = join(RUNTIME_DIR, 'node_modules', pkg, 'package.json')
  if (!existsSync(probe)) throw new Error(`deployed closure is missing ${pkg}`)
}
if (!existsSync(join(RUNTIME_DIR, 'entry.mjs'))) throw new Error(`deployed closure is missing entry.mjs`)

// Closure completeness: pnpm deploy does not install peer deps
// (auto-install-peers=false). Any @deepseek-ai/* package that some deployed
// package statically depends on must be declared explicitly in the runtime
// manifest, or the loader dies at boot (ERR_MODULE_NOT_FOUND at import time).
checkClosure(RUNTIME_DIR)

function checkClosure(root) {
  const modules = join(root, 'node_modules')
  const present = new Set()
  for (const f of readdirSync(modules)) {
    if (f.startsWith('@')) {
      for (const g of readdirSync(join(modules, f))) present.add(`${f}/${g}`)
    } else present.add(f)
  }
  const missing = new Map() // name -> Set of declaring packages
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (!entry.isDirectory()) continue
      const pjPath = join(p, 'package.json')
      if (!existsSync(pjPath)) { walk(p); continue }
      const pj = JSON.parse(readFileSync(pjPath, 'utf8'))
      // optionalDependencies may legitimately be absent (platform variants).
      for (const [kind, deps] of [['dependencies', pj.dependencies], ['peers', pj.peerDependencies]]) {
        if (!deps) continue
        for (const name of Object.keys(deps)) {
          const scoped = name.startsWith('@') && name.includes('/') ? name.split('/').slice(0, 2).join('/') : name
          if (!present.has(scoped)) {
            if (!missing.has(name)) missing.set(name, new Set())
            missing.get(name).add(pj.name)
          }
        }
      }
    }
  }
  walk(modules)
  const hard = [...missing.entries()].filter(([name]) => name.startsWith('@deepseek-ai/'))
  if (hard.length) {
    const lines = hard.map(([name, from]) => `  ${name} <- ${[...from].join(', ')}`).join('\n')
    throw new Error(`deployed closure is missing @deepseek-ai packages — add them to desktop-runtime/package.json:\n${lines}`)
  }
  for (const [name, from] of missing) console.warn(`  ! missing optional/registry dep ${name} (${[...from].join(', ')}) — ignored`)
}

// ── 2. assemble the runtime dir ──────────────────────────────────────────
console.log('[2/3] Assembling runtime dir')
rmSync(RUNTIME_OUT, { recursive: true, force: true })
mkdirSync(RUNTIME_OUT, { recursive: true })
if (!existsSync(NODE_EXE)) throw new Error(`node.exe not found at ${NODE_EXE}`)
cpSync(NODE_EXE, join(RUNTIME_OUT, 'node.exe'))
// cpSync of 200MB+ of node_modules through the JS fallback is slow; robocopy
// threads it. Robocopy exit codes 0-7 are all success (1 = files copied).
const rc = spawnSync('robocopy', [RUNTIME_DIR, RUNTIME_OUT, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS'],
  { stdio: 'inherit' })
if (rc.status === null || rc.status > 7) throw new Error(`robocopy failed with exit code ${rc.status}`)

// makensis enforces the Win32 MAX_PATH limit: pi-ai's nested copy of
// @mistralai/mistralai (esm/models/operations/<operation>.d.ts) blows past
// 260 chars and aborts the installer with "failed opening file". mistralai is
// a lazy/optional dep of pi-ai (checkClosure above only flags @deepseek-ai/*
// as hard requirements), so drop it before the bundler sees it.
const piAiNested = join(RUNTIME_OUT, 'node_modules', '@earendil-works', 'pi-ai', 'node_modules')
const piMistral = join(piAiNested, '@mistralai')
if (existsSync(piMistral)) {
  rmSync(piMistral, { recursive: true, force: true })
  console.log(`  pruned ${piMistral} (NSIS MAX_PATH)`)
}

// ── 3. report ────────────────────────────────────────────────────────────
console.log(`[3/3] Done: ${RUNTIME_OUT} (node_modules deployed, node.exe embedded)`)
