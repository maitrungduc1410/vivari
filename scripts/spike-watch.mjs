// Spike: --watch actually restarts.
//
// `node --watch server.js` used to run the server ONCE and exit 0. Nothing said the
// flag had been ignored, so the only evidence was that nothing ever restarted — the
// exact failure this project keeps finding and hating, a program reporting success for
// work it did not do. `bun --watch` was worse: the flag was read as a filename.
//
// So the assertions are about the behaviour, not the flag being accepted: a rerun
// happens, the banners are node's own text byte for byte, a burst of writes is ONE
// restart rather than several, an install into node_modules is not a restart at all,
// and killing the supervisor does not leave the child running with nobody reading it.
//
//   run:  node scripts/spike-watch.mjs

import { bootSpikeKernel } from "./lib/spike-harness.mjs";

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const h = await bootSpikeKernel();
const { kernel } = h;
const APP = "/app";
kernel.mkdirp(APP);
kernel.mkdirp("/home/user");
const ENV = { PATH: "/bin", HOME: "/home/user", PWD: APP };

// A supervisor never exits on its own, so every case here launches one, reads the
// transcript in windows, and stops it at the end. `since` is the read: it returns only
// what arrived after the mark, which keeps a rerun's output from being confused with
// the run before it — the same discipline as answerTo() in the repl spikes.
const mark = () => h.out.length;
const since = (m) => h.out.slice(m).join("");

// The body gets `from`, the mark taken just before ITS launch, so `since(from)` is
// this case's transcript and nothing earlier. Reading from 0 instead would let a case
// pass on evidence produced by the case before it — the assertion-matches-the-wrong-
// text trap this branch has already been caught by three times.
async function watching(argv, body) {
  const from = mark();
  const pid = kernel.launch(argv[0], argv.slice(1), { cwd: APP, env: ENV });
  if (pid < 0) throw new Error("could not launch " + argv.join(" "));
  try {
    await body(from, pid);
  } finally {
    kernel.stop(pid);
    await sleep(400);
  }
}

console.log("\n1) node --watch: it runs, it says so in node's words, and it reruns");
{
  kernel.writeFile(APP + "/app.js", "console.log('RUN-1');\n");
  await watching(["node", "--watch", "app.js"], async (from) => {
    await sleep(2500);
    const first = since(from);
    ok(/RUN-1/.test(first), "the program runs once up front: " + JSON.stringify(first.trim().slice(0, 30)));
    // Captured from `node --watch` on the host, including the second sentence — it is
    // what tells a reader the process is still alive on purpose rather than hung.
    ok(
      /Completed running 'app\.js'\. Waiting for file changes before restarting\.\.\./.test(first),
      "…and node's own completion line, in full: " + JSON.stringify((/Completed.*/.exec(first) || [""])[0]),
    );

    const m = mark();
    kernel.writeFile(APP + "/app.js", "console.log('RUN-2');\n");
    await sleep(3500);
    const second = since(m);
    ok(/Restarting 'app\.js'/.test(second), "an edit restarts it: " + JSON.stringify((/Restarting.*/.exec(second) || [""])[0]));
    ok(/RUN-2/.test(second), "…and the NEW source is what runs: " + JSON.stringify(second.trim().slice(0, 40)));
    ok(!/RUN-1/.test(second), "…not the old one");
  });
}

console.log("\n2) a program that fails is reported as failed, and still watched");
{
  kernel.writeFile(APP + "/bad.js", "process.exit(1);\n");
  await watching(["node", "--watch", "bad.js"], async (from) => {
    await sleep(2500);
    ok(/Failed running 'bad\.js'/.test(since(from)), "the verb is 'Failed', as node has it: " + JSON.stringify((/Failed.*/.exec(since(from)) || [""])[0]));

    const m = mark();
    kernel.writeFile(APP + "/bad.js", "console.log('FIXED');\n");
    await sleep(3500);
    // The point of a watcher: a failing run must not end the session, or you have to
    // restart it by hand every time you make a mistake.
    ok(/FIXED/.test(since(m)), "…and it keeps watching after a failure: " + JSON.stringify(since(m).trim().slice(0, 40)));
  });
}

