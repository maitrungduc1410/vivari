// Spike (OFFLINE): tls.connect to an outside host carries HTTP/1.1 over fetch.
//
// WHY THIS EXISTS. pnpm 11 bundles undici, which dials the registry itself with
// tls.connect and writes HTTP/1.1 into the socket. There is no TLS or raw socket
// in a browser tab, so tls.connect used to throw and every pnpm 11 install died on
// ERR_PNPM_META_FETCH_FAIL. internal/tls-http-egress.js answers the requests
// written into that socket through the same fetch transport https.request uses.
//
// HOW IT IS GATED. The kernel gets a stub fetcher, so this runs with no network and
// the spike sees exactly what reached the fetch layer. A guest writes raw requests
// the way an HTTP/1.1 client does (pipelined, split across writes, chunked and
// Content-Length bodies, HEAD, 204, Connection: close) and parses the bytes that
// come back. The refusals are checked too: non-HTTP bytes, a loopback host, a
// failed fetch. Real undici against the real registry is the net tier's job
// (spike-pnpm.mjs / spike-pnpm-studio.mjs run pnpm 11 through it).
//
//   run:  node scripts/spike-tls-egress.mjs

import { bootSpikeKernel } from "./lib/spike-harness.mjs";

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};

const calls = [];
const enc = new TextEncoder();
async function stubFetcher(url, init = {}) {
  const body = init.body ? new TextDecoder().decode(init.body) : null;
  calls.push({ url, method: init.method || "GET", headers: init.headers || {}, body });
  const u = new URL(url);
  if (u.hostname === "down.example") throw new Error("network down");
  const reply = (status, headers, text) => ({
    ok: status < 400,
    status,
    statusText: "",
    headers,
    body: enc.encode(text),
  });
  switch (u.pathname) {
    case "/a":
      // What the browser hands back for a gzipped body: decoded bytes, with the
      // original encoding and length still in the headers.
      return reply(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": "999" }, '{"a":1}');
    case "/b":
      return reply(200, { "content-type": "text/plain" }, "bee");
    case "/head":
      return reply(200, { "content-length": "42" }, "");
    case "/echo":
      return reply(201, { "content-type": "text/plain" }, "got:" + (body || ""));
    case "/empty":
      return reply(204, {}, "");
    case "/big":
      return reply(200, {}, "x".repeat(200000));
    default:
      return reply(404, {}, "nope");
  }
}

const h = await bootSpikeKernel({ fetcher: stubFetcher });
const { kernel } = h;
kernel.mkdirp("/app");

const GUEST = String.raw`
const tls = require("tls");

// Minimal HTTP/1.1 response reader: status, headers, Content-Length or chunked body.
function reader(sock) {
  let buf = Buffer.alloc(0);
  const waiting = [];
  let ended = false;
  sock.on("data", (d) => { buf = Buffer.concat([buf, d]); drain(); });
  sock.on("end", () => { ended = true; drain(); });
  function tryParse(isHead) {
    const end = buf.indexOf("\r\n\r\n");
    if (end < 0) return null;
    const lines = buf.toString("latin1", 0, end).split("\r\n");
    const status = Number(lines[0].split(" ")[1]);
    const headers = {};
    for (const l of lines.slice(1)) { const c = l.indexOf(":"); headers[l.slice(0, c).toLowerCase()] = l.slice(c + 1).trim(); }
    let rest = buf.subarray(end + 4);
    let body = "";
    const noBody = isHead || status === 204 || status === 304;
    if (!noBody && headers["transfer-encoding"] === "chunked") {
      const parts = [];
      for (;;) {
        const nl = rest.indexOf("\r\n");
        if (nl < 0) return null;
        const size = parseInt(rest.toString("latin1", 0, nl), 16);
        if (rest.length < nl + 2 + size + 2) return null;
        if (size === 0) { rest = rest.subarray(nl + 4); break; }
        parts.push(rest.subarray(nl + 2, nl + 2 + size));
        rest = rest.subarray(nl + 2 + size + 2);
      }
      body = Buffer.concat(parts).toString();
    } else if (!noBody && headers["content-length"]) {
      const n = Number(headers["content-length"]);
      if (rest.length < n) return null;
      body = rest.toString("utf8", 0, n);
      rest = rest.subarray(n);
    }
    buf = rest;
    return { status, headers, body };
  }
  function drain() {
    while (waiting.length) {
      const r = tryParse(waiting[0].head);
      if (!r) { if (ended) waiting.shift().reject(new Error("socket ended mid-response")); else return; }
      else waiting.shift().resolve(r);
    }
  }
  return (head) => new Promise((resolve, reject) => { waiting.push({ head, resolve, reject }); drain(); });
}

const log = (...a) => console.log(...a);
const errOf = (fn) => { try { fn(); return "no throw"; } catch (e) { return e.code; } };

(async () => {
  // 1) handshake surface + two pipelined GETs in ONE write, answered in order.
  let cbCalled = false;
  const s = tls.connect({ host: "reg.example", port: 8443, servername: "reg.example" }, () => { cbCalled = true; });
  await new Promise((r) => s.once("secureConnect", r));
  log("secureConnect cb=" + cbCalled + " alpn=" + s.alpnProtocol + " encrypted=" + s.encrypted);
  const next = reader(s);
  s.write("GET /a HTTP/1.1\r\nhost: reg.example\r\nx-custom: yes\r\n\r\nGET /b HTTP/1.1\r\nhost: reg.example\r\n\r\n");
  const a = await next(), b = await next();
  log("pipelined " + a.status + " " + a.body + " | " + b.status + " " + b.body);
  log("a: content-encoding=" + (a.headers["content-encoding"] || "-") + " content-length=" + (a.headers["content-length"] || "-") + " te=" + a.headers["transfer-encoding"] + " conn=" + a.headers["connection"]);

  // 2) a request split byte by byte, then a Content-Length body, then a chunked one.
  const raw = "GET /b HTTP/1.1\r\nhost: reg.example\r\n\r\n";
  for (const ch of raw) s.write(ch);
  log("split " + (await next()).body);
  s.write("POST /echo HTTP/1.1\r\nhost: reg.example\r\ncontent-length: 5\r\n\r\nhel");
  setTimeout(() => s.write("lo"), 20);
  const p1 = await next();
  log("content-length body " + p1.status + " " + p1.body);
  s.write("POST /echo HTTP/1.1\r\nhost: reg.example\r\ntransfer-encoding: chunked\r\n\r\n3\r\nabc\r\n4;ext=1\r\ndefg\r\n0\r\nx-trailer: 1\r\n\r\n");
  log("chunked body " + (await next()).body);

  // 3) HEAD keeps content-length, carries no body; 204 has none; the connection
  //    is still usable after both.
  s.write("HEAD /head HTTP/1.1\r\nhost: reg.example\r\n\r\n");
  const hd = await next(true);
  log("head " + hd.status + " content-length=" + hd.headers["content-length"] + " te=" + (hd.headers["transfer-encoding"] || "-"));
  s.write("GET /empty HTTP/1.1\r\nhost: reg.example\r\n\r\n");
  const e = await next();
  log("204 te=" + (e.headers["transfer-encoding"] || "-"));
  s.write("GET /big HTTP/1.1\r\nhost: reg.example\r\n\r\n");
  log("big " + (await next()).body.length);

  // 4) Connection: close ends the socket after the response.
  const ended = new Promise((r) => s.once("end", () => r("end")));
  s.write("GET /missing HTTP/1.1\r\nhost: reg.example\r\nconnection: close\r\n\r\n");
  const m = await next();
  log("close " + m.status + " conn=" + m.headers["connection"] + " -> " + (await ended));
  s.end();

  // 5) refusals.
  log("loopback " + errOf(() => tls.connect(443, "localhost")));
  log("127.0.0.1 " + errOf(() => tls.connect({ host: "127.0.0.1", port: 443 })));
  const bad = tls.connect(5432, "db.example");
  bad.on("error", (err) => log("not-http " + err.code));
  bad.write(Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]));
  await new Promise((r) => bad.once("close", r));

  const down = tls.connect(443, "down.example");
  const downErr = new Promise((r) => down.once("error", (err) => r(err.code + " " + /network down/.test(err.message))));
  down.write("GET / HTTP/1.1\r\nhost: down.example\r\n\r\n");
  log("fetch failure " + (await downErr));
  log("DONE");
})().catch((e) => { console.log("GUEST FAILED " + (e && e.stack || e)); process.exitCode = 1; });
`;
kernel.writeFile("/app/guest.js", GUEST);

console.log("== tls.connect HTTP/1.1 egress ==");
const r = await Promise.race([
  kernel.start("node", ["/app/guest.js"], { cwd: "/app", env: { HOME: "/home/user", PATH: "/bin" }, capture: true }),
  new Promise((res) => setTimeout(() => res({ code: 124, stdout: "", stderr: "TIMEOUT (a request was never answered, or the socket held the loop)" }), 60000)),
]);
const out = r.stdout || "";
console.log(out.replace(/^/gm, "    | "));
if (r.stderr && r.stderr.trim()) console.log("  stderr:\n" + r.stderr.trim());

ok(r.code === 0 && /\nDONE/.test("\n" + out), "the guest ran to the end and exited 0 (exit " + r.code + ")");
ok(/secureConnect cb=true alpn=http\/1\.1 encrypted=true/.test(out), "secureConnect fires, the connect callback runs, ALPN is http/1.1");
ok(/pipelined 200 \{"a":1\} \| 200 bee/.test(out), "two requests written in one write are answered in order");
ok(/a: content-encoding=- content-length=- te=chunked conn=keep-alive/.test(out), "the decoded body goes out chunked, without the encoding and length that described the gzipped one");
ok(/split bee/.test(out), "a request written one byte at a time is parsed");
ok(/content-length body 201 got:hello/.test(out), "a Content-Length body arriving in two writes reaches the fetch");
ok(/chunked body got:abcdefg/.test(out), "a chunked request body (with an extension and a trailer) reaches the fetch decoded");
ok(/head 200 content-length=undefined te=-/.test(out), "HEAD sends no body (Content-Length is stripped kernel-wide, as for https.request)");
ok(/204 te=-/.test(out), "a 204 sends no body and the connection keeps working");
ok(/big 200000/.test(out), "a 200 KB body arrives whole");
ok(/close 404 conn=close -> end/.test(out), "Connection: close ends the socket after its response");
ok(/loopback ERR_VIVARI_LOOPBACK_TLS/.test(out) && /127\.0\.0\.1 ERR_VIVARI_LOOPBACK_TLS/.test(out), "a loopback host is refused, not sent to the user's real machine");
ok(/not-http ERR_VIVARI_TLS_NOT_HTTP/.test(out), "bytes that are not an HTTP request destroy the socket with a named error");
// (The async fetch path sets err.code to the fetcher's message, so the code here
// is "network down"; that is the transport's existing behaviour, shared with
// https.request, not something this socket adds.)
ok(/fetch failure .+ true/.test(out), "a failed fetch destroys the socket with an error carrying the fetch's reason");

const first = calls.find((c) => c.url.endsWith("/a"));
ok(!!first && first.url === "https://reg.example:8443/a", "the URL carries the host and non-default port the socket dialled (" + (first && first.url) + ")");
const hdr = first && Object.fromEntries(Object.entries(first.headers).map(([k, v]) => [k.toLowerCase(), v]));
ok(!!hdr && hdr["x-custom"] === "yes" && !("host" in hdr), "request headers are forwarded, minus the ones fetch owns");
const posts = calls.filter((c) => c.method === "POST").map((c) => c.body);
ok(posts.join(",") === "hello,abcdefg", "both POST bodies reached the fetch layer intact (" + posts.join(",") + ")");

console.log(failed ? `\nFAIL: ${failed} check(s)` : "\nPASS: tls.connect carries HTTP/1.1 over fetch");
process.exit(failed ? 1 : 0);
