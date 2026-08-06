// A stand-in for Pyodide's runtime-environment detection, and the list of
// fragments it copies out of the real one.
//
// WHY A STAND-IN EXISTS AT ALL. The first thing `import(pyodide.mjs)` does is
// ask the realm what it is running on, and refuse to go on if it cannot tell:
//
//     Cannot determine runtime environment: {"IN_NODE":false,…,
//     "IN_BROWSER":true,"IN_BROWSER_MAIN_THREAD":false,
//     "IN_BROWSER_WEB_WORKER":false,…}
//
// which is what every `python` command printed once the guest-realm sweep
// started hiding `WorkerGlobalScope` — the name the worker branch identifies
// itself by. Nothing caught it, because the only interpreter the offline tier
// has is scripts/lib/fake-pyodide.mjs, which is handed to code that has already
// booted and so does no detection at all, and the tier that runs the real loader
// (spike-python-bridge.mjs) runs it in Node, where the answer is a different one.
// The detection is ~30 lines of ordinary JavaScript, though, so it can run
// against a swept realm with no interpreter anywhere. That is what this is for.
//
// WHAT MAKES THE MODEL WORTH ANYTHING. On its own, nothing: a test against a
// fixture we wrote is a test of our own opinion. So MODELLED_FRAGMENTS and
// ASM_FRAGMENTS name every piece of real Pyodide the stand-ins reproduce, and
// the two tiers check them from opposite ends — the same arrangement as
// scripts/lib/urllib3-emscripten.mjs, and for the same reason:
//
//   spike-python-offline.mjs — every fragment appears in the stand-in
//                              (the model has not drifted from the list)
//   spike-python-bridge.mjs  — every fragment appears in the REAL files, read
//                              out of the pyodide package the vendor script
//                              installs (the list has not drifted from Pyodide)
//
// Fail either and the pair stops meaning anything, so both are assertions.
// Captured from Pyodide 314.0.3: the loader's from src/js/environments.ts, which
// the published pyodide.mjs.map carries verbatim (the bundle itself is minified
// past recognition); Emscripten's from pyodide.asm.mjs, which ships as its own
// authority because no map is published for it.

