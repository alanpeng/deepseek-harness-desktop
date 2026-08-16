// Desktop sidecar entry — dsh ships as real node + node_modules, not a
// single packaged exe (see build-sidecar.mjs header for why). The host spawns
// `node entry.mjs` from the bundled dsh-runtime directory; everything dsh
// needs resolves from @deepseek-ai/dsh on the deployed tree.
import '@deepseek-ai/dsh/lib/bin.js'
