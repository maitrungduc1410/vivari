// Preview Service Worker (brick 5).
//
// It intercepts requests under `<scope>/preview/<port>/<path>` and turns them
// into a message to the controlling page (which owns the kernel). The page runs
// the request against the virtual server process and posts the response back
// over a MessageChannel; we wrap it in a real Response for the iframe.
//
// This is how a browser tab can "visit" a server that only exists in memory,
// inside a Worker, with no network involved — exactly the StackBlitz preview
// trick.

const PREVIEW_MARKER = "/preview/";

// "Keep-prefix" ports. By default the SW strips the `/preview/<port>` proxy prefix
// before handing a request to the in-VM dev server (so a server that assumes it
// lives at `/` — Next, Vite, Express… — sees clean paths). But a *client-routed*
// SPA (Docusaurus, VitePress, Slidev…) resolves its route from the iframe's own
// `location.pathname`, which IS `/preview/<port>/…`. Serving such an app at `/`
// makes its router land on its NotFound page. The fix: configure that app's base
// (baseUrl / Vite `base`) to `/preview/<port>/` and tell the SW to NOT strip the
// prefix for that port — so the app runs consistently under the proxy path,
// deep-links resolve, and (crucially) `location.reload()` still targets a real
// preview URL. The controller pushes the current set here; we also persist it so a
// terminated-then-revived SW (which loses in-memory state) still routes correctly.
const KEEP_PREFIX_CACHE = "oc-config";
const KEEP_PREFIX_KEY = "https://oc.config/keep-prefix-ports";
let keepPrefixPorts = null; // Set<number> once loaded (null = not yet loaded)

async function loadKeepPrefixPorts() {
  if (keepPrefixPorts) return keepPrefixPorts;
  const set = new Set();
  try {
    const cache = await caches.open(KEEP_PREFIX_CACHE);
    const hit = await cache.match(KEEP_PREFIX_KEY);
    if (hit) for (const p of await hit.json()) set.add(p | 0);
  } catch (_) {
    /* no persisted config yet */
  }
  keepPrefixPorts = set;
  return set;
}

self.addEventListener("message", (event) => {
  const d = event.data;
  if (!d || d.type !== "oc-keep-prefix-ports" || !Array.isArray(d.ports)) return;
  keepPrefixPorts = new Set(d.ports.map((p) => p | 0));
  event.waitUntil(
    (async () => {
      try {
        const cache = await caches.open(KEEP_PREFIX_CACHE);
        await cache.put(KEEP_PREFIX_KEY, new Response(JSON.stringify([...keepPrefixPorts])));
      } catch (_) {
        /* best-effort persistence */
      }
    })(),
  );
});

// roadmap: Packaging Stage 2 — precache the role bundles. Every Process Worker
// spawn (and every reload) otherwise re-fetches its bundle — process-worker.js
// alone is ~900 KB. With the bundles in the Cache Storage the browser serves
// them from disk: spawns are instant and the app works offline.
//
// This is gated on a build id injected by scripts/build-demo.mjs (esbuild
// `define`). In dev (packages/demo/sw.js, loaded unbundled) the token is never
// defined, so BUILD_ID is null and ALL caching is skipped — edits keep hot-
// reloading exactly as before. `typeof` on an undeclared name is legal and
// yields "undefined", so this is safe to reference in the un-built file.
const BUILD_ID = typeof __OC_BUILD_ID__ !== "undefined" ? __OC_BUILD_ID__ : null;
const CACHE_ON = BUILD_ID !== null;
const CACHE_PREFIX = "oc-precache-";
const CACHE_NAME = CACHE_PREFIX + BUILD_ID;

// Directory this SW was served from — e.g. "/packages/demo-dist/" for the build,
// "/packages/demo/" in dev — and its parent "/packages/". The wasm binaries live
// in sibling pkg dirs under the parent; everything else (bundles, index.html,
// vendor) lives under the SW's own dir.
const SCOPE_DIR = new URL("./", self.location.href).pathname;
const PARENT_DIR = new URL("../", self.location.href).pathname;

