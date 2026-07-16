import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

// Ship the preview Service Worker with the package. Its canonical copy lives in
// the studio app (served there from `public/sw.js`); we vendor it into the SDK's
// `dist/assets/sw.js` at build time so a consumer can host it same-origin at
// `/sw.js` (see `Vivari.boot({ serviceWorkerUrl })`). One source of truth, shipped
// with the library.
function bundleServiceWorker(): Plugin {
  const src = fileURLToPath(new URL("../studio/public/sw.js", import.meta.url));
  return {
    name: "vivari-bundle-sw",
    closeBundle() {
      const outDir = fileURLToPath(new URL("./dist/assets", import.meta.url));
      fs.mkdirSync(outDir, { recursive: true });
      fs.copyFileSync(src, path.join(outDir, "sw.js"));
    },
  };
}

// Library build for @vivari/core.
//
// The public entry (`src/index.ts`) only pulls in framework-agnostic TS. The
// heavy machinery — the kernel worker and its nested fs/fetcher/process workers,
// plus the Rust/Wasm VFS + codec + crypto artifacts — is reached exclusively
// through `new Worker(new URL('./workers/*.js', import.meta.url))` and
// `new URL('../../<crate>/pkg/*_bg.wasm', import.meta.url)`. Vite follows those
// recursively, bundling each worker as its own chunk and emitting the wasm as
// hashed assets under `dist/assets/`, with every URL rewritten to sit beside the
// installed package. That makes the published `dist/` fully self-contained: a
// consumer's bundler resolves the workers/wasm relative to node_modules, no
// separate asset-hosting step required.
export default defineConfig({
  plugins: [bundleServiceWorker()],
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      output: {
        // Keep worker/wasm asset names stable-ish and grouped for readability.
        assetFileNames: "assets/[name]-[hash][extname]",
        chunkFileNames: "assets/[name]-[hash].js",
      },
    },
  },
  worker: { format: "es" },
});
