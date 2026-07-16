// Spike (OFFLINE, fast): guard the llhttp-in-Wasm HTTP parser so a regression in
// the Wasm bridge (bad vendored binary, drifted callback arity, broken fallback)
// is caught in CI instead of surfacing as mysterious in-browser HTTP breakage.
//
// Node allows synchronous WebAssembly compilation on any thread, so we can
// exercise the real Wasm bridge here without booting the kernel/VFS.
//
// Gates (all must pass):
//   1. The Wasm backend instantiates (backend === 'wasm', version recorded).
//   2. Method numbers round-trip through allMethods (GET/POST/...).
//   3. Request parsing: request line + headers + Content-Length body.
//   4. Chunked request body reassembled across split execute() calls.
//   5. Response parsing: status/keep-alive + pipelined second response.
//   6. HEAD/skip-body (headersComplete -> 1) completes with no body.
//   7. Upgrade (headersComplete -> 2) returns the header byte count (head split).
//   8. Malformed input returns an Error (HPE_*), never throws.
//   9. EOF-delimited body completes on finish().
//  10. Trailers surface on parser._headers for lib/_http_common.
//  11. The pure-JS fallback is selectable (VV_HTTP_PARSER=js) and still parses.
//
//   run:  node scripts/spike-http-llhttp.mjs

import { createLlhttpBinding } from "../packages/runtime/node/bindings/llhttp/llhttp-parser.js";
import { createHttpParserBinding } from "../packages/runtime/node/bindings/http_parser.js";

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ok   " : "  FAIL ") + msg);
  if (!cond) failures++;
};

const { methods, allMethods, HTTPParser, backend, llhttpVersion } = createLlhttpBinding();

// --- 1. backend + 2. method table --------------------------------------------
ok(backend === "wasm", "llhttp Wasm backend instantiated (version " + llhttpVersion + ")");
ok(methods.length >= 47, "method table populated (" + methods.length + " methods)");
ok(allMethods[1] === "GET" && allMethods[3] === "POST" && allMethods[0] === "DELETE"
  && allMethods[allMethods.length - 1] === "QUERY",
  "method numbers round-trip (GET=1, POST=3, DELETE=0, QUERY=last)");

function newParser(type) {
  const p = new HTTPParser();
  p._headers = []; // lib/_http_common seeds this via cleanParser; mimic for trailers
  const ev = { headers: null, meta: null, body: [], complete: 0 };
  p.initialize(type, {}, 80 * 1024, 0);
  p[HTTPParser.kOnHeadersComplete] = function (major, minor, headers, method, url, sc, sm, upgrade, ka) {
    ev.headers = headers;
    ev.meta = { major, minor, method, url, sc, sm, upgrade, ka };
    return 0;
  };
  p[HTTPParser.kOnBody] = function (b) {
    ev.body.push(Buffer.from(b));
  };
  p[HTTPParser.kOnMessageComplete] = function () {
    ev.complete++;
  };
  return { p, ev };
}

// --- 3. request + Content-Length ---------------------------------------------
{
  const { p, ev } = newParser(HTTPParser.REQUEST);
  const msg = "POST /submit?x=1 HTTP/1.1\r\nHost: e.com\r\nContent-Length: 5\r\n\r\nhello";
  const r = p.execute(Buffer.from(msg));
  ok(r === msg.length, "request: consumed the whole buffer");
  ok(ev.meta && allMethods[ev.meta.method] === "POST" && ev.meta.url === "/submit?x=1",
    "request: method + url parsed");
  ok(JSON.stringify(ev.headers) === JSON.stringify(["Host", "e.com", "Content-Length", "5"]),
    "request: header pairs flattened in order");
  ok(Buffer.concat(ev.body).toString() === "hello" && ev.complete === 1,
    "request: Content-Length body + message complete");
}

// --- 4. chunked request, split across execute() ------------------------------
{
  const { p, ev } = newParser(HTTPParser.REQUEST);
  const a = "PUT /x HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel";
  const b = "lo\r\n6\r\n world\r\n0\r\n\r\n";
  const r1 = p.execute(Buffer.from(a));
  const r2 = p.execute(Buffer.from(b));
  ok(r1 === a.length && r2 === b.length, "chunked: both partial buffers consumed");
  ok(Buffer.concat(ev.body).toString() === "hello world" && ev.complete === 1,
    "chunked: body reassembled across chunks");
}

