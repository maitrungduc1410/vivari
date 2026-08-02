// A synchronous CommonJS module system — the whole reason brick #1 exists.
//
// `require()` is inherently synchronous in Node: it reads the file, compiles it,
// and returns `module.exports` right away. We can only do that in the browser
// because reads go through the sync bridge (Atomics.wait). Resolution follows
// Node's algorithm: core builtins, relative/absolute paths (with .js/.json and
// directory/index/package.json "main"), and bare specifiers walked up through
// node_modules.

import { transpileEsm, transpileEsmLive, rewriteCjsDynamicImport } from "./esm.js";
import { maybePatchEsbuildInProcess } from "./esbuild-inproc-patch.js";
import { maybeTranspileTypeScript } from "./typescript-transform.js";
// The native-addon message. It is in builtins/ next to the rest of the
// "impossible in a browser, here is what to use instead" catalogue, and that file
// imports nothing, so the loader pays only for the strings.
import { nativeAddonError } from "./builtins/bun-unsupported.js";

// The constructor for `async function () {}` — used to (re)compile an ESM module
// that uses top-level await (our normal wrapper is a plain, non-async function).
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
// Our module compiler must always use the NATIVE Function constructor. The
// runtime later wraps the *global* Function (to redirect dynamic import() in
// escape-hatch bodies like piscina's `new Function('s','return import(s)')`);
// module wrappers already have their imports rewritten, so routing them through
// that wrapper would only re-lex every module for nothing. Captured at import
// time, before the global is wrapped.
const RealFunction = Function;

