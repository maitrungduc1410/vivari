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

// Mode C (wildcard per-port origin): when this SW is served on a preview host
// like `<token>--<port>.<domain>` the target port is encoded in the HOSTNAME (one
// origin per port), not in a `/preview/<port>/` PATH. An optional `-<tag>` may
// follow the port (see BootOptions.previewWildcardTag) for deploys that share the
// base domain with other apps; it is a SUFFIX because Cloudflare routes only allow
// the `*` wildcard at the START of the hostname. Detect the port once at SW
// startup; when set, every request on this origin proxies to WILDCARD_PORT and the
// path-based routing below is bypassed. On the IDE origin (modes A/B) the hostname
// doesn't match, so WILDCARD_MODE is false and nothing changes.
const WILDCARD_HOST = self.location.hostname.match(/^[a-z0-9]+--(\d+)(?:-[a-z0-9]+)?\./i);
const WILDCARD_PORT = WILDCARD_HOST ? parseInt(WILDCARD_HOST[1], 10) : 0;
const WILDCARD_MODE = WILDCARD_PORT > 0;

// Client ids of pages that host a Vivari kernel (announced via `vv-kernel-host`;
// see bridge.registerServiceWorker). handlePreview routes each preview HTTP
// request to one of these — NOT simply the top-level window — because Vivari can
// run inside an iframe (e.g. the docs /embed/ playground). There the top-level
// window is the host doc, which has no kernel; posting the request to it would
// hang. In-memory only: if the SW is revived and this is empty, handlePreview
// falls back to the top-level heuristic (and the host re-announces on each
// server `listen`, i.e. right before a preview loads).
const kernelHostIds = new Set();

// Mode B (separate preview origin): a persistent MessagePort to the IDE, handed
// to us (via the hidden __vv-bridge.html client) on `vv-connect`. When set, we
// route preview HTTP + ws/SSE over it instead of `findKernelClient()` (which
// only sees same-origin windows and so can't reach a cross-origin IDE). Lost
// when the SW is evicted → re-established via a `vv-need-connect` handshake.
let kernelPort = null;

// "Keep-prefix" ports. By default the SW strips the `/preview/<port>` proxy prefix
// before handing a request to the in-VM dev server (so a server that assumes it
// lives at `/` — Next, Vite, Express… — sees clean paths). But a *client-routed*
// SPA (Docusaurus, Slidev…) resolves its route from the iframe's own
// `location.pathname`, which IS `/preview/<port>/…`. Serving such an app at `/`
// makes its router land on its NotFound page. The fix: configure that app's base
// (baseUrl / Vite `base`) to `/preview/<port>/` and tell the SW to NOT strip the
// prefix for that port — so the app runs consistently under the proxy path,
// deep-links resolve, and (crucially) `location.reload()` still targets a real
// preview URL. The controller pushes the current set here; we also persist it so a
// terminated-then-revived SW (which loses in-memory state) still routes correctly.
const KEEP_PREFIX_CACHE = "vv-config";
const KEEP_PREFIX_KEY = "https://vv.config/keep-prefix-ports";
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

// Whether to inject Vivari's in-preview DevTools backend (chobitsu + the CDP
// bootstrap; see DEVTOOLS_TAGS) into every preview page. Default ON so the studio
// — which never sends the toggle — behaves exactly as before. The @vivari/core SDK
// ships this same sw.js and calls `setDevtoolsEnabled(false)` (via Vivari.boot) so
// standalone embedders who don't host `/vv-devtools/chobitsu.js` get clean previews
// with no 404. Persisted (like keep-prefix) so a revived SW keeps the setting.
const DEVTOOLS_KEY = "https://vv.config/devtools";
let devtoolsEnabled = null; // boolean once loaded (null = not yet loaded)

async function loadDevtoolsEnabled() {
  if (devtoolsEnabled !== null) return devtoolsEnabled;
  let enabled = true; // default ON when nothing has been persisted
  try {
    const cache = await caches.open(KEEP_PREFIX_CACHE);
    const hit = await cache.match(DEVTOOLS_KEY);
    if (hit) enabled = !!(await hit.json());
  } catch (_) {
    /* no persisted config yet */
  }
  devtoolsEnabled = enabled;
  return enabled;
}

// Persist + apply the keep-prefix port set (see setKeepPrefixPorts). `waitUntil`
// is passed for `ExtendableEvent`-sourced calls (the global message listener);
// MessagePort-sourced calls (mode B) fire-and-forget the persistence promise.
function applyKeepPrefix(ports, waitUntil) {
  keepPrefixPorts = new Set(ports.map((p) => p | 0));
  const persist = (async () => {
    try {
      const cache = await caches.open(KEEP_PREFIX_CACHE);
      await cache.put(KEEP_PREFIX_KEY, new Response(JSON.stringify([...keepPrefixPorts])));
    } catch (_) {
      /* best-effort persistence */
    }
  })();
  if (waitUntil) waitUntil(persist);
}

// Persist + apply the DevTools-injection toggle (see loadDevtoolsEnabled).
function applyDevtools(enabled, waitUntil) {
  devtoolsEnabled = enabled;
  const persist = (async () => {
    try {
      const cache = await caches.open(KEEP_PREFIX_CACHE);
      await cache.put(DEVTOOLS_KEY, new Response(JSON.stringify(devtoolsEnabled)));
    } catch (_) {
      /* best-effort persistence */
    }
  })();
  if (waitUntil) waitUntil(persist);
}

// dir:'in' (kernel → tabs): broadcast an inbound ws/SSE frame to every TOP-LEVEL
// preview client (in-app iframes get theirs via parent.postMessage, no dupes).
function broadcastInboundFrame(d) {
  return self.clients.matchAll({ type: "window" }).then((cs) => {
    for (const c of cs) {
      // Mode C: this origin serves a single port, so every top-level client here
      // IS a preview (no /preview/ marker in the URL). Mode A/B: match the marker.
      if (c.frameType === "top-level" && (WILDCARD_MODE || c.url.includes(PREVIEW_MARKER))) {
        c.postMessage(d);
      }
    }
  });
}

