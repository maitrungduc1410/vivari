// Fatal-error spike — proves a guest that fails REPORTS that it failed, and that
// a guest cannot take the kernel down with it.
//
// Two defects, found by measuring rather than reading, both of which had been
// present for as long as the runtime had an event loop:
//
//   1. An uncaught error in a callback printed its stack and the process exited
//      ZERO. `setTimeout(() => { throw new Error("boom") })` was a success as far
//      as any caller could tell, so a test script, a build step or a CI command
//      that died in a callback reported that it had passed. A wrong exit code is
//      worse than a silent one: the shell believes it. `process.on(
//      'uncaughtException')` never fired for anything either, because nothing
//      emitted it.
//
//   2. An unhandled promise rejection did something worse than exit 0 — it HUNG.
//      The rejection escaped to the host realm, whose handler rethrew it, and
//      the guest then sat there while the kernel waited for an exit that was
//      never coming.
//
//   3. `Bun.spawn()` with no arguments took down the KERNEL. The command reached
//      resolveProgram as `undefined`, .includes() threw inside the kernel, and in
//      a browser that is the whole VM: every process, the VFS session and the
//      preview, lost to one typo in a guest script.
//
// The assertions below are about EXIT CODES and about what stays alive, because
// that is what was wrong. Checking only that a stack reaches stderr would have
// passed against every one of these bugs — the stacks were always there.
//
// Both `bun` and `node` guests are covered: the loop is shared, so a fix that
// only reached one of them would be a coincidence rather than a fix.

import { bootSpikeKernel } from "./lib/spike-harness.mjs";

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  \u2713 " : "  \u2717 ") + msg);
  if (!cond) failed++;
};

const { kernel } = await bootSpikeKernel();
const APP = "/app";
kernel.mkdirp(APP);
const ENV = { HOME: "/home/user", PATH: "/bin", PWD: APP };

// A hang is a real possible outcome here (it was the bug), so every run is
// bounded and a timeout is reported as a failure rather than killing the spike.
const HANG_MS = 20000;
async function run(runner, source, ext = "ts") {
  const file = "case." + ext;
  kernel.writeFile(APP + "/" + file, source);
  const args = runner === "bun" ? ["run", file] : [file];
  let timer;
  const hang = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ hung: true, code: null, stdout: "", stderr: "" }), HANG_MS);
  });
  const result = await Promise.race([
    kernel.start(runner, args, { cwd: APP, env: ENV, capture: true }).then((r) => ({
      hung: false,
      code: r.code,
      stdout: r.stdout || "",
      stderr: r.stderr || "",
    })),
    hang,
  ]);
  clearTimeout(timer);
  return result;
}

console.log("== an uncaught error makes the process FAIL ==");
{
  const r = await run("bun", "setTimeout(() => { throw new Error('boom'); }, 5);\n");
  ok(!r.hung && r.code === 1, "a throw from a timer exits 1 (it exited 0 before, reporting success)");
  ok(/boom/.test(r.stderr), "…and the stack still reaches stderr");

  // The other half of Node's contract, and the reason this cannot simply exit on
  // every error: a server logs and stays up.
  const handled = await run(
    "bun",
    [
      "process.on('uncaughtException', (e) => console.log('HANDLED:' + e.message));",
      "setTimeout(() => { throw new Error('boom'); }, 5);",
      "setTimeout(() => console.log('STILL RUNNING'), 40);",
    ].join("\n") + "\n"
  );
  ok(!handled.hung && handled.code === 0, "with an uncaughtException handler the process survives and exits 0");
  ok(/HANDLED:boom/.test(handled.stdout), "…the handler receives the error");
  ok(/STILL RUNNING/.test(handled.stdout), "…and the loop keeps going afterwards");

  // Exiting means EXITING: work queued after the failure must not run, or the
  // process would carry on in a state its author never planned for.
  const stops = await run(
    "bun",
    "setTimeout(() => { throw new Error('boom'); }, 5);\nsetTimeout(() => console.log('SHOULD NOT PRINT'), 200);\n"
  );
  ok(!stops.hung && stops.code === 1 && !/SHOULD NOT PRINT/.test(stops.stdout), "an unhandled error stops the loop rather than limping on");

  // The exit sentinel travels the same path, so this is the check that the fix
  // did not turn every process.exit() into a failure.
  const exits = await run("bun", "setTimeout(() => process.exit(3), 5);\n");
  ok(!exits.hung && exits.code === 3, "process.exit(3) from a timer still exits 3, not 1");

  const clean = await run("bun", "console.log('fine');\n");
  ok(!clean.hung && clean.code === 0, "a script that does nothing wrong still exits 0");
}

