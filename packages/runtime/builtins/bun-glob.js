// Bun.Glob — pattern compilation, `.match()`, and the `.scan()`/`.scanSync()`
// directory walk.
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
//
// ---- the walk (Phase 2) -----------------------------------------------------
// `.scan()`/`.scanSync()` add a directory traversal on top of that matcher. Two
// things shape the implementation here in a way they would not shape a Node one:
//
//   * Every directory read is a SYNCHRONOUS syscall across the SharedArrayBuffer
//     bridge — the calling worker parks in Atomics.wait until the fs worker
//     answers. So the naive "walk everything, then filter" costs one round trip
//     per directory in the project whatever the pattern is, and `readdirSync(dir,
//     {withFileTypes:true})` costs one MORE round trip per ENTRY, because our
//     binding fills the dirent types with a per-name lstat (node/bindings/fs.js).
//     Both are avoided below: we prune directories that cannot contain a match,
//     and we read names only, lstat-ing an entry lazily and only when the answer
//     can still change the result.
//   * The pruner must never disagree with `.match()`. It does not get to: it only
//     decides where to LOOK. Membership is always decided by `match()` — the same
//     compiled RegExp `.match()` uses, called through the same method — so a
//     pruning bug can only ever cost us files, never invent them, and the checks
//     in scripts/spike-bun-offline.mjs pin both halves against each other.
//
// The pruner is a tiny NFA over the pattern's path segments (see
// compileGlobPrefix): `**` is a state that consumes any number of components,
// every other segment is a RegExp compiled by the SAME globToRegExpSource. Where a
// segment's shape is ambiguous about how many directory levels it spans — it holds
// a `**` glued to other characters, or a brace group containing a `/` — it is
// widened to a `**` state, which can only make us descend into more directories
// than strictly necessary. A negated pattern (`!x`) disables pruning entirely: it
// matches almost everything, so there is nothing to prune.

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
  // `body` (the pattern minus a leading `!`) is kept because the scan pruner has
  // to segment the same string the matcher compiled, not the raw pattern.
  return { negated, body, regexp: new RegExp("^(?:" + globToRegExpSource(body) + ")$") };
}

// ---- pruning: the path-segment prefix automaton -----------------------------

// Splits a pattern into PATH segments at top-level `/` only. A `/` inside a brace
// group or a character class belongs to that group, not to the path structure, so
// splitting on every `/` would cut `{src,test/deep}/**` in the wrong place.
// Exported for scripts/spike-bun-offline.mjs: this is pure string work and it is
// where an off-by-one silently costs you a whole subtree.
export function splitGlobSegments(pattern) {
  const segments = [];
  let current = "";
  let depth = 0; // brace nesting
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\" && i + 1 < pattern.length) {
      // Keep the escape with its character: an escaped `/` is a literal, and the
      // matcher (compileAlternation) reads it the same way.
      current += c + pattern[i + 1];
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      current += c;
      continue;
    }
    if (c === "[") { inClass = true; current += c; continue; }
    if (c === "{") { depth++; current += c; continue; }
    if (c === "}") { if (depth > 0) depth--; current += c; continue; }
    if (c === "/" && depth === 0) { segments.push(current); current = ""; continue; }
    current += c;
  }
  segments.push(current);
  return segments;
}

// Builds the prune automaton: one state per path segment. `{ globstar: true }`
// consumes any number of components; everything else is a RegExp over ONE
// component, compiled by globToRegExpSource so it cannot drift from `.match()`.
//
// A segment is widened to a globstar when it could span more than one directory
// level: it contains `**` (glued to other characters, e.g. `a**b`, which the
// matcher compiles to a separator-crossing `.*`), or it still contains a `/` after
// the split above (so the `/` was inside a brace group or an unterminated class).
// Widening only ever makes us descend into MORE directories, never fewer.
export function compileGlobPrefix(pattern) {
  const segments = splitGlobSegments(pattern).map((seg) => {
    if (/^\*+$/.test(seg) && seg.length >= 2) return { globstar: true };
    if (seg.indexOf("**") !== -1 || seg.indexOf("/") !== -1) return { globstar: true, widened: true };
    return { globstar: false, regexp: new RegExp("^(?:" + globToRegExpSource(seg) + ")$") };
  });
  return { segments };
}

// The `null` state set is the "no information, descend into everything" value,
// used for negated patterns. Everything below treats it as universally live.
function prefixClosure(plan, states) {
  const out = new Set();
  const stack = Array.from(states);
  while (stack.length) {
    const i = stack.pop();
    if (out.has(i)) continue;
    out.add(i);
    // `**` may match ZERO directories, so state i is also state i+1.
    if (i < plan.segments.length && plan.segments[i].globstar) stack.push(i + 1);
  }
  return out;
}

export function prefixStart(plan) {
  return plan ? prefixClosure(plan, [0]) : null;
}

