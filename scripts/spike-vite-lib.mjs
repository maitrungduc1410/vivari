// Shared harness for the frontend-variant Vite spikes (Preact / Lit / Solid /
// Qwik). Each of those templates is a plain Vite SPA that differs only in its
// framework plugin + JSX transform, so the in-VM proof is identical: install the
// real deps, boot the real `vite` dev server, and assert it serves the app.
//
// A spike PASSES when every gate is green:
//   1. `npm install` exits 0 and the `vite` bin landed on disk.
//   2. `vite` binds its port (its dev server actually started).
//   3. GET /                -> 200 with the template's <title> marker.
//   4. GET /@vite/client    -> 200 (Vite's dev middleware is live).
//   5. GET <entry module>   -> 200 (the framework plugin transformed the entry
//      without throwing — this is the check that would catch a Preact/Solid/Qwik
//      plugin or JSX-transform breakage that a plain "GET / 200" would miss).
//
// Usage (Node 22+, needs network for npm):
//   1) vendor npm:  rm -rf /tmp/vv-vendor && mkdir -p /tmp/vv-vendor \
//        && (cd /tmp/vv-vendor && npm install npm@10.9.2 --no-save --no-audit --no-fund)
//   2) a per-framework spike calls runViteSpike({...}); run e.g.
//        node scripts/spike-preact.mjs
//
// Env knobs: VV_LIVE=1 (stream in-VM output), VV_PORT, VV_INSTALL_TIMEOUT,
// VV_BIND_TIMEOUT, VV_INSTALL_ONLY=1.

import { Kernel } from "../packages/kernel-host/kernel.js";
import { createKernelFs } from "../packages/kernel-host/kernel-fs.js";
import { stubNodeGyp } from "../packages/kernel-host/node-gyp-stub.js";
import { applyRealNpmShims } from "../packages/kernel-host/load-real-npm.js";
import { loadShippedTemplates } from "./lib/shipped-templates.mjs";
import { shouldReportStallFor } from "../packages/core/terminal-feedback.js";
import { initTransferList } from "../packages/kernel-host/worker-transfer.js";
import { createAliasedFetcher } from "./lib/aliased-fetcher.mjs";
import { Worker, MessageChannel } from "node:worker_threads";
import fs from "node:fs";
import path from "node:path";

const VFS_NPM = "/usr/lib/node_modules/npm";

/**
 * The dev command the studio runs for a template, read from the template.
 *
 * This was briefly a `VITE_DEV` constant copied out of templates.ts, which is this
 * round's own lesson walking back in through the fix for it: `spike-react` passed the
 * manifest's command and its six neighbours took the copy, so a change to the shipped
 * command would have left react gating the new one and the rest gating the old one,
 * all green. Two places for one fact is the shape of the bug being fixed here.
 *
 * A missing id THROWS rather than falling back. A fallback is how the copy would come
 * back — silently, the first time a template is renamed.
 */
async function shippedDevCommand(templateId) {
  const t = (await loadShippedTemplates()).find((x) => x.manifest.id === templateId);
  if (!t) throw new Error(`no template \`${templateId}\` in packages/studio/src/vv/templates.ts — did its id change?`);
  if (!t.manifest.dev) throw new Error(`template \`${templateId}\` has no \`dev\` command in its manifest`);
  return t.manifest.dev;
}

/**
 * @param {object} opts
 * @param {string} opts.name         Human label, e.g. "Preact".
 * @param {string} opts.dir          VFS project dir, e.g. "/preact".
 * @param {string} opts.templateId   Shipped template this stands for, e.g. "preact" — its
 *                                   manifest supplies the dev command that gets run.
 * @param {Record<string,string>} opts.files  relPath -> contents (the template source).
 * @param {string} opts.entryModule  root-absolute module the index.html loads, e.g. "/src/main.tsx".
 * @param {RegExp}  opts.titleMarker Regex the served index.html must match, e.g. /Vite \+ Preact/.
 * @returns {Promise<boolean>} true on PASS.
 */
