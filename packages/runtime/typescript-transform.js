// Synchronous TypeScript / JSX -> JavaScript transform for the Bun runtime shim.
//
// Bun runs `.ts`/`.tsx`/`.jsx` files directly with zero configuration: it STRIPS
// types (it never type-checks) and lowers JSX. Vivari's module loader is
// synchronous (CommonJS `require` reads + compiles a file inline), and the
// in-process esbuild service (esbuild-inproc-patch.js) is (a) async and (b) only
// present when a project actually installed esbuild-wasm — neither holds for a
// bare `bun run app.ts`. So this module is a small, dependency-free, SYNCHRONOUS
// transpiler that covers the common surface of hand-written TS/TSX.
//
// SCOPE (deliberately a "strip types, lower JSX" transform, exactly like Bun's
// own loader — no type-checking, no emit-decorator-metadata, no downleveling):
//   - `import type` / `export type` (statement form + inline `{ type X }` specifiers)
//   - `interface` / `type` alias / `declare` declarations (removed)
//   - type annotations on variables, parameters, function/method return types,
//     and class fields (`: T`, optional `?:`)
//   - generic type parameters (`<T extends U = D>`) on functions/classes/arrows,
//     and generic type arguments on calls / `new` (`f<T>()`, `new C<T>()`)
//   - `as` / `satisfies` casts, and postfix non-null `!`
//   - `enum` (numeric + string) lowered to a runtime object with reverse mapping
//   - class member modifiers (`public`/`private`/`protected`/`readonly`/
//     `abstract`/`override`/`declare`) and constructor parameter properties
//   - JSX / TSX lowered to `React.createElement` (configurable pragma)
//
// KNOWN LIMITS (documented, not silently wrong): ambient `.d.ts` niceties, const
// enums as compile-time inlines (we emit a real object instead), decorator
// metadata, and exotic type positions are best-effort. For maximum fidelity a
// project can still install a real toolchain; this transform is the zero-config
// fallback that makes `bun run app.ts` work out of the box.

// ---- tokenizer --------------------------------------------------------------
// Emits a flat token stream. Whitespace/comments are their own tokens (kept, so
// output stays readable and line numbers barely move). Regex-vs-divide is
// disambiguated with the standard "previous significant token" heuristic.

const KEYWORDS_BEFORE_REGEX = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw",
  "else", "yield", "await", "case", "do",
]);

function isIdentStart(c) {
  return /[A-Za-z_$]/.test(c) || c.charCodeAt(0) > 127;
}
function isIdentPart(c) {
  return /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) > 127;
}

// Token: { type: 'id'|'punc'|'str'|'num'|'tmpl'|'regex'|'ws'|'comment', value }
function tokenize(src) {
  const toks = [];
  let i = 0;
  const n = src.length;
  // Last significant (non-ws/comment) token, for regex disambiguation.
  let lastSig = null;
  const push = (type, value) => {
    const t = { type, value };
    toks.push(t);
    if (type !== "ws" && type !== "comment") lastSig = t;
    return t;
  };
  const regexAllowed = () => {
    if (!lastSig) return true;
    if (lastSig.type === "num" || lastSig.type === "str" || lastSig.type === "tmpl" || lastSig.type === "regex") return false;
    if (lastSig.type === "id") return KEYWORDS_BEFORE_REGEX.has(lastSig.value);
    // punctuator: a regex can follow ( , = : [ ! & | ? { } ; etc. but NOT ) ] .
    const v = lastSig.value;
    if (v === ")" || v === "]" || v === "}" ) return false;
    return true;
  };

  while (i < n) {
    const c = src[i];
    // whitespace
    if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\v") {
      let j = i + 1;
      while (j < n && /\s/.test(src[j])) j++;
      push("ws", src.slice(i, j));
      i = j;
      continue;
    }
    // comments
    if (c === "/" && src[i + 1] === "/") {
      let j = i + 2;
      while (j < n && src[j] !== "\n") j++;
      push("comment", src.slice(i, j));
      i = j;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      let j = i + 2;
      while (j < n && !(src[j] === "*" && src[j + 1] === "/")) j++;
      j = Math.min(n, j + 2);
      push("comment", src.slice(i, j));
      i = j;
      continue;
    }
    // strings
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        j++;
      }
      push("str", src.slice(i, j));
      i = j;
      continue;
    }
    // template literal (kept as one token incl. ${...} — nested code inside a
    // template is rare in type positions and is emitted verbatim)
    if (c === "`") {
      let j = i + 1;
      let depth = 0;
      while (j < n) {
        if (src[j] === "\\") { j += 2; continue; }
        if (src[j] === "`" && depth === 0) { j++; break; }
        if (src[j] === "$" && src[j + 1] === "{") { depth++; j += 2; continue; }
        if (src[j] === "}" && depth > 0) { depth--; j++; continue; }
        j++;
      }
      push("tmpl", src.slice(i, j));
      i = j;
      continue;
    }
    // regex
    if (c === "/" && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      let ok = true;
      while (j < n) {
        const d = src[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "\n") { ok = false; break; }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) { j++; break; }
        j++;
      }
      if (ok) {
        while (j < n && /[a-z]/i.test(src[j])) j++; // flags
        push("regex", src.slice(i, j));
        i = j;
        continue;
      }
    }
    // number
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1]))) {
      let j = i + 1;
      while (j < n && /[0-9a-fA-FxXoObBeE._n]/.test(src[j])) j++;
      push("num", src.slice(i, j));
      i = j;
      continue;
    }
    // identifier / keyword
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j])) j++;
      push("id", src.slice(i, j));
      i = j;
      continue;
    }
    // punctuator: match the longest known multi-char operator, else single char
    const three = src.slice(i, i + 3);
    const two = src.slice(i, i + 2);
    const MULTI3 = new Set(["===", "!==", "**=", "...", ">>>", "&&=", "||=", "??="]);
    const MULTI2 = new Set([
      "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--",
      "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>", "**",
    ]);
    if (MULTI3.has(three)) { push("punc", three); i += 3; continue; }
    if (MULTI2.has(two)) { push("punc", two); i += 2; continue; }
    push("punc", c);
    i += 1;
  }
  return toks;
}

