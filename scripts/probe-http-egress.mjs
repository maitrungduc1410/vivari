// Probe: plain-http egress (http.request/get to a destination the virtual
// network cannot serve) and the loopback-vs-egress split that decides it.
//
// Vivari's `net` is a loopback-only virtual network, so `http://` to an outside
// host had no route: the vendored client ends at net.createConnection, which now
// (correctly) fails with EHOSTUNREACH/ENOTFOUND for anything that is not this
// machine. `https` has always egressed over the Fetcher Worker instead. This
// probe covers the seam that gives `http` the same egress
// (internal/http-egress.js + internal/fetch-transport.js):
//
//   1) ROUTING — for a table of destinations, which branch does http.request
//      take? Cross-checked against an INDEPENDENT oracle: a real net.connect()
//      through the same tcp_wrap binding. Egress must happen exactly where
//      connect() refuses the destination as "not this machine" (EHOSTUNREACH /
//      ENOTFOUND) and never where it would connect or report ECONNREFUSED.
//   2) IN-VM SERVER + LOOPBACK CLIENT — a real http.createServer() on a real
//      loopback port, driven end-to-end through the real net/llhttp path, with
//      the stub fetcher asserted untouched.
//   3) TRANSLATION — with a stubbed __ocfetch: method, headers (forbidden ones
//      stripped), request body, and the http.IncomingMessage contract
//      (statusCode/statusMessage/headers/rawHeaders/data/end/complete).
//   4) HONEST FAILURES — a protocol upgrade, a CONNECT tunnel, and a runtime with
//      no fetcher at all must each produce a real error, not a hang or a lie.
//
// It needs neither the Rust/Wasm VFS nor a browser: the vendored Node tree is
// loaded directly (like probe-node-registry.mjs), over an in-memory syscall stub,
// and the event loop is a hand-drained nextTick queue.
//
//   node scripts/probe-http-egress.mjs

import { createNodeModules } from "../packages/runtime/node/loader.js";

// The host's real timers, captured once: makeVm() replaces the globals with a
// deterministic queue, so a later VM must not capture an earlier VM's fake.
const HOST_SET_TIMEOUT = globalThis.setTimeout;

let failed = 0;
const ok = (cond, msg, extra) => {
  console.log((cond ? "  \u2713 " : "  \u2717 ") + msg);
  if (!cond) {
    failed++;
    if (extra !== undefined) console.log("      " + String(extra).split("\n").join("\n      "));
  }
};
const section = (t) => console.log("\n" + t);

