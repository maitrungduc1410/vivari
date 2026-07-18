import { defineConfig } from "vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// The landing site is a plain static Vite + React app. It is intentionally NOT
// cross-origin isolated: it uses no SharedArrayBuffer and links out to /studio
// (which carries the COOP/COEP headers) and /docs. Keeping COEP off here means the
// marketing page is free to load whatever it likes without CORP constraints.
export default defineConfig({
  plugins: [
    react(),
    // The React Compiler runs as a Babel plugin, wired in via plugin-react's
    // exported preset (same pattern the studio app uses).
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
  ],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
});
