// Spike (NETWORK): prove the Astro Starlight docs template boots + serves in-VM.
//
// Starlight rides the Astro path spike-astro.mjs already proves (Vite dev server, the Go/wasm
// @astrojs/compiler, the rollup -> @rollup/wasm-node registry alias, and the loader-stack fixes
// listed in that spike's header). On top of that it adds a content-collection pipeline
// (docsLoader + MDX/expressive-code) and a multi-page themed site, which is what this spike
// covers beyond plain Astro.
//
// VERSION PIN — Astro 5, not the latest. Astro >=6 switched Vite 6 -> Vite 7, whose bundler is
// rolldown, and rolldown does not load in-VM: `astro dev` on Astro 7 logs
// "[rolldown] Downloading @rolldown/binding-wasm32-wasi@… on WebContainer" and then dies with
// "TypeError: Class extends value undefined is not a constructor or null" before binding a port.
// (Consistent with the VITE_DEV `--configLoader native` workaround in templates.ts, which exists
// because Vite's rolldown config bundler also fails here.) Astro 5.18 is Vite 6 and is the major
// the shipped `astro` template + spike-astro.mjs already prove, so Starlight pins to the newest
// Starlight line that peers on astro ^5 (0.37.x). Revisit when rolldown works in-VM.
//
// Two things this exists to prove, neither of which plain Astro exercises:
//   1. **No image binary is ever needed.** Astro lists `sharp` as an optionalDependency, and
//      Starlight's `astro:assets` usage would otherwise reach for it. The template configures
//      `image: { service: passthroughImageService() }` so the sharp-backed service is never
//      constructed. Gate 1 asserts no usable native sharp binary landed AND gate 4 asserts the
//      dev log is free of sharp/image-service errors — so a regression can't hide behind a
//      page that happens to still render.
//   2. **The preview prefix, which Starlight needs and plain Astro does not.** Settled
//      empirically, not assumed: Starlight renders its sidebar / pager / site-title links as
//      ROOT-ABSOLUTE hrefs that follow Astro's `base`. With base="/" they come out as "/…",
//      and sw.js refuses to proxy a navigation carrying no /preview/<port>/ marker, so the
//      site would load and then break on the first sidebar click. With base="/preview/4321/"
//      every link carries the marker. Hence base + keepPreviewPrefix: true. (The shipped
//      `astro` template escapes this only because it is a single page with no internal links.)
//      VV_BASE overrides the base; the default is the shipped one, so run-spikes.mjs gates the
//      real config. VV_BASE=/ reproduces the control — note its link check is vacuous there.
//
// Gates (all must pass):
//   1) install ok, astro + starlight present, no usable native sharp binary,
//   2) `astro dev` binds its port,
//   3) GET the site root -> 200 with the real Starlight shell,
//   4) no sharp / image-service error in the dev output,
//   5) a deep link (second docs page) serves 200,
//   6) every internal <a href> sits under the base (the keepPreviewPrefix contract, gate 2 above),
//   7) both asset shapes serve: one under base, one root-absolute Vite dev URL.
//
//   1) vendor npm:  rm -rf /tmp/vv-vendor && mkdir -p /tmp/vv-vendor \
//        && (cd /tmp/vv-vendor && npm install npm@10.9.2 --no-save --no-audit --no-fund)
//   2) run (Node 22+):  node scripts/spike-starlight.mjs
//      env: VV_LIVE=1 (stream), VV_INSTALL_ONLY=1, VV_BASE=/preview/4321/, VV_PORT.
process.env.VV_BIND_TIMEOUT ||= "300000"; // Astro's first Vite build + wasm boot is slow in-VM.
import { bootSpikeKernel, writeProject, npmInstall, waitListen, httpGet, defaultEnv } from "./lib/spike-harness.mjs";

const DIR = "/starlight";
const PORT = Number(process.env.VV_PORT || 4321);
// Defaults to the base the SHIPPED template uses, so run-spikes.mjs gates the real config.
// Override with VV_BASE=/ to reproduce the no-base control (see the header comment).
const BASE = process.env.VV_BASE || `/preview/${PORT}/`;
// Astro 5 (Vite 6) on purpose — NOT Astro 6/7. See the header comment: Astro >=6 moves to
// Vite 7 / rolldown, which does not load in-VM. Starlight 0.37.x is the newest line peering
// on astro ^5.
const ASTRO_VERSION = process.env.VV_ASTRO_VERSION || "^5.18.0";
const STARLIGHT_VERSION = process.env.VV_STARLIGHT_VERSION || "^0.37.7";

