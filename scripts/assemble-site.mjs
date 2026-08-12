// Assemble the single Cloudflare Pages deploy from the app builds:
//
//   dist/            <- landing (sites/landing/dist)  ->  served at /
//   dist/docs/       <- docs    (sites/docs/build)     ->  served at /docs/
//   dist/blog/       <- blog    (sites/blog/build)     ->  served at /blog/
//   dist/studio/     <- studio  (packages/studio/dist) ->  served at /studio/
//
// The docs and the blog are two separate Docusaurus builds precisely because the
// landing occupies `/`: a single Docusaurus site covering both would need
// baseUrl `/`, and its index.html would overwrite the landing's below.
//
// The preview Service Worker and its runtime asset tree are hoisted to the origin
// root (/sw.js, /vv-devtools/*, /devtools/*, /devtools-host.html) because the SW
// claims root scope and hard-codes those absolute paths. Only the studio UI is
// namespaced under /studio/. Finally we emit _headers (COOP/COEP scoped to the
// studio, the embedded surfaces, the hoisted DevTools frontend and the SW) and a
// _redirects SPA fallback for /studio/*.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SITE_HEADERS, checkKernelAssets } from "./lib/site-headers.mjs";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const dist = path.join(root, "dist");

const LANDING = path.join(root, "sites/landing/dist");
const DOCS = path.join(root, "sites/docs/build");
const BLOG = path.join(root, "sites/blog/build");
const STUDIO = path.join(root, "packages/studio/dist");
const EMBED = path.join(root, "sites/embed/dist");

// Studio runtime paths that must live at the origin root, not under /studio/.
const HOIST = ["sw.js", "vv-devtools", "devtools", "devtools-host.html"];

function requireDir(p, label) {
  if (!fs.existsSync(p)) {
    console.error(`\u2717 missing ${label} build: ${p}`);
    console.error("  Run the full build first (see scripts/cloudflare-build.sh).");
    process.exit(1);
  }
}

requireDir(LANDING, "landing");
requireDir(DOCS, "docs");
requireDir(BLOG, "blog");
requireDir(STUDIO, "studio");
requireDir(EMBED, "embed");

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// 1. Landing at the root.
fs.cpSync(LANDING, dist, { recursive: true });

// 2. Docs under /docs/.
fs.cpSync(DOCS, path.join(dist, "docs"), { recursive: true });

// 2b. Blog under /blog/.
fs.cpSync(BLOG, path.join(dist, "blog"), { recursive: true });

// 3. Studio under /studio/.
const studioOut = path.join(dist, "studio");
fs.cpSync(STUDIO, studioOut, { recursive: true });

// 3b. Hoist the SW runtime tree from /studio/ up to the origin root.
for (const name of HOIST) {
  const from = path.join(studioOut, name);
  const to = path.join(dist, name);
  if (!fs.existsSync(from)) continue;
  fs.rmSync(to, { recursive: true, force: true });
  fs.renameSync(from, to);
  console.log(`\u2192 hoisted ${name} to origin root`);
}

// 3c. Embed playground under /embed/ (iframed by the docs live examples). It
// registers the same root /sw.js, so no per-app copy is needed here.
const embedOut = path.join(dist, "embed");
fs.cpSync(EMBED, embedOut, { recursive: true });
// The embed's standalone build emits its own /embed/sw.js; the real SW is the
// hoisted root /sw.js, so drop the redundant copy to avoid a stale duplicate.
fs.rmSync(path.join(embedOut, "sw.js"), { force: true });
// The embed's React live example runs `npm run dev`, so it needs the same
// vendored package-manager assets as the studio, and the Python examples need
// vendor/pyodide from that same tree. They ship in the studio build
// (packages/studio/public/vendor → /studio/vendor); the kernel worker fetches
// them relative to the app base (/embed/vendor here), so copy the whole tree in.
// Narrowing this to the package-manager subdirectories would break both Python
// demos with a fetch error that says nothing about the cause.
const studioVendor = path.join(studioOut, "vendor");
if (fs.existsSync(studioVendor)) {
  fs.cpSync(studioVendor, path.join(embedOut, "vendor"), { recursive: true });
  console.log("\u2192 copied vendor assets into /embed/");
}

// 4. Headers. The text and the reasoning behind every block live in
// scripts/lib/site-headers.mjs, next to the spike that asserts on them — the
// duplicate-COOP failure they guard cannot be reproduced by any local server, so
// the gate has to be able to read them without running an assembly.
fs.writeFileSync(path.join(dist, "_headers"), SITE_HEADERS);

// 5. SPA fallback so deep links inside the studio resolve to its shell. Static
// files (assets, favicon) are served before this rule ever applies.
fs.writeFileSync(path.join(dist, "_redirects"), "/studio/* /studio/index.html 200\n");

// 6. Assert that every asset the kernel fetches at runtime is actually in the
// output. The list and the reasoning are in scripts/lib/site-headers.mjs; what
// counts as "there" is a non-empty file (or a non-empty directory), because the
// failure being guarded answers 200 rather than 404.
const { missing, present, absentOptional } = checkKernelAssets(dist, (abs, asset) => {
  if (!fs.existsSync(abs)) return false;
  return asset.dir ? fs.readdirSync(abs).length > 0 : fs.statSync(abs).size > 0;
});
for (const rel of absentOptional) console.log(`\u25cb optional asset not produced: ${rel}`);
if (missing.length) {
  console.error("\n\u2717 kernel-fetchable assets missing from dist/:");
  for (const m of missing) console.error(`    ${m}`);
  console.error(
    "\n  These do NOT 404 in production — the _redirects SPA fallback answers 200 text/html\n" +
    "  and the kernel silently disables whatever needed them. Check that scripts/\n" +
    "  cloudflare-build.sh runs every vendor:* target that prebuild:studio does.",
  );
  process.exit(1);
}
// Count what was actually found, not what was looked for: this is the one check
// whose job is to be loud, so its success line must not quietly include the
// optional assets it just reported as absent.
console.log(
  `\u2713 ${present} kernel-fetchable asset paths present` +
    (absentOptional.length ? `, ${absentOptional.length} optional absent (see above)` : ""),
);

console.log(`\u2713 assembled site into ${path.relative(root, dist)}/`);