// bun:test — the test runner, `expect`, the mock/spy family and snapshots.
//
// Split out of bun.js for the usual reason (that file is long) but also because a
// test runner is the one part of the shim where being *approximately* right is
// actively harmful: a matcher that is subtly wrong makes a green suite lie, and a
// suite is exactly what a team runs to decide whether this sandbox is trustworthy.
// So the rule in this file is stricter than elsewhere — every behaviour below was
// checked against a real `bun test` (1.3.6, d530ed99) and the surprising ones are
// reproduced with the observation written down at the call site. Where a shape
// could not be reproduced faithfully it throws rather than guessing.
//
// The pure halves — the `.each` title formatter, the snapshot serializer, the
// .snap file codec, the JUnit writer — are exported so scripts/spike-bun-offline.mjs
// can pin them byte-for-byte against output captured from the real binary, which
// is the rule the Bun section of AGENTS.md sets for anything with a defined answer.
//
// The Bun behaviours that are surprising enough to be worth knowing before you
// change anything here:
//
//   - `.only` THROWS when the CI environment variable is truthy ("disabled in CI
//     environments to prevent accidentally skipping tests"). A committed `.only`
//     would otherwise silently green a CI run over two tests, which is the same
//     class of bug the shim's own `test.only` had before Phase 0.
//   - Snapshot CREATION is likewise refused under CI unless --update-snapshots.
//   - `expect(alreadySettledPromise).rejects.toThrow()` returns UNDEFINED in Bun,
//     not a promise; Bun synchronously peeks the settled promise and throws. We
//     cannot peek (see bun-unsupported.js's Bun.peek), so ours always returns a
//     real promise AND is tracked by the runner, so a forgotten `await` still
//     fails the test. See asyncAssertions below.
//   - The `.each` title formatter substitutes `%s` only for STRINGS and `%d`/`%i`/
//     `%f` only for NUMBERS — a `%s` handed a number is left in the title as the
//     literal "%s" while still consuming the argument — and its `$property` pass
//     eats one extra character whenever the lookup misses. Both are upstream bugs
//     we reproduce, because the title is what `-t` filters and what keys a
//     snapshot. See formatEachTitle.
//   - A snapshot key joins describe blocks with a SPACE ("outer inner nested 1")
//     while the reporter joins them with " > ". They are not the same string.
//   - Object keys are SORTED in snapshot output, and getters are printed as
//     "[native code]" rather than being invoked.
//
// Everything here takes its host (`process`, a `require`, deepEquals/deepMatch)
// as an argument for the same reason bun-sqlite.js and bun-glob.js do: it is what
// lets the offline tier drive the SHIPPED code with no kernel under it.

// Jest's brand for asymmetric matchers. Third-party matcher libraries check this
// exact symbol, so use it rather than a private one.
const ASYMMETRIC = Symbol.for("jest.asymmetricMatcher");

// Bun's default per-test timeout (`bun test --help`: "default is 5000").
export const BUN_DEFAULT_TEST_TIMEOUT = 5000;

// The header real Bun writes at the top of a .snap file. We emit the identical
// one, and that is a deliberate compatibility claim: the serializer below is
// byte-exact against Bun 1.3.6 for every shape it agrees to serialize, and it
// throws instead of writing bytes for the shapes it cannot reproduce. A snapshot
// written here is meant to be readable by a real `bun test` and vice versa.
export const SNAPSHOT_HEADER = "// Bun Snapshot v1, https://bun.sh/docs/test/snapshots";

// ---- CI detection -----------------------------------------------------------
// Bun gates two behaviours on "am I in CI": `.only` throws, and a MISSING snapshot
// is a failure rather than something to create. Verified against the real binary:
// CI=true trips it; CI=false, CI=0 and an empty CI do not.
export function ciEnabled(env) {
  const v = env && env.CI;
  if (v === undefined || v === null) return false;
  const s = String(v).toLowerCase();
  return s !== "" && s !== "false" && s !== "0";
}

// ---- the snapshot / pretty-format serializer --------------------------------
// Bun's snapshot format, reproduced byte-for-byte. Every rule below is an
// observation from `bun test` 1.3.6, and scripts/spike-bun-offline.mjs pins each
// against the exact bytes that run produced.
//
// The one thing this does NOT do is guess. Two shapes are refused (see
// SNAPSHOT_UNSERIALIZABLE): a Map or a Set NESTED inside a container. Bun's own
// output for those is malformed in a way that is not even self-consistent — at
// depth 1 a nested Set is written as `"s":   \nSet {…}\n,` (two stray spaces, the
// count of which tracks the indent) while a nested Map at the same depth is
// written as `"m": \nMap {…}\n,` (none). There is no rule there to encode, and
// inventing tidier bytes would produce a .snap file that fails under real Bun —
// so this throws and names the shape instead. Both are fine at the TOP level.
const SNAPSHOT_UNSERIALIZABLE = (kind) =>
  `bun:test cannot snapshot a ${kind} nested inside an object or array: real Bun's ` +
  `own output for that shape is malformed (the indentation it emits differs between ` +
  `Map and Set at the same depth), so the Vivari shim refuses to write bytes that ` +
  `would not round-trip under a real \`bun test\`. Snapshot the ${kind} on its own ` +
  `(\`expect(theSet).toMatchSnapshot()\`) or assert it with toEqual instead.`;

