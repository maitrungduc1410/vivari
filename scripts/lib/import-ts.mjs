// Import a TypeScript module from a build script, on every Node this repo admits.
//
// Node's type stripping has four regimes and the difference between the first
// two is what shipped a broken `npm run dev`:
//
//   >= 22.18.0    stripping is ON BY DEFAULT. A plain `import()` of a .ts works
//                 and no hook is installed.
//   22.15-22.17   stripping exists but only behind --experimental-strip-types.
//                 `module.registerHooks` (22.15.0) plus `module.stripTypeScriptTypes`
//                 (22.13.0) do the same job from inside the process, which is the
//                 fallback below — real modules, live bindings, no subprocess.
//   22.6-22.14    the flag exists, the hook API does not. There is nothing this
//                 module can do from in-process, so the error names the flag.
//   < 22.6        no stripping at all, flagged or otherwise. Upgrade.
//
// Sources, because a wrong version number here is the whole bug: type stripping
// was added flagged in 22.6.0 and became default-on in 22.18.0
// (nodejs.org/docs/latest-v22.x/api/typescript.html); `registerHooks` and
// `stripTypeScriptTypes` are dated in .../api/module.html.
//
// PROBE FIRST, THEN IMPORT ONCE — and that order is the entire correctness
// argument, not a style preference.
//
// The version of this file that shipped did the obvious thing instead: import
// the real file, and if it failed with ERR_UNKNOWN_FILE_EXTENSION, install the
// hook and import it AGAIN. That works on 22.23 and does not work on 22.16,
// which is the Node it was written for. Measured on both, same script:
//
//                                        22.16.0    22.23.2 --no-experimental-strip-types
//   first import of a .ts, no hook       fails      fails
//   RETRY the same specifier, hooked     FAILS      ok
//   a DIFFERENT .ts, hooked              ok         ok
//
// On 22.16 the loader remembers the failure against the specifier, so the one
// file you actually wanted is the one file you can no longer load. Both regimes
// agree on every other line of that table, which is exactly why the bug survived
// three rounds of review: everyone verified against `--no-experimental-strip-types`
// on a modern Node, and that flag is NOT an old Node. It turns default stripping
// off and leaves 22.23's loader machinery in place, including the part that
// differs here.
//
// So capability is settled on a throwaway file, and the caller's specifier is
// imported exactly once, after the answer is known — on a path that has never
// failed and therefore has nothing memoised against it.
//
// Rejected: a cache-busting `?v=n` query on the retry. It does work on 22.16
// once the hook's guard is fixed to look at the pathname (measured — the query
// hid the `.ts` from an `endsWith` check, which is why it first appeared not to),
// but each distinct query is a distinct module instance. A file imported both
// plainly and busted evaluates TWICE, so module-scope side effects run twice and
// `TEMPLATES` from one is not `TEMPLATES` from the other. Paying that to rescue
// a retry that only exists because the probe was skipped is the wrong trade.

import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const STRIP_DEFAULT_FROM = "22.18.0";
export const STRIP_HOOKS_FROM = "22.15.0";
export const STRIP_FLAG_FROM = "22.6.0";

// The one-shot capability decision, memoised as a PROMISE so that concurrent
// callers share the single probe rather than racing two of them. A rejection is
// memoised too: this Node will not start stripping types halfway through a run.
let ready = null;

/**
 * Can this process import a .ts file and get a working module out of it?
 *
 * A fresh scratch file every call, because the whole point is to learn the
 * answer without spending the caller's specifier on it — and because the second
 * call has to be a file the first call did not already fail against.
 *
 * `{"type":"module"}` beside it: a .ts takes its module system from the same
 * rules as a .js, and the nearest package.json above a tmpdir is nobody's
 * business. Without it the probe can fail as CommonJS-vs-ESM and be read as
 * "this Node cannot strip types".
 *
 * The success test is the exported VALUE, not the absence of a throw. That is
 * what makes the post-install check behavioural: a `registerHooks` that accepts
 * the registration and does nothing passes any `typeof` test and fails this one.
 */
async function probeStripping() {
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-import-ts-"));
    fs.writeFileSync(path.join(dir, "package.json"), '{"type":"module"}');
    fs.writeFileSync(path.join(dir, "probe.ts"), "export const stripped: number = 1;\n");
  } catch (err) {
    // No writable tmpdir. Nothing here can work, and saying "this Node cannot
    // strip types" would be a lie; `null` means "unknown" and the caller
    // proceeds as if stripping were ambient, which is right on >= 22.18 and no
    // worse than the behaviour this module replaced anywhere else.
    if (dir) rmDir(dir);
    return { ok: null, err };
  }
  try {
    const mod = await import(pathToFileURL(path.join(dir, "probe.ts")).href);
    return { ok: mod.stripped === 1, err: null };
  } catch (err) {
    return { ok: false, err };
  } finally {
    rmDir(dir);
  }
}

function rmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // A leaked temp dir is not worth failing a build over.
  }
}

function installStripHook() {
  // Belt-and-braces: the `stripTypeScriptTypes` call below is the real
  // capability test, so deleting this `typeof` pair changes no observable
  // behaviour (a known-equivalent mutant, recorded in the spike). It stays
  // because reaching the probe requires `registerHooks` to exist too, and
  // reading that as an intentional precondition is cheaper than rediscovering it.
  if (typeof module.registerHooks !== "function" || typeof module.stripTypeScriptTypes !== "function") {
    return false;
  }
  // `stripTypeScriptTypes` emits a one-time ExperimentalWarning naming an API
  // the contributor never called, on a path they did not choose. Spend that one
  // warning here, with the emitter muted, so the only thing they read about any
  // of this is the notice below — which says what to do about it. Safe because
  // the call is synchronous: nothing else can observe the muted emitter in
  // between, and the restore is in `finally`.
  const realEmitWarning = process.emitWarning;
  process.emitWarning = () => {};
  try {
    module.stripTypeScriptTypes("const _probe: number = 0;");
  } catch {
    return false;
  } finally {
    process.emitWarning = realEmitWarning;
  }
  module.registerHooks({
    load(url, context, nextLoad) {
      if (!url.startsWith("file:")) return nextLoad(url, context);
      const u = new URL(url);
      // `u.pathname`, not `url`, because a specifier may carry a query and
      // `"…/a.ts?v=1".endsWith(".ts")` is false — the hook then passes the file
      // to a loader that cannot read it, which is how the cache-busting variant
      // above first appeared to be impossible. Stripping is a no-op on plain JS,
      // so a missing guard would not fail loudly; it would mangle a JSON or
      // CommonJS import much later.
      if (!u.pathname.endsWith(".ts")) return nextLoad(url, context);
      u.search = "";
      u.hash = "";
      const source = module.stripTypeScriptTypes(fs.readFileSync(fileURLToPath(u), "utf8"), {
        mode: "strip",
        sourceUrl: url,
      });
      return { format: "module", source, shortCircuit: true };
    },
  });
  return true;
}

async function decideStrategy() {
  const ambient = await probeStripping();
  if (ambient.ok !== false) return; // works, or unknowable — either way, import plainly.

  if (!installStripHook()) {
    throw cannotStrip(
      `it neither strips TypeScript types by default (${STRIP_DEFAULT_FROM}+ does) nor exposes ` +
        `the in-process stripper (${STRIP_HOOKS_FROM}+ does)`,
      ambient.err,
    );
  }
  // The hook is registered; that is not the same as the hook working. Prove it
  // on a SECOND fresh file before any caller's specifier is spent.
  const hooked = await probeStripping();
  if (hooked.ok !== true) {
    throw cannotStrip(
      "the in-process stripper registered but a scratch .ts still would not import",
      hooked.err ?? ambient.err,
    );
  }
  // One line, on stderr, once per process — `decideStrategy` runs once, so no
  // separate flag is needed to make that true. The alternative is a contributor
  // silently paying for a stripper they could remove by upgrading.
  process.stderr.write(
    `  [import-ts] Node ${process.versions.node} does not strip TypeScript types by default; ` +
      `using the in-process stripper. Node ${STRIP_DEFAULT_FROM}+ does not need it.\n`,
  );
}

/**
 * `import()` for a .ts file, with an in-process stripper behind it on the Node
 * versions that need one.
 *
 * Returns the real module namespace, so exported functions and live bindings
 * survive — which is why this is a loader hook and not a subprocess handing back
 * JSON.
 *
 * The import below is the FIRST and ONLY attempt at `absPath`: everything that
 * could fail for a reason to do with this Node has already failed on a scratch
 * file. So an error out of here is about the file — a syntax error, a throw at
 * module scope, a TypeScript feature the stripper refuses — and is left
 * untouched for the caller to diagnose.
 */
export async function importTs(absPath) {
  ready ??= decideStrategy();
  await ready;
  return import(pathToFileURL(absPath).href);
}

function cannotStrip(what, cause) {
  return Object.assign(
    new Error(
      `cannot import TypeScript sources on Node ${process.versions.node}: ${what}. Either re-run ` +
        `with NODE_OPTIONS=--experimental-strip-types (works from ${STRIP_FLAG_FROM}), ` +
        `or upgrade to Node ${STRIP_DEFAULT_FROM}+.`,
    ),
    { code: "ERR_NODE_CANNOT_STRIP_TYPES", cause },
  );
}
