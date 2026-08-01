// Bun's automatic `.env` loading — the file set, the precedence, the parser and
// `$VAR` expansion.
//
// Bun reads `.env` files at startup with no opt-in (`dotenv`/`dotenv-expand` are
// documented as unnecessary under Bun), so a project that works under Bun and
// reads `process.env.DATABASE_URL` reads `undefined` here unless we do the same.
// Nothing in Vivari did this before.
//
// WHY NOT REUSE THE PARSER IN kernel-host/coreutils.js. The `node` program there
// has a KEY=VALUE reader for `--env-file`, and it is the wrong thing to share
// twice over. Mechanically: it lives INSIDE the template literal that is the
// guest program's source text, so there is no module to import — sharing it would
// mean generating the program from this file. Semantically: it implements Node's
// `--env-file`, which is a deliberately smaller language than Bun's. It has no
// `$VAR` expansion, no multi-line quoted values, no backtick quotes, no `KEY: value`
// form and no `\n` unescaping. Copying Bun's rules into it would change `node
// --env-file`'s behaviour, which is Node's to define, not ours. So the two stay
// separate on purpose, and this one is a port of Bun's own parser
// (src/env_loader.zig) rather than a fresh interpretation of "dotenv format" —
// dotenv has no specification, only implementations that disagree.
//
// PRECEDENCE (the part that is silently wrong if reversed). Bun's docs list, in
// order of INCREASING precedence: `.env`, then `.env.{NODE_ENV}`, then
// `.env.local`. Its loader (`loadDefaultFiles`) additionally reads
// `.env.{NODE_ENV}.local` ahead of all of them, and loads each file with
// override=false — so the FIRST file to define a key wins, and the load order is
// therefore decreasing precedence:
//
//     .env.{development|production|test}.local
//     .env.local                                 (SKIPPED when NODE_ENV=test)
//     .env.{development|production|test}
//     .env
//
// The process environment is populated before any of them and is never
// overridden, so a variable exported by the shell beats every file. `.env.local`
// being skipped under `NODE_ENV=test` is deliberate in Bun (it is machine-local
// developer state, and a test run must not silently inherit it) and is called out
// in Bun's own docs.
//
// The mode suffix is NOT the raw NODE_ENV: Bun has exactly three (development,
// production, test), picks `production`/`test` only on an exact match of
// `BUN_ENV ?? NODE_ENV`, and treats everything else — including unset, and
// including a real value like `staging` — as `development`. So `NODE_ENV=staging`
// reads `.env.development`, not `.env.staging`. That surprises people; it is
// still what Bun does.

/** The three modes Bun has, from `BUN_ENV ?? NODE_ENV`. */
export function bunEnvMode(env) {
  const raw = env && env.BUN_ENV !== undefined ? env.BUN_ENV : env && env.NODE_ENV;
  if (raw === "test") return "test";
  if (raw === "production") return "production";
  return "development";
}

/**
 * The files Bun reads, IN LOAD ORDER — which is decreasing precedence, because
 * each file is applied without overriding a key that is already set.
 *
 * `mode` overrides the one derived from the environment. Exactly one caller needs
 * that: `bun test` picks the `test` file set up front, BEFORE any NODE_ENV exists
 * to derive it from, and only defaults NODE_ENV to "test" afterwards (see
 * kernel-host/programs/bun.js). Deriving the mode there instead would read
 * `.env.local` on a plain `bun test`, which real Bun does not.
 */
export function bunEnvFiles(env, mode) {
  const m = mode || bunEnvMode(env);
  const files = [".env." + m + ".local"];
  if (m !== "test") files.push(".env.local");
  files.push(".env." + m, ".env");
  return files;
}

// ---- the parser -------------------------------------------------------------
// A port of env_loader.zig's Parser. The quirks below are all load-bearing; each
// one is a case where the popular JS dotenv libraries disagree with Bun.

