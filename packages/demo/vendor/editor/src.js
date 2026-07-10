// Vendor entry for the demo IDE's editor + terminal. Bundled by
// scripts/build-editor-vendor.mjs into a single same-origin ESM (editor.js) +
// stylesheet (editor.css) committed alongside. Same-origin matters: the page is
// cross-origin isolated (COEP: require-corp), so Monaco/xterm cannot come from a
// CDN — they must be served from our own origin. host.js imports from the built
// editor.js; index.html links editor.css.
import * as monaco from "monaco-editor";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export { monaco, Terminal, FitAddon };
