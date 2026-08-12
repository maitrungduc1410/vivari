import { defineConfig, type Plugin } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import Icons from "unplugin-icons/vite";
import { fileURLToPath, URL } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
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

// Two build-time facts the runtime cannot work out for itself, both derived from
// the emitted (content-hashed) filenames:
//
//   1. `public/sw.js` needs the real names of the role bundles to precache them.
//      It shipped a list of unhashed names (`kernel-worker.js`) that no Vite
//      build has ever emitted — see the long note at the top of that file.
//   2. `index.html` has exactly ONE `<script type="module">` and nothing else, so
//      the preload scanner sees nothing past the entry chunk. The kernel worker
//      is discovered only after ~1.7 MB of JS has downloaded AND executed, and
//      the codec/crypto Wasm only after the worker's own module graph resolves:
//      a five-round-trip chain, all of it serial, all of it on the critical path.
//
// One plugin because they consume the same thing — the bundle's filenames — and
// splitting them meant two passes over `generateBundle` that could disagree.
const CRITICAL = {
  // Matched against the emitted file name (rolldown derives the prefix from the
  // source module, so these survive a hash change but not a rename).
  kernelWorker: /^assets\/kernel-worker-[^/]+\.js$/,
  wasm: /^assets\/vivari_(codec|crypto|vfs)_bg-[^/]+\.wasm$/,
};
// Precached on install: the four role bundles, plus the Wasm the kernel compiles
// before it can come online. process-worker is the expensive one — without a
// precache it is re-fetched on EVERY process spawn.
const PRECACHE_PATTERNS = [
  /^assets\/(kernel|process|fs|fetcher)-worker-[^/]+\.js$/,
  CRITICAL.wasm,
];

const MANIFEST_DECL = "const __VV_PRECACHE__ = ";

function vvPrecacheAndHints(): Plugin {
  let outDir = "dist";
  let basePath = "/";
  let manifest: { id: string; assets: string[]; prefixes: string[]; shell: string } | null = null;
  let hints: string[] = [];
  return {
    name: "vv-precache-and-hints",
    apply: "build",
    configResolved(cfg) {
      outDir = cfg.build.outDir;
      basePath = cfg.base;
    },
    generateBundle(_opts, bundle) {
      const names = Object.keys(bundle).sort();
      const pick = (re: RegExp) => names.filter((n) => re.test(n));
      const assets = PRECACHE_PATTERNS.flatMap(pick);
      // A build id derived from the output, not from the clock: rebuilding
      // unchanged sources must not invalidate every user's cache, and two
      // deploys of the same commit must agree. The names already carry content
      // hashes, so hashing the name list is hashing the content.
      const id = createHash("sha256").update(names.join("\n")).digest("hex").slice(0, 16);
      manifest = {
        id,
        assets: assets.map((a) => basePath + a),
        // ONLY content-hashed output. The SW is hoisted to the origin root by
        // scripts/assemble-site.mjs, so a prefix derived from `self.location`
        // there would swallow the landing, the docs and the blog — hence an
        // explicit list — but the narrowness matters for a second reason:
        // cache-first is only safe for a URL that changes when its bytes do.
        //
        // `vendor/` is deliberately NOT here. Vite copies `public/` outside the
        // rollup bundle, so no vendor file is in `bundle` and none of them
        // contribute to the id above; their URLs are stable and unhashed, and
        // the locks and snapshots under them are re-resolved on every CI
        // checkout. Serving them cache-first under an id that cannot see them
        // pins a returning visitor to the previous deploy's vendor tree with no
        // invalidation path at all — and mixes trees, since a client can hold a
        // cached depcache/index.json from deploy N while fetching deploy N+1's
        // snapshot. They revalidate over HTTP instead, which is why
        // assemble-site.mjs keeps `immutable` off `vendor/`.
        prefixes: [basePath + "assets/"],
        shell: basePath + "index.html",
      };
      // Fail loudly rather than emit a manifest that caches nothing. This is the
      // exact failure the dead `__VV_BUILD_ID__` gate hid for the whole life of
      // the Vite build: a precache whose every entry 404s looks identical to a
      // healthy one, because precache() is per-URL best-effort by design.
      for (const [label, re] of [["kernel worker", CRITICAL.kernelWorker], ["runtime wasm", CRITICAL.wasm]] as const) {
        if (!pick(re).length) this.error(`vv-precache: no emitted ${label} matched ${re} — the precache manifest would be a no-op`);
      }
      // Only `dns-prefetch` ships. The obvious hints here — `modulepreload` for
      // the kernel worker, `preload as=fetch` for the Wasm — were measured and
      // removed: the kernel worker and the Wasm are fetched *from inside a
      // Worker*, and neither the document's preload cache (destination mismatch)
      // nor the HTTP cache (the hint's `crossorigin` makes it a separate cache
      // key from the worker's credentialed fetch) served the second request.
      // scripts/measure-studio-boot.mjs --json showed every hinted URL fetched
      // twice over the network, 2.2 MiB uncompressed of pure waste per cold
      // load, and that held even with the immutable headers below in place.
      // Do not re-add these without a --json run proving the second fetch is
      // `cached: true`.
      hints = [
        // Not `preconnect`: the registry is not touched until a user creates a
        // project, which can be minutes away, and Chrome drops an unused
        // preconnect after ~10s (and warns). The controller opens the real
        // connection when a create is committed; this just pre-resolves DNS,
        // which costs nothing and has no such timeout.
        `<link rel="dns-prefetch" href="https://registry.npmjs.org">`,
      ];
    },
    transformIndexHtml: {
      order: "post",
      handler: (html) => (hints.length ? html.replace("</head>", hints.join("\n    ") + "\n  </head>") : html),
    },
    closeBundle() {
      if (!manifest) return;
      // Rewritten on disk rather than through `define`: Vite copies `public/`
      // verbatim and never transforms it, which is the original reason the
      // build id never arrived.
      const swFile = path.resolve(fileURLToPath(new URL("./", import.meta.url)), outDir, "sw.js");
      const src = fs.readFileSync(swFile, "utf8");
      // Strip any manifest already at the top before prepending. `emptyOutDir`
      // defaults true so this is normally a fresh copy of public/sw.js, but a
      // build into a kept outDir would otherwise declare the const twice — a
      // syntax error, and one that surfaces only as a failed SW install.
      const body = src.startsWith(MANIFEST_DECL) ? src.slice(src.indexOf("\n") + 1) : src;
      fs.writeFileSync(swFile, `${MANIFEST_DECL}${JSON.stringify(manifest)};\n${body}`);
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
    vvPrecacheAndHints(),
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