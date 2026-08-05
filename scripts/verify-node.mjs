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
// Retained Turbo-analog npm — no longer shipped in COREUTILS; installed here as
// an offline test fixture (see makeKernel below).
import { NPM_PROGRAM } from "../packages/kernel-host/programs/npm.js";

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
    // #16 stage 2b: a spawned thread also receives its parentPort (a MessagePort
    // transferred from its creator through us) alongside its fs doorbell.
    const init = { type: "init", sab: info.sab, spec: info.spec, fsPort: port1 };
    const transfer = [port1];
    if (info.threadPort) {
      init.threadPort = info.threadPort;
      transfer.push(info.threadPort);
    }
    worker.postMessage(init, transfer);
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
    // napi-style meta package (Phase 2 #16 stage 2c): its per-platform builds are
    // optionalDependencies. Only the wasm32 build may install here; the darwin one
    // is name-skipped (no fetch) and the neutral-named x64 one is fetched then
    // cpu-skipped. The meta's loader re-exports whatever platform build resolved.
    "https://registry.npmjs.org/napipkg": {
      contentType: "application/json",
      body: enc.encode(
        JSON.stringify({
          name: "napipkg",
          "dist-tags": { latest: "1.0.0" },
          versions: {
            "1.0.0": {
              dist: { tarball: "https://registry.npmjs.org/napipkg/-/napipkg-1.0.0.tgz" },
              optionalDependencies: {
                "napipkg-darwin-arm64": "1.0.0", // foreign name -> fast-skipped, never fetched
                "napipkg-neutralnative": "1.0.0", // neutral name, cpu:[x64] -> fetched then skipped
                "napipkg-wasm32-wasi": "1.0.0", // cpu:[wasm32] -> the one that installs
              },
            },
          },
        }),
      ),
    },
    "https://registry.npmjs.org/napipkg/-/napipkg-1.0.0.tgz": {
      contentType: "application/octet-stream",
      body: makeTgz({
        "package/package.json": JSON.stringify({ name: "napipkg", version: "1.0.0", main: "index.js" }),
        // Mirror the real napi-rs wrapper: node:-prefixed builtins + createRequire.
        "package/index.js":
          "const { createRequire } = require('node:module');\n" +
          "const req = createRequire(__filename);\n" +
          "require('node:fs');\n" +
          "module.exports = req('napipkg-wasm32-wasi');\n",
      }),
    },
    "https://registry.npmjs.org/napipkg-neutralnative": {
      contentType: "application/json",
      body: enc.encode(
        JSON.stringify({
          name: "napipkg-neutralnative",
          "dist-tags": { latest: "1.0.0" },
          versions: { "1.0.0": { cpu: ["x64"], dist: { tarball: "https://registry.npmjs.org/napipkg-neutralnative/-/nn-1.0.0.tgz" } } },
        }),
      ),
    },
    "https://registry.npmjs.org/napipkg-wasm32-wasi": {
      contentType: "application/json",
      body: enc.encode(
        JSON.stringify({
          name: "napipkg-wasm32-wasi",
          "dist-tags": { latest: "1.0.0" },
          versions: { "1.0.0": { cpu: ["wasm32"], dist: { tarball: "https://registry.npmjs.org/napipkg-wasm32-wasi/-/ww-1.0.0.tgz" } } },
        }),
      ),
    },
    "https://registry.npmjs.org/napipkg-wasm32-wasi/-/ww-1.0.0.tgz": {
      contentType: "application/octet-stream",
      body: makeTgz({
        "package/package.json": JSON.stringify({ name: "napipkg-wasm32-wasi", version: "1.0.0", main: "index.js" }),
        "package/index.js": "module.exports = { id: 'wasm32-wasi', add: function (a, b) { return a + b; } };\n",
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
  // The Turbo-analog npm is retired from the shipped product (studio boots the
  // REAL npm CLI). It lives on here purely as a test fixture: it installs from a
  // canned, offline registry with zero network, so #9/#10/#11 (metadata fetch,
  // resolve+gunzip+untar+hoist, .bin, napi optional deps) stay green without
  // vendoring the ~12 MB real-npm asset into this fast unit gate.
  kernel.writeFile("/bin/npm.js", NPM_PROGRAM);
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

const data = Buffer.from('Vivari '.repeat(400) + 'café € zlib #11');

// sync round-trips
assert.ok(zlib.gunzipSync(zlib.gzipSync(data)).equals(data), 'gzipSync/gunzipSync round-trip');
assert.ok(zlib.inflateSync(zlib.deflateSync(data)).equals(data), 'deflateSync/inflateSync round-trip');
assert.ok(zlib.inflateRawSync(zlib.deflateRawSync(data)).equals(data), 'deflateRawSync/inflateRawSync round-trip');
assert.ok(zlib.unzipSync(zlib.gzipSync(data)).equals(data), 'unzipSync auto-detects gzip');
assert.ok(zlib.unzipSync(zlib.deflateSync(data)).equals(data), 'unzipSync auto-detects zlib');

// cross-compat: a gzip buffer made by the REAL Node zlib must decode here.
// (Produced by host node:zlib gzipSync of the expected string below.)
const fromNode = Buffer.from('H4sIAAAAAAAAAwvLLEssylSoyslMUlA2NFR41DBFITkx7fBKhUdNawAosGQvHQAAAA==', 'base64');
assert.strictEqual(zlib.gunzipSync(fromNode).toString('utf8'), 'Vivari zlib #11 — café €', 'gunzip a Node-produced gzip');

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

  // === #12b (S3): scrypt + asymmetric (ECDSA P-256/P-384, Ed25519, RSA) ===
  // Cross-validated against the host's real OpenSSL both directions: our sign is
  // verified by node:crypto, and node:crypto's signatures are verified by us.
  // Ed25519 is deterministic (RFC 8032), so its signature is compared byte-for-
  // byte; ECDSA is randomized, so it's proven by mutual verify. scrypt is a
  // deterministic KDF, so its output is byte-compared.
  const S3MSG = Buffer.from("vivari crypto s3 — sign me, verify me", "utf8");
  const s3ed = nodeCrypto.generateKeyPairSync("ed25519");
  const s3p256 = nodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const s3p384 = nodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-384" });
  const s3rsa = nodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pemPriv = (k) => k.export({ type: "pkcs8", format: "pem" });
  const pemPub = (k) => k.export({ type: "spki", format: "pem" });
  const PSS = {
    padding: nodeCrypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: nodeCrypto.constants.RSA_PSS_SALTLEN_DIGEST,
  };
  const cryptoS3Expected = {
    msgHex: S3MSG.toString("hex"),
    scrypt: nodeCrypto.scryptSync("password", "NaCl", 64, { N: 1024, r: 8, p: 16 }).toString("hex"),
    edPriv: pemPriv(s3ed.privateKey),
    edPub: pemPub(s3ed.publicKey),
    edSigHost: nodeCrypto.sign(null, S3MSG, s3ed.privateKey).toString("hex"),
    p256Priv: pemPriv(s3p256.privateKey),
    p256Pub: pemPub(s3p256.publicKey),
    p256SigHost: nodeCrypto.sign("sha256", S3MSG, s3p256.privateKey).toString("hex"),
    p384Priv: pemPriv(s3p384.privateKey),
    p384Pub: pemPub(s3p384.publicKey),
    p384SigHost: nodeCrypto.sign("sha384", S3MSG, s3p384.privateKey).toString("hex"),
    // RSA (S3 phase 2): RS256 (PKCS1v15) + PS256 (PSS) signed on the host.
    rsaPriv: pemPriv(s3rsa.privateKey),
    rsaPub: pemPub(s3rsa.publicKey),
    rsaPss: PSS,
    rs256SigHost: nodeCrypto.sign("RSA-SHA256", S3MSG, s3rsa.privateKey).toString("hex"),
    ps256SigHost: nodeCrypto
      .sign("RSA-SHA256", S3MSG, { key: s3rsa.privateKey, ...PSS })
      .toString("hex"),
    // OAEP ciphertext (default sha1) the VM must decrypt with the private key.
    oaepCtHost: nodeCrypto.publicEncrypt(s3rsa.publicKey, S3MSG).toString("hex"),
  };
  kernel.writeFile(
    "/t/cryptos3.js",
    `
const assert = require('assert');
const crypto = require('crypto');
const E = ${JSON.stringify(cryptoS3Expected)};
const msg = Buffer.from(E.msgHex, 'hex');

// --- scrypt (deterministic KDF): byte-for-byte vs OpenSSL ---
assert.strictEqual(
  crypto.scryptSync('password', 'NaCl', 64, { N: 1024, r: 8, p: 16 }).toString('hex'),
  E.scrypt, 'scryptSync matches node');

// --- Ed25519 (deterministic) ---
// our verify of OpenSSL's signature:
assert.strictEqual(crypto.verify(null, msg, E.edPub, Buffer.from(E.edSigHost, 'hex')), true,
  'ed25519: we verify OpenSSL signature');
// our signature must equal OpenSSL's (RFC 8032 determinism):
const edSig = crypto.sign(null, msg, E.edPriv);
assert.strictEqual(edSig.toString('hex'), E.edSigHost, 'ed25519: our signature == OpenSSL (deterministic)');
// derive the public key from the private and re-verify:
const edPubDerived = crypto.createPublicKey(E.edPriv);
assert.strictEqual(crypto.verify(null, msg, edPubDerived, edSig), true, 'ed25519: createPublicKey(priv) derives a working key');

// --- ECDSA P-256 / ES256 (randomized -> mutual verify) ---
assert.strictEqual(crypto.verify('sha256', msg, E.p256Pub, Buffer.from(E.p256SigHost, 'hex')), true,
  'p256: we verify OpenSSL DER signature');
const p256Sig = crypto.sign('sha256', msg, E.p256Priv);         // DER (Node default)
assert.strictEqual(crypto.verify('sha256', msg, E.p256Pub, p256Sig), true, 'p256: our DER sign round-trips');
// ieee-p1363 (JOSE) raw r||s is 64 bytes and round-trips:
const p256Raw = crypto.sign('sha256', msg, { key: E.p256Priv, dsaEncoding: 'ieee-p1363' });
assert.strictEqual(p256Raw.length, 64, 'p256: ieee-p1363 signature is 64 bytes (r||s)');
assert.strictEqual(
  crypto.verify('sha256', msg, { key: E.p256Pub, dsaEncoding: 'ieee-p1363' }, p256Raw), true,
  'p256: ieee-p1363 round-trips');
// a tampered message must fail verification:
assert.strictEqual(crypto.verify('sha256', Buffer.from('other'), E.p256Pub, p256Sig), false, 'p256: rejects wrong message');

// --- ECDSA P-384 / ES384 ---
assert.strictEqual(crypto.verify('sha384', msg, E.p384Pub, Buffer.from(E.p384SigHost, 'hex')), true,
  'p384: we verify OpenSSL signature');
const p384Sig = crypto.sign('sha384', msg, E.p384Priv);
assert.strictEqual(crypto.verify('sha384', msg, E.p384Pub, p384Sig), true, 'p384: our sign round-trips');

// --- createSign/createVerify streaming (ES256) ---
const streamSig = crypto.createSign('SHA256').update('foo').update('bar').sign(E.p256Priv);
assert.strictEqual(
  crypto.createVerify('SHA256').update('foobar').verify(E.p256Pub, streamSig), true,
  'createSign/createVerify stream (ES256) round-trips');

// --- generateKeyPairSync round-trips (ec + ed25519) ---
const gEc = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
assert.strictEqual(gEc.publicKey.type, 'public', 'generated ec KeyObject');
const gSig = crypto.sign('sha256', msg, gEc.privateKey);
assert.strictEqual(crypto.verify('sha256', msg, gEc.publicKey, gSig), true, 'generated ec key signs+verifies');
const gEd = crypto.generateKeyPairSync('ed25519', {
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
assert.ok(gEd.privateKey.includes('BEGIN PRIVATE KEY'), 'generated ed25519 exports PKCS#8 PEM');
assert.strictEqual(crypto.verify(null, msg, gEd.publicKey, crypto.sign(null, msg, gEd.privateKey)), true,
  'generated ed25519 key signs+verifies');

// --- RSA (S3 phase 2): RS256 (PKCS1v15) + PS256 (PSS) ---
// modulusLength is surfaced (jsonwebtoken@9 reads it during key validation):
assert.strictEqual(crypto.createPublicKey(E.rsaPub).asymmetricKeyDetails.modulusLength, 2048,
  'rsa: asymmetricKeyDetails.modulusLength');
// we verify OpenSSL's RS256 signature, and our RS256 round-trips:
assert.strictEqual(crypto.verify('RSA-SHA256', msg, E.rsaPub, Buffer.from(E.rs256SigHost, 'hex')), true,
  'rs256: we verify OpenSSL signature');
const rs256Sig = crypto.createSign('RSA-SHA256').update(msg).sign(E.rsaPriv);   // deterministic
assert.strictEqual(rs256Sig.toString('hex'), E.rs256SigHost, 'rs256: our signature == OpenSSL (PKCS1v15 deterministic)');
assert.strictEqual(crypto.verify('RSA-SHA256', Buffer.from('nope'), E.rsaPub, rs256Sig), false, 'rs256: rejects wrong message');
// PSS is randomized -> mutual verify:
assert.strictEqual(crypto.verify('RSA-SHA256', msg, { key: E.rsaPub, ...E.rsaPss }, Buffer.from(E.ps256SigHost, 'hex')), true,
  'ps256: we verify OpenSSL PSS signature');
const ps256Sig = crypto.createSign('RSA-SHA256').update(msg).sign({ key: E.rsaPriv, ...E.rsaPss });
assert.strictEqual(crypto.verify('RSA-SHA256', msg, { key: E.rsaPub, ...E.rsaPss }, ps256Sig), true, 'ps256: our PSS round-trips');
// RSA-OAEP: decrypt the host's ciphertext; and our own encrypt round-trips:
assert.strictEqual(crypto.privateDecrypt(E.rsaPriv, Buffer.from(E.oaepCtHost, 'hex')).toString('hex'), E.msgHex,
  'oaep: we decrypt OpenSSL ciphertext');
assert.strictEqual(crypto.privateDecrypt(E.rsaPriv, crypto.publicEncrypt(E.rsaPub, msg)).toString('hex'), E.msgHex,
  'oaep: our encrypt/decrypt round-trips');
// generateKeyPairSync('rsa') signs+verifies:
const gRsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
assert.strictEqual(crypto.verify('RSA-SHA256', msg, gRsa.publicKey, crypto.sign('RSA-SHA256', msg, gRsa.privateKey)), true,
  'generated rsa key signs+verifies');

// emit our signatures so the host can verify them with real OpenSSL:
console.log('SIG_ED25519=' + edSig.toString('hex'));
console.log('SIG_P256=' + p256Sig.toString('hex'));
console.log('SIG_P384=' + p384Sig.toString('hex'));
console.log('SIG_RS256=' + rs256Sig.toString('hex'));
console.log('SIG_PS256=' + ps256Sig.toString('hex'));
console.log('CRYPTOS3_OK');
`,
  );
  const cs3 = await kernel.start("node", ["/t/cryptos3.js"], { cwd: "/t", capture: true });
  assert(cs3.code === 0 && cs3.stdout.includes("CRYPTOS3_OK"),
    "Path B (S3): scrypt + Ed25519/ECDSA/RSA sign+verify + RSA-OAEP on the Rust/Wasm codec (mutually verified vs node:crypto)");
  // Close the loop: OpenSSL must accept the signatures our Wasm codec produced.
  const grab = (re) => (cs3.stdout.match(re) || [])[1];
  assert(
    nodeCrypto.verify(null, S3MSG, s3ed.publicKey, Buffer.from(grab(/SIG_ED25519=([0-9a-f]+)/), "hex")),
    "OpenSSL verifies our Ed25519 signature");
  assert(
    nodeCrypto.verify("sha256", S3MSG, s3p256.publicKey, Buffer.from(grab(/SIG_P256=([0-9a-f]+)/), "hex")),
    "OpenSSL verifies our ECDSA P-256 signature");
  assert(
    nodeCrypto.verify("sha384", S3MSG, s3p384.publicKey, Buffer.from(grab(/SIG_P384=([0-9a-f]+)/), "hex")),
    "OpenSSL verifies our ECDSA P-384 signature");
  assert(
    nodeCrypto.verify("RSA-SHA256", S3MSG, s3rsa.publicKey, Buffer.from(grab(/SIG_RS256=([0-9a-f]+)/), "hex")),
    "OpenSSL verifies our RSA RS256 signature");
  assert(
    nodeCrypto.verify("RSA-SHA256", S3MSG, { key: s3rsa.publicKey, ...PSS }, Buffer.from(grab(/SIG_PS256=([0-9a-f]+)/), "hex")),
    "OpenSSL verifies our RSA PS256 (PSS) signature");

  // === #12c (S3 phase 3): X.509 (new X509Certificate) + SEC1 EC private keys ===
  // Cross-validated against the host's real node:crypto/OpenSSL: our parsed cert
  // fields must equal what host X509Certificate produces for the same fixture,
  // and a signature our SEC1-parsed EC key makes must verify under OpenSSL.
  const x509Base = new URL("./fixtures/x509/", import.meta.url);
  const readFix = (f) => readFileSync(new URL(f, x509Base), "utf8");
  const rsaCertPem = readFix("rsa-cert.pem");
  const ecCertPem = readFix("ec-cert.pem");
  const ecSec1KeyPem = readFix("ec-key-sec1.pem");
  const ecPubPem = readFix("ec-pub.pem");
  const certExpected = (pem) => {
    const x = new nodeCrypto.X509Certificate(pem);
    return {
      subject: x.subject,
      issuer: x.issuer,
      serialNumber: x.serialNumber,
      validFrom: x.validFrom,
      validTo: x.validTo,
      subjectAltName: x.subjectAltName ?? null,
      keyUsage: x.keyUsage ?? null,
      ca: x.ca,
      fingerprint256: x.fingerprint256,
      pubType: x.publicKey.asymmetricKeyType,
      pubSpki: x.publicKey.export({ type: "spki", format: "pem" }),
    };
  };
  const cryptoX509Expected = {
    msgHex: S3MSG.toString("hex"),
    rsaCertPem,
    ecCertPem,
    ecSec1KeyPem,
    ecPubPem,
    rsa: certExpected(rsaCertPem),
    ec: certExpected(ecCertPem),
  };
  kernel.writeFile(
    "/t/cryptox509.js",
    `
const assert = require('assert');
const crypto = require('crypto');
const E = ${JSON.stringify(cryptoX509Expected)};
const msg = Buffer.from(E.msgHex, 'hex');

function checkCert(pem, exp, label) {
  const x = new crypto.X509Certificate(pem);
  assert.strictEqual(x.subject, exp.subject, label + ': subject');
  assert.strictEqual(x.issuer, exp.issuer, label + ': issuer');
  assert.strictEqual(x.serialNumber, exp.serialNumber, label + ': serialNumber');
  assert.strictEqual(x.validFrom, exp.validFrom, label + ': validFrom');
  assert.strictEqual(x.validTo, exp.validTo, label + ': validTo');
  assert.strictEqual(x.subjectAltName ?? null, exp.subjectAltName, label + ': subjectAltName');
  assert.strictEqual(JSON.stringify(x.keyUsage ?? null), JSON.stringify(exp.keyUsage), label + ': keyUsage');
  assert.strictEqual(x.ca, exp.ca, label + ': ca');
  assert.strictEqual(x.fingerprint256, exp.fingerprint256, label + ': fingerprint256');
  assert.strictEqual(x.publicKey.asymmetricKeyType, exp.pubType, label + ': publicKey type');
  assert.strictEqual(x.publicKey.export({ type: 'spki', format: 'pem' }), exp.pubSpki, label + ': publicKey SPKI');
  assert.strictEqual(x.verify(x.publicKey), true, label + ': self-signed verify');
  assert.strictEqual(x.checkIssued(x), true, label + ': checkIssued(self)');
  return x;
}

const rsaCert = checkCert(E.rsaCertPem, E.rsa, 'rsa-cert');
const ecCert = checkCert(E.ecCertPem, E.ec, 'ec-cert');

// A cert must NOT verify under a foreign public key (and returns false, not throw).
assert.strictEqual(rsaCert.verify(ecCert.publicKey), false, 'x509: rejects foreign key');
assert.strictEqual(rsaCert.checkIssued(ecCert), false, 'x509: not issued by an unrelated cert');

// raw is the DER; toString round-trips to a CERTIFICATE PEM that re-parses.
assert.ok(Buffer.isBuffer(rsaCert.raw) && rsaCert.raw.length > 0, 'x509: raw DER');
assert.strictEqual(new crypto.X509Certificate(rsaCert.toString()).serialNumber, E.rsa.serialNumber, 'x509: toString round-trips');

// --- SEC1 'EC PRIVATE KEY' parsing (phase 3) ---
const sec1 = crypto.createPrivateKey(E.ecSec1KeyPem);
assert.strictEqual(sec1.asymmetricKeyType, 'ec', 'sec1: parsed as EC');
const sec1Sig = crypto.sign('sha256', msg, sec1);
assert.strictEqual(crypto.verify('sha256', msg, E.ecPubPem, sec1Sig), true, 'sec1: sign/verify round-trips');
assert.strictEqual(crypto.verify('sha256', msg, crypto.createPublicKey(sec1), sec1Sig), true, 'sec1: createPublicKey(sec1) works');

console.log('SEC1_SIG=' + sec1Sig.toString('hex'));
console.log('CRYPTOX509_OK');
`,
  );
  const cx = await kernel.start("node", ["/t/cryptox509.js"], { cwd: "/t", capture: true });
  assert(
    cx.code === 0 && cx.stdout.includes("CRYPTOX509_OK"),
    "Path B (S3 phase 3): X509Certificate parse/verify + SEC1 EC keys (mutually verified vs node:crypto)");
  // Close the loop: OpenSSL must accept the ECDSA signature our SEC1-parsed key made.
  const grab509 = (re) => (cx.stdout.match(re) || [])[1];
  assert(
    nodeCrypto.verify("sha256", S3MSG, nodeCrypto.createPublicKey(ecPubPem), Buffer.from(grab509(/SEC1_SIG=([0-9a-f]+)/), "hex")),
    "OpenSSL verifies our SEC1-key ECDSA signature");

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

  // dynamic import() in a .cjs file must expose a FUNCTION export's own statics as
  // named exports (Node's CJS->ESM interop). Regression guard for the PGlite in-VM
  // template: its Emscripten glue does `const { createRequire } = await import('module')`,
  // and the `module` builtin export IS the Module *function* with createRequire hung off
  // it — keying only objects made that undefined ("e is not a function" in create()).
  kernel.mkdirp("/dbimp");
  kernel.writeFile(
    "/dbimp/fnexport.cjs",
    "function f(){ return 1; } f.STAT = 'ok'; module.exports = f;\n",
  );
  kernel.writeFile(
    "/dbimp/main.cjs",
    "(async () => {\n" +
      "  const assert = require('assert');\n" +
      "  const mod = await import('module');\n" +
      "  assert.strictEqual(typeof mod.createRequire, 'function', 'import(module).createRequire');\n" +
      "  assert.ok(mod.default, 'import(module).default present');\n" +
      "  const fn = await import('./fnexport.cjs');\n" +
      "  assert.strictEqual(typeof fn.default, 'function', 'default is the function export');\n" +
      "  assert.strictEqual(fn.STAT, 'ok', 'function export static surfaces as a named export');\n" +
      "  console.log('CJSDYN_OK');\n" +
      "})().catch((e) => { console.error(e); process.exit(1); });\n",
  );
  const cjsdyn = await kernel.start("node", ["/dbimp/main.cjs"], { cwd: "/dbimp", capture: true });
  assert(cjsdyn.code === 0 && cjsdyn.stdout.includes("CJSDYN_OK"),
    "esm: dynamic import() in a .cjs exposes a function export's statics as named exports (createRequire on 'module')");

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

  // === #16 stage 2a: napi-on-wasm — run a REAL N-API native addon =========
  // @node-rs/crc32-wasm32-wasi is a Rust crate compiled to a wasm32-wasi N-API
  // addon. It runs unmodified via `require()`: its napi-rs wrapper pulls our
  // vendored @napi-rs/wasm-runtime (the emnapi host, pure JS) which implements
  // the napi_* import surface, while the wasm's wasi_snapshot_preview1 imports
  // are satisfied by our own require('wasi'). crc32/crc32c must match the values
  // the same addon produces under host Node (907060870 / 2591144780).
  const crc32Dir = new URL("./fixtures/napi-crc32/", import.meta.url);
  kernel.mkdirp("/napi/node_modules/@node-rs/crc32-wasm32-wasi");
  const crcBase = "/napi/node_modules/@node-rs/crc32-wasm32-wasi/";
  kernel.writeFile(crcBase + "package.json", readFileSync(new URL("package.json", crc32Dir), "utf8"));
  kernel.writeFile(crcBase + "crc32.wasi.cjs", readFileSync(new URL("crc32.wasi.cjs", crc32Dir), "utf8"));
  kernel.writeFile(crcBase + "crc32.wasm32-wasi.wasm", new Uint8Array(readFileSync(new URL("crc32.wasm32-wasi.wasm", crc32Dir))));
  kernel.writeFile(
    "/napi/index.js",
    `
const crc = require('@node-rs/crc32-wasm32-wasi');
console.log('crc32=' + crc.crc32('hello'));
console.log('crc32c=' + crc.crc32c('hello'));
console.log('crc32-buf=' + crc.crc32(Buffer.from('hello')));
`,
  );
  const napi = await kernel.start("node", ["/napi/index.js"], { cwd: "/napi", capture: true });
  assert(napi.code === 0 && napi.stdout.includes("crc32=907060870"),
    "Phase 2 #16 stage 2a: napi-rs wasm32-wasi addon runs via require() over vendored emnapi + our WASI (crc32 matches host)");
  assert(napi.stdout.includes("crc32c=2591144780"),
    "Phase 2 #16 stage 2a: a second N-API export (crc32c) returns the correct value");
  assert(napi.stdout.includes("crc32-buf=907060870"),
    "Phase 2 #16 stage 2a: N-API accepts a Buffer arg (napi_get_buffer_info) — same crc32 as the string");

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

  // connecting to an unbound port rejects with ECONNREFUSED -- and does so in the
  // ORDER real Node uses, which is the part that was wrong and the part this
  // assertion exists for. A handle close callback is a later loop phase in libuv,
  // and lib/net.js leans on that: it closes the handle and then lets the stream
  // emit "error" on a tick of its own. Our binding used to schedule the close
  // callback on the tick queue, so "close" overtook "error". Reading only the code
  // cannot see that, and the only thing that noticed was lib/http.js three checks
  // below, which reported it as a mysterious ECONNRESET.
  const order = [];
  await new Promise((resolve, reject) => {
    const c = net.connect(65530, '127.0.0.1');
    c.on('connect', () => reject(new Error('unexpectedly connected')));
    c.on('error', (e) => {
      order.push('error:' + e.code);
      assert.strictEqual(e.code, 'ECONNREFUSED', 'refused sets code ECONNREFUSED');
    });
    c.on('close', () => { order.push('close'); resolve(); });
  });
  assert.deepStrictEqual(order, ['error:ECONNREFUSED', 'close'],
    'a refused connection emits error BEFORE close, as libuv does: ' + JSON.stringify(order));

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
  // _http_* running on internalBinding('http_parser') over the net loopback. The
  // parser is now real llhttp compiled to Wasm (process.versions.llhttp is set
  // when the Wasm backend is live), with a pure-JS fallback. Proves an in-VM
  // server + client: POST with a body, GET with no body, a chunked (no
  // content-length) response, a chunked (streamed) request body, response
  // headers, keep-alive socket reuse, HEAD (skip-body), 204 (no body), response
  // trailers, and ECONNREFUSED.
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
  if (req.method === 'HEAD') {
    res.writeHead(200, { 'content-length': '1234', 'x-demo': 'head' });
    res.end(); // HEAD: headers only, parser must skip the (absent) body
    return;
  }
  if (req.url === '/nocontent') {
    res.writeHead(204); res.end(); // 204: no body regardless of headers
    return;
  }
  if (req.url === '/trailers') {
    res.writeHead(200, { 'content-type': 'text/plain', 'Trailer': 'X-Sum' });
    res.write('trail'); res.addTrailers({ 'X-Sum': '42' }); res.end();
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
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, trailers: res.trailers, body: data }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function main() {
  await new Promise((r) => server.listen(0, r)); // ephemeral port
  const port = server.address().port;
  assert.ok(port > 0, 'http server.address() returns a bound port');

  // The Wasm llhttp backend advertises itself via process.versions.llhttp.
  assert.ok(process.versions.llhttp, 'llhttp Wasm parser active: ' + process.versions.llhttp);

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

  // client streams a chunked request body (no content-length); server echoes it.
  const creq = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/chunkreq' }, (res) => {
      let d = ''; res.setEncoding('utf8');
      res.on('data', (c) => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject);
    req.write('AAA'); req.write('BBB'); req.end('CCC'); // no content-length => chunked request
  });
  assert.strictEqual(JSON.parse(creq.body).echo, 'AAABBBCCC', 'chunked request body reassembled');

  // HEAD: response has headers (incl. content-length) but the parser skips the body.
  const head = await request(port, '/', 'HEAD');
  assert.strictEqual(head.status, 200, 'HEAD status 200');
  assert.strictEqual(head.headers['content-length'], '1234', 'HEAD content-length header present');
  assert.strictEqual(head.body, '', 'HEAD delivers no body');

  // 204: no body regardless of headers.
  const nc = await request(port, '/nocontent', 'GET');
  assert.strictEqual(nc.status, 204, '204 status');
  assert.strictEqual(nc.body, '', '204 delivers no body');

  // response trailers (chunked) surface on res.trailers.
  const tr = await request(port, '/trailers', 'GET');
  assert.strictEqual(tr.body, 'trail', 'trailer response body');
  assert.strictEqual(tr.trailers['x-sum'], '42', 'response trailer parsed');

  // connecting to an unbound port surfaces ECONNREFUSED on the request -- ONCE.
  // While the socket emitted close before error, this arrived as TWO error events:
  // "ECONNRESET: socket hang up" first, because socketCloseListener reads a close
  // with no error recorded as the server hanging up, and the real ECONNREFUSED a
  // phase later. The count matters as much as the code: a caller that has already
  // handled the first one is destroyed by the second.
  const httpErrors = [];
  await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: 65531, path: '/', agent: false });
    req.on('error', (e) => {
      httpErrors.push(e.code);
      assert.strictEqual(e.code, 'ECONNREFUSED', 'http refused sets ECONNREFUSED');
      setTimeout(resolve, 50);
    });
    req.end();
  });
  assert.strictEqual(httpErrors.length, 1,
    'a refused request emits exactly one error: ' + JSON.stringify(httpErrors));

  await new Promise((r) => server.close(r));
  console.log('HTTPB_OK');
}
main().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
`,
  );
  const hb = await kernel.start("node", ["/t/httpb.js"], { cwd: "/t", capture: true });
  assert(hb.code === 0 && hb.stdout.includes("HTTPB_OK"),
    "Path B: real Node lib/http.js on llhttp-Wasm (POST/GET, chunked req+res, HEAD, 204, trailers, keep-alive, ECONNREFUSED)");

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

  // === #16 stage 2c: npm auto-selects the wasm build of a native package ===
  // `npm install napipkg` sees three optionalDependencies (one per platform).
  // Only napipkg-wasm32-wasi may run on this wasm32 host, so that's the only one
  // installed; the darwin build is name-skipped and the neutrally-named x64 build
  // is fetched-then-cpu-skipped. Neither being installed must not fail the run.
  kernel.mkdirp("/napipkg-app");
  kernel.writeFile("/napipkg-app/package.json", JSON.stringify({ name: "napipkg-app", version: "1.0.0" }));
  const npmN = await kernel.start("npm", ["install", "napipkg"], { cwd: "/napipkg-app", capture: true });
  assert(npmN.code === 0 && kernel.exists("/napipkg-app/node_modules/napipkg-wasm32-wasi/package.json"),
    "Phase 2 #16 st2c: npm installs the wasm32-wasi optional dependency");
  assert(!kernel.exists("/napipkg-app/node_modules/napipkg-darwin-arm64") &&
    !kernel.exists("/napipkg-app/node_modules/napipkg-neutralnative"),
    "Phase 2 #16 st2c: npm skips the native (darwin/x64) optional dependencies");
  kernel.writeFile("/napipkg-app/run.js",
    "const p = require('napipkg'); console.log(p.id + '|' + p.add(2, 3));");
  const npkgRun = await kernel.start("node", ["/napipkg-app/run.js"], { cwd: "/napipkg-app", capture: true });
  assert(npkgRun.code === 0 && npkgRun.stdout.trim() === "wasm32-wasi|5",
    "Phase 2 #16 st2c: meta package loads + re-exports the auto-selected wasm build");

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

  // Loop liveness for host-backed async: a bare script that only `await`s a
  // WebAssembly.compile (whose promise resolves on the HOST's queue, not ours)
  // must NOT exit before it settles. No timers, no keep-alive — the empty-module
  // header is a valid wasm binary. Before the fix this printed nothing (loop saw
  // no ref'd work and exited); now hostLiveness holds it open until it resolves.
  kernel.writeFile(
    "/t/hostwasm.js",
    `
const bytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
WebAssembly.compile(bytes).then(
  (m) => console.log('WASM_COMPILE_OK ' + (m instanceof WebAssembly.Module)),
  (e) => console.log('WASM_COMPILE_ERR ' + e),
);
`,
  );
  const hw = await kernel.start("node", ["/t/hostwasm.js"], { cwd: "/t", capture: true });
  assert(hw.code === 0 && hw.stdout.includes("WASM_COMPILE_OK true"),
    "Event loop: a pending WebAssembly.compile keeps the loop alive (no manual keep-alive)");

  // process.exit() from a raw Promise microtask (async continuation) — its throw
  // sentinel escapes the loop's runCallback, but exit() also flags the loop and a
  // host-realm safety net swallows the escaped sentinel. Must exit with the code,
  // not crash the worker. (Before the fix this aborted the worker / lost the code.)
  kernel.writeFile(
    "/t/exitmicro.js",
    `
(async () => {
  await Promise.resolve();
  console.log('BEFORE_EXIT');
  process.exit(3);
  console.log('AFTER_EXIT_SHOULD_NOT_PRINT');
})();
`,
  );
  const ex1 = await kernel.start("node", ["/t/exitmicro.js"], { cwd: "/t", capture: true });
  assert(
    ex1.code === 3 && ex1.stdout.includes("BEFORE_EXIT") && !ex1.stdout.includes("AFTER_EXIT_SHOULD_NOT_PRINT"),
    "process.exit(): honoured from an async continuation microtask (code 3, stops synchronously)",
  );

  // process.exit() from a Promise .catch() handler (the exact shape that crashed
  // the esbuild test): a rejected chain whose handler exits.
  kernel.writeFile(
    "/t/exitcatch.js",
    `Promise.reject(new Error('boom')).catch(() => { console.log('IN_CATCH'); process.exit(7); });`,
  );
  const ex2 = await kernel.start("node", ["/t/exitcatch.js"], { cwd: "/t", capture: true });
  assert(ex2.code === 7 && ex2.stdout.includes("IN_CATCH"),
    "process.exit(): honoured from a Promise .catch() handler (code 7)");

  // Large whole-file reads: a file bigger than the 1 MiB shared syscall window
  // must round-trip. readFileSync(path) (buffer) already loops via fd; the utf8
  // fast path used to read the whole file in one shot and overflowed the window
  // ("offset is out of bounds") — it now falls back to the chunked fd path on
  // EFBIG. (This is what blocked `npm install` of packages with big packuments.)
  kernel.writeFile(
    "/t/reader.js",
    `
