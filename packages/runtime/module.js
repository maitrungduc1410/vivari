// A synchronous CommonJS module system — the whole reason brick #1 exists.
//
// `require()` is inherently synchronous in Node: it reads the file, compiles it,
// and returns `module.exports` right away. We can only do that in the browser
// because reads go through the sync bridge (Atomics.wait). Resolution follows
// Node's algorithm: core builtins, relative/absolute paths (with .js/.json and
// directory/index/package.json "main"), and bare specifiers walked up through
// node_modules.

import { transpileEsm } from "./esm.js";

// The constructor for `async function () {}` — used to (re)compile an ESM module
// that uses top-level await (our normal wrapper is a plain, non-async function).
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

export function createModuleSystem({ fs, path, builtins, process, globals, nodeModules }) {
  const cache = Object.create(null);
  // Check the LIVE builtins object, not a snapshot: index.js finishes wiring it
  // (adds `module`, then every `node:`-prefixed alias) AFTER this system is
  // constructed, so a Set captured here would miss `node:module`/`node:fs`/... .
  const hasBuiltin = (request) => Object.prototype.hasOwnProperty.call(builtins, request);
  // Vendored modules the loader can serve lazily (e.g. `semver`) without eagerly
  // instantiating them for every process — resolved only when actually required.
  const hasLazyBuiltin = (request) => !!nodeModules && nodeModules.has(request);

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
  const EXTS = [".js", ".mjs", ".cjs", ".json"];
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
    if (hasBuiltin(request)) return { builtin: true, id: request };
    if (hasLazyBuiltin(request)) return { builtin: true, id: request };

    if (request[0] === "#") {
      const r = resolveImports(request, fromDir);
      if (r) return { builtin: false, id: r };
      const err = new Error(`Cannot find package import '${request}' from '${fromDir}'`);
      err.code = "MODULE_NOT_FOUND";
      throw err;
    }

    let resolved = null;
    if (request.startsWith("/") || request.startsWith("./") || request.startsWith("../")) {
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
    const require = (request) => load(request, fromDir);
    // Honor require.resolve(request, { paths: [...] }) — Node resolves as if
    // required from each given dir, in order (used by @nestjs/cli to find the
    // project's typescript). Falls back to this module's own dir.
    require.resolve = (request, options) => {
      if (options && Array.isArray(options.paths)) {
        for (const base of options.paths) {
          try {
            return realpath(resolveFilename(request, base).id);
          } catch {
            /* try the next candidate path */
          }
        }
      }
      return realpath(resolveFilename(request, fromDir).id);
    };
    require.cache = cache;
    require.main = undefined;
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

  function compile(module, filename) {
    if (path.extname(filename) === ".json") {
      module.exports = JSON.parse(fs.readFileSync(filename, "utf8"));
      return;
    }
    let source = fs.readFileSync(filename, "utf8");
    if (source.charCodeAt(0) === 0xfeff) source = source.slice(1); // strip BOM
    if (source.startsWith("#!")) source = "//" + source.slice(2); // neutralize shebang

    // ESM support (#13): transpile import/export -> our synchronous CJS at load
    // time. `.cjs` is always CommonJS; everything else is scanned and rewritten
    // only if it actually uses module syntax (transpileEsm returns null for
    // plain CJS, so require/module.exports files are untouched).
    let isEsm = false;
    if (path.extname(filename) !== ".cjs") {
      const esm = transpileEsm(source, filename);
      if (esm != null) {
        source = esm;
        isEsm = true;
      }
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
        ? new Function("__oc_exports", "__oc_require", "__oc_module", source + "\n")
        : new Function("exports", "require", "module", "__filename", "__dirname", source + "\n");
    } catch (err) {
      // Top-level await: real ESM allows `await` at the module top level, but our
      // CJS wrapper is a plain (non-async) function, so `new Function` rejects the
      // parse. Recompile the ESM body as an AsyncFunction — the module then
      // evaluates to a Promise we thread through runMain()/run() (the entry) so the
      // top-level body can await while the loop pumps. Modern CLIs (e.g. Vite's
      // bin: `await import('node:inspector')`) need this. Only ESM can hit it; CJS
      // never legally has top-level await.
      if (isEsm && /\bawait\b.*\b(only|valid|allowed)\b/i.test(err.message)) {
        try {
          wrapper = new AsyncFunction("__oc_exports", "__oc_require", "__oc_module", source + "\n");
          isAsync = true;
        } catch (e2) {
          e2.message += ` (while compiling ${filename} [esm+tla])`;
          throw e2;
        }
      } else {
        // Compilation (parse) errors are otherwise anonymous ("<anonymous>"); name
        // the offending file + module kind so loader bugs are debuggable.
        err.message += ` (while compiling ${filename}${isEsm ? " [esm]" : " [cjs]"})`;
        throw err;
      }
    }
    if (isEsm) {
      const ret = wrapper.call(module.exports, module.exports, require, module);
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

  function runMain(entry) {
    const abs = entry.startsWith("/") ? entry : path.resolve(process.cwd(), entry);
    const dir = path.dirname(abs);
    const exports = load(abs, dir);
    // If the entry used top-level await, its module evaluates to a Promise; return
    // it (instead of the exports) so run() can await the top-level body while the
    // loop drives timers/microtasks.
    const r = resolveFilename(abs, dir);
    const mod = r.builtin ? null : cache[realpath(r.id)];
    return mod && mod.evaluating ? mod.evaluating : exports;
  }

  return { runMain, makeRequire, resolveFilename, Module, cache };
}