// Precached up front on install (the expensive, frequently-spawned role bundles
// + the shell). Resolved against the SW location so it works wherever mounted.
const PRECACHE = [
  "index.html",
  "host.js",
  "kernel-worker.js",
  "process-worker.js",
  "fs-worker.js",
  "fetcher-worker.js",
  "vendor/editor/editor.js", // Monaco + xterm (4 MB) — precache so the IDE is instant + offline
  "vendor/editor/editor.css",
].map((f) => new URL(f, self.location.href).href);

// A same-origin GET we own and may serve cache-first: anything under our own dir
// (bundles, index.html, vendor/*) or a runtime wasm binary in a sibling pkg dir.
// Preview traffic never reaches here (handled earlier); this is only OUR assets.
function isOwnStatic(url) {
  const p = url.pathname;
  if (p.startsWith(SCOPE_DIR)) return true;
  if (p.startsWith(PARENT_DIR) && p.endsWith(".wasm")) return true;
  return false;
}

// Coalesce concurrent misses for the same URL: a burst of Process Worker spawns
// all requesting process-worker.js at once must trigger exactly ONE network
// fetch, not N. Keyed by URL; entry cleared when the fetch settles.
const inflight = new Map();

// Cache-first with lazy population: serve the cached copy if present, otherwise
// fetch (deduped), store the successful same-origin response, and return a fresh
// clone. Falls back to any cached copy if the network is gone (offline).
async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(request);
  if (hit) return hit;

  const key = request.url;
  let p = inflight.get(key);
  if (!p) {
    p = fetch(request)
      .then(async (resp) => {
        // Store any OK same-origin response. (We only reach here for our own
        // static assets, so there's no opaque/cross-origin case to guard.)
        if (resp && resp.ok) {
          try {
            await cache.put(request, resp.clone());
          } catch (err) {
            console.warn("[oc-sw] cache.put failed for", key, "-", err && err.message);
          }
        } else {
          console.warn("[oc-sw] not caching", key, "- status", resp && resp.status, "type", resp && resp.type);
        }
        return resp;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, p);
  }

  let resp;
  try {
    resp = await p;
  } catch (err) {
    const any = await cache.match(request);
    if (any) return any;
    throw err;
  }
  // Each awaiter needs its own readable body; the shared response is only cloned.
  return resp.clone();
}

