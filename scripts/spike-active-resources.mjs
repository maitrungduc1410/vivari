// Spike (OFFLINE): process.getActiveResourcesInfo() names what keeps the loop
// alive, as Node does, and a CLI that calls it on its way out still gets out.
//
// WHY THIS EXISTS. The function did not exist, and Nuxt's CLI calls it when a dev
// server overruns its 15 s shutdown budget, to say what is still open before it
// "exits anyway". The TypeError went to Nuxt's uncaughtException reporter instead,
// the process.exit() after it never ran, and `nuxt dev`'s `q` sat at "Cleaning
// up..." for as long as the close hooks took, or forever. The last check below is
// that shutdown, reduced: a SIGINT whose close never settles and a deadline that
// reports and exits.
//
// The expected lists are what Node 26 prints for the same scripts, with two
// differences: Node also lists requests (a socket's pending ConnectWrap), and a
// timer whose callback is running ("Timeout" in the deadline below).
//
//   run:  node scripts/spike-active-resources.mjs

import { bootSpikeKernel } from "./lib/spike-harness.mjs";

let failed = 0;
const ok = (cond, msg, got) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg + (got !== undefined ? `  (${JSON.stringify(got)})` : ""));
  if (!cond) failed++;
};

const h = await bootSpikeKernel();
const k = h.kernel;
k.mkdirp("/t");
const PRINT = "console.log('VV' + JSON.stringify(process.getActiveResourcesInfo()))";
const run = async (file, source) => {
  k.writeFile(file, source);
  const r = await Promise.race([
    k.start("node", [file], { cwd: "/t", env: { PATH: "/bin" }, capture: true }),
    new Promise((resolve) => setTimeout(() => resolve({ code: "timeout", stdout: "" }), 15000)),
  ]);
  const lines = (r.stdout || "").split("\n").filter((l) => l.startsWith("VV"));
  return { code: r.code, stdout: r.stdout || "", stderr: r.stderr || "", lists: lines.map((l) => JSON.parse(l.slice(2))) };
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("== handles and timers ==");
let r = await run("/t/bare.js", PRINT);
ok(same(r.lists[0], []), "a script holding nothing: []", r.lists[0] ?? r.stderr.slice(0, 300));
r = await run(
  "/t/timers.js",
  `setTimeout(() => {}, 50);
setTimeout(() => {}, 50).unref();
clearImmediate(setImmediate(() => {}));
setImmediate(() => {});
${PRINT}`,
);
ok(same(r.lists[0], ["Timeout", "Immediate"]), "a ref'd timer and a pending immediate; unref'd and cleared ones are left out", r.lists[0]);
r = await run(
  "/t/server.js",
  `const s = require('net').createServer().listen(0, () => { ${PRINT}; s.close(); });`,
);
ok(same(r.lists[0], ["TCPServerWrap"]), "a listening server", r.lists[0]);
r = await run(
  "/t/sockets.js",
  `const net = require('net');
const s = net.createServer((c) => { ${PRINT}; c.destroy(); s.close(); }).listen(0, () => net.connect(s.address().port).on('error', () => {}));`,
);
ok(same([...(r.lists[0] || [])].sort(), ["TCPServerWrap", "TCPSocketWrap", "TCPSocketWrap"]), "a server and both ends of a connection to it", r.lists[0]);

console.log("== fork ==");
k.writeFile(
  "/t/child.js",
  `process.on('message', (m) => { if (m === 'info') process.send(process.getActiveResourcesInfo()); else process.exit(0); });`,
);
r = await run(
  "/t/parent.js",
  `const c = require('child_process').fork('/t/child.js');
c.on('message', (m) => { console.log('VV' + JSON.stringify(m)); ${PRINT}; c.send('bye'); });
c.send('info');`,
);
ok(same(r.lists[0], ["PipeWrap"]), "the forked child: its IPC channel", r.lists[0]);
ok(r.lists[1]?.includes("ProcessWrap") && r.lists[1]?.includes("PipeWrap"), "the parent: the child process and its channel", r.lists[1]);

console.log("== a shutdown that overruns its deadline ==");
r = await run(
  "/t/shutdown.js",
  `require('net').createServer().listen(0);
process.on('uncaughtException', (e) => console.log('[uncaughtException] ' + e.message));
process.on('SIGINT', () => {
  setTimeout(() => {
    console.log('did not shut down: ' + process.getActiveResourcesInfo().join(','));
    process.exit(3);
  }, 300);
  new Promise(() => {}); // a close hook that never settles
});
setTimeout(() => process.emit('SIGINT'), 50);`,
);
ok(r.code === 3, "exits from the deadline, with its code", r.code);
ok(r.stdout.includes("did not shut down: TCPServerWrap\n"), "and says what was still open", r.stdout.trim().slice(0, 200));
ok(!r.stdout.includes("[uncaughtException]"), "with no uncaught exception on the way", r.stdout.trim().slice(0, 200));

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
