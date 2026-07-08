// Headless end-to-end check of the whole stack, no browser required.
//
// The main thread runs the Kernel (Rust/Wasm VFS + process table + syscall
// servicing). Processes are Node worker_threads (scripts/process-worker.mjs),
// each with its own SharedArrayBuffer channel — exactly like the browser demo,
// where they are Web Workers. This exercises brick 4 (processes, shell, spawn)
// on top of bricks 1-3 (sync bridge, VFS, runtime).
//
//   node scripts/verify-node.mjs

import { Worker, MessageChannel } from "node:worker_threads";
import { gzipSync } from "node:zlib";
import nodeCrypto from "node:crypto";
import { readFileSync } from "node:fs";

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";

// Build a real gzipped ustar tarball from { "package/<path>": "<contents>" } so
// the npm-install proof (Phase 2 #10) exercises the actual gunzip + tar parser
// on genuine bytes, fully offline.
function tarHeader(name, size) {
  const buf = Buffer.alloc(512);
  buf.write(name, 0, 100, "utf8");
  buf.write("0000644", 100); // mode
  buf.write("0000000", 108); // uid
  buf.write("0000000", 116); // gid
  buf.write(size.toString(8).padStart(11, "0"), 124); // size (octal)
  buf.write("00000000000", 136); // mtime
  buf.write("        ", 148); // checksum placeholder = 8 spaces
  buf.write("0", 156); // typeflag: regular file
  buf.write("ustar", 257);
  buf.write("00", 263);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += buf[i];
  buf.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return buf;
}
function makeTgz(files) {
  const chunks = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8");
    chunks.push(tarHeader(name, data.length));
    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
    data.copy(padded);
    chunks.push(padded);
  }
  chunks.push(Buffer.alloc(1024)); // two zero blocks terminate the archive
  return gzipSync(Buffer.concat(chunks));
}

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

async function makeKernel() {
  // #14: the Wasm VFS runs in a dedicated File System Worker, exactly like the
  // browser. The kernel (this main thread) waits for it to boot, then talks to
  // it over its own sync SAB channel; processes get a MessagePort doorbell.
  const fsWorker = new Worker(new URL("./fs-worker.mjs", import.meta.url));
  let onKernelFsMessage = () => {};
  await new Promise((resolve) => {
    fsWorker.on("message", (m) => {
      if (m.type === "ready") resolve();
      else onKernelFsMessage(m);
    });
  });
  const kernelFs = createKernelFs(fsWorker);
  onKernelFsMessage = kernelFs.onMessage;

  const spawnWorker = (info) => {
    const worker = new Worker(new URL("./process-worker.mjs", import.meta.url));
    worker.on("message", (m) => {
      const handler = info.on[m.type];
      if (handler) handler(m);
    });
    const { port1, port2 } = new MessageChannel();
    fsWorker.postMessage({ type: "fs-register", client: info.pid, sab: info.sab, port: port2 }, [port2]);
    worker.postMessage({ type: "init", sab: info.sab, spec: info.spec, fsPort: port1 }, [port1]);
    return {
      terminate: () => {
        worker.terminate();
        fsWorker.postMessage({ type: "fs-unregister", client: info.pid });
      },
      postMessage: (m) => worker.postMessage(m),
    };
  };
  // Deterministic, offline mock of the Fetcher Worker (Phase 2 #9): canned npm
  // fixtures + a call counter so we can assert the kernel-side content cache
  // actually skips the network on a repeated URL.
  const enc = new TextEncoder();
  const fixtures = {
    "https://registry.example/left-pad": {
      contentType: "application/json",
      body: enc.encode(
        JSON.stringify({
          name: "left-pad",
          "dist-tags": { latest: "1.3.0" },
          versions: {
            "1.0.0": { dist: { tarball: "https://registry.example/left-pad/-/left-pad-1.0.0.tgz" } },
            "1.3.0": { dist: { tarball: "https://registry.example/left-pad/-/left-pad-1.3.0.tgz" } },
          },
        }),
      ),
    },
    "https://registry.example/left-pad/-/left-pad-1.3.0.tgz": {
      contentType: "application/octet-stream",
      body: new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 1, 2, 3, 4, 5, 6, 7, 8]), // fake gzip magic + bytes
    },
    // A tiny dependency tree for the npm-install proof: a@1.0.0 -> b@^1.0.0.
    // Dependencies live in the registry metadata; b's tarball carries a `bin` so
    // the .bin symlink step is exercised. Registry host matches the npm program's
    // default (registry.npmjs.org) so no code override is needed.
    "https://registry.npmjs.org/a": {
      contentType: "application/json",
      body: enc.encode(
        JSON.stringify({
          name: "a",
          "dist-tags": { latest: "1.0.0" },
          versions: {
            "1.0.0": {
              dist: { tarball: "https://registry.npmjs.org/a/-/a-1.0.0.tgz" },
              dependencies: { b: "^1.0.0" },
            },
          },
        }),
      ),
    },
    "https://registry.npmjs.org/b": {
      contentType: "application/json",
      body: enc.encode(
        JSON.stringify({
          name: "b",
          "dist-tags": { latest: "1.2.0" },
          versions: {
            "1.0.5": { dist: { tarball: "https://registry.npmjs.org/b/-/b-1.0.5.tgz" } },
            "1.2.0": { dist: { tarball: "https://registry.npmjs.org/b/-/b-1.2.0.tgz" } },
          },
        }),
      ),
    },
    "https://registry.npmjs.org/a/-/a-1.0.0.tgz": {
      contentType: "application/octet-stream",
      body: makeTgz({
        "package/package.json": JSON.stringify({ name: "a", version: "1.0.0", main: "index.js", dependencies: { b: "^1.0.0" } }),
        "package/index.js": "module.exports = () => 'a+' + require('b')();\n",
      }),
    },
    "https://registry.npmjs.org/b/-/b-1.2.0.tgz": {
      contentType: "application/octet-stream",
      body: makeTgz({
        "package/package.json": JSON.stringify({ name: "b", version: "1.2.0", main: "index.js", bin: { "b-cli": "cli.js" } }),
        "package/index.js": "module.exports = () => 'b-ok';\n",
        "package/cli.js": "console.log('b-cli ran');\n",
      }),
    },
    // c@1.0.0 depends on b via a COMPOUND range the hand-rolled semver couldn't
    // parse — proves the vendored real semver (stage 2). Expect b@1.2.0 (< 2.0.0).
    "https://registry.npmjs.org/c": {
      contentType: "application/json",
      body: enc.encode(
        JSON.stringify({
          name: "c",
          "dist-tags": { latest: "1.0.0" },
          versions: {
            "1.0.0": {
              dist: { tarball: "https://registry.npmjs.org/c/-/c-1.0.0.tgz" },
              dependencies: { b: ">=1.0.0 <2.0.0" },
            },
          },
        }),
      ),
    },
    "https://registry.npmjs.org/c/-/c-1.0.0.tgz": {
      contentType: "application/octet-stream",
      body: makeTgz({
        "package/package.json": JSON.stringify({ name: "c", version: "1.0.0", main: "index.js", dependencies: { b: ">=1.0.0 <2.0.0" } }),
        "package/index.js": "module.exports = () => 'c+' + require('b')();\n",
      }),
    },
  };
  const fetchStats = { calls: 0 };
  const fetcher = async (url) => {
    fetchStats.calls++;
    const f = fixtures[url];
    if (!f) return { ok: false, status: 404, headers: {}, body: enc.encode("not found") };
    return { ok: true, status: 200, headers: { "content-type": f.contentType }, body: f.body };
  };
  const kernel = new Kernel({ fs: kernelFs.fs, spawnWorker, fetcher });
  kernel.testFetch = fetchStats;
  kernel.installCoreutils();
  return kernel;
}