const fs = require('fs');
const big = 'A'.repeat(3 * 1024 * 1024) + 'END'; // ~3 MiB, well over the 1 MiB window
fs.writeFileSync('/t/big.txt', big);
const utf8 = fs.readFileSync('/t/big.txt', 'utf8');
const buf = fs.readFileSync('/t/big.txt');
console.log('UTF8_OK ' + (utf8.length === big.length && utf8.endsWith('END')));
console.log('BUF_OK ' + (buf.length === big.length && buf[buf.length - 1] === 68));
`,
  );
  const rd = await kernel.start("node", ["/t/reader.js"], { cwd: "/t", capture: true });
  assert(
    rd.code === 0 && rd.stdout.includes("UTF8_OK true") && rd.stdout.includes("BUF_OK true"),
    "fs: readFileSync (utf8 + buffer) handles a file larger than the shared window",
  );

  // === blocking stdin — a process that parks until somebody types ============
  //
  // Every other stdin path here is a flowing stream: the kernel posts a chunk and
  // the runtime delivers it on a loop turn. That cannot serve a reader that has
  // to have the bytes before it returns — a synchronous C-level read, which is
  // what CPython's input() is under WebAssembly. OP_READ_STDIN is the answer, and
  // this is the part of it that no stub can check: the process really parks, the
  // keystroke really arrives through shared memory, and the kernel really holds
  // what was typed early instead of dropping it into a stream nobody is reading.
  {
    kernel.mkdirp("/stdin");
    // Results go to files, not stdout: a process that can park is a process that
    // is not `capture: true`, so there is nothing collecting its output here.
    kernel.writeFile(
      "/stdin/ask.js",
      `const fs = require('fs');
