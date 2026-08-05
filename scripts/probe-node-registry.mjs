// Registry probe for the vendored Node builtin tree — the gate for the bug class
// "an id that imports cleanly and only throws when the code path is first hit".
//
// Node's real lib/ requires most of its internals LAZILY: `internal/fixed_queue`
// is pulled the first time someone iterates `events.on()`, `internal/mime` the
// first time someone reads `util.MIMEType`. So an id missing from loader.js's
// FACTORIES table is invisible at import time, invisible to a type checker, and
// invisible to every test that does not walk that exact path — it surfaces in a
// user's project as `Vivari: no vendored Node builtin '...'`. Thirteen of those
// were live in this tree at once. Same story one layer down: a primordial name
// that node/primordials.js cannot resolve kills its whole module at load, and
// only the modules nobody had exercised were affected.
//
// This is STATIC analysis over the AST (the repo's own vendored acorn), so it
// needs neither the Rust/Wasm build nor a browser — it runs everywhere
// `npm run verify` cannot (verify dies at startup without packages/vfs/pkg-node).
//
// It checks, and fails non-zero on:
//   1. every builtin id reachable via require(...), defineLazyProperties(...) and
//      getLazy(() => require(...)) resolves in loader.js's FACTORIES table;
//   2. every primordial name the vendored code destructures resolves under
//      node/primordials.js's naming scheme;
//   3. every internalBinding('ns') namespace exists in internal-binding.js;
//   4. nothing it cannot parse is passed over in silence — an unrecognised
//      construct is a failure, not a skip;
//   5. the allowlists below are exactly the deliberate omissions: an entry that
//      is no longer needed fails just as loudly as a new gap.
//
// WHAT IT DOES NOT CATCH (a probe that quietly passes is the failure mode this
// MR is about, so this list is part of the contract):
//   • Runtime behaviour. An id that is registered but whose factory throws at
//     load, or whose exports are missing the member the caller destructures,
//     passes here. Only the smoke/verify runs catch that.
//   • Primordial *correctness*. `has()` says a name resolves, not that the value
//     works: an unbound static (PromiseResolve before this MR) resolves fine and
//     still throws when called.
//   • internalBinding *members*. `internalBinding('util').getCallSites` is a
//     missing member of a present namespace; only the namespace is checked.
//   • Ids reached through a helper the probe has never heard of. The literal
//     cross-check below backstops this for `internal/*` ids, and the helper
//     inventory check fails if internal/util.js grows a new lazy loader, but a
//     brand-new helper taking a *public* id is out of reach.
//   • Anything outside packages/runtime/node/{lib,internal} — bindings/, vendor/
//     and the ESM loader are not scanned.
//
//   node scripts/probe-node-registry.mjs                  # this working tree
//   node scripts/probe-node-registry.mjs --root <dir>     # another node/ tree
//   node scripts/probe-node-registry.mjs --no-live        # skip the loader import

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Parser, version as acornVersion } from "../packages/runtime/vendor/acorn.mjs";

// --- the deliberate omissions ------------------------------------------------
// Adding to these is a conscious, reviewable act: the probe is green today and
// goes red the moment a NEW gap appears. Removing a gap must also remove its
// entry here — a stale entry fails too, so the list can't rot into cover.

const ALLOWED_MISSING_IDS = {
  "internal/source_map/source_map_cache":
    "util.getCallSites({ sourceMap: true }) — pulls four further unregistered internal/source_map/* ids. Plain getCallSites() does NOT come here: internalBinding('util').getCallSites exists now, and lib/util.js only reaches the cache under sourceMap:true or --enable-source-maps.",
};

const ALLOWED_MISSING_BINDINGS = {
  icu: "Buffer.transcode / ICU paths — dormant because internalBinding('config').hasIntl is false, so lib/buffer.js:1369 is never reached.",
};