// roadmap #19 stage C — HMR transport. A real WebSocket from the preview iframe
// would hit the network (there is no server there) and the SW can't intercept a
// ws upgrade. So we inject this classic (non-module, runs before Vite's deferred
// /@vite/client module) polyfill into every served HTML page: it replaces the
// iframe's `WebSocket` with one that tunnels each connection to the host page
// (parent.postMessage), which relays it to the kernel -> the process owning the
// preview port -> a genuine in-VM WebSocket to the dev server's HMR socket.
const WS_SHIM = `(function(){
if (window.__ocWsInstalled) return; window.__ocWsInstalled = true;
var m = location.pathname.match(/\\/preview\\/(\\d+)\\//);
var previewPort = m ? parseInt(m[1], 10) : 0;
var tok = Math.random().toString(36).slice(2, 8);
var nextId = 1, conns = {};
function post(msg){ parent.postMessage(msg, '*'); }
window.addEventListener('message', function(ev){
  var d = ev.data; if (!d || d.type !== 'oc-ws' || d.dir !== 'in') return;
  var c = conns[d.connId]; if (c) c._deliver(d);
});
window.addEventListener('pagehide', function(){
  for (var k in conns){ try { conns[k].close(1001, 'unload'); } catch(e){} }
});
function OCWebSocket(url, protocols){
  this.url = String(url); this.readyState = 0; this.protocol = ''; this.binaryType = 'blob';
  this._id = tok + '-' + (nextId++); this._l = { open:[], message:[], close:[], error:[] };
  conns[this._id] = this;
  var path = '/'; var targetPort = previewPort;
  try {
    var u = new URL(this.url, location.href);
    path = u.pathname + u.search;
    // Cross-service: a ws URL under /preview/<port>/ addresses ANOTHER in-VM
    // server (e.g. a backend on a different port), not this iframe's own dev
    // server. Route to that port and strip the proxy prefix so the server sees
    // its real path. A prefix-less ws URL routes by its explicit :port (see the
    // else-if below); a port-less one keeps the iframe's own preview port.
    var pm = u.pathname.match(/^\\/preview\\/(\\d+)(\\/.*)?$/);
    if (pm) {
      targetPort = parseInt(pm[1], 10);
      // A keep-prefix dev server (e.g. Docusaurus/VitePress with base
      // /preview/<port>/) serves its OWN HMR socket under that prefix too — keep it
      // so the server sees its real path. Only strip when tunnelling to a DIFFERENT
      // in-VM port (a genuine cross-service socket).
      if (window.__ocKeepPrefix && targetPort === previewPort) path = u.pathname + u.search;
      else path = (pm[2] || '/') + u.search;
    } else if (u.port && u.port !== location.port) {
      // An explicit ws port that isn't the studio origin's own port addresses a
      // specific in-VM listener — e.g. Vite's dedicated HMR socket (default :24678)
      // when Vite runs in middleware mode, as Nuxt/Nitro does (HTTP on :3000, HMR
      // on :24678). Without this the HMR ws tunnels to previewPort (the HTTP
      // server), which rejects the upgrade → no HMR. Route to the real port; the
      // kernel falls back to previewPort if nothing is listening there.
      targetPort = parseInt(u.port, 10);
    }
  } catch(e){}
  post({ type:'oc-ws', dir:'out', sub:'open', connId:this._id, port:targetPort, fallbackPort:previewPort, path:path, protocols: protocols || null });
}
OCWebSocket.CONNECTING = 0; OCWebSocket.OPEN = 1; OCWebSocket.CLOSING = 2; OCWebSocket.CLOSED = 3;
OCWebSocket.prototype._deliver = function(d){
  if (d.sub === 'open'){ this.readyState = 1; this.protocol = d.protocol || ''; this._emit('open', { type:'open' }); }
  else if (d.sub === 'msg'){ var data = d.data; if (d.binary && this.binaryType === 'blob' && !(data instanceof Blob)) data = new Blob([data]); this._emit('message', { type:'message', data:data }); }
  else if (d.sub === 'close'){ this.readyState = 3; delete conns[this._id]; this._emit('close', { type:'close', code:d.code||1006, reason:d.reason||'', wasClean:d.code===1000 }); }
};
OCWebSocket.prototype.send = function(data){
  if (this.readyState !== 1) throw new Error('WebSocket is not open');
  var payload = data, binary = false;
  if (typeof data !== 'string'){ binary = true;
    if (data instanceof ArrayBuffer) payload = data;
    else if (ArrayBuffer.isView(data)) payload = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    else { binary = false; payload = String(data); } }
  post({ type:'oc-ws', dir:'out', sub:'send', connId:this._id, data:payload, binary:binary });
};
OCWebSocket.prototype.close = function(code, reason){
  if (this.readyState === 3 || this.readyState === 2) return; this.readyState = 2;
  post({ type:'oc-ws', dir:'out', sub:'close', connId:this._id, code:code, reason:reason });
};
OCWebSocket.prototype.addEventListener = function(t, fn){ if (this._l[t]) this._l[t].push(fn); };
OCWebSocket.prototype.removeEventListener = function(t, fn){ var a=this._l[t]; if(a){var i=a.indexOf(fn); if(i>=0)a.splice(i,1);} };
OCWebSocket.prototype._emit = function(t, e){
  var on = this['on'+t]; if (typeof on === 'function'){ try{ on.call(this, e); }catch(x){} }
  var a = this._l[t]; if (a) for (var i=0;i<a.length;i++){ try{ a[i].call(this, e); }catch(x){} }
};
window.WebSocket = OCWebSocket;
// Next.js 16's dev "debug channel" treats a navigation whose
// PerformanceNavigationTiming reports transferSize===0 as a bfcache/HTTP-cache
// restore (wasServedFromCache). Our Service Worker proxy synthesizes every
// preview response, so the browser always reports transferSize===0 for the
// document — a false positive that makes Next try to rehydrate the debug channel
// from sessionStorage, fail (self.__next_r is random per load, so nothing is
// stored), and call location.reload() on every load → an infinite reload loop.
// Report a realistic non-zero transferSize for navigation entries so Next uses
// its live WebSocket-backed debug channel instead of the reload fallback.
try {
  var _gebt = performance.getEntriesByType.bind(performance);
  var _ge = performance.getEntries.bind(performance);
  var fixNav = function(e){
    if (!e || e.entryType !== 'navigation' || e.transferSize > 0) return e;
    return new Proxy(e, { get: function(t, p){
      if (p === 'transferSize') return ((t.encodedBodySize || 0) + 300) || 1000;
      var v = t[p]; return typeof v === 'function' ? v.bind(t) : v;
    }});
  };
  performance.getEntriesByType = function(type){ var l = _gebt(type); return type === 'navigation' ? l.map(fixNav) : l; };
  performance.getEntries = function(){ return _ge().map(fixNav); };
} catch(_){}
})();`;

