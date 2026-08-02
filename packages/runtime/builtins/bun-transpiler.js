// Bun.Transpiler — transformSync/transform, and the scan family.
//
// scan()/scanImports() answer "what does this file import, and what does it
// export" without resolving or executing anything. They used to throw here,
// because the honest answer at the time was that nothing in the runtime built an
// import graph: typescript-transform.js is a type stripper, not a parser. That
// stopped being true when Bun.build landed a real dependency-graph bundler, so
// the two halves it already needs are reused rather than re-derived:
//
//   * ES-module syntax comes from the vendored es-module-lexer, the same parse
//     Bun.build uses to find a module's exports. It reports static imports,
//     dynamic imports and export names with offsets.
//   * `require("x")` / `require.resolve("x")` come from scanRequireCalls() in
//     bun-build.js, which runs that file's lexer, so a `require` inside a string,
//     a comment or a regex is not a hit.
//
// Both run over the SAME type-stripped source, so their offsets share a
// coordinate space and merging them recovers Bun's source order.
//
// The two methods deliberately report different sets. This is not a quirk worth
// smoothing over — it is observable, and every behaviour below was checked
// against a real `bun test`-era binary (1.3.6, d530ed99) rather than the docs:
//
//   scan()        import-statement, dynamic-import, require-resolve
//   scanImports() import-statement, dynamic-import, require-call
//
// So a file whose only dependency is `require("x")` scans as importing NOTHING,
// and one whose only dependency is `require.resolve("x")` scanImports as
// importing nothing. Reproducing that is the whole point: a caller that picked
// the wrong method under real Bun gets the same empty answer here, instead of a
// sandbox that is quietly more helpful than production.
//
// Neither result is deduplicated and both are in source order; `exports` IS
// sorted (by UTF-16 code unit, so `["A","B","a","b"]`), which is Bun's order and
// not the source's.
//
// DIVERGENCES, both because our transform is not Bun's:
//
//   * A .jsx/.tsx file that actually uses JSX gets two extra require-calls from
//     real Bun's scanImports — `react/jsx-runtime` and `react` — injected by its
//     automatic JSX runtime. Ours emits classic `React.createElement`, which
//     introduces no specifier at all (the `React` binding comes from the file's
//     own import), so those two are absent. Emitting them anyway would report a
//     dependency that nothing in Vivari would ever load.
//   * The scanner is a lexer, not a parser, so source that is genuinely invalid
//     can still scan cleanly where Bun raises. A parse failure throws an Error
//     naming the position; Bun throws a `BuildMessage`, which is a class we have
//     no way to reproduce faithfully.

import { transpileTypeScript } from "../typescript-transform.js";
import { parse as lexModule } from "../node/vendor/es-module-lexer.js";
import { scanRequireCalls } from "./bun-build.js";

// Bun's own list, taken from the TypeError it throws for anything outside it.
const LOADERS = ["js", "jsx", "tsx", "ts", "css", "file", "toml", "yaml", "wasm", "bunsh", "json"];
const JS_LIKE = { js: ".js", jsx: ".jsx", tsx: ".tsx", ts: ".ts" };

const invalidLoader = () => {
  const e = new TypeError(`invalid loader - must be ${LOADERS.slice(0, -1).join(", ")}, or ${LOADERS[LOADERS.length - 1]}`);
  e.code = "ERR_INVALID_ARG_TYPE";
  return e;
};
const notJsLike = () => {
  const e = new TypeError("only JavaScript-like loaders supported for now");
  e.code = "ERR_INVALID_ARG_TYPE";
  return e;
};

/**
 * Bun validates in two steps and so do we: a name outside the list is a
 * different error from a real loader it cannot transpile. Bun applies the second
 * check only in the constructor — a non-JS loader passed to scan() is handed to
 * the parser, which then fails with something unrelated to the cause ("Failed to
 * parse" for css). We apply it in both places, because that error is useless.
 */