// `require(<expression>)` the probe cannot follow. Keyed by file + the chain of
// enclosing names, so it survives line drift but not a move. Anything not listed
// here is a failure.
const ALLOWED_DYNAMIC_REQUIRES = {
  "internal/util.js:defineLazyProperties>get":
    "the lazy-load helper itself: `require(id)` where `id` is its own parameter. Every call site passes a string literal and is checked above.",
};

// The module-loading helpers the probe understands, and the internal/util.js
// exports that merely *look* like one. A new lazy export there is a hole the
// probe cannot see through, so it fails and asks to be taught.
const LAZY_HELPERS = ["getLazy", "defineLazyProperties"];
const NOT_MODULE_LOADERS = ["lazyDOMException"];

// --- CLI ---------------------------------------------------------------------
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
if (args.includes("--help") || args.includes("-h")) {
  console.log("node scripts/probe-node-registry.mjs [--root <node dir>] [--no-live]");
  process.exit(0);
}
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i < 0 ? dflt : args[i + 1];
};
const ROOT = path.resolve(argOf("--root", path.join(REPO, "packages/runtime/node")));
const LIVE = !args.includes("--no-live");

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  \u2713 " : "  \u2717 ") + msg);
  if (!cond) failed++;
};
const section = (title) => console.log("\n" + title);
const detail = (line) => console.log("      " + line);

const rel = (f) => path.relative(ROOT, f).split(path.sep).join("/");
const stripNode = (id) => (id.startsWith("node:") ? id.slice(5) : id);

console.log("node builtin registry probe \u2014 static (no Wasm build, no browser)");
console.log("root: " + path.relative(REPO, ROOT).split(path.sep).join("/"));

// --- 1. parse every vendored file -------------------------------------------
section("sources");

