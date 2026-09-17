// Spike (OFFLINE, no kernel, no Wasm): the preview Service Worker's fetch
// routing — which requests it takes over, which it must leave alone, and what
// happens when handing one back to the network does not work.
//
// The failure that motivated it: on the Vite DEV server every module the kernel
// worker and its nested workers import is served from `/@fs/<absolute host path>`
// (studio vite.config.ts sets `server.fs.allow` to the monorepo root), not from
// `/packages/`. The SW's `/packages/` bypass therefore matched none of them, they
// fell through to `routeByClient`, and on Firefox its `fetch(event.request)`
// pass-through failed:
//
//   Failed to load '…/@fs/…/packages/kernel-host/kernel.js'.
//   A ServiceWorker intercepted the request and encountered an unexpected error.
//
// The kernel worker died before evaluating a line. Nothing surfaced: a worker's
// module-load failure is reported to the worker that created it, and the studio
// held "Starting runtime…" indefinitely. Chrome was unaffected, production was
// unaffected (bundled to /assets/, no `/@fs/` at all), so the only environment
// that could observe it was the one nobody runs a headless browser against.
//
// There is no browser here, so this drives the real `sw.js` under Node: the file
// is evaluated in a `vm` context with a stub `self`/`caches`/`fetch`, the `fetch`
// listener it registers is captured, and events are dispatched at it directly.
// That is enough to assert routing — which is where the bug was — without
// asserting anything about a real network.
//
// Gates:
//   1. The exact request from the bug report is NOT intercepted.
//   2. A preview iframe's `/@fs/` request IS still proxied into the VM. This is
//      the regression a blanket bypass would cause, and the reason the bypass is
//      conditioned on the referrer rather than on the path alone.
//   3. A `/@fs/` request with no READABLE referrer is left to the browser. Only a
//      referrer that positively names a preview is proxied into the VM. The first
//      version of this bypass had it the other way around and the kernel worker
//      kept dying in dev: a module import inside a worker does not reliably carry
//      a referrer the SW can read, so "prove it is not a preview" proved nothing
//      and the request fell through to routeByClient anyway.
//   4. `/@vite/client` is never bypassed: every in-VM Vite project requests it
//      and it must reach the VM.
//   5. passThrough survives `fetch(event.request)` failing: the caller gets the
//      real bytes from the plain re-issue.
//   6. passThrough cannot black-hole a request: with the network failing outright
//      the respondWith() promise still RESOLVES (502), never rejects.
//   7. A non-GET whose Request re-issue fails is not silently re-sent as a GET.
//   8. A navigation Request is never handed to fetch() (illegal; throws).
//   9. The pre-existing bypasses still bypass, and a real `/preview/<port>/` URL
//      still routes into the VM.
//  10. The build-time premise behind gate 1 still holds: the boot workers live
//      outside the studio's Vite root and `server.fs.allow` reaches above it,
//      which is exactly why their dev URLs start with `/@fs/`.
//
//   run:  node scripts/spike-sw-routing.mjs

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SW_SRC = path.join(ROOT, "packages/studio/public/sw.js");
const ORIGIN = "http://localhost:5173";

// The URLs from the bug report, with the checkout directory replaced by a
// placeholder. The reporter's was an absolute path under their home directory,
// and pasting a developer's machine layout into a committed test leaks it to
// everyone who reads the repo — for no benefit, since nothing here depends on it.
// What the gates actually test is the SHAPE: `/@fs/` + an absolute host path,
// which is how Vite serves any module above the studio's own root. The rest of
// each URL is verbatim, because the first gate is a regression test for concrete
// requests rather than for something someone paraphrased.
const REPO = "/checkout/vivari";
const KERNEL_WORKER_URL = `${ORIGIN}/@fs${REPO}/packages/core/src/workers/kernel-worker.ts?worker_file&type=module`;
const KERNEL_JS_URL = `${ORIGIN}/@fs${REPO}/packages/kernel-host/kernel.js`;

let failed = 0;
function ok(cond, label) {
  console.log(`${cond ? "  ✓" : "  ✗"} ${label}`);
  if (!cond) failed++;
}

