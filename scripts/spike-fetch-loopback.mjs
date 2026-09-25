// Spike (OFFLINE): a guest's global fetch() to an in-VM server must reach it, and
// must answer the way real Node's fetch answers.
//
// WHY THIS EXISTS. The guest's `fetch` was the host realm's own, so
// `fetch('http://localhost:3917')` asked the browser tab — which has never heard
// of a server listening inside the VM — while `http.get` to the same URL reached
// it over the virtual network (issue #7). internal/fetch-loopback.js now sends a
// plain-http URL whose host `isLocalDestination` calls local through the vendored
// http client and hands back a real WHATWG Response.
//
// HOW IT IS GATED. As in spike-net-close-order.mjs: every scenario runs BOTH on
// the host's real Node (undici) and in the VM, and the transcripts must match
// line for line — real Node is the oracle, not our belief about it. Every
// scenario ends by closing its server and letting the process exit on its own,
// so a loop that drops a pending fetch shows up as a missing transcript and one
// that stays pinned shows up as a timeout. VM-only invariants follow (https to
// an in-VM host, non-local URLs keep the host path).
//
//   run:  node scripts/spike-fetch-loopback.mjs

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { bootSpikeKernel, writeProject } from "./lib/spike-harness.mjs";

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};

const DEAD_PORT = 65531; // the one verify-node.mjs and spike-net-close-order.mjs use

// One server, shared by every scenario (same-process: require()d; cross-process:
// run as its own program). Responses are deterministic and carry no port, so the
// host's and the VM's transcripts can be compared verbatim.
const SERVER = `const http = require('http');
function handler(req, res) {
  const u = new URL(req.url, 'http://x');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    switch (u.pathname) {
      case '/text': return res.end('hello\\n');
      case '/echo':
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({
          method: req.method,
          type: req.headers['content-type'] || null,
          length: req.headers['content-length'] || null,
          chunked: req.headers['transfer-encoding'] || null,
          body: body.startsWith('--') ? 'multipart:' + /name="f"\\r\\n\\r\\nv\\r\\n/.test(body) : body,
        }));
      case '/headers':
        res.writeHead(200, 'Fine', [
          ['set-cookie', 'a=1; Path=/'], ['set-cookie', 'b=2'], ['x-multi', 'one'], ['x-multi', 'two'],
        ]);
        return res.end(JSON.stringify({
          custom: req.headers['x-custom'], appended: req.headers['x-appended'],
          accept: req.headers['accept'], ua: req.headers['user-agent'], cookie: req.headers['cookie'] || null,
        }));
      case '/redirect': res.writeHead(302, { location: '/echo' }); return res.end();
      case '/see-other': res.writeHead(303, { location: '/echo' }); return res.end();
      case '/temp': res.writeHead(307, { location: '/echo' }); return res.end();
      case '/loop': res.writeHead(302, { location: '/loop' }); return res.end();
      case '/missing': res.writeHead(404); return res.end('nope');
      case '/empty': res.writeHead(204); return res.end();
      case '/stream':
        res.write('one');
        setTimeout(() => res.write('two'), 150);
        return setTimeout(() => res.end('three'), 300);
      case '/slow': return setTimeout(() => res.end('late'), 1500);
      default: res.writeHead(500); return res.end('unrouted ' + u.pathname);
    }
  });
}
exports.serve = (port) => new Promise((resolve) => {
  const s = http.createServer(handler);
  // No host: dual-stack, so the host Node's 'localhost' (which may be ::1) answers too.
  s.listen(port, () => resolve(s));
});
exports.stop = (s) => { s.close(); if (s.closeAllConnections) s.closeAllConnections(); };
if (require.main === module) {
  exports.serve(Number(process.argv[2])).then((s) => {
    console.log('READY ' + s.address().port);
    process.on('SIGTERM', () => exports.stop(s));
  });
}
`;

// Each scenario body runs with `base` (a same-process server's URL) and `out`
// (append one transcript line). Errors are reported by shape, never by stack.
const wrap = (body) => `const { serve, stop } = require('./server.js');
const lines = [];
const out = (...a) => lines.push(a.map((x) => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
const err = (e) => [e && e.name, e && e.message, e && e.cause && e.cause.message, e && e.cause && e.cause.code].join(' | ');
const pathOf = (u) => new URL(u).pathname;
(async () => {
  const s = await serve(0);
  const base = 'http://127.0.0.1:' + s.address().port;
  try {
${body}
  } catch (e) { out('THREW', err(e)); }
  stop(s);
  console.log(lines.map((l) => 'OUT ' + l).join('\\n'));
})();
`;