function walkDir(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkDir(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

const files = [...walkDir(path.join(ROOT, "lib")), ...walkDir(path.join(ROOT, "internal"))];
ok(files.length > 0, `${files.length} file(s) under lib/ + internal/`);
if (files.length === 0) {
  console.log("\nRESULT: FAIL (nothing to scan \u2014 is --root a packages/runtime/node dir?)");
  process.exit(1);
}

const sources = new Map(); // rel path -> { src, lines, ast }
const parseErrors = [];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  const opts = { ecmaVersion: "latest", locations: true };
  let ast = null;
  let err = null;
  for (const sourceType of ["module", "script"]) {
    try {
      ast = Parser.parse(src, { ...opts, sourceType });
      break;
    } catch (e) {
      err ??= e;
    }
  }
  if (!ast) parseErrors.push({ file: rel(f), message: String(err && err.message) });
  else sources.set(rel(f), { src, lines: src.split("\n"), ast });
}
ok(parseErrors.length === 0, `${sources.size}/${files.length} parsed (vendored acorn ${acornVersion})`);
for (const e of parseErrors) detail(`${e.file}: ${e.message}`);

// --- 2. the FACTORIES table --------------------------------------------------
section("loader.js FACTORIES table");

const SKIP_KEYS = new Set(["loc", "start", "end", "range"]);
function walkAst(ast, visit) {
  const stack = [];
  (function rec(node, parent) {
    const named = nameOf(node, parent);
    if (named) stack.push(named);
    visit(node, parent, stack);
    for (const k of Object.keys(node)) {
      if (SKIP_KEYS.has(k)) continue;
      const v = node[k];
      if (Array.isArray(v)) {
        for (const c of v) if (c && typeof c.type === "string") rec(c, node);
      } else if (v && typeof v.type === "string") {
        rec(v, node);
      }
    }
    if (named) stack.pop();
  })(ast, null);
}

const keyName = (k) => (k.type === "Identifier" ? k.name : k.type === "Literal" ? String(k.value) : null);

// The nearest named thing enclosing a site — how the report says which API breaks.
function nameOf(node, parent) {
  switch (node.type) {
    case "FunctionDeclaration":
    case "ClassDeclaration":
      return node.id ? { name: node.id.name, kind: "function" } : null;
    case "VariableDeclarator":
      return node.id.type === "Identifier" ? { name: node.id.name, kind: "binding" } : null;
    case "FunctionExpression":
    case "ArrowFunctionExpression": {
      if (!parent) return null;
      if (parent.type === "Property" && !parent.computed && keyName(parent.key)) {
        return { name: keyName(parent.key), kind: parent.kind === "init" ? "method" : parent.kind };
      }
      if (parent.type === "MethodDefinition" && !parent.computed && keyName(parent.key)) {
        return { name: keyName(parent.key), kind: parent.kind === "get" ? "get" : "method" };
      }
      if (
        parent.type === "AssignmentExpression" &&
        parent.left.type === "MemberExpression" &&
        !parent.left.computed &&
        parent.left.property.type === "Identifier"
      ) {
        return { name: parent.left.property.name, kind: "function" };
      }
      return null;
    }
    default:
      return null;
  }
}

// Depth-1 keys of `const <name> = { ... }`, straight off the AST.
function objectLiteralKeys(file, declName) {
  const src = readFileSync(file, "utf8");
  const ast = Parser.parse(src, { ecmaVersion: "latest", locations: true, sourceType: "module" });
  const keys = new Set();
  const problems = [];
  let found = false;
  walkAst(ast, (node) => {
    if (node.type !== "VariableDeclarator") return;
    if (node.id.type !== "Identifier" || node.id.name !== declName) return;
    if (!node.init || node.init.type !== "ObjectExpression") return;
    found = true;
    for (const p of node.init.properties) {
      if (p.type !== "Property" || p.computed || !keyName(p.key)) {
        problems.push(`${path.basename(file)}:${p.loc.start.line}: ${declName} entry is not a plain key`);
        continue;
      }
      keys.add(keyName(p.key));
    }
  });
  if (!found) problems.push(`${path.basename(file)}: \`const ${declName} = { ... }\` not found`);
  return { keys, problems };
}

const loaderPath = path.join(ROOT, "loader.js");
const { keys: FACTORIES, problems: factoryProblems } = objectLiteralKeys(loaderPath, "FACTORIES");
ok(factoryProblems.length === 0 && FACTORIES.size > 0, `${FACTORIES.size} ids registered (static AST scrape)`);
for (const p of factoryProblems) detail(p);

if (LIVE) {
  let liveHas = null;
  let liveErr = null;
  try {
    const mod = await import(pathToFileURL(loaderPath).href);
    liveHas = mod.createNodeModules({}).has;
  } catch (e) {
    liveErr = e;
  }
  if (!liveHas) {
    ok(false, "live cross-check: importing loader.js failed \u2014 the static scrape is unverified");
    detail(String(liveErr && liveErr.message));
  } else {
    const disagree = [...FACTORIES].filter((id) => !liveHas(id));
    ok(disagree.length === 0, `live cross-check: createNodeModules().has() agrees on all ${FACTORIES.size} ids`);
    for (const id of disagree) detail(`scraped but not live: ${id}`);
  }
} else {
  console.log("  \u25CB live cross-check skipped (--no-live)");
}

// --- 3. extract every builtin id, binding namespace and primordial ----------
const idRefs = new Map(); // id -> [site]
const bindingRefs = new Map(); // ns -> [site]
const primordialRefs = new Map(); // name -> [site]
const literals = new Set(); // every string literal in the tree
const unparseable = []; // { key, file, line, what, snippet }
const callSites = new Map(); // "file\0name" -> [site]  (who calls the lazy loaders)

const push = (map, key, value) => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};

function siteOf(file, node, stack) {
  const line = node.loc.start.line;
  const text = (sources.get(file).lines[line - 1] ?? "").trim();
  return {
    file,
    line,
    // `enclosing` is the innermost name of any kind (it triggers the lazy hop
    // below); `enclosingFn` skips intermediate bindings like `const Glob =
    // lazyGlob()` to reach the function that is the actual API.
    enclosing: stack.length ? stack[stack.length - 1] : null,
    enclosingFn: [...stack].reverse().find((s) => s.kind !== "binding") ?? null,
    key: `${file}:${stack.map((s) => s.name).join(">") || "<top level>"}`,
    snippet: text.length > 96 ? text.slice(0, 93) + "..." : text,
  };
}