fs.writeFileSync('/stdin/ready.txt', 'up');
const first = globalThis.__ocReadStdin();
fs.writeFileSync('/stdin/first.json', JSON.stringify(first));
const rest = [globalThis.__ocReadStdin(), globalThis.__ocReadStdin(), globalThis.__ocReadStdin()];
fs.writeFileSync('/stdin/rest.json', JSON.stringify(rest));
`,
    );
    const pid = kernel.launch("node", ["/stdin/ask.js"], { cwd: "/stdin" });
    await waitFor(() => kernel.exists("/stdin/ready.txt"), "the stdin reader never started");

    // Nothing has been typed, so it must still be inside that call. If this ever
    // became "returns EOF immediately" the feature would look like it worked
    // while quietly making input() unusable.
    await sleep(150);
    assert(!kernel.exists("/stdin/first.json"),
      "a synchronous read of stdin parks the process instead of returning nothing");
    assert(kernel.procs.get(pid)?.stdinWaiting === true,
      "…and the kernel knows which process is waiting, rather than the process polling");

    kernel.sendStdin(pid, "hello\n");
    await waitFor(() => kernel.exists("/stdin/first.json"), "a typed line never reached the parked reader");
    assert(kernel.readFile("/stdin/first.json") === JSON.stringify("hello\n"),
      "the line arrives through shared memory, newline and all");

    // Typed while it is NOT waiting — between two reads. On the flowing path
    // these would be delivered to a stream this process never reads, and lost.
    kernel.sendStdin(pid, "second\n");
    kernel.sendStdin(pid, "third\n");
    kernel.sendStdin(pid, null); // end of input
    await waitFor(() => kernel.exists("/stdin/rest.json"), "the reader never finished");
    assert(kernel.readFile("/stdin/rest.json") === JSON.stringify(["second\n", "third\n", null]),
      "type-ahead is kept in order and end of input arrives as null, which is what a reader turns into EOF");

    // A process nobody can type at must not park: `capture: true` is the shape
    // spawnSync uses, where the only party who could send stdin is itself parked
    // waiting for this one to exit.
    kernel.writeFile("/stdin/closed.js",
      `const t = Date.now();
