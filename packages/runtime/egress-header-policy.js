// Which outbound request headers survive the browser's CORS rules.
//
// A cross-origin request carrying ONLY the four CORS-safelisted headers is a
// "simple" request the browser sends without a preflight OPTIONS. Anything else
// — `authorization`, `range`, `x-amz-*`, npm's `npm-session`/`pacote-*` — makes
// the browser ask permission first, and a target that does not answer that
// preflight with a matching `Access-Control-Allow-Headers` gets the whole
// request blocked.
//
// `registry.npmjs.org` is exactly such a target: it returns
// `Access-Control-Allow-Origin: *` on the actual GET but does not answer the
// preflight. None of npm's custom headers are needed to fetch a public packument
// or tarball, so dropping them turns every registry request back into a simple,
// preflight-free GET — which is why the Fetcher Worker started stripping them.
//
// That strip used to apply to EVERY host, and the cost was invisible: a signed
// S3 request lost its `Authorization` and `x-amz-*` headers and went out
// ANONYMOUS. Against a public bucket it then succeeded — the caller got a 200
// and the wrong bytes (a stripped `Range` returns the whole object) rather than
// an error. Any authenticated API was silently unusable, and no headless spike
// could see it, because Node has no CORS and the headless fetchers forward
// everything. So the strip is scoped to the hosts that actually need it, and
// every other target keeps its headers, pays for a preflight, and either works
// (the target allows the headers — e.g. an S3 bucket with a CORS policy) or
// fails loudly.
//
// Shared by the browser Fetcher Worker (packages/core/src/workers/fetcher-worker.ts)
// and the headless probes, so the policy has one definition and can be asserted
// off-thread. See scripts/probe-egress-headers.mjs.

export const CORS_SAFELISTED = new Set(["accept", "accept-language", "content-language", "content-type"]);

export const SAFE_CONTENT_TYPES = new Set([
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  "text/plain",
]);

// Public package registries: `Access-Control-Allow-Origin: *` on the GET, no
// answer to a preflight. A mirror is conventionally `registry.<something>`, and
// the prefix rule below covers those too.
export const PREFLIGHT_HOSTILE_HOSTS = new Set([
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "registry.npmmirror.com",
]);

/**
 * Should this URL's custom request headers be dropped to keep the request
 * preflight-free? True only for the package registries; same-origin requests are
 * not subject to CORS at all.
 */
export function stripsCustomHeaders(url, selfOrigin) {
  let u;
  try {
    u = new URL(url);
  } catch {
    // Not an absolute URL: same-origin by definition, so CORS does not apply.
    return false;
  }
  if (selfOrigin && u.origin === selfOrigin) return false;
  return PREFLIGHT_HOSTILE_HOSTS.has(u.hostname) || u.hostname.startsWith("registry.");
}

/** Keep only the CORS-safelisted request headers. */
export function corsSafeHeaders(headers) {
  if (!headers) return undefined;
  const entries = typeof Headers !== "undefined" && headers instanceof Headers ? [...headers] : Object.entries(headers);
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

/** The headers to actually put on the browser `fetch()` for this URL. */
export function egressHeaders(url, headers, selfOrigin) {
  if (!headers) return undefined;
  return stripsCustomHeaders(url, selfOrigin) ? corsSafeHeaders(headers) : headers;
}