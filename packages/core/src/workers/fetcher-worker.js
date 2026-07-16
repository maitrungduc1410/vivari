// The Fetcher Worker — Vivari's dedicated outbound-network worker.
//
// Phase 2, item #9 (Network/registry worker). The kernel worker delegates every
// outbound fetch to this worker so that downloading/decompressing/parsing large
// payloads (npm metadata + tarballs) never blocks the thread that services
// syscalls. It owns no SharedArrayBuffer: the kernel talks to it with plain
// messages, and the (possibly multi-MB) body is transferred back as an
// ArrayBuffer — it never travels through the 1 MiB syscall window.
//
// Protocol (kernel <-> fetcher):
//   kernel  -> { type: 'fetch', id, url, init }   init = {method, headers, body} | null
//   fetcher -> { type: 'fetch-result', id, ok, status, statusText, headers, body } (body transferred)
//           -> { type: 'fetch-result', id, error }                       (network failure)

// The native->wasm alias table is the single source of truth for the toolchain
// subsystem (shared with the in-process esbuild patch); add drop-ins there.
import { NATIVE_WASM_ALIASES as PACKAGE_ALIASES } from "../../../runtime/toolchain-shims.js";

// Pluggable registry endpoint (the "direct now, proxy later" seam). The npm
// registry sends `Access-Control-Allow-Origin: *` on both metadata and tarballs,
// so a cross-origin-isolated page can fetch it directly — no server needed today.
// To slot in a StackBlitz-style caching/rewriting proxy later, point REGISTRY_PROXY
// at it and rewrite() below is the ONLY place that needs to change.
const REGISTRY_PROXY = null;

// Host alias. In-VM code can reach a service running on the HOST machine (the
// machine running the browser, e.g. a real dev server on localhost:3000) by
// addressing it as `http://host.vivari.internal:<port>/…`. We map the alias
// to the studio's OWN hostname (the fetcher runs in the browser, so
// self.location.hostname IS the host), preserving scheme/port/path. This only
// reaches the host when the studio is served locally (localhost).
//
// This is addressing convenience, not a CORS/auth bypass: the target server still
// must allow the studio origin (Access-Control-Allow-Origin + a Cross-Origin-
// Resource-Policy that satisfies the page's COEP), exactly like any other
// cross-origin fetch. The reverse direction (host → preview) needs no alias: the
// host reaches an in-VM server at `<studio-origin>/preview/<port>/…` (the same
// Service Worker preview proxy the iframes use).
const HOST_ALIAS = "host.vivari.internal";

function rewrite(url) {
  try {
    const u = new URL(url);
    if (u.hostname === HOST_ALIAS) {
      u.hostname = (self.location && self.location.hostname) || "localhost";
      url = u.toString();
    }
  } catch {
    // Not an absolute URL — leave it untouched.
  }
  if (!REGISTRY_PROXY) return url;
  // e.g. return REGISTRY_PROXY + "/" + encodeURIComponent(url);
  return url;
}

// ---- transparent wasm drop-in aliasing --------------------------------------
// Some packages ship no wasm32 native build, so a plain install leaves them
// unusable in-VM. Their official WASM drop-in lives under a DIFFERENT package
// name, which npm's platform auto-select can't reach. Rather than force every
// project to add a package.json "overrides" block, we alias at the registry
// layer (StackBlitz-style): when npm asks for the packument of a source package,
// we serve the TARGET's packument rewritten to carry the source name. npm then
// resolves a version and downloads the TARGET's tarball (whose dist URL +
// integrity are the target's real ones) straight into node_modules/<source>.
//
// This works because each pair is published in lockstep (same version numbers),
// so a range like "esbuild@^0.28.0" resolves against esbuild-wasm's versions.
// Tarball requests need no interception: the rewritten packument already points
// at the target's tarballs. Keeps project package.json / angular.json pristine.
// PACKAGE_ALIASES is imported at the top of this file from the toolchain subsystem.

// Encode a package name for a registry path segment (scoped -> @scope%2fname).
function encodePkgSegment(name) {
  return name.startsWith("@") ? "@" + encodeURIComponent(name.slice(1)) : encodeURIComponent(name);
}

// If `url` is a packument (or single-version manifest) request for an aliased
// SOURCE package, return { targetUrl, src, dst }; otherwise null. Tarball
// requests (…/<name>/-/<file>.tgz) are deliberately left untouched.
function matchPackumentAlias(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const segs = u.pathname.split("/").filter(Boolean);
  if (!segs.length || segs.includes("-")) return null; // empty or a tarball path
  // Packument is …/<name>; a single-version manifest is …/<name>/<version|tag>.
  let nameIdx = segs.length - 1;
  const last = decodeURIComponent(segs[nameIdx]);
  const looksLikeVersion = /^\d/.test(last) || last === "latest";
  if (looksLikeVersion && segs.length >= 2) nameIdx = segs.length - 2;
  const src = decodeURIComponent(segs[nameIdx]);
  const dst = PACKAGE_ALIASES[src];
  if (!dst) return null;
  const newSegs = segs.slice();
  newSegs[nameIdx] = encodePkgSegment(dst);
  u.pathname = "/" + newSegs.join("/");
  return { targetUrl: u.toString(), src, dst };
}