console.log("\n3) one save is one restart, and an install is none");
{
  kernel.writeFile(APP + "/burst.js", "console.log('B');\n");
  await watching(["node", "--watch", "burst.js"], async (from) => {
    await sleep(2500);
    const m = mark();
    // A save is several fs events (write, truncate, an editor's rename-over) and a
    // build tool touching a directory is dozens. Without a debounce the program is
    // killed mid-boot by the next event and never reaches a running state at all.
    for (let i = 0; i < 6; i++) {
      kernel.writeFile(APP + "/burst.js", "console.log('B" + i + "');\n");
      await sleep(15);
    }
    await sleep(3500);
    const restarts = (since(m).match(/Restarting/g) || []).length;
    ok(restarts === 1, "six writes 15ms apart are ONE restart, not six: " + restarts);

    // node_modules cannot be excluded from a recursive watch, so it is excluded on
    // the change side. An install writes thousands of files; reacting to each one
    // would restart the program thousands of times.
    const m2 = mark();
    kernel.mkdirp(APP + "/node_modules/left-pad");
    kernel.writeFile(APP + "/node_modules/left-pad/index.js", "module.exports = 1;\n");
    kernel.writeFile(APP + "/node_modules/left-pad/package.json", '{"name":"left-pad"}\n');
    await sleep(2500);
    ok(!/Restarting/.test(since(m2)), "…and writing into node_modules is not a restart at all: " + JSON.stringify(since(m2).trim().slice(0, 40)));

    // POSITIVE CONTROL for the assertion above. On its own it is purely negative, so a
    // watcher that had died outright — an fs.watch that threw at startup, say — would
    // satisfy it. Proving the watcher is still awake in the same window is what makes
    // the silence mean "ignored" rather than "deaf".
    const m3 = mark();
    kernel.writeFile(APP + "/burst.js", "console.log('AWAKE');\n");
    await sleep(3500);
    ok(/Restarting/.test(since(m3)) && /AWAKE/.test(since(m3)), "…while a real source edit still does: " + JSON.stringify(since(m3).trim().slice(0, 40)));
  });
}

console.log("\n3b) a program that writes into the tree it is watched in must not thrash");
{
  // Watching directories rather than the set of files the program loaded means the
  // program's own output is inside the watched tree. Measured before the fix: 17 runs
  // and 16 restarts in six seconds, not converging — and each restart is a fresh Web
  // Worker in a browser tab, so this is unbounded spawning, not just noise. A codegen
  // script, a log, a build writing dist/ all hit it, and `node --watch build.js` is how
  // people use the flag.
  kernel.writeFile(APP + "/emit.js", "require('fs').writeFileSync('" + APP + "/out.txt', 'run at ' + Date.now());\nconsole.log('EMIT');\n");
  await watching(["node", "--watch", "emit.js"], async (from) => {
    await sleep(6000);
    const runs = (since(from).match(/EMIT/g) || []).length;
    ok(runs === 1, "a script writing out.txt runs ONCE, not once per write: " + runs);
  });

  // Extension filtering cannot save this one: dist/bundle.js IS a source extension.
  // Build-output directories are ignored for exactly this case.
  kernel.writeFile(
    APP + "/gen.js",
    "const fs=require('fs');fs.mkdirSync('" + APP + "/dist',{recursive:true});\nfs.writeFileSync('" + APP + "/dist/bundle.js','//'+Date.now());\nconsole.log('GEN');\n",
  );
  await watching(["node", "--watch", "gen.js"], async (from) => {
    await sleep(6000);
    const runs = (since(from).match(/GEN/g) || []).length;
    ok(runs === 1, "…and a build writing dist/bundle.js does too: " + runs);
  });

  // The case NEITHER filter catches: a .js sibling in the app root. The filters are
  // heuristics about names and a program can always write something they let through,
  // so the loop breaker is the only part that actually guarantees convergence. It must
  // also SAY why, or a watcher that stopped looks identical to one that is broken.
  kernel.writeFile(
    APP + "/gen2.js",
    "require('fs').writeFileSync('" + APP + "/generated.js','//'+Date.now());\nconsole.log('G2');\n",
  );
  await watching(["node", "--watch", "gen2.js"], async (from) => {
    await sleep(20000);
    const runs = (since(from).match(/G2/g) || []).length;
    // Unthrottled this was 17 runs in six seconds. The backoff doubles from the fifth
    // consecutive restart, so twenty seconds buys about nine — the point being that the
    // rate DECAYS, not that the loop ends. It cannot end: the program writes again on
    // every run, whatever we do about the interval.
    ok(runs > 1 && runs < 15, "a .js written into the source root loops, but at a decaying rate: " + runs + " runs in 20s");
    ok((since(from).match(/spaced out/g) || []).length === 1, "…and it is said once, without accusing the program of anything: " + JSON.stringify((/watch: [^\n]*/.exec(since(from)) || [""])[0].slice(0, 80)));
    // Backing off must not mean giving up: an edit still has to be picked up.
    const after = mark();
    kernel.writeFile(APP + "/gen2.js", "console.log('G2-EDITED');\n");
    await sleep(20000);
    ok(/G2-EDITED/.test(since(after)), "…and the watch is still live afterwards, not switched off: " + JSON.stringify(since(after).trim().slice(-30)));
  });
}