// --- 5. response keep-alive + pipelined ---------------------------------------
{
  const { p, ev } = newParser(HTTPParser.RESPONSE);
  const msg =
    "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nhi" +
    "HTTP/1.1 404 Not Found\r\nContent-Length: 3\r\n\r\nbye";
  const r = p.execute(Buffer.from(msg));
  ok(r === msg.length && ev.complete === 2, "response: two pipelined responses completed");
  ok(ev.meta.sc === 404 && ev.meta.sm === "Not Found", "response: status code + message parsed");
  ok(Buffer.concat(ev.body).toString() === "hibye", "response: both bodies delivered");
}

// --- 6. HEAD / skip-body ------------------------------------------------------
{
  const p = new HTTPParser();
  p.initialize(HTTPParser.RESPONSE, {}, 80 * 1024, 0);
  let bodyLen = 0, complete = 0;
  p[HTTPParser.kOnHeadersComplete] = () => 1; // skip body
  p[HTTPParser.kOnBody] = (b) => (bodyLen += b.length);
  p[HTTPParser.kOnMessageComplete] = () => complete++;
  const msg = "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n";
  const r = p.execute(Buffer.from(msg));
  ok(r === msg.length && bodyLen === 0 && complete === 1, "HEAD: skip-body completes with no body");
}

// --- 7. upgrade ---------------------------------------------------------------
{
  const p = new HTTPParser();
  p.initialize(HTTPParser.REQUEST, {}, 80 * 1024, 0);
  let upgrade = false;
  p[HTTPParser.kOnHeadersComplete] = (a, b, h, m, u, sc, sm, up) => {
    upgrade = up;
    return 2;
  };
  const head = "GET /ws HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n";
  const r = p.execute(Buffer.from(head + "FRAMEDATA"));
  ok(upgrade === true && r === head.length,
    "upgrade: flag set + returns header byte count (leftover is the head arg)");
}

// --- 8. malformed => Error ----------------------------------------------------
{
  const p = new HTTPParser();
  p.initialize(HTTPParser.REQUEST, {}, 80 * 1024, 0);
  const r = p.execute(Buffer.from("GET / GARBAGE\r\n\r\n"));
  ok(r instanceof Error && String(r.code).startsWith("HPE_"), "malformed: returns HPE_ Error (no throw)");
}

// --- 9. EOF body + finish() ---------------------------------------------------
{
  const { p, ev } = newParser(HTTPParser.RESPONSE);
  p.execute(Buffer.from("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\nstreamed"));
  const before = ev.complete;
  const fr = p.finish();
  ok(before === 0 && fr === 0 && ev.complete === 1 && Buffer.concat(ev.body).toString() === "streamed",
    "EOF: body completes only on finish()");
}

// --- 10. trailers -------------------------------------------------------------
{
  const { p } = newParser(HTTPParser.RESPONSE);
  const msg =
    "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nTrailer: X-Sum\r\n\r\n" +
    "4\r\ndata\r\n0\r\nX-Sum: 42\r\n\r\n";
  p.execute(Buffer.from(msg));
  ok(JSON.stringify(p._headers) === JSON.stringify(["X-Sum", "42"]),
    "trailers: surfaced on parser._headers for _http_common");
}

// --- 11. fallback selection ---------------------------------------------------
{
  const prev = process.env.VV_HTTP_PARSER;
  process.env.VV_HTTP_PARSER = "js";
  const jsBinding = createHttpParserBinding();
  ok(jsBinding.backend === "js", "VV_HTTP_PARSER=js selects the pure-JS parser");
  // the JS parser still parses a basic request
  const jp = new jsBinding.HTTPParser();
  jp.initialize(jsBinding.HTTPParser.REQUEST, {}, 80 * 1024, 0);
  let jsUrl = null;
  jp[jsBinding.HTTPParser.kOnHeadersComplete] = (a, b, h, m, u) => { jsUrl = u; return 0; };
  jp.execute(Buffer.from("GET /fallback HTTP/1.1\r\nHost: e\r\n\r\n"));
  ok(jsUrl === "/fallback", "pure-JS fallback parses a request");

  if (prev === undefined) delete process.env.VV_HTTP_PARSER;
  else process.env.VV_HTTP_PARSER = prev;
  const autoBinding = createHttpParserBinding();
  ok(autoBinding.backend === "wasm", "default selection prefers the Wasm backend");
}

console.log("\nRESULT: " + (failures === 0 ? "PASS — llhttp Wasm parser + fallback intact" : `FAIL — ${failures} check(s) failed`));
process.exit(failures === 0 ? 0 : 1);
