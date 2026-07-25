// Shared headless spike fetcher — mirrors the browser kernel's transparent
// native->wasm package aliasing (packages/core/src/workers/fetcher-worker.ts).
//
// Several packages ship a native binary with no wasm32 build (esbuild, rollup,
// lightningcss); their official WASM drop-ins live under a DIFFERENT package
// name, which npm's platform auto-select can't reach. The browser kernel serves
// the target's packument under the source name at the registry layer so a plain
// in-VM `npm install` pulls the wasm drop-in with NO project-level "overrides".
//
// Headless spikes (scripts/spike-*.mjs) MUST do the same, otherwise they install
// the native binary the browser kernel never sees and it dies in-VM with
// `Unsupported platform: linux wasm32 LE` (esbuild/rollup) or a missing
// `.node` (lightningcss). This module is the single source of that logic, driven
// by the same alias tables the browser uses (packages/runtime/toolchain-shims.js)
// so the two paths can't drift. Unlike the browser fetcher there is no CORS
// header stripping — Node has no CORS.

import {
  NATIVE_WASM_ALIASES,
  NATIVE_DROPIN_ALIASES,
  synthesizeRemappedPackument,
} from "../../packages/runtime/toolchain-shims.js";

const encodePkgSegment = (n) =>
  n.startsWith("@") ? "@" + encodeURIComponent(n.slice(1)) : encodeURIComponent(n);

// If `url` is a packument (or single-version manifest) request for an aliased
// SOURCE package, return { targetUrl, src, remap }; otherwise null. Tarball
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
  // Lockstep rename (verbatim) vs non-lockstep drop-in (version-remapped synth).
  const remap = !NATIVE_WASM_ALIASES[src] && !!NATIVE_DROPIN_ALIASES[src];
  const dst = NATIVE_WASM_ALIASES[src] || NATIVE_DROPIN_ALIASES[src];
  if (!dst) return null;
  const newSegs = segs.slice();
  newSegs[nameIdx] = encodePkgSegment(dst);
  u.pathname = "/" + newSegs.join("/");
  return { targetUrl: u.toString(), src, remap };
}

// Rewrite a fetched (lockstep) packument JSON so the consumer sees it under
// `src` while the version tarballs still resolve to the target. Only identity
// fields are touched; per-version `dist`/deps are preserved verbatim.
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

const jsonResult = (json, status = 200, statusText = "OK") => ({
  ok: true,
  status,
  statusText,
  headers: { "content-type": "application/json" },
  body: new TextEncoder().encode(JSON.stringify(json)),
});

/**
 * Build the kernel `fetcher` callback used by the headless spikes. GET packument
 * requests for an aliased package are transparently served from the wasm drop-in;
 * everything else (tarballs, writes, non-aliased packages) is a plain fetch. Any
 * aliasing failure falls through to the un-aliased fetch so it can't make things
 * worse.
 */
export function createAliasedFetcher() {
  return async function fetcher(url, init) {
    const method = ((init && init.method) || "GET").toUpperCase();
    if (method === "GET") {
      const alias = matchPackumentAlias(url);
      if (alias) {
        try {
          if (alias.remap) {
            // Non-lockstep drop-in: fetch BOTH the source packument (version list
            // + dist-tags) and the target packument (tarball + deps), then
            // synthesize a source-named packument whose ranges resolve but whose
            // tarballs are the target's.
            const [srcRes, dstRes] = await Promise.all([
              fetch(url, { redirect: "follow", ...(init || {}) }),
              fetch(alias.targetUrl, { redirect: "follow", ...(init || {}) }),
            ]);
            if (srcRes.ok && dstRes.ok) {
              const json = synthesizeRemappedPackument(await srcRes.json(), await dstRes.json(), alias.src);
              if (json) return jsonResult(json);
            }
          } else {
            const r = await fetch(alias.targetUrl, { redirect: "follow", ...(init || {}) });
            if (r.ok) return jsonResult(rewritePackument(await r.json(), alias.src), r.status, r.statusText);
          }
        } catch {
          // Network/parse failure — fall back to the un-aliased fetch below.
        }
      }
    }
    const r = await fetch(url, { redirect: "follow", ...(init || {}) });
    const body = new Uint8Array(await r.arrayBuffer());
    const headers = {};
    r.headers.forEach((v, k) => (headers[k] = v));
    return { ok: r.ok, status: r.status, statusText: r.statusText, headers, body };
  };
}