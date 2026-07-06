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
    return { terminate: () => worker.terminate() };
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

  // === process table actually allocated many PIDs ===
  assert(kernel.nextPid - 1 >= 10, `PID table grew (${kernel.nextPid - 1} processes spawned)`);

  console.log(failed ? "\nRESULT: FAIL" : "\nRESULT: PASS");
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