const literalString = (n) =>
  n && n.type === "Literal" && typeof n.value === "string"
    ? n.value
    : n && n.type === "TemplateLiteral" && n.expressions.length === 0 && n.quasis.length === 1
      ? n.quasis[0].value.cooked
      : null;

function countLiteralRequires(node) {
  let n = 0;
  walkAst(node, (x) => {
    if (x.type === "CallExpression" && x.callee.type === "Identifier" && x.callee.name === "require" && literalString(x.arguments[0])) n++;
  });
  return n;
}

for (const [file, { ast }] of sources) {
  walkAst(ast, (node, parent, stack) => {
    if (node.type === "Literal" && typeof node.value === "string") literals.add(node.value);

    // `const { A, B } = primordials;`
    if (node.type === "VariableDeclarator" && node.init && node.init.type === "Identifier" && node.init.name === "primordials") {
      if (node.id.type !== "ObjectPattern") {
        unparseable.push({ ...siteOf(file, node, stack), what: "`= primordials` bound to something other than an object pattern" });
        return;
      }
      for (const p of node.id.properties) {
        if (p.type !== "Property" || p.computed || !keyName(p.key)) {
          unparseable.push({ ...siteOf(file, p, stack), what: "primordials destructuring uses a computed key or a rest element" });
          continue;
        }
        push(primordialRefs, keyName(p.key), siteOf(file, p, stack));
      }
      return;
    }
    // `primordials.Foo`
    if (node.type === "MemberExpression" && node.object.type === "Identifier" && node.object.name === "primordials") {
      const site = siteOf(file, node, stack);
      if (node.computed || node.property.type !== "Identifier") {
        unparseable.push({ ...site, what: "computed access on `primordials`" });
      } else {
        push(primordialRefs, node.property.name, site);
      }
      return;
    }

    if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return;
    const fn = node.callee.name;
    const site = siteOf(file, node, stack);

    if (fn !== "require" && fn !== "defineLazyProperties" && fn !== "getLazy" && fn !== "internalBinding") {
      push(callSites, `${file}\u0000${fn}`, site);
      return;
    }

    if (fn === "require") {
      const id = literalString(node.arguments[0]);
      if (id === null) {
        unparseable.push({ ...site, what: "require() with a non-literal argument" });
      } else {
        push(idRefs, stripNode(id), site);
      }
      return;
    }

    if (fn === "defineLazyProperties") {
      const id = literalString(node.arguments[1]);
      const keysNode = node.arguments[2];
      const keys =
        keysNode && keysNode.type === "ArrayExpression" && keysNode.elements.every((e) => literalString(e) !== null)
          ? keysNode.elements.map(literalString)
          : null;
      if (id === null || keys === null) {
        unparseable.push({ ...site, what: "defineLazyProperties() with a non-literal id or key list" });
      } else {
        push(idRefs, stripNode(id), { ...site, lazyKeys: keys });
      }
      return;
    }

    if (fn === "getLazy") {
      // The require inside is picked up by the rule above; assert there IS one,
      // so `getLazy(() => somethingElse())` cannot slip past unnoticed.
      if (countLiteralRequires(node) === 0) {
        unparseable.push({ ...site, what: "getLazy() whose initializer holds no literal require()" });
      }
      return;
    }

    // internalBinding
    const ns = literalString(node.arguments[0]);
    if (ns === null) {
      unparseable.push({ ...site, what: "internalBinding() with a non-literal argument" });
    } else {
      push(bindingRefs, ns, site);
    }
  });
}

// --- 4. which user-facing API a site breaks ---------------------------------
const publicModuleOf = (file) => (file.startsWith("lib/") ? file.slice(4).replace(/\.js$/, "") : null);
const builtinIdOf = (file) => (file.startsWith("lib/") ? publicModuleOf(file) : file.replace(/\.js$/, ""));