// SSE transport. A streaming `text/event-stream` response can't cross the buffered
// HTTP preview proxy (the SW resolves ONE complete body, so a never-ending SSE
// response just 504s). So — exactly like the ws shim — we replace the iframe's
// `EventSource` with one that tunnels each connection to the host page
// (parent.postMessage), which relays it to the kernel -> the process owning the
// preview port -> a genuine in-VM loopback GET to the dev server's SSE endpoint.
// The raw event-stream bytes come back as {sub:'chunk'} and are parsed here into
// message/named events per the SSE spec. SSE is one-way, so there's no send() leg.
const SSE_SHIM = `(function(){
if (window.__ocSseInstalled) return; window.__ocSseInstalled = true;
var m = location.pathname.match(/\\/preview\\/(\\d+)\\//);
var previewPort = m ? parseInt(m[1], 10) : 0;
var tok = Math.random().toString(36).slice(2, 8);
var nextId = 1, conns = {};
function post(msg){ parent.postMessage(msg, '*'); }
window.addEventListener('message', function(ev){
  var d = ev.data; if (!d || d.type !== 'oc-sse' || d.dir !== 'in') return;
  var c = conns[d.connId]; if (c) c._deliver(d);
});
window.addEventListener('pagehide', function(){
  for (var k in conns){ try { conns[k].close(); } catch(e){} }
});
function OCEventSource(url, cfg){
  this.url = String(url); this.readyState = 0; this.withCredentials = !!(cfg && cfg.withCredentials);
  this.lastEventId = ''; this.onopen = null; this.onmessage = null; this.onerror = null;
  this._id = tok + '-' + (nextId++); this._l = {}; this._buf = '';
  conns[this._id] = this;
  var path = '/'; var targetPort = previewPort;
  try {
    var u = new URL(this.url, location.href);
    path = u.pathname + u.search;
    var pm = u.pathname.match(/^\\/preview\\/(\\d+)(\\/.*)?$/);
    if (pm) { targetPort = parseInt(pm[1], 10); path = (pm[2] || '/') + u.search; }
    else if (u.port && u.port !== location.port) targetPort = parseInt(u.port, 10);
  } catch(e){}
  post({ type:'oc-sse', dir:'out', sub:'open', connId:this._id, port:targetPort, fallbackPort:previewPort, path:path });
}
OCEventSource.CONNECTING = 0; OCEventSource.OPEN = 1; OCEventSource.CLOSED = 2;
OCEventSource.prototype._deliver = function(d){
  if (d.sub === 'open'){ this.readyState = 1; this._emit('open', { type:'open' }); }
  else if (d.sub === 'chunk'){ this._feed(String(d.data == null ? '' : d.data)); }
  else if (d.sub === 'close'){ if (this.readyState === 2) return; this.readyState = 2; delete conns[this._id]; this._emit('error', { type:'error' }); }
};
OCEventSource.prototype._feed = function(text){
  this._buf = (this._buf + text).replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
  var idx;
  while ((idx = this._buf.indexOf('\\n\\n')) >= 0){
    var raw = this._buf.slice(0, idx); this._buf = this._buf.slice(idx + 2);
    this._parse(raw);
  }
};
OCEventSource.prototype._parse = function(raw){
  var lines = raw.split('\\n'); var event = 'message', data = [], id = null;
  for (var i=0;i<lines.length;i++){
    var line = lines[i]; if (line === '' || line.charAt(0) === ':') continue;
    var c = line.indexOf(':'); var field = c === -1 ? line : line.slice(0, c);
    var value = c === -1 ? '' : line.slice(c + 1); if (value.charAt(0) === ' ') value = value.slice(1);
    if (field === 'event') event = value; else if (field === 'data') data.push(value); else if (field === 'id') id = value;
  }
  if (id !== null) this.lastEventId = id;
  if (data.length === 0) return;
  this._emit(event, { type:event, data:data.join('\\n'), lastEventId:this.lastEventId, origin:location.origin });
};
OCEventSource.prototype.close = function(){
  if (this.readyState === 2) return; this.readyState = 2; delete conns[this._id];
  post({ type:'oc-sse', dir:'out', sub:'close', connId:this._id });
};
OCEventSource.prototype.addEventListener = function(t, fn){ (this._l[t] || (this._l[t] = [])).push(fn); };
OCEventSource.prototype.removeEventListener = function(t, fn){ var a=this._l[t]; if(a){var i=a.indexOf(fn); if(i>=0)a.splice(i,1);} };
OCEventSource.prototype._emit = function(t, e){
  var on = this['on'+t]; if (typeof on === 'function'){ try{ on.call(this, e); }catch(x){} }
  var a = this._l[t]; if (a) for (var i=0;i<a.length;i++){ try{ a[i].call(this, e); }catch(x){} }
};
window.EventSource = OCEventSource;
})();`;

