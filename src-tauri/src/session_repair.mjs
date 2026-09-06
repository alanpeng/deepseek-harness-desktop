#!/usr/bin/env node
// Session-root encoding repair for the dsh-desktop shell (embedded via
// include_str! in session_repair.rs; run with the runtime's own node before
// the host spawns). dsh 0.1.0+ web profiles run the JSONL session backend in
// zstd mode, and checkRootEncoding kills the host at boot whenever a session
// directory holds a plaintext session.jsonl next to (or instead of)
// session.jsonl.zstd — upstream ships no compression migration, so the shell
// heals the root up front. Lossless by construction:
//
//   * session.jsonl whose whole content is ONE line equal to the first line
//     of the sibling .zstd's first frame (a v0-era header stub; the frame
//     already carries that header) -> delete the stub. The .zstd keeps the
//     session.
//   * session.jsonl with no .zstd sibling, whose first line is a session
//     header -> recompress the whole file as a single zstd frame, verify a
//     round trip, then delete the plaintext.
//
// Everything else is reported with action "kept" and left untouched. Output
// is one JSON object per file on stdout (the shell logs it); exit code 0 even
// when items were kept — only a fatal scan error exits 1.
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const zlib = await import("node:zlib");
const HAS_ZSTD = typeof zlib.zstdCompressSync === "function";
const report = (o) => console.log(JSON.stringify({ ts: Date.now(), ...o }));

async function decodeFirstFrame(buf) {
  // createZstdDecompress ends at the first frame boundary, which is exactly
  // the first append batch (the header) of a zstd log.
  return new Promise((resolve, reject) => {
    const dec = zlib.createZstdDecompress();
    const chunks = [];
    dec.on("data", (c) => chunks.push(c));
    dec.on("end", () => resolve(Buffer.concat(chunks)));
    dec.on("error", reject);
    dec.end(buf);
  });
}

function sessionHeaderOk(firstLine, dirName) {
  try {
    const o = JSON.parse(firstLine);
    return o && o.type === "session" && typeof o.id === "string" && o.id === dirName;
  } catch {
    return false;
  }
}

async function walk(root) {
  const files = [];
  const entries = (await readdir(root, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
  for (const e of entries) {
    const p = join(root, e.name);
    if (e.isDirectory()) files.push(...(await walk(p)));
    else if (e.name.endsWith(".jsonl")) files.push(p); // .jsonl.zstd doesn't match
  }
  return files;
}

const root = process.argv[2];
let scanned = 0;
if (!root) {
  console.error("usage: session_repair.mjs <sessions-root>");
  process.exit(1);
}
try {
  for (const plain of await walk(root)) {
    scanned++;
    if (basename(plain) !== "session.jsonl") {
      report({ action: "kept", file: plain, reason: "nonstandard-name" });
      continue;
    }
    const dir = dirname(plain);
    const zstd = join(dir, "session.jsonl.zstd");
    let stub;
    try {
      stub = await readFile(plain);
    } catch {
      continue; // vanished mid-scan
    }
    const stubLines = stub.toString("utf8").split(/\r?\n/).filter((l) => l.length > 0);
    const dirName = basename(dir);

    if (HAS_ZSTD) {
      try {
        const compressed = await readFile(zstd);
        const frame0 = (await decodeFirstFrame(compressed)).toString("utf8");
        const frame0First = frame0.split("\n")[0].trimEnd();
        if (stubLines.length === 1 && stubLines[0] === frame0First && sessionHeaderOk(stubLines[0], dirName)) {
          // The stub is exactly the header the .zstd already begins with.
          await rm(plain);
          report({ action: "removed", file: plain, reason: "redundant-frame0-stub" });
          continue;
        }
        report({
          action: "kept",
          file: plain,
          reason:
            stubLines.length !== 1
              ? "stub-carries-events"
              : !sessionHeaderOk(stubLines[0], dirName)
                ? "not-session-header"
                : "frame0-mismatch",
        });
        continue;
      } catch (err) {
        if (err && err.code === "ENOENT") {
          // No sibling: the plaintext is the whole log (0.0.x-era) — transcode.
          if (stubLines.length > 0 && sessionHeaderOk(stubLines[0], dirName)) {
            try {
              const frame = zlib.zstdCompressSync(stub);
              await writeFile(zstd, frame);
              const back = (await decodeFirstFrame(frame)).toString("utf8");
              if (back !== stub.toString("utf8")) throw new Error("roundtrip mismatch");
              await rm(plain);
              report({ action: "transcoded", file: plain, bytes: frame.length });
            } catch (err2) {
              report({ action: "kept", file: plain, reason: "transcode-failed", error: String(err2) });
            }
          } else {
            report({ action: "kept", file: plain, reason: "not-session-header" });
          }
          continue;
        }
        report({ action: "kept", file: plain, reason: "read-error", error: String(err) });
        continue;
      }
    }
    // Node without zstd support: cannot verify anything — leave the root as-is.
    report({ action: "kept", file: plain, reason: "node-zstd-unavailable" });
  }
  console.log(JSON.stringify({ ts: Date.now(), action: "summary", scanned }));
} catch (err) {
  console.error(String(err));
  process.exit(1);
}