// Index of the previous significant token, or -1. "Significant" = not ws, not a
// comment, and not a token we've logically DROPPED (marked `__d`) during the
// transform — so context checks see the emitted stream, not stripped types.
function prevSig(toks, idx) {
  for (let k = idx - 1; k >= 0; k--) {
    const t = toks[k];
    if (t.type !== "ws" && t.type !== "comment" && !t.__d) return k;
  }
  return -1;
}
function nextSig(toks, idx) {
  for (let k = idx + 1; k < toks.length; k++) {
    const t = toks[k];
    if (t.type !== "ws" && t.type !== "comment" && !t.__d) return k;
  }
  return -1;
}

// True if the file even needs TS treatment (cheap pre-check to skip plain JS).
function looksLikeTs(src, isTsx) {
  if (isTsx) return true;
  return (
    /\b(?:interface|type|enum|namespace|declare|abstract|implements|satisfies)\b/.test(src) ||
    /\bimport\s+type\b|\bexport\s+type\b/.test(src) ||
    /\bas\s+(?:const\b|[A-Za-z_$])/.test(src) ||
    /:\s*[A-Za-z_$][\w$.<>\[\]| &]*/.test(src) ||
    /<[A-Za-z_$][\w$,. <>\[\]]*>/.test(src)
  );
}

// ---- type-expression consumption -------------------------------------------
// From a start token index (positioned at the first token of a TYPE), return the
// index just AFTER the type, balancing (), [], {}, <>. Stops at a top-level
// terminator: , ; ) ] } = (and, for return types, a body `{`).
//
// `{` and `=>` are context-sensitive, so they are NOT treated as unconditional
// depth-0 stops (that mangled object types like `p: {a: number}` and function
// types like `cb: () => void`):
//   - `{` opens an object/mapped type UNLESS the caller asked for `{` as a
//     terminator (return-type position) AND the preceding token already completes
//     a type — i.e. it is a function/method body.
//   - `=>` is part of a function type (`() => void`) when the type began with `(`;
//     otherwise it starts an arrow body and terminates the type.
function skipType(toks, start, stopExtra) {
  let i = start;
  let paren = 0, brack = 0, brace = 0, angle = 0;
  const stops = new Set([",", ";", "=>", ...(stopExtra || [])]);
  const braceIsStop = stops.delete("{"); // did the caller want `{` (a body) to stop us?
  stops.delete("=>"); // handled contextually below
  let prev = null;            // previous significant token in the type stream
  let startedWithParen = false; // type began with `(` -> a function type
  let seen = false;             // have we consumed any significant token yet?
  const endsType = (t) => t && (
    t.type === "id" || t.type === "str" || t.type === "num" ||
    (t.type === "punc" && (t.value === "}" || t.value === "]" || t.value === ")" || t.value === ">" || t.value === ">>" || t.value === ">>>"))
  );
  while (i < toks.length) {
    const t = toks[i];
    if (t.type === "ws" || t.type === "comment") { i++; continue; }
    if (t.type === "str" || t.type === "tmpl" || t.type === "num" || t.type === "regex" || t.type === "id") { prev = t; seen = true; i++; continue; }
    const v = t.value;
    const depth = paren + brack + brace + angle;
    if (depth === 0 && (stops.has(v) || v === "=")) break;
    if (depth === 0 && v === "=>") { if (!startedWithParen) break; prev = t; seen = true; i++; continue; }
    if (depth === 0 && v === "{") {
      // A `{` after a complete type in a return-type position is the body; else it
      // opens an object/mapped type expression that we balance through.
      if (braceIsStop && endsType(prev)) break;
      brace++; prev = t; seen = true; i++; continue;
    }
    if (v === "(") { if (!seen) startedWithParen = true; paren++; }
    else if (v === ")") { if (paren === 0) break; paren--; }
    else if (v === "[") brack++;
    else if (v === "]") { if (brack === 0) break; brack--; }
    else if (v === "}") { if (brace === 0) break; brace--; }
    else if (v === "<") angle++;
    else if (v === ">") { if (angle > 0) angle--; }
    else if (v === ">>") { angle = Math.max(0, angle - 2); }
    else if (v === ">>>") { angle = Math.max(0, angle - 3); }
    prev = t; seen = true;
    i++;
  }
  return i;
}

// Decide whether a `<` at index `i` opens a GENERIC (type args / type params)
// rather than a less-than comparison. Heuristic: preceding significant token is
// an identifier / `)` / `>` (call target, chained generic, or after params), and
// the `<...>` region balances and is followed by `(` `` ` `` or (for decls) an id.
function isGenericOpen(toks, i) {
  const p = prevSig(toks, i);
  if (p < 0) return false;
  const pt = toks[p];
  if (!(pt.type === "id" || (pt.type === "punc" && (pt.value === ")" || pt.value === ">")))) return false;
  // scan to matching close, allowing nested <>
  let depth = 0;
  for (let k = i; k < toks.length; k++) {
    const t = toks[k];
    if (t.type === "ws" || t.type === "comment") continue;
    const v = t.value;
    if (t.type === "punc") {
      if (v === "<") depth++;
      else if (v === ">") { depth--; if (depth === 0) { return true; } }
      else if (v === ">>") { depth -= 2; if (depth <= 0) return true; }
      else if (v === ">>>") { depth -= 3; if (depth <= 0) return true; }
      // Anything clearly not type-ish inside kills the guess.
      else if (v === ";" || v === "{" || v === "&&" || v === "||" || v === "==" || v === "===") return false;
    }
    if (t.type === "str" || t.type === "tmpl" || t.type === "regex") return false;
    if (k - i > 400) return false; // runaway guard
  }
  return false;
}

// Token that may precede the `<` of a GENERIC ARROW (see isGenericArrowOpen).
// These are the positions where an expression may begin.
const EXPR_START_PUNC = new Set([
  "=", "(", ",", "[", ":", ";", "{", "}", "=>", "?", "!", "&&", "||", "??",
  "+", "-", "*", "/", "%", "==", "!=", "===", "!==", "...", "+=", "-=",
]);
const EXPR_START_KEYWORDS = new Set([...KEYWORDS_BEFORE_REGEX, "default"]);

