import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Library build for @vivari/react. React and @vivari/core are peer/runtime deps
// the consumer already has, so they stay external — this package ships only the
// thin bindings.
export default defineConfig({
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
      external: [
        "react",
        "react-dom",
        "react/jsx-runtime",
        "@vivari/core",
      ],
    },
  },
});
