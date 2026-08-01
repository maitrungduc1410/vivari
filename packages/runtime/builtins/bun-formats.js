// Bun's data-format APIs: `Bun.YAML`, `Bun.TOML`, `Bun.JSON5`, `Bun.JSONL` and
// `Bun.semver`. All pure computation — no VFS, no kernel, no network — which is
// why they can be shim'd at full fidelity rather than approximated.
//
// Why this is a separate file and not more of builtins/bun.js (which is where the
// conventions say a `Bun.*` member goes): bun.js is already ~1100 lines and three
// coverage batches are landing at once. Everything below is self-contained
// format handling with no shared state, so it costs nothing to lift out and it
// keeps the diff off the shared object literal. bun.js imports the one factory.
//
// The theme of this file is that a stock JS parser is NOT a drop-in for Bun's.
// Bun's parsers are Rust/C++ and have documented behaviours the popular npm
// libraries get differently — a TOML integer that must throw rather than round, a
// YAML schema that must not coerce a date, an error contract that is deliberately
// asymmetric between two functions on the same object. Each of those is spelled
// out at its call site below, and each has a regression check in
// scripts/spike-bun-offline.mjs. Being 95% right here is the failure mode this
// whole batch exists to avoid: it means code passes in the sandbox and returns a
// different value under real Bun, with nothing in the run to say so.
//
// Vendoring: YAML, TOML and JSON5 are REAL libraries bundled with esbuild into
// self-contained factories under ../node/vendor/ (same precedent as
// node/vendor/semver.js — see those headers for `package@version`, the license and
// the exact regenerate command). JSONL is hand-written, because its whole surface
// is "split on newlines and JSON.parse each one" and the only hard part is the
// error contract, which no library implements anyway. `Bun.semver` reuses the
// already-vendored node-semver rather than adding a second copy.

import jsYamlFactory from "../node/vendor/js-yaml.js";
import json5Factory from "../node/vendor/json5.js";
import smolTomlFactory from "../node/vendor/smol-toml.js";
import semverFactory from "../node/vendor/semver.js";

// ---- vendor instantiation ---------------------------------------------------
// The vendored bundles are factories, so importing one costs a function
// reference and nothing else; the bundle body does not run until it is called.
// That preserves the spirit of bun.js's `const lazy = (name) => require(name)`
// rule — a process that never parses YAML never pays for js-yaml — while still
// being a static import, which is what lets scripts/spike-bun-offline.mjs reach
// this code with plain Node and no kernel.
//
// Note on `Bun.semver`: `require("semver")` DOES resolve in-VM (loader.js
// registers the same vendored bundle as a lazy builtin), but it does not resolve
// in the offline spike, whose `require` is Node's own `createRequire`. Going
// through the factory means the tested path and the shipped path are the same
// one, and it still adds no second copy of the library.
function instantiate(factory, process) {
  const module = { exports: {} };
  // These bundles are `esbuild --bundle`d, so nothing reaches the `require`
  // parameter. Throwing rather than passing a real require keeps that a
  // checkable invariant instead of a silent fallback to the host's resolver.
  const noRequire = (name) => {
    throw new Error("vendored bundle unexpectedly required '" + name + "'");
  };
  factory(module.exports, noRequire, module, process);
  return module.exports;
}