// ---------------------------------------------------------------------------
// An in-memory stand-in for the Rust VFS, exposing the `sys` surface
// bindings/fs.js calls. Only what a fetched body needs: whole-file read/write
// plus stat/open/read/close.
// ---------------------------------------------------------------------------
function makeVfs() {
  const files = new Map(); // path -> Uint8Array
  const dirs = new Set(["/", "/var", "/var/cache", "/var/cache/vv-fetch"]);
  const fds = new Map();
  let nextFd = 10;
  const enoent = (p) => {
    const e = new Error("ENOENT: " + p);
    e.code = "ENOENT";
    return e;
  };
  const statOf = (p) => {
    if (files.has(p)) return { kind: "file", size: files.get(p).length, mode: 0o644, ino: 1, mtimeMs: 0, nlink: 1 };
    if (dirs.has(p)) return { kind: "dir", size: 0, mode: 0o755, ino: 2, mtimeMs: 0, nlink: 1 };
    throw enoent(p);
  };
  return {
    files,
    sys: {
      exists: (p) => files.has(p) || dirs.has(p),
      stat: statOf,
      lstat: statOf,
      readFile: (p) => {
        if (!files.has(p)) throw enoent(p);
        return files.get(p);
      },
      writeFile: (p, bytes) => {
        files.set(p, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
      },
      open: (p, flags) => {
        const creating = (flags & 0o100) !== 0 || (flags & 1) !== 0 || (flags & 2) !== 0;
        if (!files.has(p) && !creating) throw enoent(p);
        if (!files.has(p)) files.set(p, new Uint8Array(0));
        const fd = nextFd++;
        fds.set(fd, { path: p, pos: 0 });
        return fd;
      },
      close: (fd) => void fds.delete(fd),
      fstat: (fd) => statOf(fds.get(fd).path),
      fdRead: (fd, len, at) => {
        const h = fds.get(fd);
        const data = files.get(h.path) || new Uint8Array(0);
        const from = at >= 0 ? at : h.pos;
        const slice = data.subarray(from, Math.min(data.length, from + len));
        if (at < 0) h.pos = from + slice.length;
        return slice;
      },
      fdWrite: (fd, bytes) => {
        const h = fds.get(fd);
        const prev = files.get(h.path) || new Uint8Array(0);
        const next = new Uint8Array(prev.length + bytes.length);
        next.set(prev);
        next.set(bytes, prev.length);
        files.set(h.path, next);
        return bytes.length;
      },
      mkdir: (p) => void dirs.add(p),
      readdir: () => [],
      unlink: (p) => void files.delete(p),
      rmdir: (p) => void dirs.delete(p),
      rename: () => {},
      symlink: () => {},
      readlink: () => {
        throw enoent("readlink");
      },
      link: () => {},
      ftruncate: () => {},
    },
  };
}

// ---------------------------------------------------------------------------
// One "process": the vendored Node tree over the stub VFS, with a hand-drained
// nextTick queue standing in for the event loop.
// ---------------------------------------------------------------------------
function makeVm() {
  const ticks = [];
  const timers = [];
  const vfs = makeVfs();
  const proc = {
    nextTick: (fn, ...a) => ticks.push(() => fn(...a)),
    env: {},
    argv: ["node"],
    argv0: "node",
    execPath: "/usr/bin/node",
    platform: "linux",
    arch: "wasm32",
    version: "v24.18.0",
    versions: { node: "24.18.0", v8: "12.0" },
    pid: 42,
    cwd: () => "/",
    chdir: () => {},
    umask: () => 0o022,
    emitWarning: () => {},
    hrtime: Object.assign(() => [0, 0], { bigint: () => 0n }),
    uptime: () => 0,
    exit: () => {},
    on: () => proc,
    once: () => proc,
    off: () => proc,
    addListener: () => proc,
    removeListener: () => proc,
    prependListener: () => proc,
    prependOnceListener: () => proc,
    listeners: () => [],
    listenerCount: () => 0,
    emit: () => false,
    domain: null,
    _rawDebug: () => {},
  };
  const liveness = { active: 0 };
  const mods = createNodeModules({
    process: proc,
    syscalls: vfs.sys,
    netLiveness: liveness,
    netServers: { count: 0 },
  });
  // The vendored tree reaches for host timers through the globals; a
  // fake-but-ordered queue keeps the run deterministic.
  globalThis.setTimeout = (fn, _ms, ...a) => {
    const t = { fn: () => fn(...a), cancelled: false };
    timers.push(t);
    return { unref: () => t, ref: () => t, close: () => (t.cancelled = true), _t: t };
  };
  globalThis.clearTimeout = (h) => {
    if (h && h._t) h._t.cancelled = true;
  };
  globalThis.setImmediate = (fn, ...a) => proc.nextTick(fn, ...a);
  globalThis.clearImmediate = () => {};

  // Drain ticks (and then due timers) until quiescent. Everything in this probe
  // is synchronous-with-nextTick, so this is the whole event loop.
  const drain = (rounds = 200) => {
    for (let i = 0; i < rounds; i++) {
      let ran = false;
      while (ticks.length) {
        ran = true;
        ticks.shift()();
      }
      if (timers.length) {
        const t = timers.shift();
        if (!t.cancelled) {
          ran = true;
          t.fn();
        }
      }
      if (!ran) return;
    }
  };
  // Promise continuations land in the microtask queue, which only runs when the
  // host yields — so alternate real awaits with tick drains.
  const settle = async (rounds = 40) => {
    for (let i = 0; i < rounds; i++) {
      drain();
      await new Promise((r) => HOST_SET_TIMEOUT(r, 0));
      drain();
    }
  };
  return { mods, proc, vfs, drain, settle, liveness };
}

// A stubbed Fetcher Worker: records every request and materializes the response
// body in the stub VFS exactly as the kernel does (meta.path).
function installFetchStub(vm, { respond } = {}) {
  const calls = [];
  let seq = 0;
  const handle = (url, init) => {
    calls.push({ url, init: init || null });
    const r = (respond || (() => ({ status: 200, body: "ok" })))(url, init) || {};
    if (r.throw) throw r.throw;
    const path = "/var/cache/vv-fetch/resp-" + ++seq;
    const body = typeof r.body === "string" ? new TextEncoder().encode(r.body) : r.body || new Uint8Array(0);
    vm.vfs.sys.writeFile(path, body);
    return {
      status: r.status ?? 200,
      statusText: r.statusText ?? "",
      ok: (r.status ?? 200) < 400,
      headers: r.headers || {},
      contentType: (r.headers && r.headers["content-type"]) || "",
      size: body.length,
      path,
      cached: false,
    };
  };
  globalThis.__ocfetch = handle;
  globalThis.__ocfetchAsync = (url, init) => {
    try {
      return Promise.resolve(handle(url, init));
    } catch (e) {
      return Promise.reject(e);
    }
  };
  return calls;
}
const clearFetchStub = () => {
  delete globalThis.__ocfetch;
  delete globalThis.__ocfetchAsync;
};

console.log("plain-http egress probe \u2014 stubbed __ocfetch, in-memory VFS (no browser, no network)");

// ===========================================================================
// 1. ROUTING: which branch does each destination take?
// ===========================================================================
section("routing predicate \u2014 http.request branch vs. what net.connect() does");
{
  const vm = makeVm();
  const http = vm.mods.require("http");
  const net = vm.mods.require("net");
  const tcp = vm.mods.internalBinding("tcp_wrap");

  ok(typeof tcp.isLocalDestination === "function", "tcp_wrap exposes the binding's own isLocalDestination");

  // An in-VM server so one row of the table is a genuinely served loopback port.
  const server = http.createServer((req, res) => res.end("in-vm:" + req.url));
  server.listen(3000, "127.0.0.1");
  vm.drain();

  // The independent oracle: dial the destination with the real net stack and see
  // what the loopback network itself says.
  const netVerdict = (host, port) =>
    new Promise((resolve) => {
      const s = net.connect({ host, port });
      const done = (v) => {
        try {
          s.destroy();
        } catch {
          /* already gone */
        }
        resolve(v);
      };
      s.on("connect", () => done("connect"));
      s.on("error", (e) => done(e.code || "ERR"));
    });

  const DESTS = [
    { host: "127.0.0.1", port: 3000, note: "loopback IP, in-VM listening port" },
    { host: "127.0.0.1", port: 9999, note: "loopback IP, nothing listening" },
    { host: "localhost", port: 3000, note: "loopback name, in-VM listening port" },
    { host: "localhost", port: 9999, note: "loopback name, nothing listening" },
    { host: "127.0.0.5", port: 3000, note: "127.0.0.0/8 (whole loopback net)" },
    { host: "::1", port: 3000, note: "IPv6 loopback" },
    { host: "0.0.0.0", port: 3000, note: "unspecified = this host" },
    { host: "vivari", port: 3000, note: "os.hostname() = itself" },
    { host: "app.localhost", port: 3000, note: ".localhost subdomain" },
    { host: "192.168.1.7", port: 8080, note: "LAN address" },
    { host: "10.0.0.3", port: 80, note: "private-range address" },
    { host: "registry.corp.internal", port: 8080, note: "corporate mirror by name" },
    { host: "registry.npmjs.org", port: 80, note: "public host" },
    { host: "host.vivari.internal", port: 5173, note: "the fetcher's host-machine alias" },
  ];

  const rows = [];
  for (const d of DESTS) {
    const calls = installFetchStub(vm, { respond: () => ({ status: 200, body: "egress" }) });
    let branch = "net";
    let outcome = "";
    await new Promise((resolve) => {
      const req = http.request({ host: d.host, port: d.port, path: "/" }, (res) => {
        res.resume();
        res.on("end", () => {
          outcome = "response " + res.statusCode;
          resolve();
        });
      });
      req.on("error", (e) => {
        outcome = e.code || "ERR";
        resolve();
      });
      req.end();
      vm.drain();
      // The async egress settles through a promise; give it real turns.
      (async () => {
        await vm.settle(6);
        resolve();
      })();
    });
    vm.drain();
    if (calls.length) branch = "egress";
    clearFetchStub();
    rows.push({ ...d, branch, outcome, net: await netVerdict(d.host, d.port), url: calls[0] && calls[0].url });
    vm.drain();
  }

  const pad = (s, n) => String(s).padEnd(n);
  console.log(
    "\n  " + pad("destination", 34) + pad("http branch", 13) + pad("http outcome", 16) + pad("net.connect()", 15) + "note",
  );
  console.log("  " + "-".repeat(105));
  for (const r of rows) {
    console.log(
      "  " +
        pad(r.host + ":" + r.port, 34) +
        pad(r.branch, 13) +
        pad(r.outcome, 16) +
        pad(r.net, 15) +
        r.note,
    );
  }
  console.log("");

  // The contract: egress happens exactly where the virtual network refuses the
  // destination as "not this machine", and nowhere else.
  const refused = new Set(["EHOSTUNREACH", "ENOTFOUND"]);
  const disagree = rows.filter((r) => (r.branch === "egress") !== refused.has(r.net));
  ok(
    disagree.length === 0,
    "http egresses exactly where net.connect() refuses the destination (" + rows.length + " destinations)",
    disagree.map((r) => `${r.host}:${r.port} → http:${r.branch} net:${r.net}`).join("\n"),
  );

  const loopback = rows.filter((r) => !refused.has(r.net));
  ok(
    loopback.every((r) => r.branch === "net"),
    "every loopback destination stays on the real net path (" + loopback.length + " rows)",
  );
  ok(
    rows.filter((r) => r.host === "127.0.0.1" && r.port === 9999)[0].outcome === "ECONNREFUSED",
    "an in-VM port with nothing listening still reports ECONNREFUSED \u2014 not egress",
  );
  ok(
    rows.filter((r) => r.host === "127.0.0.1" && r.port === 3000)[0].outcome === "response 200",
    "the in-VM listening port is served by the in-VM server over the real net path",
  );
  const hostAlias = rows.find((r) => r.host === "host.vivari.internal");
  ok(
    hostAlias.branch === "egress" && hostAlias.url === "http://host.vivari.internal:5173/",
    "the fetcher's host-machine alias egresses, URL intact",
    hostAlias.url,
  );
  const lan = rows.find((r) => r.host === "192.168.1.7");
  ok(lan.branch === "egress" && lan.url === "http://192.168.1.7:8080/", "a LAN address egresses", lan.url);

  server.close();
  vm.drain();
}

// ===========================================================================
// 2. The three things that must not break
// ===========================================================================
section("in-VM server + loopback client (the case that must not regress)");
{
  const vm = makeVm();
  const http = vm.mods.require("http");
  const calls = installFetchStub(vm);

  let seenBody = "";
  const server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      seenBody = b;
      res.writeHead(201, { "content-type": "text/plain", "x-served-by": "in-vm" });
      res.end("hello " + req.method + " " + req.url);
    });
  });
  server.listen(4321, "127.0.0.1");
  vm.drain();
  ok(server.listening === true, "http.createServer().listen() works untouched");

  const got = await new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: 4321, path: "/x", method: "POST" }, (res) => {
      let b = "";
      res.on("data", (d) => (b += d));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on("error", (e) => resolve({ err: e.code || e.message }));
    req.end("payload");
    vm.drain();
  });
  vm.drain();

  ok(got.status === 201 && got.body === "hello POST /x", "loopback client reached the in-VM server", JSON.stringify(got));
  ok(seenBody === "payload", "the request body arrived over the real net path", seenBody);
  ok(got.headers && got.headers["x-served-by"] === "in-vm", "response came from the in-VM server, not the fetcher");
  ok(calls.length === 0, "the Fetcher Worker was never called for loopback (" + calls.length + " calls)");

  server.close();
  vm.drain();
  clearFetchStub();
}