function renderApi(pub, site) {
  const fn = site.enclosingFn;
  if (fn) return fn.kind === "get" || fn.kind === "set" ? `${pub}.${fn.name}` : `${pub}.${fn.name}()`;
  if (site.enclosing) return `require('${pub}') \u2014 \`${site.enclosing.name}\` at module load`;
  return `require('${pub}') \u2014 at module load`;
}

// lib/* files that (transitively) require this module id.
function publicConsumers(id, seen = new Set()) {
  if (seen.has(id)) return [];
  seen.add(id);
  if (seen.size > 64) return [];
  const out = new Set();
  for (const [file] of sources) {
    if (!(idRefs.get(id) ?? []).some((s) => s.file === file)) continue;
    const pub = publicModuleOf(file);
    if (pub) out.add(pub);
    else for (const p of publicConsumers(builtinIdOf(file), seen)) out.add(p);
  }
  return [...out];
}

function apisForSite(site) {
  const pub = publicModuleOf(site.file);
  if (!pub) {
    const reached = publicConsumers(builtinIdOf(site.file)).sort();
    return reached.length
      ? reached.map((m) => `require('${m}') \u2014 via ${builtinIdOf(site.file)}`)
      : [`${builtinIdOf(site.file)} \u2014 no lib/* consumer found`];
  }
  if (site.lazyKeys) return site.lazyKeys.map((k) => `${pub}.${k}`);
  // One hop through a lazy loader: `function lazyLoadCp()` is not the API, its
  // callers (fs.cp / fs.cpSync) are.
  if (site.enclosing && /^lazy/i.test(site.enclosing.name)) {
    const callers = callSites.get(`${site.file}\u0000${site.enclosing.name}`) ?? [];
    const apis = [...new Set(callers.filter((c) => c.enclosingFn).map((c) => renderApi(pub, c)))];
    if (apis.length) return apis;
  }
  return [renderApi(pub, site)];
}

function reportGap(kind, id, sites, fixLine) {
  console.log(`\n  ${kind}  ${id}`);
  const apis = [...new Set(sites.flatMap(apisForSite))].sort();
  detail(`breaks : ${apis.slice(0, 6).join(", ")}${apis.length > 6 ? `, +${apis.length - 6} more` : ""}`);
  for (const s of sites.slice(0, 6)) detail(`at     : ${s.file}:${s.line}  ${s.snippet}`);
  if (sites.length > 6) detail(`at     : +${sites.length - 6} more site(s)`);
  detail(`fix    : ${fixLine}`);
}

// --- 5. the checks -----------------------------------------------------------
section("constructs the probe could not parse");
{
  const unacknowledged = unparseable.filter((u) => !(u.key in ALLOWED_DYNAMIC_REQUIRES));
  ok(
    unacknowledged.length === 0,
    `${unparseable.length} dynamic construct(s), ${unparseable.length - unacknowledged.length} acknowledged, ${unacknowledged.length} unknown`,
  );
  for (const u of unacknowledged) {
    detail(`${u.file}:${u.line}  ${u.what}`);
    detail(`    ${u.snippet}`);
    detail(`    teach the probe, or add "${u.key}" to ALLOWED_DYNAMIC_REQUIRES with a reason.`);
  }
  for (const u of unparseable.filter((x) => x.key in ALLOWED_DYNAMIC_REQUIRES)) {
    console.log(`  \u25CB ${u.file}:${u.line} ${u.what} \u2014 allowed: ${ALLOWED_DYNAMIC_REQUIRES[u.key]}`);
  }
}

