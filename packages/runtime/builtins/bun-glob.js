// Bun.Glob — pattern compilation and `.match()`.
//
// Hand-rolled rather than vendored, deliberately. The obvious move is to bundle
// picomatch or minimatch, but Bun's glob dialect differs from theirs in ways that
// change *which files a build includes*, and all three differences are in the
// direction where the wrong answer looks plausible:
//
//   1. `*` does not cross `/` (nor `\`). minimatch's `*` also stops at `/`, but
//      picomatch and several `fast-glob` presets will happily match across
//      separators depending on options, so "drop it in with defaults" is a
//      coin flip you only lose in production.
//   2. `!` negates ONLY at the start of a pattern. minimatch supports negation
//      mid-pattern via extglob (`!(foo)`) and treats a leading `!` as a
//      list-level exclusion rather than a per-pattern boolean; Bun's `!` is
//      simply "invert the result of this one match".
//   3. Braces nest at most 10 deep. Other libraries either nest without limit or
//      expand the cross-product eagerly, which turns a pathological pattern into
//      a memory problem instead of an error.
//
// Vendoring would also mean running esbuild to produce a self-contained CJS
// module (the precedent is packages/runtime/node/vendor/semver.js), and no such
// toolchain is available in this environment. Between "a matcher whose exact
// semantics we assert" and "a library whose defaults we would have to audit
// anyway", the matcher is both smaller and more honest. scripts/spike-bun-offline.mjs
// asserts all three behaviours above directly, plus the documented examples from
// https://bun.com/docs/runtime/glob.
//
// Compilation targets a RegExp. Globs are a regular language, the translation is
// mechanical, and it lets the engine do the backtracking rather than us.

// Braces may nest 10 deep per the docs. Going deeper is a pattern bug, so it
// throws instead of silently truncating to a pattern that matches the wrong set.
const MAX_BRACE_DEPTH = 10;

// Characters that are special to RegExp but ordinary inside a glob.
const RE_SPECIAL = /[.+^$(){}|[\]\\/]/g;
const escapeLiteral = (s) => s.replace(RE_SPECIAL, "\\$&");

export function globToRegExpSource(pattern) {
  const { source, index } = compileAlternation(pattern, 0, 0, false);
  if (index < pattern.length) {
    // Only reachable via a stray `}` or `,` outside any brace, which we treat as
    // literal by falling through — compileAlternation stops at them only when it
    // is inside a group, so this is a guard against a future edit, not a path
    // users can reach today.
    throw new Error(`Bun.Glob: could not parse pattern ${JSON.stringify(pattern)} (stopped at index ${index})`);
  }
  return source;
}

// Parses `a,b,c` at the current brace depth. `inGroup` tells us whether `,` and
// `}` terminate the current run or are ordinary characters.
function compileAlternation(pattern, start, depth, inGroup) {
  const branches = [];
  let i = start;
  let current = "";

  while (i < pattern.length) {
    const c = pattern[i];

    if (inGroup && c === ",") {
      branches.push(current);
      current = "";
      i++;
      continue;
    }
    if (inGroup && c === "}") break;

    if (c === "\\") {
      // `\` escapes any of the special characters. A trailing backslash is a
      // literal backslash.
      if (i + 1 < pattern.length) {
        current += escapeLiteral(pattern[i + 1]);
        i += 2;
      } else {
        current += "\\\\";
        i++;
      }
      continue;
    }

    if (c === "{") {
      if (depth + 1 > MAX_BRACE_DEPTH) {
        throw new Error(
          `Bun.Glob: brace patterns may nest at most ${MAX_BRACE_DEPTH} levels deep, got ${depth + 1} in ${JSON.stringify(pattern)}`,
        );
      }
      const inner = compileAlternation(pattern, i + 1, depth + 1, true);
      if (pattern[inner.index] !== "}") {
        throw new Error(`Bun.Glob: unterminated '{' in pattern ${JSON.stringify(pattern)}`);
      }
      current += "(?:" + inner.source + ")";
      i = inner.index + 1;
      continue;
    }

    if (c === "[") {
      const cls = compileCharClass(pattern, i);
      if (cls) {
        current += cls.source;
        i = cls.index;
        continue;
      }
      // An unterminated `[` is a literal `[`, which is what shells do.
      current += "\\[";
      i++;
      continue;
    }

    if (c === "*") {
      let j = i;
      while (pattern[j] === "*") j++;
      const globstar = j - i >= 2;
      if (globstar) {
        // `**/` must be able to match *zero* directories: the documented example
        // is `new Glob("**/*.ts").match("index.ts") === true`. Making it `.*\/`
        // would require at least one separator and silently drop root-level
        // files from a build.
        if (pattern[j] === "/") {
          current += "(?:.*\\/)?";
          i = j + 1;
        } else {
          current += ".*";
          i = j;
        }
      } else {
        // A single `*` stops at a path separator, either flavour.
        current += "[^/\\\\]*";
        i = j;
      }
      continue;
    }

    if (c === "?") {
      current += "[^/\\\\]";
      i++;
      continue;
    }

    current += escapeLiteral(c);
    i++;
  }

  branches.push(current);
  return { source: branches.join("|"), index: i };
}

