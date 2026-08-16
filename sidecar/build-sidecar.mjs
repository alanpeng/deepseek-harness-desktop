#!/usr/bin/env node
// Build the dsh web host runtime directory for the desktop bundle.
//
// Pipeline:
//   1. `pnpm install --prod --frozen-lockfile` materializes the runtime
//      closure from sidecar/runtime-manifest/package.json (all @deepseek-ai/*
//      deps pinned to published npm versions — the closure used to come from
//      `pnpm deploy` inside the upstream clone's packages/desktop, which is a
//      LOCAL-ONLY directory that upstream master never had) into a flat
//      hoisted node_modules tree.
//   2. Assemble `sidecar/runtime/`: the installed tree + a stock Node binary.
//      Tauri's `bundle.resources` ships this directory inside the installer
//      as `dsh-runtime`, and the app spawns `node entry.mjs` from there.
//   3. Pack `sidecar/dist/dsh-runtime-<v>-<platform>.tar.gz` (top-level
//      `runtime/`, same layout the runtime updater ships).
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
//
// Usage:
//   node sidecar/build-sidecar.mjs [--platform windows-x86_64]
//                                  [--node-from-exec]
//   --platform        windows-x86_64 (default) | macos-x86_64 |
//                     macos-aarch64 | linux-x86_64
//   --node-from-exec  copy process.execPath as the bundled node binary
//                     (CI: run after setup-node so the version is correct
//                     and no download is needed). Without it, Windows uses
//                     the well-known install path and other platforms fall
//                     back to execPath too.

import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url)) // dsh-desktop/
const args = parseArgs(process.argv.slice(2))
const PLATFORM = args.platform || 'windows-x86_64'
const MANIFEST = join(ROOT, 'sidecar', 'runtime-manifest') // package.json + entry.mjs
const STAGING = join(ROOT, 'sidecar', 'staging')
const RUNTIME_DIR = join(STAGING, 'dsh-desktop-runtime') // install target, then copied to RUNTIME_OUT
const RUNTIME_OUT = join(ROOT, 'sidecar', 'runtime') // what the installer ships as dsh-runtime
const DIST = join(ROOT, 'sidecar', 'dist')

// Per-platform facts: bundled node binary name, whether the NSIS MAX_PATH
// trim applies (only Windows installers hit makensis' path limit).
const PLATFORMS = {
  'windows-x86_64': { node: 'node.exe', trimDeepPaths: true },
  'macos-x86_64': { node: 'node', trimDeepPaths: false },
  'macos-aarch64': { node: 'node', trimDeepPaths: false },
  'linux-x86_64': { node: 'node', trimDeepPaths: false },
}
if (!PLATFORMS[PLATFORM]) fail(`未知平台 ${PLATFORM}（可用: ${Object.keys(PLATFORMS).join(', ')}）`)

// Archive tool: libarchive bsdtar ships as tar.exe with Windows, `tar` on unix.
const TAR = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar'

// Windows: never spawn `pnpm` by bare name — under Git Bash the PATH
// entries are POSIX shell scripts that CreateProcess refuses (EINVAL), and
// the .cmd shims are equally unreliable through execFileSync. Invoke the real
// JS entry via the current node instead. On unix, pnpm is a plain executable
// on PATH (corepack / pnpm install) and execFileSync handles it directly.
const NODE = process.execPath
const PNPM_ENTRY = process.platform === 'win32' ? findPnpmEntry() : 'pnpm'