// Decide whether a `<` at index `i` opens the type PARAMETERS of a generic arrow
// function (`<T>(x: T): T => x`). isGenericOpen cannot see these: it requires the
// previous token to be an identifier / `)` / `>`, but a generic arrow starts an
// EXPRESSION, so what precedes it is `=`, `(`, `,`, `return`, … Only `async <T>(…)`
// happened to be caught, because `async` is an identifier.
//
// Plain JS cannot begin an expression with `<`, so requiring a balanced `<...>`
// followed by a parameter list that leads to `=>` (directly, or after a `: T`
// return annotation) is enough to tell this apart from a comparison. `.tsx`/`.jsx`
// sources have JSX lowered before stripTypes runs, so no JSX ambiguity remains.
function isGenericArrowOpen(toks, i) {
  const p = prevSig(toks, i);
  if (p >= 0) {
    const pt = toks[p];
    const okPunc = pt.type === "punc" && EXPR_START_PUNC.has(pt.value);
    const okKeyword = pt.type === "id" && EXPR_START_KEYWORDS.has(pt.value);
    if (!okPunc && !okKeyword) return false;
  }
  // 1) balanced `<...>`, containing nothing that is clearly not a type.
  let depth = 0;
  let k = i;
  for (; k < toks.length; k++) {
    const t = toks[k];
    if (t.type === "ws" || t.type === "comment") continue;
    if (t.type === "str" || t.type === "tmpl" || t.type === "regex") return false;
    if (t.type === "punc") {
      const v = t.value;
      if (v === "<") depth++;
      else if (v === ">") { depth--; if (depth === 0) { k++; break; } }
      else if (v === ">>") { depth -= 2; if (depth <= 0) { k++; break; } }
      else if (v === ">>>") { depth -= 3; if (depth <= 0) { k++; break; } }
      else if (v === ";" || v === "{" || v === "=>" || v === "&&" || v === "||") return false;
    }
    if (k - i > 400) return false; // runaway guard
  }
  if (depth > 0) return false;
  // 2) the type parameters must be followed by a parameter list.
  const open = nextSig(toks, k - 1);
  if (open < 0 || toks[open].type !== "punc" || toks[open].value !== "(") return false;
  // 3) …whose matching `)` is followed by `=>`, or by a `: T` return type.
  let pdepth = 0;
  for (let j = open; j < toks.length; j++) {
    const t = toks[j];
    if (t.type !== "punc") continue;
    if (t.value === "(") pdepth++;
    else if (t.value === ")") {
      pdepth--;
      if (pdepth === 0) {
        const after = nextSig(toks, j);
        if (after < 0 || toks[after].type !== "punc") return false;
        return toks[after].value === "=>" || toks[after].value === ":";
      }
    }
    if (j - open > 4000) return false; // runaway guard
  }
  return false;
}

// ---- main transform ---------------------------------------------------------

const MEMBER_MODIFIERS = new Set(["public", "private", "protected", "readonly", "abstract", "override", "declare"]);