export async function runViteSpike({ name, dir, templateId, files, entryModule, titleMarker }) {
  const devCommand = await shippedDevCommand(templateId);
  const LIVE = process.env.VV_LIVE === "1";
  const PORT = Number(process.env.VV_PORT || 5173);
  const VENDOR_NPM = process.argv[2] || "/tmp/vv-vendor/node_modules/npm";

  if (!fs.existsSync(path.join(VENDOR_NPM, "bin/npm-cli.js"))) {
    console.error(`No vendored npm at ${VENDOR_NPM} (expected bin/npm-cli.js).`);
    console.error(
      `Vendor it:  rm -rf /tmp/vv-vendor && mkdir -p /tmp/vv-vendor && (cd /tmp/vv-vendor && npm install npm@10.9.2 --no-save --no-audit --no-fund)`,
    );
    process.exit(2);
  }

  // ── kernel setup (same shape as spike-webpack.mjs / spike-next.mjs) ─────────
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
    const w = new Worker(new URL("./process-worker.mjs", import.meta.url));
    w.on("message", (m) => {
      const h = info.on[m.type];
      if (h) h(m);
    });
    w.on("error", (e) => {
      process.stderr.write(`\n[worker-error pid ${info.pid}] ${(e && e.stack) || e}\n`);
    });
    const { port1, port2 } = new MessageChannel();
    fsWorker.postMessage({ type: "fs-register", client: info.pid, sab: info.sab, port: port2 }, [port2]);
    const init = { type: "init", sab: info.sab, spec: info.spec, fsPort: port1 };
    if (info.threadPort) init.threadPort = info.threadPort;
    // A worker pool (tinypool, piscina, synckit) puts a MessagePort in workerData;
    // initTransferList is what knows those must be transferred on to the child.
    w.postMessage(init, initTransferList(info, port1));
    return {
      terminate: () => {
        w.terminate();
        fsWorker.postMessage({ type: "fs-unregister", client: info.pid });
      },
      postMessage: (m) => w.postMessage(m),
    };
  };

  // Transparent native->wasm packument aliasing, mirroring the browser kernel.
  // Backed by the shared table in packages/runtime/toolchain-shims.js (via
  // scripts/lib/aliased-fetcher.mjs), so esbuild/rollup/lightningcss and any
  // drop-in stay in lockstep with fetcher-worker.ts and can't drift.
  const fetcher = createAliasedFetcher();

  const out = [];
  const cap = (s) => {
    out.push(s);
    if (LIVE) process.stderr.write(s);
  };
  // Two sets, because they answer different questions and the difference is load
  // bearing. `listening` is ever-bound and only grows — right for "did it start",
  // wrong for "is it still up", and vite closes and rebinds a few times while it
  // settles, so a live view has to track both edges.
  const listening = new Set();
  const live = new Set();
  const kernel = new Kernel({ fs: kernelFs.fs, spawnWorker, fetcher, stdout: cap, stderr: cap });
  kernel.onListen = (port) => {
    listening.add(port);
    live.add(port);
  };
  kernel.onClose = (port) => live.delete(port);

  // ── the stall watchdog, run against the real thing ─────────────────────────
  //
  // A user ran this exact template and watched the terminal fill with `[runtime] PID
  // 7 () has printed nothing for 73s … it looks stuck rather than slow`, four times
  // over, while the dev server it was accusing served their app and hot-reloaded it.
  // Those pids were vite's rolldown worker threads, parked waiting for a job.
  //
  // The rendering belongs to kernel-worker.ts, which is browser-only and cannot run
  // here, but the DECISION is `shouldReportStallFor` and that is shared — the same
  // call the kernel worker makes, reading the same kernel. An earlier version of this
  // harness re-derived the inputs itself, which made this gate an assertion about a
  // copy: production could change and the copy would keep passing. The threshold is
  // dropped to a few seconds because the point is to give the watchdog every chance
  // to fire, not to wait out 60.
  kernel.stallThresholdMs = Number(process.env.VV_STALL_MS || 6000);
  kernel.stallCheckMs = 1000;
  const stallReports = [];
  kernel.onProcStall = (pid, info) => {
    if (!shouldReportStallFor(kernel, pid)) return;
    stallReports.push({
      pid,
      command: info.command,
      isThread: !!info.isThread,
      silentMs: info.silentMs,
    });
  };
  kernel.installCoreutils();
  let fetchN = 0;
  kernel.onFetch = (url, meta) => {
    fetchN++;
    if (LIVE) process.stderr.write(`  [net ${fetchN}] ${meta.cached ? "cache" : "GET"} ${((meta.size / 1024) | 0)}k  ${url}\n`);
  };

  // ── load the vendored npm tree into the VFS ────────────────────────────────
  let fileCount = 0;
  function loadDir(hostDir, vfsDir) {
    kernel.mkdirp(vfsDir);
    for (const entry of fs.readdirSync(hostDir, { withFileTypes: true })) {
      const hostPath = path.join(hostDir, entry.name);
      const vfsPath = vfsDir + "/" + entry.name;
      if (entry.isDirectory()) loadDir(hostPath, vfsPath);
      else if (entry.isFile()) {
        kernel.writeFile(vfsPath, fs.readFileSync(hostPath));
        fileCount++;
      }
    }
  }
  const t0 = Date.now();
  loadDir(VENDOR_NPM, VFS_NPM);
  stubNodeGyp(kernel, VFS_NPM);
  // `/bin/npm` and `/bin/npx`, which the product installs as part of loading npm
  // (loadRealNpm). This harness never needed them while it called npm's CLI file by
  // path and started vite by path — which is the same shortcut, one layer down: with
  // no `npm` on PATH there was no way for a spike to run a template's own commands
  // even if it had wanted to.
  applyRealNpmShims(kernel);
  console.log(`[${name}] Loaded real npm into VFS: ${fileCount} files (${Date.now() - t0}ms)`);

  kernel.mkdirp("/home/user");
  kernel.mkdirp("/tmp/.npm/_logs");

  // ── write the template source into the VFS ─────────────────────────────────
  for (const [rel, contents] of Object.entries(files)) {
    const abs = dir + "/" + rel;
    kernel.mkdirp(abs.slice(0, abs.lastIndexOf("/")));
    kernel.writeFile(abs, contents);
  }

  const env = {
    HOME: "/home/user",
    PATH: dir + "/node_modules/.bin:/bin",
    npm_config_cache: "/tmp/.npm",
    NODE_ENV: "development",
    VV_LIVE: LIVE ? "1" : "",
    // VV_DEBUG passthrough → Vite's `debug` namespaces (e.g. VV_DEBUG=vite:deps,
    // vite:optimize-deps) so a spike can surface what the dep optimizer is doing.
    ...(process.env.VV_DEBUG ? { DEBUG: process.env.VV_DEBUG } : {}),
    // VV_ENV='{"K":"V",...}' — inject arbitrary env into the in-VM process (used to
    // probe rolldown/emnapi knobs like NAPI_RS_ASYNC_WORK_POOL_SIZE).
    ...(process.env.VV_ENV ? JSON.parse(process.env.VV_ENV) : {}),
  };

  // ── gate 1: install ────────────────────────────────────────────────────────
  console.log(`\n== [${name}] npm install ==`);
  const INSTALL_TIMEOUT = Number(process.env.VV_INSTALL_TIMEOUT || 300000);
  const t1 = Date.now();
  let installTimedOut = false;
  const inst = await Promise.race([
    kernel.start("node", [VFS_NPM + "/bin/npm-cli.js", "install", "--no-audit", "--no-fund"], { cwd: dir, env, capture: !LIVE }),
    new Promise((r) => setTimeout(() => { installTimedOut = true; r({ code: 124 }); }, INSTALL_TIMEOUT)),
  ]);
  console.log(`  install exit=${inst.code}${installTimedOut ? " (TIMED OUT)" : ""}  (${((Date.now() - t1) / 1000).toFixed(1)}s)`);
  if (inst.code !== 0) {
    console.log("  STDERR tail:\n" + ((inst.stderr || out.join("")).slice(-3000)));
    process.exit(1);
  }
  const viteBin = kernel.exists(dir + "/node_modules/vite/bin/vite.js");
  console.log("  vite bin present: " + viteBin);

  if (process.env.VV_INSTALL_ONLY === "1") {
    console.log(`\nOC_INSTALL_ONLY=1 — stopping after install.`);
    process.exit(inst.code === 0 && viteBin ? 0 : 1);
  }

  // ── gate 2: vite dev server binds its port ─────────────────────────────────
  //
  // Started the way the STUDIO starts it: an interactive `sh` whose VV_RUN is the
  // template's own dev script, which is what the Run button sets. This used to
  // invoke `node node_modules/vite/bin/vite.js` directly, and the difference is not
  // cosmetic — the shipped command goes through `npm run`, npm's run-script does
  // `if (p.stdin) p.stdin.end()`, and for a while our ChildProcess answered that
  // question wrongly and the resulting EOF made every template's dev server shut
  // itself down seconds after it started. Six green spikes said otherwise, because
  // all six skipped the two programs in the middle. A harness that takes a shortcut
  // the product cannot take is gating the shortcut.
  //
  // --host/--port/--strictPort still go on the end: they are the harness's, not the
  // template's, and `npm run dev --` forwards them.
  console.log(`\n== [${name}] ${devCommand} (dev server, via sh — the shipped path) ==`);
  const devStart = out.length;
  const devLine = `${devCommand} --host 127.0.0.1 --port ${PORT} --strictPort`;
  const shPid = kernel.launch("sh", [], {
    cwd: dir,
    env: { ...env, VV_RUN: devLine },
    // A terminal, because the studio's is one and it reaches further than it looks:
    // fd 0 being a TTY is what puts vite in interactive mode, which is what makes it
    // listen to stdin at all.
    tty: true,
  });
  if (process.env.VV_DEBUG) console.log(`  [dev shell pid] ${shPid}`);
  const BIND_TIMEOUT = Number(process.env.VV_BIND_TIMEOUT || 240000);
  const tb = Date.now();
  let fatal = "";
  while (!listening.has(PORT) && Date.now() - tb < BIND_TIMEOUT && !fatal) {
    await new Promise((r) => setTimeout(r, 100));
    const tail = out.slice(devStart).join("");
    // `sh: <cmd>: not found` is in here because the shipped path runs a COMMAND
    // rather than a file path, so it can now fail by not existing — and without
    // this that failure waits out the full bind timeout before saying so.
    //
    // Every branch has to name something the dev server cannot come back from,
    // because matching one ends the wait and reports the port as never bound. A
    // plugin-TAGGED line is not that on its own: Vite tags ordinary compat
    // warnings exactly the way it tags errors, and the Qwik optimizer prints
    //   [plugin:vite-plugin-qwik] context method emitFile() is not supported in serve mode.
    // on every serve-mode boot, a few hundred ms BEFORE "ready", after which the
    // server binds and serves the app. Matching the bare tag therefore made the
    // verdict a race between that warning and the bind, decided by which one a
    // 100 ms poll happened to see first — the same commit passed and failed on
    // consecutive runs, and under load it failed four times in six. So the tag
    // now has to arrive WITH an error to count as one; Vite's own startup-failure
    // banner is matched directly, which is the fatal case the bare tag was
    // standing in for.
    const m = tail.match(
      /Cannot find module '([^']+)'|sh: [^\n]*not found|Failed to resolve[^\n]*|error when starting dev server[^\n]*|[^\n]*[Ee]rror[^\n]*\[plugin[^\]]*\][^\n]*|\[plugin[^\]]*\][^\n]*[Ee]rror[^\n]*|([A-Za-z]*Error: [^\n]*is not (?:a function|supported)[^\n]*)/,
    );
    if (m) fatal = m[0];
  }
  if (fatal) console.log(`  early-abort: ${fatal}`);
  const bound = listening.has(PORT);
  console.log(`  listening on ${PORT}: ${bound}  (${((Date.now() - tb) / 1000).toFixed(1)}s)`);

  // ── gates 3-5: HTTP checks ─────────────────────────────────────────────────
  const decode = (b) => (typeof b === "string" ? b : Buffer.from(b).toString());
  const get = (url) =>
    kernel.handleHttpRequest(PORT, { port: PORT, method: "GET", url, headers: { host: "127.0.0.1:" + PORT }, body: "" });
  const getRetry = async (url) => {
    let r = await get(url);
    // Vite does on-demand work on first hit (optimizeDeps / transform) → allow
    // a warm-up window on 5xx/404 before giving up.
    for (let i = 0; i < 60 && (r.status === 502 || r.status === 404 || r.status >= 500); i++) {
      await new Promise((res) => setTimeout(res, 1000));
      r = await get(url);
    }
    return r;
  };

  let rootOk = false;
  let clientOk = false;
  let entryOk = false;
  if (bound) {
    const root = await getRetry("/");
    const rootBody = decode(root.body || "");
    rootOk = root.status === 200 && titleMarker.test(rootBody) && /<script[^>]+type="module"/.test(rootBody);
    console.log(`  GET /               -> ${root.status}  (${rootBody.length} bytes)  marker=${titleMarker.test(rootBody)}`);

    const client = await getRetry("/@vite/client");
    clientOk = client.status === 200;
    console.log(`  GET /@vite/client   -> ${client.status}`);

    const entry = await getRetry(entryModule);
    const entryBody = decode(entry.body || "");
    entryOk = entry.status === 200 && entryBody.length > 0;
    console.log(`  GET ${entryModule.padEnd(15)} -> ${entry.status}  (${entryBody.length} bytes)`);
    if (!entryOk) console.log("  entry body head: " + entryBody.slice(0, 300).replace(/\n/g, " "));
  } else {
    console.log("\n---- dev output tail (last 4000 chars) ----\n" + out.slice(devStart).join("").slice(-4000));
  }

  // ── gates 6-7: it is still there, and it pre-bundled ───────────────────────
  //
  // "Started and served once" is not what a dev server is for, and it is exactly
  // what the old harness proved. A server that shuts down seconds after printing
  // its URL passes every gate above if the requests land in the window. So: is the
  // port still bound now, and did the dependency scan survive?
  //
  // The scan is checked separately from the port because it failed FIRST and more
  // quietly — vite catches it, prints `Failed to run dependency scan. Skipping
  // dependency pre-bundling.` and carries on serving, so it costs cold-start speed
  // rather than correctness and no other gate would ever notice. Its positive
  // control is `.vite/deps`: pre-bundling either wrote the optimised modules or it
  // did not, which is a fact on disk rather than an absence in a log.
  const devOut = out.slice(devStart).join("");
  const scanFailed = /Failed to run dependency scan|Request is outdated/.test(devOut);
  const stillServing = live.has(PORT);
  // POLLED, not read once. Pre-bundling is asynchronous — vite can serve the first
  // requests while the optimiser is still writing — so a single read after the HTTP
  // gates is a race, and it lost one: svelte reported `scan failed: false` beside
  // `deps: 0` and passed on a re-run. A gate that goes red for a reason other than the
  // one it names is worse than no gate, because the first red is read as noise and so
  // is the second. Waiting costs nothing in the failing case this exists for: there the
  // scan has ALREADY failed, so the directory is never written and the poll runs out.
  let deps = [];
  for (let i = 0; i < 40 && deps.length === 0; i++) {
    try {
      deps = kernel.readdir(dir + "/node_modules/.vite/deps") || [];
    } catch {
      /* not created yet, or never */
    }
    if (deps.length === 0) await new Promise((r) => setTimeout(r, 250));
  }
  const preBundled = deps.length > 0;
  console.log(`  dev server still listening on ${PORT}: ${stillServing}`);
  console.log(`  dependency scan failed: ${scanFailed}`);
  console.log(`  pre-bundled deps in .vite/deps: ${deps.length}`);
  if (scanFailed) {
    const m = devOut.match(/\(!\)[^\n]*\n(?:[^\n]*\n){0,12}/);
    console.log("  scan failure:\n" + (m ? m[0] : "").split("\n").map((l) => "    " + l).join("\n"));
  }
  if (!stillServing) console.log("\n---- dev output tail (last 3000 chars) ----\n" + devOut.slice(-3000));

  // ── gate 8: a healthy dev server is not accused of hanging ─────────────────
  //
  // Everything above has just proved this server is healthy — bound, serving 200s,
  // transforming the entry, still up, deps pre-bundled. So any stall report standing
  // at this moment is false BY CONSTRUCTION, which is what makes this assertable at
  // all rather than a judgement about noise.
  //
  // Deliberately narrower than "no reports": a genuinely busy-and-silent process is
  // supposed to be reported, and this harness runs a real `npm install` first. The
  // claim is about the processes the user was shown — the dev server's own tree, once
  // it is up. Threads are checked by name too, because `PID 7 ()` was a separate
  // defect from the false positive and a fix for one does not cover the other.
  //
  // WHAT THIS GATE DOES NOT COVER, so nobody reads it as covering everything: it
  // cannot exercise `hasUnwatchedChild` at all. `vite` is excused by `serving` before
  // that input is consulted, and each thread is excused before its parent is examined,
  // so this reads 0 reports whether the revocation is right, wrong, or deleted. The
  // revocation is gated synthetically in spike-diag-liveness, on a pool built to hold
  // a watched and an unwatched child at the same time. This gate's job is the user's
  // symptom, which is the threads themselves.
  //
  // WHICH RULE IS DOING THE WORK HERE, measured on this template by disabling one at
  // a time, because the two are not interchangeable and the difference is not visible
  // from a passing run:
  //
  //   unobservable off, awaiting on  -> reported: the threads that never announced
  //   awaiting off, unobservable on  -> reported: none
  //
  // EVERY one of vite's threads has never printed, so `unobservable` covers all of
  // them and is on its own sufficient here; `awaiting` covers those that also announce
  // `work`, which is not all of them. So `unobservable` is the one this template cannot
  // do without, and `awaiting` is not redundant for a reason this gate structurally
  // cannot show: it is what covers a pool worker that PRINTS at boot and then parks,
  // which no thread here does. spike-diag-liveness runs one.
  //
  // Stated without counting on purpose. The pool has come up with a different number
  // of threads between runs on the same machine and template, so a count written here
  // is a sentence that goes stale without anything being wrong — and the argument does
  // not need one.
  //
  // Give the watchdog its chance, and prove it had one. Reports back off by doubling
  // (T, 2T, 4T …), so idling past 2T means two opportunities have gone by; asserting
  // the observed silence afterwards is what stops this gate passing vacuously because
  // nothing was ever quiet for long enough to check.
  const stallWindow = kernel.stallThresholdMs * 2 + 2000;
  await new Promise((r) => setTimeout(r, stallWindow));

  const devTreePids = new Set();
  {
    const kids = new Map();
    for (const [cpid, p] of kernel.procs) kids.set(cpid, p.parentPid ?? 0);
    for (const [cpid] of kernel.procs) {
      let cur = cpid;
      const seen = new Set();
      while (cur && !seen.has(cur)) {
        seen.add(cur);
        if (cur === shPid) {
          devTreePids.add(cpid);
          break;
        }
        cur = kids.get(cur);
      }
    }
  }
  // Measured over the whole dev tree rather than its threads, because not every
  // template has threads: Svelte's dev server runs without a rolldown pool, and a
  // check keyed on threads reported "silent 0s" there and failed a healthy run. The
  // server process itself is quiet between requests in every template, which is the
  // same silence the watchdog reads and enough to prove it was given something to look
  // at.
  const quietest = [...kernel.procs.values()]
    .filter((p) => !p.finalized && devTreePids.has(p.pid))
    .reduce((m, p) => Math.max(m, Date.now() - (p.lastOutput || p.startedAt || Date.now())), 0);
  const watchdogHadItsChance = quietest > kernel.stallThresholdMs;
  console.log(
    `  quietest process in the dev tree has been silent ${Math.round(quietest / 1000)}s ` +
      `(threshold ${Math.round(kernel.stallThresholdMs / 1000)}s)`,
  );

  const falseStalls = stallReports.filter((r) => devTreePids.has(r.pid));
  const threads = [...kernel.procs.values()].filter((p) => p.isThread && !p.finalized);
  const unnamedThreads = threads.filter((p) => !p.command || !String(p.command).trim());
  console.log(`  worker threads in the dev tree: ${threads.length} (${threads.map((p) => p.command || "??").join(", ")})`);
  console.log(`  stall reports against the healthy dev tree: ${falseStalls.length}`);
  for (const r of falseStalls) {
    console.log(`    PID ${r.pid} (${r.command || ""})${r.isThread ? " [worker thread]" : ""} silent ${Math.round(r.silentMs / 1000)}s`);
  }
  if (unnamedThreads.length) console.log(`  UNNAMED worker threads: ${unnamedThreads.length}`);
  const noFalseStalls = falseStalls.length === 0;
  const threadsNamed = unnamedThreads.length === 0;

  const ok =
    inst.code === 0 &&
    viteBin &&
    bound &&
    rootOk &&
    clientOk &&
    entryOk &&
    stillServing &&
    !scanFailed &&
    preBundled &&
    noFalseStalls &&
    threadsNamed &&
    watchdogHadItsChance;
  console.log(
    `\nRESULT: ${ok ? `PASS — ${name} + Vite boots via \`${devCommand}\`, serves / (200), transforms ${entryModule}, and is still up` : `FAIL — see logs above`}`,
  );
  return ok;
}