async function main() {
  const kernel = await makeKernel();

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

  // Path B proof: require('stream') is Node's REAL vendored lib/stream.js +
  // internal/streams/* running on Event loop v2 — Readable/Writable/Transform,
  // pipeline, finished, async iteration, setEncoding (StringDecoder) and the
  // stream/promises API. Exercises real backpressure/nextTick/immediate flows.
  kernel.writeFile(
    "/t/streamb.js",
    `
const assert = require('assert');
const stream = require('stream');
const { Readable, Writable, Transform, PassThrough, pipeline, finished, Duplex } = stream;
const { pipeline: pipelineP, finished: finishedP } = require('stream/promises');

const collect = (r) => new Promise((resolve, reject) => {
  const chunks = [];
  r.on('data', (c) => chunks.push(c));
  r.on('end', () => resolve(chunks));
  r.on('error', reject);
});

async function main() {
  // Readable: object/byte push + async iteration.
  const r1 = Readable.from(['a', 'b', 'c']);
  let viaAsyncIter = '';
  for await (const c of r1) viaAsyncIter += c;
  assert.strictEqual(viaAsyncIter, 'abc', 'Readable.from + async iteration');

  // Readable push + setEncoding: multibyte char split across chunk boundary
  // must be reassembled by the StringDecoder ('é' = 0xC3 0xA9).
  const r2 = new Readable({ read() {} });
  r2.setEncoding('utf8');
  r2.push(Buffer.from([0xc3]));
  r2.push(Buffer.from([0xa9, 0x21])); // continuation of é, then '!'
  r2.push(null);
  const dec = (await collect(r2)).join('');
  assert.strictEqual(dec, 'é!', 'setEncoding reassembles a split multibyte char');

  // Writable: collects writes, finish fires.
  const sink = [];
  const w = new Writable({ write(chunk, enc, cb) { sink.push(chunk.toString()); cb(); } });
  w.write('x'); w.write('y'); w.end('z');
  await finishedP(w);
  assert.strictEqual(sink.join(''), 'xyz', 'Writable collects chunks + finished()');

  // Transform: uppercase, piped through PassThrough.
  const up = new Transform({
    transform(chunk, enc, cb) { cb(null, chunk.toString().toUpperCase()); },
  });
  const out = [];
  const drain = new Writable({ write(c, e, cb) { out.push(c.toString()); cb(); } });
  await pipelineP(Readable.from(['ab', 'cd']), up, new PassThrough(), drain);
  assert.strictEqual(out.join(''), 'ABCD', 'pipeline: Readable -> Transform -> PassThrough -> Writable');

  // callback pipeline + finished on the same run.
  await new Promise((resolve, reject) => {
    const dst = new Writable({ write(c, e, cb) { cb(); } });
    finished(dst, (err) => { if (err) reject(err); });
    pipeline(Readable.from(['1', '2']), dst, (err) => (err ? reject(err) : resolve()));
  });

  // Duplex is both readable + writable.
  const d = new Duplex({ read() {}, write(c, e, cb) { cb(); } });
  assert.ok(d.writable && d.readable, 'Duplex is readable + writable');

  console.log('STREAMB_OK');
}
main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
`,
  );
  const sb = await kernel.start("node", ["/t/streamb.js"], { cwd: "/t", capture: true });
  assert(sb.code === 0 && sb.stdout.includes("STREAMB_OK"),
    "Path B: real Node lib/stream.js runs (Readable/Writable/Transform/pipeline/finished/promises)");

  // Path B proof: require('zlib') is Node's REAL vendored lib/zlib.js running on
  // internalBinding('zlib') backed by the Rust/Wasm codec (packages/codec). Cover
  // the sync one-shot API, the async streaming API (createGzip/Gunzip through a
  // pipeline on Event loop v2), crc32, and cross-compatibility with a gzip buffer
  // produced by the real Node zlib (decodes byte-for-byte).
  kernel.writeFile(
    "/t/zlibb.js",
    `
const assert = require('assert');
const zlib = require('zlib');
const { pipeline } = require('stream');
const { Readable, Writable } = require('stream');

const data = Buffer.from('OpenContainer '.repeat(400) + 'café € zlib #11');

// sync round-trips
assert.ok(zlib.gunzipSync(zlib.gzipSync(data)).equals(data), 'gzipSync/gunzipSync round-trip');
assert.ok(zlib.inflateSync(zlib.deflateSync(data)).equals(data), 'deflateSync/inflateSync round-trip');
assert.ok(zlib.inflateRawSync(zlib.deflateRawSync(data)).equals(data), 'deflateRawSync/inflateRawSync round-trip');
assert.ok(zlib.unzipSync(zlib.gzipSync(data)).equals(data), 'unzipSync auto-detects gzip');
assert.ok(zlib.unzipSync(zlib.deflateSync(data)).equals(data), 'unzipSync auto-detects zlib');

// cross-compat: a gzip buffer made by the REAL Node zlib must decode here.
const fromNode = Buffer.from('H4sIAAAAAAAAE/MvSM1zzs8rSczMSy1SqMrJTFJQNjRUeNQwRSE5Me3wSoVHTWsAWCDGcyQAAAA=', 'base64');
assert.strictEqual(zlib.gunzipSync(fromNode).toString('utf8'), 'OpenContainer zlib #11 — café €', 'gunzip a Node-produced gzip');

// crc32 matches the real Node value.
assert.strictEqual(zlib.crc32('hello world'), 222957957, 'crc32 matches Node');

async function main() {
  // async streaming: createGzip -> createGunzip through a pipeline (drives the
  // async binding.write path over nextTick, exactly like a real gzip stream).
  const gzipped = await new Promise((resolve, reject) => {
    const chunks = [];
    const src = Readable.from([data.subarray(0, 1000), data.subarray(1000)]);
    const sink = new Writable({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb(); } });
    pipeline(src, zlib.createGzip(), sink, (err) => err ? reject(err) : resolve(Buffer.concat(chunks)));
  });
  assert.ok(zlib.gunzipSync(gzipped).equals(data), 'streaming createGzip output is valid gzip');

  const back = await new Promise((resolve, reject) => {
    const chunks = [];
    const sink = new Writable({ write(c, e, cb) { chunks.push(Buffer.from(c)); cb(); } });
    pipeline(Readable.from([gzipped]), zlib.createGunzip(), sink, (err) => err ? reject(err) : resolve(Buffer.concat(chunks)));
  });
  assert.ok(back.equals(data), 'streaming createGunzip round-trips the stream');

  console.log('ZLIBB_OK');
}
main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
`,
  );
  const zb = await kernel.start("node", ["/t/zlibb.js"], { cwd: "/t", capture: true });
  assert(zb.code === 0 && zb.stdout.includes("ZLIBB_OK"),
    "Path B: real Node lib/zlib.js runs on the Rust/Wasm codec (gzip/deflate/raw, sync + streaming, crc32)");

  // Path B proof (#12): require('crypto') is our lib/crypto.js over
  // internalBinding('crypto') backed by the Rust/Wasm crypto codec
  // (packages/crypto, RustCrypto). Every value is compared byte-for-byte against
  // the host's real node:crypto: digests (md5..sha512), HMAC, PBKDF2, and the AES
  // ciphers (aes-256-gcm with AAD+tag, aes-256-cbc) both ways, plus cross-decrypt
  // of ciphertext produced by real OpenSSL.
  const CKEY32 = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1));
  const GIV12 = Buffer.from(Array.from({ length: 12 }, (_, i) => i + 7));
  const CIV16 = Buffer.from(Array.from({ length: 16 }, (_, i) => i + 3));
  const gcmC = nodeCrypto.createCipheriv("aes-256-gcm", CKEY32, GIV12);
  gcmC.setAAD(Buffer.from("hdr-aad"));
  const gcmCt = Buffer.concat([gcmC.update("secret gcm message", "utf8"), gcmC.final()]);
  const cbcC = nodeCrypto.createCipheriv("aes-256-cbc", CKEY32, CIV16);
  const cbcCt = Buffer.concat([cbcC.update("secret cbc message", "utf8"), cbcC.final()]);
  const cryptoExpected = {
    md5: nodeCrypto.createHash("md5").update("abc").digest("hex"),
    sha1: nodeCrypto.createHash("sha1").update("abc").digest("hex"),
    sha224: nodeCrypto.createHash("sha224").update("abc").digest("hex"),
    sha256: nodeCrypto.createHash("sha256").update("abc").digest("hex"),
    sha384: nodeCrypto.createHash("sha384").update("abc").digest("hex"),
    sha512: nodeCrypto.createHash("sha512").update("abc").digest("hex"),
    hmac: nodeCrypto.createHmac("sha256", "key")
      .update("The quick brown fox jumps over the lazy dog").digest("hex"),
    pbkdf2: nodeCrypto.pbkdf2Sync("password", "salt", 1000, 32, "sha256").toString("hex"),
    key: CKEY32.toString("hex"),
    giv: GIV12.toString("hex"),
    civ: CIV16.toString("hex"),
    gcmCt: gcmCt.toString("hex"),
    gcmTag: gcmC.getAuthTag().toString("hex"),
    cbcCt: cbcCt.toString("hex"),
  };
  kernel.writeFile(
    "/t/cryptob.js",
    `
const assert = require('assert');
const crypto = require('crypto');
const E = ${JSON.stringify(cryptoExpected)};

// digests vs real node:crypto
for (const algo of ['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512']) {
  assert.strictEqual(crypto.createHash(algo).update('abc').digest('hex'), E[algo], algo + ' matches node');
}
assert.strictEqual(crypto.createHash('sha256').update('a').update('bc').digest('hex'), E.sha256, 'sha256 multi-update');

// HMAC + PBKDF2
assert.strictEqual(
  crypto.createHmac('sha256', 'key').update('The quick brown fox jumps over the lazy dog').digest('hex'),
  E.hmac, 'hmac-sha256 matches node');
assert.strictEqual(crypto.pbkdf2Sync('password', 'salt', 1000, 32, 'sha256').toString('hex'), E.pbkdf2, 'pbkdf2Sync matches node');

const key = Buffer.from(E.key, 'hex'), giv = Buffer.from(E.giv, 'hex'), civ = Buffer.from(E.civ, 'hex');

// AES-256-GCM: our ciphertext + tag must equal OpenSSL's, and we must decrypt OpenSSL's.
const gc = crypto.createCipheriv('aes-256-gcm', key, giv);
gc.setAAD(Buffer.from('hdr-aad'));
const gct = Buffer.concat([gc.update('secret gcm message', 'utf8'), gc.final()]);
assert.strictEqual(gct.toString('hex'), E.gcmCt, 'aes-256-gcm ciphertext matches node');
assert.strictEqual(gc.getAuthTag().toString('hex'), E.gcmTag, 'aes-256-gcm auth tag matches node');
const gd = crypto.createDecipheriv('aes-256-gcm', key, giv);
gd.setAAD(Buffer.from('hdr-aad'));
gd.setAuthTag(Buffer.from(E.gcmTag, 'hex'));
assert.strictEqual(Buffer.concat([gd.update(Buffer.from(E.gcmCt, 'hex')), gd.final()]).toString('utf8'),
  'secret gcm message', 'aes-256-gcm decrypts OpenSSL ciphertext');
// tampered tag must throw (authenticated).
assert.throws(() => {
  const bad = crypto.createDecipheriv('aes-256-gcm', key, giv);
  bad.setAAD(Buffer.from('hdr-aad'));
  bad.setAuthTag(Buffer.alloc(16));
  Buffer.concat([bad.update(Buffer.from(E.gcmCt, 'hex')), bad.final()]);
}, 'gcm rejects a bad auth tag');

// AES-256-CBC (PKCS#7): ciphertext matches OpenSSL and round-trips.
const cc = crypto.createCipheriv('aes-256-cbc', key, civ);
const cct = Buffer.concat([cc.update('secret cbc message', 'utf8'), cc.final()]);
assert.strictEqual(cct.toString('hex'), E.cbcCt, 'aes-256-cbc ciphertext matches node');
const cd = crypto.createDecipheriv('aes-256-cbc', key, civ);
assert.strictEqual(Buffer.concat([cd.update(Buffer.from(E.cbcCt, 'hex')), cd.final()]).toString('utf8'),
  'secret cbc message', 'aes-256-cbc round-trips');

// randomness sanity (WebCrypto-backed).
assert.strictEqual(crypto.randomBytes(16).length, 16, 'randomBytes length');
assert.ok(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(crypto.randomUUID()), 'randomUUID v4 format');
console.log('CRYPTOB_OK');
`,
  );
  const cb2 = await kernel.start("node", ["/t/cryptob.js"], { cwd: "/t", capture: true });
  assert(cb2.code === 0 && cb2.stdout.includes("CRYPTOB_OK"),
    "Path B: our lib/crypto.js runs on the Rust/Wasm crypto codec (digests/HMAC/PBKDF2/AES-GCM+CBC vs node:crypto)");

  // === #13: ESM import/export transpiled to our sync CJS (es-module-lexer) ===
  // Seed a small ESM/CJS mixed graph: named/default/namespace imports, CJS<->ESM
  // interop, re-exports, an ESM-syntax .js file, a package resolved via its
  // package.json "exports" field, dynamic import(), and import.meta.
  kernel.mkdirp("/esm/node_modules/expkg/lib");
  kernel.writeFile(
    "/esm/dep.mjs",
    "export const answer = 42;\n" +
    "export function greet(n){ return 'hi ' + n; }\n" +
    "export class Box { constructor(v){ this.v = v; } }\n" +
    "export default { kind: 'esm-default' };\n",
  );
  kernel.writeFile("/esm/named.mjs", "export const a = 1;\nexport let b = 2;\nb = 3;\n");
  kernel.writeFile("/esm/lazy.mjs", "export default 'lazy-loaded';\n");
  kernel.writeFile(
    "/esm/cjs-dep.cjs",
    "module.exports = function add(x, y){ return x + y; };\nmodule.exports.tag = 'cjs';\n",
  );
  kernel.writeFile(
    "/esm/reexp.mjs",
    "export { answer, greet } from './dep.mjs';\n" +
    "export * from './named.mjs';\n" +
    "export * as depNs from './dep.mjs';\n" +
    "export { default as depDefault } from './dep.mjs';\n",
  );
  // an ESM module authored as .js (detected by syntax, no .mjs extension)
  kernel.writeFile("/esm/tool.js", "import { answer } from './dep.mjs';\nexport const doubled = answer * 2;\n");
  // a package resolved via package.json "exports"
  kernel.writeFile(
    "/esm/node_modules/expkg/package.json",
    JSON.stringify({ name: "expkg", version: "1.0.0", type: "module", exports: { ".": { import: "./lib/index.mjs", require: "./lib/index.mjs" } } }),
  );
  kernel.writeFile("/esm/node_modules/expkg/lib/index.mjs", "export const pkgName = 'expkg';\nexport default () => 'pkg-call';\n");
  // a CJS file that requires an ESM module (interop from the CJS side)
  kernel.writeFile(
    "/esm/from-cjs.js",
    "const dep = require('./dep.mjs');\n" +
    "module.exports = { esmDefaultKind: dep.default.kind, esmAnswer: dep.answer, hasEsModule: dep.__esModule === true };\n",
  );
  kernel.writeFile(
    "/esm/main.mjs",
    "import def, { answer, greet, Box } from './dep.mjs';\n" +
    "import * as ns from './dep.mjs';\n" +
    "import add from './cjs-dep.cjs';\n" +
    "import { answer as A2, depNs, depDefault } from './reexp.mjs';\n" +
    "import { a, b } from './named.mjs';\n" +
    "import { doubled } from './tool.js';\n" +
    "import expkg, { pkgName } from 'expkg';\n" +
    "import fromCjs from './from-cjs.js';\n" +
    "import './named.mjs';\n" +
    "export const total = answer + a + b;\n" +
    "export function label(){ return greet('world'); }\n" +
    "const sync = {\n" +
    "  def_kind: def.kind, answer, greeting: greet('x'), boxV: new Box(9).v,\n" +
    "  nsAnswer: ns.answer, nsDefaultKind: ns.default.kind,\n" +
    "  add: add(2,3), addTag: add.tag,\n" +
    "  reAnswer: A2, depNsAnswer: depNs.answer, depDefaultKind: depDefault.kind,\n" +
    "  named_a: a, named_b: b, total, label: label(), doubled,\n" +
    "  pkgName, pkgCall: expkg(),\n" +
    "  fromCjs, metaHasUrl: typeof import.meta.url === 'string',\n" +
    "};\n" +
    "console.log('ESM_SYNC:' + JSON.stringify(sync));\n" +
    "import('./lazy.mjs').then((m) => console.log('ESM_DYN:' + m.default));\n",
  );

  const esm = await kernel.start("node", ["/esm/main.mjs"], { cwd: "/esm", capture: true });
  assert(esm.code === 0, "esm: node runs an .mjs entry without error (exit 0)");
  const esmLine = (esm.stdout.split("\n").find((l) => l.startsWith("ESM_SYNC:")) || "").slice("ESM_SYNC:".length);
  const R = esmLine ? JSON.parse(esmLine) : {};
  assert(R.def_kind === "esm-default", "esm: default import interop (ESM default)");
  assert(R.answer === 42 && R.greeting === "hi x" && R.boxV === 9, "esm: named import (const/function/class)");
  assert(R.nsAnswer === 42 && R.nsDefaultKind === "esm-default", "esm: namespace import (* as ns, incl .default)");
  assert(R.add === 5 && R.addTag === "cjs", "esm: default+named interop importing a CJS (.cjs) module");
  assert(R.reAnswer === 42 && R.depNsAnswer === 42 && R.depDefaultKind === "esm-default",
    "esm: re-exports (named / * / * as ns / default as)");
  assert(R.named_a === 1 && R.named_b === 3, "esm: live binding sees post-assignment value (let b = 2; b = 3)");
  assert(R.total === 46 && R.label === "hi world", "esm: local exports (const + function) are require-able");
  assert(R.doubled === 84, "esm: an ESM module authored as .js is detected by syntax and transpiled");
  assert(R.pkgName === "expkg" && R.pkgCall === "pkg-call", "esm: bare package resolved via package.json \"exports\" field");
  assert(R.fromCjs && R.fromCjs.esmDefaultKind === "esm-default" && R.fromCjs.hasEsModule === true,
    "esm: a CJS module can require() an ESM module (__esModule + default interop)");
  assert(R.metaHasUrl === true, "esm: import.meta.url is available");
  assert(esm.stdout.includes("ESM_DYN:lazy-loaded"), "esm: dynamic import() resolves to a Promise of the module");

  // === Consolidation: fill-in builtins that used to throw on require ===
  kernel.writeFile(
    "/t/compat.js",
    `
const assert = require('assert');

// punycode (vendored verbatim)
const punycode = require('punycode');
assert.strictEqual(punycode.toASCII('mañana.com'), 'xn--maana-pta.com');
assert.strictEqual(punycode.toUnicode('xn--maana-pta.com'), 'mañana.com');
assert.deepStrictEqual(punycode.ucs2.decode('A'), [65]);
console.log('OK punycode');

// constants (deprecated aggregate)
const constants = require('constants');
assert.strictEqual(constants.SIGINT, 2);
assert.strictEqual(constants.ENOENT, 2);
assert.ok(typeof constants.O_RDONLY === 'number');
console.log('OK constants');

// console (require-able Console class over custom streams)
const { Console } = require('console');
let out = '';
const stream = { write: (s) => { out += s; } };
const clog = new Console(stream, stream);
clog.log('hello %s %d', 'x', 7);
assert.strictEqual(out, 'hello x 7\\n');
console.log('OK console');

async function main() {
  // timers/promises
  const { setTimeout: sleep, setInterval } = require('timers/promises');
  assert.strictEqual(await sleep(5, 'v'), 'v');
  let ticks = 0;
  for await (const t of setInterval(3, 'tick')) { if (++ticks >= 3) break; }
  assert.strictEqual(ticks, 3);
  const ac = new AbortController();
  const pending = sleep(1000, 'nope', { signal: ac.signal });
  ac.abort();
  let aborted = false;
  try { await pending; } catch (e) { aborted = e && e.name === 'AbortError'; }
  assert.ok(aborted, 'timers/promises setTimeout rejects on abort');
  console.log('OK timers/promises');

  // dns (loopback-aware) — callback + promise
  const dns = require('dns');
  const cb = await new Promise((res, rej) => dns.lookup('localhost', (e, a, f) => e ? rej(e) : res({ a, f })));
  assert.strictEqual(cb.a, '127.0.0.1');
  assert.strictEqual(cb.f, 4);
  const pr = await dns.promises.lookup('localhost');
  assert.strictEqual(pr.address, '127.0.0.1');
  await new Promise((res) => dns.resolve4('localhost', (e, addrs) => { assert.ok(!e && addrs[0] === '127.0.0.1'); res(); }));
  console.log('OK dns');

  // net.connect BY HOSTNAME — exercises vendored net.js -> require('dns').lookup
  const net = require('net');
  const server = net.createServer((s) => { s.setEncoding('utf8'); s.on('data', (d) => s.end('echo:' + d)); });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const reply = await new Promise((res, rej) => {
    const c = net.connect(port, 'localhost', () => c.end('hi'));
    c.setEncoding('utf8');
    let b = '';
    c.on('data', (d) => { b += d; });
    c.on('end', () => res(b));
    c.on('error', rej);
  });
  assert.strictEqual(reply, 'echo:hi');
  server.close();
  console.log('OK net-hostname');
  console.log('COMPAT_OK');
}
main().catch((e) => { console.error('COMPAT_FAIL', (e && e.stack) || e); process.exit(1); });
`,
  );
  const compat = await kernel.start("node", ["/t/compat.js"], { cwd: "/t", capture: true });
  assert(compat.code === 0, "consolidation: compat program exits 0");
  assert(compat.stdout.includes("OK punycode"), "consolidation: punycode (toASCII/toUnicode/ucs2) vendored verbatim");
  assert(compat.stdout.includes("OK constants"), "consolidation: constants (signals + errno + fs) require-able");
  assert(compat.stdout.includes("OK console"), "consolidation: console.Console writes to a custom stream via util.format");
  assert(compat.stdout.includes("OK timers/promises"), "consolidation: timers/promises setTimeout/setInterval + AbortSignal");
  assert(compat.stdout.includes("OK dns"), "consolidation: dns loopback lookup (callback + promises + resolve4)");
  assert(compat.stdout.includes("OK net-hostname"),
    "consolidation: net.connect(port, 'localhost') resolves via the new dns (vendored net.js hostname path)");

  // === #16: WASI preview1 — run a real wasm32-wasi CLI over our VFS ===
  // A Rust binary compiled to wasm32-wasip1 (packages/wasi-demo) runs unmodified
  // via require('wasi'): it reads argv/env, opens a file in a preopened dir,
  // uppercases it, and writes an output file + stdout — every fd/path call
  // bridged to our VFS. The expected bytes match this same .wasm run under the
  // host's own node:wasi, so this is a real interop proof, not a self-check.
  kernel.mkdirp("/wasi");
  kernel.writeFile("/wasi/wasi_demo.wasm", new Uint8Array(readFileSync(new URL("../packages/wasi-demo/pkg/wasi_demo.wasm", import.meta.url))));
  kernel.mkdirp("/work");
  kernel.writeFile("/work/in.txt", "hello wasi\n");
  kernel.writeFile(
    "/t/wasitest.js",
    `
const fs = require('fs');
const { WASI } = require('wasi');
const bytes = fs.readFileSync('/wasi/wasi_demo.wasm');
const wasi = new WASI({
  version: 'preview1',
  args: ['wasi_demo', '/work/in.txt', '/work/out.txt'],
  env: { WASI_GREETING: 'salut' },
  preopens: { '/work': '/work' },
});
// Sync compile+instantiate — allowed in a Worker for any size (we are one).
const mod = new WebAssembly.Module(bytes);
const instance = new WebAssembly.Instance(mod, wasi.getImportObject());
const code = wasi.start(instance);
console.log('exit=' + code);
console.log('out=' + JSON.stringify(fs.readFileSync('/work/out.txt', 'utf8')));
`,
  );
  const w = await kernel.start("node", ["/t/wasitest.js"], { cwd: "/t", capture: true });
  assert(w.code === 0 && w.stdout.includes("salut: HELLO WASI"),
    "Phase 2 #16: wasm32-wasi CLI runs via require('wasi') — argv/env/preopen/fd_write to stdout over the VFS");
  assert(w.stdout.includes("exit=0"), "Phase 2 #16: WASI _start + proc_exit return exit code 0");
  assert(w.stdout.includes('out="HELLO WASI\\n"'),
    "Phase 2 #16: guest path_open + fd_read/fd_write landed output in the VFS (matches host node:wasi)");

  // Path B proof: require('net') is Node's REAL vendored lib/net.js +
  // internal/{net,stream_base_commons} running on our tcp_wrap/stream_wrap
  // loopback binding — net.Server/net.Socket are real Duplex streams. Proves an
  // echo server + client roundtrip, ephemeral listen + address(), a second
  // independent connection, chunked reassembly, and ECONNREFUSED.
  kernel.writeFile(
    "/t/netb.js",
    `
const assert = require('assert');
const net = require('net');

function echo(sock) {
  sock.setEncoding('utf8');
  sock.on('data', (d) => sock.write('echo:' + d));
  sock.on('end', () => sock.end());
}
function drain(port, payload) {
  return new Promise((resolve, reject) => {
    const c = net.connect(port, '127.0.0.1', () => c.end(payload));
    c.setEncoding('utf8');
    let buf = '';
    c.on('data', (d) => { buf += d; });
    c.on('end', () => resolve(buf));
    c.on('error', reject);
  });
}

async function main() {
  const server = net.createServer(echo);
  await new Promise((r) => server.listen(0, r)); // ephemeral port
  const port = server.address().port;
  assert.ok(port > 0, 'server.address() returns a bound port');

  // echo roundtrip + a second, independent connection on the same server.
  assert.strictEqual(await drain(port, 'hello'), 'echo:hello', 'echo roundtrip');
  assert.strictEqual(await drain(port, 'world'), 'echo:world', 'second independent connection');

  // multiple writes on one connection are reassembled in order by the peer.
  const server2 = net.createServer((sock) => {
    let n = 0;
    sock.on('data', (c) => { n += c.length; });
    sock.on('end', () => { sock.end(String(n)); });
  });
  await new Promise((r) => server2.listen(0, r));
  const p2 = server2.address().port;
  const total = await new Promise((resolve, reject) => {
    const c = net.connect(p2, '127.0.0.1', () => {
      c.write('aaaa'); c.write('bbbb'); c.end('cc'); // 10 bytes
    });
    c.setEncoding('utf8'); let b = '';
    c.on('data', (d) => b += d);
    c.on('end', () => resolve(b));
    c.on('error', reject);
  });
  assert.strictEqual(total, '10', 'server counted 10 bytes across 3 writes');

  // connecting to an unbound port rejects with ECONNREFUSED.
  await new Promise((resolve, reject) => {
    const c = net.connect(65530, '127.0.0.1');
    c.on('connect', () => reject(new Error('unexpectedly connected')));
    c.on('error', (e) => {
      assert.strictEqual(e.code, 'ECONNREFUSED', 'refused sets code ECONNREFUSED');
      resolve();
    });
  });

  await new Promise((r) => server.close(r));
  await new Promise((r) => server2.close(r));
  console.log('NETB_OK');
}
main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
`,
  );
  const nb = await kernel.start("node", ["/t/netb.js"], { cwd: "/t", capture: true });
  assert(nb.code === 0 && nb.stdout.includes("NETB_OK"),
    "Path B: real Node lib/net.js runs (echo server/client, address(), 2nd conn, chunked, ECONNREFUSED)");

  // Path B proof (#8): require('http') is Node's REAL vendored lib/http.js +
  // _http_* running on the pure-JS internalBinding('http_parser') over the net
  // loopback. Proves an in-VM server + client: POST with a body, GET with no body,
  // a chunked (no content-length) response, response headers, keep-alive socket
  // reuse across two requests, and ECONNREFUSED.
  kernel.writeFile(
    "/t/httpb.js",
    `
const assert = require('assert');
const http = require('http');

const server = http.createServer((req, res) => {
  if (req.url === '/chunked') {
    res.writeHead(200, { 'content-type': 'text/plain' }); // no length => chunked
    res.write('chunk-a;'); res.write('chunk-b;'); res.end('chunk-c');
    return;
  }
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => body += c);
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json', 'x-demo': 'oc' });
    res.end(JSON.stringify({ ok: true, echo: body, url: req.url, method: req.method }));
  });
});

function request(port, path, method, payload, agent) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, agent }, (res) => {
      let data = ''; res.setEncoding('utf8');
      res.on('data', (c) => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function main() {
  await new Promise((r) => server.listen(0, r)); // ephemeral port
  const port = server.address().port;
  assert.ok(port > 0, 'http server.address() returns a bound port');

  const post = await request(port, '/hello?x=1', 'POST', 'ping');
  assert.strictEqual(post.status, 200, 'POST status 200');
  assert.strictEqual(JSON.parse(post.body).echo, 'ping', 'POST body echoed');
  assert.strictEqual(post.headers['x-demo'], 'oc', 'response header propagated');

  const g = await request(port, '/plain', 'GET');
  assert.strictEqual(JSON.parse(g.body).method, 'GET', 'GET routed');
  assert.strictEqual(JSON.parse(g.body).echo, '', 'GET has no body');

  const ch = await request(port, '/chunked', 'GET');
  assert.strictEqual(ch.headers['transfer-encoding'], 'chunked', 'chunked transfer-encoding');
  assert.strictEqual(ch.body, 'chunk-a;chunk-b;chunk-c', 'chunked body reassembled');

  // keep-alive: reuse a single TCP socket across two requests via one agent.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const k1 = await request(port, '/k1', 'GET', undefined, agent);
  const k2 = await request(port, '/k2', 'GET', undefined, agent);
  assert.strictEqual(JSON.parse(k1.body).url, '/k1', 'keep-alive req 1');
  assert.strictEqual(JSON.parse(k2.body).url, '/k2', 'keep-alive req 2');
  agent.destroy();

  // connecting to an unbound port surfaces ECONNREFUSED on the request.
  await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: 65531, path: '/', agent: false });
    req.on('error', (e) => {
      assert.strictEqual(e.code, 'ECONNREFUSED', 'http refused sets ECONNREFUSED');
      resolve();
    });
    req.end();
  });

  await new Promise((r) => server.close(r));
  console.log('HTTPB_OK');
}
main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
`,
  );
  const hb = await kernel.start("node", ["/t/httpb.js"], { cwd: "/t", capture: true });
  assert(hb.code === 0 && hb.stdout.includes("HTTPB_OK"),
    "Path B: real Node lib/http.js runs (POST/GET, chunked, headers, keep-alive, ECONNREFUSED)");

  // === #9: network fetch via the Fetcher Worker (mocked offline) ===
  // A process calls the blocking __ocfetch; the kernel routes to the (mock)
  // Fetcher Worker, streams the body into the VFS, and returns metadata. Proves:
  // metadata + tarball land in the VFS, sizes are right, a 404 surfaces ok=false,
  // and a repeated URL is served from the kernel cache (no extra network call).
  kernel.writeFile(
    "/t/fetchb.js",
    `
const assert = require('assert');
const fs = require('fs');
const metaUrl = 'https://registry.example/left-pad';
const meta = __ocfetch(metaUrl);
assert.strictEqual(meta.ok, true, 'metadata ok');
assert.strictEqual(meta.status, 200, 'metadata 200');
assert.ok(meta.contentType.includes('json'), 'metadata content-type');
assert.strictEqual(meta.cached, false, 'metadata first fetch is not cached');
const doc = JSON.parse(fs.readFileSync(meta.path, 'utf8'));
const latest = doc['dist-tags'].latest;
assert.strictEqual(latest, '1.3.0', 'latest dist-tag parsed from VFS file');
const tar = __ocfetch(doc.versions[latest].dist.tarball);
assert.ok(tar.ok && tar.size === 12, 'tarball downloaded into VFS (12 bytes)');
assert.strictEqual(fs.readFileSync(tar.path).length, 12, 'tarball bytes readable from VFS');
const again = __ocfetch(metaUrl);
assert.strictEqual(again.cached, true, 'repeated URL served from cache');
const missing = __ocfetch('https://registry.example/nope');
assert.strictEqual(missing.ok, false, '404 surfaces ok=false');
assert.strictEqual(missing.status, 404, '404 status');
console.log('FETCHB_OK');
`,
  );
  const fb = await kernel.start("node", ["/t/fetchb.js"], { cwd: "/t", capture: true });
  assert(fb.code === 0 && fb.stdout.includes("FETCHB_OK"),
    "Phase 2 #9: __ocfetch streams npm metadata + tarball into the VFS via the Fetcher Worker");
  // metadata(1) + tarball(1) + missing(1) = 3 network calls; the repeated metadata
  // URL was a cache hit, so it did NOT add a 4th.
  assert(kernel.testFetch.calls === 3,
    "Phase 2 #9: kernel content cache skips the network on a repeated URL (3 calls, not 4)");

  // === #10: real `npm install` — resolve + download + gunzip/untar + hoist ===
  // `npm install a` must resolve a@1.0.0, follow its dependency b@^1.0.0, fetch
  // both packuments + tarballs, gunzip and untar them into node_modules, hoist b
  // to the project root, create the .bin symlink, and record a in package.json.
  kernel.mkdirp("/proj");
  kernel.writeFile("/proj/package.json", JSON.stringify({ name: "proj", version: "1.0.0" }));
  const npmI = await kernel.start("npm", ["install", "a"], { cwd: "/proj", capture: true });
  assert(npmI.code === 0 && npmI.stdout.includes("added 2 packages"),
    "Phase 2 #10: npm install resolves + installs a transitive tree (a -> b)");
  assert(kernel.exists("/proj/node_modules/a/package.json"),
    "Phase 2 #10: direct dependency extracted into node_modules");
  assert(kernel.exists("/proj/node_modules/b/package.json"),
    "Phase 2 #10: transitive dependency hoisted to the root node_modules");
  assert(kernel.exists("/proj/node_modules/.bin/b-cli"),
    "Phase 2 #10: .bin symlink created for a package with a bin field");
  kernel.writeFile(
    "/proj/run.js",
    `
const pj = require('/proj/package.json');
console.log(require('a')() + '|' + pj.dependencies.a);
`,
  );
  const npmRun = await kernel.start("node", ["/proj/run.js"], { cwd: "/proj", capture: true });
  assert(npmRun.code === 0 && npmRun.stdout.trim() === "a+b-ok|^1.0.0",
    "Phase 2 #10: installed tree is require-able (a requires hoisted b) + package.json recorded");

  // === #10 stage 2: real semver + npm run/npx + PATH-aware .bin resolution ===
  // Real vendored semver resolves a COMPOUND range the old hand-rolled logic
  // could not (c deps b '>=1.0.0 <2.0.0' -> b@1.2.0).
  kernel.mkdirp("/proj2");
  kernel.writeFile("/proj2/package.json", JSON.stringify({ name: "proj2", version: "1.0.0" }));
  const npmC = await kernel.start("npm", ["install", "c"], { cwd: "/proj2", capture: true });
  assert(npmC.code === 0 && kernel.exists("/proj2/node_modules/b/package.json"),
    "Phase 2 #10 st2: real semver resolves a compound range (c deps b '>=1.0.0 <2.0.0')");
  kernel.writeFile("/proj2/run.js", "console.log(require('c')())");
  const rc2 = await kernel.start("node", ["/proj2/run.js"], { cwd: "/proj2", capture: true });
  assert(rc2.code === 0 && rc2.stdout.trim() === "c+b-ok",
    "Phase 2 #10 st2: compound-range tree require-able (c -> b@1.2.0)");

  // PATH-aware resolution runs a node_modules/.bin symlink (b-cli was installed
  // into /proj by the earlier `npm install a`).
  const binRun = await kernel.start("b-cli", [], {
    cwd: "/proj", env: { PATH: "/proj/node_modules/.bin" }, capture: true,
  });
  assert(binRun.code === 0 && binRun.stdout.includes("b-cli ran"),
    "Phase 2 #10 st2: PATH-aware resolution executes a node_modules/.bin symlink");

  // npm run <script> (passes trailing args through to the script).
  kernel.mkdirp("/proj3");
  kernel.writeFile("/proj3/package.json",
    JSON.stringify({ name: "proj3", version: "1.0.0", scripts: { greet: "node greet.js from-script" } }));
  kernel.writeFile("/proj3/greet.js", "console.log('greet ' + process.argv.slice(2).join(' '));");
  const nrun = await kernel.start("npm", ["run", "greet"], { cwd: "/proj3", capture: true });
  assert(nrun.code === 0 && nrun.stdout.includes("greet from-script"),
    "Phase 2 #10 st2: npm run <script> executes the package.json script");

  // npx runs an already-installed local bin (resolved via node_modules/.bin).
  const nx = await kernel.start("npx", ["b-cli"], { cwd: "/proj", capture: true });
  assert(nx.code === 0 && nx.stdout.includes("b-cli ran"),
    "Phase 2 #10 st2: npx runs a local node_modules/.bin executable");

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
  await waitFor(() => kernel.exists("/srv/timer-fired.txt"),
    "background timer did not fire while the server was idle", 60);
  assert(kernel.exists("/srv/timer-fired.txt"),
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
