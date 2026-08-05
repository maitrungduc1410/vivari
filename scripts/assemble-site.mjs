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
// vendored package-manager assets as the studio. They ship in the studio build
// (packages/studio/public/vendor → /studio/vendor); the kernel worker fetches
// them relative to the app base (/embed/vendor here), so copy the tree in.
const studioVendor = path.join(studioOut, "vendor");
if (fs.existsSync(studioVendor)) {
  fs.cpSync(studioVendor, path.join(embedOut, "vendor"), { recursive: true });
  console.log("\u2192 copied vendor assets into /embed/");
}

// 4. Headers: scope cross-origin isolation to every surface that runs the
// runtime. The studio and the /embed/ playground need SharedArrayBuffer directly;
// the docs (/docs/*) and the blog (/blog/*) need it because they host the /embed/
// iframe, and an iframe is only cross-origin isolated when its top-level document
// is too. The cost is that both sites must serve every image same-origin, since
// COEP blocks third-party subresources that don't send CORP. The landing (/)
// stays free of COEP. Preview responses (/preview/<port>/) are synthesized by the
// SW, which stamps their isolation headers itself.
//
// The DevTools frontend needs an entry of its OWN even though it is same-origin.
// Under COEP:require-corp a nested DOCUMENT is not covered by the same-origin
// exemption that subresources get: it must send require-corp (or credentialless)
// itself, or Chrome refuses the frame outright with the "<host> refused to
// connect" error page. `/devtools-host.html` is hoisted OUT of /studio/ to the
// origin root (above), so the `/studio/*` rule no longer reaches it. Both the
// `.html` and the extensionless form are listed because Pages' clean URLs redirect
// `/x.html` to `/x`, and the rule must match the URL that finally answers 200.
// Locally none of this shows up: the Vite dev server stamps isolation on EVERY
// response (vite.config.ts `swScope()`), so devtools-host.html inherits it there.
const COI = `  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp`;
const headers = `# Generated by scripts/assemble-site.mjs — do not edit by hand.
/studio/*
${COI}

/embed/*
${COI}

/docs/*
${COI}

/blog/*
${COI}

/devtools-host.html
${COI}

/devtools-host
${COI}

/devtools/*
${COI}

/sw.js
  Service-Worker-Allowed: /
${COI}
`;
fs.writeFileSync(path.join(dist, "_headers"), headers);

// 5. SPA fallback so deep links inside the studio resolve to its shell. Static
// files (assets, favicon) are served before this rule ever applies.
fs.writeFileSync(path.join(dist, "_redirects"), "/studio/* /studio/index.html 200\n");

console.log(`\u2713 assembled site into ${path.relative(root, dist)}/`);