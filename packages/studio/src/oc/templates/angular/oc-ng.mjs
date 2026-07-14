// OpenContainer Angular launcher.
//
// Angular's @angular/build compiles with esbuild (a filesystem-backed binary
// SERVICE) and serves via Vite. Two things need adapting for the in-browser VM,
// which this script handles before delegating to the Angular CLI:
//
//   1. esbuild's Node build spawns `node bin/esbuild --service` as a CHILD and
//      talks a byte-accurate binary protocol over its stdio pipe. Brokered
//      through the single-threaded in-VM kernel, that pipe deadlocks against
//      Angular's Piscina linker pool + inline AOT (all contend for one event
//      loop). We rewrite esbuild-wasm's ensureServiceIsRunning() to run the Go
//      wasm IN THIS THREAD: fd 0/1/2 are multiplexed onto the protocol in memory
//      and every other fd delegates to the real fs (the VFS).
//   2. Angular's AOT + JS/CSS transforms use worker pools with an Atomics
//      fast-path our cooperative worker_threads can't serve; NG_BUILD_PARALLEL_TS
//      selects the inline AotCompilation and PISCINA_DISABLE_ATOMICS switches the
//      transform pool to async message passing.
//
// The esbuild patch is a string replacement of esbuild-wasm@0.28.1's shipped
// lib/main.js (pinned via package.json "overrides"); it is idempotent and a
// no-op if the spawn block isn't found (esbuild then falls back to its child).

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// The exact child-spawn block esbuild-wasm@0.28.1 ships in lib/main.js.
const ESB_INPROC_OLD = `  let [command, args] = esbuildCommandAndArgs();
  let child = child_process.spawn(command, args.concat(\`--service=\${"0.28.1"}\`, "--ping"), {
    windowsHide: true,
    stdio: ["pipe", "pipe", "inherit"],
    cwd: defaultWD
  });
  let { readFromStdout, afterClose, service } = createChannel({
    writeToStdin(bytes) {
      child.stdin.write(bytes, (err) => {
        if (err) afterClose(err);
      });
    },
    readFileSync: fs2.readFileSync,
    isSync: false,
    hasFS: true,
    esbuild: node_exports
  });
  child.stdin.on("error", afterClose);
  child.on("error", afterClose);
  const stdin = child.stdin;
  const stdout = child.stdout;
  stdout.on("data", readFromStdout);
  stdout.on("end", afterClose);
  stopService = () => {
    stdin.destroy();
    stdout.destroy();
    child.kill();
    initializeWasCalled = false;
    longLivedService = void 0;
    stopService = void 0;
  };
  let refCount = 0;
  child.unref();
  if (stdin.unref) {
    stdin.unref();
  }
  if (stdout.unref) {
    stdout.unref();
  }
  const refs = {
    ref() {
      if (++refCount === 1) child.ref();
    },
    unref() {
      if (--refCount === 0) child.unref();
    }
  };`;