// ===========================================================================
// 3. TRANSLATION: request out, IncomingMessage back
// ===========================================================================
section("egress translation \u2014 request/response over the stubbed fetcher");
{
  const vm = makeVm();
  const http = vm.mods.require("http");
  const calls = installFetchStub(vm, {
    respond: () => ({
      status: 201,
      statusText: "Created",
      headers: { "content-type": "application/json", etag: 'W/"abc"' },
      body: '{"ok":true}',
    }),
  });

  const res = await new Promise((resolve) => {
    const req = http.request(
      {
        method: "POST",
        host: "registry.corp.internal",
        port: 8080,
        path: "/-/api?x=1",
        headers: {
          "content-type": "application/json",
          "user-agent": "probe/1",
          host: "should-be-dropped",
          connection: "keep-alive",
          "content-length": "17",
          "accept-encoding": "gzip",
        },
      },
      (r) => {
        let body = "";
        r.on("data", (d) => (body += d));
        r.on("end", () =>
          resolve({
            statusCode: r.statusCode,
            statusMessage: r.statusMessage,
            headers: r.headers,
            rawHeaders: r.rawHeaders,
            httpVersion: r.httpVersion,
            complete: r.complete,
            body,
          }),
        );
      },
    );
    req.on("error", (e) => resolve({ err: e.message }));
    req.write('{"name":');
    req.end('"x"}');
    vm.settle(8).then(resolve, resolve);
  });
  vm.drain();

  ok(calls.length === 1, "exactly one fetch was issued", calls.length);
  const c = calls[0] || { init: {} };
  ok(c.url === "http://registry.corp.internal:8080/-/api?x=1", "URL rebuilt from options", c.url);
  ok(c.init.method === "POST", "method carried", c.init.method);
  ok(
    Buffer.from(c.init.bodyB64 || "", "base64").toString() === '{"name":"x"}',
    "streamed request body buffered and carried as base64",
    Buffer.from(c.init.bodyB64 || "", "base64").toString(),
  );
  const h = c.init.headers || {};
  ok(h["user-agent"] === "probe/1" && h["content-type"] === "application/json", "caller headers carried", JSON.stringify(h));
  ok(
    !("host" in h) && !("connection" in h) && !("content-length" in h) && !("accept-encoding" in h),
    "fetch-forbidden headers stripped",
    JSON.stringify(h),
  );
  ok(res.statusCode === 201 && res.statusMessage === "Created", "status + statusMessage", res.statusCode + " " + res.statusMessage);
  ok(res.headers && res.headers.etag === 'W/"abc"', "response headers surfaced", JSON.stringify(res.headers));
  ok(Array.isArray(res.rawHeaders) && res.rawHeaders.includes("content-type"), "rawHeaders present");
  ok(res.body === '{"ok":true}', "body streamed out of the VFS", res.body);
  ok(res.complete === true && res.httpVersion === "1.1", "IncomingMessage contract (complete, httpVersion)");

  // statusMessage falls back to the STATUS_CODES table when the fetcher gives none.
  clearFetchStub();
  const calls2 = installFetchStub(vm, { respond: () => ({ status: 404, body: "" }) });
  const res2 = await new Promise((resolve) => {
    const req = http.get("http://example.com/missing", (r) => {
      r.resume();
      r.on("end", () => resolve({ code: r.statusCode, msg: r.statusMessage }));
    });
    req.on("error", (e) => resolve({ err: e.message }));
    vm.settle(8).then(resolve, resolve);
  });
  vm.drain();
  ok(calls2.length === 1 && res2.code === 404 && res2.msg === "Not Found", "http.get + STATUS_CODES fallback", JSON.stringify(res2));

  // A default port must not appear in the URL.
  clearFetchStub();
  const calls3 = installFetchStub(vm);
  await new Promise((resolve) => {
    const req = http.get({ host: "example.com", path: "/p" }, (r) => {
      r.resume();
      r.on("end", resolve);
    });
    req.on("error", resolve);
    vm.settle(6).then(resolve, resolve);
  });
  vm.drain();
  ok(calls3[0] && calls3[0].url === "http://example.com/p", "default port 80 omitted from the URL", calls3[0] && calls3[0].url);

  // Node also accepts options.headers as a raw list, in two shapes.
  for (const [shape, headers] of [
    ["flat", ["x-a", "1", "x-b", "2"]],
    ["pairs", [["x-a", "1"], ["x-b", "2"]]],
  ]) {
    clearFetchStub();
    const c4 = installFetchStub(vm);
    await new Promise((resolve) => {
      const req = http.get({ host: "example.com", path: "/", headers }, (r) => {
        r.resume();
        r.on("end", resolve);
      });
      req.on("error", resolve);
      vm.settle(6).then(resolve, resolve);
    });
    vm.drain();
    const h4 = (c4[0] && c4[0].init.headers) || {};
    ok(h4["x-a"] === "1" && h4["x-b"] === "2" && !("0" in h4), "raw " + shape + " header list carried, not indexed", JSON.stringify(h4));
  }

  // An IPv6 literal destination must survive the round trip through the URL.
  clearFetchStub();
  const c5 = installFetchStub(vm);
  await new Promise((resolve) => {
    const req = http.get({ host: "2606:4700::1111", port: 8080, path: "/" }, (r) => {
      r.resume();
      r.on("end", resolve);
    });
    req.on("error", resolve);
    vm.settle(6).then(resolve, resolve);
  });
  vm.drain();
  ok(c5[0] && c5[0].url === "http://[2606:4700::1111]:8080/", "IPv6 literal bracketed in the egress URL", c5[0] && c5[0].url);
  clearFetchStub();
}

