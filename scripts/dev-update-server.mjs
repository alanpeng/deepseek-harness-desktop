#!/usr/bin/env node
// Local update test server for the Phase 6 verification.
//
//   node scripts/dev-update-server.mjs [--root <dir>] [--port 8765]
//        [--manifest <path>] [--registry <path>] [--runtime-version <v>]
//
// - Static files are served from --root (default: sidecar/dist).
// - GET /latest.json: returns --manifest if given, else <root>/latest.json.
// - GET /registry.json: returns --registry if given, else a fake npm
//   packument for --runtime-version (or the highest dsh-runtime-*.tar.gz
//   version found in --root).
// Point the app at it with:
//   DSH_RUNTIME_REGISTRY_URL=http://127.0.0.1:8765/registry.json
//   DSH_RUNTIME_ARTIFACT_BASE_URL=http://127.0.0.1:8765
// (shell endpoint override is baked in at build time via --config).

import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'

const args = parseArgs(process.argv.slice(2))
const PORT = Number(args.port || 8765)
const ROOT = resolve(args.root || join(process.cwd(), 'sidecar', 'dist'))
const MANIFEST = args.manifest ? resolve(args.manifest) : null
const REGISTRY = args.registry ? resolve(args.registry) : null

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

function fakeRegistry() {
  // Highest dsh-runtime-<v>.tar.gz in root, or the explicit override.
  let v = args['runtime-version']
  if (!v && existsSync(ROOT)) {
    for (const f of readdirSync(ROOT)) {
      const m = f.match(/^dsh-runtime-([\d.]+(?:-[0-9A-Za-z.-]+)?)\.tar\.gz$/)
      if (m && (!v || m[1].localeCompare(v, undefined, { numeric: true }) > 0)) v = m[1]
    }
  }
  if (!v) return { 'dist-tags': {}, versions: {} }
  return { 'dist-tags': { latest: v, next: v }, versions: { [v]: {} } }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const path = decodeURIComponent(url.pathname)

  if (path === '/latest.json') {
    const file = MANIFEST || join(ROOT, 'latest.json')
    return serve(file, res, 'application/json')
  }
  if (path === '/registry.json') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify(REGISTRY ? JSON.parse(readFileSync(REGISTRY, 'utf8')) : fakeRegistry()))
  }

  const file = join(ROOT, path.replace(/^\/+/, ''))
  if (!file.startsWith(ROOT) || !existsSync(file)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    return res.end(`404: ${path} (root ${ROOT})`)
  }
  const type = path.endsWith('.json') ? 'application/json'
    : path.endsWith('.sha256') ? 'text/plain'
    : path.endsWith('.minisig') ? 'text/plain'
    : 'application/octet-stream'
  serve(file, res, type)
})

function serve(file, res, type) {
  let size
  try {
    size = statSync(file).size
  } catch {
    // Missing file must 404, not crash the server (uncaught throw in a
    // request handler takes the whole process down).
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    return res.end(`404: ${file}`)
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': size,
  })
  createReadStream(file).pipe(res)
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`dev-update-server on http://127.0.0.1:${PORT}`)
  console.log(`  root:     ${ROOT}`)
  console.log(`  manifest: ${MANIFEST || join(ROOT, 'latest.json')}`)
  console.log(`  registry: ${REGISTRY || '<generated from root>'}`)
  if (!MANIFEST && existsSync(join(ROOT, 'latest.json'))) {
    const m = JSON.parse(readFileSync(join(ROOT, 'latest.json'), 'utf8'))
    console.log(`  latest.json version: ${m.version}`)
  }
})