// `[abc]`, `[a-z]`, `[^ab]`, `[!a-z]`. Returns null when there is no closing `]`.
function compileCharClass(pattern, start) {
  let i = start + 1;
  let negated = false;
  if (pattern[i] === "!" || pattern[i] === "^") {
    negated = true;
    i++;
  }
  let body = "";
  // A `]` in the first position is a literal `]`, per POSIX.
  if (pattern[i] === "]") {
    body += "\\]";
    i++;
  }
  let closed = false;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "]") {
      closed = true;
      i++;
      break;
    }
    if (c === "\\" && i + 1 < pattern.length) {
      body += "\\" + pattern[i + 1];
      i += 2;
      continue;
    }
    // `-` is kept verbatim so ranges work; everything else that RegExp treats
    // specially inside a class is escaped.
    body += /[\]\\^]/.test(c) ? "\\" + c : c;
    i++;
  }
  if (!closed) return null;
  // Even a negated class must not swallow a path separator.
  return { source: "[" + (negated ? "^/\\\\" : "") + body + "]", index: i };
}

// Compiles a pattern into { negated, regexp }. Exported so the offline spike can
// assert on the compiled form as well as on match results.
export function compileGlob(pattern) {
  if (typeof pattern !== "string") {
    throw new TypeError("Bun.Glob: pattern must be a string");
  }
  // `!` negates only at the START of a pattern. Anywhere else it is an ordinary
  // character: `new Glob("a!b").match("a!b")` is true, and there is no
  // mid-pattern negation syntax the way extglob-capable matchers provide.
  let negated = false;
  let body = pattern;
  if (body.startsWith("!")) {
    negated = true;
    body = body.slice(1);
  }
  return { negated, regexp: new RegExp("^(?:" + globToRegExpSource(body) + ")$") };
}

export class Glob {
  constructor(pattern) {
    this.pattern = pattern;
    // Compile eagerly so a malformed pattern throws at construction, where the
    // stack still points at the caller's own code.
    this._compiled = compileGlob(pattern);
  }

  match(path) {
    const s = String(path);
    const hit = this._compiled.regexp.test(s);
    return this._compiled.negated ? !hit : hit;
  }

  // scan()/scanSync() need a directory walk over the VFS, which is a different
  // problem from pattern matching and is scheduled for Phase 2 alongside
  // import.meta.dir and Bun.FileSystemRouter. Returning an empty iterator here
  // would read as "no files matched" — the silently-wrong answer this whole
  // change exists to remove — so they fail loudly instead, in the same
  // import-safe/call-loud tier as bun:ffi.
  scan() {
    throw new Error(GLOB_SCAN_UNSUPPORTED("scan"));
  }
  scanSync() {
    throw new Error(GLOB_SCAN_UNSUPPORTED("scanSync"));
  }
}

export const GLOB_SCAN_UNSUPPORTED = (name) =>
  `Bun.Glob.${name}() is not implemented in the Vivari shim yet (it needs a VFS directory walk; coming in Phase 2). ` +
  `Bun.Glob(...).match() works today — use it with your own readdir if you need to filter a listing.`;