// Evaluate sw.js with just enough platform to reach its fetch handler. Top-level
// `function` declarations land on the context object, so handlePreview and
// friends can be replaced from out here — the point is to observe WHICH branch a
// request takes, not to re-implement the VM proxy.
function loadSw({ hostname = "localhost" } = {}) {
  const calls = { fetch: [] };
  const listeners = {};
  const emptyCache = {
    match: async () => undefined,
    put: async () => {},
    keys: async () => [],
    delete: async () => true,
  };
  const ctx = {
    // Silent, but it has to carry every method the SW actually calls: a stub
    // narrower than the real thing turns a diagnostic line into a TypeError
    // thrown from inside the fetch handler, which is worse than no line at all.
    console: { log() {}, warn() {}, error() {}, debug() {}, info() {} },
    URL, Response, Request, Headers, MessageChannel, TextEncoder, TextDecoder,
    setTimeout, clearTimeout, atob, btoa,
    async fetch(input, init) {
      calls.fetch.push({ input, init });
      return new Response("network", { status: 200 });
    },
    caches: {
      open: async () => emptyCache,
      keys: async () => [],
      match: async () => undefined,
      delete: async () => true,
    },
  };
  ctx.self = {
    location: new URL(`http://${hostname}:5173/sw.js`),
    addEventListener: (type, fn) => ((listeners[type] ??= []).push(fn), undefined),
    clients: { get: async () => undefined, matchAll: async () => [], claim: async () => {} },
    registration: { scope: `${ORIGIN}/` },
    skipWaiting: () => {},
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(SW_SRC, "utf8"), ctx, { filename: "packages/studio/public/sw.js" });
  ctx.__calls = calls;
  ctx.__listeners = listeners;
  // Never talk to a real VM: every gate below asserts on the ROUTE taken.
  ctx.handlePreview = async (event, port, p) => {
    ctx.__proxied = { port, path: p };
    return new Response("from-vm", { status: 200 });
  };
  ctx.loadKeepPrefixPorts = async () => new Set();
  return ctx;
}

// Dispatch one FetchEvent and report whether the SW claimed it. `responded` is
// undefined when respondWith() was never called — i.e. the request was left to
// the browser, which is the only outcome that cannot fail.
function dispatch(ctx, { url, referrer = "", clientUrl = null, mode = "cors", method = "GET" }) {
  const event = {
    request: { url, referrer, mode, method },
    clientId: clientUrl ? "client-1" : "",
    resultingClientId: "",
    respondWith(p) {
      event.responded = Promise.resolve(p).then(
        (value) => ({ resolved: true, value }),
        (error) => ({ resolved: false, error }),
      );
    },
    waitUntil() {},
  };
  ctx.self.clients.get = async (id) =>
    id === "client-1" && clientUrl ? { id, url: clientUrl } : undefined;
  for (const fn of ctx.__listeners.fetch) fn(event);
  return event;
}

console.log("\n1. the request that killed the kernel worker");
{
  const ctx = loadSw();
  const event = dispatch(ctx, {
    url: KERNEL_JS_URL,
    referrer: KERNEL_WORKER_URL,
    clientUrl: KERNEL_WORKER_URL,
  });
  ok(event.responded === undefined, "the kernel worker's /@fs/ module import is left to the browser");
  ok(ctx.__calls.fetch.length === 0, "the SW does not re-issue it at all");
}

console.log("\n2. a preview's own /@fs/ request still reaches the VM");
{
  const ctx = loadSw();
  const event = dispatch(ctx, {
    url: `${ORIGIN}/@fs/app/outside-root/util.js`,
    referrer: `${ORIGIN}/preview/5173/index.html`,
    clientUrl: `${ORIGIN}/preview/5173/`,
  });
  ok(event.responded !== undefined, "it is intercepted rather than bypassed");
  const settled = await event.responded;
  ok(settled.resolved, "respondWith resolved");
  ok(ctx.__proxied?.port === 5173, `proxied to the in-VM port (${JSON.stringify(ctx.__proxied)})`);
}

console.log("\n3. a /@fs/ request with no readable referrer is left to the browser");
{
  for (const [label, referrer] of [
    ["no referrer", ""],
    ["about:client", "about:client"],
    ["cross-origin referrer", "https://example.com/x"],
  ]) {
    const ctx = loadSw();
    const event = dispatch(ctx, { url: KERNEL_JS_URL, referrer, clientUrl: KERNEL_WORKER_URL });
    ok(event.responded === undefined, `${label}: not intercepted`);
    ok(!ctx.__proxied, `${label}: not proxied into the VM`);
  }
}

