// Shared closure machinery for the dsh runtime manifest.
//
// build-sidecar.mjs runs the completeness gate against the materialized
// closure; scripts/complete-closure.mjs (run by the auto-update workflow)
// auto-declares whatever that gate would flag. The scan, the
// deliberately-unpublished list and the Windows pnpm resolution are shared so
// the two never drift apart.

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
export const KNOWN_UNPUBLISHED = new Set([
  '@deepseek-ai/dsh-bash',
  '@deepseek-ai/dsh-user-id',
  '@deepseek-ai/dsh-retention',
  '@deepseek-ai/dsh-environment',
])

// Scan a hoisted node_modules closure: every installed package's
// dependencies/peerDependencies against what is present. optionalDependencies
// may legitimately be absent (platform variants) — not scanned. Returns
// [[name, [declaring packages…]], …] including non-scoped misses (the caller
// filters); no error is thrown here.
export function scanMissing(modulesDir) {
  const present = new Set()
  for (const f of readdirSync(modulesDir)) {
    if (f.startsWith('@')) {
      for (const g of readdirSync(join(modulesDir, f))) present.add(`${f}/${g}`)
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
  walk(modulesDir)
  return [...missing.entries()].map(([name, from]) => [name, [...from]])
}

// Windows: never spawn `pnpm` by bare name — under Git Bash the PATH entries
// are POSIX shell scripts that CreateProcess refuses (EINVAL), and the .cmd
// shims are equally unreliable through execFileSync. Resolve the real
// pnpm.mjs: npm -g puts it under %APPDATA%\npm on dev machines, but CI
// windows runners install next to node itself (hostedtoolcache layout).
// Returns the pnpm.mjs path on Windows, 'pnpm' elsewhere, null when missing.
export function resolvePnpmEntry() {
  if (process.platform !== 'win32') return 'pnpm'
  const candidates = [
    join(process.env.APPDATA || '', 'npm', 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
    join(dirname(process.execPath), 'node_modules', 'pnpm', 'bin', 'pnpm.mjs'),
  ]
  const found = candidates.find((p) => existsSync(p))
  if (found) return found
  const npmCli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
  if (existsSync(npmCli)) {
    try {
      const prefix = execFileSync(process.execPath, [npmCli, 'prefix', '-g'], { encoding: 'utf8' }).trim()
      const p = join(prefix, 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
      if (existsSync(p)) return p
    } catch {}
  }
  return null
}