console.log("\n== an unhandled rejection fails instead of hanging ==");
{
  const r = await run("bun", "Promise.reject(new Error('nope'));\n");
  ok(!r.hung, "the process EXITS at all — this hung for ever before");
  ok(r.code === 1, "…with code 1, as Node's default unhandled-rejections mode gives");
  ok(/nope/.test(r.stderr), "…and the reason is reported");

  const hooked = await run(
    "bun",
    [
      "process.on('unhandledRejection', (reason) => console.log('HANDLED:' + reason.message));",
      "Promise.reject(new Error('nope'));",
      "setTimeout(() => console.log('STILL RUNNING'), 40);",
    ].join("\n") + "\n"
  );
  ok(!hooked.hung && hooked.code === 0 && /HANDLED:nope/.test(hooked.stdout), "an unhandledRejection hook suppresses the default and keeps the process alive");

  // Node falls a rejection through to uncaughtException when no rejection hook is
  // set, and hands it `origin: 'unhandledRejection'` so a handler can tell the two
  // apart. Pinning the origin, not just the delivery: a shim that reported every
  // error as 'uncaughtException' would pass a weaker check.
  const fell = await run(
    "bun",
    [
      "process.on('uncaughtException', (e, origin) => console.log('ORIGIN:' + origin + ':' + e.message));",
      "Promise.reject(new Error('nope'));",
    ].join("\n") + "\n"
  );
  ok(!fell.hung && /ORIGIN:unhandledRejection:nope/.test(fell.stdout), "with no rejection hook it arrives at uncaughtException, tagged with its origin");

  const rejectedEntry = await run("bun", "await Promise.reject(new Error('tla'));\n");
  ok(!rejectedEntry.hung && rejectedEntry.code === 1, "a top-level await that rejects exits 1");
}

console.log("\n== a handler that throws is fatal, and says why twice ==");
{
  const r = await run(
    "bun",
    [
      "process.on('uncaughtException', () => { throw new Error('handler broke'); });",
      "setTimeout(() => { throw new Error('boom'); }, 5);",
    ].join("\n") + "\n"
  );
  ok(!r.hung && r.code === 1, "a throwing uncaughtException handler still fails the process");
  // Both errors matter: the first says what went wrong, the second says why the
  // handler did not save you. Reporting only one sends you to the wrong file.
  ok(/boom/.test(r.stderr) && /handler broke/.test(r.stderr), "…and both the original error and the handler's are reported");
}

console.log("\n== the same rules for a node guest, not just bun ==");
{
  const thrown = await run("node", "setTimeout(() => { throw new Error('boom'); }, 5);\n", "js");
  ok(!thrown.hung && thrown.code === 1, "node: a throw from a timer exits 1");
  const rejected = await run("node", "Promise.reject(new Error('nope'));\n", "js");
  ok(!rejected.hung && rejected.code === 1, "node: an unhandled rejection exits 1 rather than hanging");
  const handled = await run(
    "node",
    "process.on('uncaughtException', (e) => console.log('HANDLED:' + e.message));\nsetTimeout(() => { throw new Error('boom'); }, 5);\n",
    "js"
  );
  ok(!handled.hung && handled.code === 0 && /HANDLED:boom/.test(handled.stdout), "node: a handler suppresses the default here too");
}