// ===========================================================================
// 4. HONEST FAILURES
// ===========================================================================
section("honest failures \u2014 no silent wrong answers");
{
  const vm = makeVm();
  const http = vm.mods.require("http");

  // A WebSocket-style upgrade cannot ride a fetch: no socket comes back, so the
  // caller would wait forever on a request that "succeeded".
  const calls = installFetchStub(vm);
  const up = await new Promise((resolve) => {
    const req = http.request({
      host: "ws.example.com",
      path: "/",
      headers: { Connection: "Upgrade", Upgrade: "websocket" },
    });
    req.on("upgrade", () => resolve({ upgraded: true }));
    req.on("response", () => resolve({ response: true }));
    req.on("error", (e) => resolve({ code: e.code, message: e.message }));
    req.end();
    vm.settle(6).then(resolve, resolve);
  });
  vm.drain();
  ok(up.code === "ERR_VIVARI_UPGRADE_UNSUPPORTED", "an Upgrade request errors instead of hanging", JSON.stringify(up));
  ok(calls.length === 0, "no fetch was issued for the upgrade attempt", calls.length);

  const conn = await new Promise((resolve) => {
    const req = http.request({ method: "CONNECT", host: "proxy.example.com", port: 443, path: "example.com:443" });
    req.on("connect", () => resolve({ connected: true }));
    req.on("response", () => resolve({ response: true }));
    req.on("error", (e) => resolve({ code: e.code }));
    req.end();
    vm.settle(6).then(resolve, resolve);
  });
  vm.drain();
  ok(conn.code === "ERR_VIVARI_UPGRADE_UNSUPPORTED", "CONNECT errors instead of pretending", JSON.stringify(conn));

  // A fetcher that rejects (what a mixed-content block looks like from in here).
  clearFetchStub();
  installFetchStub(vm, {
    respond: () => ({ throw: Object.assign(new TypeError("Failed to fetch"), { code: undefined }) }),
  });
  const blocked = await new Promise((resolve) => {
    const req = http.get("http://registry.corp.internal/pkg", () => resolve({ response: true }));
    req.on("error", (e) => resolve({ code: e.code, message: e.message }));
    vm.settle(8).then(resolve, resolve);
  });
  vm.drain();
  ok(
    blocked.code === "ECONNREFUSED" && /Failed to fetch/.test(blocked.message || ""),
    "a rejected fetch surfaces as a request error",
    JSON.stringify(blocked),
  );
  ok(
    /mixed content/.test(blocked.message || "") && /host\.vivari\.internal/.test(blocked.message || ""),
    "the http:// failure names the browser constraint and the workaround",
    blocked.message,
  );

  // No fetcher at all (a runtime with no kernel egress).
  clearFetchStub();
  const noNet = await new Promise((resolve) => {
    const req = http.get("http://example.com/", () => resolve({ response: true }));
    req.on("error", (e) => resolve({ code: e.code, message: e.message }));
    vm.settle(6).then(resolve, resolve);
  });
  vm.drain();
  ok(noNet.code === "ENETUNREACH", "no Fetcher Worker → ENETUNREACH, not a hang", JSON.stringify(noNet));
}