const SCENARIOS = [
  {
    name: "GET text: status, statusText, headers, body, url, redirected, type",
    body: `const r = await fetch(base + '/text');
    out(r.status, r.statusText, r.ok, r.headers.get('content-length'), pathOf(r.url), r.redirected, r.type);
    out(await r.text());`,
  },
  {
    name: "a localhost URL (not an IP literal) is routed in-VM too",
    body: `const r = await fetch(base.replace('127.0.0.1', 'localhost') + '/text');
    out(r.status, await r.text());`,
  },
  {
    name: "POST a JSON body: method, Content-Type, Content-Length, bytes echoed",
    body: `const r = await fetch(base + '/echo', { method: 'post', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 1, ü: 'ß' }) });
    out(r.status, r.headers.get('content-type'), await r.json());`,
  },
  {
    name: "request body types: string, Uint8Array, ArrayBuffer, Blob, URLSearchParams, FormData, ReadableStream",
    body: `const bodies = {
      string: 'plain',
      u8: new TextEncoder().encode('bytes'),
      ab: new TextEncoder().encode('buffer').buffer,
      blob: new Blob(['blob'], { type: 'text/x-blob' }),
      params: new URLSearchParams({ q: 'a b', n: '1' }),
      form: (() => { const f = new FormData(); f.append('f', 'v'); return f; })(),
    };
    for (const [k, b] of Object.entries(bodies)) {
      const j = await (await fetch(base + '/echo', { method: 'PUT', body: b })).json();
      if (k === 'form') j.type = j.type && j.type.split(';')[0];
      out(k, j);
    }
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('str')); c.enqueue(new TextEncoder().encode('eam')); c.close(); } });
    out('stream', await (await fetch(base + '/echo', { method: 'POST', body: stream, duplex: 'half' })).json());`,
  },
  {
    name: "headers round-trip: request headers arrive, multi-value response headers and Set-Cookie survive",
    body: `const h = new Headers({ 'X-Custom': 'v1' }); h.append('x-appended', 'a'); h.append('x-appended', 'b');
    const r = await fetch(base + '/headers', { headers: h });
    out(r.status, r.statusText, r.headers.get('x-multi'), r.headers.getSetCookie(), await r.json());
    const c = await fetch(base + '/headers', { headers: [['cookie', 'sid=1']] });
    out((await c.json()).cookie);`,
  },
  {
    name: "a Request object as input: method, headers and body are taken from it",
    body: `const req = new Request(base + '/echo', { method: 'PATCH', headers: { 'content-type': 'text/x-req' }, body: 'from-request' });
    out(await (await fetch(req)).json());`,
  },
  {
    name: "302 is followed: redirected=true, final url, POST turns into GET without its body",
    body: `const g = await fetch(base + '/redirect');
    out(g.status, g.redirected, pathOf(g.url), (await g.json()).method);
    const p = await fetch(base + '/redirect', { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } });
    out(p.status, p.redirected, await p.json());
    const s = await fetch(base + '/see-other', { method: 'PUT', body: 'x' });
    out('303', (await s.json()).method);
    const t = await fetch(base + '/temp', { method: 'POST', body: 'kept' });
    out('307', await t.json());`,
  },
  {
    name: "redirect: 'manual' returns the 3xx itself; 'error' rejects; a loop stops at 20",
    body: `const m = await fetch(base + '/redirect', { redirect: 'manual' });
    out(m.status, m.redirected, m.headers.get('location'), pathOf(m.url));
    try { await fetch(base + '/redirect', { redirect: 'error' }); out('no throw'); } catch (e) { out(err(e)); }
    try { await fetch(base + '/loop'); out('no throw'); } catch (e) { out(err(e)); }`,
  },
  {
    name: "404 and 204: status, ok, statusText, body",
    body: `const r = await fetch(base + '/missing');
    out(r.status, r.ok, r.statusText, await r.text());
    const e = await fetch(base + '/empty');
    out(e.status, e.statusText, e.body);
    const h = await fetch(base + '/text', { method: 'HEAD' });
    out('HEAD', h.status, h.headers.get('content-length'), h.body);`,
  },
  {
    name: "the body streams: getReader() sees each chunk as the server writes it",
    body: `const r = await fetch(base + '/stream');
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    const seen = [];
    for (;;) { const { value, done } = await reader.read(); if (done) break; seen.push(dec.decode(value)); }
    out(seen.join('|'));`,
  },
  {
    name: "AbortSignal: mid-request abort rejects with AbortError; a pre-aborted signal never sends",
    body: `const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const t0 = Date.now();
    try { await fetch(base + '/slow', { signal: ac.signal }); out('no throw'); } catch (e) { out(e.name, e.message, Date.now() - t0 < 1000); }
    try { await fetch(base + '/text', { signal: AbortSignal.abort() }); out('no throw'); } catch (e) { out(e.name, e.message); }
    const ac2 = new AbortController();
    const r = await fetch(base + '/stream', { signal: ac2.signal });
    const reader = r.body.getReader();
    await reader.read();
    ac2.abort();
    try { for (;;) { const { done } = await reader.read(); if (done) { out('ended'); break; } } } catch (e) { out('body', e.name); }`,
  },
  {
    name: "a port nobody listens on: TypeError('fetch failed') with cause.code ECONNREFUSED",
    body: `try { await fetch('http://127.0.0.1:${DEAD_PORT}/'); out('no throw'); }
    catch (e) { out(e.name, e.message, e.cause.code, e.cause.syscall, e.cause.address, e.cause.port); }`,
  },
  {
    name: "fetch-level TypeErrors: GET with a body, a stream body without duplex, CONNECT",
    body: `for (const init of [{ method: 'GET', body: 'x' }, { method: 'POST', body: new ReadableStream() }, { method: 'CONNECT' }]) {
      try { await fetch(base + '/text', init); out('no throw'); } catch (e) { out(e.name, e.message); }
    }`,
  },
  {
    name: "cross-process: a server in ANOTHER process is reachable",
    body: `const r = await fetch('http://localhost:' + process.argv[2] + '/text');
    out(r.status, await r.text());
    const h = await fetch('http://127.0.0.1:' + process.argv[2] + '/headers');
    out(h.headers.getSetCookie());`,
    crossProcess: true,
  },
];
const CROSS = SCENARIOS.findIndex((s) => s.crossProcess);

