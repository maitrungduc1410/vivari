// A synchronous CommonJS module system — the whole reason brick #1 exists.
//
// `require()` is inherently synchronous in Node: it reads the file, compiles it,
// and returns `module.exports` right away. We can only do that in the browser
// because reads go through the sync bridge (Atomics.wait). Resolution follows
// Node's algorithm: core builtins, relative/absolute paths (with .js/.json and
// directory/index/package.json "main"), and bare specifiers walked up through
// node_modules.

import { transpileEsm } from "./esm.js";

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

  function resolveFilename(request, fromDir) {
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

  function makeRequire(fromDir) {
    const require = (request) => load(request, fromDir);
    require.resolve = (request) => resolveFilename(request, fromDir).id;
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

    const filename = r.id;
    if (cache[filename]) return cache[filename].exports;

    const module = new Module(filename);
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
    // ESM modules get NO __filename/__dirname params: real ES modules don't have
    // them (they use import.meta.url, which we provide via __oc_meta), and ESM code
    // that wants them commonly does `const __dirname = fileURLToPath(...)` — which
    // would collide with an injected param and throw "already declared" (this is
    // exactly how Vite's bundled chunks are authored).
    if (isEsm) {
      const wrapper = new Function("exports", "require", "module", source + "\n");
      wrapper.call(module.exports, module.exports, require, module);
    } else {
      const wrapper = new Function(
        "exports",
        "require",
        "module",
        "__filename",
        "__dirname",
        source + "\n",
      );
      wrapper.call(module.exports, module.exports, require, module, filename, dirname);
    }
  }

  function runMain(entry) {
    const abs = entry.startsWith("/") ? entry : path.resolve(process.cwd(), entry);
    return load(abs, path.dirname(abs));
  }

  return { runMain, makeRequire, resolveFilename, Module, cache };
}