// ===========================================================================
// 5. The seams that must defer to the vendored client
// ===========================================================================
section("requests that must NOT be hijacked");
{
  const vm = makeVm();
  const http = vm.mods.require("http");
  const calls = installFetchStub(vm);

  const attempt = (opts) =>
    new Promise((resolve) => {
      let req;
      try {
        req = http.request(opts, () => resolve({ response: true }));
      } catch (e) {
        return resolve({ threw: e.code || e.message });
      }
      req.on("error", (e) => resolve({ code: e.code }));
      req.end();
      vm.drain();
      vm.settle(4).then(resolve, resolve);
    });

  const sock = await attempt({ socketPath: "/tmp/docker.sock", path: "/info" });
  vm.drain();
  ok(calls.length === 0, "options.socketPath is never egressed (in-VM UNIX socket)", JSON.stringify(sock));

  const proto = await attempt({ protocol: "https:", host: "example.com", path: "/" });
  vm.drain();
  ok(
    calls.length === 0 && String(proto.threw || "").includes("ERR_INVALID_PROTOCOL"),
    "http.request({protocol:'https:'}) still throws ERR_INVALID_PROTOCOL",
    JSON.stringify(proto),
  );

  // A proxy-style agent overriding createConnection owns the transport: defer to
  // it (it fails loudly if the proxy itself is unreachable) rather than silently
  // bypassing the route the caller chose.
  const agent = new http.Agent();
  let proxyDialed = false;
  agent.createConnection = function (...args) {
    proxyDialed = true;
    return http.Agent.prototype.createConnection.apply(this, args);
  };
  const viaProxy = await attempt({ agent, host: "example.com", port: 80, path: "/" });
  vm.drain();
  ok(
    calls.length === 0 && proxyDialed,
    "an agent with its own createConnection keeps the vendored path",
    JSON.stringify(viaProxy) + " dialed=" + proxyDialed,
  );

  const custom = await attempt({
    host: "example.com",
    path: "/",
    createConnection: () => {
      throw Object.assign(new Error("mine"), { code: "ECUSTOM" });
    },
  });
  vm.drain();
  ok(calls.length === 0, "options.createConnection is honoured, not bypassed", JSON.stringify(custom));

  ok(typeof http.createServer === "function" && typeof http.Server === "function", "http's server exports untouched");
  ok(http.request.name === "request" && http.get.name === "get", "wrapped request/get keep their names");
  clearFetchStub();
}