// In-process replacement: runs the Go wasm in this thread, multiplexing fd 0/1/2
// onto esbuild's binary protocol. References esbuild's own main.js locals
// (path2, fs2, os2, node_exports, createChannel, initializeWasCalled,
// longLivedService, stopService), so it is injected into that scope verbatim.
const ESB_INPROC_NEW = `  // [OpenContainer] in-process esbuild service (no child spawn).
  require(path2.join(__dirname, "..", "wasm_exec.js"));
  const __ocWasmBytes = fs2.readFileSync(path2.join(__dirname, "..", "esbuild.wasm"));
  let __ocStdin = [];
  let __ocStdinPos = 0;
  let __ocResume = null;
  let __ocReadFromStdout = null;
  const __ocRealFs = fs2;
  const __ocFs = Object.create(__ocRealFs);
  __ocFs.writeSync = (fd, buf) => {
    if (fd === 1) { __ocReadFromStdout(buf.slice()); return buf.length; }
    if (fd === 2) { try { process.stderr.write(buf.slice()); } catch {} return buf.length; }
    return __ocRealFs.writeSync(fd, buf);
  };
  __ocFs.write = (fd, buf, offset, length, position, callback) => {
    if (fd === 1 || fd === 2) {
      const slice = (offset === 0 && length === buf.length) ? buf : buf.subarray(offset, offset + length);
      const n = __ocFs.writeSync(fd, slice);
      const cb = typeof position === "function" ? position : callback;
      if (typeof cb === "function") cb(null, n);
      return;
    }
    return __ocRealFs.write(fd, buf, offset, length, position, callback);
  };
  __ocFs.read = (fd, buffer, offset, length, position, callback) => {
    if (fd === 0) {
      if (__ocStdin.length === 0) {
        __ocResume = () => __ocFs.read(fd, buffer, offset, length, position, callback);
        return;
      }
      const first = __ocStdin[0];
      const count = Math.max(0, Math.min(length, first.length - __ocStdinPos));
      buffer.set(first.subarray(__ocStdinPos, __ocStdinPos + count), offset);
      __ocStdinPos += count;
      if (__ocStdinPos === first.length) { __ocStdin.shift(); __ocStdinPos = 0; }
      callback(null, count);
      return;
    }
    return __ocRealFs.read(fd, buffer, offset, length, position, callback);
  };
  globalThis.fs = __ocFs;
  const __ocGo = new globalThis.Go();
  __ocGo.argv = ["node", \`--service=\${"0.28.1"}\`];
  __ocGo.env = Object.assign({ TMPDIR: os2.tmpdir() }, process.env);
  let { readFromStdout, afterClose, service } = createChannel({
    writeToStdin(bytes) {
      __ocStdin.push(bytes);
      if (__ocResume) {
        const r = __ocResume;
        __ocResume = null;
        // Resume the parked Go read on a microtask, NOT a macrotimer: our event
        // loop may already be idle-waiting on the kernel when this fires, and
        // microtasks are always drained before the loop parks.
        queueMicrotask(r);
      }
    },
    readFileSync: fs2.readFileSync,
    isSync: false,
    hasFS: true,
    esbuild: node_exports
  });
  __ocReadFromStdout = readFromStdout;
  __ocGo.exit = (code) => { afterClose(code ? new Error("esbuild service exited with code " + code) : null); };
  WebAssembly.instantiate(__ocWasmBytes, __ocGo.importObject).then(
    (result) => { __ocGo.run(result.instance); },
    (err) => { afterClose(err); }
  );
  let __ocRefCount = 0;
  let __ocRefTimer = null;
  stopService = () => {
    try { for (const t of __ocGo._scheduledTimeouts.values()) clearTimeout(t); } catch {}
    if (__ocRefTimer) { clearInterval(__ocRefTimer); __ocRefTimer = null; }
    initializeWasCalled = false;
    longLivedService = void 0;
    stopService = void 0;
  };
  // Hold the event loop open while a request is in flight — the inline Go service
  // parks on an fd-0 read that refs nothing, and a pending promise won't keep the
  // loop alive (mirrors the child transport's child.ref()/child.unref()). Needed
  // for one-shot \`ng build\`; \`ng serve\` also has the dev-server listener.
  const refs = {
    ref() { if (++__ocRefCount === 1) __ocRefTimer = setInterval(() => {}, 1 << 30); },
    unref() { if (--__ocRefCount === 0 && __ocRefTimer) { clearInterval(__ocRefTimer); __ocRefTimer = null; } },
  };`;

function patchEsbuild() {
  for (const dir of ["node_modules/esbuild", "node_modules/esbuild-wasm"]) {
    const mainPath = path.resolve(dir, "lib/main.js");
    if (!fs.existsSync(mainPath)) continue;
    let src;
    try {
      src = fs.readFileSync(mainPath, "utf8");
    } catch {
      continue;
    }
    if (src.includes("[OpenContainer] in-process esbuild service")) continue; // already patched
    if (!src.includes(ESB_INPROC_OLD)) {
      console.warn("[oc-ng] esbuild spawn block not found in " + dir + " — leaving it to spawn a child");
      continue;
    }
    fs.writeFileSync(mainPath, src.replace(ESB_INPROC_OLD, ESB_INPROC_NEW));
    console.log("[oc-ng] patched " + dir + " to run esbuild in-process");
  }
}

patchEsbuild();

if (!process.env.NG_BUILD_PARALLEL_TS) process.env.NG_BUILD_PARALLEL_TS = "0";
if (!process.env.PISCINA_DISABLE_ATOMICS) process.env.PISCINA_DISABLE_ATOMICS = "1";
if (!process.env.NG_CLI_ANALYTICS) process.env.NG_CLI_ANALYTICS = "false";

// Run the Angular CLI as its own process (the proven model): args after this
// script pass straight through, e.g. `node scripts/oc-ng.mjs serve --port 4200`.
const ng = path.resolve("node_modules/@angular/cli/bin/ng.js");
const child = spawn(process.execPath, [ng, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
child.on("exit", (code, signal) => process.exit(signal ? 1 : code ?? 0));
