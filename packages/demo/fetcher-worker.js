// The Fetcher Worker — OpenContainer's dedicated outbound-network worker.
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

// Pluggable registry endpoint (the "direct now, proxy later" seam). The npm
// registry sends `Access-Control-Allow-Origin: *` on both metadata and tarballs,
// so a cross-origin-isolated page can fetch it directly — no server needed today.
// To slot in a StackBlitz-style caching/rewriting proxy later, point REGISTRY_PROXY
// at it and rewrite() below is the ONLY place that needs to change.
const REGISTRY_PROXY = null;

function rewrite(url) {
  if (!REGISTRY_PROXY) return url;
  // e.g. return REGISTRY_PROXY + "/" + encodeURIComponent(url);
  return url;
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