// In-browser DevTools bridge. Injected into every preview page next to the WS
// shim. It (1) loads chobitsu — the CDP backend — as a classic script so it hooks
// console/network before the app's module scripts run, (2) tunnels CDP messages
// between chobitsu and the chii DevTools frontend (which lives in a sibling iframe
// on the host page; the host relays by window.postMessage), and (3) reports every
// SPA/MPA navigation up to the host so the preview address bar stays in sync.
//
// Protocol on the host page:
//   preview → host : { source:'oc-cdp', dir:'target',   data:<cdp json string> }
//                     { source:'oc-nav', href:<path>                          }
//   host  → preview: { source:'oc-cdp', dir:'frontend', data:<cdp json string> }  (forward to chobitsu)
//                     { source:'oc-cdp', dir:'init'                            }  (run the attach handshake)
const CDP_BOOTSTRAP = `(function(){
if (window.__ocCdpInstalled) return; window.__ocCdpInstalled = true;
function post(m){ parent.postMessage(m, '*'); }
var seq = 0;
function setup(){
  if (!window.chobitsu) return false;
  window.chobitsu.setOnMessage(function(msg){
    // Drop responses to our own internal enable requests (ids prefixed 'ocdt');
    // pass through events and responses the frontend actually asked for.
    if (typeof msg === 'string' && msg.indexOf('"id":"ocdt') !== -1) return;
    post({ source:'oc-cdp', dir:'target', data: msg });
  });
  return true;
}
if (!setup()) { var tries = 0, iv = setInterval(function(){ if (setup() || ++tries > 100) clearInterval(iv); }, 20); }
function sendToChobitsu(method){ if (window.chobitsu) window.chobitsu.sendRawMessage(JSON.stringify({ id:'ocdt'+(++seq), method:method, params:{} })); }
function sendToDevtools(msg){ post({ source:'oc-cdp', dir:'target', data: JSON.stringify(msg) }); }
function init(){
  sendToDevtools({ method:'Page.frameNavigated', params:{ frame:{ id:'1', mimeType:'text/html', securityOrigin: location.origin, url: location.href }, type:'Navigation' } });
  sendToChobitsu('Network.enable');
  sendToDevtools({ method:'Runtime.executionContextsCleared' });
  sendToChobitsu('Runtime.enable');
  sendToChobitsu('Debugger.enable');
  sendToChobitsu('DOMStorage.enable');
  sendToChobitsu('DOM.enable');
  sendToChobitsu('CSS.enable');
  sendToChobitsu('Overlay.enable');
  sendToDevtools({ method:'DOM.documentUpdated' });
}
window.addEventListener('message', function(ev){
  var d = ev.data;
  if (!d || d.source !== 'oc-cdp') return;
  if (d.dir === 'frontend') { if (window.chobitsu) window.chobitsu.sendRawMessage(d.data); }
  else if (d.dir === 'init') { init(); }
});
function notifyNav(){ post({ source:'oc-nav', href: location.pathname + location.search + location.hash }); }
var _ps = history.pushState, _rs = history.replaceState;
history.pushState = function(){ var r = _ps.apply(this, arguments); notifyNav(); return r; };
history.replaceState = function(){ var r = _rs.apply(this, arguments); notifyNav(); return r; };
window.addEventListener('popstate', notifyNav);
window.addEventListener('hashchange', notifyNav);
window.addEventListener('load', notifyNav);
notifyNav();
})();`;

