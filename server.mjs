// Minimal static dev server whose ONLY interesting job is to send the two
// headers that unlock SharedArrayBuffer (i.e. cross-origin isolation):
//
//   Cross-Origin-Opener-Policy:   same-origin
//   Cross-Origin-Embedder-Policy: require-corp
//
// Without these, `SharedArrayBuffer` is undefined and the whole PoC cannot run.
//
//   node server.mjs   ->   http://localhost:8080/packages/demo/index.html

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".map": "application/json; charset=utf-8",
};

const server = createServer(async (req, res) => {
  // These headers are the reason this file exists.
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");

  let urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (urlPath === "/") urlPath = "/packages/demo/index.html";

  const filePath = normalize(join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  const ext = extname(filePath);

  // [optimize] .wasm is the one asset re-fetched a lot (the kernel now compiles
  // each codec once, but page reloads still refetch). Let the browser cache it
  // and revalidate cheaply: no-cache + Last-Modified, answering 304 when the
  // file is unchanged. This stays correct across `wasm-pack` rebuilds (mtime
  // bumps → fresh download) unlike a blind max-age. Everything else is no-store
  // so edited JS/HTML always reloads in dev.
  if (ext === ".wasm") {
    try {
      const st = await stat(filePath);
      const lastModified = st.mtime.toUTCString();
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Last-Modified", lastModified);
      if (req.headers["if-modified-since"] === lastModified) {
        res.writeHead(304).end();
        return;
      }
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
  } else {
    res.setHeader("Cache-Control", "no-store");
  }

  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
});

server.listen(PORT, () => {
  console.log(`OpenContainer dev server → http://localhost:${PORT}/`);
  console.log(`Open →  http://localhost:${PORT}/packages/demo/index.html`);
});
