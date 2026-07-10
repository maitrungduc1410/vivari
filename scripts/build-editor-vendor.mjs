// Bundle Monaco + xterm into a single same-origin ESM for the demo IDE.
//
// The page is cross-origin isolated (COEP: require-corp), so the editor + the
// terminal cannot be pulled from a CDN — every subresource must be served from
// our own origin. This collapses the monaco-editor + @xterm/xterm ESM graphs
// into one committed file (packages/demo/vendor/editor/editor.js) plus its
// stylesheet (editor.css), which both the dev server and the demo-dist build
// serve verbatim. Fonts (codicon.ttf) are inlined as data URLs so there is no
// extra asset to wire up.
//
//   node scripts/build-editor-vendor.mjs
//
// Re-run only when bumping monaco/xterm; the output is checked in.

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "packages/demo/vendor/editor/src.js");
const OUT = join(ROOT, "packages/demo/vendor/editor/editor.js");

const result = await build({
  entryPoints: [SRC],
  outfile: OUT,
  bundle: true,
  format: "esm",
  target: "esnext",
  minify: true,
  legalComments: "none",
  metafile: true,
  loader: {
    ".ttf": "dataurl",
    ".woff": "dataurl",
    ".woff2": "dataurl",
  },
  logLevel: "info",
});

const kb = (n) => (n / 1024).toFixed(1) + " KB";
for (const [file, meta] of Object.entries(result.metafile.outputs)) {
  console.log("  " + file.replace(ROOT + "/", "") + "  " + kb(meta.bytes));
}