const DEVTOOLS_TAGS =
  '<script src="/oc-devtools/chobitsu.js"><\/script>' + "<script>" + CDP_BOOTSTRAP + "<\/script>";

// Insert the shim as the first child of <head> (so it runs before any script).
// The WS shim runs first (inline), then chobitsu (classic src → executes before
// the app's deferred module scripts), then the CDP bootstrap.
function injectWsShim(html, keepPrefix) {
  // For keep-prefix ports, tell the injected WS shim (and any app code that cares)
  // that this document lives under its real base — so its own HMR socket path is
  // left prefixed rather than stripped.
  const flag = keepPrefix ? "<script>window.__ocKeepPrefix=true;<\/script>" : "";
  const tag = flag + "<script>" + WS_SHIM + "<\/script><script>" + SSE_SHIM + "<\/script>" + DEVTOOLS_TAGS;
  const headOpen = /<head[^>]*>/i.exec(html);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  const htmlOpen = /<html[^>]*>/i.exec(html);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return html.slice(0, at) + tag + html.slice(at);
  }
  return tag + html;
}

self.addEventListener("install", (event) => {
  self.skipWaiting();
  if (CACHE_ON) event.waitUntil(precache());
});

// Best-effort, per-URL precache: unlike cache.addAll (atomic — one 404 discards
// the whole batch), this stores whatever succeeds and logs the rest, so a stray
// missing asset can't leave the cache empty (which would make every spawn miss).
// Entries already present are left untouched: the cache is keyed by build id, so
// a still-cached asset is byte-identical — no need to refetch. That keeps SW
// reinstalls (e.g. DevTools "Update on reload", which re-runs install on every
// navigation) free instead of re-downloading ~1 MB of bundles each time.
async function precache() {
  const cache = await caches.open(CACHE_NAME);
  let fetched = 0;
  let kept = 0;
  let failed = 0;
  await Promise.all(
    PRECACHE.map(async (url) => {
      if (await cache.match(url)) {
        kept++;
        return;
      }
      try {
        const resp = await fetch(url, { cache: "reload" });
        if (!resp.ok) throw new Error("status " + resp.status);
        await cache.put(url, resp.clone());
        fetched++;
      } catch (err) {
        failed++;
        console.warn("[oc-sw] precache miss:", url, "-", err && err.message);
      }
    }),
  );
  if (fetched || failed) {
    console.log(`[oc-sw] precache ${CACHE_NAME}: ${fetched} fetched, ${kept} cached, ${failed} failed`);
  }
}

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop caches from previous builds (each build id gets its own cache, so a
      // redeploy invalidates cleanly — no stale bundles served forever).
      if (CACHE_ON) {
        const keys = await caches.keys();
        await Promise.all(
          keys.filter((k) => k.startsWith(CACHE_PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k)),
        );
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // never touch cross-origin

  const idx = url.pathname.indexOf(PREVIEW_MARKER);
  if (idx !== -1) {
    // Explicit preview URL: <scope>/preview/<port>/<path> — the iframe navigation
    // and any *relative* subresource resolve here.
    const rest = url.pathname.slice(idx + PREVIEW_MARKER.length);
    const slash = rest.indexOf("/");
    const port = parseInt(slash === -1 ? rest : rest.slice(0, slash), 10);
    const stripped = (slash === -1 ? "/" : rest.slice(slash)) + url.search;
    const full = url.pathname + url.search;
    // Keep-prefix ports serve UNDER /preview/<port>/ (see loadKeepPrefixPorts);
    // everyone else gets the prefix stripped as before.
    event.respondWith(
      loadKeepPrefixPorts().then((keep) =>
        handlePreview(event, port, keep.has(port) ? full : stripped, keep.has(port)),
      ),
    );
    return;
  }

  // Our own bundles/wasm/shell: serve from the precache (instant, offline). Only
  // in the built demo (CACHE_ON); dev stays on the network so edits reload.
  if (CACHE_ON && event.request.method === "GET" && isOwnStatic(url)) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // The vendored DevTools CDP backend (chobitsu). A preview page loads it via an
  // absolute /oc-devtools/... URL, so without this exception routeByClient would
  // proxy it into the VM (which has no such file). It's always OUR app asset —
  // let it hit the network (served same-origin by the serveDevtools Vite plugin).
  if (url.pathname.startsWith("/oc-devtools/")) return;

  // The vendored DevTools frontend (chii): the host document itself and all of
  // its module assets. These are OUR app files (served same-origin by the
  // serveDevtools Vite plugin), never anything in the VM. Pass them straight to
  // the network — routing them through routeByClient risks a spurious
  // `fetch(event.request)` failure on the iframe navigation and, worse, could
  // proxy them into a preview that has no such file.
  if (url.pathname === "/devtools-host.html" || url.pathname.startsWith("/devtools/")) return;

  // Our own vendored assets (the real-npm delivery pack, editor bundles). These
  // are same-origin OUR files and must hit the network directly — routing them
  // through routeByClient fails under cross-origin isolation (a spurious
  // `fetch(event.request)` failure), exactly like /oc-devtools/ + /packages/.
  // The kernel worker fetches /vendor/npm-pack.bin here; without this bypass it
  // gets "Failed to fetch" and falls back to the built-in npm.
  if (url.pathname.startsWith("/vendor/")) return;

  // Root-absolute request (e.g. Vite's /@vite/client, /src/main.js,
  // /node_modules/...). It only belongs to a preview if a preview iframe issued
  // it; the demo's own files live under /packages/ and go straight to network.
  if (url.pathname.startsWith("/packages/")) return;

  // A top-level navigation that reached here is NOT a preview (preview navigations
  // match the PREVIEW_MARKER branch above). It is the studio app's own document —
  // never proxy it: let the browser fetch it from the network so it loads even
  // when this SW controls the client. Proxying it means routeByClient can't yet
  // identify the (not-yet-existing) resulting client, so the SW ends up owning a
  // response that never settles and the page hangs forever ("keeps loading" on
  // every load where the SW is already in control). Preview *subresources* aren't
  // navigations, so they still flow through routeByClient below.
  if (event.request.mode === "navigate") return;

  event.respondWith(routeByClient(event, url));
});