// Rewrite a fetched packument JSON so the consumer sees it under `src` while the
// version tarballs still resolve to `dst`. Only identity fields are touched; the
// per-version `dist` (tarball + integrity), dependencies and optionalDependencies
// are preserved verbatim — the target's lack of native platform deps is exactly
// what makes it install cleanly in-VM.
function rewritePackument(json, src) {
  if (json && typeof json === "object") {
    if ("name" in json) json.name = src;
    if ("_id" in json) json._id = src;
    const versions = json.versions;
    if (versions && typeof versions === "object") {
      for (const v of Object.keys(versions)) {
        const m = versions[v];
        if (m && typeof m === "object") {
          if ("name" in m) m.name = src;
          if ("_id" in m) m._id = src + "@" + (m.version || v);
        }
      }
    }
  }
  return json;
}

// CORS-safelisted request headers: a cross-origin request that carries ONLY
// these is a "simple" request the browser sends without a preflight OPTIONS.
// See https://fetch.spec.whatwg.org/#cors-safelisted-request-header.
const CORS_SAFELISTED = new Set(["accept", "accept-language", "content-language", "content-type"]);
const SAFE_CONTENT_TYPES = new Set([
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
]);

// Keep only CORS-safelisted request headers. npm/pacote attach custom headers
// (`npm-command`, `npm-session`, `npm-auth-type`, `pacote-*`, `authorization`,
// …) which are NOT safelisted, so the browser fires a preflight OPTIONS that
// registry.npmjs.org does not answer with the matching
// `Access-Control-Allow-Headers` — the request is then blocked even though the
// registry returns `Access-Control-Allow-Origin: *` on the actual GET. None of
// those headers are needed to fetch public packuments/tarballs, so dropping
// them turns every registry request back into a simple, preflight-free GET.
// This is a browser-only concern (Node has no CORS), so the headless fetchers
// used by scripts/spike-*.mjs deliberately keep the full header set.
function corsSafeHeaders(headers) {
  if (!headers) return undefined;
  const entries = headers instanceof Headers ? [...headers] : Object.entries(headers);
  const out = {};
  for (const [k, v] of entries) {
    const lk = String(k).toLowerCase();
    if (!CORS_SAFELISTED.has(lk)) continue;
    // A non-simple Content-Type value still triggers a preflight, so drop it too.
    if (lk === "content-type" && !SAFE_CONTENT_TYPES.has(String(v).split(";")[0].trim().toLowerCase())) {
      continue;
    }
    out[k] = v;
  }
  return out;
}

async function doFetch(url, init) {
  // Default mode is 'cors'; with ACAO:* the response is readable and satisfies
  // COEP:require-corp. Follows redirects (registry tarballs may 3xx to a CDN).
  // `init` (from the http/https client shim) carries method/headers/body so a
  // real ClientRequest can egress; forbidden headers were already stripped shim-side.
  const opts = { redirect: "follow" };
  if (init) {
    if (init.method) opts.method = init.method;
    // Strip non-safelisted headers so cross-origin GETs stay preflight-free.
    if (init.headers) opts.headers = corsSafeHeaders(init.headers);
    if (init.body) opts.body = init.body;
  }

  // Transparent wasm drop-in: serve the target's packument under the source name
  // for GET metadata requests only (never for tarballs or writes). On any failure
  // we fall through to the normal fetch so aliasing can't make things worse.
  const method = (opts.method || "GET").toUpperCase();
  if (method === "GET") {
    const alias = matchPackumentAlias(url);
    if (alias) {
      try {
        const res = await fetch(rewrite(alias.targetUrl), opts);
        if (res.ok) {
          const json = rewritePackument(await res.json(), alias.src);
          const body = new TextEncoder().encode(JSON.stringify(json)).buffer;
          const headers = {};
          for (const [k, v] of res.headers) headers[k] = v;
          headers["content-type"] = "application/json";
          delete headers["content-length"]; // body length changed after rewrite
          delete headers["content-encoding"]; // we return decoded JSON bytes
          return { ok: true, status: res.status, statusText: res.statusText, headers, body };
        }
      } catch {
        // Network/parse failure — fall back to the un-aliased fetch below.
      }
    }
  }

  const res = await fetch(rewrite(url), opts);
  const buf = await res.arrayBuffer();
  const headers = {};
  for (const [k, v] of res.headers) headers[k] = v;
  return { ok: res.ok, status: res.status, statusText: res.statusText, headers, body: buf };
}

self.onmessage = async (event) => {
  const m = event.data;
  if (m.type !== "fetch") return;
  try {
    const r = await doFetch(m.url, m.init);
    self.postMessage(
      {
        type: "fetch-result",
        id: m.id,
        ok: r.ok,
        status: r.status,
        statusText: r.statusText,
        headers: r.headers,
        body: r.body,
      },
      [r.body],
    );
  } catch (err) {
    self.postMessage({
      type: "fetch-result",
      id: m.id,
      error: String((err && err.message) || err),
    });
  }
};