function stripTypes(src) {
  const toks = tokenize(src);
  let out = "";
  const emit = (s) => { out += s; };

  // A tiny stack tracking whether we're directly inside a class body, so we can
  // handle member modifiers + parameter properties + field annotations.
  let i = 0;
  const N = toks.length;

  // ---- TS parameter-property synthesis state --------------------------------
  // `constructor(private x, public y)` must ALSO emit `this.x = x; this.y = y;`
  // at the top of the constructor body. We track paren depth, whether we're in a
  // constructor's parameter list, and the collected property names.
  let parenDepth = 0;
  let ctorPending = false;   // saw `constructor`, waiting for its `(`
  let inCtorParams = false;  // currently between a constructor's `(` and `)`
  let ctorParenLevel = -1;   // paren depth at which the ctor param list opened
  let ctorProps = [];        // param-property names seen in the current ctor
  let awaitCtorBody = false; // params closed, waiting to inject at the body `{`
  const recordCtorProp = (fromIdx) => {
    // From a stripped modifier, walk forward past any further modifiers to the
    // parameter identifier and record it (deduped).
    let k = nextSig(toks, fromIdx);
    while (k >= 0 && toks[k].type === "id" && MEMBER_MODIFIERS.has(toks[k].value)) k = nextSig(toks, k);
    if (k >= 0 && toks[k].type === "id" && !ctorProps.includes(toks[k].value)) ctorProps.push(toks[k].value);
  };

  // Helper: emit a token verbatim.
  const raw = (t) => { emit(t.value); };

  // Mark tokens [a, b) as DROPPED so backward context scans (prevSig/nextSig/
  // enclosingContext) ignore them, then return b (the new cursor). This is how a
  // stripped `!`/type/modifier stops fooling the "what came before" heuristics.
  const drop = (a, b) => {
    for (let k = a; k < b; k++) toks[k].__d = true;
    return b;
  };
  // Drop the token at `k` plus the run of trailing ws/comments after it. Always
  // advances at least one token (so a modifier/`?`/`!` can't loop forever).
  const dropTok = (k) => {
    let j = k + 1;
    while (j < N && (toks[j].type === "ws" || toks[j].type === "comment")) j++;
    return drop(k, j);
  };

  while (i < N) {
    const t = toks[i];

    if (t.type === "ws" || t.type === "comment" || t.type === "str" || t.type === "tmpl" || t.type === "num" || t.type === "regex") {
      raw(t);
      i++;
      continue;
    }

    if (t.type === "id") {
      const kw = t.value;
      const p = prevSig(toks, i);
      const atStmtStart = p < 0 || (toks[p].type === "punc" && (toks[p].value === ";" || toks[p].value === "{" || toks[p].value === "}")) ||
        (toks[p].type === "id" && (toks[p].value === "export" || toks[p].value === "default"));

      // import type ... / export type ...  (statement form)
      if ((kw === "import" || kw === "export")) {
        const nx = nextSig(toks, i);
        if (nx >= 0 && toks[nx].type === "id" && toks[nx].value === "type") {
          const nx2 = nextSig(toks, nx);
          // `export type {` or `import type {` / `import type X` -> drop whole statement.
          // But NOT `export type` used as `export type X = ...` (also dropped) — both are type-only.
          // Guard against `import typeof` (flow) — treat `type` followed by ident/brace/star.
          if (nx2 >= 0 && (toks[nx2].value === "{" || toks[nx2].value === "*" || toks[nx2].type === "id")) {
            i = dropStatement(toks, i);
            continue;
          }
        }
      }

      // interface / (top-level) type alias / declare  -> remove declaration
      if (atStmtStart || (toks[p] && toks[p].type === "id" && (toks[p].value === "export" || toks[p].value === "default"))) {
        if (kw === "interface") { i = drop(i, skipInterface(toks, i)); trimDanglingExport(); continue; }
        if (kw === "type" && isTypeAlias(toks, i)) { i = drop(i, dropStatement(toks, i)); trimDanglingExport(); continue; }
        if (kw === "declare") { i = drop(i, skipDeclare(toks, i)); continue; }
        if (kw === "namespace" || kw === "module") {
          // `declare`-free ambient namespace with a body: drop it (best-effort).
          // Guard against the identifier `module` (`module.exports = …`) / a call
          // `module(x)`: only a real declaration has `namespace/module <Name|"str"> {`.
          const nx = nextSig(toks, i);
          const isDecl = nx >= 0 && (toks[nx].type === "id" || toks[nx].type === "str");
          if (isDecl) {
            const body = findNamespaceBody(toks, i);
            if (body >= 0) { i = drop(i, body); trimDanglingExport(); continue; }
          }
        }
        if (kw === "enum" || (kw === "const" && isConstEnum(toks, i))) {
          const lowered = lowerEnum(toks, i);
          if (lowered) { emit(lowered.code); i = drop(i, lowered.next); continue; }
        }
      }

      // `abstract class` -> `class`
      if (kw === "abstract") {
        const nx = nextSig(toks, i);
        if (nx >= 0 && toks[nx].type === "id" && toks[nx].value === "class") {
          i = dropTok(i); // drop `abstract` + following ws
          continue;
        }
      }

      // `as` / `satisfies` cast: drop the keyword and the following type. The type
      // may be an object type (`as { x: number }`) so we do NOT stop at `{`.
      if (kw === "as" || kw === "satisfies") {
        // Only when it follows an expression (prev is id/)/]/str/num/tmpl/`this`).
        if (p >= 0) {
          const end = skipType(toks, nextSig(toks, i));
          i = drop(i, end);
          continue;
        }
      }

      // class ... implements X, Y  -> drop the implements clause (keep extends).
      if (kw === "implements") {
        // drop until `{`
        let k = nextSig(toks, i);
        while (k < N && !(toks[k].type === "punc" && toks[k].value === "{")) k++;
        i = drop(i, k);
        continue;
      }

      // Member modifiers inside a class body / constructor params: drop the word.
      // Inside a constructor's parameter list a modifier ALSO declares a property.
      if (MEMBER_MODIFIERS.has(kw) && isBeforeMember(toks, i)) {
        if (inCtorParams && parenDepth === ctorParenLevel + 1) recordCtorProp(i);
        i = dropTok(i);
        continue;
      }

      // `constructor` — arm parameter-property capture for its `(` … `)`.
      if (kw === "constructor") {
        const nx = nextSig(toks, i);
        if (nx >= 0 && toks[nx].type === "punc" && toks[nx].value === "(") {
          ctorPending = true;
          ctorProps = [];
        }
      }

      // A function/method/class name followed by `<...>` type PARAMETERS.
      raw(t);
      i++;
      // generic type parameters right after a name/keyword like function/class or method name
      continue;
    }

    // punctuators
    if (t.type === "punc") {
      const v = t.value;

      // Generic open `<` — type args (call site), type params (decl site), or the
      // type params of a generic arrow function in expression position.
      if (v === "<" && (isGenericOpen(toks, i) || isGenericArrowOpen(toks, i))) {
        const close = skipAngle(toks, i);
        i = drop(i, close);
        continue;
      }

      // Optional marker `?` in `name?:` / `name?)` / `name?,` (params, fields).
      if (v === "?") {
        const nx = nextSig(toks, i);
        if (nx >= 0 && toks[nx].type === "punc" && (toks[nx].value === ":" || toks[nx].value === ")" || toks[nx].value === "," || toks[nx].value === ";")) {
          // `x?: T` -> the `:` branch below strips the type; here just drop `?`.
          // But keep ternary `a ? b : c`: guard that prev is an id/)/] (a binding),
          // and that this isn't an expression `?`. If followed by `:` we still must
          // ensure it's an annotation, not a conditional — handled by colon logic.
          if (toks[nx].value === ")" || toks[nx].value === "," || toks[nx].value === ";") {
            i = dropTok(i); // pure optional param/field marker
            continue;
          }
          // `?:` optional-with-annotation — drop `?`, let `:` be handled next loop.
          i = dropTok(i);
          continue;
        }
      }

      // Non-null assertion postfix `!` : `foo!.bar`, `foo!)`, `foo!;`, `foo!,`.
      if (v === "!") {
        const nx = nextSig(toks, i);
        const pp = prevSig(toks, i);
        const prevIsValue = pp >= 0 && (toks[pp].type === "id" || toks[pp].type === "str" || toks[pp].type === "num" || toks[pp].type === "tmpl" ||
          (toks[pp].type === "punc" && (toks[pp].value === ")" || toks[pp].value === "]")));
        const nextTok = nx >= 0 ? toks[nx] : null;
        const nextOk = nextTok && (
          (nextTok.type === "punc" && ["." , ")", "]", "}", ";", ",", "?.", "=", "==", "===", "!=", "!==", ":", "&&", "||", "??", "+", "-", "*", "/", ">", "<", ">=", "<="].includes(nextTok.value)) ||
          nextTok == null
        );
        // Distinguish from `!expr` negation (prev not a value) and `!=`/`!==`
        // (already tokenized as one punct, so `!` alone here).
        if (prevIsValue && (nextOk || nx < 0)) {
          i = dropTok(i);
          continue;
        }
      }

      // Type annotation colon: `: T` in a binding/param/return position. We only
      // strip when this `:` is NOT an object-literal key or a ternary branch.
      if (v === ":" && isAnnotationColon(toks, i)) {
        const end = skipType(toks, nextSig(toks, i), ["{", ")", "]", "}"]);
        i = drop(i, end);
        continue;
      }

      // Track paren depth + constructor param list boundaries + body injection.
      if (v === "(") {
        parenDepth++;
        if (ctorPending) { inCtorParams = true; ctorParenLevel = parenDepth - 1; ctorPending = false; }
      } else if (v === ")") {
        if (inCtorParams && parenDepth === ctorParenLevel + 1) {
          inCtorParams = false;
          if (ctorProps.length) awaitCtorBody = true;
        }
        parenDepth--;
      } else if (v === "{" && awaitCtorBody) {
        awaitCtorBody = false;
        raw(t); // emit the `{`
        emit(" " + ctorProps.map((nm) => `this.${nm} = ${nm};`).join(" ") + " ");
        ctorProps = [];
        i++;
        continue;
      }

      raw(t);
      i++;
      continue;
    }

    raw(t);
    i++;
  }
  return out;

  // ---- inner helpers (closures over toks/N) ---------------------------------

  function skipAngle(tk, start) {
    // start at `<`; return index just after matching `>` (handles >> >>>)
    let depth = 0;
    let k = start;
    for (; k < N; k++) {
      const x = tk[k];
      if (x.type === "ws" || x.type === "comment") continue;
      if (x.type !== "punc") continue;
      if (x.value === "<") depth++;
      else if (x.value === ">") { depth--; if (depth === 0) return k + 1; }
      else if (x.value === ">>") { depth -= 2; if (depth <= 0) return k + 1; }
      else if (x.value === ">>>") { depth -= 3; if (depth <= 0) return k + 1; }
    }
    return k;
  }

  function isTypeAlias(tk, idx) {
    // `type Name<...> = ...` : after `type` comes an identifier then `<` or `=`.
    const a = nextSig(tk, idx);
    if (a < 0 || tk[a].type !== "id") return false;
    const b = nextSig(tk, a);
    if (b < 0) return false;
    return tk[b].type === "punc" && (tk[b].value === "=" || tk[b].value === "<");
  }

  function isConstEnum(tk, idx) {
    const a = nextSig(tk, idx);
    return a >= 0 && tk[a].type === "id" && tk[a].value === "enum";
  }

  function skipInterface(tk, idx) {
    // idx at `interface`; skip name + optional generics + extends, then a { } block.
    let k = nextSig(tk, idx);
    while (k < N && !(tk[k].type === "punc" && tk[k].value === "{")) k++;
    if (k >= N) return N;
    // balance braces
    let depth = 0;
    for (; k < N; k++) {
      if (tk[k].type === "punc") {
        if (tk[k].value === "{") depth++;
        else if (tk[k].value === "}") { depth--; if (depth === 0) { k++; break; } }
      }
    }
    // If preceded by `export`, we already emitted `export` — turn it into nothing
    // by trimming a dangling `export`. Simpler: callers ensure export is emitted
    // then this leaves `export ` + removed body -> `export ;`? Avoid that: back
    // out a trailing `export` we may have emitted.
    trimDanglingExport();
    return k;
  }

  function skipDeclare(tk, idx) {
    // `declare` can prefix var/let/const/function/class/namespace/module/global.
    // Drop the whole following declaration/statement or block.
    let k = nextSig(tk, idx);
    if (k < 0) return N;
    const kw = tk[k].type === "id" ? tk[k].value : "";
    if (kw === "global" || kw === "namespace" || kw === "module") {
      const body = findNamespaceBody(tk, k);
      trimDanglingExport();
      return body >= 0 ? body : dropStatement(tk, idx);
    }
    trimDanglingExport();
    // class/function with a body -> drop the block; var/type -> drop to `;`.
    return dropStatement(tk, idx);
  }

  function findNamespaceBody(tk, idx) {
    let k = idx;
    while (k < N && !(tk[k].type === "punc" && tk[k].value === "{")) {
      if (tk[k].type === "punc" && tk[k].value === ";") return k + 1;
      k++;
    }
    if (k >= N) return -1;
    let depth = 0;
    for (; k < N; k++) {
      if (tk[k].type === "punc") {
        if (tk[k].value === "{") depth++;
        else if (tk[k].value === "}") { depth--; if (depth === 0) return k + 1; }
      }
    }
    return N;
  }

  function dropStatement(tk, idx) {
    // Drop tokens from idx until a top-level `;` or a balanced block `{...}` ends
    // the statement, or a newline-terminated declaration without a body.
    let k = idx;
    let brace = 0, paren = 0, brack = 0, angle = 0;
    let sawBody = false;
    for (; k < N; k++) {
      const x = tk[k];
      if (x.type === "ws" || x.type === "comment" || x.type === "str" || x.type === "tmpl" || x.type === "regex" || x.type === "num") continue;
      if (x.type === "punc") {
        const depth = brace + paren + brack + angle;
        if (x.value === "{") { brace++; sawBody = true; }
        else if (x.value === "}") { brace--; if (brace === 0 && sawBody && paren === 0 && brack === 0) { return k + 1; } }
        else if (x.value === "(") paren++;
        else if (x.value === ")") paren--;
        else if (x.value === "[") brack++;
        else if (x.value === "]") brack--;
        else if (x.value === "<") angle++;
        else if (x.value === ">") { if (angle > 0) angle--; }
        else if (x.value === ";" && depth === 0) return k + 1;
      }
    }
    return N;
  }

  function isBeforeMember(tk, idx) {
    // A class-member modifier is followed by another modifier, an identifier, `#`,
    // `[` (computed), `readonly`, or `constructor`/get/set. Heuristic: previous
    // significant token is `{` `;` `}` or another modifier, and next is id/#/[.
    const p = prevSig(tk, idx);
    const nx = nextSig(tk, idx);
    if (nx < 0) return false;
    const nextOk = (tk[nx].type === "id") || (tk[nx].type === "punc" && (tk[nx].value === "#" || tk[nx].value === "[" || tk[nx].value === "*"));
    if (!nextOk) return false;
    if (p < 0) return false;
    const pv = tk[p];
    return (pv.type === "punc" && (pv.value === "{" || pv.value === ";" || pv.value === "}" || pv.value === "(" || pv.value === ",")) ||
      (pv.type === "id" && MEMBER_MODIFIERS.has(pv.value)) ||
      (pv.type === "id" && (pv.value === "static"));
  }

  function isAnnotationColon(tk, idx) {
    // True when `:` at idx introduces a TYPE (param/var/return/field), false for
    // object-literal keys and ternary `?:`.
    const p = prevSig(tk, idx);
    if (p < 0) return false;
    const pv = tk[p];
    // After an identifier or `)` (return type) or `]`/`?`(handled) — candidates.
    const prevIsBindingName = pv.type === "id" && !RESERVED_VALUE.has(pv.value);
    const prevIsParenClose = pv.type === "punc" && pv.value === ")";
    const prevIsBracketClose = pv.type === "punc" && pv.value === "]"; // computed field or index sig
    const prevIsBraceClose = pv.type === "punc" && pv.value === "}"; // destructured binding pattern
    if (!(prevIsBindingName || prevIsParenClose || prevIsBracketClose || prevIsBraceClose)) return false;

    // A `:` after `}` is a type annotation only when the `}` closes a destructuring
    // pattern in a BINDING position — `({ a }: T)` param or `const { a }: T = …`. An
    // object literal `}` followed by `:` (e.g. a ternary `cond ? {…} : x`) is not.
    if (prevIsBraceClose) return isDestructurePatternClose(tk, p);

    // Distinguish object literal `{ key: value }` and ternary `cond ? a : b`.
    // Walk back to see the enclosing context of this `:`.
    const ctx = enclosingContext(tk, idx);
    // Ternary alternate (`cond ? a : b`) and switch/labels are never annotations,
    // regardless of what encloses them.
    if (ctx === "ternary" || ctx === "case") return false;
    // A `:` DIRECTLY after `)` is a return-type annotation in every remaining
    // position — including a method/arrow inside an object literal
    // (`Bun.serve({ fetch(req): Response { … } })`). The object-literal bail below
    // must NOT swallow it, or the `: Response` survives and the module fails to
    // parse. Ternary/case were already excluded above.
    if (prevIsParenClose) return true;
    if (ctx === "object") return false; // property VALUE in an object literal
    return true;
  }

  // Given the index of a `}`, decide whether it closes a destructuring pattern in
  // a binding position (function parameter or `const/let/var`), i.e. its matching
  // `{` is preceded by `(`, `,`, `[`, or a declaration keyword. Used to strip the
  // annotation in `({ a }: T)` / `const { a }: T = …` without touching object
  // literals used as values.
  function isDestructurePatternClose(tk, closeIdx) {
    let depth = 0;
    for (let k = closeIdx; k >= 0; k--) {
      const x = tk[k];
      if (x.__d || x.type !== "punc") continue;
      if (x.value === "}") depth++;
      else if (x.value === "{") {
        depth--;
        if (depth === 0) {
          const pb = prevSig(tk, k);
          if (pb < 0) return false;
          const pbt = tk[pb];
          if (pbt.type === "punc" && (pbt.value === "(" || pbt.value === "," || pbt.value === "[")) return true;
          if (pbt.type === "id" && (pbt.value === "const" || pbt.value === "let" || pbt.value === "var")) return true;
          return false;
        }
      }
    }
    return false;
  }

  function enclosingContext(tk, idx) {
    // Scan backward tracking bracket depth to classify what `{`/`?`/`case` most
    // immediately governs this `:`.
    let paren = 0, brack = 0, brace = 0, angle = 0;
    for (let k = idx - 1; k >= 0; k--) {
      const x = tk[k];
      if (x.__d) continue;
      if (x.type === "ws" || x.type === "comment" || x.type === "str" || x.type === "tmpl" || x.type === "num" || x.type === "regex") continue;
      if (x.type === "id") {
        if ((paren === 0 && brack === 0 && brace === 0) && (x.value === "case")) return "case";
        continue;
      }
      if (x.type !== "punc") continue;
      const v = x.value;
      if (v === ")") paren++;
      else if (v === "(") { if (paren === 0) return "params"; paren--; }
      else if (v === "]") brack++;
      else if (v === "[") { if (brack === 0) return "index"; brack--; }
      else if (v === "}") brace++;
      else if (v === "{") {
        if (brace === 0) {
          // Is this `{` an object literal or a block? If the token before `{` is
          // `=` `(` `,` `[` `return` `:` `=>` `?` `||` `&&` etc -> object literal.
          const pb = prevSig(tk, k);
          if (pb >= 0) {
            const pbt = tk[pb];
            const objBefore = (pbt.type === "punc" && ["=", "(", ",", "[", ":", "=>", "?", "||", "&&", "??", "return"].includes(pbt.value)) ||
              (pbt.type === "id" && pbt.value === "return");
            return objBefore ? "object" : "block";
          }
          return "block";
        }
        brace--;
      }
      else if (v === "?" && paren === 0 && brack === 0 && brace === 0 && angle === 0) return "ternary";
      else if (v === "<") { if (angle > 0) angle--; }
      else if (v === ">") angle++;
      else if ((v === ";" || v === "{" ) && paren === 0 && brack === 0 && brace === 0) return "stmt";
    }
    return "stmt";
  }

  function trimDanglingExport() {
    // If `out` ends with `export ` (optionally with default) after we removed a
    // type-only construct, strip that dangling keyword so we don't emit
    // `export ;`. Only trims trailing `export`/`default` + whitespace.
    out = out.replace(/(?:^|[\s;{}])export\s*$/,(m)=> m.replace(/export\s*$/, ""))
             .replace(/(?:^|[\s;{}])export\s+default\s*$/,(m)=> m.replace(/export\s+default\s*$/, ""));
  }

  function lowerEnum(tk, idx) {
    // idx at `enum` or `const`(const enum). Parse `enum Name { A, B = 2, C = 'x' }`
    // into a runtime object with numeric auto-increment + reverse mapping.
    let k = idx;
    if (tk[k].value === "const") k = nextSig(tk, k); // skip `const`
    // k at `enum`
    const nameIdx = nextSig(tk, k);
    if (nameIdx < 0 || tk[nameIdx].type !== "id") return null;
    const name = tk[nameIdx].value;
    let b = nextSig(tk, nameIdx);
    if (b < 0 || tk[b].value !== "{") return null;
    // collect members until matching }
    let depth = 0;
    let j = b;
    const memberToks = [];
    for (; j < N; j++) {
      const x = tk[j];
      if (x.type === "punc" && x.value === "{") { depth++; if (depth === 1) continue; }
      if (x.type === "punc" && x.value === "}") { depth--; if (depth === 0) { j++; break; } }
      memberToks.push(x);
    }
    // split members on top-level commas
    const members = [];
    let cur = [];
    let d2 = 0;
    for (const x of memberToks) {
      if (x.type === "punc" && (x.value === "(" || x.value === "[" || x.value === "{")) d2++;
      if (x.type === "punc" && (x.value === ")" || x.value === "]" || x.value === "}")) d2--;
      if (x.type === "punc" && x.value === "," && d2 === 0) { members.push(cur); cur = []; continue; }
      cur.push(x);
    }
    if (cur.some((x) => x.type !== "ws" && x.type !== "comment")) members.push(cur);

    let auto = 0;
    const lines = [];
    for (const m of members) {
      const sig = m.filter((x) => x.type !== "ws" && x.type !== "comment");
      if (!sig.length) continue;
      const key = sig[0].value.replace(/^['"]|['"]$/g, "");
      const eq = sig.findIndex((x) => x.type === "punc" && x.value === "=");
      if (eq >= 0) {
        const valToks = sig.slice(eq + 1);
        const valStr = valToks.map((x) => x.value).join("");
        const asNum = Number(valStr);
        if (!Number.isNaN(asNum) && /^-?[0-9]/.test(valStr.trim())) {
          lines.push(`${name}[${name}[${JSON.stringify(key)}] = ${valStr}] = ${JSON.stringify(key)};`);
          auto = asNum + 1;
        } else {
          // string / expression member: no reverse mapping
          lines.push(`${name}[${JSON.stringify(key)}] = ${valStr};`);
        }
      } else {
        lines.push(`${name}[${name}[${JSON.stringify(key)}] = ${auto}] = ${JSON.stringify(key)};`);
        auto++;
      }
    }
    // Was it exported? peek if `out` currently ends with export — keep it.
    const code = `var ${name}; (function (${name}) { ${lines.join(" ")} })(${name} || (${name} = {}));`;
    return { code, next: j };
  }
}

// Identifiers that are NOT binding names (so `word :` isn't a type annotation).
const RESERVED_VALUE = new Set([
  "return", "case", "default", "typeof", "instanceof", "in", "of", "new", "void",
  "delete", "throw", "yield", "await", "else", "do", "true", "false", "null",
  "this", "super",
]);

// ---- JSX (very small, pragma-based) ----------------------------------------
// We reuse a minimal JSX lowering that only handles the common shapes. For
// non-trivial JSX a real toolchain remains the recommended path.
function transformJsx(src, opts) {
  const pragma = (opts && opts.jsxPragma) || "React.createElement";
  const fragment = (opts && opts.jsxFragment) || "React.Fragment";
  // Delegate to a compact recursive-descent JSX parser.
  return lowerJsx(src, pragma, fragment);
}

// Minimal JSX lowering. Handles elements, self-closing tags, attributes (string,
// {expr}, boolean), spread attributes, children (text, {expr}, nested elements),
// and fragments <>...</>. Not a full parser; documented best-effort.
function lowerJsx(src, pragma, fragment) {
  let i = 0;
  const n = src.length;
  let out = "";

  function peek() { return src[i]; }
  function skipTrivia() {
    while (i < n) {
      if (/\s/.test(src[i])) { i++; continue; }
      if (src[i] === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
      if (src[i] === "/" && src[i + 1] === "*") { i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++; i += 2; continue; }
      break;
    }
  }

  // Scan a balanced JS expression until an unbalanced `}` (for {expr}) — copies
  // strings/templates/regex/nested braces.
  function readExprUntilBrace() {
    let depth = 0;
    let s = "";
    while (i < n) {
      const c = src[i];
      if (c === "{") { depth++; s += c; i++; continue; }
      if (c === "}") { if (depth === 0) { i++; break; } depth--; s += c; i++; continue; }
      if (c === '"' || c === "'" || c === "`") { s += readString(c); continue; }
      s += c; i++;
    }
    return transformJsxInner(s);
  }
  function readString(q) {
    let s = src[i]; i++;
    let depth = 0;
    while (i < n) {
      const c = src[i];
      if (c === "\\") { s += c + (src[i + 1] || ""); i += 2; continue; }
      if (q === "`" && c === "$" && src[i + 1] === "{") { depth++; s += "${"; i += 2; continue; }
      if (q === "`" && c === "}" && depth > 0) { depth--; s += c; i++; continue; }
      s += c;
      i++;
      if (c === q && (q !== "`" || depth === 0)) break;
    }
    return s;
  }

  function isTagStart() {
    // `<` followed by identifier, `>` (fragment) — and previous non-space is an
    // expression-start position. We keep this simple: any `<` that begins a tag
    // name char or `>` starts JSX here.
    if (src[i] !== "<") return false;
    const c = src[i + 1];
    return c === ">" || /[A-Za-z]/.test(c) || c === "_" || c === "$";
  }

  function parseElement() {
    // assumes src[i] === '<'
    i++; // consume <
    if (src[i] === ">") { // fragment
      i++;
      const kids = parseChildren();
      // expect </>
      skipClose();
      return `${pragma}(${fragment}, null${kids})`;
    }
    // tag name (supports dotted + namespaced)
    let name = "";
    while (i < n && /[A-Za-z0-9_$.\-:]/.test(src[i])) { name += src[i]; i++; }
    const tag = /^[a-z]/.test(name) ? JSON.stringify(name) : name;
    // attributes
    const props = [];
    for (;;) {
      skipTrivia();
      if (src[i] === "/" && src[i + 1] === ">") { i += 2; return `${pragma}(${tag}, ${propsObj(props)})`; }
      if (src[i] === ">") { i++; break; }
      if (src[i] === "{" ) { // spread {...x}
        i++; skipTrivia();
        if (src[i] === "." && src[i + 1] === "." && src[i + 2] === ".") { i += 3; const e = readExprUntilBrace(); props.push({ spread: e }); continue; }
        const e = readExprUntilBrace(); props.push({ spread: e }); continue;
      }
      // attr name
      let an = "";
      while (i < n && /[A-Za-z0-9_$\-:]/.test(src[i])) { an += src[i]; i++; }
      if (!an) { i++; continue; }
      skipTrivia();
      if (src[i] === "=") {
        i++; skipTrivia();
        if (src[i] === "{") { i++; const e = readExprUntilBrace(); props.push({ k: an, v: e }); }
        else if (src[i] === '"' || src[i] === "'") { const s = readString(src[i]); props.push({ k: an, v: s }); }
        else { props.push({ k: an, v: "true" }); }
      } else {
        props.push({ k: an, v: "true" });
      }
    }
    const kids = parseChildren();
    skipClose();
    return `${pragma}(${tag}, ${propsObj(props)}${kids})`;
  }

  function propsObj(props) {
    if (!props.length) return "null";
    const parts = [];
    for (const p of props) {
      if (p.spread) { parts.push(`...(${p.spread})`); continue; }
      const key = /^[A-Za-z_$][\w$]*$/.test(p.k) ? p.k : JSON.stringify(p.k);
      parts.push(`${key}: ${p.v}`);
    }
    return `{ ${parts.join(", ")} }`;
  }

  function parseChildren() {
    let kids = "";
    let text = "";
    const flushText = () => {
      const t = text.replace(/\s+/g, " ").trim();
      if (t) kids += `, ${JSON.stringify(t)}`;
      text = "";
    };
    while (i < n) {
      if (src[i] === "<" && src[i + 1] === "/") { flushText(); break; }
      if (src[i] === "<" && isTagStart()) { flushText(); kids += `, ${parseElement()}`; continue; }
      if (src[i] === "{") { flushText(); i++; const e = readExprUntilBrace(); if (e.trim()) kids += `, ${e}`; continue; }
      text += src[i]; i++;
    }
    return kids;
  }

  function skipClose() {
    // consume `</name>` or `</>`
    if (src[i] === "<" && src[i + 1] === "/") {
      i += 2;
      while (i < n && src[i] !== ">") i++;
      i++;
    }
  }

  // Top-level: walk tokens, entering JSX at expression positions.
  function transformJsxInner(s) {
    const save = { i, n: n, src };
    // recurse with a fresh scanner over `s`
    return lowerJsx(s, pragma, fragment);
  }

  // Simple driver: copy code, and whenever a JSX element begins in an expression
  // position, lower it.
  let prevNonSpace = "";
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") { out += readString(c); prevNonSpace = c; continue; }
    if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") { out += src[i]; i++; } continue; }
    if (c === "/" && src[i + 1] === "*") { out += "/*"; i += 2; while (i < n && !(src[i] === "*" && src[i + 1] === "/")) { out += src[i]; i++; } out += "*/"; i += 2; continue; }
    if (c === "<" && isTagStart() && jsxAllowed(prevNonSpace)) {
      out += parseElement();
      prevNonSpace = ")";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prevNonSpace = c;
    i++;
  }
  return out;
}

// JSX may begin where an expression may begin: after `(`, `,`, `=`, `=>`, `return`,
// `?`, `:`, `[`, `{`, `&&`, `||`, `??`, `;`, or at the very start.
function jsxAllowed(prev) {
  if (prev === "") return true;
  return ["(", ",", "=", ">", "?", ":", "[", "{", "&", "|", ";", "}"].includes(prev) || prev === "return";
}

/**
 * Transpile a TS/TSX/JSX source string to plain JS, synchronously.
 * @param {string} source
 * @param {string} filename  used only to pick the mode by extension
 * @param {{ jsxPragma?: string, jsxFragment?: string }} [opts]
 * @returns {string}
 */
export function transpileTypeScript(source, filename, opts) {
  const isTsx = /\.(tsx|jsx)$/i.test(filename || "");
  const isJsxOnly = /\.jsx$/i.test(filename || "");
  let out = source;
  // JSX first (so the type stripper sees plain JS), unless it's a `.ts` (no JSX).
  if (isTsx) out = transformJsx(out, opts);
  // Type-strip everything except `.jsx` (which is JS + JSX, no TS types).
  if (!isJsxOnly) out = stripTypes(out);
  return out;
}

/**
 * Return the transpiled JS if `filename` is a TS/JSX module that needs it, else
 * null (so the loader leaves plain JS/JSON untouched). Mirrors the shape of
 * maybePatchEsbuildInProcess / transpileEsm used elsewhere in the loader.
 */
export function maybeTranspileTypeScript(source, filename, opts) {
  if (typeof source !== "string") return null;
  const m = /\.(ts|mts|cts|tsx|jsx)$/i.exec(filename || "");
  if (!m) return null;
  const isTsx = /tsx|jsx/i.test(m[1]);
  if (!isTsx && !looksLikeTs(source, false)) return null; // plain JS in a .ts wrapper
  try {
    return transpileTypeScript(source, filename, opts);
  } catch {
    // Never make things worse: on a transform bug, fall back to the raw source
    // (a genuine syntax error then surfaces at compile time, as it would anyway).
    return null;
  }
}