const got = globalThis.__ocReadStdin();
console.log(JSON.stringify({ got, quick: Date.now() - t < 500 }));
`);
    const closed = await kernel.start("node", ["/stdin/closed.js"], { cwd: "/stdin", capture: true });
    assert(closed.code === 0 && closed.stdout.includes('"got":null') && closed.stdout.includes('"quick":true'),
      "a captured process reads end-of-input at once rather than deadlocking on a keystroke that cannot come");

    // And none of this may disturb the flowing path every other program uses.
    kernel.writeFile("/stdin/flow.js",
      `const fs = require('fs');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c.toString()));
process.stdin.on('end', () => { fs.writeFileSync('/stdin/flow.txt', chunks.join('')); });
fs.writeFileSync('/stdin/flow-ready.txt', 'up');
`);
    const flowPid = kernel.launch("node", ["/stdin/flow.js"], { cwd: "/stdin" });
    await waitFor(() => kernel.exists("/stdin/flow-ready.txt"), "the flowing reader never started");
    kernel.sendStdin(flowPid, "streamed\n");
    kernel.sendStdin(flowPid, null);
    await waitFor(() => kernel.exists("/stdin/flow.txt"), "a process that never made the syscall stopped receiving stdin");
    assert(kernel.readFile("/stdin/flow.txt") === "streamed\n",
      "a process that never reads synchronously still gets stdin the way it always did");
  }

  // === #15: async child_process.spawn — streaming stdio + exit + kill =========
  // A child that prints across timers proves output STREAMS live (arrives as
  // multiple 'data' events while the child runs its own loop), not buffered until
  // exit like spawnSync. The parent stays in its event loop the whole time.
  kernel.writeFile(
    "/t/child-stream.js",
    `
console.log('line1');
setTimeout(() => console.log('line2'), 10);
setTimeout(() => { console.log('line3'); process.exit(7); }, 20);
`,
  );
  kernel.writeFile(
    "/t/spawnb.js",
    `
const cp = require('child_process');
const assert = require('assert');
const chunks = [];
let dataEvents = 0;
let sawFirstBeforeClose = false;
const child = cp.spawn('node', ['/t/child-stream.js'], { cwd: '/t' });
assert.ok(child.pid > 0, 'spawn returns a pid immediately (non-blocking)');
child.stdout.on('data', (d) => { dataEvents++; chunks.push(d.toString()); if (chunks.join('').indexOf('line1') >= 0) sawFirstBeforeClose = true; });
child.on('exit', (code, signal) => {
  assert.strictEqual(code, 7, 'child exit code propagates');
  assert.strictEqual(signal, null, 'no signal on a normal exit');
});
child.on('close', (code) => {
  const out = chunks.join('');
  assert.ok(out.indexOf('line1') >= 0 && out.indexOf('line2') >= 0 && out.indexOf('line3') >= 0, 'all streamed lines received in order');
  assert.ok(dataEvents >= 1 && sawFirstBeforeClose, 'stdout arrived as data events before close');
  console.log('SPAWN_ASYNC_OK events=' + dataEvents + ' code=' + code);
  process.exit(0);
});
`,
  );
  const spb = await kernel.start("node", ["/t/spawnb.js"], { cwd: "/t", capture: true });
  assert(spb.code === 0 && spb.stdout.includes("SPAWN_ASYNC_OK"),
    "Phase 2 #15: child_process.spawn streams stdout live + fires exit/close with the child's code");

  // kill(): a forever-running child (interval keeps it alive) is terminated by the
  // parent; the child reports exit code null + signal SIGTERM.
  kernel.writeFile("/t/child-forever.js", "console.log('alive');\nsetInterval(() => console.log('tick'), 5);\n");
  kernel.writeFile(
    "/t/killb.js",
    `
const cp = require('child_process');
const assert = require('assert');
const child = cp.spawn('node', ['/t/child-forever.js'], { cwd: '/t' });
let sawData = false;
child.stdout.on('data', () => { sawData = true; if (!child.killed) child.kill('SIGTERM'); });
child.on('exit', (code, signal) => {
  assert.strictEqual(signal, 'SIGTERM', 'killed child reports SIGTERM');
  assert.strictEqual(code, null, 'killed child has a null exit code');
  console.log('SPAWN_KILL_OK sawData=' + sawData);
  process.exit(0);
});
`,
  );
  const kib = await kernel.start("node", ["/t/killb.js"], { cwd: "/t", capture: true });
  assert(kib.code === 0 && kib.stdout.includes("SPAWN_KILL_OK sawData=true"),
    "Phase 2 #15: child.kill('SIGTERM') terminates a long-running child (exit null + signal)");

  // === #16 stage 2b: worker_threads — real nested Worker + shared memory =======
  // A Worker runs a real entry file as its own kernel-spawned thread (own syscall
  // SAB + FS registration). We prove: workerData crosses (incl. a SharedArrayBuffer),
  // the child sees isMainThread=false/threadId>0, message roundtrips both ways over
  // the direct MessageChannel, the child mutates shared memory the parent reads via
  // Atomics, and the child's exit code propagates to the Worker 'exit' event.
  kernel.writeFile(
    "/t/wt-child.js",
    `
const { parentPort, workerData, threadId, isMainThread } = require('worker_threads');
const shared = new Int32Array(workerData.sab);
Atomics.store(shared, 0, workerData.base + threadId); // parent reads this back
parentPort.on('message', (m) => {
  if (m === 'ping') parentPort.postMessage({ pong: true, isMainThread, threadId, got: workerData.hello });
  else if (m === 'bye') process.exit(5);
});
parentPort.postMessage('ready');
`,
  );
  kernel.writeFile(
    "/t/wt-parent.js",
    `
const { Worker, isMainThread, threadId } = require('worker_threads');
const assert = require('assert');
assert.ok(isMainThread, 'top-level isMainThread is true');
assert.strictEqual(threadId, 0, 'top-level threadId is 0');
const sab = new SharedArrayBuffer(8);
const shared = new Int32Array(sab);
const w = new Worker('/t/wt-child.js', { workerData: { hello: 'hi', base: 100, sab } });
let online = false, gotReady = false, childTid = 0;
w.on('online', () => { online = true; });
w.on('message', (m) => {
  if (m === 'ready') { gotReady = true; w.postMessage('ping'); }
  else if (m && m.pong) {
    childTid = m.threadId;
    assert.strictEqual(m.isMainThread, false, 'child sees isMainThread=false');
    assert.ok(m.threadId > 0, 'child has a non-zero threadId');
    assert.strictEqual(m.got, 'hi', 'workerData delivered to the child');
    assert.strictEqual(Atomics.load(shared, 0), 100 + m.threadId, 'child wrote SharedArrayBuffer the parent reads');
    w.postMessage('bye');
  }
});
w.on('exit', (code) => {
  assert.ok(online && gotReady, 'saw online + ready before exit');
  assert.strictEqual(code, 5, "child's process.exit(5) propagates to Worker 'exit'");
  assert.ok(w.threadId > 0 && w.threadId === childTid, 'Worker.threadId matches the child');
  console.log('WT_OK code=' + code + ' threadId=' + w.threadId);
  process.exit(0);
});
`,
  );
  const wtr = await kernel.start("node", ["/t/wt-parent.js"], { cwd: "/t", capture: true });
  assert(wtr.code === 0 && wtr.stdout.includes("WT_OK"),
    "Phase 2 #16 stage 2b: worker_threads.Worker runs a real nested thread (workerData + SAB + message roundtrip + exit code)");

  // === #16 stage 2b: receiveMessageOnPort (Node's synchronous port drain) ======
  // Piscina/tinypool's Atomics fast path pulls results with receiveMessageOnPort;
  // libraries also use it directly in manual polling mode. Prove: empty port ->
  // undefined, and after posting, messages drain out IN ORDER, then undefined again.
  kernel.writeFile(
    "/t/rmop.js",
    `