section("lazy-load helper inventory");
{
  const utilFile = "internal/util.js";
  const known = new Set([...LAZY_HELPERS, ...NOT_MODULE_LOADERS]);
  const exported = new Set();
  const entry = sources.get(utilFile);
  if (!entry) {
    ok(false, `${utilFile} not found \u2014 cannot confirm the helper set`);
  } else {
    walkAst(entry.ast, (node) => {
      if (
        node.type !== "AssignmentExpression" ||
        node.left.type !== "MemberExpression" ||
        node.left.object.type !== "Identifier" ||
        node.left.object.name !== "module" ||
        node.left.property.name !== "exports" ||
        node.right.type !== "ObjectExpression"
      ) {
        return;
      }
      for (const p of node.right.properties) if (p.type === "Property" && keyName(p.key)) exported.add(keyName(p.key));
    });
    const surprises = [...exported].filter((n) => /lazy/i.test(n) && !known.has(n));
    ok(
      surprises.length === 0,
      `${utilFile} exports exactly the known lazy helpers (${LAZY_HELPERS.join(", ")})`,
    );
    for (const n of surprises) {
      detail(`new lazy export: ${n} \u2014 the probe cannot see through it. Add it to LAZY_HELPERS`);
      detail("    (and teach the extractor) or to NOT_MODULE_LOADERS if it loads no builtin.");
    }
  }
}

section("builtin ids \u2192 loader.js FACTORIES");
{
  const referenced = [...idRefs.keys()].sort();
  const missing = referenced.filter((id) => !FACTORIES.has(id));
  const newlyMissing = missing.filter((id) => !(id in ALLOWED_MISSING_IDS));
  const allowedHit = missing.filter((id) => id in ALLOWED_MISSING_IDS);

  console.log(`  ${referenced.length} distinct id(s) referenced from ${sources.size} file(s); ${missing.length} unresolved`);
  ok(newlyMissing.length === 0, `${newlyMissing.length} unresolved outside the allowlist`);
  for (const id of newlyMissing) {
    reportGap("UNREGISTERED", id, idRefs.get(id), "register it in packages/runtime/node/loader.js's FACTORIES table, or add it to ALLOWED_MISSING_IDS in this file with a reason.");
  }

  // Stale allowlist entries: registered after all, or no longer referenced.
  const stale = Object.keys(ALLOWED_MISSING_IDS).filter((id) => FACTORIES.has(id) || !idRefs.has(id));
  ok(stale.length === 0, `${Object.keys(ALLOWED_MISSING_IDS).length} allowlisted omission(s), ${stale.length} stale`);
  for (const id of stale) {
    detail(`${id}: ${FACTORIES.has(id) ? "now registered" : "no longer referenced"} \u2014 drop it from ALLOWED_MISSING_IDS`);
  }
  for (const id of allowedHit.sort()) console.log(`  \u25CB ${id} \u2014 ${ALLOWED_MISSING_IDS[id]}`);
}

section("cross-check: bare 'internal/*' string literals");
{
  // Independent of the pattern rules above: any `internal/...` STRING LITERAL in
  // the tree (comments excluded — this reads the AST, not the text) must either
  // resolve or be allowlisted, even if it reaches the loader through a helper
  // this probe has never heard of.
  const bare = [...literals].filter((s) => /^(?:node:)?internal\/[\w./-]+$/.test(s)).map(stripNode);
  const unresolved = [...new Set(bare)].filter((id) => !FACTORIES.has(id) && !(id in ALLOWED_MISSING_IDS)).sort();
  ok(unresolved.length === 0, `${new Set(bare).size} literal(s), ${unresolved.length} neither registered nor allowlisted`);
  for (const id of unresolved) {
    const seenBy = idRefs.has(id) ? "(the pattern rules saw it too)" : "(the pattern rules did NOT see it \u2014 unknown consumer)";
    detail(`${id} ${seenBy}`);
  }
  const invisible = [...new Set(bare)].filter((id) => !idRefs.has(id));
  if (invisible.length) {
    console.log(`  \u25CB ${invisible.length} literal(s) the pattern rules do not treat as a require: ${invisible.join(", ")}`);
  }
}