// Pure: given a bin file's source, return the .js/.cjs/.mjs target token that a
// shell cmd-shim `exec`s (with pnpm's `$basedir` left un-expanded), or null when
// it isn't an unwrappable shell shim — a real `#!/usr/bin/env node` bin, a
// non-shell shebang, or no `.js` exec target. pnpm (and npm-on-Windows) install a
// package's bin as such a `#!/bin/sh` wrapper instead of the POSIX symlink npm
// uses; our loader can't run shell, so runMain unwraps it to the .js it runs.
// Exported for the offline unit test (scripts/spike-cmd-shim.mjs).
export function parseShellShimTarget(source) {
  if (typeof source !== "string" || !source.startsWith("#!")) return null;
  const nl = source.indexOf("\n");
  const shebang = source.slice(0, nl < 0 ? source.length : nl);
  if (/\bnode\b/.test(shebang)) return null; // real node bin — compile it as JS
  if (!/\b(sh|bash|dash)\b/.test(shebang)) return null; // only shell wrappers
  const m =
    source.match(/exec\s+(?:"[^"]*"|\S+)\s+"?([^"\s]+\.[cm]?js)"?/) ||
    source.match(/"?(\$basedir\/[^"\s]+\.[cm]?js)"?/);
  return (m && m[1]) || null;
}

export function createModuleSystem({ fs, path, builtins, process, globals, nodeModules }) {
  const cache = Object.create(null);
  // The entry module (Node's `require.main` / `process.mainModule`). Set by
  // runMain; every require's `require.main` points at it.
  let mainModule = undefined;
  // Check the LIVE builtins object, not a snapshot: index.js finishes wiring it
  // (adds `module`, then every `node:`-prefixed alias) AFTER this system is
  // constructed, so a Set captured here would miss `node:module`/`node:fs`/... .
  const hasBuiltin = (request) => Object.prototype.hasOwnProperty.call(builtins, request);
  // Vendored modules the loader can serve lazily (e.g. `semver`) without eagerly
  // instantiating them for every process — resolved only when actually required.
  const hasLazyBuiltin = (request) => !!nodeModules && nodeModules.has(request);
  // A wasm N-API addon ships a matched set: the binding, the @napi-rs/wasm-runtime
  // host and the @emnapi/* halves are built together, and the bridge between the
  // host and emnapi is a private ABI, not a public API. We vendor only the host
  // (at 0.2.x, patched for our cooperative loop) and it normally wins as a
  // builtin — which silently mismatches any addon that brings a newer emnapi.
  // emnapi 2 is the break: its NodeEnv calls bridge.setLastError/deleteEnv, which
  // the 0.2.x bundle has never heard of, so the addon dies in instantiate. That is
  // every Vite 8 project, via rolldown >= 1.2.1.
  //
  // So hand an emnapi-2 addon the copy it installed, which is self-consistent by
  // construction, and leave everything else on the vendored host: emnapi-1 addons
  // (rspack, tailwind's oxide) are proven against it by their spikes, and their
  // newer hosts don't work here anyway — the threaded path hangs where the
  // vendored one takes the sync route.
  const emnapiMajor = (fromDir) => {
    for (const nm of nodeModulesPaths(fromDir)) {
      const pkg = readPkg(path.join(nm, "@emnapi/runtime"));
      const major = pkg && typeof pkg.version === "string" ? parseInt(pkg.version, 10) : NaN;
      if (!Number.isNaN(major)) return major;
    }
    return 0;
  };

  function Module(id) {
    this.id = id;
    this.filename = id;
    this.exports = {};
    this.loaded = false;
    this.children = [];
    // Node exposes the module's node_modules lookup paths here. Real tools read it
    // — e.g. @nestjs/cli's getModulePaths() does `module.paths.slice(...)` to build
    // the `paths` for require.resolve('typescript', {paths}); a missing array threw
    // and surfaced as "TypeScript could not be found". Filled in load().
    this.paths = [];
  }

  const isFile = (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  // Resolution order: JS/JSON first (so a compiled `.js` shadows its `.ts` source
  // when both exist — matching tsc/Node output layouts), then the TS/JSX
  // extensions Bun resolves natively. TS files are transpiled at compile() time.
  const EXTS = [".js", ".mjs", ".cjs", ".json", ".ts", ".tsx", ".mts", ".cts", ".jsx"];
  const tryExtensions = (p) => {
    if (isFile(p)) return p;
    for (const ext of EXTS) if (isFile(p + ext)) return p + ext;
    return null;
  };

  const loadIndex = (dir) => {
    for (const ext of EXTS) {
      const f = path.join(dir, "index" + ext);
      if (isFile(f)) return f;
    }
    return null;
  };

  const readPkg = (dir) => {
    const p = path.join(dir, "package.json");
    if (!isFile(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };

  // package.json "exports"/"imports" condition resolution. Everything in this
  // runtime is loaded through require() (ESM is transpiled to CJS at load), so we
  // resolve like Node's require(): "node"/"require" first, then "default", and
  // only fall to "import" last. Putting "default" ahead of "import" matters for
  // dual packages that omit a "require" key but ship a CJS "default" (e.g.
  // tslib: { module, import: <esm>, default: <cjs> }) — require() must land on
  // the CJS default, not the ESM import.
  const EXPORT_CONDITIONS = ["node", "require", "default", "import"];
  function pickCondition(val) {
    if (typeof val === "string") return val;
    if (Array.isArray(val)) {
      for (const v of val) {
        const r = pickCondition(v);
        if (r) return r;
      }
      return null;
    }
    if (val && typeof val === "object") {
      for (const c of EXPORT_CONDITIONS) {
        if (Object.prototype.hasOwnProperty.call(val, c)) {
          const r = pickCondition(val[c]);
          if (r) return r;
        }
      }
    }
    return null;
  }

  function resolveExports(pkgDir, exportsField, sub) {
    let target = null;
    if (typeof exportsField === "string" || Array.isArray(exportsField)) {
      target = sub === "." ? pickCondition(exportsField) : null;
    } else if (exportsField && typeof exportsField === "object") {
      const keys = Object.keys(exportsField);
      const isSubpathMap = keys.some((k) => k.startsWith("."));
      if (isSubpathMap) {
        if (Object.prototype.hasOwnProperty.call(exportsField, sub)) {
          target = pickCondition(exportsField[sub]);
        } else {
          for (const k of keys) {
            if (k.endsWith("/*")) {
              const pre = k.slice(0, -1);
              if (sub.startsWith(pre)) {
                const t = pickCondition(exportsField[k]);
                if (t) {
                  target = t.replace("*", sub.slice(pre.length));
                  break;
                }
              }
            }
          }
        }
      } else {
        target = sub === "." ? pickCondition(exportsField) : null;
      }
    }
    if (!target) return null;
    const full = path.join(pkgDir, target);
    return tryExtensions(full) || (isFile(full) && full) || null;
  }

  function splitBare(request) {
    const parts = request.split("/");
    let name;
    let rest;
    if (request[0] === "@") {
      name = parts.slice(0, 2).join("/");
      rest = parts.slice(2);
    } else {
      name = parts[0];
      rest = parts.slice(1);
    }
    return { name, sub: rest.length ? "./" + rest.join("/") : "." };
  }

  function loadAsDirectory(dir) {
    const pkg = readPkg(dir);
    if (pkg) {
      if (pkg.exports) {
        const r = resolveExports(dir, pkg.exports, ".");
        if (r) return r;
      }
      const main = pkg.main || (pkg.module && typeof pkg.module === "string" ? pkg.module : null);
      if (main) {
        const target = path.join(dir, main);
        const resolved = tryExtensions(target) || loadIndex(target);
        if (resolved) return resolved;
      }
    }
    return loadIndex(dir);
  }

  function nodeModulesPaths(fromDir) {
    const dirs = [];
    let cur = fromDir;
    for (;;) {
      if (path.basename(cur) !== "node_modules") dirs.push(path.join(cur, "node_modules"));
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return dirs;
  }

  // package.json "imports" (subpath imports, specifiers starting with '#'). They
  // resolve against the package scope (nearest package.json) of the importing
  // file, honouring the same conditions as "exports". Targets may be relative
  // paths or bare specifiers (which resolve normally). Used e.g. by Vite's
  // `#module-sync-enabled` -> ./misc/{true,false}.js condition switch.
  function resolveImports(request, fromDir) {
    let cur = fromDir;
    for (;;) {
      const pkg = readPkg(cur);
      if (pkg) {
        if (pkg.imports && typeof pkg.imports === "object") {
          let target = null;
          if (Object.prototype.hasOwnProperty.call(pkg.imports, request)) {
            target = pickCondition(pkg.imports[request]);
          } else {
            for (const k of Object.keys(pkg.imports)) {
              if (k.endsWith("/*")) {
                const pre = k.slice(0, -1);
                if (request.startsWith(pre)) {
                  const t = pickCondition(pkg.imports[k]);
                  if (t) {
                    target = t.replace("*", request.slice(pre.length));
                    break;
                  }
                }
              }
            }
          }
          if (target) {
            if (target.startsWith("./") || target.startsWith("../") || target.startsWith("/")) {
              const full = path.resolve(cur, target);
              const r = tryExtensions(full) || (isFile(full) ? full : null);
              if (r) return r;
            } else {
              return resolveFilename(target, cur).id; // bare specifier target
            }
          }
        }
        break; // stop at the first (nearest) package scope, like Node
      }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    return null;
  }

  // Normalize a file:// module specifier to a plain VFS path. Dynamic `import()`
  // is routinely called with a file:// URL plus a cache-busting query/hash —
  // Vite's native/runner config loaders do `import(pathToFileURL(cfg)+'?t='+now)`
  // and its module runner imports `file://.../dist/node/index.js`. Only file://
  // specifiers are touched: bare specifiers, relative paths, and package.json
  // subpath imports (`#foo`) must pass through verbatim (a `#` is NOT a URL hash).
  function fromFileUrl(request) {
    let r = request.slice("file://".length);
    try { r = decodeURIComponent(r); } catch { /* leave as-is */ }
    const h = r.indexOf("#");
    if (h >= 0) r = r.slice(0, h);
    const q = r.indexOf("?");
    if (q >= 0) r = r.slice(0, q);
    return r;
  }

  function resolveFilename(request, fromDir) {
    if (request.startsWith("file://")) request = fromFileUrl(request);
    const overridable = request === "@napi-rs/wasm-runtime" && emnapiMajor(fromDir) >= 2;
    if (!overridable) {
      if (hasBuiltin(request)) return { builtin: true, id: request };
      if (hasLazyBuiltin(request)) return { builtin: true, id: request };
    }

    if (request[0] === "#") {
      const r = resolveImports(request, fromDir);
      if (r) return { builtin: false, id: r };
      const err = new Error(`Cannot find package import '${request}' from '${fromDir}'`);
      err.code = "MODULE_NOT_FOUND";
      throw err;
    }

    let resolved = null;
    // Node treats "." and ".." (bare, no slash) as relative too — e.g.
    // `require('.')` loads the current directory's index/main. They don't match a
    // startsWith('./') check, so handle them explicitly or they'd fall through to
    // the node_modules branch and look for a package literally named "." (npm's
    // @sigstore/tuf does `require('.')`).
    if (
      request === "." ||
      request === ".." ||
      request.startsWith("/") ||
      request.startsWith("./") ||
      request.startsWith("../")
    ) {
      const base = path.resolve(fromDir, request);
      resolved = tryExtensions(base) || loadAsDirectory(base);
    } else {
      const { name, sub } = splitBare(request);
      for (const nm of nodeModulesPaths(fromDir)) {
        const pkgDir = path.join(nm, name);
        const pkg = readPkg(pkgDir);
        if (pkg && pkg.exports) {
          const r = resolveExports(pkgDir, pkg.exports, sub);
          if (r) {
            resolved = r;
            break;
          }
        }
        const base = sub === "." ? pkgDir : path.join(pkgDir, sub.slice(2));
        resolved = tryExtensions(base) || loadAsDirectory(base);
        if (resolved) break;
      }
    }

    if (!resolved) {
      // Nothing installed — fall back to the vendored copy.
      if (overridable && (hasBuiltin(request) || hasLazyBuiltin(request)))
        return { builtin: true, id: request };
      const err = new Error(`Cannot find module '${request}' from '${fromDir}'`);
      err.code = "MODULE_NOT_FOUND";
      throw err;
    }
    return { builtin: false, id: resolved };
  }

  // Node resolves a module's path through symlinks to its realpath by default
  // (preserveSymlinks=false), so `__dirname` / `import.meta.url` / relative
  // requires resolve from the file's REAL location. This matters for
  // node_modules/.bin shims: `.bin/vite` is a symlink to `../vite/bin/vite.js`,
  // and the bin does `import('../dist/node/cli.js')` — which only resolves if the
  // entry's dirname is `vite/bin`, not `.bin`. Fall back to the given path if the
  // fs has no realpath or the path doesn't exist.
  const realpath = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  };

  function makeRequire(fromDir) {
    // Route through Module._load / Module._resolveFilename (rather than calling
    // `load`/`resolveFilename` directly) so tools that monkey-patch those seams
    // — ts-node, tsx, jest, proxyquire, module-alias — actually intercept every
    // require, exactly as they do in Node.
    const parent = { filename: path.join(fromDir, "__oc_require__") };
    const require = (request) => Module._load(request, parent, false);
    // Honor require.resolve(request, { paths: [...] }) — Node resolves as if
    // required from each given dir, in order (used by @nestjs/cli to find the
    // project's typescript). Falls back to this module's own dir.
    require.resolve = (request, options) => Module._resolveFilename(request, parent, false, options);
    require.cache = cache;
    // Live view of the entry module: it's set during runMain AFTER the entry
    // begins compiling, so a static snapshot here would read undefined for the
    // very module that needs `require.main === module` to be true.
    Object.defineProperty(require, "main", { configurable: true, enumerable: true, get: () => mainModule });
    require.extensions = Module._extensions;
    return require;
  }

  function load(request, fromDir) {
    const r = resolveFilename(request, fromDir);
    if (r.builtin) {
      if (Object.prototype.hasOwnProperty.call(builtins, r.id)) return builtins[r.id];
      return nodeModules.require(r.id); // lazy vendored module (loader-cached)
    }

    const filename = realpath(r.id); // canonicalize symlinks (see realpath above)
    if (cache[filename]) return cache[filename].exports;

    const module = new Module(filename);
    module.paths = nodeModulesPaths(path.dirname(filename));
    cache[filename] = module;
    let ok = false;
    try {
      compile(module, filename);
      ok = true;
    } finally {
      if (!ok) delete cache[filename];
    }
    module.loaded = true;
    return module.exports;
  }

  // JSX lowering options for a given file: honor the nearest tsconfig.json's
  // `compilerOptions.jsxFactory` / `jsxFragmentFactory` (cached per directory),
  // defaulting to the classic React pragma. tsconfig may be JSONC, so a failed
  // strict parse falls back to a light comment strip.
  const _jsxCfgCache = new Map();
  function jsxOptionsFor(filename) {
    let dir = path.dirname(filename);
    for (;;) {
      if (_jsxCfgCache.has(dir)) {
        const cached = _jsxCfgCache.get(dir);
        if (cached) return cached;
      } else {
        let opt = null;
        const tc = path.join(dir, "tsconfig.json");
        try {
          if (isFile(tc)) {
            const raw = fs.readFileSync(tc, "utf8");
            let json;
            try { json = JSON.parse(raw); }
            catch { json = JSON.parse(raw.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "")); }
            const co = (json && json.compilerOptions) || {};
            if (co.jsxFactory || co.jsxFragmentFactory) {
              opt = {
                jsxPragma: co.jsxFactory || "React.createElement",
                jsxFragment: co.jsxFragmentFactory || "React.Fragment",
              };
            } else {
              opt = {};
            }
          }
        } catch {
          opt = null;
        }
        _jsxCfgCache.set(dir, opt);
        if (opt && (opt.jsxPragma || opt.jsxFragment)) return opt;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return undefined;
  }

  function compile(module, filename, providedSource) {
    // A `.node` file is a compiled native addon — machine code, not JavaScript.
    // The check has to be HERE, at the top of compile(), and not only on
    // Module._extensions['.node']: `load()` calls compile() directly, so the
    // extension table is consulted by tools that reach for it but never by our own
    // require path. Without this, the read below pulled the binary in as UTF-8
    // text and the wrapper compile reported `SyntaxError: Invalid or unexpected
    // token` — a parse error about a file that was never source, naming a `.node`
    // path most people have never heard of, on the most common hard failure a real
    // Node project meets in the browser. See builtins/bun-unsupported.js for the
    // message and the substitution map it carries.
    if (path.extname(filename) === ".node") throw nativeAddonError(filename);
    if (path.extname(filename) === ".json") {
      const txt = providedSource != null ? providedSource : fs.readFileSync(filename, "utf8");
      module.exports = JSON.parse(txt);
      return;
    }
    let source = providedSource != null ? providedSource : fs.readFileSync(filename, "utf8");
    if (source.charCodeAt(0) === 0xfeff) source = source.slice(1); // strip BOM
    if (source.startsWith("#!")) source = "//" + source.slice(2); // neutralize shebang

    // Transparent in-process esbuild service: rewrite esbuild-wasm's lib/main.js
    // so its Go service runs in this thread instead of spawning a child whose
    // stdio pipe deadlocks under a worker pool. No-op for everything else. This
    // replaces the old per-project scripts/vv-ng.mjs patch (see
    // esbuild-inproc-patch.js).
    const esbPatched = maybePatchEsbuildInProcess(source, filename, fs, path);
    if (esbPatched != null) source = esbPatched;

    // Bun-style zero-config TypeScript/JSX: strip types + lower JSX synchronously
    // for `.ts`/`.tsx`/`.mts`/`.cts`/`.jsx` before the ESM pass sees the source.
    // A no-op (returns null) for plain JS and for `.ts` files that contain no
    // type syntax, so ordinary modules are untouched. See typescript-transform.js.
    const tsCompiled = maybeTranspileTypeScript(source, filename, jsxOptionsFor(filename));
    if (tsCompiled != null) source = tsCompiled;

    // Breakpoint-debugger instrumentation. When a debug session is attached
    // (index.js installs `globalThis.__vvDebugHook`), weave probes into the guest's
    // OWN source (node_modules excluded) on plain, line-preserving ECMAScript —
    // after the TS/JSX strip, before the ESM rewrite. The hook registers the script
    // (Debugger.scriptParsed) and returns the woven code; it self-heals to the
    // original source on any failure, so debugging never breaks a run. Zero cost
    // when no session is attached (one global read).
    const dh = globalThis.__vvDebugHook;
    if (dh && dh.shouldInstrument(filename)) {
      try {
        const woven = dh.instrument(source, filename, {
          isModule: /(^|[\n;])\s*(import|export)\b/.test(source),
        });
        if (typeof woven === "string" && woven.length) source = woven;
      } catch {
        /* leave source un-instrumented — that file just isn't breakpointable */
      }
    }

    // ESM support (#13): transpile import/export -> our synchronous CJS at load
    // time. `.cjs` is always CommonJS; everything else is scanned and rewritten
    // only if it actually uses module syntax (transpileEsm returns null for
    // plain CJS, so require/module.exports files are untouched).
    let isEsm = false;
    let esmSource = null; // pre-transpile ESM source, kept for the live-binding fallback
    if (path.extname(filename) !== ".cjs") {
      const esm = transpileEsm(source, filename);
      if (esm != null) {
        esmSource = source;
        source = esm;
        isEsm = true;
      }
    }
    // Pure CJS still needs its dynamic `import()` routed through our loader (ESM
    // files got theirs rewritten above). Otherwise `await import('chalk')` in a
    // CommonJS module escapes to the host realm's native import(). See esm.js.
    if (!isEsm) {
      const rewritten = rewriteCjsDynamicImport(source, filename);
      if (rewritten != null) source = rewritten;
    }

    const dirname = path.dirname(filename);
    const require = makeRequire(dirname);

    // The classic CommonJS wrapper. Only the real wrapper params are injected;
    // Buffer/process/console/global/timers are true globals (set on globalThis by
    // the runtime), exactly like Node. Injecting them as params instead would make
    // a userland `const Buffer = require('buffer').Buffer` an "Identifier already
    // declared" SyntaxError.
    //
    // ESM modules get NONE of the CJS wrapper identifiers as their normal names:
    // real ES modules have no `require`/`__filename`/`__dirname`/`module`/`exports`
    // as free variables, and ESM code routinely binds those names itself —
    //   import { createRequire } from 'module';
    //   const require = createRequire(import.meta.url);
    //   import module from 'node:module';           // TS7's getExePath.js
    //   const __dirname = path.dirname(fileURLToPath(import.meta.url));
    // Injecting any of them as params would make those declarations throw
    // "Identifier already declared". So the transpiler's generated code refers to
    // EVERYTHING under an __oc_ prefix — __oc_require (import rewrites, __oc_import,
    // __oc_meta.resolve), __oc_exports, __oc_module — and we inject those here.
    // import.meta.url is provided via __oc_meta.
    let wrapper;
    let isAsync = false;
    try {
      wrapper = isEsm
        ? new RealFunction("__oc_exports", "__oc_require", "__oc_module", source + "\n")
        : new RealFunction("exports", "require", "module", "__filename", "__dirname", source + "\n");
    } catch (err) {
      // Top-level await: real ESM allows `await` at the module top level, but our
      // CJS wrapper is a plain (non-async) function, so `new Function` rejects the
      // parse. Recompile the ESM body as an AsyncFunction — the module then
      // evaluates to a Promise we thread through runMain()/run() (the entry) so the
      // top-level body can await while the loop pumps. Modern CLIs (e.g. Vite's
      // bin: `await import('node:inspector')`) need this. Only ESM can hit it; CJS
      // never legally has top-level await.
      //
      // We can't reliably sniff TLA from the error MESSAGE: `await x` at top level
      // parses `await` as an identifier, so the parser blames the NEXT token —
      // `SyntaxError: Unexpected identifier 'x'` — not the tidy "await is only valid…"
      // string. (@sveltejs/kit's core/sync/ts.js does `ts = (await import('ts')).default`
      // → after our import-rewrite `await __oc_import('ts')` → "Unexpected identifier
      // '__oc_import'".) So for ESM we just RETRY as an AsyncFunction on any compile
      // error: real TLA then compiles, and a genuine syntax error fails again and is
      // reported. The retry is error-path only, so there's no cost on the happy path.
      if (isEsm) {
        try {
          wrapper = new AsyncFunction("__oc_exports", "__oc_require", "__oc_module", source + "\n");
          isAsync = true;
        } catch (e2) {
          e2.message += ` (while compiling ${filename} [esm])`;
          throw e2;
        }
      } else {
        // Compilation (parse) errors are otherwise anonymous ("<anonymous>"); name
        // the offending file + module kind so loader bugs are debuggable.
        err.message += ` (while compiling ${filename} [cjs])`;
        throw err;
      }
    }
    // Run an ESM wrapper with the live-binding fallback: a circular import of a
    // const/class/singleton reads its source binding eagerly (`const X = m.X`), before
    // the source finished initialising → "Cannot access 'X' before initialization" (or,
    // for a name whose eager snapshot we dropped, "X is not defined"). Recompile THIS
    // module so imports become live bindings read lazily via `with(__oc_live)` and
    // re-run it ONCE. Only ESM, only when the throw looks like that, only if we still
    // have the source. The eager attempt threw in the prelude (before the body ran), so
    // re-running only re-defines the (configurable) export getters + re-runs cached
    // requires — no double body side effects. astro's runtime needs this (Fragment,
    // apiContextRoutesSymbol, AstroConfigSchema, globalContentLayer, telemetry, …).
    const runEsm = () => {
      try {
        return wrapper.call(module.exports, module.exports, require, module);
      } catch (e) {
        if (
          esmSource != null &&
          e instanceof ReferenceError &&
          /before initialization|is not defined/.test((e && e.message) || "")
        ) {
          const live = transpileEsmLive(esmSource, filename);
          if (live != null) {
            let w2;
            try {
              w2 = new RealFunction("__oc_exports", "__oc_require", "__oc_module", live + "\n");
              isAsync = false;
            } catch {
              w2 = new AsyncFunction("__oc_exports", "__oc_require", "__oc_module", live + "\n");
              isAsync = true;
            }
            return w2.call(module.exports, module.exports, require, module);
          }
        }
        throw e;
      }
    };
    // Debug aid: name the module whose TOP-LEVEL evaluation throws. Parse errors
    // already get the filename appended above, but a runtime throw during a
    // module's body (e.g. an ESM/CJS interop mismatch → `undefined.map`) is
    // otherwise anonymous in the stack. Gated so it's zero-cost in normal runs.
    if (process.env.VV_TRACE_MODULES) {
      try {
        if (isEsm) {
          const ret = runEsm();
          if (isAsync) module.evaluating = ret;
        } else {
          wrapper.call(module.exports, module.exports, require, module, filename, dirname);
        }
      } catch (e) {
        try {
          process.stderr.write(`[vv-module-throw] ${filename}: ${(e && e.message) || e}\n`);
        } catch {}
        // process.stderr routes through the kernel asynchronously, so it's lost if
        // the worker crashes right after. Also prepend the throwing module's path
        // to the error message (once per module up the require chain) so the
        // synchronous worker-error line shows the full chain: `[outer] [inner] …`.
        try {
          if (e && typeof e === "object" && !e.__ocTraced) {
            e.__ocTraced = true;
            const tag = `[${filename}] `;
            if (typeof e.stack === "string") e.stack = tag + e.stack;
            e.message = tag + e.message;
          }
        } catch {}
        throw e;
      }
      return;
    }
    if (isEsm) {
      const ret = runEsm();
      // A top-level-await module evaluates to a Promise; expose it so the entry
      // (runMain) can await the top-level body. A synchronous ESM module — even one
      // compiled to an async wrapper — has already fully run by the time this
      // returns (an async function runs sync up to its first real await, and there
      // is none), so its exports are complete for require() callers.
      if (isAsync) module.evaluating = ret;
    } else {
      wrapper.call(module.exports, module.exports, require, module, filename, dirname);
    }
  }

  // pnpm (and npm on Windows) install a package's bin as a SHELL cmd-shim — a
  // `#!/bin/sh` wrapper that `exec node "<…>/foo.js" "$@"` — instead of the POSIX
  // symlink-to-the-real-.js that npm uses. Our loader can't run shell, so if the
  // program is a shim, unwrap it to the .js it execs. Cheap: only extension-less
  // files (bins) are ever candidates, and we only read shell shebangs — a real
  // `#!/usr/bin/env node` bin returns null and is compiled as JS as before.
  function resolveCmdShim(file) {
    const ext = path.extname(file);
    // Only extension-less files (bins) are ever shims; skip obvious JS/JSON/native.
    if (ext === ".js" || ext === ".cjs" || ext === ".mjs" || ext === ".json" || ext === ".node") return null;
    let src;
    try {
      src = fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
    let target = parseShellShimTarget(src);
    if (!target) return null;
    // Expand pnpm's `$basedir` (= the shim's dir) and collapse `..` for the VFS.
    target = target.replace(/\$basedir/g, path.dirname(file));
    target = target.startsWith("/") ? path.resolve(target) : path.resolve(path.dirname(file), target);
    return target;
  }

  function runMain(entry) {
    const abs = entry.startsWith("/") ? entry : path.resolve(process.cwd(), entry);
    const dir = path.dirname(abs);
    const r = resolveFilename(abs, dir);
    if (r.builtin) return load(abs, dir); // degenerate: entry is a builtin id
    // Unwrap a pnpm/cmd-shim bin to the real .js it wraps, then run THAT as main.
    // Node's argv[1] for a bin is the resolved .js (not the shim), so mirror it.
    const shimTarget = resolveCmdShim(realpath(r.id));
    if (shimTarget && shimTarget !== realpath(r.id)) {
      try {
        if (Array.isArray(process.argv) && process.argv[1] === entry) process.argv[1] = shimTarget;
      } catch {}
      return runMain(shimTarget);
    }
    const filename = realpath(r.id);
    let mod = cache[filename];
    if (!mod) {
      mod = new Module(filename);
      mod.paths = nodeModulesPaths(path.dirname(filename));
      // Publish the entry as require.main / process.mainModule BEFORE its body
      // runs, so the extremely common `if (require.main === module)` guard is
      // true inside the entry itself (Node sets the main module up front too).
      mod.main = true;
      mainModule = mod;
      Module.main = mod;
      try { process.mainModule = mod; } catch {}
      cache[filename] = mod;
      let ok = false;
      try {
        compile(mod, filename);
        ok = true;
      } finally {
        if (!ok) delete cache[filename];
      }
      mod.loaded = true;
    } else {
      mod.main = true;
      mainModule = mod;
      Module.main = mod;
      try { process.mainModule = mod; } catch {}
    }
    // A top-level-await entry evaluates to a Promise; return it so run() can await
    // the top-level body while the loop drives timers/microtasks.
    return mod.evaluating ? mod.evaluating : mod.exports;
  }

  // ── Make `Module` a real, patchable constructor ────────────────────────────
  // Node's `module` builtin default export IS this class. Real tools reach for
  // these seams directly: npm's `promzard` hand-builds a Module and calls
  // `_nodeModulePaths`/`_resolveFilename`/`mod.require`; ts-node/tsx/jest patch
  // `_load`, `_resolveFilename`, `prototype.require`, or `_extensions['.js']` to
  // intercept requires; module runners read `_cache`, `wrap`, `_compile`.
  Module._cache = cache;
  // Node ships `.js`/`.json`/`.node` handlers on Module._extensions (aka
  // require.extensions). Tools both PATCH them (ts-node/tsx) and READ their keys
  // to decide an extension is natively loadable — rechoir (webpack-cli's config
  // loader) does `Object.keys(require.extensions).includes('.js')` and throws
  // "No module loader found for '.js'" if it's absent. Delegate to our compiler so
  // a direct `_extensions['.js'](module, filename)` call still works.
  Module._extensions = Object.create(null);
  Module._extensions[".js"] = (module, filename) => compile(module, filename);
  Module._extensions[".json"] = (module, filename) => compile(module, filename);
  // Bun-style native TypeScript/JSX: the same compiler handles them (compile()
  // transpiles by extension). Registering the handlers also satisfies tools that
  // probe `require.extensions` before loading a `.ts`/`.tsx` entry.
  for (const e of [".ts", ".tsx", ".mts", ".cts", ".jsx"]) {
    Module._extensions[e] = (module, filename) => compile(module, filename);
  }
  // `.node` goes through the same compiler as everything else, which is where the
  // check lives, so a tool that calls `_extensions['.node'](module, filename)`
  // directly gets the identical message rather than a second, thinner one. NOTE
  // `.node` is deliberately NOT in EXTS: a package that probes with
  // require.resolve('./build/foo.node') before falling back to pure JS must keep
  // getting "not found" for a file that does not exist, or it takes the native
  // branch and fails here instead of taking the branch that works.
  Module._extensions[".node"] = (module, filename) => compile(module, filename);
  Module.globalPaths = [];
  Module.wrapper = [
    "(function (exports, require, module, __filename, __dirname) { ",
    "\n});",
  ];
  Module.wrap = (script) => Module.wrapper[0] + script + Module.wrapper[1];

  Module._nodeModulePaths = (dir) => nodeModulesPaths(dir);

  Module._resolveFilename = function _resolveFilename(request, parent, _isMain, options) {
    // require.resolve(request, { paths: [...] }) — resolve as if required from
    // each given dir, in order (used by @nestjs/cli to find project typescript).
    if (options && Array.isArray(options.paths)) {
      for (const base of options.paths) {
        try {
          const r = resolveFilename(request, base);
          return r.builtin ? r.id : realpath(r.id);
        } catch {
          /* try the next candidate path */
        }
      }
    }
    const base = parent && parent.filename ? path.dirname(parent.filename) : process.cwd();
    const r = resolveFilename(request, base);
    return r.builtin ? r.id : realpath(r.id);
  };

  // The central require funnel — patch this to intercept every require (jest,
  // proxyquire, module-alias do). Mirrors Node's Module._load(request, parent).
  Module._load = function _load(request, parent, _isMain) {
    const base = parent && parent.filename ? path.dirname(parent.filename) : process.cwd();
    return load(request, base);
  };

  Module.isBuiltin = (request) => {
    if (typeof request !== "string") return false;
    const name = request.startsWith("node:") ? request.slice(5) : request;
    return hasBuiltin(name) || hasBuiltin("node:" + name) || hasLazyBuiltin(name);
  };

  // syncBuiltinESMExports is a no-op for us (no separate ESM builtin namespace to
  // resync); real tools call it after mutating a builtin and expect it to exist.
  Module.syncBuiltinESMExports = () => {};

  Module.createRequire = (from) => {
    let p = typeof from === "string" ? from : "/";
    if (p.startsWith("file://")) {
      try {
        p = decodeURIComponent(p.slice("file://".length));
      } catch {
        p = p.slice("file://".length);
      }
    }
    // Node treats a base path ENDING IN '/' as the directory itself (so its own
    // node_modules is searched), not that directory's parent. The trailing slash
    // is load-bearing: the Angular CLI does `createRequire(projectRoot + '/')` to
    // resolve `@angular/core/package.json` from the project root. A plain
    // `path.dirname('/ng/')` yields '/', which drops '/ng/node_modules'.
    const dir = p.endsWith("/") ? p.replace(/\/+$/, "") || "/" : path.dirname(p);
    return makeRequire(dir);
  };

  Module.prototype.require = function moduleRequire(request) {
    return Module._load(request, this, false);
  };

  // Instance load()/_compile(): run a file (or a source string) into THIS
  // module — ts-node/tsx build a Module then call `mod._compile(transpiled, fn)`.
  Module.prototype.load = function moduleLoad(filename) {
    this.filename = filename;
    this.paths = nodeModulesPaths(path.dirname(filename));
    if (!cache[filename]) cache[filename] = this;
    compile(this, filename);
    this.loaded = true;
  };
  Module.prototype._compile = function moduleCompile(content, filename) {
    this.filename = filename;
    if (!this.paths || !this.paths.length) this.paths = nodeModulesPaths(path.dirname(filename));
    compile(this, filename, content);
    this.loaded = true;
    return this.exports;
  };

  return { runMain, makeRequire, resolveFilename, Module, cache, setMainModule: (m) => (mainModule = m) };
}