// Where npm -g put pnpm on Windows: user-global (%APPDATA%\npm) on dev
// machines, but CI windows runners install npm packages next to node itself
// (hostedtoolcache layout) — probe both, then ask npm as a last resort.
function findPnpmEntry() {
  const candidates = [
    join(process.env.APPDATA || '', 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
    join(dirname(process.execPath), 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
  ]
  const found = candidates.find((p) => existsSync(p))
  if (found) return found
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(npmCli)) {
    try {
      const prefix = execFileSync(NODE, [npmCli, 'prefix', '-g'], { encoding: 'utf8' }).trim()
      const p = join(prefix, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
      if (existsSync(p)) return p
    } catch {}
  }
  throw new Error('pnpm 未找到：请先 npm install -g pnpm@11（Windows 需要 pnpm.mjs 文件路径）')
}

function fail(msg) {
  console.error(`[build-sidecar] ${msg}`)
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

function run(args, opts = {}) {
  // unix: pnpm is a real executable on PATH; Windows: invoke pnpm.mjs via node.
  const cmd = process.platform === 'win32' ? NODE : PNPM_ENTRY
  const argv = process.platform === 'win32' ? [PNPM_ENTRY, ...args] : args
  console.log(`\n$ ${process.platform === 'win32' ? 'node' : 'pnpm'} ${args.join(' ')}`)
  execFileSync(cmd, argv, { stdio: 'inherit', ...opts })
}

// The bundled node binary. CI passes --node-from-exec (setup-node 24 already
// put the right binary on PATH). Locally: the well-known Windows install path
// (existing behavior) or — on unix — whatever node this script runs under.
function resolveNodeBinary() {
  const target = join(RUNTIME_OUT, PLATFORMS[PLATFORM].node)
  if (args['node-from-exec']) {
    if (!existsSync(process.execPath)) fail(`execPath not found: ${process.execPath}`)
    console.log(`  node from execPath: ${process.execPath}`)
    return process.execPath
  }
  if (PLATFORM === 'windows-x86_64') {
    const exe = 'C:\\Program Files\\nodejs\\node.exe'
    if (!existsSync(exe)) throw new Error(`node.exe not found at ${exe}`)
    return exe
  }
  // unix local build: this script IS running on node, so execPath is the
  // binary (no symlink indirection, unlike `which node`).
  return process.execPath
}

// ── 1. install the closure from the committed manifest ───────────────────
console.log(`[1/4] Installing runtime closure (platform ${PLATFORM})`)
rmSync(STAGING, { recursive: true, force: true })
mkdirSync(STAGING, { recursive: true })
cpSync(MANIFEST, RUNTIME_DIR, { recursive: true })
// pnpm install --prod: no devDeps, hoisted layout (the app resolves
// node_modules flat, same as the old pnpm deploy tree). --frozen-lockfile
// pins the resolution to the committed pnpm-lock.yaml (update it by running
// `pnpm install` in sidecar/runtime-manifest after bumping a dependency).
// auto-install-peers=false: several @deepseek-ai/* peers were never published
// to npm (e.g. @deepseek-ai/dsh-bash, a peer of dsh-bash-local) — the closure
// check below still fails the build if any actually-needed package is missing.
// confirmModulesPurge=false: the copied manifest tree may carry a stale
// node_modules (e.g. a local `pnpm install` in runtime-manifest), which pnpm
// wants to purge — but it refuses without a TTY unless told otherwise. CI
// sets CI=true and skips the prompt, so this only matters for local runs.
run(['--dir', RUNTIME_DIR, 'install', '--prod', '--node-linker=hoisted',
  '--config.auto-install-peers=false', '--config.confirmModulesPurge=false', '--frozen-lockfile'])

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
  // These @deepseek-ai packages are peers of installed plugins that were NEVER
  // published to npm (npm view → 404; upstream workspace-internal names):
  //   dsh-bash        <- dsh-bash-local            (bash backend, desktop
  //                                                  profile loads dsh-shell,
  //                                                  not dsh-bash-local)
  //   dsh-user-id     <- dsh-command-feedback / dsh-session-telemetry-otel
  //   dsh-retention   <- dsh-spill-policy
  //   dsh-environment <- dsh-web-search-deepseek
  // The 0.1.0 deploy tree (pnpm deploy + auto-install-peers=false) lacked them
  // too and shipped fine — cordis only imports peers when the profile actually
  // loads the plugin, and the desktop profile loads none of these. Accepted
  // deliberately; everything published must exist.
  const KNOWN_UNPUBLISHED = new Set([
    '@deepseek-ai/dsh-bash',
    '@deepseek-ai/dsh-user-id',
    '@deepseek-ai/dsh-retention',
    '@deepseek-ai/dsh-environment',
  ])
  const hard = [...missing.entries()].filter(([name]) => name.startsWith('@deepseek-ai/') && !KNOWN_UNPUBLISHED.has(name))
  if (hard.length) {
    const lines = hard.map(([name, from]) => `  ${name} <- ${[...from].join(', ')}`).join('\n')
    throw new Error(`deployed closure is missing @deepseek-ai packages — add them to desktop-runtime/package.json:\n${lines}`)
  }
  for (const [name, from] of missing) console.warn(`  ! missing optional/registry dep ${name} (${[...from].join(', ')}) — ignored`)
}

// ── 2. assemble the runtime dir ──────────────────────────────────────────
console.log('[2/4] Assembling runtime dir')
rmSync(RUNTIME_OUT, { recursive: true, force: true })
mkdirSync(RUNTIME_OUT, { recursive: true })
const nodeSrc = resolveNodeBinary()
const nodeTarget = join(RUNTIME_OUT, PLATFORMS[PLATFORM].node)
cpSync(nodeSrc, nodeTarget)
console.log(`  bundled ${nodeSrc} -> ${nodeTarget}`)
if (process.platform === 'win32') {
  // robocopy threads the 200MB+ node_modules copy; exit codes 0-7 are all
  // success (1 = files copied).
  const rc = spawnSync('robocopy', [RUNTIME_DIR, RUNTIME_OUT, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS'],
    { stdio: 'inherit' })
  if (rc.status === null || rc.status > 7) throw new Error(`robocopy failed with exit code ${rc.status}`)
} else {
  // unix has no robocopy — plain recursive copy. Not hosted by CI (pnpm
  // deploy + copies of this tree are genuinely cheap; robocopy exists here
  // only because Windows' single-threaded cpSync was measurably slow).
  cpSync(RUNTIME_DIR, RUNTIME_OUT, { recursive: true })
}

// makensis enforces the Win32 MAX_PATH limit: pi-ai's nested copy of
// @mistralai/mistralai (esm/models/operations/<operation>.d.ts) blows past
// 260 chars and aborts the installer with "failed opening file". mistralai is
// a lazy/optional dep of pi-ai (checkClosure above only flags @deepseek-ai/*
// as hard requirements), so drop it before the bundler sees it. Only the
// Windows NSIS path hits this — dmg/deb/AppImage tools have no 260-char limit.
if (PLATFORMS[PLATFORM].trimDeepPaths) {
  const piAiNested = join(RUNTIME_OUT, 'node_modules', '@earendil-works', 'pi-ai', 'node_modules')
  const piMistral = join(piAiNested, '@mistralai')
  if (existsSync(piMistral)) {
    rmSync(piMistral, { recursive: true, force: true })
    console.log(`  pruned ${piMistral} (NSIS MAX_PATH)`)
  }
}

// ── 3. pack the artifact ─────────────────────────────────────────────────
console.log('[3/4] Packing tarball')
const pjPath = join(RUNTIME_OUT, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
if (!existsSync(pjPath)) fail(`dsh package.json not found at ${pjPath}`)
const VERSION = JSON.parse(readFileSync(pjPath, 'utf8')).version
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(VERSION)) fail(`bad dsh version: ${VERSION}`)
const TAG = `dsh-runtime-${VERSION}-${PLATFORM}`
mkdirSync(DIST, { recursive: true })
const GZ = join(DIST, `${TAG}.tar.gz`)
rmSync(GZ, { force: true })
// Top-level dir is `runtime/` (the app resolves it via find_top_dir).
const rc = spawnSync(TAR, ['-czf', GZ, '-C', join(ROOT, 'sidecar'), 'runtime'], { stdio: 'inherit' })
if (rc.status !== 0) fail(`tar pack failed (exit ${rc.status})`)
const gzMB = Math.round(statSync(GZ).size / 1048576)

// ── 4. report ────────────────────────────────────────────────────────────
console.log(`[4/4] Done: ${RUNTIME_OUT} (dsh ${VERSION}, ${PLATFORM})`)
console.log(`      artifact: ${GZ} (${gzMB} MB)`)