section("internalBinding namespaces \u2192 internal-binding.js");
{
  const bindingFile = path.join(ROOT, "internal-binding.js");
  const { keys: BINDINGS, problems } = objectLiteralKeys(bindingFile, "bindings");
  for (const p of problems) detail(p);
  const missing = [...bindingRefs.keys()].filter((ns) => !BINDINGS.has(ns)).sort();
  const newlyMissing = missing.filter((ns) => !(ns in ALLOWED_MISSING_BINDINGS));
  console.log(`  ${bindingRefs.size} namespace(s) referenced; ${BINDINGS.size} implemented; ${missing.length} unresolved`);
  ok(problems.length === 0 && newlyMissing.length === 0, `${newlyMissing.length} unresolved outside the allowlist`);
  for (const ns of newlyMissing) {
    reportGap("MISSING BINDING", `internalBinding('${ns}')`, bindingRefs.get(ns), "implement it in packages/runtime/node/internal-binding.js, or add it to ALLOWED_MISSING_BINDINGS with a reason.");
  }
  const stale = Object.keys(ALLOWED_MISSING_BINDINGS).filter((ns) => BINDINGS.has(ns) || !bindingRefs.has(ns));
  ok(stale.length === 0, `${Object.keys(ALLOWED_MISSING_BINDINGS).length} allowlisted omission(s), ${stale.length} stale`);
  for (const ns of stale) detail(`${ns}: ${BINDINGS.has(ns) ? "now implemented" : "no longer referenced"} \u2014 drop it from ALLOWED_MISSING_BINDINGS`);
  for (const ns of missing.filter((n) => n in ALLOWED_MISSING_BINDINGS)) {
    console.log(`  \u25CB internalBinding('${ns}') \u2014 ${ALLOWED_MISSING_BINDINGS[ns]}`);
  }
}

section("primordial names \u2192 primordials.js");
{
  const primordialsPath = path.join(ROOT, "primordials.js");
  let primordials = null;
  let importErr = null;
  try {
    ({ primordials } = await import(pathToFileURL(primordialsPath).href));
  } catch (e) {
    importErr = e;
  }
  if (!primordials) {
    ok(false, "importing primordials.js failed \u2014 no primordial name could be checked");
    detail(String(importErr && importErr.message));
  } else {
    // Ask the real Proxy, so this tracks primordials.js's naming scheme exactly
    // rather than reimplementing it. `has` runs the same resolve() as `get`.
    const unresolved = [...primordialRefs.keys()].filter((n) => !Reflect.has(primordials, n)).sort();
    console.log(`  ${primordialRefs.size} name(s) destructured by lib/ + internal/`);
    ok(unresolved.length === 0, `${unresolved.length} unresolvable under the <Ns><Member> scheme`);
    for (const name of unresolved) {
      const sites = primordialRefs.get(name);
      console.log(`\n  UNRESOLVABLE PRIMORDIAL  ${name}`);
      const apis = [...new Set(sites.flatMap((s) => apisForSite(s)))].sort();
      detail(`breaks : ${apis.slice(0, 6).join(", ")}${apis.length > 6 ? `, +${apis.length - 6} more` : ""}`);
      detail("         (the whole module throws at load \u2014 primordials are destructured at the top)");
      for (const s of sites.slice(0, 6)) detail(`at     : ${s.file}:${s.line}  ${s.snippet}`);
      detail("fix    : add it to SPECIALS in packages/runtime/node/primordials.js, or make it derivable.");
    }
  }
}

// --- 6. verdict --------------------------------------------------------------
console.log("\nnot covered by this probe (static analysis only):");
console.log("  \u2022 a registered id whose factory throws at load, or whose exports lack the member the caller reads");
console.log("  \u2022 a primordial that resolves but is wrong when called (an unbound static resolves fine)");
console.log("  \u2022 missing MEMBERS of a present internalBinding namespace (e.g. internalBinding('util').getCallSites)");
console.log("  \u2022 anything outside packages/runtime/node/{lib,internal}");
console.log("  \u2192 run `npm run verify` / the spikes for those; see this file's header.");

console.log(`\nRESULT: ${failed ? "FAIL" : "PASS"} (${failed} check${failed === 1 ? "" : "s"} failed)`);
process.exit(failed ? 1 : 0);