// Resolve a root-absolute request to its in-VM port by inspecting the client
// (the iframe document) that issued it — its URL carries /preview/<port>/. If it
// isn't from a preview iframe, pass the request through to the network unchanged.
async function routeByClient(event, url) {
  const id = event.clientId || event.resultingClientId;
  let clientUrl = "";
  if (id) {
    const client = await self.clients.get(id);
    if (client) clientUrl = client.url;
  }
  const m = clientUrl.match(/\/preview\/(\d+)\//);
  if (!m) return fetch(event.request);
  return handlePreview(event, parseInt(m[1], 10), url.pathname + url.search);
}

async function handlePreview(event, port, path, keepPrefix) {
  if (!Number.isInteger(port)) {
    return new Response("Bad preview URL\n", { status: 400 });
  }

  // Find the page that hosts the kernel (any window client that is not itself a
  // preview frame). We include uncontrolled clients so this works on first load.
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const kernelClient =
    clients.find((c) => !c.url.includes(PREVIEW_MARKER)) || clients[0];
  if (!kernelClient) {
    return new Response("OpenContainer kernel is not running\n", { status: 503 });
  }

  let body = "";
  const method = event.request.method;
  if (method !== "GET" && method !== "HEAD") {
    try {
      body = await event.request.text();
    } catch {
      body = "";
    }
  }
  const headers = {};
  for (const [k, v] of event.request.headers) headers[k] = v;

  const req = { port, method, url: path, headers, body };

  const resp = await new Promise((resolve) => {
    const mc = new MessageChannel();
    // Dev servers do slow work on first hit (e.g. Vite optimizeDeps / on-demand
    // transform), so allow more headroom than a plain static preview.
    const timer = setTimeout(
      () => resolve({ status: 504, headers: {}, body: "Preview timed out\n" }),
      60000,
    );
    mc.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve(e.data);
    };
    kernelClient.postMessage({ type: "oc-http", req }, [mc.port2]);
  });

  const respHeaders = new Headers(resp.headers || {});
  // Same-origin preview docs are allowed under COEP:require-corp, but be explicit
  // so nested subresources embed cleanly in the cross-origin-isolated top page.
  respHeaders.set("Cross-Origin-Resource-Policy", "same-origin");
  respHeaders.set("Cross-Origin-Embedder-Policy", "require-corp");
  if (!respHeaders.has("content-type")) respHeaders.set("content-type", "text/html; charset=utf-8");

  // Binary responses (images/fonts/wasm from the dev server) cross the kernel
  // JSON boundary base64-encoded; rebuild the exact bytes here.
  let outBody = resp.body ?? "";
  if (resp.bodyEncoding === "base64" && typeof resp.body === "string") {
    const bin = atob(resp.body);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    outBody = bytes;
  } else if (typeof outBody === "string" && (respHeaders.get("content-type") || "").includes("text/html")) {
    // roadmap #19 stage C: install the ws tunnel polyfill before /@vite/client.
    outBody = injectWsShim(outBody, keepPrefix);
    respHeaders.delete("content-length"); // body grew; let the browser recompute
  }

  return new Response(outBody, { status: resp.status || 200, headers: respHeaders });
}