export function resolveLoaderExt(loader) {
  if (loader == null) return null;
  if (typeof loader !== "string" || !LOADERS.includes(loader)) throw invalidLoader();
  const ext = JS_LIKE[loader];
  if (!ext) throw notJsLike();
  return ext;
}

function decodeSource(code, method) {
  if (typeof code === "string") return code;
  if (code instanceof Uint8Array) return new TextDecoder().decode(code);
  throw new TypeError(`Expected code to be a string or Uint8Array for '${method}'.`);
}

function lineColumn(src, idx) {
  let line = 1;
  let start = 0;
  for (let i = 0; i < idx && i < src.length; i++) {
    if (src[i] === "\n") { line++; start = i + 1; }
  }
  let end = src.indexOf("\n", start);
  if (end < 0) end = src.length;
  return { line, column: idx - start, lineText: src.slice(start, end) };
}

/**
 * Everything both methods need, once: the type-stripped source, its ESM imports
 * and exports, and its require calls — merged into one source-ordered list that
 * each method then filters. Kept separate from the class so the offline spike can
 * pin it without constructing a Transpiler.
 */
export function scanSource(code, loader, method = "scan") {
  const src = decodeSource(code, method);
  const ext = resolveLoaderExt(loader) || ".tsx";
  // `.js` is left alone for the same reason module.js leaves it alone: routing
  // plain JavaScript through the type stripper is what that gate prevents.
  const js = ext === ".js" ? src : transpileTypeScript(src, "input" + ext);

  let lexed;
  try {
    lexed = lexModule(js, "input" + ext);
  } catch (e) {
    const at = lineColumn(js, (e && e.idx) || 0);
    const err = new Error(`Parse error at ${at.line}:${at.column}: ${at.lineText.trim()}`);
    err.position = { line: at.line, column: at.column, lineText: at.lineText, offset: (e && e.idx) || 0 };
    throw err;
  }
  const [imports, exports] = lexed;

  const found = [];
  for (const imp of imports) {
    // d === -1 static, d >= 0 dynamic, d === -2 `import.meta`. A dynamic import
    // whose specifier is not a literal has no `n`, and Bun reports nothing for
    // it rather than guessing — `import(x)` scans as no import at all.
    if (imp.d === -2 || imp.n == null) continue;
    found.push({ kind: imp.d === -1 ? "import-statement" : "dynamic-import", path: imp.n, pos: imp.s });
  }
  for (const r of scanRequireCalls(js)) found.push(r);
  found.sort((a, b) => a.pos - b.pos);

  return {
    // Bun sorts; the lexer reports source order.
    exports: exports.map((e) => e.n).filter((n) => typeof n === "string").sort(),
    found,
  };
}

const strip = (found, drop) => found.filter((f) => f.kind !== drop).map((f) => ({ kind: f.kind, path: f.path }));

export function bunScan(code, loader) {
  const { exports, found } = scanSource(code, loader, "scan");
  return { exports, imports: strip(found, "require-call") };
}

export function bunScanImports(code, loader) {
  const { found } = scanSource(code, loader, "scanImports");
  return strip(found, "require-resolve");
}

export function makeTranspilerClass() {
  return class Transpiler {
    constructor(opts) {
      this._opts = opts || {};
      // Validate here, as Bun does: a loader typo should fail where it was
      // written, not at the first transform with a misleading parse error.
      if (this._opts.loader != null) resolveLoaderExt(this._opts.loader);
    }
    transformSync(code, loaderOrOpts) {
      const loader = typeof loaderOrOpts === "string" ? loaderOrOpts : this._opts.loader;
      const ext = resolveLoaderExt(loader) || ".tsx";
      return transpileTypeScript(decodeSource(code, "transformSync"), "input" + ext);
    }
    async transform(code, loader) { return this.transformSync(code, loader); }
    scan(code, loader) { return bunScan(code, loader === undefined ? this._opts.loader : loader); }
    scanImports(code, loader) { return bunScanImports(code, loader === undefined ? this._opts.loader : loader); }
  };
}