const files = { "server.js": SERVER };
for (const [i, s] of SCENARIOS.entries()) files[`s${i}.js`] = wrap(s.body);
const transcript = (stdout) =>
  (stdout || "")
    .split("\n")
    .filter((l) => l.startsWith("OUT "))
    .join("\n");

// ── on the host's real Node ──────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vv-fetch-loopback-"));
for (const [f, src] of Object.entries(files)) fs.writeFileSync(path.join(tmp, f), src);
const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
const hostPort = await freePort();
const hostServer = spawn(process.execPath, [path.join(tmp, "server.js"), String(hostPort)], { stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve) => {
  let buf = "";
  hostServer.stdout.on("data", (d) => {
    buf += d;
    if (buf.includes("READY")) resolve();
  });
});
const hostOut = [];
for (const [i] of SCENARIOS.entries()) {
  let out = "";
  try {
    const args = [path.join(tmp, `s${i}.js`)];
    if (i === CROSS) args.push(String(hostPort));
    out = transcript(execFileSync(process.execPath, args, { cwd: tmp, encoding: "utf8", timeout: 20000 }));
  } catch (e) {
    out = "HOST_FAILED: " + ((e && e.stderr) || e);
  }
  hostOut.push(out);
}
hostServer.kill("SIGTERM");

// ── and in the VM ────────────────────────────────────────────────────────────
const h = await bootSpikeKernel();
const DIR = "/t";
writeProject(h.kernel, DIR, files);
const VM_PORT = 3917; // the issue's port; the VM's network is its own
h.kernel.start("node", [`${DIR}/server.js`, String(VM_PORT)], { cwd: DIR });
{
  const t0 = Date.now();
  while (!h.out.join("").includes("READY " + VM_PORT) && Date.now() - t0 < 30000) await new Promise((r) => setTimeout(r, 50));
}
const runVm = (argv, ms = 30000) =>
  Promise.race([
    h.kernel.start("node", argv, { cwd: DIR, capture: true }),
    new Promise((r) => setTimeout(() => r({ code: "TIMEOUT", stdout: "", stderr: `no exit within ${ms}ms` }), ms)),
  ]);
const vmOut = [];
for (const [i] of SCENARIOS.entries()) {
  const argv = [`${DIR}/s${i}.js`];
  if (i === CROSS) argv.push(String(VM_PORT));
  const r = await runVm(argv);
  const t = transcript(r.stdout);
  vmOut.push(t || `VM_NO_OUTPUT (code=${r.code}) ${(r.stderr || "").split("\n").slice(0, 3).join(" / ")}`);
}

console.log("== the VM's fetch transcript matches real Node's, scenario by scenario ==");
for (const [i, s] of SCENARIOS.entries()) {
  const same = hostOut[i] === vmOut[i] && hostOut[i].startsWith("OUT ") && !hostOut[i].includes("OUT THREW");
  ok(same, s.name);
  if (!same || process.env.VV_LIVE === "1") {
    console.log("      host: " + hostOut[i].split("\n").join("\n            "));
    console.log("      vm:   " + vmOut[i].split("\n").join("\n            "));
  }
}