console.log("\n4. /@vite/ and /@id/ are never bypassed (in-VM Vite needs them)");
{
  for (const p of ["/@vite/client", "/@react-refresh", "/@id/virtual:thing"]) {
    const ctx = loadSw();
    const event = dispatch(ctx, {
      url: ORIGIN + p,
      referrer: `${ORIGIN}/preview/5173/`,
      clientUrl: `${ORIGIN}/preview/5173/`,
    });
    ok(event.responded !== undefined, `${p} is intercepted`);
    await event.responded;
    ok(ctx.__proxied?.port === 5173, `${p} is proxied into the VM`);
  }
}

console.log("\n5. pass-through survives fetch(event.request) failing");
{
  const ctx = loadSw();
  const seen = [];
  ctx.fetch = async (input) => {
    seen.push(typeof input === "string" ? "url" : "request");
    if (typeof input !== "string") throw new TypeError("NetworkError when attempting to fetch resource.");
    return new Response("real bytes", { status: 200 });
  };
  const event = dispatch(ctx, {
    url: `${ORIGIN}/src/main.tsx`,
    referrer: `${ORIGIN}/`,
    clientUrl: `${ORIGIN}/`,
  });
  const settled = await event.responded;
  ok(settled.resolved, `respondWith resolved instead of rejecting (${settled.error ?? "ok"})`);
  ok(settled.value?.status === 200, `status ${settled.value?.status}`);
  ok((await settled.value?.text()) === "real bytes", "the caller got the real body");
  ok(seen.join(",") === "request,url", `tried the Request first, then the plain URL (${seen.join(",")})`);
}

console.log("\n6. pass-through cannot black-hole a request");
{
  const ctx = loadSw();
  ctx.fetch = async () => {
    throw new TypeError("NetworkError when attempting to fetch resource.");
  };
  const event = dispatch(ctx, {
    url: `${ORIGIN}/src/main.tsx`,
    referrer: `${ORIGIN}/`,
    clientUrl: `${ORIGIN}/`,
  });
  const settled = await event.responded;
  ok(settled.resolved, `respondWith RESOLVED with the network down (${settled.error ?? "ok"})`);
  ok(settled.value?.status === 502, `synthetic ${settled.value?.status} the caller can see`);
}

console.log("\n7. a failed non-GET is not silently re-sent as a GET");
{
  const ctx = loadSw();
  const seen = [];
  ctx.fetch = async (input) => {
    seen.push(typeof input === "string" ? "url" : "request");
    throw new TypeError("NetworkError when attempting to fetch resource.");
  };
  const event = dispatch(ctx, {
    url: `${ORIGIN}/api/thing`,
    method: "POST",
    referrer: `${ORIGIN}/`,
    clientUrl: `${ORIGIN}/`,
  });
  const settled = await event.responded;
  ok(seen.join(",") === "request", `only the original Request was tried (${seen.join(",")})`);
  ok(settled.resolved && settled.value?.status === 502, "and it still settles");
}

console.log("\n8. a navigation Request is never handed to fetch()");
{
  const ctx = loadSw();
  const seen = [];
  ctx.fetch = async (input) => {
    seen.push(typeof input === "string" ? "url" : "request");
    return new Response("network", { status: 200 });
  };
  const url = new URL(`${ORIGIN}/somewhere`);
  await ctx.passThrough({ request: { url: url.href, mode: "navigate", method: "GET" } }, url);
  ok(seen.join(",") === "url", `fetch() only ever saw a URL string (${seen.join(",")})`);
}

console.log("\n9. the pre-existing routes are unchanged");
{
  for (const p of ["/packages/kernel-host/kernel.js", "/vendor/npm.tar", "/vv-devtools/chobitsu.js", "/devtools/front_end/x.js"]) {
    const ctx = loadSw();
    const event = dispatch(ctx, { url: ORIGIN + p, referrer: `${ORIGIN}/`, clientUrl: `${ORIGIN}/` });
    ok(event.responded === undefined, `${p} still bypasses the SW`);
  }
  const ctx = loadSw();
  const event = dispatch(ctx, {
    url: `${ORIGIN}/preview/3000/api/users?q=1`,
    referrer: `${ORIGIN}/preview/3000/`,
    clientUrl: `${ORIGIN}/preview/3000/`,
  });
  await event.responded;
  ok(ctx.__proxied?.port === 3000, "an explicit /preview/<port>/ URL still routes into the VM");
  ok(ctx.__proxied?.path === "/api/users?q=1", `with the prefix stripped (${ctx.__proxied?.path})`);
}

