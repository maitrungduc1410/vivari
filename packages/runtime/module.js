// A synchronous CommonJS module system — the whole reason brick #1 exists.
//
// `require()` is inherently synchronous in Node: it reads the file, compiles it,
// and returns `module.exports` right away. We can only do that in the browser
// because reads go through the sync bridge (Atomics.wait). Resolution follows
// Node's algorithm: core builtins, relative/absolute paths (with .js/.json and
// directory/index/package.json "main"), and bare specifiers walked up through
// node_modules.

export function createModuleSystem({ fs, path, builtins, process, globals, nodeModules }) {
  const cache = Object.create(null);
  const builtinNames = new Set(Object.keys(builtins));
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
  const tryExtensions = (p) =>
    (isFile(p) && p) || (isFile(p + ".js") && p + ".js") || (isFile(p + ".json") && p + ".json") || null;

  const loadIndex = (dir) =>
    (isFile(path.join(dir, "index.js")) && path.join(dir, "index.js")) ||
    (isFile(path.join(dir, "index.json")) && path.join(dir, "index.json")) ||
    null;

  function loadAsDirectory(dir) {
    const pkgPath = path.join(dir, "package.json");
    if (isFile(pkgPath)) {
      try {
        const main = JSON.parse(fs.readFileSync(pkgPath, "utf8")).main;
        if (main) {
          const target = path.join(dir, main);
          const resolved = tryExtensions(target) || loadIndex(target);
          if (resolved) return resolved;
        }
      } catch {
        /* fall through to index */
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

  function resolveFilename(request, fromDir) {
    if (builtinNames.has(request)) return { builtin: true, id: request };
    if (hasLazyBuiltin(request)) return { builtin: true, id: request };

    let resolved = null;
    if (request.startsWith("/") || request.startsWith("./") || request.startsWith("../")) {
      const base = path.resolve(fromDir, request);
      resolved = tryExtensions(base) || loadAsDirectory(base);
    } else {
      for (const nm of nodeModulesPaths(fromDir)) {
        const base = path.join(nm, request);
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

    const dirname = path.dirname(filename);
    const require = makeRequire(dirname);

    // The classic CommonJS wrapper. Only the five real wrapper params are
    // injected; Buffer/process/console/global/timers are true globals (set on
    // globalThis by the runtime), exactly like Node. Injecting them as params
    // instead would make a userland `const Buffer = require('buffer').Buffer`
    // a "Identifier already declared" SyntaxError.
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

  function runMain(entry) {
    const abs = entry.startsWith("/") ? entry : path.resolve(process.cwd(), entry);
    return load(abs, path.dirname(abs));
  }

  return { runMain, makeRequire, resolveFilename, Module, cache };
}