// ── the invariants, stated outright ──────────────────────────────────────────
console.log("\n== the invariants, stated outright ==");
{
  const [l0, l1] = vmOut[0].split("\n");
  ok(l0 && l0.startsWith("OUT 200 OK true") && l1 === 'OUT hello\n'.trim(), "GET reaches the in-VM server (issue #7)");
  ok(vmOut[CROSS].includes("OUT 200 hello"), "…including one in another process");
  ok(vmOut[11].includes("TypeError fetch failed ECONNREFUSED connect 127.0.0.1 " + DEAD_PORT), "a refused dial is TypeError('fetch failed') with cause ECONNREFUSED");
}
{
  writeProject(h.kernel, DIR, {
    "tls.js": `fetch('https://localhost:${VM_PORT}/text').then(
  () => console.log('RESOLVED'),
  (e) => console.log('TLS ' + e.name + ' ' + e.code + ' ' + /no TLS/.test(e.message) + ' ' + /http:\\/\\/localhost:${VM_PORT}\\/text/.test(e.message)));
`,
    // A non-local URL keeps the host path: undici headless, the tab's fetch in a
    // browser. `.invalid` never resolves, so this needs no network — and the
    // failure is explained exactly as before (explainFetchFailure).
    "outside.js": `fetch('http://vivari-spike.invalid/').then(
  () => console.log('RESOLVED'),
  (e) => console.log('OUTSIDE ' + e.name + ' ' + /browser tab/.test(e.message)));
`,
    // Nothing but the fetch holds the loop: the process must wait for it.
    "live.js": `fetch('http://127.0.0.1:${VM_PORT}/slow').then((r) => r.text()).then((t) => console.log('LIVE ' + t));
`,
  });
  const tls = await runVm([`${DIR}/tls.js`]);
  ok((tls.stdout || "").includes("TLS TypeError ERR_VIVARI_LOOPBACK_TLS true true"), "https to an in-VM host rejects with ERR_VIVARI_LOOPBACK_TLS and names the http:// URL to use");
  const outside = await runVm([`${DIR}/outside.js`], 60000);
  ok((outside.stdout || "").includes("OUTSIDE TypeError true"), "a non-local URL still takes the host's fetch, failure explained as before");
  const live = await runVm([`${DIR}/live.js`]);
  ok(live.code === 0 && (live.stdout || "").includes("LIVE late"), "an in-flight loopback fetch keeps the process alive with no timer");
}

// ── a redirect that leaves the VM hands the host only the guest's headers ────
// The in-VM hop sends undici's defaults (accept, accept-language, sec-fetch-mode,
// user-agent) so an in-VM server sees what real Node would send. The host path
// must not inherit them: in a browser they are headers the guest never set, and
// a non-safelisted one makes a plain GET preflight, so an external redirect could
// fail where a direct fetch works. Headless undici re-adds the same four with the
// same values, so a server cannot tell; this loads the real module on the host
// Node and observes what it hands `viaHost`.
console.log("\n== a redirect out of the VM hands the host path only the guest's headers ==");
{
  const { default: factory } = await import("../packages/runtime/node/internal/fetch-loopback.js");
  const mod = { exports: {} };
  const { createRequire } = await import("node:module");
  const hostRequire = createRequire(import.meta.url);
  const LOCAL = new Set(["127.0.0.1", "localhost"]);
  factory(mod.exports, (id) => hostRequire(id), mod, process, (name) =>
    name === "tcp_wrap" ? { isLocalDestination: (host) => LOCAL.has(String(host)) } : {},
  );
  const http = await import("node:http");
  const inVm = [];
  const server = http.createServer((req, res) => {
    inVm.push(req.headers);
    res.writeHead(302, { location: "http://outside.example/landing" });
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  let handed = null;
  const viaHost = async (url, init) => {
    handed = { url, headers: Object.fromEntries(new Headers(init.headers)) };
    return new Response("outside");
  };
  const r = await mod.exports.fetch(
    `http://127.0.0.1:${server.address().port}/go`,
    { headers: { "x-guest": "1", authorization: "Bearer t" } },
    viaHost,
  );
  server.close();
  const INJECTED = ["accept", "accept-language", "sec-fetch-mode", "user-agent"];
  ok(r.redirected === true && handed && handed.url === "http://outside.example/landing", "the redirect is handed to the host path");
  ok(inVm[0] && INJECTED.every((h) => h in inVm[0]), "the in-VM hop still carries undici's defaults");
  const leaked = handed ? INJECTED.filter((h) => h in handed.headers) : INJECTED;
  ok(leaked.length === 0, `the host path gets none of the injected defaults (leaked: ${leaked.join(", ") || "none"})`);
  ok(handed && handed.headers["x-guest"] === "1", "…but does get the guest's own header");
  ok(handed && !("authorization" in handed.headers), "…minus credentials, stripped for the cross-origin hop");
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* scratch */
}

console.log(`\nRESULT: ${failed === 0 ? "PASS — loopback fetch matches real Node" : `FAIL — ${failed} check(s)`}`);
process.exit(failed === 0 ? 0 : 1);