// Assemble the Cloudflare Worker's static assets (mode C — wildcard per-port
// preview origins).
//
//   worker/public/            <- served by worker/src/index.js on *.<domain>
//     sw.js                   <- the preview Service Worker (host-based routing)
//     __vv-bridge.html        <- hidden bridge doc the IDE iframes to hand the SW a port
//     __vv-preview-boot.html  <- first-party boot page for a standalone preview tab
//     vv-devtools/chobitsu.js <- the in-preview DevTools (CDP) backend
//
// Unlike mode B (a second Pages project reading dist-preview/), mode C is a Worker,
// so there is no _headers/_redirects — worker/src/index.js stamps the isolation
// headers and serves the boot fallback itself. This script just copies the exact
// static files the Worker needs out of the studio build.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const STUDIO = path.join(root, "packages/studio/dist");
const out = path.join(root, "worker/public");

if (!fs.existsSync(STUDIO)) {
  console.error(`\u2717 missing studio build: ${STUDIO}`);
  console.error("  Build the studio first (see scripts/cloudflare-build-worker.sh).");
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// Same static set as the mode-B preview origin (see assemble-preview.mjs).
const FILES = ["sw.js", "__vv-bridge.html", "__vv-preview-boot.html"];
const DIRS = ["vv-devtools"]; // chobitsu.js (the CDP backend, absolute-pathed by the SW)

for (const name of FILES) {
  const from = path.join(STUDIO, name);
  if (!fs.existsSync(from)) {
    console.error(`\u2717 missing ${name} in the studio build (${from})`);
    process.exit(1);
  }
  fs.copyFileSync(from, path.join(out, name));
  console.log(`\u2192 ${name}`);
}

for (const name of DIRS) {
  const from = path.join(STUDIO, name);
  if (!fs.existsSync(from)) {
    console.warn(`\u26a0 optional ${name}/ not found in the studio build — skipping`);
    continue;
  }
  fs.cpSync(from, path.join(out, name), { recursive: true });
  console.log(`\u2192 ${name}/`);
}

console.log(`\u2713 assembled worker assets into ${path.relative(root, out)}/`);