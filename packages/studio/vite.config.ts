import { defineConfig, type Plugin } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import Icons from "unplugin-icons/vite";
import { fileURLToPath, URL } from "node:url";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

// The two headers that unlock SharedArrayBuffer (cross-origin isolation). Without
// them `SharedArrayBuffer` is undefined and the whole runtime cannot run. Applied
// to the dev server, the preview server, AND — via the plugin below — every
// response, including the Service Worker script (which additionally needs
// Service-Worker-Allowed so it can claim the whole origin for the preview proxy).
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// Grant the preview Service Worker (served at /sw.js) a root scope so it can
// intercept /preview/<port>/... for the whole origin.
function swScope(): Plugin {
  const mw = (req: any, res: any, next: any) => {
    for (const [k, v] of Object.entries(isolation)) res.setHeader(k, v);
    if (req.url && req.url.split("?")[0].endsWith("/sw.js"))
      res.setHeader("Service-Worker-Allowed", "/");
    next();
  };
  return {
    name: "vv-cross-origin-isolation",
    configureServer(server) {
      server.middlewares.use(mw);
    },
    configurePreviewServer(server) {
      server.middlewares.use(mw);
    },
  };
}

// Vendor the in-browser DevTools locally (no CDN → COEP-safe). We serve two
// things same-origin:
//   /vv-devtools/chobitsu.js  — the CDP backend injected into every preview page
//                               (chobitsu ships a UMD bundle exposing `chobitsu`)
//   /devtools/**              — the full chii (Chrome DevTools) frontend, i.e.
//                               chii's `public/` dir (front_end/ + friends)
// In dev/preview a middleware streams the files from node_modules; for the build
// they're copied into the output so the deployed app is fully self-contained.
const require = createRequire(import.meta.url);
const CHOBITSU_FILE = require.resolve("chobitsu"); // → dist/chobitsu.js (UMD)
const CHII_PUBLIC = path.join(path.dirname(require.resolve("chii/package.json")), "public");

const MIME: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".html": "text/html",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain",
};

function sendFile(res: any, file: string) {
  // Buffered read + explicit Content-Length (not streamed): the DevTools frontend
  // fires a burst of ~50 concurrent module imports, and chunked-transfer responses
  // over HTTP/1.1 keep-alive were leaving many of them pending forever in the
  // browser. A fixed-length body lets the browser close + reuse sockets cleanly.
  // fs.readFile also can't crash the dev server on a client abort the way an
  // unhandled read-stream 'error' could.
  fs.readFile(file, (err, data) => {
    if (err) {
      res.statusCode = err.code === "ENOENT" ? 404 : 500;
      res.end(String(err.code || "error"));
      return;
    }
    res.setHeader("Content-Type", MIME[path.extname(file).toLowerCase()] || "application/octet-stream");
    res.setHeader("Content-Length", data.length);
    res.end(data);
  });
}

function serveDevtools(): Plugin {
  let outDir = "dist";
  const handler = (req: any, res: any, next: () => void) => {
    const url = (req.url || "").split("?")[0].split("#")[0];
    if (url === "/vv-devtools/chobitsu.js") {
      sendFile(res, CHOBITSU_FILE);
      return;
    }
    if (url.startsWith("/devtools/")) {
      const rel = decodeURIComponent(url.slice("/devtools/".length));
      const abs = path.join(CHII_PUBLIC, rel);
      // Guard against path traversal escaping the vendored frontend.
      if (abs !== CHII_PUBLIC && !abs.startsWith(CHII_PUBLIC + path.sep)) {
        res.statusCode = 403;
        res.end("Forbidden");
        return;
      }
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        sendFile(res, abs);
        return;
      }
      res.statusCode = 404;
      res.end("Not found");
      return;
    }
    next();
  };
  return {
    name: "vv-serve-devtools",
    configResolved(cfg) {
      outDir = cfg.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
    closeBundle() {
      const dist = path.resolve(fileURLToPath(new URL("./", import.meta.url)), outDir);
      fs.mkdirSync(path.join(dist, "vv-devtools"), { recursive: true });
      fs.copyFileSync(CHOBITSU_FILE, path.join(dist, "vv-devtools", "chobitsu.js"));
      fs.cpSync(CHII_PUBLIC, path.join(dist, "devtools"), { recursive: true });
    },
  };
}

// For the unified Cloudflare Pages deploy the studio is served under `/studio/`
// (the landing owns `/` and the docs own `/docs/`). Set `VV_BASE=/studio/` for that
// build; local `npm run dev` keeps the default root base. The preview Service
// Worker and its runtime asset tree (/sw.js, /preview/*, /vv-devtools/*,
// /devtools/*) always stay at the origin root because the SW claims root scope.
const base = process.env.VV_BASE || "/";

// https://vite.dev/config/
export default defineConfig({
  base,
  plugins: [
    // plugin-react v6 transforms JSX with oxc; the React Compiler is a Babel
    // plugin, wired in via the exported preset + @rolldown/plugin-babel.
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    // Iconify icons compiled to inline SVG React components at build time — offline
    // (no CDN → COEP-safe) and tree-shaken. Used as `~icons/<collection>/<name>`.
    Icons({ compiler: "jsx", jsx: "react" }),
    swScope(),
    // After swScope so its header middleware (COEP/COOP) runs first and stamps
    // these responses before we stream the vendored DevTools assets.
    serveDevtools(),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Consume the SDK from source in the monorepo: Vite compiles @vivari/core's
      // TS and follows its nested `new Worker(new URL(...))` + `new URL(*.wasm)`
      // references into packages/core/src/workers and the sibling crate pkg dirs —
      // exactly how Studio bundled these before they moved into the core package.
      "@vivari/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
    },
  },
  server: {
    headers: isolation,
    // The kernel worker (in src/workers/) and its nested workers import from
    // sibling packages (packages/kernel-host, packages/runtime, packages/vfs|codec|
    // crypto/pkg). Let Vite's dev server read + bundle them from the monorepo root.
    fs: { allow: [fileURLToPath(new URL("../../", import.meta.url))] },
  },
  preview: { headers: isolation },
  worker: { format: "es" },
});
