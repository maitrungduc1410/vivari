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

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const idx = url.pathname.indexOf(PREVIEW_MARKER);
  if (idx === -1) return; // not a preview request; let it hit the network/cache

  const rest = url.pathname.slice(idx + PREVIEW_MARKER.length);
  const slash = rest.indexOf("/");
  const port = parseInt(slash === -1 ? rest : rest.slice(0, slash), 10);
  const path = (slash === -1 ? "/" : rest.slice(slash)) + url.search;

  event.respondWith(handlePreview(event, port, path));
});

async function handlePreview(event, port, path) {
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
  }

  return new Response(outBody, { status: resp.status || 200, headers: respHeaders });
}
