import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

// Vivari needs a cross-origin isolated page: SharedArrayBuffer (and therefore the
// whole runtime) is only available when the document is served with these two
// headers. Applied to the dev server AND the preview server.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// Serve the SDK's preview Service Worker at the origin root (`/sw.js`) with a
// root scope so it can intercept `/preview/<port>/…` for the whole origin.
//
// A real app copies `node_modules/@vivari/core/dist/assets/sw.js` into its own
// `public/` (or points `serviceWorkerUrl` at wherever it hosts it). Here — in the
// monorepo, consuming @vivari/core from source — we resolve it straight from the
// package: the built `dist/assets/sw.js` if present, else its canonical source.
function serveVivariServiceWorker(): Plugin {
  const candidates = [
    new URL("../../packages/core/dist/assets/sw.js", import.meta.url),
    new URL("../../packages/studio/public/sw.js", import.meta.url),
  ].map(fileURLToPath);
  const swPath = candidates.find((p) => fs.existsSync(p)) ?? candidates[candidates.length - 1];

  const middleware = (req: any, res: any, next: () => void) => {
    for (const [k, v] of Object.entries(isolation)) res.setHeader(k, v);
    const url = (req.url || "").split("?")[0];
    if (url === "/sw.js") {
      res.setHeader("Content-Type", "text/javascript");
      res.setHeader("Service-Worker-Allowed", "/");
      res.end(fs.readFileSync(swPath));
      return;
    }
    next();
  };

  return {
    name: "vivari-example-serve-sw",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
    // For `vite build`, drop the SW into the output so `npm run preview` (and any
    // static deploy of `dist/`) serves it at `/sw.js`.
    closeBundle() {
      const out = fileURLToPath(new URL("./dist/sw.js", import.meta.url));
      fs.mkdirSync(fileURLToPath(new URL("./dist", import.meta.url)), { recursive: true });
      fs.copyFileSync(swPath, out);
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [serveVivariServiceWorker()],
  resolve: {
    alias: {
      // Consume the SDK from source in the monorepo (like packages/studio does):
      // Vite compiles @vivari/core's TS and follows its nested workers + wasm.
      // A published-package consumer would instead just `import "@vivari/core"`.
      "@vivari/core": fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url)),
    },
  },
  server: {
    headers: isolation,
    // The kernel worker + its nested workers import from sibling monorepo packages
    // (packages/kernel-host, packages/runtime, packages/{vfs,codec,crypto}/pkg).
    fs: { allow: [fileURLToPath(new URL("../../", import.meta.url))] },
  },
  preview: { headers: isolation },
  worker: { format: "es" },
});