console.log("\n3b-2) a healthy program is not mistaken for a loop");
{
  // The backoff replaced a loop BREAKER that stopped watching outright, and that killed
  // sessions which had done nothing wrong: six saves 600ms apart to a program that wrote
  // nothing at all switched the watch off and told the user the program had written into
  // its own tree. Nothing here knows who wrote a file, so a wrong guess must stay cheap.
  kernel.writeFile(APP + "/quick.js", "console.log('Q');\n");
  const from = mark();
  const pid = kernel.launch("node", ["--watch", "quick.js"], { cwd: APP, env: ENV });
  await sleep(2500);
  for (let i = 0; i < 6; i++) {
    kernel.writeFile(APP + "/quick.js", "console.log('Q" + i + "');\n");
    await sleep(600);
  }
  await sleep(3000);
  const runs = (since(from).match(/^Q\d/gm) || []).length;
  ok(runs >= 5, "six quick saves get their six runs: " + runs);
  ok(!/spaced out/.test(since(from)), "…and nothing is throttled or accused");
  kernel.stop(pid);
  await sleep(400);
}

console.log("\n3c) a server that handles SIGTERM restarts without losing its port");
{
  // The restart used to respawn after a flat 30ms, which is enough only for a program
  // the kernel can finalize synchronously. Graceful shutdown is how servers are
  // normally written, and for those the new child raced the old one for the port and
  // lost EVERY time — so --watch failed completely for the class of program people
  // watch most. EADDRINUSE here is the whole point of the case.
  const SRV = [
    "const http = require('http');",
    "const s = http.createServer((q, r) => r.end('ok'));",
    "s.listen(4321, () => console.log('LISTENING'));",
    "process.on('SIGTERM', () => { setTimeout(() => { s.close(); process.exit(0); }, 800); });",
  ].join("\n");
  kernel.writeFile(APP + "/srv.js", SRV + "\n");
  await watching(["node", "--watch", "srv.js"], async (from) => {
    await sleep(2600);
    ok(/LISTENING/.test(since(from)), "the server takes the port: " + JSON.stringify(since(from).trim().slice(0, 30)));
    const m = mark();
    kernel.writeFile(APP + "/srv.js", SRV.replace("'ok'", "'ok2'") + "\n");
    await sleep(6000);
    ok(/LISTENING/.test(since(m)), "…and after an edit it takes the port AGAIN: " + JSON.stringify(since(m).trim().slice(0, 50)));
    ok(!/EADDRINUSE/.test(since(m)), "…because the old child was dead first, not merely asked to die");

    // TWICE, inside the kill window. Waiting for the old child's 'exit' is only half the
    // fix: killChild hands ownership of the dying child over and clears `child`, so a
    // second save arriving during the wait found nothing to kill, ran its callback at
    // once, and spawned a replacement while the old child was still alive. One logical
    // restart became two spawns, and EADDRINUSE came straight back. Saving twice inside a
    // couple of seconds is ordinary — save, look, save again.
    const m2 = mark();
    kernel.writeFile(APP + "/srv.js", SRV.replace("'ok'", "'ok3'") + "\n");
    await sleep(400);
    kernel.writeFile(APP + "/srv.js", SRV.replace("'ok'", "'ok4'") + "\n");
    await sleep(8000);
    ok(!/EADDRINUSE/.test(since(m2)), "two saves inside the kill window still yield no EADDRINUSE");
    ok((since(m2).match(/LISTENING/g) || []).length === 1, "…and exactly one server ends up holding the port: " + JSON.stringify(since(m2).trim().slice(0, 60)));
  });
}

