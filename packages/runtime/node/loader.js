// The Node builtin loader — the heart of Path B.
//
// Node ships its standard library as JavaScript (lib/) that runs on top of a
// C++ core reached through `internalBinding`. We keep that JS layer UNMODIFIED
// and re-implement the layer beneath it. Each vendored module is a factory
//   function (exports, require, module, process, internalBinding, primordials)
// exactly like Node's own BuiltinLoader wraps its sources. This loader links
// them: it resolves `require('path')` / `require('internal/...')` against the
// vendored set, injects our `primordials` + `internalBinding` + the process,
// caches instances, and tolerates require cycles (returns the partial exports).
//
// Adding a real Node module later = drop the vendored file in and register it.

import { primordials } from "./primordials.js";
import { createInternalBinding } from "./internal-binding.js";

import pathFactory from "./lib/path.js";
import constantsFactory from "./internal/constants.js";
import validatorsFactory from "./internal/validators.js";
import errorsFactory from "./internal/errors.js";
import utilFactory from "./internal/util.js";

// name -> factory. Public builtins (e.g. "path") and internals ("internal/...")
// live in the same table, just like Node's builtin id space.
const FACTORIES = {
  path: pathFactory,
  "internal/constants": constantsFactory,
  "internal/validators": validatorsFactory,
  "internal/errors": errorsFactory,
  "internal/util": utilFactory,
};

const strip = (name) => (name.startsWith("node:") ? name.slice(5) : name);

export function createNodeModules({ process }) {
  const internalBinding = createInternalBinding();
  const modules = new Map(); // id -> module object (kept for cycle resolution)

  function nodeRequire(name) {
    const id = strip(name);
    const existing = modules.get(id);
    if (existing) return existing.exports; // done, or partial during a cycle
    const factory = FACTORIES[id];
    if (!factory) {
      throw new Error(`OpenContainer: no vendored Node builtin '${id}'`);
    }
    const module = { exports: {} };
    modules.set(id, module); // register BEFORE running so cycles see the partial
    factory(module.exports, nodeRequire, module, process, internalBinding, primordials);
    return module.exports;
  }

  return {
    require: nodeRequire,
    /** True if `name` is served by the vendored Node lib (public ids only). */
    has: (name) => Object.prototype.hasOwnProperty.call(FACTORIES, strip(name)),
  };
}
