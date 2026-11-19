// Spike (OFFLINE, Wasm-free): two Studio tabs on one origin each get their OWN
// previews from the shared Service Worker, even when both dev servers bind the same
// in-VM port.
//
// WHY THIS EXISTS. In mode A every tab's preview lives at /preview/<port>/ on the
// studio origin, and one SW serves them all. #23 routed a preview by the client that
// asked: a navigation by the window that started it, a subresource by its frame. But
// measured in Chrome 156, the FIRST navigation of an iframe whose parent sets `src`
// (how PreviewFrame loads every preview) carries an EMPTY clientId, so that load fell
// back to "the first kernel window", and the guess was then remembered for the frame.
// The bridge now adds its kernel token to preview URLs (`__vv_kernel`); the SW maps
// the token to the tab, records the frame, and redirects to the clean URL.
//
// HOW IT IS GATED. The real sw.js runs under `vm`. Two fake kernel windows answer
// every vv-http request with their own name, so each check reads which tab served it.
// The client list puts tab B FIRST, so the fallback heuristic picks B and only real
// routing can reach tab A.
//
//   run:  node scripts/spike-sw-multitab.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SW_SRC = path.join(ROOT, "packages/studio/public/sw.js");
const ORIGIN = "http://localhost:5173";

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};

// One SW instance plus the window clients it can see.
function loadSw() {
  const emptyCache = { match: async () => undefined, put: async () => {}, keys: async () => [], delete: async () => true };
  const listeners = {};
  const clients = [];
  const ctx = {
    console: { log() {}, warn() {}, error() {}, debug() {}, info() {} },
    URL, Response, Request, Headers, MessageChannel, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, atob, btoa, AbortSignal,
    fetch: async () => new Response("network", { status: 200 }),
    caches: { open: async () => emptyCache, keys: async () => [], match: async () => undefined, delete: async () => true },
  };
  ctx.self = {
    location: new URL(`${ORIGIN}/sw.js`),
    addEventListener: (type, fn) => ((listeners[type] ??= []).push(fn), undefined),
    clients: {
      get: async (id) => clients.find((c) => c.id === id),
      matchAll: async () => clients.slice(),
      claim: async () => {},
    },
    registration: { scope: `${ORIGIN}/` },
    skipWaiting: () => {},
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SW_SRC, "utf8"), ctx, { filename: "packages/studio/public/sw.js" });

  // A kernel window answers vv-http with its own name and the path it was handed,
  // and records anything else posted to it (ws/SSE frames).
  const kernel = (id) => {
    const c = {
      id,
      url: `${ORIGIN}/`,
      frameType: "top-level",
      got: [],
      postMessage(msg, transfer) {
        if (msg && msg.type === "vv-http") {
          transfer[0].postMessage({ status: 200, headers: { "content-type": "text/plain" }, body: `${id}:${msg.req.url}` });
        } else c.got.push(msg);
      },
    };
    clients.push(c);
    return c;
  };
  const frame = (id, url) => clients.push({ id, url: ORIGIN + url, frameType: "nested", postMessage() {} });

  const message = async (source, data) => {
    const waits = [];
    for (const fn of listeners.message) fn({ data, source, ports: [], waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  const request = async ({ url, mode = "cors", clientId = "", resultingClientId = "" }) => {
    let responded;
    const event = {
      request: { url: ORIGIN + url, referrer: "", mode, method: "GET", headers: new Headers() },
      clientId,
      resultingClientId,
      respondWith: (p) => (responded = Promise.resolve(p)),
      waitUntil() {},
    };
    for (const fn of listeners.fetch) fn(event);
    const res = await responded;
    if (!res) return { status: 0, body: "", location: null };
    return { status: res.status, body: await res.text(), location: res.headers.get("location"), coep: res.headers.get("cross-origin-embedder-policy"), corp: res.headers.get("cross-origin-resource-policy") };
  };
  const peek = (expr) => vm.runInContext(expr, ctx);
  return { ctx, clients, kernel, frame, message, request, peek };
}

// Which kernel answered: the body starts with its name.
const servedBy = (r) => r.body.split(":")[0];

console.log("== the bridge and the SW agree on the parameter name ==");
{
  const bridgeSrc = fs.readFileSync(path.join(ROOT, "packages/core/src/bridge.ts"), "utf8");
  const inBridge = (bridgeSrc.match(/const PREVIEW_KERNEL_PARAM = "([^"]+)"/) || [])[1];
  const inSw = loadSw().peek("KERNEL_PARAM");
  ok(inBridge && inBridge === inSw, `bridge.ts and sw.js both use ${JSON.stringify(inSw)} (bridge: ${JSON.stringify(inBridge)})`);
}

console.log("\n== a tab's first preview load reaches that tab, not the first kernel window ==");
{
  const sw = loadSw();
  const b = sw.kernel("tab-B"); // listed first: what the heuristic would pick
  const a = sw.kernel("tab-A");
  await sw.message(a, { type: "vv-kernel-host", token: "aaaaaa" });
  await sw.message(b, { type: "vv-kernel-host", token: "bbbbbb" });

  // The iframe's first navigation: parent-set src, so clientId is empty (Chrome 156).
  const first = await sw.request({ url: "/preview/5173/?__vv_kernel=aaaaaa", mode: "navigate", resultingClientId: "frame-A" });
  ok(first.status === 302, `the tokened navigation is redirected (${first.status})`);
  ok(first.location === `${ORIGIN}/preview/5173/`, `…to the URL without the token (${first.location})`);
  // WebKit blocks a redirect into a frame of a COEP: require-corp page unless the 302
  // itself carries COEP, and Response.redirect() carries no headers at all.
  ok(first.coep === "require-corp" && first.corp === "same-origin", `…and carries COEP/CORP, or WebKit blocks it (coep=${first.coep}, corp=${first.corp})`);

  // The redirected navigation keeps the same resultingClientId.
  const doc = await sw.request({ url: "/preview/5173/", mode: "navigate", resultingClientId: "frame-A" });
  ok(servedBy(doc) === "tab-A", `the document comes from tab A (${servedBy(doc)})`);
  sw.frame("frame-A", "/preview/5173/");
  const sub = await sw.request({ url: "/preview/5173/src/main.tsx", clientId: "frame-A" });
  ok(servedBy(sub) === "tab-A", `…and so does its subresource (${servedBy(sub)})`);
  // A reload from inside the frame names the old document.
  const reload = await sw.request({ url: "/preview/5173/", mode: "navigate", clientId: "frame-A", resultingClientId: "frame-A2" });
  ok(servedBy(reload) === "tab-A", `…and a reload from inside the frame (${servedBy(reload)})`);

  const firstB = await sw.request({ url: "/preview/5173/?__vv_kernel=bbbbbb", mode: "navigate", resultingClientId: "frame-B" });
  const docB = await sw.request({ url: (firstB.location ?? ORIGIN + "/preview/5173/").slice(ORIGIN.length), mode: "navigate", resultingClientId: "frame-B" });
  ok(servedBy(docB) === "tab-B", `tab B's preview on the same port comes from tab B (${servedBy(docB)})`);

  // Control: without the token the first load is a guess, and it guesses tab B. This
  // is what #23 did for every first load, and why the token exists.
  const guess = await sw.request({ url: "/preview/5173/", mode: "navigate", resultingClientId: "frame-X" });
  ok(servedBy(guess) === "tab-B", `control: an untokened first load falls back to the first kernel window (${servedBy(guess)})`);
}

console.log("\n== the token never reaches the app ==");
{
  const sw = loadSw();
  const a = sw.kernel("tab-A");
  await sw.message(a, { type: "vv-kernel-host", token: "aaaaaa" });
  const r = await sw.request({ url: "/preview/5173/page?q=1&__vv_kernel=aaaaaa&t=2", mode: "navigate", resultingClientId: "f1" });
  ok(r.location === `${ORIGIN}/preview/5173/page?q=1&t=2`, `other query params survive the redirect (${r.location})`);
  // A non-navigation carrying the token (e.g. a fetch of a preview URL from the studio)
  // is served directly, routed by the token, with the token stripped.
  const f = await sw.request({ url: "/preview/5173/api?x=1&__vv_kernel=aaaaaa", clientId: "devtools" });
  ok(f.body === "tab-A:/api?x=1", `a tokened fetch reaches tab A without the token (${f.body})`);
  // An unknown token (the SW was revived and lost the map) still redirects to the
  // clean URL, which then takes the fallback.
  const lost = await sw.request({ url: "/preview/5173/?__vv_kernel=zzzzzz", mode: "navigate", resultingClientId: "f2" });
  ok(lost.status === 302 && lost.location === `${ORIGIN}/preview/5173/`, `an unknown token still redirects to the clean URL (${lost.status} ${lost.location})`);
}

console.log("\n== keep-prefix is decided per tab ==");
{
  const sw = loadSw();
  const b = sw.kernel("tab-B");
  const a = sw.kernel("tab-A");
  await sw.message(a, { type: "vv-kernel-host", token: "aaaaaa" });
  await sw.message(b, { type: "vv-kernel-host", token: "bbbbbb" });
  await sw.message(a, { type: "vv-keep-prefix-ports", ports: [5173] }); // tab A: a Docusaurus-style app
  await sw.message(b, { type: "vv-keep-prefix-ports", ports: [] });
  const ra = await sw.request({ url: "/preview/5173/docs/intro?__vv_kernel=aaaaaa", clientId: "x" });
  const rb = await sw.request({ url: "/preview/5173/docs/intro?__vv_kernel=bbbbbb", clientId: "x" });
  ok(ra.body === "tab-A:/preview/5173/docs/intro", `tab A keeps the prefix (${ra.body})`);
  ok(rb.body === "tab-B:/docs/intro", `tab B, same port, gets it stripped (${rb.body})`);
}

console.log("\n== ws/SSE frames from a preview go to its own tab ==");
{
  const sw = loadSw();
  const b = sw.kernel("tab-B");
  const a = sw.kernel("tab-A");
  await sw.message(a, { type: "vv-kernel-host", token: "aaaaaa" });
  await sw.message(b, { type: "vv-kernel-host", token: "bbbbbb" });
  await sw.request({ url: "/preview/5173/?__vv_kernel=aaaaaa", mode: "navigate", resultingClientId: "frame-A" });
  await sw.request({ url: "/preview/5173/", mode: "navigate", resultingClientId: "frame-A" });
  sw.frame("frame-A", "/preview/5173/");
  await sw.message({ id: "frame-A" }, { type: "vv-ws", dir: "out", sub: "open", connId: 1 });
  ok(a.got.some((m) => m.type === "vv-ws") && !b.got.some((m) => m.type === "vv-ws"), "the HMR socket frame reaches tab A only");
}

console.log("\n== routing maps forget clients that are gone ==");
{
  const sw = loadSw();
  const a = sw.kernel("tab-A");
  await sw.message(a, { type: "vv-kernel-host", token: "aaaaaa" });
  await sw.message(a, { type: "vv-keep-prefix-ports", ports: [] });
  await sw.request({ url: "/preview/5173/?__vv_kernel=aaaaaa", mode: "navigate", resultingClientId: "frame-A" });
  await sw.request({ url: "/preview/5173/", mode: "navigate", resultingClientId: "frame-A" });
  const t0 = Date.now();
  ok(typeof sw.ctx.pruneRouting === "function", "the SW has a pruning pass");
  if (typeof sw.ctx.pruneRouting !== "function") sw.ctx.pruneRouting = () => {};
  // Just recorded and not a client yet (a navigation records before the document
  // exists): a prune right now must keep it.
  sw.peek("lastPrune = 0");
  sw.ctx.pruneRouting([{ id: "tab-A" }], t0);
  ok(sw.peek("frameKernel.has('frame-A')"), "a frame still inside its grace period is kept");
  // Tab A and its frame are closed; a minute later everything about them goes.
  sw.peek("lastPrune = 0");
  sw.ctx.pruneRouting([], t0 + 61000);
  ok(sw.peek("frameKernel.size") === 0 && sw.peek("frameSeenAt.size") === 0, "frames of a closed tab are dropped");
  ok(sw.peek("kernelByToken.size") === 0, "…and its token");
  ok(sw.peek("keepPrefixByClient.size") === 0 && sw.peek("kernelHostIds.size") === 0, "…and its keep-prefix set and kernel-host entry");
}

console.log("\nRESULT: " + (failed ? `FAIL (${failed})` : "PASS: each tab's previews are served by that tab"));
process.exit(failed ? 1 : 0);