export function createBunFormats({ process }) {
  const memo = new Map();
  const vendor = (factory) => {
    let mod = memo.get(factory);
    if (!mod) {
      mod = instantiate(factory, process);
      memo.set(factory, mod);
    }
    return mod;
  };

  // ---- Bun.YAML --------------------------------------------------------------
  // Bun's YAML parser is Rust and targets YAML 1.2; js-yaml's DEFAULT_SCHEMA is
  // YAML 1.1, and the difference is not academic. Under 1.1, `expires: 2030-01-01`
  // resolves to a JS Date and `debug: yes` resolves to `true`; under 1.2 both stay
  // strings. A config file read through the wrong schema therefore parses "fine"
  // and hands the app a different type than production would. So the schema is
  // CORE_SCHEMA (1.2 core) explicitly, plus the merge type — `<<: *defaults` is
  // not in 1.2 core, but Bun's own documentation demonstrates it, so it stays.
  let yamlSchema = null;
  const jsYaml = () => {
    const yaml = vendor(jsYamlFactory);
    if (!yamlSchema) yamlSchema = yaml.CORE_SCHEMA.extend({ implicit: [yaml.types.merge] });
    return yaml;
  };

  // Multi-document input returns an ARRAY of documents; single-document input
  // returns the document itself. This is documented Bun behaviour and it is a
  // shape change, not a formatting detail — a caller that assumes one or the
  // other breaks the moment a `---` separator appears in the file.
  function yamlParse(text) {
    const yaml = jsYaml();
    let docs;
    try {
      docs = yaml.loadAll(requireText(text, "Bun.YAML.parse"), { schema: yamlSchema });
    } catch (err) {
      throw asSyntaxError(err);
    }
    // Bun's docs do not say what an input with no document at all produces, so
    // this follows js-yaml's own `load("")` and returns undefined. A document
    // that exists but is empty (comments only) keeps YAML's answer of null.
    if (docs.length === 0) return undefined;
    return docs.length === 1 ? docs[0] : docs;
  }

  // ---- Bun.TOML --------------------------------------------------------------
  // smol-toml already matches Bun on the two behaviours that most TOML libraries
  // get differently (see ../node/vendor/smol-toml.js): an integer outside
  // +/-(2^53 - 1) throws instead of quietly becoming a lossy float, and — via a
  // one-line patch there — date/times come back as their source text rather than
  // as Date objects. Both are what Bun documents.
  const smolToml = () => vendor(smolTomlFactory);

  function tomlParse(text) {
    try {
      return smolToml().parse(requireText(text, "Bun.TOML.parse"));
    } catch (err) {
      throw asSyntaxError(err);
    }
  }

  // smol-toml's `stringify` produces Bun's documented layout byte-for-byte
  // (scalars, then [table], then [[array-of-tables]]), but disagrees with Bun on
  // four value-level rules, in both directions: it skips `null` and emits BigInt
  // as a plain integer where Bun throws, and it throws on function/symbol values
  // where Bun skips them. Normalising the input first is cheaper and clearer than
  // patching the bundle in four places, and it lets the circular-reference case
  // say "circular reference" instead of "maximum object depth exceeded".
  function tomlStringify(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Bun.TOML.stringify expects an object (a TOML document is a table)");
    }
    return smolToml().stringify(normalizeForToml(value, new Set(), false));
  }

  // ---- Bun.JSON5 -------------------------------------------------------------
  // Used unwrapped. json5 is the reference implementation, passes the same
  // official test suite Bun documents passing, throws a real SyntaxError, and its
  // `stringify` already emits Bun's exact output — unquoted identifier keys,
  // single-quoted strings, a trailing comma per line when `space` is given, and
  // Infinity/NaN literally rather than as JSON's `null`.
  const json5 = () => vendor(json5Factory);

  // ---- Bun.JSONL -------------------------------------------------------------
  // Hand-written: the format is one JSON value per line, so the parsing is
  // JSON.parse in a loop and all the design is in the error contract, which is
  // deliberately asymmetric between the two entry points and which no npm JSONL
  // library reproduces:
  //
  //   parse()      throws ONLY if zero values parsed. If line 900 of 1000 is
  //                corrupt you get 899 values back and no exception at all.
  //   parseChunk() NEVER throws for a parse error. It reports it in the returned
  //                {values, read, done, error}, because a chunk boundary in the
  //                middle of a value is normal for a stream and must not be fatal.
  //
  // Implementing both on one error strategy silently breaks whichever one it is
  // not. Both directions have a regression check in the offline spike.
  const jsonl = {
    parse(input, start, end) {
      const r = scanJsonl(input, start, end, true, "Bun.JSONL.parse");
      // The asymmetry, in one line: a partial result is a result.
      if (r.error && r.values.length === 0) throw r.error;
      return r.values;
    },
    parseChunk(input, start, end) {
      return scanJsonl(input, start, end, false, "Bun.JSONL.parseChunk");
    },
  };

  // ---- Bun.semver ------------------------------------------------------------
  // Bun documents this as "compatible with node-semver", so the honest shim is
  // the real node-semver we already vendor for the npm program rather than a
  // hand-rolled range matcher. Ranges are where a subset implementation goes
  // wrong quietly: `>=1 <2`, `1 || 2`, hyphen ranges, and the rule that a
  // prerelease only satisfies a range that itself names one.
  const semverLib = () => vendor(semverFactory);

  const bunSemver = {
    // Bun returns false for an invalid version OR an invalid range, rather than
    // throwing. node-semver already does that for malformed strings; the guard
    // covers non-string arguments, which it throws on.
    satisfies(version, range) {
      try {
        return semverLib().satisfies(version, range);
      } catch {
        return false;
      }
    },
    // Sort comparator: -1 / 0 / 1, with prereleases ordering before the release
    // they precede. Bun's docs do not say what an unparseable version does here
    // (unlike satisfies, where they say "returns false"), so this surfaces
    // node-semver's TypeError rather than inventing an ordering. Guessing 0 would
    // make an unsortable array look sorted, which is the silent-wrong failure the
    // shim's house style forbids.
    order(versionA, versionB) {
      return semverLib().compare(versionA, versionB);
    },
  };

  return {
    YAML: { parse: yamlParse },
    TOML: { parse: tomlParse, stringify: tomlStringify },
    JSON5: {
      parse: (text, reviver) => json5().parse(text, reviver),
      stringify: (value, replacer, space) => json5().stringify(value, replacer, space),
    },
    JSONL: jsonl,
    semver: bunSemver,
  };
}