console.log("\n== a guest cannot take the kernel with it ==");
{
  // Every shape of "no command", because the two spawns accept an array OR an
  // options object and each shape reached the kernel by a different route.
  const r = await run(
    "bun",
    [
      "const shapes: Array<() => unknown> = [",
      "  () => (Bun as any).spawn(),",
      "  () => (Bun as any).spawn({}),",
      "  () => (Bun as any).spawn([]),",
      "  () => (Bun as any).spawn([null]),",
      "  () => (Bun as any).spawnSync(),",
      "  () => (Bun as any).spawnSync({ cmd: [] }),",
      "];",
      "let typeErrors = 0;",
      "for (const shape of shapes) {",
      "  try { shape(); } catch (e) { if (e instanceof TypeError) typeErrors++; }",
      "}",
      "console.log('TYPEERRORS:' + typeErrors + '/' + shapes.length);",
      // The claim is not merely "the kernel process is still up" — it is that the
      // kernel can still SERVE. A spawn after the bad ones proves the syscall
      // channel survived, which a crashed kernel could never do.
      "const after = Bun.spawnSync(['echo', 'kernel is fine']);",
      "console.log('AFTER:' + new TextDecoder().decode(after.stdout).trim());",
    ].join("\n") + "\n"
  );
  ok(!r.hung && r.code === 0, "the script that makes six malformed spawn calls exits cleanly");
  ok(/TYPEERRORS:6\/6/.test(r.stdout), "every malformed spawn throws a TypeError synchronously, at the call: " + (/TYPEERRORS:\S+/.exec(r.stdout) || ["?"])[0]);
  ok(/AFTER:kernel is fine/.test(r.stdout), "…and the kernel still services a real spawn afterwards");

  // Independent of the guest-side validation above: the kernel itself must not
  // die on a command it cannot resolve, whatever the runtime let through.
  ok(kernel.resolveProgram(undefined, "/") === null, "kernel.resolveProgram(undefined) answers 'no such program' instead of throwing");
  ok(kernel.resolveProgram("", "/") === null, "…and so does the empty string");
  ok(typeof kernel.resolveProgram("echo", "/", { PATH: "/bin" }) === "string", "…while a real command still resolves");
}

console.log("\n== the kernel's other door: messages, not syscalls ==");
{
  // A Process Worker's messages reach a handler TABLE in the kernel, and in a
  // browser `globalThis.postMessage` inside that worker posts straight to it — so
  // those payloads are only as trustworthy as the guest. Five of these nine threw
  // on a malformed message (`thread-spawn` on a bare `{}`), and the dispatch had no
  // guard, so the throw escaped into the kernel's onmessage and ended the VM: every
  // process, the VFS session, the preview.
  //
  // Called directly rather than posted, deliberately. The Node tier has no global
  // postMessage for a guest to reach — which is exactly why this went unnoticed —
  // so the tier-independent claim worth pinning is that no handler throws on junk.
  kernel.writeFile(APP + "/sleeper.ts", "setTimeout(() => {}, 3000);\n");
  const sleeper = kernel.start("bun", ["run", "sleeper.ts"], { cwd: APP, env: ENV, capture: true });
  await new Promise((r) => setTimeout(r, 500));
  const pid = [...kernel.procs.keys()].pop();

  const handlers = [
    "handleThreadSpawn", "handleThreadTerminate", "handleChildStdin", "handleSignalListen",
    "handleWsOut", "handleSseOut", "handlePipeRelay", "handleDebugEvent", "handleWorkerError",
  ];
  const junk = [undefined, null, {}, { type: "nonsense" }, { spec: null }, { connId: "no-such" }, 7, "string"];
  const threw = [];
  for (const name of handlers) {
    for (const payload of junk) {
      try {
        kernel[name](pid, payload);
      } catch {
        threw.push(name);
        break;
      }
    }
  }
  ok(threw.length === 0, "no kernel message handler throws on a malformed payload" + (threw.length ? " — threw: " + threw.join(", ") : ""));
  // A shape check invites the opposite failure, so this pins that the live process
  // was not collateral damage of the junk above.
  ok(kernel.procs.has(pid), "…and the process that was running is untouched");
  await sleeper;
}