console.log("\n10. the premise: boot-path modules really are served from /@fs/");
{
  const cfg = fs.readFileSync(path.join(ROOT, "packages/studio/vite.config.ts"), "utf8");
  // Vite serves a file from `/@fs/<abs path>` exactly when it is outside the Vite
  // root but inside `server.fs.allow`. Both halves have to hold, or gate 1 is
  // testing a URL the dev server never emits.
  ok(
    /fs:\s*\{\s*allow:\s*\[\s*fileURLToPath\(new URL\("\.\.\/\.\.\/"/.test(cfg),
    "server.fs.allow reaches above packages/studio (the Vite root)",
  );
  for (const rel of [
    "packages/core/src/workers/kernel-worker.ts",
    "packages/core/src/workers/fs-worker.ts",
    "packages/core/src/workers/fetcher-worker.ts",
    "packages/kernel-host/kernel.js",
  ]) {
    ok(
      fs.existsSync(path.join(ROOT, rel)) && !rel.startsWith("packages/studio/"),
      `${rel} is outside the Vite root, so dev serves it from /@fs/`,
    );
  }
}

// The request that actually killed it, taken verbatim from the SW's own log. No
// file in the worker's graph imports this: Vite injects it during transform to
// support `import.meta.env`, which is why reading the sources never found it.
console.log("\n11. a module Vite INJECTS into the worker is left to the browser");
{
  const ENV_MJS = `${ORIGIN}/node_modules/vite/dist/client/env.mjs`;
  {
    const ctx = loadSw();
    const event = dispatch(ctx, { url: ENV_MJS, referrer: KERNEL_WORKER_URL, clientUrl: KERNEL_WORKER_URL });
    ok(event.responded === undefined, "the kernel worker's env.mjs is not intercepted");
    ok(!ctx.__proxied, "and not proxied into the VM");
  }
  // Same URL, asked for by an in-VM Vite project. It must still reach the VM —
  // which is why this bypass keys on the referrer and not on `/node_modules/`.
  {
    const ctx = loadSw();
    const event = dispatch(ctx, {
      url: `${ORIGIN}/node_modules/.vite/deps/react.js?v=abc`,
      referrer: `${ORIGIN}/preview/5173/`,
      clientUrl: `${ORIGIN}/preview/5173/`,
    });
    ok(event.responded !== undefined, "a preview's /node_modules/ request is still intercepted");
    await event.responded;
    ok(ctx.__proxied?.port === 5173, "and still proxied into the VM");
  }
  // The page asks for it too, milliseconds earlier, and that one works today.
  // Leave it alone: this bypass must not widen beyond the case that is broken.
  {
    const ctx = loadSw();
    const event = dispatch(ctx, { url: ENV_MJS, referrer: `${ORIGIN}/@vite/client`, clientUrl: `${ORIGIN}/` });
    ok(event.responded !== undefined, "the page's own env.mjs is untouched by this change");
  }
}

// This gate exists because this spike failed it. The URLs above were pasted out
// of a bug report produced on a macOS checkout, and the reporter's home directory
// came along with them and got committed. Diagnosing a `/@fs/` bug means working
// from logs full of absolute host paths, so whoever writes the next fixture here
// is in exactly the same position — cheaper to catch than to rely on everyone
// remembering.
//
// The macOS home prefix never legitimately appears in this repo, which makes it a
// clean signal. The Linux one does — `/home/project` and `/home/user` are the
// in-VM paths, used all over the runtime and its spikes — so it cannot be checked
// the same way without drowning in false positives.
//
// Assembled from pieces rather than written out, so that this scan does not match
// its own source. The first version did, and reported a leak in a clean tree.
const HOME_PREFIX = "/" + "Users" + "/";
console.log("\n12. no fixture carries a developer's home directory");
{
  const dir = path.join(ROOT, "scripts");
  const leaked = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".mjs"))
    .filter((name) => fs.readFileSync(path.join(dir, name), "utf8").includes(HOME_PREFIX));
  ok(
    leaked.length === 0,
    leaked.length === 0
      ? `scripts/*.mjs carry no ${HOME_PREFIX} paths`
      : `these carry a ${HOME_PREFIX} path: ${leaked.join(", ")}`,
  );
}

console.log(
  failed === 0
    ? "\n✓ service worker routing holds"
    : `\n✗ ${failed} check(s) failed`,
);
process.exit(failed ? 1 : 0);