console.log("\n3c-2) two saves in the kill window leave one child, not two");
{
  // Same re-entrancy, seen on a program that holds no port: the second spawn does not
  // fail, it just runs alongside the first, doubling every side effect the program has.
  // The abandoned child is not even announced, since its exit handler sees it is no
  // longer the current one.
  const TICK = "console.log('TICK');\nsetInterval(() => {}, 1000);\nprocess.on('SIGTERM', () => setTimeout(() => process.exit(0), 1200));\n";
  kernel.writeFile(APP + "/tick.js", TICK);
  const from = mark();
  const pid = kernel.launch("node", ["--watch", "tick.js"], { cwd: APP, env: ENV });
  await sleep(2600);
  const withOneChild = kernel.procs.size;
  kernel.writeFile(APP + "/tick.js", TICK + "// a\n");
  await sleep(400);
  kernel.writeFile(APP + "/tick.js", TICK + "// b\n");
  await sleep(9000);
  ok(kernel.procs.size === withOneChild, "still one supervisor and one child, not two children: " + kernel.procs.size + " (was " + withOneChild + ")");
  ok(/TICK/.test(since(from)), "…and the one that is left is running");
  kernel.stop(pid);
  await sleep(400);
}

console.log("\n3d) a watched program can be typed at");
{
  // 'inherit' on the child's stdin only declares that it HAS a terminal; it does not
  // connect a data path. Terminal input goes to the shell's foreground job, which is
  // the SUPERVISOR — so the child claimed a terminal and then never saw a keystroke,
  // which is the same false claim the pipe-on-fd-0 fix removed one layer up.
  kernel.writeFile(
    APP + "/echoin.js",
    "console.log('READY');\nprocess.stdin.on('data', (d) => console.log('CHILD-SAW[' + String(d).trim() + ']'));\nprocess.stdin.resume();\n",
  );
  const from = mark();
  const pid = kernel.launch("node", ["--watch", "echoin.js"], { cwd: APP, env: ENV });
  await sleep(2500);
  kernel.sendStdin(pid, "typed-at-the-supervisor\n");
  await sleep(1500);
  ok(
    /CHILD-SAW\[typed-at-the-supervisor\]/.test(since(from)),
    "the supervisor relays what is typed to the child: " + JSON.stringify(since(from).trim().slice(0, 60)),
  );
  kernel.stop(pid);
  await sleep(400);
}

console.log("\n4) --watch-path watches somewhere else");
{
  kernel.mkdirp(APP + "/src");
  kernel.writeFile(APP + "/src/data.txt", "one\n");
  kernel.writeFile(APP + "/reader.js", "console.log('READ:' + require('fs').readFileSync('src/data.txt', 'utf8').trim());\n");
  await watching(["node", "--watch-path", "./src", "reader.js"], async (from) => {
    await sleep(2500);
    ok(/READ:one/.test(since(from)), "it runs: " + JSON.stringify(since(from).trim().slice(0, 30)));
    const m = mark();
    kernel.writeFile(APP + "/src/data.txt", "two\n");
    await sleep(3500);
    ok(/READ:two/.test(since(m)), "…and a change under the watched path restarts it: " + JSON.stringify(since(m).trim().slice(0, 40)));
  });
}