// Whitespace-insensitive containment, plus the two pieces of TypeScript the
// loader's source has and a runnable copy cannot: `x as any` casts and return/
// parameter type annotations. Neither is what is being asserted, the expressions
// are. Applied to both sides of every comparison, so it can never make a real
// difference disappear.
export const normalize = (s) =>
  String(s)
    .replace(/\(([^()]+) as any\)/g, "$1")
    .replace(/:\s*(?:boolean|RuntimeEnv|BaseRuntimeEnv)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

// Verbatim from pyodide/src/js/environments.ts. IN_BROWSER_WEB_WORKER is the one
// this whole change is about: it is a CONSTRUCTOR-IDENTITY test, so it needs the
// `WorkerGlobalScope` binding itself to be visible on globalThis — `self` alone,
// which is all the sweep leaves behind, cannot answer it.
export const MODELLED_FRAGMENTS = [
  {
    label: "IN_NODE — the probe process.browser masks",
    source: `const IN_NODE =
    typeof process === "object" &&
    typeof process.versions === "object" &&
    typeof process.versions.node === "string" &&
    !(process as any).browser;`,
  },

  {
    label: "IN_BROWSER",
    source: `const IN_BROWSER = !base.IN_NODE && !base.IN_DENO && !base.IN_BUN;`,
  },

  {
    label: "IN_BROWSER_MAIN_THREAD — false in any worker, swept or not",
    source: `const IN_BROWSER_MAIN_THREAD =
    IN_BROWSER &&
    typeof window !== "undefined" &&
    typeof (window as any).document !== "undefined" &&
    typeof (document as any).createElement === "function" &&
    "sessionStorage" in (window as any) &&
    typeof (globalThis as any).importScripts !== "function";`,
  },

  {
    label: "IN_BROWSER_WEB_WORKER — the constructor-identity test the sweep broke",
    source: `const IN_BROWSER_WEB_WORKER =
    IN_BROWSER &&
    typeof (globalThis as any).WorkerGlobalScope !== "undefined" &&
    typeof (globalThis as any).self !== "undefined" &&
    (globalThis as any).self instanceof (globalThis as any).WorkerGlobalScope;`,
  },

  // Reached only once IN_BROWSER_WEB_WORKER is true, i.e. only after the fix —
  // so the fix put a probe in the path that was not being executed before, and
  // it is a probe that runs a call the sweep has shadowed away.
  {
    label: "the isClassicWorker() gate the worker branch runs into",
    source: `if (IN_BROWSER_WEB_WORKER && isClassicWorker()) {
    throw new Error("Classic web workers are not supported");
  }`,
  },

  {
    label: "isClassicWorker() — a throw means 'not classic'",
    source: `function isClassicWorker(): boolean {
  try {
    // Check if importScripts throws. importScripts only available in the classic web worker.
    // This check might give false positive when no-unsafe-eval is enabled, but better than having nothing
    (globalThis as any).importScripts("data:text/javascript,");
    return true;
  } catch (e) {
    return false;
  }
}`,
  },

  {
    label: "the refusal itself",
    source: `if (
    !(
      env.IN_BROWSER_MAIN_THREAD ||
      env.IN_BROWSER_WEB_WORKER ||
      env.IN_NODE ||
      env.IN_SHELL ||
      env.IN_WORKERD
    )
  ) {
    throw new Error(
      \`Cannot determine runtime environment: \${JSON.stringify(env)}\`,
    );
  }`,
  },
];

// The four lines Emscripten opens _createPyodideModule() with, verbatim from the
// minified pyodide.asm.mjs (there is no published map for it). This is the wall
// two lines behind the first one: with WEB, WORKER and NODE all false it settles
// on SHELL and reaches for a `read()` that exists in d8 and nowhere else.
export const ASM_FRAGMENTS = [
  { label: "ENVIRONMENT_IS_WEB", source: `var ENVIRONMENT_IS_WEB=!!globalThis.window;` },
  { label: "ENVIRONMENT_IS_WORKER — the same binding again", source: `var ENVIRONMENT_IS_WORKER=!!globalThis.WorkerGlobalScope;` },
  { label: "ENVIRONMENT_IS_NODE — the probe process.type masks", source: `var ENVIRONMENT_IS_NODE=globalThis.process?.versions?.node&&globalThis.process?.type!="renderer";` },
  { label: "ENVIRONMENT_IS_SHELL — what a fully swept realm falls through to", source: `var ENVIRONMENT_IS_SHELL=!ENVIRONMENT_IS_WEB&&!ENVIRONMENT_IS_NODE&&!ENVIRONMENT_IS_WORKER;` },
];

// The loader's detection, de-TypeScripted and nothing else. Every expression
// above appears here as it appears there, which is why it is a source string run
// through `new Function` rather than exported functions: the globals it reads
// have to be bound to the realm under test, and rewriting `globalThis.self` into
// `scope.self` would be exactly the drift the fragment list exists to prevent.
export const STANDIN = `
function getGlobalRuntimeEnv() {
  if (typeof API !== "undefined" && API !== globalThis.API) {
    return API.runtimeEnv;
  }
  const IN_BUN = typeof Bun !== "undefined";
  const IN_DENO = typeof Deno !== "undefined";
  const IN_NODE =
    typeof process === "object" &&
    typeof process.versions === "object" &&
    typeof process.versions.node === "string" &&
    !process.browser;
  const IN_SAFARI =
    typeof navigator === "object" &&
    typeof navigator.userAgent === "string" &&
    navigator.userAgent.indexOf("Chrome") === -1 &&
    navigator.userAgent.indexOf("Safari") > -1;
  const IN_SHELL = typeof read === "function" && typeof load === "function";
  const IN_WORKERD =
    typeof navigator === "object" &&
    navigator.userAgent?.includes("Cloudflare-Workers");
  return calculateDerivedFlags({
    IN_BUN,
    IN_DENO,
    IN_NODE,
    IN_SAFARI,
    IN_SHELL,
    IN_WORKERD,
  });
}

function calculateDerivedFlags(base) {
  const IN_NODE_COMMONJS =
    base.IN_NODE &&
    typeof module !== "undefined" &&
    module.exports &&
    typeof require === "function" &&
    typeof __dirname === "string";

  const IN_NODE_ESM = base.IN_NODE && !IN_NODE_COMMONJS;
  const IN_BROWSER = !base.IN_NODE && !base.IN_DENO && !base.IN_BUN;
  const IN_BROWSER_MAIN_THREAD =
    IN_BROWSER &&
    typeof window !== "undefined" &&
    typeof window.document !== "undefined" &&
    typeof document.createElement === "function" &&
    "sessionStorage" in window &&
    typeof globalThis.importScripts !== "function";
  const IN_BROWSER_WEB_WORKER =
    IN_BROWSER &&
    typeof globalThis.WorkerGlobalScope !== "undefined" &&
    typeof globalThis.self !== "undefined" &&
    globalThis.self instanceof globalThis.WorkerGlobalScope;

  if (IN_BROWSER_WEB_WORKER && isClassicWorker()) {
    throw new Error("Classic web workers are not supported");
  }

  const env = {
    ...base,
    IN_BROWSER,
    IN_BROWSER_MAIN_THREAD,
    IN_BROWSER_WEB_WORKER,
    IN_NODE_COMMONJS,
    IN_NODE_ESM,
  };

  if (
    !(
      env.IN_BROWSER_MAIN_THREAD ||
      env.IN_BROWSER_WEB_WORKER ||
      env.IN_NODE ||
      env.IN_SHELL ||
      env.IN_WORKERD
    )
  ) {
    throw new Error(
      \`Cannot determine runtime environment: \${JSON.stringify(env)}\`,
    );
  }

  return env;
}

function isClassicWorker() {
  try {
    // Check if importScripts throws. importScripts only available in the classic web worker.
    // This check might give false positive when no-unsafe-eval is enabled, but better than having nothing
    globalThis.importScripts("data:text/javascript,");
    return true;
  } catch (e) {
    return false;
  }
}

return getGlobalRuntimeEnv();
`;

// Emscripten's, same treatment. It runs at the top of _createPyodideModule(),
// i.e. inside loadPyodide() rather than at module-eval time — which is why the
// boot mask has to be held across both and not just across the import.
export const ASM_STANDIN = `
var ENVIRONMENT_IS_WEB=!!globalThis.window;
var ENVIRONMENT_IS_WORKER=!!globalThis.WorkerGlobalScope;
var ENVIRONMENT_IS_NODE=globalThis.process?.versions?.node&&globalThis.process?.type!="renderer";
var ENVIRONMENT_IS_SHELL=!ENVIRONMENT_IS_WEB&&!ENVIRONMENT_IS_NODE&&!ENVIRONMENT_IS_WORKER;
return { ENVIRONMENT_IS_WEB, ENVIRONMENT_IS_WORKER, ENVIRONMENT_IS_NODE: !!ENVIRONMENT_IS_NODE, ENVIRONMENT_IS_SHELL };
`;

// Every free name the two models read, bound to the realm under test. A bare
// `window` in a swept realm is an own property holding `undefined`, so it has to
// arrive as an undefined ARGUMENT and not as a missing one — a `new Function`
// body would otherwise resolve it against the harness's own global and see
// Node's answers instead of the guest's.
const FREE_NAMES = [
  "globalThis", "self", "window", "document", "process", "navigator",
  "Bun", "Deno", "API", "read", "load", "module", "require", "__dirname",
];

function runInRealm(source, scope) {
  const fn = new Function(...FREE_NAMES, source);
  return fn(...FREE_NAMES.map((name) => (name === "globalThis" ? scope : scope[name])));
}

/** Pyodide's own RUNTIME_ENV, as pyodide.mjs would compute it in `scope`. */
export function detectRuntimeEnv(scope) {
  return runInRealm(STANDIN, scope);
}

/** Emscripten's four flags, as pyodide.asm.mjs would compute them in `scope`. */
export function detectEmscriptenEnv(scope) {
  return runInRealm(ASM_STANDIN, scope);
}