// dir:'out' (tab → kernel): forward an outbound ws/SSE frame to the kernel — over
// the persistent port in mode B, else to the same-origin kernel-host client.
function forwardOutboundFrame(d) {
  if (kernelPort) {
    kernelPort.postMessage(d);
    return Promise.resolve();
  }
  return findKernelClient().then((k) => {
    if (k) k.postMessage(d);
  });
}

// Messages the IDE sends us over the mode-B persistent port. Mirror of the
// same-origin config/relay branches in the global `message` listener.
function onKernelPortMessage(event) {
  const d = event.data;
  if (!d) return;
  if (d.type === "vv-keep-prefix-ports" && Array.isArray(d.ports)) {
    applyKeepPrefix(d.ports);
    return;
  }
  if (d.type === "vv-devtools" && typeof d.enabled === "boolean") {
    applyDevtools(d.enabled);
    return;
  }
  if ((d.type === "vv-ws" || d.type === "vv-sse") && d.dir === "in") {
    broadcastInboundFrame(d);
  }
}

self.addEventListener("message", (event) => {
  const d = event.data;
  // Mode B handshake: the bridge doc (on our origin) relays the IDE's port to us.
  // Keep it and route preview HTTP + tunnel traffic over it from now on.
  if (d && d.type === "vv-connect") {
    kernelPort = (event.ports && event.ports[0]) || null;
    if (kernelPort) kernelPort.onmessage = onKernelPortMessage;
    return;
  }
  // A page announcing it hosts a Vivari kernel — remember its client id so
  // handlePreview routes preview HTTP to it even when it's a nested iframe.
  if (d && d.type === "vv-kernel-host") {
    if (event.source && event.source.id) kernelHostIds.add(event.source.id);
    return;
  }
  if (d && d.type === "vv-keep-prefix-ports" && Array.isArray(d.ports)) {
    applyKeepPrefix(d.ports, (p) => event.waitUntil(p));
    return;
  }
  // Toggle the in-preview DevTools backend injection (see loadDevtoolsEnabled).
  if (d && d.type === "vv-devtools" && typeof d.enabled === "boolean") {
    applyDevtools(d.enabled, (p) => event.waitUntil(p));
    return;
  }
  // ws/SSE tunnel relay for a preview opened in its OWN top-level tab. In the studio
  // the preview is an iframe that postMessages its parent directly; but a standalone
  // tab ("Open in new tab") lives in a separate browsing-context group where
  // COOP:same-origin severs window.opener, so it can't reach the studio window. The
  // SW is shared across the origin (exactly how the HTTP preview proxy reaches the
  // studio's kernel client cross-tab), so relay the tunnel through it:
  //   dir:'out' (tab → kernel): forward to the kernel (port in mode B, else client).
  //   dir:'in'  (kernel → tabs): broadcast to every TOP-LEVEL preview client.
  if (d && (d.type === "vv-ws" || d.type === "vv-sse")) {
    if (d.dir === "out") {
      event.waitUntil(forwardOutboundFrame(d));
    } else if (d.dir === "in") {
      event.waitUntil(broadcastInboundFrame(d));
    }
    return;
  }
});

