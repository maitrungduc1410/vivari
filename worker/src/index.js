// Cloudflare Worker — mode C (wildcard per-port preview origins).
//
// In mode C every in-VM port is served from its OWN origin,
// `<token>--<port>-vv.<domain>` (e.g. k3f9a2xh--5173-vv.jamesisme.com). That
// gives each preview real `localhost:<port>` web-platform semantics (its own
// cookies/storage/CORS) and isolates previews from the IDE *and* from each other.
// The `-vv` tag is a SUFFIX (not a prefix) because Cloudflare routes only allow
// the `*` wildcard at the START of the hostname — so the route `*-vv.<domain>/*`
// is valid AND narrow (it matches only our per-port hosts, never other apps).
//
// Cloudflare Pages can't attach a *wildcard* custom domain, so a Worker (bound to
// a `*-vv.<domain>/*` route) plays the role the second Pages project plays in mode
// B: pure static hosting for the preview Service Worker runtime. It runs NO kernel
// and NO studio UI. The SW it serves relays every preview request over a
// MessagePort to the kernel living in the IDE tab (see packages/studio/public/
// sw.js `WILDCARD_MODE` + packages/core/src/bridge.ts `ensurePreviewBridge`).
//
// Responsibilities:
//   1. Gate on the preview hostname — pass every other host straight through so
//      unrelated apps on the same base domain keep working.
//   2. Serve our static SW-runtime files (sw.js, the bridge doc, the boot page,
//      the DevTools CDP backend), mapping Cloudflare "clean URL" forms back to
//      their `.html` file.
//   3. Serve the boot page for any other path (the app root `/` and its
//      subresources) — reached only before a Service Worker controls the tab; the
//      boot page registers the SW first-party and reloads into the real preview.
//   4. Stamp cross-origin isolation headers on every response so the IDE
//      (COEP:require-corp) can embed the bridge iframe and the SW can claim `/`.

// A Vivari preview host: `<token>--<port>-vv.<rest>`. Keep this in sync with the
// tag in packages/core (default "vv" suffix) and the regex in sw.js.
const PREVIEW_HOST = /^[a-z0-9]+--\d+-vv\./i;

// Cloudflare "clean URLs" serve `/x.html` as `/x`; map both forms to the file.
const ALIASES = {
  "/__vv-bridge": "/__vv-bridge.html",
  "/__vv-preview-boot": "/__vv-preview-boot.html",
};

// The real asset file for a request path, or null if it isn't a static
// SW-runtime file (→ falls back to the boot page).
function assetPathFor(pathname) {
  if (ALIASES[pathname]) return ALIASES[pathname];
  if (
    pathname === "/sw.js" ||
    pathname === "/__vv-bridge.html" ||
    pathname === "/__vv-preview-boot.html" ||
    pathname.startsWith("/vv-devtools/")
  ) {
    return pathname;
  }
  return null;
}

// Re-emit a response with cross-origin isolation headers. Previews are a DIFFERENT
// origin from the IDE, so CORP:cross-origin + COEP:credentialless make the SW, the
// bridge doc and chobitsu.js embeddable under the IDE's COEP:require-corp;
// COOP:same-origin isolates a preview opened as its own top-level tab; and the SW
// must be allowed to claim root scope.
function isolate(res, pathname, status) {
  const h = new Headers(res.headers);
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  h.set("Cross-Origin-Embedder-Policy", "credentialless");
  h.set("Cross-Origin-Resource-Policy", "cross-origin");
  if (pathname === "/sw.js") h.set("Service-Worker-Allowed", "/");
  return new Response(res.body, {
    status: status || res.status,
    statusText: res.statusText,
    headers: h,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Not a Vivari preview host → leave it entirely alone.
    if (!PREVIEW_HOST.test(url.hostname)) return fetch(request);

    const real = assetPathFor(url.pathname);
    if (real) {
      const res = await env.ASSETS.fetch(new URL(real, url.origin));
      return isolate(res, url.pathname);
    }

    // Any other path (the app root `/` and its subresources). Once the SW controls
    // the tab it intercepts these before they reach us, so a request that DOES
    // reach us means no SW is controlling yet (first hit / hard reload): hand back
    // the boot page, which registers the SW first-party and reloads.
    const boot = await env.ASSETS.fetch(new URL("/__vv-preview-boot.html", url.origin));
    return isolate(boot, "/__vv-preview-boot.html", 200);
  },
};