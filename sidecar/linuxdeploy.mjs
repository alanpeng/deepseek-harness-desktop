// linuxdeploy accommodations for the bundled runtime tree.
//
// Tauri's AppImage bundler hands the whole AppDir to linuxdeploy, which walks
// every ELF it finds, runs `ldd` on each, and aborts the entire bundle when ldd
// exits non-zero — reporting only `Failed to run ldd: exited with code 1`, with
// no file name and no hint that a *bundled payload* file (not the shell) is to
// blame. The deb target is bundled first and succeeds, so the failure looks
// like an AppImage-only problem.
//
// musl-only native builds are what trip it: their interpreter does not exist on
// the runner, so ldd cannot resolve them. They are also dead weight here — the
// node binary shipped beside them is the runner's own glibc build, which cannot
// start on a musl host at all, so nothing in this tree can ever load them. The
// pick is made at runtime from the host's own report
// (`process.report.getReport().header.glibcVersionRuntime`, see
// @deepseek-ai/node-addon-system/lib/flock.js), and a glibc host never takes
// the musl branch.

import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]) // \x7fELF
const ET_DYN = 3 // shared object / PIE — every supported target is little-endian

/** e_type of `file`, or null when it is not an ELF we can read. */
function elfType(file) {
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
    if (head[5] !== 1) return null // not little-endian (x86_64/aarch64 both are)
    return head.readUInt16LE(16)
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

function* walkFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) yield* walkFiles(p)
    else if (entry.isFile()) yield p
  }
}

function containsElf(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory() ? containsElf(p) : elfType(p) !== null) return true
  }
  return false
}

// Drop musl-only native builds from the runtime tree. Returns the removed paths.
//
// Keyed on the directory name rather than on file contents, deliberately:
// `bin/landlock-run` is a static-musl ET_EXEC that Linux users genuinely run
// (it is the Landlock sandbox launcher) and pruning by "looks static" would
// delete it. Only builds parked in a musl-named directory are variants, and a
// directory is only pruned when it actually holds an ELF — a JS module that
// merely has "musl" in its name survives.
//
// The list is structure-based, not package-based, because the package-based
// version rotted: it knew only koffi's `musl_x64/`, and dsh 0.1.5-rc.2 added
// `@deepseek-ai/node-addon-system-linux-x64/bin/musl/system.node` next to it
// (2026-09-11, linux job dead inside linuxdeploy). koffi's `musl_x64/`,
// this `bin/musl/`, and any future `*-musl` package all land here.
export function pruneMuslBuilds(root, { dryRun = false } = {}) {
  const pruned = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const p = join(dir, entry.name)
      if (/musl/i.test(entry.name) && containsElf(p)) {
        if (!dryRun) rmSync(p, { recursive: true, force: true })
        pruned.push(p)
        continue // gone — nothing left to descend into
      }
      walk(p)
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
    if (elfType(file) !== ET_DYN) continue
    const r = spawnSync('ldd', [file], { encoding: 'utf8' })
    if (r.error) throw new Error(`ldd 不可用: ${r.error.message}`)
    if (r.status !== 0) {
      const first = `${r.stderr || r.stdout || ''}`.trim().split('\n')[0]
      bad.push({ file, why: first || `ldd exit ${r.status}` })
    }
  }
  return bad
}