const { MessageChannel, receiveMessageOnPort } = require('worker_threads');
const assert = require('assert');
const { port1, port2 } = new MessageChannel();
assert.strictEqual(receiveMessageOnPort(port2), undefined, 'empty port -> undefined (also arms the inbox)');
port1.postMessage({ n: 1 });
port1.postMessage('two');
const got = [];
let ticks = 0;
const timer = setInterval(() => {
  let m;
  while ((m = receiveMessageOnPort(port2))) got.push(m.message);
  if (got.length >= 2 || ++ticks > 50) {
    clearInterval(timer);
    assert.strictEqual(got.length, 2, 'drained exactly 2 messages, got ' + got.length);
    assert.ok(got[0] && got[0].n === 1, 'message 1 drained in order');
    assert.strictEqual(got[1], 'two', 'message 2 drained in order');
    assert.strictEqual(receiveMessageOnPort(port2), undefined, 'empty again after drain');
    console.log('RMOP_OK');
    process.exit(0);
  }
}, 10);
`,
  );
  const rmop = await kernel.start("node", ["/t/rmop.js"], { cwd: "/t", capture: true });
  assert(rmop.code === 0 && rmop.stdout.includes("RMOP_OK"),
    "Phase 2 #16 stage 2b: receiveMessageOnPort drains queued port messages in order (manual polling mode)");

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

  // === brick 4b: shell pipes + redirects ===
  // Fixtures: a producer, an uppercasing stdin filter, and an emitter that writes
  // to BOTH stdout and stderr (lowercase) so we can prove where each byte flows.
  kernel.writeFile("/t/produce.js", "process.stdout.write('l1 l2 l3');\n");
  kernel.writeFile(
    "/t/upper.js",
    `let d = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { d += c; });
process.stdin.on('end', () => { process.stdout.write(d.toUpperCase()); });
`,
  );
  kernel.writeFile("/t/emit.js", "process.stdout.write('outline'); process.stderr.write('errline');\n");
  kernel.writeFile(
    "/pipe.sh",
    `echo hello | cat
node /t/produce.js | node /t/upper.js
echo first > /t/red.txt
echo second >> /t/red.txt
cat /t/red.txt
node /t/emit.js > /t/o.txt 2> /t/e.txt
cat /t/o.txt
cat /t/e.txt
node /t/emit.js 2>&1 | node /t/upper.js
node /t/upper.js < /t/red.txt
echo DEVNULL_SUPPRESSED > /dev/null
node /t/emit.js > /dev/null 2>&1
node /t/upper.js < /dev/null
false | true && echo LASTOK
true | false || echo LASTFAIL
echo SHPIPE_DONE
`,
  );
  const pipe = await kernel.start("sh", ["/pipe.sh"], { cwd: "/", capture: true });
  const po = pipe.stdout;
  assert(pipe.code === 0 && po.includes("SHPIPE_DONE"), "shell: pipe/redirect script runs to completion");
  assert(po.includes("hello"), "shell: basic pipe (echo hello | cat)");
  assert(po.includes("L1 L2 L3"), "shell: multi-stage pipe streams + transforms data (node | node)");
  assert(po.includes("first") && po.includes("second"), "shell: > truncates and >> appends (cat red.txt)");
  assert(po.includes("outline") && po.includes("errline"), "shell: > and 2> split stdout/stderr to separate files");
  assert(po.includes("OUTLINE") && po.includes("ERRLINE"), "shell: 2>&1 merges stderr into the pipe");
  assert(po.includes("FIRST") && po.includes("SECOND"), "shell: < feeds a file into a command's stdin");
  assert(!po.includes("DEVNULL_SUPPRESSED"), "shell: > /dev/null discards stdout");
  assert(!po.includes("/dev/null"), "shell: /dev/null redirects open no real fd (no error printed)");
  assert(po.includes("LASTOK"), "shell: pipeline exit status is the LAST stage (false | true => 0)");
  assert(po.includes("LASTFAIL"), "shell: pipeline exit status is the LAST stage (true | false => 1)");

  // === brick 4c: inline env-var prefix + node --env-file ===
  // envcheck.js prints the three env vars the script below sets three ways:
  //   inline prefix on a simple command, inline prefix on a pipeline stage, and
  //   `node --env-file`. A bare `NAME=value` sets the shell's own env for the rest
  //   of the session, so a later plain `node envcheck.js` still sees it.
  kernel.writeFile(
    "/t/envcheck.js",
    `process.stdout.write('ENV ' + (process.env.PORT || '-') + ' ' + (process.env.GREETING || '-') + ' ' + (process.env.FROM_FILE || '-') + '\\n');\n`,
  );
  kernel.writeFile("/t/app.env", "FROM_FILE=fromfile\n# comment\nGREETING=\"from file\"\n");
  kernel.writeFile(
    "/env.sh",
    `PORT=3000 node /t/envcheck.js
GREETING=hi node /t/envcheck.js | cat
node --env-file=/t/app.env /t/envcheck.js
FROM_FILE=inline node --env-file=/t/app.env /t/envcheck.js
export SHELLVAR=exported
PORT=7788
node /t/envcheck.js
echo ENVSH_DONE
`,
  );
  const envrun = await kernel.start("sh", ["/env.sh"], { cwd: "/", capture: true });
  const eo = envrun.stdout;
  assert(envrun.code === 0 && eo.includes("ENVSH_DONE"), "shell: env-prefix script runs to completion");
  assert(eo.includes("ENV 3000 - -"), "shell: inline NAME=value prefix scopes env to a simple command");
  assert(eo.includes("ENV - hi -"), "shell: inline NAME=value prefix works on a pipeline stage");
  assert(eo.includes("ENV - from file fromfile"), "node: --env-file loads KEY=VALUE (quotes stripped) into process.env");
  assert(eo.includes("ENV - from file inline"), "node: existing env takes precedence over --env-file");
  assert(eo.includes("ENV 7788 - -"), "shell: bare NAME=value sets the shell's own env for later commands");

  // === child_process: binary-safe parent -> child stdin ===
  // The parent writes all 256 byte values (in two chunks) to child.stdin and the
  // child echoes them back byte-for-byte, proving stdin is a real binary sink and
  // not utf8-mangled.
  kernel.writeFile(
    "/t/stdin-child.js",
    `const fs = require('fs');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const buf = Buffer.concat(chunks);
  fs.writeFileSync('/t/received.bin', buf);
  process.stdout.write('GOT ' + buf.length);
});
`,
  );
  kernel.writeFile(
    "/t/cstdin.js",
    `const cp = require('child_process');
const fs = require('fs');
const child = cp.spawn('node', ['/t/stdin-child.js'], { cwd: '/t' });
let out = '';
child.stdout.on('data', (d) => { out += d; });
const payload = Buffer.alloc(256);
for (let i = 0; i < 256; i++) payload[i] = i;
child.stdin.write(payload.slice(0, 128));
child.stdin.write(payload.slice(128));
child.stdin.end();
child.on('close', (code) => {
  const got = fs.readFileSync('/t/received.bin');
  let byteExact = got.length === 256;
  for (let i = 0; byteExact && i < 256; i++) if (got[i] !== i) byteExact = false;
  console.log('CSTDIN code=' + code + ' len=' + got.length + ' echoed=' + out.trim());
  if (code === 0 && byteExact) console.log('CSTDIN_OK');
});
`,
  );
  const cstdin = await kernel.start("node", ["/t/cstdin.js"], { cwd: "/t", capture: true });
  assert(
    cstdin.code === 0 && cstdin.stdout.includes("CSTDIN_OK"),
    "child_process: parent -> child.stdin delivers all 256 byte values intact (binary-safe write/end)",
  );

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

  // === fs.watch: push-based change events (roadmap #19 stage B) ===
  // A guest process watches /wd; the HOST (kernel client) then writes a file into
  // it. The change must be pushed cross-client from the File System Worker to the
  // watching process, firing its fs.watch callback. The guest signals via marker
  // files (the kernel's fs client can't read content, only test existence). It
  // filters on 'target.txt' so its own marker writes don't re-trigger.
  kernel.mkdirp("/wd");
  kernel.writeFile(
    "/wd/watcher.js",
    `
const fs = require('fs');
fs.watch('/wd', (event, filename) => {
  if (filename === 'target.txt') fs.writeFileSync('/wd/fired-' + event + '.txt', '1');
});
fs.writeFileSync('/wd/ready.txt', '1');
setInterval(() => {}, 1000);
`,
  );
  kernel.start("node", ["/wd/watcher.js"], { cwd: "/wd" });
  await waitFor(() => kernel.exists("/wd/ready.txt"), "watcher process did not start");
  kernel.writeFile("/wd/target.txt", "hello"); // creation -> 'rename'
  await waitFor(() => kernel.exists("/wd/fired-rename.txt"),
    "fs.watch did not fire on a cross-client create", 100);
  assert(kernel.exists("/wd/fired-rename.txt"),
    "fs.watch: a host write fires the watching process's callback ('rename' on create)");
  kernel.writeFile("/wd/target.txt", "hello again"); // modify -> 'change'
  await waitFor(() => kernel.exists("/wd/fired-change.txt"),
    "fs.watch did not fire on a cross-client modify", 100);
  assert(kernel.exists("/wd/fired-change.txt"),
    "fs.watch: a subsequent host write fires 'change' on the same watcher");

  // === fs.watch fan-out is bucketed by top-level tree (roadmap #19 optimize) ===
  // A watcher on /w1 must NOT fire for churn in a DIFFERENT top-level subtree
  // (/w2) — the File System Worker buckets watches by first path segment, so a
  // mutation nobody watches is ~O(1) and never fans out. Then prove the watcher
  // is still alive by writing inside /w1.
  kernel.mkdirp("/w1");
  kernel.mkdirp("/w2");
  kernel.writeFile(
    "/w1/watcher2.js",
    `