// env_loader.zig's `whitespace_chars` — note it includes the line breaks, so
// "skip whitespace" also skips blank lines.
const WS = "\t\u000B\u000C \u00A0\n\r";
const isWs = (c) => c !== undefined && WS.indexOf(c) !== -1;
// Key characters: letters, digits, `_`, and also `-` and `.`.
const isKeyChar = (c) => c !== undefined && /[A-Za-z0-9_\-.]/.test(c);
const isNameChar = (c) => c !== undefined && /[A-Za-z0-9_]/.test(c);

/**
 * Parse a `.env` file into an ordered Map of raw (unexpanded) values.
 *
 * Within one file a later assignment overrides an earlier one (oven-sh/bun#1262),
 * which is the opposite of the cross-file rule — hence a Map that we overwrite.
 */
export function parseDotenv(src) {
  const out = new Map();
  const n = src.length;
  let pos = 0;

  const skipWs = () => { while (pos < n && isWs(src[pos])) pos++; };
  const skipLine = () => {
    while (pos < n && src[pos] !== "\n" && src[pos] !== "\r") pos++;
    if (pos < n) pos++;
  };

  // `KEY=`, `export KEY=`, or `KEY: ` (the colon form needs the following space,
  // so a value like `host:port` on the right of an `=` is never mistaken for one).
  const parseKey = (checkExport) => {
    if (checkExport) skipWs();
    const start = pos;
    let end = start;
    while (end < n && isKeyChar(src[end])) end++;
    if (end < n && start < end) {
      pos = end;
      skipWs();
      if (pos < n) {
        if (checkExport && end < pos && src.slice(start, end) === "export") {
          const inner = parseKey(false);
          if (inner !== null) return inner;
        }
        if (src[pos] === "=") {
          pos++;
          return src.slice(start, end);
        }
        if (src[pos] === ":" && isWs(src[pos + 1])) {
          pos += 2;
          return src.slice(start, end);
        }
      }
    }
    pos = start;
    return null;
  };

  // A quoted value may span lines, and it only COUNTS as quoted if nothing but
  // whitespace or a `#` comment follows the closing quote — otherwise the quote
  // was part of the text and we keep looking for a later one. Inside `"` a `\n`
  // and `\r` are unescaped; inside `'` and a backtick a backslash stays literal.
  const parseQuoted = (quote) => {
    const start = pos;
    let end = start + 1;
    while (end < n) {
      const ch = src[end];
      if (ch === "\\") { end += 1; }
      else if (ch === quote) {
        end += 1;
        pos = end;
        skipWs();
        const between = src.slice(end, pos);
        if (pos >= n || src[pos] === "#" || between.indexOf("\n") !== -1 || between.indexOf("\r") !== -1) {
          let buf = "";
          let i = start;
          while (i < end) {
            const c = src[i];
            if (c === "\\") {
              if (quote === '"') {
                const nx = src[i + 1];
                if (nx === "n") buf += "\n";
                else if (nx === "r") buf += "\r";
                else buf += src.slice(i, i + 2); // unknown escape: kept verbatim
                i += 2;
              } else {
                buf += "\\";
                i += 1;
              }
            } else if (c === "\r") {
              i += 1;
              if (i >= end || src[i] !== "\n") buf += "\n"; // lone CR -> LF; CRLF -> the LF
            } else {
              buf += c;
              i += 1;
            }
          }
          return buf.slice(1, buf.length - 1); // drop the surrounding quotes
        }
        pos = start; // not a terminator after all — keep scanning
      }
      end += 1;
    }
    return null; // unterminated: fall back to the unquoted reading
  };

  const parseValue = () => {
    const start = pos;
    skipWs();
    if (pos >= n) return "";
    const q = src[pos];
    if (q === "`" || q === '"' || q === "'") {
      const quoted = parseQuoted(q);
      if (quoted !== null) return quoted;
    }
    // Unquoted: up to `#`, CR or LF, then trimmed. A `#` needs no leading space,
    // so `FOO=a#b` is `a` — dotenv keeps `a#b`.
    let end = start;
    while (end < n && src[end] !== "#" && src[end] !== "\r" && src[end] !== "\n") end++;
    pos = end;
    let v = src.slice(start, end);
    let s = 0;
    let e = v.length;
    while (s < e && isWs(v[s])) s++;
    while (e > s && isWs(v[e - 1])) e--;
    return v.slice(s, e);
  };

  while (pos < n) {
    const key = parseKey(true);
    if (key === null) { skipLine(); continue; }
    out.set(key, parseValue());
  }
  return out;
}