// ===========================================================================
// 6. https must keep working through the shared transport
// ===========================================================================
section("https on the refactored shared transport");
{
  const vm = makeVm();
  const https = vm.mods.require("https");
  const calls = installFetchStub(vm, {
    respond: () => ({ status: 200, headers: { "content-type": "application/json" }, body: '{"name":"pkg"}' }),
  });

  const got = await new Promise((resolve) => {
    const req = https.get("https://registry.npmjs.org/pkg", (r) => {
      let b = "";
      r.on("data", (d) => (b += d));
      r.on("end", () => resolve({ code: r.statusCode, body: b, encrypted: !!(r.socket && r.socket.encrypted) }));
    });
    req.on("error", (e) => resolve({ err: e.message }));
    vm.settle(8).then(resolve, resolve);
  });
  vm.drain();
  ok(calls[0] && calls[0].url === "https://registry.npmjs.org/pkg", "https URL unchanged", calls[0] && calls[0].url);
  ok(got.code === 200 && got.body === '{"name":"pkg"}', "https response delivered", JSON.stringify(got));
  ok(got.encrypted === true, "the https stand-in socket still reports encrypted");
  ok(typeof https.Agent === "function" && new https.Agent().defaultPort === 443, "https.Agent still extendable, port 443");
  let threw = "";
  try {
    https.createServer();
  } catch (e) {
    threw = e.code;
  }
  ok(threw === "ERR_METHOD_NOT_IMPLEMENTED", "https.createServer still refuses honestly", threw);
  clearFetchStub();
}

console.log(`\nRESULT: ${failed ? "FAIL" : "PASS"} (${failed} check${failed === 1 ? "" : "s"} failed)`);
process.exit(failed ? 1 : 0);