const fs = require('fs');
let fired = 0;
fs.watch('/w1', (event, filename) => {
  if (filename === 'ready.txt' || filename === 'count.txt') return; // ignore own markers
  fired++;
  fs.writeFileSync('/w1/count.txt', String(fired));
});
fs.writeFileSync('/w1/ready.txt', '1');
setInterval(() => {}, 1000);
`,
  );
  kernel.start("node", ["/w1/watcher2.js"], { cwd: "/w1" });
  await waitFor(() => kernel.exists("/w1/ready.txt"), "watcher2 process did not start");
  // Churn in a different top-level tree — must be ignored by the /w1 watcher.
  for (let i = 0; i < 5; i++) kernel.writeFile("/w2/junk" + i + ".txt", "x");
  await new Promise((r) => setTimeout(r, 150));
  assert(!kernel.exists("/w1/count.txt"),
    "fs.watch: churn in an unwatched top-level tree does not fire the watcher (bucketed fan-out)");
  // An in-tree write still fires — the watcher wasn't just dead.
  kernel.writeFile("/w1/real.txt", "y");
  await waitFor(() => kernel.exists("/w1/count.txt"),
    "fs.watch did not fire for an in-tree write after cross-tree churn", 100);
  assert(kernel.exists("/w1/count.txt"),
    "fs.watch: an in-tree write still fires after unrelated cross-tree churn");

  // === shipped dep-cache snapshots: import, restore, and reject bad archives ===
  // A first run on a fresh origin is the expensive path users keep dying in, so the
  // app can ship a prebuilt node_modules and RESTORE instead of installing. The
  // archive arrives over the network, which makes validation the interesting part:
  // a truncated download, an HTML error page served with a 200, or a doctored path
  // must each degrade to "no snapshot" — never to a half-unpacked node_modules.
  {
    const encT = new TextEncoder();
    // Build an archive the way a build-time producer would: the same
    // [u32le headerLen][headerJSON][blob] layout dep-cache.js packs.
    const mkArchive = (entries, blobParts) => {
      const blob = blobParts.length
        ? blobParts.reduce((acc, p) => { const m = new Uint8Array(acc.length + p.length); m.set(acc); m.set(p, acc.length); return m; }, new Uint8Array(0))
        : new Uint8Array(0);
      const header = encT.encode(JSON.stringify({ v: 1, entries }));
      const out = new Uint8Array(4 + header.length + blob.length);
      new DataView(out.buffer).setUint32(0, header.length, true);
      out.set(header, 4);
      out.set(blob, 4 + header.length);
      return out;
    };
    const fileA = encT.encode('module.exports = "from a shipped snapshot";\n');
    const fileB = encT.encode('{"name":"shipped-pkg","version":"1.0.0","main":"index.js"}\n');
    const goodEntries = [
      { p: "shipped-pkg", k: "d", m: 0o755 },
      { p: ".bin", k: "d", m: 0o755 },
      { p: "shipped-pkg/index.js", k: "f", m: 0o644, o: 0, l: fileA.length },
      { p: "shipped-pkg/package.json", k: "f", m: 0o644, o: fileA.length, l: fileB.length },
      // Symlinked bins are the fragile part of any pack/restore, and dev servers are
      // launched through one.
      { p: ".bin/shipped", k: "l", m: 0o777, t: "../shipped-pkg/index.js" },
    ];
    const good = mkArchive(goodEntries, [fileA, fileB]);
    // Built NOW, because importing transfers the buffer and detaches our view of it
    // (deliberate — these archives are ~100 MB and a structured clone would double
    // that). A caller must not reuse an array it has handed to depCacheImport.
    const truncated = mkArchive(goodEntries, [fileA, fileB]).slice(0, 24);

    kernel.mkdirp("/shipped-proj");
    kernel.writeFile("/shipped-proj/package.json", '{"name":"p","dependencies":{"shipped-pkg":"1.0.0"}}');
    // Shaped like a real key: hashDepKey produces `<pm>:<src>:<sha256hex>`, and the
    // package.json form is what a fresh project (no lockfile yet) looks up.
    const key = "npm:package.json:" + "de".repeat(32);

    assert(!(await kernel.fs.depCacheHas(key)),
      "a key with no snapshot misses before anything is imported (so a normal install runs)");
    const imported = await kernel.fs.depCacheImport(key, good);
    assert(!!imported && imported.entries === goodEntries.length,
      `a build-time archive imports into the store (${imported ? imported.entries : 0} entries)`);
    assert(await kernel.fs.depCacheHas(key),
      "the imported snapshot is then a HIT — which is what makes the fresh-project lookup skip install");

    const count = await kernel.fs.depCacheRestore(key, "/shipped-proj");
    assert(count === goodEntries.length, `restoring a shipped snapshot recreates every entry (${count})`);
    assert(kernel.readFile("/shipped-proj/node_modules/shipped-pkg/index.js").includes("from a shipped snapshot"),
      "a restored file has its real contents");
    assert(kernel.exists("/shipped-proj/node_modules/.bin/shipped"),
      "a restored .bin symlink exists (dev servers are launched through one)");

    // Every malformed shape must be REJECTED, not partially applied. Each is a real
    // failure mode of shipping a ~100 MB asset over a CDN.
    const bad = {
      "an HTML error page served with a 200": encT.encode("<!DOCTYPE html><html><body>404</body></html>"),
      "an empty response": new Uint8Array(0),
      "a truncated download (header longer than the body)": truncated,
      "a file slice pointing past the end of the blob": mkArchive(
        [{ p: "x", k: "d", m: 0o755 }, { p: "x/y.js", k: "f", m: 0o644, o: 0, l: 1 << 20 }], [fileA]),
      "a path escaping node_modules via ..": mkArchive(
        [{ p: "../../etc/passwd", k: "f", m: 0o644, o: 0, l: fileA.length }], [fileA]),
      "an absolute path": mkArchive(
        [{ p: "/etc/passwd", k: "f", m: 0o644, o: 0, l: fileA.length }], [fileA]),
      "an unknown entry kind": mkArchive([{ p: "weird", k: "?", m: 0o644 }], []),
    };
    let rejected = 0;
    for (const [what, archive] of Object.entries(bad)) {
      const res = await kernel.fs.depCacheImport("npm:package.json:bad" + rejected, archive);
      assert(res === null, `rejected: ${what}`);
      if (res === null) rejected++;
    }
    assert(!kernel.exists("/etc/passwd"),
      "no rejected archive wrote anything outside node_modules");
    assert(rejected === Object.keys(bad).length,
      `every malformed archive was rejected (${rejected}/${Object.keys(bad).length}) — each one falls back to a normal install`);
  }

  // === liveness watchdog: a BUSY but SILENT process must report itself ===
  // This is the case the watchdog exists for and the one it originally could not
  // detect: it keyed on `lastActivity`, which every syscall bumps, so npm's reify
  // phase (~12,000 file writes, no output) reset the timer thousands of times a
  // second while the terminal sat dead. Output silence is what the user experiences,
  // so output silence is what must be measured. The process below writes files in a
  // loop and prints nothing — exactly that shape.
  {
    kernel._stopStallWatchdog(); // adopt the test's interval, not the default 15s
    const savedThreshold = kernel.stallThresholdMs;
    const savedCheck = kernel.stallCheckMs;
    // Generous margins: this runs alongside the rest of the suite, so give the
    // watchdog many chances to tick rather than racing a loaded machine.
    kernel.stallThresholdMs = 300;
    kernel.stallCheckMs = 50;
    // Earlier tests leave long-lived silent processes alive (the fs.watch watchers
    // sit on setInterval and print nothing), and they are legitimately reported too —
    // so scope every assertion to the process under test.
    const stalls = [];
    kernel.onProcStall = (pid, info) => stalls.push({ pid, ...info });
    const forScript = (name) => stalls.filter((s) => (s.args || []).some((a) => String(a).includes(name)));

    kernel.mkdirp("/stall");
    kernel.writeFile(
      "/stall/busy.js",
      `
