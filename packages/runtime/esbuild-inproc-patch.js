// Transparent in-process esbuild service (framework-agnostic).
//
// esbuild-wasm's Node build (lib/main.js) starts its service by spawning
// `node bin/esbuild --service` as a CHILD and talking a byte-accurate binary
// protocol over its stdio pipe. Brokered through the single-threaded in-VM
// kernel, that pipe deadlocks whenever the same event loop also drives a worker
// pool (Piscina/tinypool) — e.g. Angular's compiler, but also tsup, Vitest and
// anything else that bundles-under-a-pool. The fix is to run the Go wasm IN THIS
// THREAD: fd 0/1/2 are multiplexed onto the protocol in memory and every other
// fd delegates to the real fs (the VFS).
//
// This used to live in a per-project launcher (scripts/oc-ng.mjs). It now runs
// in the module loader (see module.js) so ANY project that ends up with an
// esbuild-wasm-backed install gets the deadlock-free service automatically, with
// no project-level script or config. It is a string replacement of the child-
// spawn block esbuild-wasm ships in lib/main.js; it is idempotent and a strict
// no-op when the wasm assets aren't present next to main.js (a genuine native
// esbuild install is left untouched).
//
// VERSION-DRIFT RESILIENCE: the block's only per-release variable is the version
// literal in `--service=${"x.y.z"}`, so we match with a regex that TEMPLATES that
// literal (capturing the version and threading it into the replacement). A point/
// minor bump with the same block shape keeps patching automatically. If the block
// SHAPE changes (a real esbuild-wasm refactor) the regex won't match and we emit a
// loud one-time console.warn — esbuild would otherwise silently deadlock under a
// worker pool, so we fail loud instead of failing silent.

// Template of the child-spawn block esbuild-wasm ships in lib/main.js, with the
// version literal replaced by the %VER% placeholder. Compiled to a regex below.
const ESB_INPROC_OLD = `  let [command, args] = esbuildCommandAndArgs();
  let child = child_process.spawn(command, args.concat(\`--service=\${"%VER%"}\`, "--ping"), {
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
// longLivedService, stopService) plus the CJS wrapper's __dirname/require, so it
// is injected into that scope verbatim.
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
  __ocGo.argv = ["node", \`--service=\${"%VER%"}\`];
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

const OC_MARKER = "[OpenContainer] in-process esbuild service";

// A semver-ish version literal: 1-3 dotted numbers + optional prerelease/build.
const VER_CAPTURE = "([0-9]+(?:\\.[0-9]+){0,3}(?:-[0-9A-Za-z.]+)?)";

// Compile the spawn-block template into a regex that captures the version literal,
// so a patch-compatible release (same block shape, new version) still matches.
function compileOldRegex() {
  const escaped = ESB_INPROC_OLD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped.replace("%VER%", VER_CAPTURE));
}
const ESB_OLD_RE = compileOldRegex();

// True when `filename` is an esbuild(-wasm) lib/main.js whose package also ships
// the Go wasm assets (esbuild.wasm + wasm_exec.js) one directory up. A genuine
// native esbuild install has no such assets and is deliberately skipped.
function isEsbuildWasmMain(filename, fs, path) {
  if (!filename.endsWith("/lib/main.js") && !filename.endsWith("\\lib\\main.js")) return false;
  const pkgDir = path.dirname(path.dirname(filename)); // <pkg>/lib/main.js -> <pkg>
  try {
    return fs.existsSync(path.join(pkgDir, "esbuild.wasm")) && fs.existsSync(path.join(pkgDir, "wasm_exec.js"));
  } catch {
    return false;
  }
}

// Warn at most once per file so a drift (esbuild-wasm refactored the spawn block)
// is visible in the console instead of surfacing as a mysterious build hang.
const _driftWarned = new Set();
function warnDrift(filename) {
  if (_driftWarned.has(filename)) return;
  _driftWarned.add(filename);
  try {
    console.warn(
      "[OpenContainer] esbuild-wasm in-process patch did NOT apply to " +
        filename +
        ": the spawn block shape changed (version drift). esbuild may deadlock " +
        "under worker pools (Angular/Vite/Vitest/tsup). Update the ESB_INPROC_OLD " +
        "template in packages/runtime/esbuild-inproc-patch.js to match the new " +
        "esbuild-wasm lib/main.js.",
    );
  } catch {
    /* console may be unavailable in some worker contexts */
  }
}

/**
 * If `source` is esbuild-wasm's lib/main.js, return it rewritten to run the Go
 * service in-process; otherwise return null (leave the source untouched).
 * Idempotent: already-patched sources return null. If the file IS esbuild-wasm's
 * main.js but the known spawn block can't be found (version drift), it warns
 * loudly and returns null rather than deadlocking silently.
 */
export function maybePatchEsbuildInProcess(source, filename, fs, path) {
  if (typeof source !== "string" || source.length < 64) return null;
  if (source.includes(OC_MARKER)) return null; // already patched
  if (!isEsbuildWasmMain(filename, fs, path)) return null; // native esbuild — leave it
  const m = source.match(ESB_OLD_RE);
  if (!m) {
    warnDrift(filename);
    return null;
  }
  const version = m[1];
  const replacement = ESB_INPROC_NEW.replaceAll("%VER%", version);
  // Diagnostic: this process is about to host the resident esbuild Go wasm
  // service (~11 MB wasm + Go heap), a notable term in the memory readout.
  _inprocActive = true;
  // Function replacement: return the string verbatim so `$`-sequences in the
  // esbuild source (e.g. `${...}` template holes) are never treated as $-patterns.
  return source.replace(ESB_OLD_RE, () => replacement);
}

// True once this process has patched esbuild-wasm to run its Go service
// in-process (surfaced per-PID by the "Measure Memory" diagnostic).
let _inprocActive = false;
export function isEsbuildInprocActive() {
  return _inprocActive;
}