// ---- JSONL scanner ----------------------------------------------------------
// One engine behind both entry points, differing only in `final`: parse() treats
// end-of-input as terminating the last value, parseChunk() does not, because an
// unterminated tail is the normal state of a stream mid-flight and re-parsing it
// when the rest arrives is the caller's job.
//
// `read` is the offset just past the last value that parsed — bytes for a
// Uint8Array, characters for a string, matching Bun. It deliberately excludes the
// terminating newline: Bun's own streaming example slices at `read` and the
// leading newline that leaves behind is skipped as a blank line on the next pass.
// The documented examples pin both numbers ('{"id":1}\n{"id":2}\n{"id":3' => 17,
// '{"a":1}\n{invalid}\n{"b":2}\n' => 7) and the spike asserts them.
//
// `done` is "the input was consumed with no remaining data". Bun's docs give one
// worked value for it (false, with an incomplete value left over) and do not
// define the trailing-newline case, so it is read here as "nothing parseable is
// left and no error stopped us" — trailing whitespace does not make it false.
const NEWLINE = 0x0a;

export function scanJsonl(input, start, end, final, apiName) {
  const bytes = ArrayBuffer.isView(input) && !(input instanceof DataView);
  if (!bytes && typeof input !== "string") {
    throw new TypeError(apiName + " expects a string or a Uint8Array");
  }
  const source = bytes && !(input instanceof Uint8Array)
    ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    : input;

  const limit = source.length;
  let i = clamp(start, 0, limit, 0);
  const stop = clamp(end, 0, limit, limit);
  // A UTF-8 BOM at the head of a buffer is data no JSON parser accepts and every
  // Windows text editor writes; Bun skips it for Uint8Array input.
  if (bytes && i === 0 && stop >= 3 && source[0] === 0xef && source[1] === 0xbb && source[2] === 0xbf) i = 3;

  const values = [];
  let read = i;
  let error = null;

  while (i < stop) {
    let nl = -1;
    for (let j = i; j < stop; j++) {
      if (bytes ? source[j] === NEWLINE : source.charCodeAt(j) === NEWLINE) {
        nl = j;
        break;
      }
    }
    const segmentEnd = nl === -1 ? stop : nl;
    const text = bytes ? decodeUtf8(source.subarray(i, segmentEnd)) : source.slice(i, segmentEnd);
    if (text.trim() === "") {
      // Blank line — not a value, and not an error either.
      if (nl === -1) {
        i = stop;
        break;
      }
      i = nl + 1;
      continue;
    }
    // No terminating newline and more data may follow: leave it for the caller.
    if (nl === -1 && !final) break;
    try {
      values.push(JSON.parse(text));
    } catch (err) {
      error = asSyntaxError(err);
      break;
    }
    read = segmentEnd;
    i = nl === -1 ? stop : nl + 1;
  }

  return { values, read, done: error === null && i >= stop, error };
}

// ---- small shared helpers ---------------------------------------------------

function clamp(value, min, max, fallback) {
  if (value === undefined || value === null) return fallback;
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return n < min ? min : n > max ? max : n;
}

let utf8Decoder = null;
function decodeUtf8(view) {
  if (!utf8Decoder) utf8Decoder = new TextDecoder();
  return utf8Decoder.decode(view);
}

function requireText(text, apiName) {
  if (typeof text !== "string") throw new TypeError(apiName + " expects a string");
  return text;
}

// Bun's parsers all reject with a SyntaxError. js-yaml throws a YAMLException and
// smol-toml a TomlError, neither of which is one, so a caller writing
// `catch (e) { if (e instanceof SyntaxError) ... }` would take the wrong branch.
// The original is kept as `cause` — both libraries put a source excerpt with a
// line/column caret in the message, which is worth not throwing away.
function asSyntaxError(err) {
  if (err instanceof SyntaxError) return err;
  const message = err && err.message ? err.message : String(err);
  return new SyntaxError(message, { cause: err });
}

// Deep-copy a value into what smol-toml's `stringify` should see, applying Bun's
// documented rules for things TOML cannot represent. Also the circular check:
// `seen` holds the containers on the current path, so a repeated sibling is fine
// and only a genuine cycle throws.
function normalizeForToml(value, seen, inArray) {
  const type = typeof value;
  if (value === null) {
    throw new TypeError("Bun.TOML.stringify cannot serialize null (TOML has no null)");
  }
  if (type === "bigint") {
    throw new TypeError("Bun.TOML.stringify cannot serialize a BigInt (TOML integers are 64-bit at most)");
  }
  if (value === undefined || type === "function" || type === "symbol") {
    if (inArray) {
      throw new TypeError("Bun.TOML.stringify cannot serialize " + describe(value) + " inside an array (TOML arrays cannot have holes)");
    }
    return undefined; // caller drops the property
  }
  if (type !== "object" || value instanceof Date) return value;

  if (seen.has(value)) throw new TypeError("Bun.TOML.stringify cannot serialize a circular reference");
  seen.add(value);
  let out;
  if (Array.isArray(value)) {
    // Indexed rather than `.map`, which skips holes — a hole reads as undefined
    // and must throw for the same reason an explicit undefined does.
    out = [];
    for (let i = 0; i < value.length; i++) out.push(normalizeForToml(value[i], seen, true));
  } else {
    out = {};
    for (const key of Object.keys(value)) {
      const normalized = normalizeForToml(value[key], seen, false);
      if (normalized !== undefined) out[key] = normalized;
    }
  }
  seen.delete(value);
  return out;
}

function describe(value) {
  if (value === undefined) return "undefined";
  return "a " + typeof value;
}