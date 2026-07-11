import { defineConfig, type Plugin } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import Icons from "unplugin-icons/vite";
import { fileURLToPath, URL } from "node:url";

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
    name: "oc-cross-origin-isolation",
    configureServer(server) {
      server.middlewares.use(mw);
    },
    configurePreviewServer(server) {
      server.middlewares.use(mw);
    },
  };
}

// https://vite.dev/config/
export default defineConfig({
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
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    headers: isolation,
    // The kernel worker (and its nested workers) live in sibling packages
    // (packages/demo, packages/kernel-host, packages/runtime, packages/vfs|codec|
    // crypto/pkg). Let Vite's dev server read + bundle them from the monorepo root.
    fs: { allow: [fileURLToPath(new URL("../../", import.meta.url))] },
  },
  preview: { headers: isolation },
  worker: { format: "es" },
});