// Join BASE with a site-relative path, tolerating BASE with or without a trailing slash.
const at = (p) => (BASE.replace(/\/$/, "") + "/" + p.replace(/^\//, "")).replace(/^(?!\/)/, "/");

const h = await bootSpikeKernel();

// Minimal Starlight site — the same shape the studio template ships.
writeProject(h.kernel, DIR, {
  "package.json": `{
  "name": "starlight-docs",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview"
  },
  "dependencies": {
    "astro": "${ASTRO_VERSION}",
    "@astrojs/starlight": "${STARLIGHT_VERSION}"
  }
}
`,
  "astro.config.mjs": `import { defineConfig, passthroughImageService } from 'astro/config'
import starlight from '@astrojs/starlight'

export default defineConfig({
  base: '${BASE}',
  // Never construct the sharp-backed image service — see the header comment.
  image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: 'Starlight on Vivari',
      description: 'Docs that build and run entirely in the browser VM',
      pagefind: false,
      sidebar: [
        { label: 'Guides', items: [{ label: 'Getting Started', slug: 'guides/getting-started' }] },
      ],
    }),
  ],
})
`,
  // Mirrors the shipped template. Without it npm resolves manifests for ~19 optional peer
  // deps of Astro's unstorage/db0 (Prisma, Drizzle, react-native, Azure, Xata) and drags
  // ~420 MB of decoded packument JSON through the fetcher instead of ~108 MB. See gate 5.
  ".npmrc": `legacy-peer-deps=true\n`,
  // Starlight's default <head> references /favicon.svg; ship the official starter's mark
  // (withastro/starlight examples/basics) so the shell has no 404. It adapts to light/dark
  // via an embedded prefers-color-scheme style.
  "public/favicon.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><path fill-rule="evenodd" d="M81 36 64 0 47 36l-1 2-9-10a6 6 0 0 0-9 9l10 10h-2L0 64l36 17h2L28 91a6 6 0 1 0 9 9l9-10 1 2 17 36 17-36v-2l9 10a6 6 0 1 0 9-9l-9-9 2-1 36-17-36-17-2-1 9-9a6 6 0 1 0-9-9l-9 10v-2Zm-17 2-2 5c-4 8-11 15-19 19l-5 2 5 2c8 4 15 11 19 19l2 5 2-5c4-8 11-15 19-19l5-2-5-2c-8-4-15-11-19-19l-2-5Z" clip-rule="evenodd"/><path d="M118 19a6 6 0 0 0-9-9l-3 3a6 6 0 1 0 9 9l3-3Zm-96 4c-2 2-6 2-9 0l-3-3a6 6 0 1 1 9-9l3 3c3 2 3 6 0 9Zm0 82c-2-2-6-2-9 0l-3 3a6 6 0 1 0 9 9l3-3c3-2 3-6 0-9Zm96 4a6 6 0 0 1-9 9l-3-3a6 6 0 1 1 9-9l3 3Z"/><style>path{fill:#000}@media (prefers-color-scheme:dark){path{fill:#fff}}</style></svg>
`,
  // MUST exist — see the header comment. Starlight always loads astro-expressive-code, whose
  // loadEcConfigFile() only tolerates an ABSENT config when the failed dynamic import reports
  // ERR_MODULE_NOT_FOUND / ERR_LOAD_URL; in-VM it reports the CJS code MODULE_NOT_FOUND, so an
  // absent file is misread as a broken one and `astro dev` exits before binding.
  "ec.config.mjs": `// Expressive Code options for Starlight's code blocks.
// Deliberately a plain object with NO imports: this file is loaded by a bare dynamic import
// from the project root (it is not processed by Vite), so keeping it dependency-free avoids
// an ESM re-export chain at boot. \`defineEcConfig\` from '@astrojs/starlight/expressive-code'
// is only a typing helper, so nothing is lost.
export default {
  styleOverrides: { borderRadius: '0.4rem' },
}
`,
  "src/content.config.ts": `import { defineCollection } from 'astro:content'
import { docsLoader } from '@astrojs/starlight/loaders'
import { docsSchema } from '@astrojs/starlight/schema'

export const collections = {
  docs: defineCollection({ loader: docsLoader(), schema: docsSchema() }),
}
`,
  "src/content/docs/index.mdx": `---
title: Starlight on Vivari
description: An Astro Starlight docs site compiled entirely in the browser VM
---

Welcome to **Starlight**, running entirely inside Vivari's in-browser VM.

- Write docs in Markdown or MDX
- Live hot reload as you edit
- Zero native dependencies
`,
  "src/content/docs/guides/getting-started.md": `---
title: Getting Started
description: Add a page, order the sidebar, edit and watch it hot-reload
---

Add a page by dropping a \`.md\` / \`.mdx\` file under \`src/content/docs/\`.

\`\`\`ts
export function greet(name: string): string {
  return \`Hello, \${name}!\`
}
\`\`\`
`,
});

// ── gate 1: install, and no usable native image binary ───────────────────────
// --ignore-scripts MUST match the manifest's install command, and it is not cosmetic: sharp's
// `node install/check.js` starts and then never exits in-VM, so npm waits on it forever (see the
// header). A spike that installs WITH scripts is not testing what the studio runs.
const inst = await npmInstall(h, { dir: DIR, extraArgs: ["--ignore-scripts"] });
if (inst.code !== 0) process.exit(1);

// Astro 7 moved its CLI to bin/astro.mjs; Astro 5 (the older `astro` template + spike-astro.mjs)
// has astro.js at the package root. Accept either so this spike survives a version bump.
const CLI = ["node_modules/astro/bin/astro.mjs", "node_modules/astro/astro.js"].find((p) =>
  h.kernel.exists(DIR + "/" + p),
);
const astroCli = !!CLI;
const starlightPkg = h.kernel.exists(DIR + "/node_modules/@astrojs/starlight/package.json");
// sharp itself may land (Astro lists it as an optionalDependency); what must NOT land is a
// native platform binary npm could actually load on this host.
const nativeSharp = ["linux-x64", "linux-arm64", "linuxmusl-x64", "darwin-x64", "darwin-arm64", "win32-x64"].some(
  (p) => h.kernel.exists(DIR + "/node_modules/@img/sharp-" + p),
);
console.log("  astro CLI present:                 " + astroCli + (CLI ? `  (${CLI})` : ""));
console.log("  @astrojs/starlight present:        " + starlightPkg);
console.log("  a NATIVE @img/sharp-* present:     " + nativeSharp + (nativeSharp ? "  (BAD)" : ""));
// Informational, deliberately NOT asserted: npm's platform auto-select also pulls sharp's own
// wasm build (@img/sharp-wasm32), so an image service is not strictly unavailable in-VM. The
// template still uses passthroughImageService — see its header comment for why we don't rely on
// this — but recording it keeps the AGENTS.md note honest and flags the day it stops landing.
console.log(
  "  @img/sharp-wasm32 present:         " + h.kernel.exists(DIR + "/node_modules/@img/sharp-wasm32") + "  (informational)",
);

if (process.env.VV_INSTALL_ONLY === "1") {
  console.log("\nVV_INSTALL_ONLY=1 — stopping after install.");
  process.exit(astroCli && starlightPkg && !nativeSharp ? 0 : 1);
}

// ── gate 2: `astro dev` binds the port ───────────────────────────────────────
const devStart = h.out.length;
const env = { ...defaultEnv(DIR), PORT: String(PORT) };
const bound = await waitListen(h, {
  dir: DIR,
  port: PORT,
  argv: [CLI, "dev", "--port", String(PORT)],
  env,
});

// ── gate 3: GET the site root -> 200 with the real Starlight shell ───────────
let rootOk = false;
let deepOk = true;
let assetOk = true;
let navOk = true;
if (bound) {
  // Request paths exactly as the browser would under this base (Astro serves the site AT base).
  const root = await httpGet(h.kernel, PORT, BASE);
  // Starlight's own shell: its stylesheet-scoped `sl-` class prefix + the configured title.
  rootOk = root.status === 200 && /Starlight on Vivari/.test(root.body) && /\bsl-/.test(root.body);
  console.log(`  GET ${BASE} -> ${root.status}  (${root.body.length} bytes)`);
  console.log("  body head: " + root.body.slice(0, 200).replace(/\n/g, " "));
  console.log("  Starlight shell (sl- classes): " + /\bsl-/.test(root.body));

  // Starlight is a MULTI-page themed site, so a deep link must resolve too — this is what
  // regresses if the base/preview-prefix pairing is wrong.
  const deep = at("guides/getting-started/");
  const dr = await httpGet(h.kernel, PORT, deep);
  deepOk = dr.status === 200 && /Getting Started/.test(dr.body);
  console.log(`  GET ${deep} -> ${dr.status}  deepOk=${deepOk}`);

  // THE reason this template sets `base` + keepPreviewPrefix. Starlight renders its sidebar,
  // prev/next pager and site-title link as ROOT-ABSOLUTE hrefs. Clicking one is a top-level
  // navigation, and packages/studio/public/sw.js deliberately does NOT proxy a navigation that
  // carries no /preview/<port>/ marker (`if (event.request.mode === "navigate") return;` — it
  // assumes such a document is the studio's own). So without base every sidebar click would
  // leave the preview instead of routing into the VM: the site would load and then break on the
  // first link. Requiring every internal link to sit under base is what pins that down; assets
  // are exempt because they are subresources, which DO get routeByClient (see below).
  const links = [...root.body.matchAll(/<a\b[^>]+href="(\/[^"]*)"/gi)].map((m) => m[1]);
  if (BASE === "/") {
    // Vacuous under the no-base control: every root-absolute href trivially starts with "/".
    console.log(`  internal <a> links: ${links.length} (base="/" — prefix check n/a)`);
  } else {
    const offBase = links.filter((u) => !u.startsWith(BASE));
    navOk = links.length > 0 && offBase.length === 0;
    console.log(`  internal <a> links: ${links.length}, all under ${BASE}: ${navOk}`);
    if (offBase.length) console.log("    off-base: " + [...new Set(offBase)].slice(0, 8).join(", "));
  }

  // Assets. Astro dev emits TWO shapes and BOTH must serve, because the SW reaches them by
  // different routes (packages/studio/public/sw.js):
  //   - base-prefixed (e.g. /preview/4321/_astro/…) — matched by the /preview/<port>/ marker;
  //   - root-absolute Vite dev URLs (/@id/…, /@vite/client, /@fs/…) which Vite does NOT put
  //     under base — these have no marker, so `routeByClient` infers the port from the issuing
  //     iframe's own /preview/<port>/ document URL. That is why a root-absolute asset here is
  //     CORRECT and must not be asserted to start with base (an earlier draft of this spike got
  //     that wrong): under keepPreviewPrefix the iframe URL always carries the prefix.
  if (BASE !== "/") {
    const urls = [...root.body.matchAll(/<(?:script|link)[^>]+(?:src|href)="(\/[^"]+)"/gi)].map((m) => m[1]);
    const underBase = urls.filter((u) => u.startsWith(BASE));
    const rootAbs = urls.filter((u) => !u.startsWith(BASE));
    console.log(`  shell assets: ${underBase.length} under ${BASE}, ${rootAbs.length} root-absolute (Vite dev URLs)`);
    // Fetch one of each shape that the shell actually emits.
    const probes = [underBase[0], rootAbs[0]].filter(Boolean);
    if (!probes.length) {
      console.log("  (no script/link asset found in the shell to verify)");
      assetOk = false;
    }
    for (const u of probes) {
      const a = await h.kernel.handleHttpRequest(PORT, {
        port: PORT,
        method: "GET",
        url: u,
        headers: { host: "127.0.0.1:" + PORT },
        body: "",
      });
      const ct = (a.headers && (a.headers["content-type"] || a.headers["Content-Type"])) || "";
      const one = a.status === 200 && !/text\/html/.test(ct);
      console.log(`  GET ${u} -> ${a.status} (${ct}) ok=${one}`);
      if (!one) assetOk = false;
    }
  }
} else {
  console.log("\n---- dev output tail (last 4000 chars) ----\n" + h.out.slice(devStart).join("").slice(-4000));
}

// ── gate 4: nothing reached for sharp / an image service ─────────────────────
const devLog = h.out.slice(devStart).join("");
const imageErr = devLog.match(/Could not find Sharp|sharp.*not (?:be )?(?:found|installed)|MissingSharp|ImageNotFound/i);
const sharpClean = !imageErr;
console.log("  no sharp/image-service error in dev output: " + sharpClean + (imageErr ? `  (saw: ${imageErr[0]})` : ""));

const ok = inst.code === 0 && astroCli && starlightPkg && !nativeSharp && bound && rootOk && deepOk && navOk && assetOk && sharpClean;
console.log(
  "\nRESULT: " +
    (ok
      ? `PASS — Starlight dev server boots (Vite + @astrojs/compiler wasm, passthrough images) and serves ${BASE} + a deep link with 200`
      : "FAIL — see logs above"),
);
process.exit(ok ? 0 : 1);