console.log("\n5) killing the supervisor takes the child with it");
{
  // A long-lived child (a server, which is what people watch) outlives its parent
  // unless the parent kills it. An orphan here is invisible and permanent: nothing
  // reads its output and nothing can signal it, but it still holds its port.
  kernel.writeFile(APP + "/live.js", "setInterval(() => {}, 1000); console.log('LIVE');\n");
  const before = kernel.procs.size;
  const pid = kernel.launch("node", ["--watch", "live.js"], { cwd: APP, env: ENV });
  await sleep(2500);
  ok(kernel.procs.size > before, "a supervisor and a child are both running: " + before + " -> " + kernel.procs.size);
  kernel.stop(pid);
  await sleep(1500);
  ok(kernel.procs.size === before, "…and stopping the supervisor leaves no orphan: " + kernel.procs.size + " (was " + before + " before it started)");
}

console.log("\n6) bun --watch, --hot, and bun run --watch");
{
  kernel.writeFile(APP + "/index.ts", "const n: number = 1; console.log('TS-' + n);\n");
  kernel.writeFile(APP + "/package.json", JSON.stringify({ name: "w", scripts: { dev: "bun index.ts" } }) + "\n");

  await watching(["bun", "--watch", "index.ts"], async (from) => {
    await sleep(2600);
    // TypeScript, because bun has no JS-only mode: a watched file is transpiled on
    // every rerun, not just the first.
    ok(/TS-1/.test(since(from)), "it runs the TypeScript: " + JSON.stringify(since(from).trim().slice(0, 30)));
    const m = mark();
    kernel.writeFile(APP + "/index.ts", "const n: number = 2; console.log('TS-' + n);\n");
    await sleep(3500);
    ok(/TS-2/.test(since(m)), "…and reruns it on a change: " + JSON.stringify(since(m).trim().slice(0, 30)));
    // Bun prints no banner around a rerun, so neither do we — copying node's lines
    // here would describe bun wrongly.
    ok(!/Restarting|Completed running/.test(since(m)), "…without node's banners, which are node's");
  });

  kernel.writeFile(APP + "/index.ts", "const n: number = 1; console.log('TS-' + n);\n");
  await sleep(300);
  await watching(["bun", "--hot", "index.ts"], async (from) => {
    await sleep(2600);
    // The one honest compromise in this change. Real --hot swaps the module graph
    // inside the live process, so globals and open sockets survive; this restarts.
    // Saying so once is the difference between a documented limit and a program
    // silently losing the state its author expected to keep.
    ok(
      /--hot runs as --watch/.test(since(from)) && /RESTARTED, not soft-reloaded/.test(since(from)),
      "--hot says plainly that it restarts instead: " + JSON.stringify((/note:.*/.exec(since(from)) || [""])[0].slice(0, 80)),
    );
    const m = mark();
    kernel.writeFile(APP + "/index.ts", "const n: number = 3; console.log('TS-' + n);\n");
    await sleep(3500);
    ok(/TS-3/.test(since(m)), "…and still reruns on a change: " + JSON.stringify(since(m).trim().slice(0, 30)));
  });

  kernel.writeFile(APP + "/index.ts", "const n: number = 1; console.log('TS-' + n);\n");
  await sleep(300);
  await watching(["bun", "run", "--watch", "dev"], async (from) => {
    await sleep(2600);
    ok(/TS-1/.test(since(from)), "bun run --watch <script> runs the script: " + JSON.stringify(since(from).trim().slice(0, 30)));
    const m = mark();
    kernel.writeFile(APP + "/index.ts", "const n: number = 4; console.log('TS-' + n);\n");
    await sleep(3500);
    ok(/TS-4/.test(since(m)), "…and reruns it: " + JSON.stringify(since(m).trim().slice(0, 30)));
  });
}

console.log(failed === 0 ? "\nOK: --watch restarts" : `\nFAIL: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