// Advance the automaton over one directory-entry name.
export function prefixStep(plan, states, name) {
  if (!plan || states === null) return null;
  const next = new Set();
  for (const i of states) {
    const seg = plan.segments[i];
    if (!seg) continue; // past the end: nothing deeper can match through this state
    if (seg.globstar) next.add(i); // absorb this component and stay
    else if (seg.regexp.test(name)) next.add(i + 1);
  }
  return prefixClosure(plan, next);
}

// True when SOME descendant of the directory in this state could still match, i.e.
// the automaton has a state that has not consumed the whole pattern. When this is
// false the directory is not read at all — that saved readdir is the point.
export function prefixCanDescend(plan, states) {
  if (!plan || states === null) return true;
  for (const i of states) if (i < plan.segments.length) return true;
  return false;
}

// ---- the walk ---------------------------------------------------------------

export const GLOB_BROKEN_SYMLINK = (path) =>
  `Bun.Glob scan: broken symbolic link at ${JSON.stringify(path)} ` +
  `(you passed throwErrorOnBrokenSymlink: true).`;

export const GLOB_NO_REALPATH =
  `Bun.Glob scan: followSymlinks: true needs fs.realpathSync to break symlink cycles, and the ` +
  `filesystem handed to the walker does not have it. Without it a link that points at one of its ` +
  `own ancestors walks forever.`;

// The traversal, with `fs` injected: it needs only readdirSync/lstatSync/statSync,
// so scripts/spike-bun-offline.mjs drives the whole thing — pruning, symlinks,
// option defaults — against an in-memory tree with no kernel, and the kernel spike
// then proves the same code over the real Wasm VFS.
//
// A generator, not an array: Bun's scan is lazy, and here laziness is what lets a
// consumer that breaks early skip the remaining syscalls entirely.
export function* scanGlobSync(fs, options) {
  const root = options.root;
  const match = options.match;
  const plan = options.prefix || null;
  const dot = !!options.dot;
  const absolute = !!options.absolute;
  const onlyFiles = options.onlyFiles !== false;
  const followSymlinks = !!options.followSymlinks;
  const throwOnBroken = !!options.throwErrorOnBrokenSymlink;

  const join = (dir, name) => (dir.endsWith("/") ? dir + name : dir + "/" + name);

  // Classify an entry, following a symlink only as far as we are allowed to.
  // Returning null means "skip it": either it vanished mid-walk, or it is a broken
  // link and the caller did not ask us to throw on those (Bun's default).
  //
  // Note we stat a symlink even when followSymlinks is false. We are not following
  // it — we never read through it — but `onlyFiles` needs to know whether it names
  // a directory, and calling a link to a directory a file would be exactly the kind
  // of plausible-looking wrong answer this shim refuses to give.
  const classify = (abs) => {
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      return null;
    }
    if (!st.isSymbolicLink()) return { isDirectory: st.isDirectory(), isSymlink: false };
    let target;
    try {
      target = fs.statSync(abs);
    } catch {
      if (throwOnBroken) throw new Error(GLOB_BROKEN_SYMLINK(abs));
      return null;
    }
    return { isDirectory: target.isDirectory(), isSymlink: true };
  };

  function* walk(dir, rel, states, linkChain) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      // The ROOT has to be loud — "cwd does not exist" must not read as "no files
      // matched". Anything deeper is a directory that disappeared or that we cannot
      // read halfway through a walk, which Bun skips too.
      if (rel === "") throw err;
      return;
    }
    // Bun does not document a traversal order. We sort so a scan is reproducible:
    // the tests can then assert on a whole result array rather than on a set, and
    // a caller who takes the first N gets a stable N.
    names = names.slice().sort();
    for (const name of names) {
      // `dot: false` (the default) is documented as "allow patterns to match
      // entries that begin with a period", so the filter is on the ENTRY, before
      // matching: a pattern that spells `.env` out literally still does not match
      // one unless dot is on. Hidden directories are not descended into either.
      if (!dot && name.charCodeAt(0) === 46 /* . */) continue;
      const childRel = rel === "" ? name : rel + "/" + name;
      const nextStates = prefixStep(plan, states, name);
      const canDescend = prefixCanDescend(plan, nextStates);
      const selfMatches = match(childRel);
      // Neither this entry nor anything under it can match: skip it without even
      // asking what it is. This is the syscall the pruner exists to save.
      if (!selfMatches && !canDescend) continue;

      const kind = classify(join(dir, name));
      if (!kind) continue;
      const out = absolute ? join(root, childRel) : childRel;

      if (!kind.isDirectory) {
        if (selfMatches) yield out;
        continue;
      }
      if (selfMatches && !onlyFiles) yield out;
      if (!canDescend) continue;
      if (kind.isSymlink && !followSymlinks) continue; // documented default: do not traverse

      let nextChain = linkChain;
      if (kind.isSymlink) {
        // Following links means a cycle (a/link -> a) is an infinite walk, and the
        // VFS's own ELOOP guard does not help: every individual resolution is fine,
        // it is the traversal that never ends. Track the resolved directories we
        // reached THROUGH a link and refuse to re-enter one that is already an
        // ancestor of the current path.
        if (typeof fs.realpathSync !== "function") {
          // Without realpath there is no cycle guard, and the failure mode is not a
          // wrong answer but a walk that never returns — the worker parks forever
          // and the tab looks hung. Say so instead.
          throw new Error(GLOB_NO_REALPATH);
        }
        let real;
        try {
          real = fs.realpathSync(join(dir, name));
        } catch {
          continue;
        }
        if (linkChain.indexOf(real) !== -1) continue;
        nextChain = linkChain.concat([real]);
      }
      yield* walk(join(dir, name), childRel, nextStates, nextChain);
    }
  }

  yield* walk(root, "", prefixStart(plan), []);
}