// Choose how to reach the kernel for a preview request. Mode B routes over the
// persistent port (`cross: true` → cross-origin response headers); mode A picks
// the same-origin kernel-host window client. In mode B after an SW eviction the
// port is gone: detect the bridge client, ask the IDE to re-hand a port, and wait
// briefly for it before giving up. Does a single matchAll to stay cheap in mode A.
async function resolveKernelSink() {
  if (kernelPort) return { post: (m, t) => kernelPort.postMessage(m, t || []), cross: true };
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  // Match both `/__vv-bridge.html` and the Cloudflare clean-URL form `/__vv-bridge`.
  const bridge = clients.find((c) => c.url.includes("/__vv-bridge"));
  if (bridge) {
    // Mode B, revived SW: request a fresh port and wait up to ~2s for it.
    bridge.postMessage({ type: "vv-need-connect" });
    for (let i = 0; i < 40 && !kernelPort; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (kernelPort) return { post: (m, t) => kernelPort.postMessage(m, t || []), cross: true };
    return null;
  }
  const client = pickKernelClient(clients);
  return client ? { post: (m, t) => client.postMessage(m, t || []), cross: false } : null;
}

// The window that hosts the kernel — a non-preview, non-DevTools, non-bridge
// window (preferring one that announced itself via vv-kernel-host so an EMBEDDED
// Vivari, whose kernel is in a nested frame, still resolves). Used to route both
// preview HTTP and the standalone-tab ws/SSE tunnel to the running kernel.
//
// Returns null when NO plausible kernel window exists. This is critical on a
// mode-B *preview origin*, where every window client is itself a preview / bridge
// / boot page and the real kernel is only reachable via the persistent port: we
// must NOT fall back to "any client" (that would post the request to the preview
// tab itself → nobody answers → "Preview timed out"). Returning null lets the
// caller show the friendly "connecting…" page instead.
function pickKernelClient(clients) {
  const isPreview = (c) => c.url.includes(PREVIEW_MARKER);
  const isDevtools = (c) => c.url.includes("/devtools-host.html") || c.url.includes("/devtools/");
  const isBridge = (c) => c.url.includes("/__vv-bridge") || c.url.includes("/__vv-preview-boot");
  const ok = (c) => !isPreview(c) && !isDevtools(c) && !isBridge(c);
  return (
    clients.find((c) => kernelHostIds.has(c.id) && ok(c)) ||
    clients.find((c) => c.frameType === "top-level" && ok(c)) ||
    clients.find(ok) ||
    null
  );
}

async function findKernelClient() {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return pickKernelClient(clients);
}

// roadmap: Packaging Stage 2 — precache the role bundles. Every Process Worker
// spawn (and every reload) otherwise re-fetches its bundle — process-worker.js
// alone is ~900 KB. With the bundles in the Cache Storage the browser serves
// them from disk: spawns are instant and the app works offline.
//
// This is gated on a build id (`__VV_BUILD_ID__`, a build-time `define`). It is
// currently never defined in the studio build, so BUILD_ID is null and ALL
// caching is skipped — edits keep hot-
// reloading exactly as before. `typeof` on an undeclared name is legal and
// yields "undefined", so this is safe to reference in the un-built file.
const BUILD_ID = typeof __VV_BUILD_ID__ !== "undefined" ? __VV_BUILD_ID__ : null;
const CACHE_ON = BUILD_ID !== null;
const CACHE_PREFIX = "vv-precache-";
const CACHE_NAME = CACHE_PREFIX + BUILD_ID;

// Directory this SW was served from (the studio origin root) — and its parent.
// The wasm binaries live in sibling pkg dirs under the parent; everything else
// (bundles, index.html) lives under the SW's own dir.
const SCOPE_DIR = new URL("./", self.location.href).pathname;
const PARENT_DIR = new URL("../", self.location.href).pathname;

// Precached up front on install (the expensive, frequently-spawned role bundles
// + the shell). Resolved against the SW location so it works wherever mounted.
const PRECACHE = [
  "index.html",
  "kernel-worker.js",
  "process-worker.js",
  "fs-worker.js",
  "fetcher-worker.js",
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
            console.warn("[vv-sw] cache.put failed for", key, "-", err && err.message);
          }
        } else {
          console.warn("[vv-sw] not caching", key, "- status", resp && resp.status, "type", resp && resp.type);
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

// DevTools Network bridge for the shims. The ws/SSE polyfills below replace the
// native `WebSocket`/`EventSource` globals BEFORE chobitsu loads and tunnel over
// postMessage, so chobitsu never observes them and they never appear in the chii
// Network panel (fetch/XHR stay native, so chobitsu already captures those). This
// tiny helper lets the shims emit synthetic Chrome DevTools Protocol `Network.*`
// events over the SAME channel the CDP bootstrap uses ({source:'vv-cdp',
// dir:'target'}); the controller already relays those to the attached frontend,
// which renders a WS Messages tab and an EventSource EventStream tab natively.
//
// `emit` is gated on attachment (no work while DevTools is closed). Each live
// connection registers a `replay` fn re-emitting its creation events, invoked on
// attach (or re-attach on tab switch) so a connection opened before the panel —
// or before switching to this tab — still shows up (its future frames then stream
// live; frames from before attach are dropped, matching real DevTools behaviour).
// Report the preview document's real `document.title` up to the host page so the
// preview tab strip can show it (with an ellipsis + hover tooltip) instead of a
// bare "Preview (<port>)". Always injected (unlike the vv-nav address-bar sync,
// which rides in the opt-in CDP bootstrap): the title is fetched on load and
// re-posted whenever the app rewrites <title> (SPA routers, react-helmet, etc.).
const TITLE_SHIM = `(function(){
if (window.__vvTitleInstalled) return; window.__vvTitleInstalled = true;
var last = null;
function send(){
  var t = document.title || "";
  if (t === last) return;
  last = t;
  try { parent.postMessage({ source:'vv-title', title: t }, '*'); } catch(e){}
}
function observe(){
  // <title> lives in <head>; watch it (and any added/removed title node) for
  // changes, then push the current value.
  try { if (document.head) new MutationObserver(send).observe(document.head, { childList:true, subtree:true, characterData:true }); } catch(e){}
  send();
}
if (document.head) observe();
else document.addEventListener('DOMContentLoaded', observe);
window.addEventListener('load', send);
})();`;

const NET_SHIM = `(function(){
if (window.__vvNet) return;
var attached = false, gen = 0, live = {};
function post(method, params){
  try { parent.postMessage({ source:'vv-cdp', dir:'target', data: JSON.stringify({ method: method, params: params }) }, '*'); } catch(e){}
}
// Announce a connection's creation events at most ONCE per generation. A new
// generation begins on each (re)attach (onAttach); the DevTools frontend clears
// its network log on the frameNavigated that init() sends, so one announce per
// generation = exactly one row per connection (no duplicate from the live-emit +
// replay-on-attach paths both firing).
function announce(id){ var o = live[id]; if (!o || o.gen === gen) return; o.gen = gen; try { o.replay(); } catch(e){} }
window.__vvNet = {
  now: function(){ return performance.now() / 1000; },
  wall: function(){ return Date.now() / 1000; },
  emit: function(method, params){ if (attached) post(method, params); },
  register: function(id, replay){ live[id] = { replay: replay, gen: -1 }; if (attached) announce(id); },
  unregister: function(id){ delete live[id]; },
  onAttach: function(){ attached = true; gen++; for (var k in live){ announce(k); } }
};
})();`;

// roadmap #19 stage C — HMR transport. A real WebSocket from the preview iframe
// would hit the network (there is no server there) and the SW can't intercept a
// ws upgrade. So we inject this classic (non-module, runs before Vite's deferred
// /@vite/client module) polyfill into every served HTML page: it replaces the
// iframe's `WebSocket` with one that tunnels each connection to the host page
// (parent.postMessage), which relays it to the kernel -> the process owning the
// preview port -> a genuine in-VM WebSocket to the dev server's HMR socket.
const WS_SHIM = `(function(){
if (window.__vvWsInstalled) return; window.__vvWsInstalled = true;
var hm = location.hostname.match(/^[a-z0-9]+--(\\d+)-vv\\./i);
var m = location.pathname.match(/\\/preview\\/(\\d+)\\//);
var previewPort = hm ? parseInt(hm[1], 10) : (m ? parseInt(m[1], 10) : 0);
var tok = Math.random().toString(36).slice(2, 8);
var nextId = 1, conns = {};
// The preview relays connection frames to the window that talks to the kernel: our
// parent when embedded in the studio iframe. "Open in new tab" makes this a
// TOP-LEVEL document — and the studio's COOP:same-origin severs window.opener — so
// there is no host window to postMessage. Fall back to the Service Worker, which is
// shared across browsing-context groups (exactly how the HTTP preview proxy reaches
// the studio's kernel client cross-tab); the studio relays inbound frames back the
// same way. Listen on BOTH channels so either transport delivers.
var vvHost = (window.parent && window.parent !== window) ? window.parent : null;
function post(msg){
  if (vvHost) { try { vvHost.postMessage(msg, '*'); return; } catch(e){} }
  try { var sw = navigator.serviceWorker && navigator.serviceWorker.controller; if (sw) sw.postMessage(msg); } catch(e){}
}
function _b64(x){
  var b;
  if (x instanceof ArrayBuffer) b = new Uint8Array(x);
  else if (ArrayBuffer.isView(x)) b = new Uint8Array(x.buffer, x.byteOffset, x.byteLength);
  else return '';
  var s = ''; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  try { return btoa(s); } catch(e){ return ''; }
}
function _onIn(ev){
  var d = ev.data; if (!d || d.type !== 'vv-ws' || d.dir !== 'in') return;
  var c = conns[d.connId]; if (c) c._deliver(d);
}
window.addEventListener('message', _onIn);
if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', _onIn);
window.addEventListener('pagehide', function(){
  for (var k in conns){ try { conns[k].close(1001, 'unload'); } catch(e){} }
});
function VVWebSocket(url, protocols){
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
      // A keep-prefix dev server (e.g. Docusaurus with base
      // /preview/<port>/) serves its OWN HMR socket under that prefix too — keep it
      // so the server sees its real path. Only strip when tunnelling to a DIFFERENT
      // in-VM port (a genuine cross-service socket).
      if (window.__vvKeepPrefix && targetPort === previewPort) path = u.pathname + u.search;
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
  post({ type:'vv-ws', dir:'out', sub:'open', connId:this._id, port:targetPort, fallbackPort:previewPort, path:path, protocols: protocols || null });
  // DevTools display URL: the real in-VM destination (localhost:<targetPort><path>),
  // NOT the studio-origin proxy URL the app resolved against (which carries the
  // internal /preview/<port>/ prefix and is confusing in the Network panel).
  var self2 = this; this._rid = this._id;
  this._cdpUrl = (/^wss:/i.test(this.url) ? 'wss' : 'ws') + '://localhost:' + targetPort + path;
  this._wsReplay = function(){
    window.__vvNet.emit('Network.webSocketCreated', { requestId:self2._rid, url:self2._cdpUrl, initiator:{ type:'script' } });
    window.__vvNet.emit('Network.webSocketWillSendHandshakeRequest', { requestId:self2._rid, timestamp:window.__vvNet.now(), wallTime:window.__vvNet.wall(), request:{ headers:{} } });
    if (self2.readyState === 1) window.__vvNet.emit('Network.webSocketHandshakeResponseReceived', { requestId:self2._rid, timestamp:window.__vvNet.now(), response:{ status:101, statusText:'Switching Protocols', headers:{} } });
  };
  window.__vvNet.register(this._rid, this._wsReplay);
}
VVWebSocket.CONNECTING = 0; VVWebSocket.OPEN = 1; VVWebSocket.CLOSING = 2; VVWebSocket.CLOSED = 3;
VVWebSocket.prototype._deliver = function(d){
  if (d.sub === 'open'){ this.readyState = 1; this.protocol = d.protocol || '';
    window.__vvNet.emit('Network.webSocketHandshakeResponseReceived', { requestId:this._rid, timestamp:window.__vvNet.now(), response:{ status:101, statusText:'Switching Protocols', headers:{} } });
    this._emit('open', { type:'open' }); }
  else if (d.sub === 'msg'){ var data = d.data;
    window.__vvNet.emit('Network.webSocketFrameReceived', { requestId:this._rid, timestamp:window.__vvNet.now(), response:{ opcode: d.binary?2:1, mask:false, payloadData: d.binary ? _b64(d.data) : String(d.data) } });
    if (d.binary && this.binaryType === 'blob' && !(data instanceof Blob)) data = new Blob([data]); this._emit('message', { type:'message', data:data }); }
  else if (d.sub === 'close'){ this.readyState = 3; delete conns[this._id];
    if (!this._cdpClosed){ this._cdpClosed = true; window.__vvNet.emit('Network.webSocketClosed', { requestId:this._rid, timestamp:window.__vvNet.now() }); window.__vvNet.unregister(this._rid); }
    this._emit('close', { type:'close', code:d.code||1006, reason:d.reason||'', wasClean:d.code===1000 }); }
};
VVWebSocket.prototype.send = function(data){
  if (this.readyState !== 1) throw new Error('WebSocket is not open');
  var payload = data, binary = false;
  if (typeof data !== 'string'){ binary = true;
    if (data instanceof ArrayBuffer) payload = data;
    else if (ArrayBuffer.isView(data)) payload = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    else { binary = false; payload = String(data); } }
  post({ type:'vv-ws', dir:'out', sub:'send', connId:this._id, data:payload, binary:binary });
  window.__vvNet.emit('Network.webSocketFrameSent', { requestId:this._rid, timestamp:window.__vvNet.now(), response:{ opcode: binary?2:1, mask:true, payloadData: binary ? _b64(payload) : String(payload) } });
};
VVWebSocket.prototype.close = function(code, reason){
  if (this.readyState === 3 || this.readyState === 2) return; this.readyState = 2;
  if (!this._cdpClosed){ this._cdpClosed = true; window.__vvNet.emit('Network.webSocketClosed', { requestId:this._rid, timestamp:window.__vvNet.now() }); window.__vvNet.unregister(this._rid); }
  post({ type:'vv-ws', dir:'out', sub:'close', connId:this._id, code:code, reason:reason });
};
VVWebSocket.prototype.addEventListener = function(t, fn){ if (this._l[t]) this._l[t].push(fn); };
VVWebSocket.prototype.removeEventListener = function(t, fn){ var a=this._l[t]; if(a){var i=a.indexOf(fn); if(i>=0)a.splice(i,1);} };
VVWebSocket.prototype._emit = function(t, e){
  var on = this['on'+t]; if (typeof on === 'function'){ try{ on.call(this, e); }catch(x){} }
  var a = this._l[t]; if (a) for (var i=0;i<a.length;i++){ try{ a[i].call(this, e); }catch(x){} }
};
window.WebSocket = VVWebSocket;
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
if (window.__vvSseInstalled) return; window.__vvSseInstalled = true;
var hm = location.hostname.match(/^[a-z0-9]+--(\\d+)-vv\\./i);
var m = location.pathname.match(/\\/preview\\/(\\d+)\\//);
var previewPort = hm ? parseInt(hm[1], 10) : (m ? parseInt(m[1], 10) : 0);
var tok = Math.random().toString(36).slice(2, 8);
var nextId = 1, conns = {};
// Host resolution matches the ws shim: the studio iframe's parent when embedded, or
// — for a top-level "Open in new tab" preview, where COOP severs window.opener — the
// shared Service Worker. Inbound frames arrive on whichever channel we sent out on.
var vvHost = (window.parent && window.parent !== window) ? window.parent : null;
function post(msg){
  if (vvHost) { try { vvHost.postMessage(msg, '*'); return; } catch(e){} }
  try { var sw = navigator.serviceWorker && navigator.serviceWorker.controller; if (sw) sw.postMessage(msg); } catch(e){}
}
function _onIn(ev){
  var d = ev.data; if (!d || d.type !== 'vv-sse' || d.dir !== 'in') return;
  var c = conns[d.connId]; if (c) c._deliver(d);
}
window.addEventListener('message', _onIn);
if (navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', _onIn);
window.addEventListener('pagehide', function(){
  for (var k in conns){ try { conns[k].close(); } catch(e){} }
});
function VVEventSource(url, cfg){
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
  post({ type:'vv-sse', dir:'out', sub:'open', connId:this._id, port:targetPort, fallbackPort:previewPort, path:path });
  // DevTools display URL: the real in-VM destination, with the internal
  // /preview/<port>/ proxy prefix stripped (see the ws shim for rationale).
  var self2 = this; this._rid = this._id;
  this._cdpUrl = ((location.protocol === 'https:') ? 'https' : 'http') + '://localhost:' + targetPort + path;
  this._sseReplay = function(){
    window.__vvNet.emit('Network.requestWillBeSent', { requestId:self2._rid, loaderId:'vv', documentURL:location.href, request:{ url:self2._cdpUrl, method:'GET', headers:{ Accept:'text/event-stream' } }, timestamp:window.__vvNet.now(), wallTime:window.__vvNet.wall(), initiator:{ type:'script' }, type:'EventSource' });
    if (self2.readyState === 1) window.__vvNet.emit('Network.responseReceived', { requestId:self2._rid, timestamp:window.__vvNet.now(), type:'EventSource', response:{ url:self2._cdpUrl, status:200, statusText:'OK', mimeType:'text/event-stream', headers:{ 'content-type':'text/event-stream' } } });
  };
  window.__vvNet.register(this._rid, this._sseReplay);
}
VVEventSource.CONNECTING = 0; VVEventSource.OPEN = 1; VVEventSource.CLOSED = 2;
VVEventSource.prototype._sseFinish = function(){
  if (this._cdpDone) return; this._cdpDone = true;
  window.__vvNet.emit('Network.loadingFinished', { requestId:this._rid, timestamp:window.__vvNet.now(), encodedDataLength:0 });
  window.__vvNet.unregister(this._rid);
};
VVEventSource.prototype._deliver = function(d){
  if (d.sub === 'open'){ this.readyState = 1;
    window.__vvNet.emit('Network.responseReceived', { requestId:this._rid, timestamp:window.__vvNet.now(), type:'EventSource', response:{ url:this._cdpUrl, status:200, statusText:'OK', mimeType:'text/event-stream', headers:{ 'content-type':'text/event-stream' } } });
    this._emit('open', { type:'open' }); }
  else if (d.sub === 'chunk'){ this._feed(String(d.data == null ? '' : d.data)); }
  else if (d.sub === 'close'){ if (this.readyState === 2) return; this.readyState = 2; delete conns[this._id]; this._sseFinish(); this._emit('error', { type:'error' }); }
};
VVEventSource.prototype._feed = function(text){
  this._buf = (this._buf + text).replace(/\\r\\n/g, '\\n').replace(/\\r/g, '\\n');
  var idx;
  while ((idx = this._buf.indexOf('\\n\\n')) >= 0){
    var raw = this._buf.slice(0, idx); this._buf = this._buf.slice(idx + 2);
    this._parse(raw);
  }
};
VVEventSource.prototype._parse = function(raw){
  var lines = raw.split('\\n'); var event = 'message', data = [], id = null;
  for (var i=0;i<lines.length;i++){
    var line = lines[i]; if (line === '' || line.charAt(0) === ':') continue;
    var c = line.indexOf(':'); var field = c === -1 ? line : line.slice(0, c);
    var value = c === -1 ? '' : line.slice(c + 1); if (value.charAt(0) === ' ') value = value.slice(1);
    if (field === 'event') event = value; else if (field === 'data') data.push(value); else if (field === 'id') id = value;
  }
  if (id !== null) this.lastEventId = id;
  if (data.length === 0) return;
  var payload = data.join('\\n');
  window.__vvNet.emit('Network.eventSourceMessageReceived', { requestId:this._rid, timestamp:window.__vvNet.now(), eventName:event, eventId:this.lastEventId || '', data:payload });
  this._emit(event, { type:event, data:payload, lastEventId:this.lastEventId, origin:location.origin });
};
VVEventSource.prototype.close = function(){
  if (this.readyState === 2) return; this.readyState = 2; delete conns[this._id];
  this._sseFinish();
  post({ type:'vv-sse', dir:'out', sub:'close', connId:this._id });
};
VVEventSource.prototype.addEventListener = function(t, fn){ (this._l[t] || (this._l[t] = [])).push(fn); };
VVEventSource.prototype.removeEventListener = function(t, fn){ var a=this._l[t]; if(a){var i=a.indexOf(fn); if(i>=0)a.splice(i,1);} };
VVEventSource.prototype._emit = function(t, e){
  var on = this['on'+t]; if (typeof on === 'function'){ try{ on.call(this, e); }catch(x){} }
  var a = this._l[t]; if (a) for (var i=0;i<a.length;i++){ try{ a[i].call(this, e); }catch(x){} }
};
window.EventSource = VVEventSource;
})();`;

// In-browser DevTools bridge. Injected into every preview page next to the WS
// shim. It (1) loads chobitsu — the CDP backend — as a classic script so it hooks
// console/network before the app's module scripts run, (2) tunnels CDP messages
// between chobitsu and the chii DevTools frontend (which lives in a sibling iframe
// on the host page; the host relays by window.postMessage), and (3) reports every
// SPA/MPA navigation up to the host so the preview address bar stays in sync.
//
// Protocol on the host page:
//   preview → host : { source:'vv-cdp', dir:'target',   data:<cdp json string> }
//                     { source:'vv-nav', href:<path>                          }
//   host  → preview: { source:'vv-cdp', dir:'frontend', data:<cdp json string> }  (forward to chobitsu)
//                     { source:'vv-cdp', dir:'init'                            }  (run the attach handshake)
const CDP_BOOTSTRAP = `(function(){
if (window.__vvCdpInstalled) return; window.__vvCdpInstalled = true;
function post(m){ parent.postMessage(m, '*'); }
var seq = 0;
// chobitsu reports fetch/XHR with the URL the app resolved against the iframe
// origin — i.e. the internal studio-origin proxy path (…/preview/<port>/…). Rewrite
// it to the friendly in-VM URL the user's code actually targets
// (http://localhost:<port>/<path>), so the Network panel matches what the ws/SSE
// shims already show. Display-only: the requestId (and thus getResponseBody) is
// untouched.
var _hp = location.hostname.match(/^[a-z0-9]+--(\\d+)-vv\\./i);
var _pp = location.pathname.match(/^\\/preview\\/(\\d+)\\//);
var previewPort = _hp ? parseInt(_hp[1], 10) : (_pp ? parseInt(_pp[1], 10) : 0);
function cleanUrl(u){
  try {
    var url = new URL(u, location.href);
    if (url.origin !== location.origin) return u;
    var scheme0 = (location.protocol === 'https:') ? 'https' : 'http';
    // Mode C: this whole origin maps to one in-VM port; show localhost:<port>.
    // An explicit /preview/<port>/ (cross-service) still shows its real target port.
    if (_hp) {
      var pmc = url.pathname.match(/^\\/preview\\/(\\d+)(\\/.*)?$/);
      if (pmc) return scheme0 + '://localhost:' + pmc[1] + (pmc[2] || '/') + url.search + url.hash;
      return scheme0 + '://localhost:' + previewPort + url.pathname + url.search + url.hash;
    }
    var pm = url.pathname.match(/^\\/preview\\/(\\d+)(\\/.*)?$/);
    if (!pm) return u;
    var port = parseInt(pm[1], 10);
    // A keep-prefix app (Docusaurus/Slidev) genuinely serves under /preview/<port>/,
    // so its own-port URLs legitimately keep the prefix — mirror the ws shim.
    var rest = (window.__vvKeepPrefix && port === previewPort) ? url.pathname : (pm[2] || '/');
    var scheme = (location.protocol === 'https:') ? 'https' : 'http';
    return scheme + '://localhost:' + port + rest + url.search + url.hash;
  } catch(e){ return u; }
}
function scrubNet(o){
  var p = o && o.params; if (!p) return false;
  var changed = false;
  function fix(obj, key){ if (obj && typeof obj[key] === 'string'){ var c = cleanUrl(obj[key]); if (c !== obj[key]){ obj[key] = c; changed = true; } } }
  fix(p, 'documentURL');
  fix(p.request, 'url');
  fix(p.response, 'url');
  fix(p.redirectResponse, 'url');
  return changed;
}
// The ws/SSE replay must wait until BOTH (a) the frontend re-attached (an 'init'
// from the host, sent once per DevTools (re)mount) AND (b) the frontend's Network
// domain is actually live (its 'Network.enable' command, seen via the relay).
// Firing on the DevTools iframe load alone races chii's Network panel startup —
// a webSocketCreated emitted too early is dropped, so a socket opened before the
// panel was ready (e.g. right after a preview reload) never shows. Both signals
// fire exactly once per fresh frontend, so this also keeps it to one row.
var seenInit = false, seenNet = false;
function maybeAttach(){
  if (seenInit && seenNet && window.__vvNet){ seenInit = false; seenNet = false; window.__vvNet.onAttach(); }
}
function setup(){
  if (!window.chobitsu) return false;
  window.chobitsu.setOnMessage(function(msg){
    // Drop responses to our own internal enable requests (ids prefixed 'vvdt');
    // pass through events and responses the frontend actually asked for.
    if (typeof msg === 'string' && msg.indexOf('"id":"vvdt') !== -1) return;
    // Friendly-URL rewrite for fetch/XHR Network events (cheap substring gate first).
    if (typeof msg === 'string' && msg.indexOf('/preview/') !== -1 && msg.indexOf('"Network.') !== -1) {
      try { var o = JSON.parse(msg); if (o && typeof o.method === 'string' && o.method.indexOf('Network.') === 0 && scrubNet(o)) msg = JSON.stringify(o); } catch(e){}
    }
    post({ source:'vv-cdp', dir:'target', data: msg });
  });
  return true;
}
if (!setup()) { var tries = 0, iv = setInterval(function(){ if (setup() || ++tries > 100) clearInterval(iv); }, 20); }
function sendToChobitsu(method){ if (window.chobitsu) window.chobitsu.sendRawMessage(JSON.stringify({ id:'vvdt'+(++seq), method:method, params:{} })); }
function sendToDevtools(msg){ post({ source:'vv-cdp', dir:'target', data: JSON.stringify(msg) }); }
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
  // Don't replay live ws/SSE connections yet — wait until the frontend's Network
  // domain is enabled too (maybeAttach), so the replayed rows aren't dropped by a
  // not-yet-ready Network panel.
  seenInit = true; maybeAttach();
}
window.addEventListener('message', function(ev){
  var d = ev.data;
  if (!d || d.source !== 'vv-cdp') return;
  if (d.dir === 'frontend') {
    if (window.chobitsu) window.chobitsu.sendRawMessage(d.data);
    // The frontend just enabled its Network domain → its panel is ready to render
    // events. Trigger the deferred ws/SSE replay now (once both signals are in).
    try { if (JSON.parse(d.data).method === 'Network.enable') { seenNet = true; maybeAttach(); } } catch(e){}
  }
  else if (d.dir === 'init') { init(); }
});
function notifyNav(){ post({ source:'vv-nav', href: location.pathname + location.search + location.hash }); }
var _ps = history.pushState, _rs = history.replaceState;
history.pushState = function(){ var r = _ps.apply(this, arguments); notifyNav(); return r; };
history.replaceState = function(){ var r = _rs.apply(this, arguments); notifyNav(); return r; };
window.addEventListener('popstate', notifyNav);
window.addEventListener('hashchange', notifyNav);
window.addEventListener('load', notifyNav);
notifyNav();
})();`;

const DEVTOOLS_TAGS =
  '<script src="/vv-devtools/chobitsu.js"><\/script>' + "<script>" + CDP_BOOTSTRAP + "<\/script>";

// Insert the shim as the first child of <head> (so it runs before any script).
// The DevTools network bridge (NET_SHIM) runs first so the WS/SSE shims can use
// it, then the WS + SSE shims (inline), then chobitsu (classic src → executes
// before the app's deferred module scripts), then the CDP bootstrap.
function injectWsShim(html, keepPrefix, devtools) {
  // For keep-prefix ports, tell the injected WS shim (and any app code that cares)
  // that this document lives under its real base — so its own HMR socket path is
  // left prefixed rather than stripped.
  const flag = keepPrefix ? "<script>window.__vvKeepPrefix=true;<\/script>" : "";
  // The net/WS/SSE shims are always required (HMR + virtual networking); the
  // DevTools backend (chobitsu + CDP) is opt-out so a standalone SDK embedder that
  // doesn't host /vv-devtools/chobitsu.js gets clean previews (no per-page 404).
  const tag =
    flag +
    "<script>" + NET_SHIM + "<\/script>" +
    "<script>" + TITLE_SHIM + "<\/script>" +
    "<script>" + WS_SHIM + "<\/script>" +
    "<script>" + SSE_SHIM + "<\/script>" +
    (devtools ? DEVTOOLS_TAGS : "");
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
        console.warn("[vv-sw] precache miss:", url, "-", err && err.message);
      }
    }),
  );
  if (fetched || failed) {
    console.log(`[vv-sw] precache ${CACHE_NAME}: ${fetched} fetched, ${kept} cached, ${failed} failed`);
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

  // Mode-B static docs on the preview origin: the hidden bridge iframe and the
  // standalone-preview boot page. They are OUR files — always pass them straight
  // to the network. Cloudflare Pages "clean URLs" 308-redirect `/x.html` → `/x`,
  // so match BOTH forms; without this bypass the redirected hit falls through to
  // routeByClient, which calls fetch() on a navigation request and throws
  // ("Failed to fetch"), breaking the bridge handshake.
  if (
    url.pathname === "/__vv-bridge" ||
    url.pathname === "/__vv-bridge.html" ||
    url.pathname === "/__vv-preview-boot" ||
    url.pathname === "/__vv-preview-boot.html"
  ) {
    return;
  }

  // Mode C (wildcard per-port origin): the port is in the hostname, so a request
  // on this origin belongs to this origin's single in-VM port — served at root
  // (no proxy prefix to strip, no keep-prefix). Two exceptions keep parity with
  // modes A/B: our static SW-runtime files (bridge/boot handled above; DevTools
  // below) hit the network so the Worker can serve them; and an explicit
  // `/preview/<port>/…` URL still addresses ANOTHER in-VM port so **cross-service
  // HTTP** (a frontend calling a backend on a different port) keeps working
  // exactly as before — the kernel is shared across every origin's bridge port.
  if (WILDCARD_MODE) {
    if (url.pathname.startsWith("/vv-devtools/")) return;
    const cross = url.pathname.match(/^\/preview\/(\d+)(\/.*)?$/);
    if (cross) {
      event.respondWith(
        handlePreview(event, parseInt(cross[1], 10), (cross[2] || "/") + url.search, false),
      );
    } else {
      event.respondWith(handlePreview(event, WILDCARD_PORT, url.pathname + url.search, false));
    }
    return;
  }

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
  // absolute /vv-devtools/... URL, so without this exception routeByClient would
  // proxy it into the VM (which has no such file). It's always OUR app asset —
  // let it hit the network (served same-origin by the serveDevtools Vite plugin).
  if (url.pathname.startsWith("/vv-devtools/")) return;

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
  // `fetch(event.request)` failure), exactly like /vv-devtools/ + /packages/.
  // The kernel worker fetches them relative to the app base, so the path is
  // /vendor/… (root), /studio/vendor/… or /embed/vendor/… in the unified deploy;
  // without this bypass it gets "Failed to fetch" and no package managers load.
  if (/(^|\/)vendor\//.test(url.pathname)) return;

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
  if (!m) {
    // Defensive: a navigation Request must never be passed to fetch() inside a SW
    // (mode:"navigate" is illegal for fetch() and throws). Re-issue a plain GET so
    // pass-through never rejects. Real navigations already return at the top of the
    // fetch handler; this only guards unexpected redirect artifacts.
    if (event.request.mode === "navigate") return fetch(url.href, { credentials: "include" });
    return fetch(event.request);
  }
  return handlePreview(event, parseInt(m[1], 10), url.pathname + url.search);
}

// A friendly "connecting…" gate for a standalone mode-B preview tab (isolated
// pop-out, or a pasted preview-origin URL) that can't reach the kernel yet. It
// briefly auto-retries (a just-claimed SW may not see its clients for a tick),
// then — because a standalone cross-site tab is in a different storage partition
// than the editor tab — reveals a "Connect this tab" gate that best-effort calls
// the Storage Access API inside the click gesture and reloads, falling back to
// browser-config instructions. This mirrors StackBlitz's "You're almost there"
// screen and is inherent to any client-side kernel (no server to reach).
function previewConnectingHtml(port) {
  return (
    "<!doctype html><html><head><meta charset='utf-8'>" +
    "<meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<title>Connecting to Vivari…</title>" +
    "<style>" +
    "html,body{height:100%;margin:0}" +
    "body{display:flex;align-items:center;justify-content:center;background:#0b0d10;color:#e6e8eb;" +
    "font:15px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}" +
    ".card{max-width:34rem;padding:2rem;text-align:center}" +
    ".spin{width:26px;height:26px;margin:0 auto 1rem;border:3px solid #2a2f36;border-top-color:#6aa3ff;" +
    "border-radius:50%;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}" +
    "h1{font-size:1.15rem;margin:.25rem 0 .5rem}p{color:#9aa4af;margin:.4rem 0}code{color:#cbd5e1}" +
    "button{margin-top:1rem;padding:.6rem 1.1rem;border:0;border-radius:.5rem;background:#3b82f6;" +
    "color:#fff;font:inherit;font-weight:600;cursor:pointer}button:hover{background:#2f6fe0}" +
    "button:disabled{opacity:.6;cursor:default}" +
    "</style></head><body><div class='card'>" +
    "<div class='spin' id='sp'></div>" +
    "<h1 id='t'>Connecting to your Vivari project…</h1>" +
    "<p id='m'>Preview on port <code>" + port + "</code>. Keep the Vivari editor tab open.</p>" +
    "<div id='g' style='display:none'>" +
    "<button id='b' type='button'>Connect this tab</button>" +
    "<p id='hint' style='display:none'></p>" +
    "</div>" +
    "<script>(function(){" +
    "var k='vv-preview-tries';var n=+(sessionStorage.getItem(k)||0);" +
    "var sp=document.getElementById('sp'),t=document.getElementById('t'),m=document.getElementById('m');" +
    "var g=document.getElementById('g'),b=document.getElementById('b'),hint=document.getElementById('hint');" +
    // Auto-retry a few times: self-heals when storage is already unpartitioned.
    "if(n<3){sessionStorage.setItem(k,n+1);setTimeout(function(){location.reload()},1500);return;}" +
    "sessionStorage.removeItem(k);sp.style.display='none';" +
    "t.textContent='Connect this tab to your Vivari project';" +
    "m.innerHTML='This preview runs on a separate origin for isolation. Keep the <b>Vivari editor tab</b> open, then connect this tab.';" +
    "g.style.display='block';" +
    "function fallback(){hint.style.display='block';" +
    "hint.innerHTML='Still stuck? Allow third-party data / cookies for this site in your browser settings, then reload \\u2014 previews run cross-origin so the browser isolates their storage by default.';}" +
    "b.addEventListener('click',function(){" +
    "b.disabled=true;b.textContent='Connecting\\u2026';" +
    // requestStorageAccess must run in a user gesture; best-effort, then reload.
    "var req=document.requestStorageAccess?document.requestStorageAccess():Promise.reject();" +
    "Promise.resolve(req).then(function(){location.reload();})" +
    ".catch(function(){b.disabled=false;b.textContent='Try again';fallback();});" +
    "});" +
    "})();<\/script>" +
    "</div></body></html>"
  );
}

async function handlePreview(event, port, path, keepPrefix) {
  if (!Number.isInteger(port)) {
    return new Response("Bad preview URL\n", { status: 400 });
  }

  // Reach the kernel. Mode A: the same-origin kernel-host window client. Mode B:
  // the persistent port to the (cross-origin) IDE, reviving it if the SW was
  // evicted. `cross` tells us which CORP/COEP headers the response needs.
  const sink = await resolveKernelSink();
  if (!sink) {
    // A top-level preview tab (mode B "Open in new tab") whose kernel we can't
    // reach yet — show a friendly, auto-retrying page instead of a bare 503 or a
    // raw 404. It self-heals the moment the kernel becomes reachable (e.g. the
    // project tab connects / the shared SW is available).
    if (event.request.mode === "navigate") {
      return new Response(previewConnectingHtml(port), {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "Cross-Origin-Resource-Policy": "cross-origin",
          "Cross-Origin-Embedder-Policy": "credentialless",
        },
      });
    }
    return new Response("Vivari kernel is not running\n", { status: 503 });
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

  // Tell path-prefix-aware guest frameworks (FastAPI `root_path`, Flask
  // `SCRIPT_NAME`, …) that they're mounted behind /preview/<port> so they emit
  // correct absolute URLs — e.g. Swagger UI's openapi.json link and "Try it out"
  // request URLs, or framework redirects. Only when we STRIPPED that prefix:
  // keepPrefix apps already receive the full path, and a wildcard-root preview is
  // served at the origin root with no prefix (its source URL has no /preview/).
  if (!keepPrefix) {
    const srcPath = new URL(event.request.url).pathname;
    const pIdx = srcPath.indexOf(PREVIEW_MARKER);
    if (pIdx !== -1) {
      headers["x-forwarded-prefix"] = srcPath.slice(0, pIdx) + PREVIEW_MARKER + port;
    }
  }

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
    sink.post({ type: "vv-http", req }, [mc.port2]);
  });

  const respHeaders = new Headers(resp.headers || {});
  if (sink.cross) {
    // Mode B: the preview is a DIFFERENT origin from the IDE. Let its subresources
    // be embedded cross-origin (CORP) and keep the preview cross-origin isolated
    // without needing every response to carry CORP (COEP:credentialless).
    respHeaders.set("Cross-Origin-Resource-Policy", "cross-origin");
    respHeaders.set("Cross-Origin-Embedder-Policy", "credentialless");
  } else {
    // Same-origin preview docs are allowed under COEP:require-corp, but be explicit
    // so nested subresources embed cleanly in the cross-origin-isolated top page.
    respHeaders.set("Cross-Origin-Resource-Policy", "same-origin");
    respHeaders.set("Cross-Origin-Embedder-Policy", "require-corp");
  }
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
    // DevTools backend injection is opt-out (loadDevtoolsEnabled; default on).
    outBody = injectWsShim(outBody, keepPrefix, await loadDevtoolsEnabled());
    respHeaders.delete("content-length"); // body grew; let the browser recompute
  }

  return new Response(outBody, { status: resp.status || 200, headers: respHeaders });
}