console.log("\n== a guest cannot reach the kernel's mailbox ==");
{
  // The same fix at the runtime end. A Node worker has no global postMessage, so an
  // assertion that the guest sees none would pass without the fix — vacuous. The
  // worker entry therefore plants one when VV_PLANT_KERNEL_MAILBOX is set (see
  // scripts/process-worker.mjs), standing in for the browser's kernel channel.
  //
  // What is pinned is that the guest cannot REACH the kernel through it, which is
  // not the same as the name being absent: a bun guest gets a `postMessage` back
  // (Bun's main thread has one), inert and bound to nothing. The plant returns a
  // sentinel string, so calling it is what tells the two apart — checking only
  // `typeof` would call the Bun-faithful replacement a failure, and would call a
  // re-leaked channel a success.
  kernel.writeFile(APP + "/echo.worker.ts", "self.onmessage = (e: any) => postMessage('echo:' + e.data);\n");
  kernel.writeFile(
    APP + "/mailbox.ts",
    [
      "const pm = (globalThis as any).postMessage;",
      "const seen = {",
      "  postMessage: typeof pm,",
      // The sentinel the plant returns. `undefined` here means whatever this is,
      // it is not the channel to the kernel's handler table.
      "  reached: typeof pm === 'function' ? String(pm({ type: 'thread-spawn' })) : 'no-op',",
      "  Worker: typeof (globalThis as any).Worker,",
      "};",
      // Proof the runtime's OWN channel survived the removal: this output, the exit
      // code and the worker round trip all travel it. If the worker shell had kept
      // reading the global lazily instead of capturing it, every one of them would
      // be gone.
      "const w = new Worker('./echo.worker.ts');",
      "w.postMessage('hi');",
      "const reply = await new Promise((r) => { w.onmessage = (e: any) => r(e.data); });",
      "await w.terminate();",
      'console.log("MAILBOX:" + JSON.stringify({ ...seen, reply }));',
    ].join("\n") + "\n"
  );
  // Read when the worker module loads, so it has to be set before this start.
  process.env.VV_PLANT_KERNEL_MAILBOX = "1";
  const m = await kernel.start("bun", ["run", "mailbox.ts"], { cwd: APP, env: ENV, capture: true });
  delete process.env.VV_PLANT_KERNEL_MAILBOX;
  const found = /MAILBOX:(\{.*\})/.exec(m.stdout || "");
  const got = found ? JSON.parse(found[1]) : null;
  if (!got) console.log("  stderr:", (m.stderr || "").split("\n").slice(0, 3).join(" | "));
  ok(m.code === 0 && !!got, "the mailbox script runs");
  ok(got && got.reached !== "guest reached the kernel", "the planted kernel channel is gone before guest code runs, so a guest cannot post into the kernel's handler table");
  ok(got && got.reached === "undefined", "…and what a bun guest has instead is inert, returning undefined as Bun's does");
  ok(got && got.postMessage === "function", "…while the NAME is still there, because Bun's main thread has one");
  ok(got && got.Worker === "function", "…and Bun's Worker survives the realm sweep that removed the rest");
  ok(got && got.reply === "echo:hi", "…and a worker still exchanges messages, so the runtime's own channel is intact");
}

console.log(failed ? `\nFAIL: ${failed} check(s) failed` : "\nOK: all fatal-error checks passed");
process.exit(failed ? 1 : 0);