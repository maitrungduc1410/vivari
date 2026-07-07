// Headless end-to-end check of the whole stack, no browser required.
//
// The main thread runs the Kernel (Rust/Wasm VFS + process table + syscall
// servicing). Processes are Node worker_threads (scripts/process-worker.mjs),
// each with its own SharedArrayBuffer channel — exactly like the browser demo,
// where they are Web Workers. This exercises brick 4 (processes, shell, spawn)
// on top of bricks 1-3 (sync bridge, VFS, runtime).
//
//   node scripts/verify-node.mjs

import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";

import { Kernel } from "../packages/kernel-host/kernel.js";

const require = createRequire(import.meta.url);
const wasm = require("../packages/kernel/pkg-node/open_webcontainer_kernel.js");

let failed = 0;
const assert = (ok, msg) => {
  console.log((ok ? "  \u2713 " : "  \u2717 ") + msg);
  if (!ok) failed++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, msg, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await sleep(10);
  }
  throw new Error("waitFor timed out: " + msg);
}

function makeKernel() {
  const vfs = new wasm.VirtualFileSystem();
  const spawnWorker = (info) => {
    const worker = new Worker(new URL("./process-worker.mjs", import.meta.url));
    worker.on("message", (m) => {
      const handler = info.on[m.type];
      if (handler) handler(m);
    });
    worker.postMessage({ type: "init", sab: info.sab, spec: info.spec });
    return {
      terminate: () => worker.terminate(),
      postMessage: (m) => worker.postMessage(m),
    };
  };
  const kernel = new Kernel({ vfs, spawnWorker });
  kernel.installCoreutils();
  return kernel;
}