// Bun prints a function's DECLARED name only: `function named(){}` is
// "[Function: named]" but `{ f: () => {} }` is plain "[Function]", even though the
// arrow's .name is "f" (JS infers it from the property). So read the name out of
// the source text rather than off .name, which is the only way to tell an inferred
// name from a written one.
function functionLabel(fn) {
  let src = "";
  try { src = Function.prototype.toString.call(fn); } catch { /* exotic callable */ }
  const m = /^\s*(?:async\s+)?(?:function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/.exec(src);
  return m ? `[Function: ${m[1]}]` : "[Function]";
}

function constructorPrefix(v) {
  const proto = Object.getPrototypeOf(v);
  if (proto === null || proto === Object.prototype) return "";
  const name = proto.constructor && proto.constructor.name;
  // An anonymous class gets no prefix at all — Bun prints its instance as a plain
  // object literal.
  return name && name !== "Object" ? name + " " : "";
}

function formatValue(v, indent, seen) {
  switch (typeof v) {
    case "undefined": return "undefined";
    case "boolean": return String(v);
    // String(-0) is "0", and a snapshot that cannot tell -0 from 0 is not a
    // snapshot. Bun prints "-0".
    case "number": return Object.is(v, -0) ? "-0" : String(v);
    case "bigint": return String(v) + "n";
    case "symbol": return v.toString();
    case "function": return functionLabel(v);
    // Raw, in quotes, with NOTHING escaped — the escaping happens once at the file
    // level (escapeSnapshotBody), because the value is embedded in a template
    // literal. A `"` inside the string is left alone.
    case "string": return '"' + v + '"';
    default: break;
  }
  if (v === null) return "null";
  if (seen.has(v)) return "[Circular]";

  const tag = Object.prototype.toString.call(v);
  if (tag === "[object Date]") return v.toISOString();
  if (tag === "[object RegExp]") return String(v);
  if (v instanceof Error) return `[${v.name}: ${v.message}]`;
  if (tag === "[object Promise]") return "Promise {}";

  seen.add(v);
  try {
    const inner = indent + "  ";
    if (v instanceof Map) {
      if (indent !== "") throw new Error(SNAPSHOT_UNSERIALIZABLE("Map"));
      const rows = [...v].map(([k, val]) => `${inner}${formatValue(k, inner, seen)} => ${formatValue(val, inner, seen)},`);
      return rows.length ? `Map {\n${rows.join("\n")}\n${indent}}` : "Map {}";
    }
    if (v instanceof Set) {
      if (indent !== "") throw new Error(SNAPSHOT_UNSERIALIZABLE("Set"));
      const rows = [...v].map((val) => `${inner}${formatValue(val, inner, seen)},`);
      return rows.length ? `Set {\n${rows.join("\n")}\n${indent}}` : "Set {}";
    }
    if (Array.isArray(v) || (ArrayBuffer.isView(v) && !(v instanceof DataView))) {
      // A typed array keeps its constructor name; a plain array does not. Holes in
      // a sparse array read as undefined, which is what Bun prints for them.
      const prefix = Array.isArray(v) ? "" : v.constructor.name + " ";
      if (v.length === 0) return prefix + "[]";
      const rows = [];
      for (let i = 0; i < v.length; i++) rows.push(childRow(inner, "", v[i], seen));
      return `${prefix}[\n${rows.join("\n")}\n${indent}]`;
    }
    const prefix = constructorPrefix(v);
    // Sorted, by plain codepoint order — Bun does not preserve insertion order
    // here, so neither can we.
    const keys = Object.keys(v).sort();
    if (keys.length === 0) return prefix + "{}";
    const rows = keys.map((k) => childRow(inner, '"' + k + '": ', propertyValue(v, k), seen));
    return `${prefix}{\n${rows.join("\n")}\n${indent}}`;
  } finally {
    seen.delete(v);
  }
}

// Bun does not invoke an own getter while serializing — it prints "[native code]".
// Reproducing that is not just fidelity: invoking a getter from a snapshot would
// run user code with side effects at assertion time.
const GETTER_PLACEHOLDER = { toString: () => "[native code]" };
function propertyValue(obj, key) {
  const d = Object.getOwnPropertyDescriptor(obj, key);
  if (d && !("value" in d)) return GETTER_PLACEHOLDER;
  return d ? d.value : obj[key];
}

// One line of a container's body. A child whose rendering spans lines but is not
// itself a container (i.e. a multi-line string) is emitted at column 0 followed by
// a lone `,` — that is Bun's own output, an off-by-one in its indent handling that
// is stable across depths, so it is reproduced rather than tidied.
function childRow(indent, label, value, seen) {
  if (value === GETTER_PLACEHOLDER) return `${indent}${label}[native code],`;
  const body = formatValue(value, indent, seen);
  if (typeof value === "string" && body.indexOf("\n") !== -1) {
    return `${indent}${label}\n${body}\n,`;
  }
  return `${indent}${label}${body},`;
}

// The public entry: Bun's pretty-format, used for snapshots and for `%p` in an
// `.each` title.
export function prettyFormat(value) {
  return formatValue(value, "", new Set());
}

// ---- .snap file codec -------------------------------------------------------
// A .snap file is executable CommonJS (`exports[\`key\`] = \`body\`;`), so both the
// key and the body are template-literal contexts: a backslash, a backtick or a
// `${` in the value has to be escaped or the file stops parsing.
export function escapeSnapshotBody(s) {
  return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
}
function unescapeSnapshotBody(s) {
  return s.replace(/\\(\\|`|\$\{)/g, "$1");
}

// A body that spans lines is stored with a newline immediately inside each
// backtick; a single-line one is stored inline. Reading has to undo exactly that.
function wrapSnapshotBody(body) {
  return body.indexOf("\n") === -1 ? body : "\n" + body + "\n";
}
function unwrapSnapshotBody(raw) {
  if (raw.startsWith("\n") && raw.endsWith("\n")) return raw.slice(1, -1);
  return raw;
}

export function parseSnapshotFile(text) {
  const out = new Map();
  const re = /exports\[`((?:[^`\\]|\\.)*)`\]\s*=\s*`((?:[^`\\]|\\.)*)`;/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.set(unescapeSnapshotBody(m[1]), unwrapSnapshotBody(unescapeSnapshotBody(m[2])));
  }
  return out;
}

export function formatSnapshotFile(entries) {
  // Bun writes the keys sorted, which is what keeps a .snap file's diff readable
  // when a test is added in the middle of a file.
  const keys = [...entries.keys()].sort();
  const body = keys
    .map((k) => `exports[\`${escapeSnapshotBody(k)}\`] = \`${escapeSnapshotBody(wrapSnapshotBody(entries.get(k)))}\`;`)
    .join("\n\n");
  return SNAPSHOT_HEADER + "\n\n" + body + "\n";
}

// An inline snapshot is written back into the source indented to the call site, so
// the stored text carries the file's indentation. Strip it before comparing, the
// way Jest's stripAddedIndentation does, or every inline snapshot inside a
// describe block would mismatch on whitespace alone.
export function dedentInlineSnapshot(s) {
  if (typeof s !== "string" || s.indexOf("\n") === -1) return s;
  const lines = s.split("\n");
  // Only a value that was written back by the tooling looks like this: an empty
  // first line, an all-whitespace last line, and the body between them. Anything
  // else is a hand-written string and must be compared verbatim.
  if (lines.length <= 2 || lines[0].trim() !== "" || lines[lines.length - 1].trim() !== "") return s;
  const body = lines.slice(1, -1);
  // The indentation is the one on the first line that has content — NOT the one on
  // the closing line, which sits at column 0 when the matcher call does.
  const first = body.find((l) => l.trim() !== "");
  const pad = first ? /^[ \t]*/.exec(first)[0] : "";
  if (!pad) return body.join("\n");
  if (!body.every((l) => l.trim() === "" || l.startsWith(pad))) return s;
  return body.map((l) => (l.startsWith(pad) ? l.slice(pad.length) : l)).join("\n");
}

// ---- `.each` title formatting -----------------------------------------------
// Bun's formatter, bugs included. Reproduced rather than corrected because the
// title IS the identity of a test here: `-t/--test-name-pattern` matches it and a
// snapshot is keyed by it, so a "nicer" title silently changes which tests run and
// which stored snapshots are found.
//
// printf pass (verified against bun 1.3.6):
//   %s   substitutes ONLY a string; anything else leaves the literal "%s" in the
//        title AND still consumes the argument.
//   %d %f substitute ONLY a number (1.7 → "1.7", NaN → "NaN").
//   %i   substitutes only an integer that JSC would hold as an int32 — 1.7 and
//        even -0 come back as the literal "%i", because -0 is stored as a double.
//   %j %o JSON.stringify (a Map therefore renders as "{}").
//   %p   pretty-format, which can be multi-line inside a test name.
//   %#   the row index; consumes no argument.  %%  a literal %; consumes none.
//   Anything else, or a token with no argument left, stays literal.
//
// $property pass: only for a row that is a non-array object. `$a.b` walks the
// path. When the lookup MISSES, Bun emits the literal `$path` and then swallows
// the NEXT character — "$ end" becomes "$end", "$a-b" becomes "$ab". That is an
// off-by-one in the upstream scanner; it is stable and load-bearing for names, so
// it is reproduced here.
export function formatEachTitle(title, row, index) {
  const args = Array.isArray(row) ? row : [row];
  let out = "";
  let arg = 0;
  const dollars = !Array.isArray(row) && row !== null && typeof row === "object";
  for (let i = 0; i < title.length; i++) {
    const c = title[i];
    if (c === "%" && i + 1 < title.length) {
      const tok = title[i + 1];
      if (tok === "%") { out += "%"; i++; continue; }
      if (tok === "#") { out += String(index); i++; continue; }
      if ("sdifjop".indexOf(tok) !== -1) {
        if (arg >= args.length) { out += c; continue; }
        const v = args[arg++];
        out += formatPrintfToken(tok, v);
        i++;
        continue;
      }
      out += c;
      continue;
    }
    if (c === "$" && dollars) {
      let j = i + 1;
      while (j < title.length && /[\w$.]/.test(title[j])) j++;
      const path = title.slice(i + 1, j);
      const found = lookupPath(row, path);
      if (found.ok) {
        out += typeof found.value === "string" ? found.value : prettyFormat(found.value);
        i = j - 1;
      } else {
        // The upstream off-by-one: emit `$path`, then skip one more character.
        out += "$" + path;
        i = j;
      }
      continue;
    }
    out += c;
  }
  return out;
}

function formatPrintfToken(tok, v) {
  switch (tok) {
    case "s": return typeof v === "string" ? v : "%s";
    case "d": case "f": return typeof v === "number" ? String(v) : "%" + tok;
    // JSC holds -0 and any non-int32 as a double, and Bun's %i wants an int32.
    case "i": return typeof v === "number" && Number.isInteger(v) && !Object.is(v, -0) && v >= -2147483648 && v <= 2147483647
      ? String(v) : "%i";
    case "j": case "o": {
      try { const s = JSON.stringify(v); return s === undefined ? "%" + tok : s; } catch { return "%" + tok; }
    }
    case "p": return prettyFormat(v);
    default: return "%" + tok;
  }
}

function lookupPath(row, path) {
  if (!path) return { ok: false };
  let cur = row;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || !(part in Object(cur))) return { ok: false };
    cur = cur[part];
  }
  return { ok: true, value: cur };
}

