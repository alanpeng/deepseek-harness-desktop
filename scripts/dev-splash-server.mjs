// Dev-mode static server for the splash/error page (tauri.conf.json devUrl).
// In release builds the page ships as bundled assets instead (frontendDist).
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(import.meta.url), '..', '..', 'src-ui')
const port = Number(process.env.PORT || 1420)

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

createServer(async (req, res) => {
  try {
    const path = (req.url || '/').split('?')[0]
    const file = path === '/' ? '/index.html' : path
    const data = await readFile(join(root, file))
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('not found')
  }
}).listen(port, '127.0.0.1', () => {
  console.log(`[dev-splash-server] http://127.0.0.1:${port}`)
})