// `scan(root)` and `scanSync(root)` both take either a cwd string or an options
// object. Pure, so the defaults — `onlyFiles: true` is the one that surprises
// people — are asserted offline.
export function normalizeScanOptions(rootOrOptions, defaultCwd) {
  const opts =
    typeof rootOrOptions === "string"
      ? { cwd: rootOrOptions }
      : rootOrOptions && typeof rootOrOptions === "object"
        ? rootOrOptions
        : {};
  return {
    cwd: opts.cwd == null ? defaultCwd : String(opts.cwd),
    dot: !!opts.dot,
    absolute: !!opts.absolute,
    onlyFiles: opts.onlyFiles !== false,
    followSymlinks: !!opts.followSymlinks,
    throwErrorOnBrokenSymlink: !!opts.throwErrorOnBrokenSymlink,
  };
}

// The bare Glob class is the MATCHER; it has no filesystem, so its scan entry
// points say that rather than returning an empty iterator. Only createBunGlob()
// below — what `Bun.Glob` actually is — can walk anything. Reaching this message
// means the class was imported directly, not that the API is unsupported.
export const GLOB_SCAN_UNBOUND = (name) =>
  `Bun.Glob.${name}() was called on the unbound matcher exported by bun-glob.js, which has no ` +
  `filesystem. Use the Bun global's Bun.Glob (createBunGlob in bun-glob.js binds it to the ` +
  `runtime's fs), or call scanGlobSync(fs, options) directly.`;

export class Glob {
  constructor(pattern) {
    this.pattern = pattern;
    // Compile eagerly so a malformed pattern throws at construction, where the
    // stack still points at the caller's own code.
    this._compiled = compileGlob(pattern);
    this._prefixPlan = undefined;
  }

  match(path) {
    const s = String(path);
    const hit = this._compiled.regexp.test(s);
    return this._compiled.negated ? !hit : hit;
  }

  // A negated pattern gets no plan (null): `!x` matches nearly every path, so
  // there is nothing a pruner could rule out and pretending otherwise would drop
  // real results. Built on first scan and cached — a Glob that only ever matches
  // never pays for it.
  _plan() {
    if (this._prefixPlan === undefined) {
      this._prefixPlan = this._compiled.negated ? null : compileGlobPrefix(this._compiled.body);
    }
    return this._prefixPlan;
  }

  // scan() is async and scanSync() is sync, and that asymmetry is the API — Bun
  // types them `AsyncIterable<string>` and `Iterable<string>` respectively. It is
  // not a difference in how much work happens up front: our syscalls are
  // synchronous either way (the worker parks in Atomics.wait), so scan() is the
  // same lazy walk surfaced through an async generator, which at least lets a
  // caller's `for await` body interleave with the traversal.
  scan() {
    throw new Error(GLOB_SCAN_UNBOUND("scan"));
  }
  scanSync() {
    throw new Error(GLOB_SCAN_UNBOUND("scanSync"));
  }
}

// The Glob the `Bun` global exposes: the matcher above, bound to a filesystem.
// Everything the walk needs is injected, which is what keeps the pattern logic
// (pure, unit-testable offline) separate from the traversal (a kernel round trip
// per directory).
export function createBunGlob({ lazy, process }) {
  class BunGlob extends Glob {
    _scanOptions(rootOrOptions) {
      const path = lazy("path");
      const opts = normalizeScanOptions(rootOrOptions, process.cwd());
      return {
        ...opts,
        root: path.resolve(process.cwd(), opts.cwd),
        match: (p) => this.match(p),
        prefix: this._plan(),
      };
    }
    scanSync(rootOrOptions) {
      return scanGlobSync(lazy("fs"), this._scanOptions(rootOrOptions));
    }
    scan(rootOrOptions) {
      const iterator = scanGlobSync(lazy("fs"), this._scanOptions(rootOrOptions));
      return (async function* () {
        for (const entry of iterator) yield entry;
      })();
    }
  }
  return { Glob: BunGlob };
}