/**
 * Bun's `$VAR` expansion (env_loader.zig `expandValue`), which is not quite any
 * dotenv-expand's. Supports `$NAME`, `${NAME}` and `${NAME:-default}`; an unset
 * variable becomes the default or the empty string; `\$` suppresses expansion and
 * the backslash is dropped. It scans BACKWARDS from the end, so a `$` in the very
 * last position is never a reference, and — unlike dotenv-expand — expansion also
 * happens inside single quotes, because Bun expands the parsed value regardless of
 * how it was quoted.
 */
export function expandDotenvValue(value, lookup) {
  if (value.length < 2) return value;
  let out = "";
  let last = value.length;
  let pos = value.length - 2;
  for (;;) {
    if (value[pos] === "$") {
      if (pos > 0 && value[pos - 1] === "\\") {
        out = value.slice(pos, last) + out;
        pos -= 1;
      } else {
        let end = value[pos + 1] === "{" ? pos + 2 : pos + 1;
        const nameStart = end;
        while (end < value.length && isNameChar(value[end])) end++;
        const found = lookup(value.slice(nameStart, end));
        let fallback = "";
        if (value.startsWith(":-", end)) {
          end += 2;
          const dStart = end;
          while (end < value.length && value[end] !== "}" && value[end] !== "\\") end++;
          fallback = value.slice(dStart, end);
        }
        if (end < value.length && value[end] === "}") end++;
        out = (found === undefined || found === null ? fallback : found) + value.slice(end, last) + out;
      }
      last = pos;
    }
    if (pos === 0) break;
    pos -= 1;
  }
  return last > 0 ? value.slice(0, last) + out : out;
}

/**
 * Apply one file's contents to `env`, Bun-style: a key already present (from the
 * process environment or an earlier — higher precedence — file) is left alone,
 * and only the keys this file introduced are expanded. Expansion runs in
 * insertion order, so a reference to a key defined EARLIER in the same file sees
 * its expanded value while one defined later sees its raw value — again, Bun's
 * order, not a choice we get to make.
 *
 * Returns the keys this file actually set.
 */
export function applyDotenv(env, src) {
  const added = [];
  for (const [key, raw] of parseDotenv(src)) {
    if (env[key] !== undefined) continue;
    env[key] = raw;
    added.push(key);
  }
  for (const key of added) {
    env[key] = expandDotenvValue(env[key], (name) => env[name]);
  }
  return added;
}

/**
 * Read and apply Bun's default `.env` set from `cwd`. `readFile(path)` returns the
 * file's text or null when it does not exist (injected so this stays pure enough
 * to test without a VFS). `mode` forces the file set (see bunEnvFiles). Returns
 * the files that existed, in load order.
 */
export function loadBunEnvFiles({ env, cwd, readFile, mode }) {
  const loaded = [];
  const base = cwd && cwd !== "/" ? cwd.replace(/\/+$/, "") : "";
  for (const name of bunEnvFiles(env, mode)) {
    let src;
    try {
      src = readFile(base + "/" + name);
    } catch {
      src = null; // unreadable is the same as absent: Bun does not fail a run over it
    }
    if (typeof src !== "string") continue;
    loaded.push({ file: name, keys: applyDotenv(env, src) });
  }
  return loaded;
}