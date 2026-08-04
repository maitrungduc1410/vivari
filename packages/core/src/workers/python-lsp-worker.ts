// @ts-nocheck — authored in TS for Vite's native worker bundling, but not strictly
// type-checked: it imports the untyped runtime driver and drives Pyodide's dynamic
// FS/proxy surface. esbuild (via Vite) is the compiler, as with fetcher-worker.ts.
//
// The Python Language Service Worker — one long-lived CPython, for the editor.
//
// WHY A WORKER OF ITS OWN, which is the design question this feature turns on.
// Every `python` command boots its own Pyodide inside a Process Worker and dies
// with it (builtins/python.js). Three things make that model wrong here:
//
//   - Lifetime. A language service has to outlive the edit that woke it. Tying it
//     to a process means a REPL exiting takes completion down with it, which the
//     user would read as the feature being broken rather than as a process ending.
//   - Visibility. An editor feature must not appear in the process table. Nobody
//     asked to run it, so nobody should have to see it, and nobody should be able
//     to kill it by tidying up their jobs.
//   - Isolation. jedi holds a warm parser cache that is most of why the second
//     keystroke is fast. Sharing an interpreter with user code would put that
//     cache one `sys.modules` mutation away from being wrong.
//
// So this is a nested Worker owned by the kernel worker, in the same category as
// fs-worker and fetcher-worker: created outside kernel.procs, never registered
// with createProcess, and therefore absent from `ps` and from diagnostics().
//
// AND IT IS LAZY. Pyodide is ~30 MB. Somebody editing a .ts file must not pay for
// it, so kernel-worker.ts does not create this worker at boot — it creates it on
// the first language request, which means on the first .py file opened. The
// `state` messages below are what lets the editor say "Python: starting…" instead
// of returning nothing for eight seconds and looking broken.

import {
  BLACK_PACKAGES,
  JEDI_PACKAGES,
  LSP_DRIVER_SOURCE,
  MYPY_PACKAGES,
  ruffMarkersFrom,
} from "../../../runtime/builtins/python-lsp.js";

// Progress goes to the host as `state` messages, never to stdout: this worker has
// no terminal, and Pyodide's default loader messages would otherwise be written
// into the interpreter's stdout stream and dropped on the floor. (The same
// routing bug, in the same loader, corrupted `pip freeze > requirements.txt`.)
const quiet = { messageCallback: () => {}, errorCallback: () => {} };

let pyodide = null;
let dispatch = null; // the _vv_lsp callable
let booting = null;
let blackLoaded = false;
let blackError = null;
let mypyLoaded = false;
let mypyError = null;
let ruff = null; // the ruff Workspace, once its wasm is in
let ruffError = null;

const post = (type, extra) => self.postMessage({ type, ...extra });
const errText = (e) => (e && e.message) || String(e);

/**
 * Boot once. Concurrent callers await the same promise rather than starting a
 * second interpreter — two 30 MB boots racing is the failure mode that turns a
 * slow feature into an out-of-memory one.
 */
function boot(indexUrl) {
  if (booting) return booting;
  booting = (async () => {
    post("state", { state: "starting" });
    const url = String(indexUrl || "").replace(/\/*$/, "/");
    // The vendored distribution, same as a python process uses. importScripts is
    // not available in a module worker, so import the ESM entry.
    const { loadPyodide } = await import(/* @vite-ignore */ url + "pyodide.mjs");
    const py = await loadPyodide({ indexURL: url });
    // jedi's default environment discovery runs sys.executable in a SUBPROCESS to
    // read its version, and Pyodide answers that with OSError(138). See the
    // InterpreterEnvironment note in builtins/python-lsp.js — this line only
    // matters because our own runtime sets sys.executable to "python".
    py.runPython('import sys; sys.executable = "python"');
    await py.loadPackage(JEDI_PACKAGES, quiet);
    py.runPython(LSP_DRIVER_SOURCE);
    pyodide = py;
    dispatch = py.globals.get("_vv_lsp");
    post("state", { state: "ready" });
    return py;
  })().catch((e) => {
    booting = null; // a failed boot must be retryable; the network may come back
    const message = errText(e);
    post("state", { state: "failed", detail: message });
    throw e;
  });
  return booting;
}

/**
 * black is loaded separately, and only when someone formats. It is four wheels
 * nobody editing a file needs until they press the key, and jedi is what makes
 * the editor feel alive.
 */
async function ensureBlack() {
  if (blackLoaded) return;
  if (blackError) throw new Error(blackError);
  try {
    await pyodide.loadPackage(BLACK_PACKAGES, quiet);
    blackLoaded = true;
  } catch (e) {
    // Remember the failure. Retrying four wheel fetches on every keystroke of a
    // format shortcut would be its own bug.
    blackError = errText(e);
    throw new Error(blackError);
  }
}

/**
 * mypy, on the same terms as black and for a stronger reason: it is the biggest
 * wheel the studio can pull, and it is only wanted once someone has written
 * enough to be worth checking. A failure is remembered rather than retried,
 * because the check runs on a timer and a retry loop would be a fetch per pause.
 */