async function main() {
  const kernel = makeKernel();

  // --- seed a Node project for the runtime regression program ---
  kernel.mkdirp("/t/lib");
  kernel.mkdirp("/t/node_modules/dep");
  kernel.writeFile("/t/lib/greet.js", "module.exports.greet = (n) => 'hi ' + n;\n");
  kernel.writeFile("/t/node_modules/dep/package.json", JSON.stringify({ main: "main.js" }));
  kernel.writeFile("/t/node_modules/dep/main.js", "module.exports = () => 'from-dep';\n");
  kernel.writeFile("/t/data.json", JSON.stringify({ answer: 42 }));
  kernel.writeFile(
    "/t/selftest.js",
    `
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { greet } = require('./lib/greet');
const dep = require('dep');
const data = require('./data.json');
assert.strictEqual(greet('x'), 'hi x');
assert.strictEqual(dep(), 'from-dep');
assert.strictEqual(data.answer, 42);
assert.strictEqual(path.basename('/a/b.txt'), 'b.txt');
fs.writeFileSync('out.txt', 'w');
assert.strictEqual(fs.readFileSync('out.txt', 'utf8'), 'w');
assert.ok(require('./lib/greet') === require('./lib/greet'));
assert.strictEqual(Buffer.from('hi').toString('hex'), '6869');
console.log('SELFTEST_OK');
`,
  );

  // --- seed the app + shell script for the process/shell tests ---
  kernel.mkdirp("/project");
  kernel.writeFile(
    "/project/app.js",
    `
const fs = require('fs');
const { execSync } = require('child_process');
console.log('app-cwd ' + process.cwd());
fs.writeFileSync('note.txt', 'note-contents');
console.log('nested ' + execSync('echo NEST', { encoding: 'utf8' }).trim());
`,
  );
  kernel.writeFile(
    "/root.sh",
    `
echo hello world
pwd
mkdir -p /work/a/b
cd /work
pwd
ls /work
echo one && echo two
false || echo recovered
nosuchcmd || echo handled
node /project/app.js
cat /work/note.txt
`,
  );

  // === runtime regression (bricks 1-3) via a real 'node' process ===
  const self = await kernel.start("node", ["/t/selftest.js"], { cwd: "/t", capture: true });
  assert(self.code === 0, "node selftest exits 0");
  assert(self.stdout.includes("SELFTEST_OK"), "runtime: require/fs/Buffer selftest passes");

  // process.pid must reflect the real kernel-assigned PID, not a hardcoded 1.
  kernel.writeFile("/t/pid.js", "console.log(process.pid);\n");
  const pidExpected = kernel.nextPid; // the PID the next spawned process will get
  const pidRun = await kernel.start("node", ["/t/pid.js"], { cwd: "/t", capture: true });
  assert(
    pidRun.stdout.trim() === String(pidExpected),
    `process: process.pid reflects the kernel PID (got ${pidRun.stdout.trim()}, want ${pidExpected})`,
  );

  // Path B proof: require('path') is Node's REAL vendored lib/path.js running on
  // the internalBinding layer. win32 semantics (backslash) are something the old
  // hand-written posix-only shim could not do.
  kernel.writeFile(
    "/t/pathb.js",
    `
const path = require('path');
const assert = require('assert');
assert.strictEqual(path.sep, '/');
assert.strictEqual(path.win32.sep, '\\\\');
assert.strictEqual(path.posix.join('/a', 'b', '..', 'c'), '/a/c');
assert.strictEqual(path.win32.join('C:\\\\a', 'b'), 'C:\\\\a\\\\b');
assert.strictEqual(path.basename('/x/y.txt', '.txt'), 'y');
assert.deepStrictEqual(
  path.parse('/a/b/c.js'),
  { root: '/', dir: '/a/b', base: 'c.js', ext: '.js', name: 'c' },
);
console.log('PATHB_OK');
`,
  );
  const pb = await kernel.start("node", ["/t/pathb.js"], { cwd: "/t", capture: true });
  assert(pb.code === 0 && pb.stdout.includes("PATHB_OK"),
    "Path B: real Node lib/path.js runs (posix + win32) via the loader");

  // Path B proof: require('buffer') is Node's REAL vendored lib/buffer.js on our
  // internalBinding('buffer'). Exercise codecs, numeric read/write (incl. BigInt),
  // byteswap, concat/compare, and the Uint8Array-subclass identity.
  kernel.writeFile(
    "/t/bufferb.js",
    `
const assert = require('assert');
const b = require('buffer');
// It's the real module: Buffer is a Uint8Array subclass.
assert.strictEqual(Buffer.from('x') instanceof Uint8Array, true);
assert.strictEqual(Buffer.isBuffer(Buffer.from('x')), true);
assert.strictEqual(typeof b.kMaxLength, 'number');
// Codec round-trips.
assert.strictEqual(Buffer.from('hello').toString('hex'), '68656c6c6f');
assert.strictEqual(Buffer.from('68656c6c6f', 'hex').toString(), 'hello');
assert.strictEqual(Buffer.from('hello').toString('base64'), 'aGVsbG8=');
assert.strictEqual(Buffer.from('aGVsbG8=', 'base64').toString(), 'hello');
assert.strictEqual(Buffer.from('hi').toString('base64url'), 'aGk');
assert.strictEqual(Buffer.from('café').toString('utf8'), 'café');
assert.strictEqual(Buffer.byteLength('€', 'utf8'), 3);
assert.strictEqual(Buffer.from('hi', 'utf16le').toString('hex'), '68006900');
assert.strictEqual(Buffer.from('hi', 'utf16le').toString('utf16le'), 'hi');
// Numeric read/write (pure-JS internal/buffer.js).
const n = Buffer.alloc(4); n.writeUInt32BE(0xdeadbeef, 0);
assert.strictEqual(n.toString('hex'), 'deadbeef');
assert.strictEqual(n.readUInt32BE(0), 0xdeadbeef);
assert.strictEqual(n.readUInt32LE(0), 0xefbeadde);
const big = Buffer.alloc(8); big.writeBigUInt64BE(0x0102030405060708n, 0);
assert.strictEqual(big.readBigUInt64BE(0), 0x0102030405060708n);
// Byteswap, concat, compare, indexOf.
assert.strictEqual(Buffer.from([1, 2, 3, 4]).swap16().toString('hex'), '02010403');
assert.strictEqual(Buffer.concat([Buffer.from('foo'), Buffer.from('bar')]).toString(), 'foobar');
assert.strictEqual(Buffer.compare(Buffer.from('a'), Buffer.from('b')), -1);
assert.strictEqual(Buffer.from('hello').indexOf('ll'), 2);
console.log('BUFFERB_OK');
`,
  );
  const bb = await kernel.start("node", ["/t/bufferb.js"], { cwd: "/t", capture: true });
  assert(bb.code === 0 && bb.stdout.includes("BUFFERB_OK"),
    "Path B: real Node lib/buffer.js runs (codecs/numeric/bigint/swap) via internalBinding('buffer')");

  // Path B proof: require('fs') is Node's REAL vendored lib/fs.js running on our
  // internalBinding('fs') (node/bindings/fs.js -> Rust VFS via real fds). This
  // exercises the fd layer (open/write/fstat/read/close), whole-file helpers,
  // real Stats (ino/size/mtime + isFile/isDirectory), Dirent (withFileTypes),
  // recursive mkdir/rm, rename/copy/symlink/readlink, ftruncate, mkdtemp.
  kernel.writeFile(
    "/t/fsb.js",
    `
const assert = require('assert');
const fs = require('fs');

// fd round-trip: openSync/writeSync/fstatSync/readSync/closeSync (real fds).
const fd = fs.openSync('/t/fdfile.txt', 'w');
assert.strictEqual(fs.writeSync(fd, 'hello fd'), 8);
const fst = fs.fstatSync(fd);
assert.strictEqual(fst.size, 8);
assert.ok(fst.isFile());
fs.closeSync(fd);
const rfd = fs.openSync('/t/fdfile.txt', 'r');
const buf = Buffer.alloc(5);
assert.strictEqual(fs.readSync(rfd, buf, 0, 5, 0), 5);
assert.strictEqual(buf.toString(), 'hello');
fs.closeSync(rfd);

// whole-file helpers: utf8 fast path + Buffer + append.
fs.writeFileSync('/t/a.txt', 'abc');
assert.strictEqual(fs.readFileSync('/t/a.txt', 'utf8'), 'abc');
assert.ok(Buffer.isBuffer(fs.readFileSync('/t/a.txt')));
fs.appendFileSync('/t/a.txt', 'def');
assert.strictEqual(fs.readFileSync('/t/a.txt', 'utf8'), 'abcdef');

// real Stats.
const s = fs.statSync('/t/a.txt');
assert.ok(s.isFile() && !s.isDirectory());
assert.strictEqual(s.size, 6);
assert.ok(s.mtime instanceof Date);
assert.ok(typeof s.ino === 'number' && s.ino > 0);
assert.strictEqual(fs.statSync('/t', { throwIfNoEntry: false }).isDirectory(), true);
assert.strictEqual(fs.statSync('/t/nope', { throwIfNoEntry: false }), undefined);

// recursive mkdir + readdir (+ withFileTypes Dirent).
fs.mkdirSync('/t/d/e/f', { recursive: true });
assert.ok(fs.statSync('/t/d/e/f').isDirectory());
fs.writeFileSync('/t/d/one.txt', '1');
fs.mkdirSync('/t/d/sub');
assert.deepStrictEqual(fs.readdirSync('/t/d').sort(), ['e', 'one.txt', 'sub']);
const ents = fs.readdirSync('/t/d', { withFileTypes: true });
const byName = Object.fromEntries(ents.map((d) => [d.name, d]));
assert.ok(byName['one.txt'].isFile());
assert.ok(byName['sub'].isDirectory());

// rename / copy / exists / realpath.
fs.renameSync('/t/a.txt', '/t/a2.txt');
assert.ok(!fs.existsSync('/t/a.txt') && fs.existsSync('/t/a2.txt'));
fs.copyFileSync('/t/a2.txt', '/t/a3.txt');
assert.strictEqual(fs.readFileSync('/t/a3.txt', 'utf8'), 'abcdef');
assert.strictEqual(fs.realpathSync('/t/a3.txt'), '/t/a3.txt');

// symlink / readlink / lstat (+ follow on read).
fs.symlinkSync('/t/a3.txt', '/t/link');
assert.strictEqual(fs.readlinkSync('/t/link'), '/t/a3.txt');
assert.ok(fs.lstatSync('/t/link').isSymbolicLink());
assert.strictEqual(fs.readFileSync('/t/link', 'utf8'), 'abcdef');

// ftruncate.
const tfd = fs.openSync('/t/a3.txt', 'r+');
fs.ftruncateSync(tfd, 3);
fs.closeSync(tfd);
assert.strictEqual(fs.readFileSync('/t/a3.txt', 'utf8'), 'abc');

// recursive rm + mkdtemp.
fs.rmSync('/t/d', { recursive: true });
assert.ok(!fs.existsSync('/t/d'));
const tmp = fs.mkdtempSync('/t/tmp-');
assert.ok(fs.statSync(tmp).isDirectory());

console.log('FSB_OK');
`,
  );
  const fsb = await kernel.start("node", ["/t/fsb.js"], { cwd: "/t", capture: true });
  assert(fsb.code === 0 && fsb.stdout.includes("FSB_OK"),
    "Path B: real Node lib/fs.js sync API runs (fds/Stats/Dirent/rm/rename/symlink) via internalBinding('fs')");

  // Path B proof: the async (callback) fs API, which routes through FSReqCallback
  // and is delivered on process.nextTick by our binding.
  kernel.writeFile(
    "/t/fscb.js",
    `
const assert = require('assert');
const fs = require('fs');
fs.writeFile('/t/cb.txt', 'cbdata', (err) => {
  assert.ok(!err, 'writeFile err');
  fs.readFile('/t/cb.txt', 'utf8', (err2, data) => {
    assert.ok(!err2, 'readFile err');
    assert.strictEqual(data, 'cbdata');
    fs.stat('/t/cb.txt', (err3, st) => {
      assert.ok(!err3, 'stat err');
      assert.ok(st.isFile() && st.size === 6);
      console.log('FSCB_OK');
    });
  });
});
`,
  );
  const fscb = await kernel.start("node", ["/t/fscb.js"], { cwd: "/t", capture: true });
  assert(fscb.code === 0 && fscb.stdout.includes("FSCB_OK"),
    "Path B: real Node lib/fs.js callback API (writeFile/readFile/stat) via FSReqCallback + nextTick");

  // Path B proof: require('events') is Node's REAL vendored lib/events.js. Cover
  // the core EventEmitter surface (on/emit/once/prepend/remove/counts), the
  // throwing 'error' contract, and real-only statics (getEventListeners, the
  // captureRejectionSymbol, and the events.once(emitter,name) promise helper).
  kernel.writeFile(
    "/t/eventsb.js",
    `
const assert = require('assert');
const EventEmitter = require('events');
// Real module identity: constructor with self-ref + statics the shim lacked.
assert.strictEqual(EventEmitter.EventEmitter, EventEmitter);
assert.strictEqual(typeof EventEmitter.getEventListeners, 'function');
assert.strictEqual(typeof EventEmitter.captureRejectionSymbol, 'symbol');

const ee = new EventEmitter();
let sum = 0;
const add = (a, b) => { sum += a + b; };
ee.on('add', add);
ee.emit('add', 2, 3);
assert.strictEqual(sum, 5);
assert.strictEqual(ee.listenerCount('add'), 1);
ee.removeListener('add', add);
ee.emit('add', 100, 100);
assert.strictEqual(sum, 5);

let onceCount = 0;
ee.once('go', () => { onceCount++; });
ee.emit('go'); ee.emit('go');
assert.strictEqual(onceCount, 1);

const order = [];
ee.on('x', () => order.push('b'));
ee.prependListener('x', () => order.push('a'));
ee.emit('x');
assert.deepStrictEqual(order, ['a', 'b']);

assert.deepStrictEqual(ee.eventNames().sort(), ['x']);
ee.setMaxListeners(3);
assert.strictEqual(ee.getMaxListeners(), 3);

// 'error' with no listener throws (Node's contract).
assert.throws(() => new EventEmitter().emit('error', new Error('boom')), /boom/);

// events.once(emitter, name) returns a Promise (the promisified one-shot).
const waiter = new EventEmitter();
const p = EventEmitter.once(waiter, 'ready');
assert.ok(p instanceof Promise);
waiter.emit('ready', 42);
console.log('EVENTSB_OK');
`,
  );
  const eb = await kernel.start("node", ["/t/eventsb.js"], { cwd: "/t", capture: true });
  assert(eb.code === 0 && eb.stdout.includes("EVENTSB_OK"),
    "Path B: real Node lib/events.js runs (EventEmitter core + statics + once promise)");

  // Path B proof: require('util') is Node's REAL vendored lib/util.js (format,
  // inherits, promisify, types, isDeepStrictEqual, callbackify, debuglog) over
  // our internal layer, with util.inspect supplied by our compatible bridge.
  kernel.writeFile(
    "/t/utilb.js",
    `
const assert = require('assert');
const util = require('util');
const ESC = String.fromCharCode(27);
// Real module: statics the old hand-written shim didn't have.
assert.strictEqual(typeof util.callbackify, 'function');
assert.strictEqual(typeof util.debuglog, 'function');
assert.strictEqual(typeof util.inspect.custom, 'symbol');

// printf-style format (backed by our inspect bridge for %j / objects).
assert.strictEqual(util.format('%s %d %j', 'a', 3, { x: 1 }), 'a 3 {"x":1}');
assert.strictEqual(util.format('%d%%', 50), '50%');
assert.strictEqual(util.format('a', 'b', 'c'), 'a b c');
assert.strictEqual(util.format('n=%d', 'notnum'), 'n=NaN');

// inspect: nesting + circular guard.
assert.ok(util.inspect({ a: 1, b: [1, 2] }).includes('a: 1'));
const circ = {}; circ.self = circ;
assert.ok(util.inspect(circ).includes('Circular'));

// inherits: prototype chain + super_.
function P() {} P.prototype.hi = function () { return 'hi'; };
function C() {} util.inherits(C, P);
assert.strictEqual(C.super_, P);
assert.ok(new C() instanceof P);
assert.strictEqual(new C().hi(), 'hi');

// promisify wraps a Node-style callback fn into a Promise-returning one.
const later = (x, cb) => cb(null, x * 2);
const pLater = util.promisify(later);
assert.strictEqual(typeof pLater, 'function');
assert.ok(pLater(21) instanceof Promise);

// types + deep equality + ANSI stripping.
assert.strictEqual(util.types.isDate(new Date()), true);
assert.strictEqual(util.types.isNativeError(new Error('e')), true);
assert.strictEqual(util.isDeepStrictEqual({ a: [1, 2] }, { a: [1, 2] }), true);
assert.strictEqual(util.isDeepStrictEqual({ a: 1 }, { a: 2 }), false);
assert.strictEqual(util.stripVTControlCharacters(ESC + '[31mred' + ESC + '[39m'), 'red');
console.log('UTILB_OK');
`,
  );
  const ub = await kernel.start("node", ["/t/utilb.js"], { cwd: "/t", capture: true });
  assert(ub.code === 0 && ub.stdout.includes("UTILB_OK"),
    "Path B: real Node lib/util.js runs (format/inherits/promisify/types/isDeepStrictEqual)");

  // Event loop v2 proof: ordering. nextTick beats Promise microtasks, and both
  // beat timers/immediates — which now actually FIRE (the old synchronous loop
  // starved them). Printing from inside setImmediate proves the loop drives to it.
  kernel.writeFile(
    "/t/loopb.js",
    `
const assert = require('assert');
const order = [];
setTimeout(() => order.push('timeout'), 0);
Promise.resolve().then(() => order.push('promise'));
process.nextTick(() => order.push('nextTick'));
setImmediate(() => {
  order.push('immediate');
  assert.strictEqual(order[0], 'nextTick', 'nextTick runs first');
  assert.strictEqual(order[1], 'promise', 'microtask before timers/immediate');
  assert.ok(order.includes('timeout') && order.includes('immediate'), 'timers + immediates fired');
  console.log('LOOPB_OK ' + order.join(','));
});
`,
  );
  const lb = await kernel.start("node", ["/t/loopb.js"], { cwd: "/t", capture: true });
  assert(lb.code === 0 && lb.stdout.includes("LOOPB_OK"),
    "Event loop: ordering nextTick > microtask > timers/immediate (all fire)");

  // Event loop v2 proof: real timers — setInterval fires repeatedly then stops on
  // clearInterval, clearTimeout cancels, and nested/chained timers work.
  kernel.writeFile(
    "/t/timersb.js",
    `
let ticks = 0;
const iv = setInterval(() => {
  if (++ticks === 3) { clearInterval(iv); console.log('INTERVAL_OK ' + ticks); }
}, 4);
const cancelled = setTimeout(() => console.log('SHOULD_NOT_PRINT'), 8);
clearTimeout(cancelled);
setTimeout(() => setTimeout(() => console.log('NESTED_OK'), 4), 4);
`,
  );
  const tb = await kernel.start("node", ["/t/timersb.js"], { cwd: "/t", capture: true });
  assert(
    tb.code === 0 &&
      tb.stdout.includes("INTERVAL_OK 3") &&
      tb.stdout.includes("NESTED_OK") &&
      !tb.stdout.includes("SHOULD_NOT_PRINT"),
    "Event loop: setInterval/clearInterval + clearTimeout + nested timers",
  );

  // === brick 4: shell session with each command as its own process ===
  const sh = await kernel.start("sh", ["/root.sh"], { cwd: "/", capture: true });
  const o = sh.stdout;
  assert(sh.code === 0, "shell script exits 0");
  assert(o.includes("hello world"), "shell: echo with quotes/args");
  assert(/\n\/work\n|^\/work\n/m.test(o) || o.includes("/work"), "shell: cd persists (pwd => /work)");
  assert(o.includes("\na\n") || o.split("\n").includes("a"), "shell: ls shows created dir 'a'");
  assert(o.includes("one") && o.includes("two"), "shell: && runs both sides");
  assert(o.includes("recovered"), "shell: || recovers from a failed command");
  assert(o.includes("handled"), "shell: missing command (127) triggers ||");
  assert(o.includes("app-cwd /work"), "process: node inherits shell's cwd");
  assert(o.includes("nested NEST"), "process: nested execSync child works");
  assert(o.includes("note-contents"), "process: file written by app.js read back by cat");

  // === exit codes as separate processes ===
  assert((await kernel.start("true")).code === 0, "program 'true' exits 0");
  assert((await kernel.start("false")).code === 1, "program 'false' exits 1");
  assert((await kernel.start("nosuchprogram")).code === 127, "unknown program => 127");

  // === brick 5: virtual network — an http server inside a worker process ===
  kernel.mkdirp("/srv");
  kernel.writeFile(
    "/srv/server.js",
    `
const http = require('http');
http.createServer((req, res) => {
  if (req.url === '/json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, url: req.url }));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('hello ' + req.url + ' from pid ' + process.pid);
}).listen(3000);
`,
  );
  // Fire-and-forget: the server never exits (parks in its accept loop).
  kernel.start("node", ["/srv/server.js"], { cwd: "/srv" });
  await waitFor(() => kernel.listeners.has(3000), "server did not start listening on 3000");

  const r1 = await kernel.handleHttpRequest(3000, { method: "GET", url: "/world", headers: {}, body: "" });
  assert(r1.status === 200, "http: server responds 200");
  assert(/^hello \/world from pid \d+$/.test(r1.body), "http: request routed to handler with url");

  const r2 = await kernel.handleHttpRequest(3000, { method: "GET", url: "/again", headers: {}, body: "" });
  assert(r2.body.startsWith("hello /again"), "http: accept loop serves a second request");

  const r3 = await kernel.handleHttpRequest(3000, { method: "GET", url: "/json", headers: {}, body: "" });
  assert(JSON.parse(r3.body).ok === true, "http: handler branches on url (JSON route)");
  assert((r3.headers["content-type"] || "").includes("json"), "http: response headers propagate");

  const r4 = await kernel.handleHttpRequest(9999, { method: "GET", url: "/", headers: {}, body: "" });
  assert(r4.status === 502, "http: request to an unbound port => 502");

  // Event loop v2 flagship: a timer fires WHILE a server is alive and idle (no
  // traffic). The old synchronous accept loop starved timers; now the loop waits
  // on the earliest timer even with a server open. The callback does a sync fs
  // write (proving the SAB channel is free during the idle wait), and the server
  // still serves afterwards.
  kernel.writeFile(
    "/srv/timerserver.js",
    `
const http = require('http');
const fs = require('fs');
setTimeout(() => fs.writeFileSync('/srv/timer-fired.txt', 'fired'), 20);
http.createServer((req, res) => res.end('tick ' + fs.existsSync('/srv/timer-fired.txt'))).listen(3100);
`,
  );
  kernel.start("node", ["/srv/timerserver.js"], { cwd: "/srv" });
  await waitFor(() => kernel.listeners.has(3100), "timer server did not listen on 3100");
  await waitFor(() => kernel.vfs.exists("/srv/timer-fired.txt"),
    "background timer did not fire while the server was idle", 60);
  assert(kernel.vfs.exists("/srv/timer-fired.txt"),
    "Event loop: a setTimeout fires while a server is running (idle, no traffic)");
  const r5 = await kernel.handleHttpRequest(3100, { method: "GET", url: "/", headers: {}, body: "" });
  assert(r5.status === 200 && r5.body === "tick true",
    "http: server still serves after a background timer fired");

  // Event loop v2: an ASYNC request handler — it awaits a setTimeout before
  // res.end(), so the response is deferred until the timer fires (the loop keeps
  // turning meanwhile). Two concurrent requests resolve independently.
  kernel.writeFile(
    "/srv/asyncserver.js",
    `
const http = require('http');
let ticks = 0;
setInterval(() => { ticks++; }, 5);
http.createServer(async (req, res) => {
  const start = Date.now();
  await new Promise((r) => setTimeout(r, 30));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ awaited: true, tookAtLeast: (Date.now() - start) >= 25, url: req.url }));
}).listen(3200);
`,
  );
  kernel.start("node", ["/srv/asyncserver.js"], { cwd: "/srv" });
  await waitFor(() => kernel.listeners.has(3200), "async server did not listen on 3200");
  const ra = await kernel.handleHttpRequest(3200, { method: "GET", url: "/a", headers: {}, body: "" });
  const raj = JSON.parse(ra.body);
  assert(ra.status === 200 && raj.awaited === true && raj.tookAtLeast === true && raj.url === "/a",
    "Event loop: async request handler (await setTimeout before res.end) responds");
  const [c1, c2] = await Promise.all([
    kernel.handleHttpRequest(3200, { method: "GET", url: "/x", headers: {}, body: "" }),
    kernel.handleHttpRequest(3200, { method: "GET", url: "/y", headers: {}, body: "" }),
  ]);
  assert(JSON.parse(c1.body).url === "/x" && JSON.parse(c2.body).url === "/y",
    "http: two async requests in flight resolve independently");

  // === process table actually allocated many PIDs ===
  assert(kernel.nextPid - 1 >= 10, `PID table grew (${kernel.nextPid - 1} processes spawned)`);

  console.log(failed ? "\nRESULT: FAIL" : "\nRESULT: PASS");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