// ---- JUnit reporter ---------------------------------------------------------
// `--reporter=junit --reporter-outfile=<path>`. Real Bun also stamps each testcase
// with the source `line` and the runner's `hostname`; we have neither (no source
// positions through the loader's transform, no OS hostname in a tab), so those
// attributes are omitted rather than filled with a plausible-looking lie.
export function junitXml(files, meta) {
  const esc = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const secs = (ms) => (ms / 1000).toFixed(6);
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>'];
  const totals = { tests: 0, failures: 0, skipped: 0 };
  for (const f of files) {
    for (const c of f.cases) {
      totals.tests++;
      if (c.status === "fail") totals.failures++;
      else if (c.status !== "pass") totals.skipped++;
    }
  }
  lines.push(
    `<testsuites name="bun test" tests="${totals.tests}" assertions="0" failures="${totals.failures}" ` +
      `skipped="${totals.skipped}" time="${secs(meta.durationMs)}">`
  );
  for (const f of files) {
    const t = f.cases.length;
    const fails = f.cases.filter((c) => c.status === "fail").length;
    const skips = f.cases.filter((c) => c.status !== "pass" && c.status !== "fail").length;
    lines.push(
      `  <testsuite name="${esc(f.name)}" file="${esc(f.name)}" tests="${t}" assertions="0" ` +
        `failures="${fails}" skipped="${skips}" time="${secs(f.durationMs || 0)}">`
    );
    for (const c of f.cases) {
      const attrs =
        `name="${esc(c.name)}" classname="${esc(c.suite || "")}" time="${secs(c.durationMs || 0)}" ` +
        `file="${esc(f.name)}" assertions="0"`;
      if (c.status === "fail") {
        lines.push(`    <testcase ${attrs}>`);
        lines.push(`      <failure message="${esc(c.error || "failed")}" />`);
        lines.push("    </testcase>");
      } else if (c.status === "pass") {
        lines.push(`    <testcase ${attrs} />`);
      } else {
        lines.push(`    <testcase ${attrs}>`);
        lines.push(`      <skipped />`);
        lines.push("    </testcase>");
      }
    }
    lines.push("  </testsuite>");
  }
  lines.push("</testsuites>");
  return lines.join("\n") + "\n";
}

// ---- asymmetric matchers ----------------------------------------------------
class AsymmetricMatcher {
  constructor(label, match) {
    this.$$typeof = ASYMMETRIC;
    this._label = label;
    this._match = match;
  }
  asymmetricMatch(actual) { return !!this._match(actual); }
  toString() { return this._label; }
  toJSON() { return this._label; }
}
function isAsymmetric(v) {
  return !!v && typeof v === "object" && v.$$typeof === ASYMMETRIC && typeof v.asymmetricMatch === "function";
}
// Cheap pre-pass: if the expected side holds no asymmetric matcher anywhere we can
// hand the whole comparison to Bun.deepEquals, which is the implementation that is
// already pinned against Bun's documented loose/strict split. The hand-written walk
// below only has to be right for trees that DO contain one.
function containsAsymmetric(v, depth) {
  if (isAsymmetric(v)) return true;
  if (!v || typeof v !== "object" || (depth || 0) > 24) return false;
  if (Array.isArray(v)) return v.some((x) => containsAsymmetric(x, (depth || 0) + 1));
  if (v instanceof Map) { for (const x of v.values()) if (containsAsymmetric(x, (depth || 0) + 1)) return true; return false; }
  if (v instanceof Set) { for (const x of v) if (containsAsymmetric(x, (depth || 0) + 1)) return true; return false; }
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer || v instanceof Date || v instanceof RegExp) return false;
  return Object.keys(v).some((k) => containsAsymmetric(v[k], (depth || 0) + 1));
}

