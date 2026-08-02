import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";

// The `"use client"` directive at the top of every module in src/ is what lets a
// Next.js App Router *Server* Component import this package at all — without it
// the first hook throws at build time. Rollup hoists those directives into a
// single one at the top of the chunk, but that is bundler behaviour, not a
// contract: a Vite/Rollup upgrade could drop it and nothing else would notice
// until a user filed the bug. So fail the build instead.
function assertUseClient(): Plugin {
  return {
    name: "vv-assert-use-client",
    generateBundle(_options, bundle) {
      const entry = bundle["index.js"];
      if (entry?.type !== "chunk") throw new Error("expected an index.js entry chunk");
      if (!/^["']use client["'];/.test(entry.code)) {
        throw new Error(
          'dist/index.js does not start with "use client" — importing @vivari/react from a ' +
            "Next.js Server Component would fail. Check that src/index.ts still carries the " +
            "directive and that the bundler still preserves it.",
        );
      }
    },
  };
}

// Library build for @vivari/react. React and @vivari/core are peer deps the
// consumer already has, so they stay external — this package ships only the
// thin bindings.
export default defineConfig({
  plugins: [assertUseClient()],
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
      external: ["react", "react-dom", "react/jsx-runtime", "@vivari/core"],
    },
  },
});