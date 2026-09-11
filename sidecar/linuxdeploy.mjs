// linuxdeploy accommodations for the bundled runtime tree.
//
// Tauri's AppImage bundler hands the whole AppDir to linuxdeploy, which walks
// every ELF it finds, runs `ldd` on each, and aborts the entire bundle when ldd
// exits non-zero — reporting only `Failed to run ldd: exited with code 1`, with
// no file name and no hint that a *bundled payload* file (not the shell) is to
// blame. The deb target is bundled first and succeeds, so the failure looks
// like an AppImage-only problem.
//
// Two things in a multi-platform npm closure trip it, both dead weight in the
// bundle — the file that gets loaded is chosen at runtime from the host's own
// properties, and the bundled node is always the CI runner's glibc build:
//
//   * musl variants (`@deepseek-ai/node-addon-system-linux-x64/bin/musl/`,
//     koffi's `musl_x64/`, sharp's `*-linuxmusl-*` packages). The host's libc
//     decides: `process.report.getReport().header.glibcVersionRuntime`, see
//     @deepseek-ai/node-addon-system/lib/flock.js.
//   * other architectures (node-pty ships `prebuilds/linux-arm64/pty.node`
//     next to the x86_64 one). The host's arch decides.
//
// Neither has an interpreter the runner can resolve, so ldd cannot read them.

import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]) // \x7fELF
const ET_DYN = 3 // shared object / PIE — what linuxdeploy runs ldd on
const EM_X86_64 = 62
const EM_AARCH64 = 183

// Target architectures this build knows how to prune for (the `--platform`
// suffix). Every supported target is little-endian.
const TARGET_MACHINE = { x86_64: EM_X86_64, aarch64: EM_AARCH64 }

/** `{ type, machine }` of `file`, or null when it is not a readable ELF. */
function elfInfo(file) {
  let fd
  try {
    fd = openSync(file, 'r')
  } catch {
    return null
  }
  try {
    const head = Buffer.alloc(20)
    if (readSync(fd, head, 0, 20, 0) < 20) return null
    if (!head.subarray(0, 4).equals(ELF_MAGIC)) return null
    if (head[5] !== 1) return null // not little-endian
    return { type: head.readUInt16LE(16), machine: head.readUInt16LE(18) }
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

function containsElf(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory() ? containsElf(p) : elfInfo(p) !== null) return true
  }
  return false
}

// Drop binaries from the runtime tree that the target platform can never load.
// Returns [{ path, why }] for logging.
//
// musl variants are keyed on the directory name rather than on file contents,
// deliberately: `bin/landlock-run` is a static-musl ET_EXEC that Linux users
// genuinely run (it is the Landlock sandbox launcher) and pruning by "looks
// static" would delete it. Only builds parked in a musl-named directory are
// variants, and a directory is only pruned when it actually holds an ELF — a JS
// module that merely has "musl" in its name survives.
//
// The musl list is structure-based, not package-based, because the
// package-based version rotted: it knew only koffi's `musl_x64/`, and dsh
// 0.1.5-rc.2 added `@deepseek-ai/node-addon-system-linux-x64/bin/musl/` next to
// it (2026-09-11, linux job dead inside linuxdeploy).
//
// Foreign architectures need no naming convention at all — e_machine says it.
// Mach-O and PE payloads (darwin/win32 prebuilds) are not ELF, so neither this
// nor linuxdeploy touches them.
export function pruneForeignBuilds(root, { arch, dryRun = false } = {}) {
  const want = TARGET_MACHINE[arch]
  if (!want) throw new Error(`未知目标架构 ${arch}（可用: ${Object.keys(TARGET_MACHINE).join(', ')}）`)

  const pruned = []
  const drop = (path, why) => {
    if (!dryRun) rmSync(path, { recursive: true, force: true })
    pruned.push({ path, why })
  }
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (/musl/i.test(entry.name) && containsElf(p)) {
          drop(p, 'musl build')
          continue // gone — nothing left to descend into
        }
        walk(p)
      } else if (entry.isFile()) {
        const elf = elfInfo(p)
        if (elf !== null && elf.machine !== want) drop(p, `foreign arch (e_machine ${elf.machine})`)
      }
    }
  }
  walk(root)
  return pruned
}

// ELF files linuxdeploy's ldd pass cannot resolve, i.e. the ones the AppImage
// bundle would abort on. Same criterion as linuxdeploy (non-zero ldd exit), so
// this cannot disagree with it: it just names the file first. Only ET_DYN is
// checked — linuxdeploy acts on ELFs carrying a PT_DYNAMIC, and the static
// ET_EXEC launchers (`bin/landlock-run`) are skipped by it.
//
// Returns [{ file, why }]; throws when ldd itself is missing (Linux only —
// callers must not run this elsewhere).
export function findUnresolvableElf(root) {
  const bad = []
  for (const file of walkFiles(root)) {
    if (elfInfo(file)?.type !== ET_DYN) continue
    const r = spawnSync('ldd', [file], { encoding: 'utf8' })
    if (r.error) throw new Error(`ldd 不可用: ${r.error.message}`)
    if (r.status !== 0) {
      const first = `${r.stderr || r.stdout || ''}`.trim().split('\n')[0]
      bad.push({ file, why: first || `ldd exit ${r.status}` })
    }
  }
  return bad
}

function* walkFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) yield* walkFiles(p)
    else if (entry.isFile()) yield p
  }
}