const fs = require('fs');
// Print ONCE, then go quiet while working — precisely npm's shape: it announces the
// reify phase and then writes ~12,000 files in silence. Anchoring the output here also
// keeps the test independent of how long the runtime takes to boot.
process.stdout.write('starting work\\n');
const end = Date.now() + 4000;
let n = 0;
while (Date.now() < end) fs.writeFileSync('/stall/f' + (n++ % 50) + '.txt', 'x'.repeat(64));
fs.writeFileSync('/stall/done.txt', String(n));
`,
    );
    const busyRun = await kernel.start("node", ["/stall/busy.js"], { cwd: "/stall", capture: true });
    assert(busyRun.code === 0,
      `the busy-but-silent test process ran cleanly (exit ${busyRun.code}${busyRun.code ? ": " + String(busyRun.stderr || "").slice(0, 300) : ""})`);

    const busy = forScript("busy.js");
    assert(busy.length > 0,
      `watchdog reported a busy-but-silent process (${busy.length} report(s))`);
    // Repeat reports back off by doubling, so silence is strictly increasing.
    assert(busy.length < 2 || busy[busy.length - 1].silentMs > busy[0].silentMs,
      "repeat stall reports show the silence growing, on a doubling backoff");
    // The process really was working the whole time it was being reported silent.
    assert(kernel.exists("/stall/done.txt") && Number(kernel.readFile("/stall/done.txt")) > 100,
      `the "silent" process was in fact writing files throughout ` +
      `(${kernel.exists("/stall/done.txt") ? kernel.readFile("/stall/done.txt") : 0} writes)`);
    const last = busy[busy.length - 1];
    // The finding that makes the *message* wording matter: a guest hammering the
    // filesystem registers ZERO kernel syscalls, because fs traffic goes straight to
    // the FS worker over its own SAB. So syscall counts must never be used to
    // conclude "wedged" — progress has to come from the VFS (see onProcStall in
    // kernel-worker.ts, which asks the FS worker for the file count).
    assert(last.syscalls === 0,
      `a filesystem-only workload is invisible to the kernel (${last.syscalls} kernel syscalls) ` +
      "— so 'no syscalls' must NOT be reported as 'stuck'");
    // Observation, not inference: this is the state the user's terminal now describes.
    // Read defensively — a *diagnostic* line must never be able to abort the suite,
    // which it did when a loaded machine left the writer short of finishing.
    const writes = kernel.exists("/stall/done.txt") ? kernel.readFile("/stall/done.txt") : "?";
    console.log(`    ↳ observed: PID ${last.pid} printed nothing for ${last.silentMs}ms while ` +
      `writing ${writes} files — reported, and correctly NOT called dead`);

    // And the inverse: a process that produces output must NOT be reported.
    kernel.writeFile(
      "/stall/chatty.js",
      `let n = 0;
const t = setInterval(() => { process.stdout.write('tick ' + (++n) + '\\n'); if (n > 25) clearInterval(t); }, 60);
`,
    );
    await kernel.start("node", ["/stall/chatty.js"], { cwd: "/stall", capture: true });
    const chatty = forScript("chatty.js");
    assert(chatty.length === 0,
      `a process that keeps printing is never reported as stalled (${chatty.length} reports)`);

    kernel.onProcStall = null;
    kernel.stallThresholdMs = savedThreshold;
    kernel.stallCheckMs = savedCheck;
    kernel._stopStallWatchdog();
  }

  // === an uncaught error in a RUNNING worker is not death ===
  // A browser Worker's `error` event fires for an uncaught exception and the worker
  // keeps servicing its event loop. Finalizing on it killed `astro dev`, which throws
  // ~113 uncaught SyntaxErrors per run and had always survived them.
  {
    kernel.writeFile(
      "/stall/survivor.js",
      `const fs = require('fs');
process.stdout.write('up\\n');
setTimeout(() => { fs.writeFileSync('/stall/survived.txt', 'still here'); }, 400);
`,
    );
    const pid = kernel.launch("node", ["/stall/survivor.js"], { cwd: "/stall", capture: true });
    await waitFor(() => kernel.procs.get(pid)?.booted, "survivor never started", 50);
    // Exactly what the browser delivers mid-run for an uncaught error: no `fatal`
    // flag, because the worker had already posted messages.
    kernel.handleWorkerError(pid, { error: '"[object Object]" is not valid JSON' });
    assert(kernel.procs.has(pid) && !kernel.procs.get(pid).finalized,
      "an uncaught worker error does not kill a running process");
    // Read the counter now: the process is short-lived and its row is gone once it exits.
    assert(kernel.procs.get(pid)?.workerErrors === 1,
      "the uncaught error is still counted for diagnostics");
    await waitFor(() => kernel.exists("/stall/survived.txt"),
      "process did not keep running after an uncaught worker error", 100);
    assert(kernel.exists("/stall/survived.txt"),
      "the process kept running and completed its work after an uncaught worker error");

    // …but a worker that never came up MUST still be finalized, or start() and every
    // other waiter hangs forever. That is the case Fix A was written for, and it is
    // reported by the environment as `fatal` since only it can tell the difference.
    const deadPid = kernel.launch("node", ["/stall/survivor.js"], { cwd: "/stall", capture: true });
    let settled = null;
    kernel.procs.get(deadPid).onExit = (r) => { settled = r; };
    kernel.handleWorkerError(deadPid, { error: "Failed to fetch dynamically imported module", fatal: true });
    assert(!kernel.procs.has(deadPid), "a worker that failed to BOOT is still finalized");
    assert(settled && settled.code === 1, "a boot failure settles its waiters with a non-zero exit");
  }

  // === diagnostics(): enough to tell slow from wedged without the machine ===
  // NOTE what is deliberately NOT asserted: a rising `syscalls`. Almost nothing a
  // plain script does is a kernel syscall — fs goes to the FS worker, stdout is a
  // plain message — so `syscalls` is only meaningful for network/spawn-heavy work.
  // The field the user's paste-back actually turns on is `sinceOutputMs`.
  {
    const pid = kernel.launch("node", ["/stall/busy.js"], { cwd: "/stall", capture: true });
    await waitFor(() => kernel.procs.get(pid)?.booted, "busy proc never ran", 50);
    const row = kernel.diagnostics().procs.find((p) => p.pid === pid);
    assert(!!row && row.command.includes("busy.js"),
      "diagnostics() lists a live process with its full command line");
    assert(!!row && row.sinceOutputMs >= 0 && row.sinceSyscallMs >= 0 && row.booted === true,
      "diagnostics() reports both silence clocks and whether the worker came up");
    await new Promise((r) => setTimeout(r, 300));
    const row2 = kernel.diagnostics().procs.find((p) => p.pid === pid);
    assert(!!row2 && row2.sinceOutputMs > row.sinceOutputMs,
      "output silence grows across two diagnostics() calls — the signal a stuck-looking install is judged on");
    const d = kernel.diagnostics();
    assert(!!d.fetch && typeof d.fetch.inflight === "number" && Array.isArray(d.listeners),
      "diagnostics() also reports fetch state and bound ports, to tell a stuck download from a stuck write");
  }

  // === fetched-body lifetime: eviction must never outrun a reader ===
  // The kernel hands a process a PATH and the process reads the bytes back in a
  // later turn. Eviction runs in between, on other downloads. Before bodies were
  // reference counted it would unlink a body its reader had not read yet, and
  // https.js turns the resulting ENOENT into an empty 200 — a silent truncation,
  // not an error. cap=0 forces eviction on every single fetch, so the window that
  // is normally timing-dependent is hit deterministically here.
  {
    const savedCap = kernel.fetchCacheMaxBytes;
    kernel.fetchCacheMaxBytes = 0;
    const fetchBody = (url) => kernel._fetchIntoVfs(1, { url });

    // A is handed out and NOT read yet; B..D evict it from the accounting.
    const a = await fetchBody("https://registry.npmjs.org/lifetime-a");
    for (const u of ["lifetime-b", "lifetime-c", "lifetime-d"]) {
      await fetchBody("https://registry.npmjs.org/" + u);
    }
    assert(kernel.exists(a.path),
      "fetch body survives eviction while its reader still holds it (the silent-truncation race)");

    // Reading it is what frees it: FsServer reports the completed read through the
    // kernel-fs channel, which drops the last reference and reaps the file. This
    // also proves the whole release path is wired, not just the bookkeeping.
    const bytes = kernel.readFileBytes(a.path);
    assert(bytes && bytes.length > 0, "fetch body still had its contents when finally read");
    await waitFor(() => !kernel.exists(a.path),
      "fetch body was not reclaimed after its reader finished", 100);
    assert(!kernel.exists(a.path), "fetch body is reclaimed once its last reader is done");

    // Two readers of one body (what in-flight de-dupe produces): the FIRST read
    // must not pull the file out from under the second.
    const e = await fetchBody("https://registry.npmjs.org/lifetime-e");
    kernel._pinFetchBody(e.path, 1); // simulate a second sharer of the same body
    await fetchBody("https://registry.npmjs.org/lifetime-f"); // evict e
    kernel.releaseFetchBody(e.path);
    assert(kernel.exists(e.path), "a shared fetch body survives the first of its two readers");
    kernel.releaseFetchBody(e.path);
    assert(!kernel.exists(e.path), "a shared fetch body is reclaimed after the last of its readers");

    // Each fetch gets a distinct body path, so a re-fetch after eviction can never
    // be deleted by a stale pending unlink from the previous generation. (The
    // intervening fetch is what evicts i1 — otherwise the re-fetch is a cache hit
    // and legitimately returns the same path.)
    const i1 = await fetchBody("https://registry.npmjs.org/lifetime-i");
    kernel.releaseFetchBody(i1.path);
    await fetchBody("https://registry.npmjs.org/lifetime-j");
    const i2 = await fetchBody("https://registry.npmjs.org/lifetime-i");
    assert(i1.path !== i2.path, "a re-fetched body gets a fresh path, not the evicted one");

    // Backstop: a process handed a body that dies without ever reading it must not
    // pin that body for the rest of the session.
    const g = await fetchBody("https://registry.npmjs.org/lifetime-g");
    await fetchBody("https://registry.npmjs.org/lifetime-h"); // evict g while pinned
    assert(kernel.exists(g.path), "a body handed to a live process is not reclaimed early");
    kernel._releaseFetchBodiesForPid(1);
    assert(!kernel.exists(g.path), "a dead process's unread fetch bodies are reclaimed");

    kernel.fetchCacheMaxBytes = savedCap;
  }

  // === process table actually allocated many PIDs ===
  assert(kernel.nextPid - 1 >= 10, `PID table grew (${kernel.nextPid - 1} processes spawned)`);

  console.log(failed ? "\nRESULT: FAIL" : "\nRESULT: PASS");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});