async function ensureMypy() {
  if (mypyLoaded) return;
  if (mypyError) throw new Error(mypyError);
  try {
    await pyodide.loadPackage(MYPY_PACKAGES, quiet);
    mypyLoaded = true;
  } catch (e) {
    mypyError = errText(e);
    throw new Error(mypyError);
  }
}

/**
 * ruff, which is not Python and therefore not loaded like any of the above.
 *
 * It is a WebAssembly module of its own (scripts/vendor-ruff.mjs), so this needs
 * no interpreter, no wheel and no lock — and the caller below deliberately does
 * NOT boot Pyodide for a lint. That is the whole reason ruff is worth having in
 * the editor as well as at a prompt: opening a .py file puts its markers up in
 * the time it takes to fetch 11 MB, while the ~30 MB interpreter that answers
 * "is this a type error" is still starting.
 *
 * Its wasm is fetched with the browser's own fetch, not the blocking syscall the
 * `ruff` command uses: this worker is host code with a network of its own,
 * whereas that one is a guest process behind the kernel.
 */
async function ensureRuff(ruffUrl) {
  if (ruff) return ruff;
  if (ruffError) throw new Error(ruffError);
  try {
    if (!ruffUrl) throw new Error("no vendored ruff (VV_RUFF_URL is unset for this build)");
    const [mod, wasm] = await Promise.all([
      import(/* @vite-ignore */ ruffUrl + "ruff_wasm.js"),
      fetch(ruffUrl + "ruff_wasm_bg.wasm").then((r) => {
        if (!r.ok) throw new Error("fetching the ruff wasm returned HTTP " + r.status);
        return r.arrayBuffer();
      }),
    ]);
    await mod.default({ module_or_path: wasm });
    // Defaults, matching the command. A [tool.ruff] table is not read there and
    // is not read here either, and for the same reason — one place where the
    // editor and the prompt disagreeing would be worse than either behaviour.
    ruff = new mod.Workspace(mod.Workspace.defaultSettings());
    return ruff;
  } catch (e) {
    ruffError = errText(e);
    throw new Error(ruffError);
  }
}

/**
 * One lint. The mapping lives in the runtime module next to the provider that
 * consumes it (ruffMarkersFrom), so both spike tiers can check it without a
 * worker; this is only the call.
 */
function ruffLint(source) {
  return ruffMarkersFrom(ruff.check(source));
}

// ── the project mirror ───────────────────────────────────────────────────────
// jedi resolves `import helper` by looking at files, so the project has to exist
// in this interpreter's filesystem. The host sends contents; this worker writes
// them at the SAME absolute paths, so a definition jedi reports comes back as a
// path the editor can open without a translation table.
//
// Only what changed is sent (the kernel worker keeps the digests), because the
// alternative — re-sending the tree per keystroke — is the same cost as not
// caching at all.
function syncFiles(files, removed) {
  if (!pyodide) return;
  for (const path of removed || []) {
    try {
      pyodide.FS.unlink(path);
    } catch {
      /* already gone, which is the desired state */
    }
  }
  for (const [path, text] of files || []) {
    try {
      const slash = path.lastIndexOf("/");
      if (slash > 0) pyodide.FS.mkdirTree(path.slice(0, slash));
      pyodide.FS.writeFile(path, new TextEncoder().encode(text));
    } catch {
      /* one unwritable file must not fail the batch */
    }
  }
}

self.onmessage = async (event) => {
  const m = event.data;
  if (!m || typeof m !== "object") return;

  if (m.type === "py-lsp-sync") {
    // A sync can arrive before the first request, so make sure there is an
    // interpreter to sync INTO — but do not boot one just to copy files.
    if (pyodide) syncFiles(m.files, m.removed);
    return;
  }

  if (m.type !== "py-lsp-request") return;
  const { id, req, indexUrl, ruffUrl } = m;
  try {
    // Before the boot, on purpose: a lint must not be what drags 30 MB of
    // CPython in, and must not queue behind it once it is here.
    if (req.op === "lint") {
      await ensureRuff(ruffUrl);
      post("py-lsp-reply", { id, ok: true, result: ruffLint(req.code || "") });
      return;
    }
    if (!pyodide) await boot(indexUrl);
    syncFiles(m.files, m.removed);
    if (req.op === "format") await ensureBlack();
    if (req.op === "check") await ensureMypy();
    // One string in, one string out: a PyProxy per field would have to be
    // destroyed by hand, and a leak here would be per-keystroke.
    const answer = dispatch(JSON.stringify(req));
    post("py-lsp-reply", { id, ok: true, result: JSON.parse(answer) });
  } catch (e) {
    // Never an empty result dressed up as a successful one — the caller has to be
    // able to tell "jedi says there is nothing here" from "there is no jedi".
    post("py-lsp-reply", { id, ok: false, error: errText(e) });
  }
};