// ---- the runtime ------------------------------------------------------------
// host: { process, lazy(name) -> builtin, deepEquals, deepMatch }
export function createBunTest({ process, lazy, deepEquals, deepMatch }) {
  const fsOf = () => lazy("fs");
  const pathOf = () => lazy("path");

  // ---- equality, asymmetric-aware -------------------------------------------
  function equals(received, expected, strict) {
    if (isAsymmetric(expected)) return expected.asymmetricMatch(received);
    if (isAsymmetric(received)) return received.asymmetricMatch(expected);
    if (!containsAsymmetric(expected)) return deepEquals(received, expected, strict);
    return walkEquals(received, expected, strict);
  }
  // Only reached when `expected` holds an asymmetric matcher somewhere below, so
  // it needs to mirror deepEquals' container rules exactly far enough to reach it
  // and can delegate every leaf back.
  function walkEquals(a, b, strict) {
    if (isAsymmetric(b)) return b.asymmetricMatch(a);
    if (!containsAsymmetric(b)) return deepEquals(a, b, strict);
    if (a === null || typeof a !== "object" || b === null || typeof b !== "object") return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(b)) {
      if (strict && a.length !== b.length) return false;
      const n = Math.max(a.length, b.length);
      for (let i = 0; i < n; i++) if (!walkEquals(a[i], b[i], strict)) return false;
      return true;
    }
    if (b instanceof Map) {
      if (!(a instanceof Map) || a.size !== b.size) return false;
      for (const [k, v] of b) { if (!a.has(k)) return false; if (!walkEquals(a.get(k), v, strict)) return false; }
      return true;
    }
    if (b instanceof Set) {
      if (!(a instanceof Set) || a.size !== b.size) return false;
      const pool = [...a];
      for (const v of b) {
        const i = pool.findIndex((x) => walkEquals(x, v, strict));
        if (i === -1) return false;
        pool.splice(i, 1);
      }
      return true;
    }
    if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    const keys = (o) => (strict ? Object.keys(o) : Object.keys(o).filter((k) => o[k] !== undefined));
    const ka = keys(a), kb = keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of kb) {
      if (strict && !Object.prototype.hasOwnProperty.call(a, k)) return false;
      if (!walkEquals(a[k], b[k], strict)) return false;
    }
    return true;
  }
  function matchesObject(received, subset) {
    if (isAsymmetric(subset)) return subset.asymmetricMatch(received);
    if (!containsAsymmetric(subset)) return deepMatch(subset, received);
    if (subset === null || typeof subset !== "object") return equals(received, subset, false);
    if (received === null || typeof received !== "object") return false;
    if (Array.isArray(subset)) {
      if (!Array.isArray(received) || subset.length !== received.length) return false;
      return subset.every((v, i) => matchesObject(received[i], v));
    }
    if (Object.prototype.toString.call(subset) !== "[object Object]") return equals(received, subset, false);
    for (const k of Object.keys(subset)) {
      if (!(k in received)) return false;
      if (!matchesObject(received[k], subset[k])) return false;
    }
    return true;
  }

  // ---- mocks ----------------------------------------------------------------
  // Every spy is remembered so `mock.restore()` / `jest.restoreAllMocks()` can put
  // the originals back — without the registry those two are no-ops that look like
  // they worked, which is the failure mode this shim exists to avoid.
  const spies = [];
  const mockFns = [];

  function makeMockFn(impl) {
    const calls = [];
    const results = [];
    const instances = [];
    const contexts = [];
    const invocationCallOrder = [];
    // Queued one-shot behaviours, in FIFO order — mockReturnValueOnce et al.
    const onceImpls = [];
    let current = impl;
    let order = 0;

    const f = function (...args) {
      calls.push(args);
      contexts.push(this);
      instances.push(this);
      invocationCallOrder.push(++order);
      const use = onceImpls.length ? onceImpls.shift() : current;
      if (!use) { results.push({ type: "return", value: undefined }); return undefined; }
      try {
        const r = use.apply(this, args);
        results.push({ type: "return", value: r });
        return r;
      } catch (e) {
        // A throwing mock records `{type: "throw"}` — the old shim let the throw
        // escape without recording anything, so toHaveReturnedTimes counted it.
        results.push({ type: "throw", value: e });
        throw e;
      }
    };
    f.mock = { calls, results, instances, contexts, invocationCallOrder };
    Object.defineProperty(f.mock, "lastCall", { get: () => calls[calls.length - 1], enumerable: false });
    f._isMockFunction = true;
    f.mockClear = () => {
      calls.length = 0; results.length = 0; instances.length = 0;
      contexts.length = 0; invocationCallOrder.length = 0;
      return f;
    };
    f.mockReset = () => { current = undefined; onceImpls.length = 0; return f.mockClear(); };
    f.mockImplementation = (i) => { current = i; return f; };
    f.mockImplementationOnce = (i) => { onceImpls.push(i); return f; };
    f.mockReturnValue = (v) => { current = () => v; return f; };
    f.mockReturnValueOnce = (v) => { onceImpls.push(() => v); return f; };
    f.mockReturnThis = () => { current = function () { return this; }; return f; };
    f.mockResolvedValue = (v) => { current = () => Promise.resolve(v); return f; };
    f.mockResolvedValueOnce = (v) => { onceImpls.push(() => Promise.resolve(v)); return f; };
    f.mockRejectedValue = (v) => { current = () => Promise.reject(v); return f; };
    f.mockRejectedValueOnce = (v) => { onceImpls.push(() => Promise.reject(v)); return f; };
    f.mockName = (n) => { f._mockName = n; return f; };
    f.getMockName = () => f._mockName || "jest.fn()";
    mockFns.push(f);
    return f;
  }

  function spyOn(obj, method) {
    if (obj === null || obj === undefined) {
      throw new TypeError("spyOn(obj, method): obj must be an object");
    }
    const desc = findDescriptor(obj, method);
    if (!desc) {
      // Silently installing a spy on a method that does not exist means the
      // assertion "it was called" can never fire and nobody finds out why.
      throw new TypeError(`spyOn(obj, "${String(method)}"): property does not exist on the object`);
    }
    if (typeof desc.value !== "function") {
      throw new TypeError(`spyOn(obj, "${String(method)}"): property is not a function`);
    }
    const original = desc.value;
    const owned = Object.prototype.hasOwnProperty.call(obj, method);
    const mock = makeMockFn(function (...args) { return original.apply(this, args); });
    const restore = () => {
      // A method inherited from a prototype must be DELETED, not assigned back, or
      // the object keeps a own-property copy that shadows a later prototype patch.
      if (owned) Object.defineProperty(obj, method, { ...desc, value: original });
      else delete obj[method];
    };
    mock.mockRestore = () => { restore(); return mock; };
    Object.defineProperty(obj, method, { configurable: true, enumerable: desc.enumerable !== false, writable: true, value: mock });
    spies.push({ restore });
    return mock;
  }
  function findDescriptor(obj, key) {
    let cur = obj;
    while (cur) {
      const d = Object.getOwnPropertyDescriptor(cur, key);
      if (d) return d;
      cur = Object.getPrototypeOf(cur);
    }
    return null;
  }

  // ---- mock.module ----------------------------------------------------------
  // Replaces a module's exports in the loader's require cache, which is the same
  // object an `import` resolves through here (packages/runtime/esm.js compiles ESM
  // down to synchronous CJS). Resolution is relative to the test file currently
  // being loaded/run, which is what Bun does; `makeCwdRequire` would resolve
  // "./dep" against the process cwd and silently mock the wrong file for any test
  // that does not sit in the project root.
  function mockModule(specifier, factory) {
    if (typeof specifier !== "string") throw new TypeError("mock.module(specifier, factory): specifier must be a string");
    if (typeof factory !== "function") throw new TypeError("mock.module(specifier, factory): factory must be a function");
    const Module = lazy("module");
    // At module scope this is the file being loaded; inside a test body the loader
    // has already moved on, so fall back to the file the executing test came from.
    const from = (currentTest && currentTest.file) || currentFile || (process.cwd() + "/.");
    let resolved;
    try {
      resolved = Module._resolveFilename(specifier, { filename: from, id: from });
    } catch (e) {
      throw new Error(`mock.module("${specifier}"): could not resolve it from ${from} — ${(e && e.message) || e}`);
    }
    if (Module.isBuiltin && Module.isBuiltin(resolved)) {
      // Real Bun does not mock builtins either, but it fails SILENTLY (the require
      // returns the real module and the test quietly asserts against it). Throwing
      // is a deliberate divergence: a silent no-op here is exactly the "green suite
      // that lies" this file exists to prevent.
      throw new Error(
        `mock.module("${specifier}") cannot mock a builtin module. Real Bun silently ` +
          `leaves builtins unmocked; the Vivari shim refuses rather than letting the ` +
          `test assert against the real module. Inject the dependency instead, or ` +
          `spyOn(require("${specifier}"), "method").`
      );
    }
    const exports = factory();
    const mod = { id: resolved, filename: resolved, exports, loaded: true, children: [], paths: [] };
    Module._cache[resolved] = mod;
    return mod;
  }

  // ---- expect ---------------------------------------------------------------
  const customMatchers = Object.create(null);
  // `.resolves`/`.rejects` return a real Promise (Bun returns undefined for an
  // already-settled promise — it peeks, which no browser engine lets us do). The
  // runner drains this list after each test body so a MISSING `await` still fails
  // the test rather than passing silently, which is the whole risk of the async
  // matchers.
  let asyncAssertions = [];

  function expect(received) {
    const api = buildMatchers(received, false, null);
    api.not = buildMatchers(received, true, null);
    api.resolves = buildAsync(received, false, "resolves");
    api.resolves.not = buildAsync(received, true, "resolves");
    api.rejects = buildAsync(received, false, "rejects");
    api.rejects.not = buildAsync(received, true, "rejects");
    return api;
  }

  function buildAsync(received, negate, mode) {
    const target = {};
    for (const name of Object.keys(MATCHERS).concat(Object.keys(customMatchers))) {
      target[name] = (...args) => {
        const p = settleFor(received, mode).then((value) => {
          // `mode` travels with the matcher so toThrow knows that under `.rejects`
          // the received value IS the thrown thing rather than a function to call.
          buildMatchers(value, negate, mode)[name](...args);
        });
        asyncAssertions.push(p);
        return p;
      };
    }
    return target;
  }
  function settleFor(received, mode) {
    if (!received || typeof received.then !== "function") {
      // Bun's own message: `.rejects`/`.resolves` on a non-promise (a FUNCTION
      // returning one included — Bun rejects that, unlike Jest) is a usage error.
      return Promise.reject(new Error(`expect(received).${mode}: received value must be a promise, got ${typeOf(received)}`));
    }
    if (mode === "resolves") {
      return received.then(
        (v) => v,
        (e) => { throw new Error(`expected promise to resolve, but it rejected with ${fmt(e && e.message ? e.message : e)}`); }
      );
    }
    return received.then(
      (v) => { throw new Error(`expected promise to reject, but it resolved with ${fmt(v)}`); },
      // The rejection REASON is what the matcher then runs against, so
      // `.rejects.toThrow(msg)` gets the error and `.rejects.toBe(42)` gets 42.
      (e) => e
    );
  }

  function buildMatchers(received, negate, mode) {
    const self = {};
    const assert = (cond, message) => {
      const pass = negate ? !cond : cond;
      if (!pass) throw new Error((negate ? "[not] " : "") + message);
    };
    for (const [name, fn] of Object.entries(MATCHERS)) {
      self[name] = (...args) => fn({ received, negate, assert, self, mode }, ...args);
    }
    for (const [name, fn] of Object.entries(customMatchers)) {
      self[name] = (...args) => {
        const r = fn.call({ isNot: negate, equals: (a, b) => equals(a, b, false), utils: { printReceived: fmt, printExpected: fmt } }, received, ...args);
        if (!r || typeof r.pass !== "boolean") {
          throw new Error(`expect.extend: matcher "${name}" must return { pass, message }`);
        }
        const pass = negate ? !r.pass : r.pass;
        if (!pass) throw new Error(typeof r.message === "function" ? r.message() : String(r.message || `${name} failed`));
      };
    }
    return self;
  }

  // Every matcher takes the assertion context first. Keeping them in one table is
  // what lets `.resolves`/`.rejects` expose the identical set instead of the two
  // hand-picked matchers the old `.resolves` had.
  const MATCHERS = {
    toBe: (c, v) => c.assert(Object.is(c.received, v) || c.received === v, `expected ${fmt(c.received)} to be ${fmt(v)}`),
    toEqual: (c, v) => c.assert(equals(c.received, v, false), `expected ${fmt(c.received)} to equal ${fmt(v)}`),
    toStrictEqual: (c, v) => c.assert(equals(c.received, v, true), `expected ${fmt(c.received)} to strictly equal ${fmt(v)}`),
    toMatchObject: (c, subset) => c.assert(matchesObject(c.received, subset), `expected ${fmt(c.received)} to match object ${fmt(subset)}`),
    toBeTruthy: (c) => c.assert(!!c.received, `expected ${fmt(c.received)} to be truthy`),
    toBeFalsy: (c) => c.assert(!c.received, `expected ${fmt(c.received)} to be falsy`),
    toBeDefined: (c) => c.assert(c.received !== undefined, `expected value to be defined`),
    toBeUndefined: (c) => c.assert(c.received === undefined, `expected value to be undefined`),
    toBeNull: (c) => c.assert(c.received === null, `expected ${fmt(c.received)} to be null`),
    toBeNaN: (c) => c.assert(Number.isNaN(c.received), `expected ${fmt(c.received)} to be NaN`),
    toContain: (c, v) => c.assert(
      !!c.received && typeof c.received.includes === "function" && c.received.includes(v),
      `expected ${fmt(c.received)} to contain ${fmt(v)}`
    ),
    // toContain is identity (`includes`); toContainEqual is structural. Collapsing
    // the two is the classic way an array-of-objects assertion never fires.
    toContainEqual: (c, v) => c.assert(
      Array.isArray(c.received) && c.received.some((x) => equals(x, v, false)),
      `expected ${fmt(c.received)} to contain an element equal to ${fmt(v)}`
    ),
    toHaveLength: (c, n) => c.assert(!!c.received && c.received.length === n, `expected length ${c.received && c.received.length} to be ${n}`),
    toBeGreaterThan: (c, n) => c.assert(c.received > n, `expected ${fmt(c.received)} > ${n}`),
    toBeGreaterThanOrEqual: (c, n) => c.assert(c.received >= n, `expected ${fmt(c.received)} >= ${n}`),
    toBeLessThan: (c, n) => c.assert(c.received < n, `expected ${fmt(c.received)} < ${n}`),
    toBeLessThanOrEqual: (c, n) => c.assert(c.received <= n, `expected ${fmt(c.received)} <= ${n}`),
    toMatch: (c, re) => c.assert(
      typeof re === "string" ? String(c.received).includes(re) : re.test(c.received),
      `expected ${fmt(c.received)} to match ${re}`
    ),
    toBeInstanceOf: (c, C) => c.assert(c.received instanceof C, `expected value to be instanceof ${C && C.name}`),
    // Jest's rule, which is not the obvious one: the comparison is
    // |a-b| < 10^-digits / 2, and `digits` defaults to 2.
    toBeCloseTo: (c, n, digits) => {
      const d = digits === undefined ? 2 : digits;
      const diff = Math.abs(c.received - n);
      c.assert(diff < Math.pow(10, -d) / 2, `expected ${fmt(c.received)} to be close to ${n} (${d} digits, diff ${diff})`);
    },
    toHaveProperty: (c, keyPath, ...rest) => {
      const found = getPath(c.received, keyPath);
      if (rest.length === 0) {
        c.assert(found.ok, `expected ${fmt(c.received)} to have property ${fmt(keyPath)}`);
        return;
      }
      c.assert(found.ok && equals(found.value, rest[0], false), `expected property ${fmt(keyPath)} to equal ${fmt(rest[0])}`);
    },
    toThrow: (c, expected) => toThrowImpl(c, expected),
    toThrowError: (c, expected) => toThrowImpl(c, expected),
    // ---- mock/spy matchers ---------------------------------------------------
    toHaveBeenCalled: (c) => { const m = mockOf(c.received); c.assert(m.calls.length > 0, `expected mock to have been called`); },
    toHaveBeenCalledTimes: (c, n) => { const m = mockOf(c.received); c.assert(m.calls.length === n, `expected mock to have been called ${n} times, called ${m.calls.length}`); },
    toHaveBeenCalledWith: (c, ...args) => {
      const m = mockOf(c.received);
      c.assert(m.calls.some((call) => equals(call, args, false)), `expected mock to have been called with ${fmt(args)}, calls: ${fmt(m.calls)}`);
    },
    toHaveBeenLastCalledWith: (c, ...args) => {
      const m = mockOf(c.received);
      const last = m.calls[m.calls.length - 1];
      c.assert(m.calls.length > 0 && equals(last, args, false), `expected last call to be ${fmt(args)}, was ${fmt(last)}`);
    },
    toHaveBeenNthCalledWith: (c, n, ...args) => {
      const m = mockOf(c.received);
      // Jest/Bun number calls from 1, and an off-by-one here silently asserts the
      // wrong call rather than failing.
      const call = m.calls[n - 1];
      c.assert(m.calls.length >= n && equals(call, args, false), `expected call #${n} to be ${fmt(args)}, was ${fmt(call)}`);
    },
    toHaveReturned: (c) => { const m = mockOf(c.received); c.assert(m.results.some((r) => r.type === "return"), `expected mock to have returned`); },
    toHaveReturnedTimes: (c, n) => {
      const m = mockOf(c.received);
      const k = m.results.filter((r) => r.type === "return").length;
      c.assert(k === n, `expected mock to have returned ${n} times, returned ${k}`);
    },
    // ---- Bun's jest-extended-style type/shape matchers -----------------------
    toBeEmpty: (c) => c.assert(isEmpty(c.received), `expected ${fmt(c.received)} to be empty`),
    toBeArray: (c) => c.assert(Array.isArray(c.received), `expected ${fmt(c.received)} to be an array`),
    toBeArrayOfSize: (c, n) => c.assert(Array.isArray(c.received) && c.received.length === n, `expected an array of size ${n}`),
    toBeString: (c) => c.assert(typeof c.received === "string", `expected ${fmt(c.received)} to be a string`),
    toBeNumber: (c) => c.assert(typeof c.received === "number", `expected ${fmt(c.received)} to be a number`),
    toBeBoolean: (c) => c.assert(typeof c.received === "boolean", `expected ${fmt(c.received)} to be a boolean`),
    toBeFunction: (c) => c.assert(typeof c.received === "function", `expected ${fmt(c.received)} to be a function`),
    toBeObject: (c) => c.assert(!!c.received && typeof c.received === "object" && !Array.isArray(c.received), `expected ${fmt(c.received)} to be an object`),
    toBeNil: (c) => c.assert(c.received === null || c.received === undefined, `expected ${fmt(c.received)} to be null or undefined`),
    toBeTypeOf: (c, t) => c.assert(typeof c.received === t, `expected typeof ${fmt(c.received)} to be ${t}`),
    toBeInteger: (c) => c.assert(Number.isInteger(c.received), `expected ${fmt(c.received)} to be an integer`),
    toBeFinite: (c) => c.assert(Number.isFinite(c.received), `expected ${fmt(c.received)} to be finite`),
    toBeDate: (c) => c.assert(c.received instanceof Date, `expected ${fmt(c.received)} to be a Date`),
    toStartWith: (c, s) => c.assert(typeof c.received === "string" && c.received.startsWith(s), `expected ${fmt(c.received)} to start with ${fmt(s)}`),
    toEndWith: (c, s) => c.assert(typeof c.received === "string" && c.received.endsWith(s), `expected ${fmt(c.received)} to end with ${fmt(s)}`),
    toInclude: (c, s) => c.assert(typeof c.received === "string" && c.received.includes(s), `expected ${fmt(c.received)} to include ${fmt(s)}`),
    toBeOneOf: (c, list) => c.assert(Array.isArray(list) && list.some((v) => equals(c.received, v, false)), `expected ${fmt(c.received)} to be one of ${fmt(list)}`),
    toSatisfy: (c, pred) => c.assert(!!pred(c.received), `expected ${fmt(c.received)} to satisfy the predicate`),
    // ---- snapshots -----------------------------------------------------------
    toMatchSnapshot: (c, ...args) => snapshotMatch(c, args),
    toMatchInlineSnapshot: (c, ...args) => inlineSnapshotMatch(c, args),
  };

  function toThrowImpl(c, expected) {
    let threw = false;
    let err;
    if (c.mode === "rejects") {
      // Under `.rejects` the received value IS the rejection reason — which may be
      // a plain 42 — so there is nothing to call.
      threw = true;
      err = c.received;
    } else if (typeof c.received === "function") {
      try { c.received(); } catch (e) { threw = true; err = e; }
    } else {
      // A non-callable receiver is a usage error in Bun, not a silently passing
      // assertion: `expect(5).toThrow()` must not report "yes, 5 threw".
      throw new TypeError(`expect(received).toThrow(): received value must be a function, got ${typeOf(c.received)}`);
    }
    const message = err && err.message !== undefined ? String(err.message) : String(err);
    let ok = threw;
    let what = "";
    if (threw && expected !== undefined && expected !== null) {
      if (typeof expected === "string") { ok = message.includes(expected); what = ` containing ${fmt(expected)}`; }
      else if (expected instanceof RegExp) {
        // Master compared a RegExp with `includes("")`, i.e. every error matched
        // every pattern — an assertion that could not fail.
        ok = expected.test(message); what = ` matching ${expected}`;
      } else if (typeof expected === "function") { ok = err instanceof expected; what = ` of type ${expected.name}`; }
      else if (expected instanceof Error) {
        // An Error INSTANCE compares the message for EQUALITY, not containment —
        // the opposite of the string form, which is Jest's rule and Bun's.
        ok = message === String(expected.message); what = ` with message ${fmt(expected.message)}`;
      } else if (typeof expected === "object" && typeof expected.message === "string") {
        ok = message === expected.message; what = ` with message ${fmt(expected.message)}`;
      }
    }
    c.assert(ok, `expected function to throw${what}${threw ? `, threw ${fmt(message)}` : ""}`);
  }

  function mockOf(fn) {
    if (!fn || !fn.mock) {
      throw new TypeError("expect(received).toHaveBeenCalled*(): received value must be a mock or spy function");
    }
    return fn.mock;
  }

  // ---- snapshot state -------------------------------------------------------
  // One store per test FILE. Everything is read lazily and written once at the end
  // of the run, so a suite with no snapshots touches the filesystem not at all.
  const snapshotFiles = new Map();
  let snapshotCounters = new Map();
  let snapshotOptions = { update: false, ci: false };
  const snapshotStats = { added: 0, updated: 0, matched: 0 };

  function snapshotStore(file) {
    const path = pathOf();
    const snapPath = path.join(path.dirname(file), "__snapshots__", path.basename(file) + ".snap");
    let store = snapshotFiles.get(snapPath);
    if (!store) {
      let entries = new Map();
      try { entries = parseSnapshotFile(fsOf().readFileSync(snapPath, "utf8")); } catch { /* first run */ }
      store = { snapPath, entries, dirty: false };
      snapshotFiles.set(snapPath, store);
    }
    return store;
  }

  function snapshotKey(label, hint) {
    // The reporter joins describe blocks with " > "; a snapshot key joins them with
    // a plain space. Using the display label here would key every nested snapshot
    // under a name real Bun never writes.
    const base = label.split(" > ").join(" ");
    const named = hint ? `${base}: ${hint}` : base;
    const n = (snapshotCounters.get(named) || 0) + 1;
    snapshotCounters.set(named, n);
    return `${named} ${n}`;
  }

  function snapshotMatch(c, args) {
    if (!currentTest) throw new Error("toMatchSnapshot() can only be used inside a test");
    if (!currentTest.file) {
      throw new Error(
        "toMatchSnapshot() needs to know which file the test came from, and this " +
          "runner was driven directly rather than by `bun test`. Use " +
          "toMatchInlineSnapshot(`…`) or run the suite with `bun test`."
      );
    }
    const hint = typeof args[0] === "string" ? args[0] : undefined;
    const body = prettyFormat(c.received);
    const store = snapshotStore(currentTest.file);
    const key = snapshotKey(currentTest.label, hint);
    const existing = store.entries.get(key);
    if (existing === undefined || snapshotOptions.update) {
      if (existing === undefined && snapshotOptions.ci && !snapshotOptions.update) {
        // Bun's rule, and a good one: a CI run must not silently CREATE the
        // snapshot it is meant to be checking against, or the first green build
        // proves nothing.
        throw new Error(
          "Snapshot creation is disabled in CI environments unless --update-snapshots is used.\n" +
            "To override, set the environment variable CI=false.\nReceived: " + body
        );
      }
      store.entries.set(key, body);
      store.dirty = true;
      if (existing === undefined) snapshotStats.added++; else if (existing !== body) snapshotStats.updated++;
      return;
    }
    snapshotStats.matched++;
    c.assert(existing === body, `snapshot ${fmt(key)} did not match\n--- stored ---\n${existing}\n--- received ---\n${body}`);
  }

  function inlineSnapshotMatch(c, args) {
    const expected = args.find((a) => typeof a === "string" && (a.indexOf("\n") !== -1 || args.length === 1));
    const body = prettyFormat(c.received);
    if (args.length === 0) {
      // Bun rewrites the source file to insert the snapshot. Doing that needs an
      // exact call-site position, and ours would come from a stack frame pointing
      // at loader-transformed source (typescript-transform.js strips types before
      // the file is compiled), so an insertion could land in the wrong place and
      // corrupt the user's test. Refuse rather than risk it.
      throw new Error(
        "toMatchInlineSnapshot() with no argument would have to WRITE the snapshot " +
          "back into your test file, which the Vivari shim does not do: it has no " +
          "reliable source position for the call (the loader transpiles TS/JSX before " +
          "compiling, so stack columns do not point at your source). Use " +
          "toMatchSnapshot() for file-backed snapshots, or paste the value in:\n" +
          "  .toMatchInlineSnapshot(`\n" + body.replace(/^/gm, "  ") + "\n`)"
      );
    }
    const want = dedentInlineSnapshot(expected === undefined ? String(args[0]) : expected);
    snapshotStats.matched++;
    c.assert(want === body, `inline snapshot did not match\n--- expected ---\n${want}\n--- received ---\n${body}`);
  }

  // ---- expect's statics -----------------------------------------------------
  expect.any = (Ctor) =>
    new AsymmetricMatcher(`Any<${(Ctor && Ctor.name) || String(Ctor)}>`, (actual) => {
      // `expect.any(String)` has to match both a primitive and its wrapper, which a
      // bare instanceof does not.
      if (Ctor === String) return typeof actual === "string" || actual instanceof String;
      if (Ctor === Number) return typeof actual === "number" || actual instanceof Number;
      if (Ctor === Boolean) return typeof actual === "boolean" || actual instanceof Boolean;
      if (Ctor === BigInt) return typeof actual === "bigint";
      if (Ctor === Symbol) return typeof actual === "symbol";
      if (Ctor === Function) return typeof actual === "function";
      if (Ctor === Object) return actual !== null && typeof actual === "object";
      return actual instanceof Ctor;
    });
  expect.anything = () => new AsymmetricMatcher("Anything", (actual) => actual !== null && actual !== undefined);
  expect.objectContaining = (subset) =>
    new AsymmetricMatcher("ObjectContaining", (actual) =>
      !!actual && typeof actual === "object" && Object.keys(subset).every((k) => k in actual && equals(actual[k], subset[k], false))
    );
  expect.arrayContaining = (list) =>
    new AsymmetricMatcher("ArrayContaining", (actual) =>
      Array.isArray(actual) && list.every((v) => actual.some((x) => equals(x, v, false)))
    );
  expect.stringContaining = (s) => new AsymmetricMatcher("StringContaining", (actual) => typeof actual === "string" && actual.includes(s));
  expect.stringMatching = (re) =>
    new AsymmetricMatcher("StringMatching", (actual) => typeof actual === "string" && (typeof re === "string" ? actual.includes(re) : re.test(actual)));
  expect.closeTo = (n, digits) =>
    new AsymmetricMatcher("CloseTo", (actual) => typeof actual === "number" && Math.abs(actual - n) < Math.pow(10, -(digits === undefined ? 2 : digits)) / 2);
  expect.not = {
    objectContaining: (subset) => negated(expect.objectContaining(subset)),
    arrayContaining: (list) => negated(expect.arrayContaining(list)),
    stringContaining: (s) => negated(expect.stringContaining(s)),
    stringMatching: (re) => negated(expect.stringMatching(re)),
    closeTo: (n, d) => negated(expect.closeTo(n, d)),
  };
  function negated(m) {
    return new AsymmetricMatcher("Not<" + m._label + ">", (actual) => !m.asymmetricMatch(actual));
  }
  expect.extend = (matchers) => {
    for (const [name, fn] of Object.entries(matchers || {})) {
      if (typeof fn !== "function") throw new TypeError(`expect.extend: "${name}" must be a function`);
      customMatchers[name] = fn;
    }
  };

  // ---- registration ---------------------------------------------------------
  const suites = [];
  const rootHooks = { beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] };
  let current = null;
  let hasOnly = false;
  // The file the CLI is currently require()-ing (or, during the run, the file the
  // executing test came from). Snapshots and mock.module resolution both key off it.
  let currentFile = null;
  let currentTest = null;

  function emptyHooks() { return { beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] }; }

  // Bun throws on `.only` when CI is truthy: a committed `.only` would otherwise
  // narrow a CI run to two tests and report success. Checked at REGISTRATION, like
  // Bun, so the file fails to load rather than reporting a suspiciously small run.
  function assertOnlyAllowed() {
    if (ciEnabled(process.env)) {
      throw new Error(
        ".only is disabled in CI environments to prevent accidentally skipping tests. " +
          "To override, set the environment variable CI=false."
      );
    }
  }

  function addSuite(name, fn, mode) {
    const parent = current;
    // A describe inside a skipped/todo describe cannot be more selected than its
    // parent, so the mode is inherited downward at registration time.
    const inherited = parent && parent.mode !== "run" ? parent.mode : mode;
    const suite = {
      name, tests: [], children: [], hooks: emptyHooks(), parent,
      mode: inherited, only: mode === "only", file: currentFile,
    };
    if (mode === "only") hasOnly = true;
    (parent ? parent.children : suites).push(suite);
    if (suite.mode === "todo" && typeof fn !== "function") return suite;
    current = suite;
    try { if (fn) fn(); } finally { current = parent; }
    return suite;
  }

  const describe = (name, fn) => addSuite(name, fn, "run");
  describe.skip = (name, fn) => addSuite(name, fn, "skip");
  describe.todo = (name, fn) => addSuite(name, fn, "todo");
  describe.only = (name, fn) => { assertOnlyAllowed(); return addSuite(name, fn, "only"); };
  describe.if = (cond) => (name, fn) => addSuite(name, fn, cond ? "run" : "skip");
  describe.skipIf = (cond) => (name, fn) => addSuite(name, fn, cond ? "skip" : "run");
  describe.todoIf = (cond) => (name, fn) => addSuite(name, fn, cond ? "todo" : "run");
  describe.each = (table) => (title, fn) =>
    table.forEach((row, i) => addSuite(formatEachTitle(title, row, i), () => fn(...(Array.isArray(row) ? row : [row])), "run"));

  // Bun's public third argument is `number | { timeout, retry, repeats }` — NOT the
  // {skip, only} bag the old shim read, which is why registration options are a
  // separate, private argument.
  function normalizeTestOptions(opts) {
    if (typeof opts === "number") return { timeout: opts };
    if (opts && typeof opts === "object") {
      return { timeout: opts.timeout, retry: opts.retry, repeats: opts.repeats };
    }
    return {};
  }

  function addTest(name, fn, opts, reg) {
    const o = normalizeTestOptions(opts);
    const mode = (reg && reg.mode) || (current && current.mode !== "run" ? current.mode : "run");
    const t = {
      name, fn,
      mode: current && current.mode !== "run" ? current.mode : mode,
      only: !!(reg && reg.only),
      failing: !!(reg && reg.failing),
      timeout: typeof o.timeout === "number" ? o.timeout : null,
      retry: typeof o.retry === "number" ? o.retry : 0,
      repeats: typeof o.repeats === "number" ? o.repeats : 0,
      file: currentFile,
    };
    if (t.only) hasOnly = true;
    if (current) current.tests.push(t);
    else suites.push({ name: "", tests: [t], children: [], hooks: emptyHooks(), mode: "run", file: currentFile });
    return t;
  }

  const test = (name, fn, opts) => addTest(name, fn, opts);
  test.skip = (name, fn, opts) => addTest(name, fn, opts, { mode: "skip" });
  test.todo = (name, fn, opts) => addTest(name, fn || (() => {}), opts, { mode: "todo" });
  test.only = (name, fn, opts) => { assertOnlyAllowed(); return addTest(name, fn, opts, { only: true }); };
  test.failing = (name, fn, opts) => addTest(name, fn, opts, { failing: true });
  test.if = (cond) => (name, fn, opts) => addTest(name, fn, opts, cond ? {} : { mode: "skip" });
  test.skipIf = (cond) => (name, fn, opts) => addTest(name, fn, opts, cond ? { mode: "skip" } : {});
  test.todoIf = (cond) => (name, fn, opts) => addTest(name, fn, opts, cond ? { mode: "todo" } : {});
  test.each = (table) => (title, fn, opts) =>
    table.forEach((row, i) =>
      addTest(formatEachTitle(title, row, i), () => fn(...(Array.isArray(row) ? row : [row])), opts)
    );
  const it = test;

  const hook = (kind) => (fn) => { (current ? current.hooks[kind] : rootHooks[kind]).push(fn); };

  const mock = (impl) => makeMockFn(impl);
  mock.module = mockModule;
  mock.restore = () => { while (spies.length) spies.pop().restore(); };
  mock.clearAllMocks = () => { for (const f of mockFns) f.mockClear(); };

  // ---- the run --------------------------------------------------------------
  async function runOne(t, label) {
    const started = now();
    const timeout = t.timeout != null ? t.timeout : runOptions.timeout;
    currentTest = { label, file: t.file };
    let error = null;
    try {
      const r = t.fn();
      if (r && typeof r.then === "function") {
        // An async body can genuinely be abandoned at the deadline. A synchronous
        // one cannot be interrupted by anything in JavaScript — real Bun does not
        // interrupt it either (a 200ms sync loop under `--timeout 50` runs to
        // completion and is THEN reported as timed out), so the post-hoc elapsed
        // check below is faithful, not a shortcut.
        await Promise.race([r, timeoutPromise(timeout, label)]);
      }
      const drained = asyncAssertions;
      asyncAssertions = [];
      // A `.resolves`/`.rejects` the test forgot to await is still an assertion the
      // test made; failing it here is what stops a missing `await` from turning a
      // red test green.
      await Promise.all(drained);
    } catch (e) {
      error = e;
      asyncAssertions = [];
    } finally {
      currentTest = null;
    }
    const elapsed = now() - started;
    if (!error && elapsed > timeout) error = new Error(`this test timed out after ${timeout}ms.`);
    return { error, durationMs: elapsed };
  }

  function timeoutPromise(ms, label) {
    return new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`this test timed out after ${ms}ms.`)), ms);
      if (timer && typeof timer.unref === "function") timer.unref();
    });
  }
  function now() { return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now(); }

  let runOptions = { timeout: BUN_DEFAULT_TEST_TIMEOUT };

  async function run(options) {
    const opts = options || {};
    runOptions = { timeout: typeof opts.timeout === "number" ? opts.timeout : BUN_DEFAULT_TEST_TIMEOUT };
    snapshotOptions = { update: !!opts.updateSnapshots, ci: ciEnabled(process.env) };
    const pattern = opts.testNamePattern
      ? (opts.testNamePattern instanceof RegExp ? opts.testNamePattern : new RegExp(opts.testNamePattern))
      : null;
    const bail = typeof opts.bail === "number" && opts.bail > 0 ? opts.bail : 0;
    const runTodo = !!opts.todo;
    const dots = opts.reporter === "dots";
    const quiet = opts.reporter === "junit";
    const startedAt = now();

    let pass = 0, fail = 0, skip = 0, todo = 0, filtered = 0;
    let bailed = false;
    const junitFiles = new Map();
    const write = (s) => { if (!quiet) process.stdout.write(s); };

    // `--only` means "run ONLY the tests marked .only" even when none is marked,
    // in which case the right answer is an empty run. Treating the flag as a no-op
    // would run the whole suite under a flag asking for the opposite.
    const onlyMode = hasOnly || !!opts.only;
    const focused = (t, suite) => (onlyMode ? t.only || suiteIsOnly(suite) : true);
    const suiteIsOnly = (s) => { for (let c = s; c; c = c.parent) if (c.only) return true; return false; };
    const anySelected = (s) => s.tests.some((t) => focused(t, s)) || s.children.some(anySelected);

    const record = (t, name, suiteName, status, durationMs, errorMessage) => {
      const file = t.file || "(inline)";
      if (!junitFiles.has(file)) junitFiles.set(file, { name: file, cases: [], durationMs: 0 });
      const f = junitFiles.get(file);
      f.cases.push({ name, suite: suiteName, status, durationMs, error: errorMessage });
      f.durationMs += durationMs || 0;
    };

    const runSuite = async (suite, prefix, outerBefore, outerAfter) => {
      if (bailed || !anySelected(suite)) return;
      const beforeEach = outerBefore.concat(suite.hooks.beforeEach);
      const afterEach = suite.hooks.afterEach.concat(outerAfter);
      let ranBeforeAll = false;
      const ensureBeforeAll = async () => {
        if (ranBeforeAll) return;
        ranBeforeAll = true;
        for (const fn of suite.hooks.beforeAll) await fn();
      };
      for (const t of suite.tests) {
        if (bailed) break;
        if (!focused(t, suite)) continue;
        const label = (prefix ? prefix + " > " : "") + t.name;
        if (pattern && !pattern.test(label)) { filtered++; continue; }
        if (t.mode === "todo" && !runTodo) { todo++; write("  \u25CB " + label + " (todo)\n"); record(t, t.name, prefix, "todo", 0); continue; }
        if (t.mode === "skip") { skip++; write("  - " + label + " (skipped)\n"); record(t, t.name, prefix, "skip", 0); continue; }
        // A suite's beforeAll must not run for a suite whose tests are all skipped
        // or filtered out, so it is deferred to the first test that really runs.
        await ensureBeforeAll();

        // repeats: N runs the test N+1 times and every run has to pass.
        // retry: N re-runs a FAILING test up to N more times before giving up.
        const runs = (t.repeats || 0) + 1;
        let result = null;
        for (let r = 0; r < runs; r++) {
          let attempt = null;
          for (let a = 0; a <= (t.retry || 0); a++) {
            for (const fn of beforeEach) await fn();
            attempt = await runOne(t, label);
            for (const fn of afterEach) await fn();
            if (!attempt.error) break;
          }
          result = attempt;
          if (attempt.error) break;
        }
        let error = result.error;
        if (t.failing) {
          // `.failing` inverts the verdict, and Bun's message for the inversion is
          // worth keeping: a test that starts passing is a signal, not a success.
          error = error ? null : new Error("this test is marked as failing but it passed. Remove `.failing` if tested behavior now works");
        }
        if (error) {
          fail++;
          write("  \u2717 " + label + "\n    " + ((error && error.message) || error) + "\n");
          record(t, t.name, prefix, "fail", result.durationMs, (error && error.message) || String(error));
          if (bail && fail >= bail) { bailed = true; break; }
        } else {
          pass++;
          write(dots ? "." : "  \u2713 " + label + "\n");
          record(t, t.name, prefix, "pass", result.durationMs);
        }
      }
      for (const child of suite.children) {
        if (bailed) break;
        await ensureBeforeAll();
        await runSuite(child, (prefix ? prefix + " > " : "") + child.name, beforeEach, afterEach);
      }
      if (ranBeforeAll) for (const fn of suite.hooks.afterAll) await fn();
    };

    for (const fn of rootHooks.beforeAll) await fn();
    for (const s of suites) {
      if (bailed) break;
      await runSuite(s, s.name, rootHooks.beforeEach, rootHooks.afterEach);
    }
    for (const fn of rootHooks.afterAll) await fn();

    // Snapshots are written once, at the end — a suite that adds none never opens
    // the filesystem.
    for (const store of snapshotFiles.values()) {
      if (!store.dirty) continue;
      const fs = fsOf(), path = pathOf();
      try { fs.mkdirSync(path.dirname(store.snapPath), { recursive: true }); } catch { /* exists */ }
      fs.writeFileSync(store.snapPath, formatSnapshotFile(store.entries));
    }

    if (dots) write("\n");
    const parts = [pass + " pass"];
    if (skip) parts.push(skip + " skip");
    if (todo) parts.push(todo + " todo");
    if (filtered) parts.push(filtered + " filtered out");
    parts.push(fail + " fail");
    write("\n " + parts.join(", ") + "\n");
    if (snapshotStats.added || snapshotStats.updated) {
      write(" snapshots: " + (snapshotStats.added ? "+" + snapshotStats.added + " added" : "") +
        (snapshotStats.added && snapshotStats.updated ? ", " : "") +
        (snapshotStats.updated ? snapshotStats.updated + " updated" : "") + "\n");
    }
    if (bailed) write(" Bailed out after " + fail + " failure" + (fail === 1 ? "" : "s") + "\n");

    if (opts.reporter === "junit") {
      if (!opts.reporterOutfile) throw new Error("--reporter=junit requires --reporter-outfile=<path>");
      fsOf().writeFileSync(opts.reporterOutfile, junitXml([...junitFiles.values()], { durationMs: now() - startedAt }));
    }
    // A -t that matched nothing is an error in Bun (exit 1), not an empty green
    // run — the usual cause is a typo in the pattern.
    if (pattern && pass + fail === 0 && filtered > 0) {
      process.stderr.write(`error: regex "${pattern.source}" matched 0 tests (${filtered} filtered out)\n`);
      return 1;
    }
    return fail === 0 ? 0 : 1;
  }

  return {
    describe, test, it, expect,
    beforeAll: hook("beforeAll"), afterAll: hook("afterAll"),
    beforeEach: hook("beforeEach"), afterEach: hook("afterEach"),
    mock, spyOn,
    jest: {
      fn: (impl) => makeMockFn(impl),
      spyOn,
      restoreAllMocks: () => mock.restore(),
      clearAllMocks: () => mock.clearAllMocks(),
    },
    setSystemTime: () => {
      throw new Error(
        "bun:test setSystemTime() is not implemented in the Vivari shim: the runtime " +
          "has no clock seam to override (Date and performance.now come straight from " +
          "the host worker). Inject a clock, or stub Date.now with spyOn(Date, 'now')."
      );
    },
    // Told by `bun test` which file it is about to load, so a test can be traced
    // back to its file for snapshots, mock.module resolution and JUnit output.
    __setFile(file) { currentFile = file; },
    __run: run,
  };

  function isEmpty(v) {
    if (v === null || v === undefined) return true;
    if (typeof v === "string" || Array.isArray(v)) return v.length === 0;
    if (v instanceof Map || v instanceof Set) return v.size === 0;
    if (typeof v === "object") return Object.keys(v).length === 0;
    return false;
  }
}

// ---- shared helpers ---------------------------------------------------------
function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
function fmt(v) {
  try {
    const s = JSON.stringify(v);
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
}
// toHaveProperty takes either "a.b.c" or ["a", "b", 1]; the ARRAY form is the only
// way to reach a key that itself contains a dot, so the two are not interchangeable.
function getPath(obj, keyPath) {
  const parts = Array.isArray(keyPath) ? keyPath : String(keyPath).split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return { ok: false };
    if (!(p in Object(cur))) return { ok: false };
    cur = cur[p];
  }
  return { ok: true, value: cur };
}