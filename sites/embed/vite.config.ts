import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import fs from "node:fs";
import path from "node:path";

// The two headers that unlock SharedArrayBuffer (cross-origin isolation). Without
// them `SharedArrayBuffer` is undefined and the Vivari runtime cannot boot.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// The preview Service Worker is a single source of truth in the studio package.
// The React example needs it (previews are proxied through /preview/<port>/); the
// Node example boots with serviceWorkerUrl:false and doesn't. In the unified
// Cloudflare deploy the root /sw.js is provided by the studio (hoisted by
// scripts/assemble-site.mjs); this plugin only serves/copies it so the embed app
// also works when run standalone (dev + `vite preview`).
const SW_SRC = fileURLToPath(
  new URL("../../packages/studio/public/sw.js", import.meta.url),
);

function crossOriginIsolation(): Plugin {
  const mw = (req: any, res: any, next: () => void) => {
    for (const [k, v] of Object.entries(isolation)) res.setHeader(k, v);
    const url = (req.url || "").split("?")[0];
    if (url.endsWith("/sw.js")) {
      res.setHeader("Service-Worker-Allowed", "/");
      if (url === "/sw.js" && fs.existsSync(SW_SRC)) {
        res.setHeader("Content-Type", "text/javascript");
        res.end(fs.readFileSync(SW_SRC));
        return;
      }
    }
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
    closeBundle() {
      // Emit /sw.js next to the standalone build so `vite preview` can register it.
      const dist = path.resolve(
        fileURLToPath(new URL("./", import.meta.url)),
        "dist",
      );
      if (fs.existsSync(SW_SRC)) {
        fs.mkdirSync(dist, { recursive: true });
        fs.copyFileSync(SW_SRC, path.join(dist, "sw.js"));
      }
    },
  };
}

// Served under /embed/ in the unified deploy (VV_BASE=/embed/); default root base
// for standalone dev. The runtime asset tree (/sw.js, /preview/*) always lives at
// the origin root because the Service Worker claims root scope.
const base = process.env.VV_BASE || "/";

export default defineConfig({
  base,
  plugins: [react(), crossOriginIsolation()],
  resolve: {
    // @vivari/react is aliased to its monorepo source below, so its bare react
    // and react-dom imports resolve from packages/react (the hoisted root copy)
    // while this app's own imports resolve from sites/embed. Two React copies in
    // one bundle cause an invalid hook call (the dispatcher is null, so useState
    // throws). Dedupe collapses every react specifier to a single copy.
    dedupe: ["react", "react-dom", "react/jsx-runtime"],
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Consume the SDK from source in the monorepo, exactly like the studio does:
      // Vite compiles the TS and follows @vivari/core's nested `new Worker(new
      // URL(...))` + `new URL(*.wasm)` references into the sibling crate packages.
      "@vivari/core": fileURLToPath(
        new URL("../../packages/core/src/index.ts", import.meta.url),
      ),
      "@vivari/react": fileURLToPath(
        new URL("../../packages/react/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    headers: isolation,
    // The kernel worker and its nested workers import from sibling packages
    // (kernel-host, runtime, vfs|codec|crypto/pkg). Let Vite read the repo root.
    fs: { allow: [fileURLToPath(new URL("../../", import.meta.url))] },
  },
  preview: { headers: isolation },
  worker: { format: "es" },
});
