// HTMLRewriter — the streaming HTML transformer Bun exposes as a global.
//
// Bun's is lol-html, the Rust engine Cloudflare Workers use, and the whole point
// of that design is that it is NOT a DOM: it never builds a tree, never corrects
// your markup, and copies everything it was not asked to change through BYTE FOR
// BYTE. That last property is the one people actually depend on — you rewrite one
// attribute in a 200 KB page and the other 199 KB come out identical, comments,
// odd quoting, stray whitespace and all. A parse-then-serialize shim would pass a
// naive test and quietly reformat every page it touched, so this is a rewriter
// over the source text: tokens carry their own [start, end) offsets, untouched
// tokens are emitted as the original slice, and only a tag someone actually
// modified is re-serialized.
//
// Every behaviour below was measured against bun-1.3.14 on linux-x64 rather than
// inferred from the docs, and the ones that surprised us are called out where
// they are implemented. The published types are wrong in at least one place
// (`transform(Blob)` is documented and throws), which is a good summary of why.
//
// KNOWN DIVERGENCES, all in the strict direction (what runs here runs there):
//
//   * Not streaming. Bun rewrites as bytes arrive, with a bounded buffer; this
//     reads the whole input first. The OUTPUT is the same — including the chunk
//     boundaries its streaming tokenizer produces inside a <script>, which are
//     observable through a text handler and so are reproduced deliberately — but
//     the memory profile and the time-to-first-byte are not.
//   * An `async` handler is only awaited on the `transform(Response)` path. Bun
//     somehow drains one on the string path too; JavaScript cannot, so rather
//     than silently dropping whatever the handler did after its first `await`,
//     the string path throws and says to use a Response.
//   * The selector subset is real CSS but not all of it (see parseSelectorList):
//     an unsupported selector THROWS at `.on()`. It must never be accepted and
//     then silently match nothing — that is a rewrite that quietly does nothing.

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

// Elements whose content is text, not markup: `<script>if (a<b)</script>` must
// not see a `<b>` start tag. Bun agrees — an element selector matching `p` does
// not fire for `<script><p></script>`.
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes"]);

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";

// ---- selectors --------------------------------------------------------------
// A practical subset of what lol-html accepts: tag, `*`, `#id`, `.class`,
// `[attr]`, `[attr=value]` with the five operators, `:not(simple)`,
// `:first-child`, `:nth-child(an+b)`, descendant and `>` combinators, and comma
// lists. Bun's own error strings are reused for the cases it also rejects, since
// those are what a caller will search for.
//
// Refusing is the important half. A selector that parses but never matches turns
// a rewrite into a no-op, and a no-op looks exactly like a page that had nothing
// to rewrite — the failure is invisible at the call site and shows up as a
// missing script tag in production.
const SELECTOR_EMPTY = "The selector is empty.";
const SELECTOR_PSEUDO = "Unsupported pseudo-class or pseudo-element in selector.";
const SELECTOR_ATTR = "Unexpected token in the attribute selector.";
const SELECTOR_UNEXPECTED_END = "Unexpected end of selector.";
const SELECTOR_DANGLING = "Dangling combinator in selector.";
const SELECTOR_CLASS = "Invalid or unescaped class name in selector.";
const SELECTOR_TOKEN = "Unexpected token in selector.";
const SELECTOR_COMBINATOR = (c) => "Unsupported combinator `" + c + "` in selector.";

function parseSelectorList(source) {
  if (typeof source !== "string") throw new Error(SELECTOR_EMPTY);
  const list = [];
  for (const part of splitTopLevel(source, ",")) {
    const trimmed = part.trim();
    if (trimmed === "") throw new Error(SELECTOR_EMPTY);
    list.push(parseComplexSelector(trimmed));
  }
  if (list.length === 0) throw new Error(SELECTOR_EMPTY);
  return list;
}

// Splitting on a separator that must not be inside brackets or parentheses:
// `[data-x=","]` and `:not(a, b)` both contain commas that are not list breaks.
function splitTopLevel(source, sep) {
  const out = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote && source[i - 1] !== "\\") quote = "";
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth--;
    else if (c === sep && depth === 0) {
      out.push(source.slice(start, i));
      start = i + 1;
    }
  }
  out.push(source.slice(start));
  return out;
}

// A complex selector is a list of compounds joined by combinators, kept
// rightmost-first because that is the direction matching runs in.
function parseComplexSelector(source) {
  const parts = [];
  let buffer = "";
  let depth = 0;
  let quote = "";
  const flush = () => {
    const t = buffer.trim();
    if (t) parts.push({ compound: parseCompound(t) });
    buffer = "";
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      buffer += c;
      if (c === quote && source[i - 1] !== "\\") quote = "";
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buffer += c; continue; }
    if (c === "[" || c === "(") depth++;
    if (c === "]" || c === ")") depth--;
    if (depth === 0 && (c === "~" || c === "+")) {
      // lol-html has no sibling combinators; it names the one it found rather
      // than failing generically, and so does this.
      throw new Error(SELECTOR_COMBINATOR(c));
    }
    if (depth === 0 && c === ">") {
      flush();
      parts.push({ combinator: "child" });
      continue;
    }
    if (depth === 0 && /\s/.test(c)) {
      if (buffer.trim()) {
        flush();
        parts.push({ combinator: "descendant" });
      }
      continue;
    }
    buffer += c;
  }
  flush();

  // Collapse "descendant" markers that sit next to a `>` (as in `div > p`).
  const cleaned = [];
  for (const part of parts) {
    if (part.combinator === "descendant" && cleaned.length && cleaned[cleaned.length - 1].combinator === "child") continue;
    if (part.combinator === "child" && cleaned.length && cleaned[cleaned.length - 1].combinator === "descendant") {
      cleaned[cleaned.length - 1] = part;
      continue;
    }
    cleaned.push(part);
  }
  // A leading combinator has nothing on its left and reads as an empty selector;
  // a trailing one is "dangling". Two different messages in the binary, for what
  // looks like one mistake.
  if (cleaned.length === 0 || cleaned[0].combinator) throw new Error(SELECTOR_EMPTY);
  if (cleaned[cleaned.length - 1].combinator) throw new Error(SELECTOR_DANGLING);
  return cleaned;
}

const IDENT = /^-?[_a-zA-Z\u00a0-\uffff][-_a-zA-Z0-9\u00a0-\uffff]*/;

function parseCompound(source) {
  const compound = { tag: null, id: null, classes: [], attrs: [], nots: [], nth: null, nthOfType: null };
  let rest = source;
  let matchedSomething = false;

  while (rest.length) {
    if (rest[0] === "*") {
      compound.tag = null;
      rest = rest.slice(1);
      matchedSomething = true;
      continue;
    }
    if (rest[0] === "#" || rest[0] === ".") {
      const kind = rest[0];
      const m = IDENT.exec(rest.slice(1));
      if (!m) {
        // Three spellings of "that is not a name", three different messages in
        // the binary: `.` runs out of input, `..` is a bad class name, `#` is
        // simply empty. Copied because the message is what a caller searches.
        if (rest.length === 1) throw new Error(kind === "." ? SELECTOR_UNEXPECTED_END : SELECTOR_EMPTY);
        throw new Error(kind === "." ? SELECTOR_CLASS : SELECTOR_EMPTY);
      }
      if (kind === "#") compound.id = m[0];
      else compound.classes.push(m[0]);
      rest = rest.slice(1 + m[0].length);
      matchedSomething = true;
      continue;
    }
    if (rest[0] === "[") {
      const close = rest.indexOf("]");
      // `[a` with no bracket is tolerated as `[a]` (measured); `[`, `[]` and `p[`
      // have nothing to tolerate.
      const body = close === -1 ? rest.slice(1) : rest.slice(1, close);
      if (body.trim() === "") throw new Error(SELECTOR_UNEXPECTED_END);
      compound.attrs.push(parseAttributeSelector(body));
      rest = close === -1 ? "" : rest.slice(close + 1);
      matchedSomething = true;
      continue;
    }
    if (rest[0] === ":") {
      // `::before` and friends are pseudo-ELEMENTS: there is no such token in the
      // stream, so they can never match. Bun rejects them and so does this.
      if (rest[1] === ":") throw new Error(SELECTOR_PSEUDO);
      // Exactly five are supported, measured one by one against the binary:
      // :not(), :first-child, :nth-child(), :first-of-type, :nth-of-type().
      // :last-child, :only-child, :nth-last-child(), :empty, :checked and the
      // rest all throw there — several of them because a rewriter sees a token
      // stream and cannot know what comes after, and the others because they are
      // live browser state. Names are matched case-sensitively: `:NTH-CHILD(2)`
      // matches nothing in the binary, and refusing it here is the strict
      // direction of that same non-answer.
      const m = /^:([-a-zA-Z]+)(\(([^)]*)\))?/.exec(rest);
      if (!m) throw new Error(SELECTOR_PSEUDO);
      if (!m[2] && rest[m[0].length] === "(") {
        // `:nth-child(` never closes; `:not(p` is tolerated as `:not(p)`.
        const inner = rest.slice(m[0].length + 1);
        if (m[1] !== "not" || inner.trim() === "") throw new Error(SELECTOR_UNEXPECTED_END);
        for (const part of splitTopLevel(inner, ",")) {
          const t = part.trim();
          if (!t) throw new Error(SELECTOR_EMPTY);
          compound.nots.push(parseCompound(t));
        }
        rest = "";
        matchedSomething = true;
        continue;
      }
      const name = m[1];
      const arg = m[3] == null ? null : m[3].trim();
      if (name === "not") {
        if (!arg) throw new Error(SELECTOR_EMPTY);
        for (const inner of splitTopLevel(arg, ",")) {
          const t = inner.trim();
          if (!t) throw new Error(SELECTOR_EMPTY);
          compound.nots.push(parseCompound(t));
        }
      } else if (name === "first-child") {
        compound.nth = { a: 0, b: 1 };
      } else if (name === "nth-child") {
        compound.nth = parseNth(arg);
      } else if (name === "first-of-type") {
        compound.nthOfType = { a: 0, b: 1 };
      } else if (name === "nth-of-type") {
        compound.nthOfType = parseNth(arg);
      } else {
        throw new Error(SELECTOR_PSEUDO);
      }
      rest = rest.slice(m[0].length);
      matchedSomething = true;
      continue;
    }
    const m = IDENT.exec(rest);
    if (!m) throw new Error(SELECTOR_EMPTY);
    compound.tag = m[0].toLowerCase();
    rest = rest.slice(m[0].length);
    matchedSomething = true;
  }

  if (!matchedSomething) throw new Error(SELECTOR_EMPTY);
  return compound;
}

function parseAttributeSelector(body) {
  const m = /^\s*([-_a-zA-Z0-9\u00a0-\uffff]+)\s*(?:([~^$*|]?=)\s*(.*?)\s*)?$/.exec(body);
  // `[a=b c]` is a token too many, which the binary reports as a selector-level
  // error rather than an attribute one.
  if (!m) throw new Error(/\s/.test(body.trim()) ? SELECTOR_TOKEN : SELECTOR_ATTR);
  const name = m[1].toLowerCase();
  if (!m[2]) return { name, op: null, value: null };
  let raw = m[3];
  if (raw == null || raw === "") throw new Error(SELECTOR_ATTR);
  if ((raw[0] === '"' && raw.endsWith('"')) || (raw[0] === "'" && raw.endsWith("'"))) {
    raw = raw.slice(1, -1);
  } else if (!IDENT.test(raw) || IDENT.exec(raw)[0].length !== raw.length) {
    // Bun rejects `[data-x=1]` — an unquoted value has to be an identifier, and
    // `1` is not one. Measured, and surprising enough to be worth reproducing:
    // quietly accepting it would make a selector work here and throw there.
    throw new Error(SELECTOR_ATTR);
  }
  return { name, op: m[2], value: raw };
}

function parseNth(arg) {
  if (!arg) throw new Error(SELECTOR_PSEUDO);
  const text = arg.replace(/\s+/g, "").toLowerCase();
  if (text === "odd") return { a: 2, b: 1 };
  if (text === "even") return { a: 2, b: 0 };
  const m = /^([+-]?\d*)n([+-]\d+)?$|^([+-]?\d+)$/.exec(text);
  if (!m) throw new Error(SELECTOR_PSEUDO);
  if (m[3] != null) return { a: 0, b: parseInt(m[3], 10) };
  const aRaw = m[1];
  const a = aRaw === "" || aRaw === "+" ? 1 : aRaw === "-" ? -1 : parseInt(aRaw, 10);
  return { a, b: m[2] ? parseInt(m[2], 10) : 0 };
}

function matchesCompound(compound, frame) {
  if (compound.tag != null && compound.tag !== frame.tagName) return false;
  if (compound.id != null && frame.id !== compound.id) return false;
  for (const cls of compound.classes) if (!frame.classes.has(cls)) return false;
  for (const attr of compound.attrs) if (!matchesAttribute(attr, frame)) return false;
  for (const not of compound.nots) if (matchesCompound(not, frame)) return false;
  if (compound.nth && !matchesNth(compound.nth, frame.childIndex)) return false;
  if (compound.nthOfType && !matchesNth(compound.nthOfType, frame.typeIndex)) return false;
  return true;
}

// 1-based position among siblings (or among same-tag siblings, for -of-type).
function matchesNth({ a, b }, n) {
  if (a === 0) return n === b;
  const k = (n - b) / a;
  return Number.isInteger(k) && k >= 0;
}

function matchesAttribute(attr, frame) {
  const value = frame.attrMap.get(attr.name);
  if (value === undefined) return false;
  if (attr.op === null) return true;
  switch (attr.op) {
    case "=": return value === attr.value;
    case "~=": return value.split(/\s+/).includes(attr.value);
    case "^=": return attr.value !== "" && value.startsWith(attr.value);
    case "$=": return attr.value !== "" && value.endsWith(attr.value);
    case "*=": return attr.value !== "" && value.includes(attr.value);
    case "|=": return value === attr.value || value.startsWith(attr.value + "-");
    default: return false;
  }
}

// `stack` is the open-element chain, innermost last.
function matchesComplex(complex, stack) {
  let index = stack.length - 1;
  let part = complex.length - 1;
  if (!matchesCompound(complex[part].compound, stack[index])) return false;
  part--;
  index--;
  while (part >= 0) {
    const combinator = complex[part].combinator;
    const compound = complex[part - 1].compound;
    if (combinator === "child") {
      if (index < 0 || !matchesCompound(compound, stack[index])) return false;
      index--;
    } else {
      let found = false;
      while (index >= 0) {
        if (matchesCompound(compound, stack[index])) { found = true; index--; break; }
        index--;
      }
      if (!found) return false;
    }
    part -= 2;
  }
  return true;
}

// ---- tokenizer ---------------------------------------------------------------
// Offsets, not strings: every token knows the span of source it came from, which
// is what lets an untouched token be re-emitted verbatim.
function tokenize(html) {
  const tokens = [];
  let i = 0;
  let textStart = 0;
  const pushText = (end) => {
    if (end > textStart) tokens.push({ type: "text", start: textStart, end });
  };

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;

    if (html.startsWith("<!--", lt)) {
      const close = html.indexOf("-->", lt + 4);
      const end = close === -1 ? html.length : close + 3;
      pushText(lt);
      tokens.push({ type: "comment", start: lt, end, textStart: lt + 4, textEnd: close === -1 ? html.length : close });
      i = textStart = end;
      continue;
    }
    if (/^<!doctype/i.test(html.slice(lt, lt + 9))) {
      const close = html.indexOf(">", lt);
      const end = close === -1 ? html.length : close + 1;
      pushText(lt);
      tokens.push({ type: "doctype", start: lt, end, ...parseDoctype(html.slice(lt, end)) });
      i = textStart = end;
      continue;
    }
    if (html.startsWith("</", lt)) {
      const m = /^<\/([^\s/>]+)\s*>?/.exec(html.slice(lt));
      if (!m) { i = lt + 1; continue; }
      pushText(lt);
      tokens.push({ type: "endTag", start: lt, end: lt + m[0].length, name: m[1].toLowerCase() });
      i = textStart = lt + m[0].length;
      continue;
    }
    const nameMatch = /^<([a-zA-Z][^\s/>]*)/.exec(html.slice(lt));
    if (!nameMatch) { i = lt + 1; continue; }

    const tag = parseStartTag(html, lt);
    pushText(lt);
    tokens.push(tag);
    i = textStart = tag.end;

    // Raw-text content: consume to the matching close tag without tokenizing it.
    if (!tag.selfClosing && RAW_TEXT_ELEMENTS.has(tag.name)) {
      const closeRe = new RegExp("</" + tag.name.replace(/[^a-z0-9]/gi, "\\$&") + "[\\s/>]", "i");
      const rest = html.slice(i);
      const found = closeRe.exec(rest);
      const contentEnd = found ? i + found.index : html.length;
      if (contentEnd > i) tokens.push({ type: "text", start: i, end: contentEnd, raw: true });
      i = textStart = contentEnd;
    }
  }
  pushText(html.length);
  return tokens;
}

function parseDoctype(source) {
  const m = /^<!doctype\s+([^\s>]+)/i.exec(source);
  const publicMatch = /public\s+("([^"]*)"|'([^']*)')(\s+("([^"]*)"|'([^']*)'))?/i.exec(source);
  const systemMatch = /system\s+("([^"]*)"|'([^']*)')/i.exec(source);
  return {
    name: m ? m[1].toLowerCase() : null,
    publicId: publicMatch ? (publicMatch[2] != null ? publicMatch[2] : publicMatch[3]) : null,
    systemId: systemMatch
      ? systemMatch[2] != null
        ? systemMatch[2]
        : systemMatch[3]
      : publicMatch && publicMatch[4]
        ? publicMatch[6] != null
          ? publicMatch[6]
          : publicMatch[7]
        : null,
  };
}

function parseStartTag(html, start) {
  const nameMatch = /^<([a-zA-Z][^\s/>]*)/.exec(html.slice(start));
  const name = nameMatch[1].toLowerCase();
  let i = start + nameMatch[0].length;
  const attrs = [];
  let selfClosing = false;

  while (i < html.length) {
    while (i < html.length && /\s/.test(html[i])) i++;
    if (i >= html.length) break;
    if (html[i] === ">") { i++; break; }
    if (html[i] === "/" && html[i + 1] === ">") { selfClosing = true; i += 2; break; }
    if (html[i] === "/") { i++; continue; }

    const attrStart = i;
    while (i < html.length && !/[\s/>=]/.test(html[i])) i++;
    const rawName = html.slice(attrStart, i);
    if (rawName === "") { i++; continue; }
    while (i < html.length && /\s/.test(html[i])) i++;
    let value = "";
    let raw = rawName;
    if (html[i] === "=") {
      i++;
      while (i < html.length && /\s/.test(html[i])) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1);
        const end = close === -1 ? html.length : close;
        value = html.slice(i + 1, end);
        raw = rawName + "=" + quote + value + quote;
        i = close === -1 ? html.length : close + 1;
      } else {
        const valueStart = i;
        while (i < html.length && !/[\s>]/.test(html[i])) i++;
        value = html.slice(valueStart, i);
        raw = rawName + "=" + value;
      }
    }
    attrs.push({ name: rawName.toLowerCase(), value, raw });
  }

  return { type: "startTag", start, end: i, name, rawName: nameMatch[1], attrs, selfClosing };
}

// ---- escaping ----------------------------------------------------------------
// Measured, and the two rules are NOT the same: inserted content escapes &, < and
// > but leaves quotes alone, while an attribute value escapes only the double
// quote. Using one rule for both would either mangle `<a href="?a=1&b=2">` or
// emit an attribute that ends early.
const escapeContent = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escapeAttribute = (s) => String(s).replace(/"/g, "&quot;");

const contentOf = (content, options) => (options && options.html ? String(content) : escapeContent(content));

// ---- the mutable views handed to handlers -------------------------------------

class TextChunk {
  constructor(text, lastInTextNode) {
    this._text = text;
    this._last = lastInTextNode;
    this._before = "";
    this._after = "";
    this._removed = false;
    this._replacement = null;
  }
  get text() { return this._text; }
  get lastInTextNode() { return this._last; }
  get removed() { return this._removed; }
  before(content, options) { this._before += contentOf(content, options); return this; }
  after(content, options) { this._after = contentOf(content, options) + this._after; return this; }
  replace(content, options) { this._replacement = contentOf(content, options); this._removed = true; return this; }
  remove() { this._removed = true; this._replacement = null; return this; }
}

class CommentView {
  constructor(text) {
    this._text = text;
    this._before = "";
    this._after = "";
    this._removed = false;
    this._replacement = null;
    this._edited = false;
  }
  get text() { return this._text; }
  set text(value) { this._text = String(value); this._edited = true; }
  get removed() { return this._removed; }
  before(content, options) { this._before += contentOf(content, options); return this; }
  after(content, options) { this._after = contentOf(content, options) + this._after; return this; }
  replace(content, options) { this._replacement = contentOf(content, options); this._removed = true; return this; }
  remove() { this._removed = true; this._replacement = null; return this; }
}

class DoctypeView {
  constructor(token) {
    this._name = token.name;
    this._publicId = token.publicId;
    this._systemId = token.systemId;
    this._removed = false;
  }
  get name() { return this._name; }
  get publicId() { return this._publicId; }
  get systemId() { return this._systemId; }
  get removed() { return this._removed; }
  remove() { this._removed = true; return this; }
}

class DocumentEndView {
  constructor() { this._append = ""; }
  append(content, options) { this._append += contentOf(content, options); return this; }
}

class EndTagView {
  constructor(name) {
    this._name = name;
    this._before = "";
    this._after = "";
    this._removed = false;
  }
  get name() { return this._name; }
  set name(value) { this._name = String(value); }
  before(content, options) { this._before += contentOf(content, options); return this; }
  after(content, options) { this._after = contentOf(content, options) + this._after; return this; }
  remove() { this._removed = true; return this; }
}

class ElementView {
  constructor(token, namespaceURI, canHaveContent) {
    this._token = token;
    this._tagName = token.name;
    this._renamed = false;
    this._attrs = token.attrs.map((a) => ({ ...a }));
    this._namespaceURI = namespaceURI;
    this._canHaveContent = canHaveContent;
    this._edited = false;
    this._before = "";
    this._after = "";
    this._prepend = "";
    this._append = "";
    this._removed = false;
    this._keepContent = false;
    this._replacement = null;
    this._innerContent = null;
    this._endTagHandlers = [];
  }

  get tagName() { return this._tagName; }
  set tagName(value) { this._tagName = String(value); this._renamed = true; this._edited = true; }
  get removed() { return this._removed; }
  get selfClosing() { return this._token.selfClosing; }
  get canHaveContent() { return this._canHaveContent; }
  get namespaceURI() { return this._namespaceURI; }

  get attributes() {
    const pairs = this._attrs.map((a) => [a.name, a.value]);
    return pairs[Symbol.iterator]();
  }

  getAttribute(name) {
    const found = this._attrs.find((a) => a.name === String(name).toLowerCase());
    return found ? found.value : null;
  }
  hasAttribute(name) {
    return this._attrs.some((a) => a.name === String(name).toLowerCase());
  }
  setAttribute(name, value) {
    const lower = String(name).toLowerCase();
    const text = String(value);
    const found = this._attrs.find((a) => a.name === lower);
    if (found) {
      found.value = text;
      found.raw = null; // re-serialize this one; the rest keep their original text
    } else {
      this._attrs.push({ name: lower, value: text, raw: null });
    }
    this._edited = true;
    return this;
  }
  removeAttribute(name) {
    const lower = String(name).toLowerCase();
    const at = this._attrs.findIndex((a) => a.name === lower);
    if (at !== -1) {
      this._attrs.splice(at, 1);
      this._edited = true;
    }
    return this;
  }

  before(content, options) { this._before += contentOf(content, options); return this; }
  after(content, options) { this._after = contentOf(content, options) + this._after; return this; }
  prepend(content, options) { this._prepend = contentOf(content, options) + this._prepend; return this; }
  append(content, options) { this._append += contentOf(content, options); return this; }
  replace(content, options) { this._replacement = contentOf(content, options); this._removed = true; this._keepContent = false; return this; }
  remove() { this._removed = true; this._keepContent = false; return this; }
  removeAndKeepContent() { this._removed = true; this._keepContent = true; return this; }
  setInnerContent(content, options) { this._innerContent = contentOf(content, options); return this; }

  onEndTag(handler) {
    // Bun's message, verbatim: a void element has no end tag to hang a handler on.
    if (!this._canHaveContent || this._token.selfClosing) throw new Error("No end tag.");
    this._endTagHandlers.push(handler);
  }

  // The start tag as it should appear in the output. Unmodified elements are not
  // rebuilt at all (see the caller) — this runs only when something changed, and
  // it reproduces what lol-html does then: original per-attribute text where the
  // attribute was untouched (so `x='1'` keeps its single quotes), a normalized
  // single space between attributes, and `name="value"` for anything new.
  serializeStartTag() {
    // The ORIGINAL spelling, unless the caller renamed the element: `<SPAN>` with
    // an attribute added comes back as `<SPAN a="1">` from the binary, not
    // `<span …>`. Same for attribute names — `HREF='/x'` keeps its case and its
    // single quotes, and only the attribute that was touched is rewritten.
    let out = "<" + (this._renamed ? this._tagName : this._token.rawName);
    for (const attr of this._attrs) {
      out += " " + (attr.raw != null ? attr.raw : `${attr.name}="${escapeAttribute(attr.value)}"`);
    }
    // `<rect fill="red" />` — the space is Bun's, and a diff against its
    // output is the only way anyone would know.
    if (this._token.selfClosing) out += " /";
    return out + ">";
  }
}

// ---- the rewrite pass ---------------------------------------------------------
// Written as a generator so one implementation serves both entry points: it
// YIELDS whatever a handler returned, and the driver decides what that means.
// The synchronous driver refuses a thenable (it cannot wait, and pretending to
// would drop everything the handler did after its first await); the asynchronous
// one awaits it.
function* rewrite(html, rules, documentHandlers) {
  const tokens = tokenize(html);
  let out = "";
  const stack = [];
  const documentEnd = new DocumentEndView();
  // The document is a parent too: `td:first-of-type` matches a `<td>` sitting at
  // the top level, so root elements need the same sibling tallies a real parent
  // keeps. Found by differential fuzzing — every hand-written case had its
  // elements inside something.
  const root = { childCount: 0, typeCounts: new Map() };

  // Emitting a text chunk means emitting Bun's PAIR: the run itself, then an
  // empty chunk flagged lastInTextNode. Measured — every text run in the binary's
  // output is followed by that empty chunk, and handlers that count chunks or
  // look at `lastInTextNode` depend on seeing it.
  function* handleTextChunk(text, source, isLast) {
    const chunk = new TextChunk(text, isLast);
    for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
      const rule = rules[ruleIndex];
      if (rule.handlers.text && inMatchedSubtree(stack, ruleIndex)) yield rule.handlers.text(chunk);
    }
    if (documentHandlers.text) yield documentHandlers.text(chunk);
    out += chunk._before;
    if (!chunk._removed) out += source;
    else if (chunk._replacement != null) out += chunk._replacement;
    out += chunk._after;
  }

  const suppressed = () => stack.some((f) => f.suppress);

  for (const token of tokens) {
    const source = html.slice(token.start, token.end);

    if (token.type === "text") {
      if (suppressed()) continue;
      // One text NODE, but not necessarily one chunk: inside a raw-text element
      // Bun's tokenizer breaks at every `<` it has to consider and reject, so
      // `var a = "<p>x</p>"` arrives as `var a = "`, `<`, `p>x`, `</p`, `">`.
      // Handlers that inspect chunk text see those boundaries, so they are
      // reproduced rather than papered over with one big chunk.
      for (const piece of token.raw ? rawTextPieces(source) : [source]) {
        yield* handleTextChunk(piece, piece, false);
      }
      yield* handleTextChunk("", "", true);
      continue;
    }

    if (token.type === "comment") {
      const view = new CommentView(html.slice(token.textStart, token.textEnd));
      for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
        const rule = rules[ruleIndex];
        if (rule.handlers.comments && inMatchedSubtree(stack, ruleIndex)) yield rule.handlers.comments(view);
      }
      if (documentHandlers.comments) yield documentHandlers.comments(view);
      if (suppressed()) continue;
      out += view._before;
      if (!view._removed) out += view._edited ? "<!--" + view._text + "-->" : source;
      else if (view._replacement != null) out += view._replacement;
      out += view._after;
      continue;
    }

    if (token.type === "doctype") {
      const view = new DoctypeView(token);
      if (documentHandlers.doctype) yield documentHandlers.doctype(view);
      if (suppressed()) continue;
      if (!view._removed) out += source;
      continue;
    }

    if (token.type === "startTag") {
      const parent = stack[stack.length - 1] || root;
      const childIndex = ++parent.childCount;
      // :nth-of-type counts siblings that share a tag name, so each parent keeps a
      // tally per name rather than one counter.
      const typeIndex = (parent.typeCounts.get(token.name) || 0) + 1;
      parent.typeCounts.set(token.name, typeIndex);
      const namespaceURI =
        token.name === "svg" ? SVG_NS
          : token.name === "math" ? MATHML_NS
            : parent.namespaceURI || HTML_NS;
      const foreign = namespaceURI !== HTML_NS;
      // A void element never has content; in foreign content `<rect/>` closes
      // itself, while `<p/>` in HTML does NOT — measured: selfClosing true,
      // canHaveContent true, and the paragraph still swallows what follows.
      const canHaveContent = foreign ? !token.selfClosing : !VOID_ELEMENTS.has(token.name);
      const closesImmediately = VOID_ELEMENTS.has(token.name) || (foreign && token.selfClosing);

      const frame = {
        matched: null, // rule indices this element itself matches (filled below)
        tagName: token.name,
        namespaceURI,
        attrMap: new Map(token.attrs.map((a) => [a.name, a.value])),
        classes: new Set(String((token.attrs.find((a) => a.name === "class") || {}).value || "").split(/\s+/).filter(Boolean)),
        id: (token.attrs.find((a) => a.name === "id") || {}).value || null,
        childIndex,
        typeIndex,
        childCount: 0,
        typeCounts: new Map(),
        suppress: false,
        element: null,
      };

      stack.push(frame);
      const view = new ElementView(token, namespaceURI, canHaveContent);
      frame.element = view;
      // Which rules this element matches is computed ONCE, here, and remembered on
      // the frame — both because it is the only place the ancestor chain is known
      // and because text and comment handlers need it for the whole subtree: in
      // Bun, `on("p", { text })` fires for `x` in `<p>hello <b>x</b></p>`, not just
      // for text whose immediate parent is the p. Measured; matching only the
      // innermost element silently skipped every nested chunk.
      frame.matched = new Set();
      for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
        if (matchesAny(rules[ruleIndex], stack)) frame.matched.add(ruleIndex);
      }
      for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
        const rule = rules[ruleIndex];
        if (rule.handlers.element && frame.matched.has(ruleIndex)) yield rule.handlers.element(view);
      }

      const wasSuppressed = stack.slice(0, -1).some((f) => f.suppress);
      if (!wasSuppressed) {
        out += view._before;
        if (!view._removed) out += view._edited ? view.serializeStartTag() : source;
        else if (view._replacement != null) out += view._replacement;
        if (!view._removed && canHaveContent) out += view._prepend;
      }
      // Content is dropped for remove()/replace()/setInnerContent(); with
      // removeAndKeepContent() only the tags go.
      frame.suppress = wasSuppressed || (view._removed && !view._keepContent) || view._innerContent != null;
      if (!wasSuppressed && view._innerContent != null && canHaveContent) out += view._innerContent;

      if (closesImmediately || !canHaveContent) {
        stack.pop();
        if (!wasSuppressed) {
          // append() on a void element is a no-op in Bun (measured), because it
          // is placed before an end tag that never comes.
          out += view._after;
        }
      }
      continue;
    }

    if (token.type === "endTag") {
      // Find the frame this closes; ignore a stray end tag, as a token rewriter
      // must (`<p><b>x</p>` keeps its unbalanced shape in Bun's output too).
      let at = -1;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].tagName === token.name) { at = k; break; }
      }
      if (at === -1) {
        if (!suppressed()) out += source;
        continue;
      }
      // Everything opened inside it is implicitly closed.
      while (stack.length - 1 > at) {
        const orphan = stack.pop();
        if (!stack.some((f) => f.suppress) && !orphan.suppress) out += orphan.element._after;
      }
      const frame = stack.pop();
      const view = frame.element;
      const outerSuppressed = stack.some((f) => f.suppress);

      // Renaming the element renames its end tag: `e.tagName = "section"` on a div
      // must close </section>, not </div>. The handler sees the new name too.
      const endTag = new EndTagView(view._tagName);
      const endTagSourceOk = !view._renamed;
      for (const handler of view._endTagHandlers) yield handler(endTag);

      if (!outerSuppressed) {
        // The append content survives a remove(), which is what the binary does:
        // `e.remove(); e.append("Z")` on `<b>x</b>` yields exactly "Z".
        out += view._append;
        out += endTag._before;
        if (!view._removed && !view._keepContent && !endTag._removed) {
          // `</p   >` and `</P>` survive verbatim — an edit to the start tag does
          // not reformat the end tag; only a rename replaces it.
          out += endTagSourceOk && endTag._name === view._tagName ? source : "</" + endTag._name + ">";

        }
        out += endTag._after;
        out += view._after;
      }
      continue;
    }
  }

  // Unclosed elements at EOF: their pending append/after content is dropped,
  // because the end tag it was anchored to never arrived (`<div>x` with an
  // append comes back as `<div>x`).
  if (documentHandlers.end) yield documentHandlers.end(documentEnd);
  out += documentEnd._append;
  return out;
}

// Text and comments belong to every matched element they are nested inside, so
// the question is not "does the innermost element match" but "did any open one".
function inMatchedSubtree(stack, ruleIndex) {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].matched && stack[i].matched.has(ruleIndex)) return true;
  return false;
}

// The split above, isolated: text up to a `<`, then either the bare `<` or the
// whole `</name` run that turned out not to be this element's end tag.
function rawTextPieces(text) {
  const pieces = [];
  let start = 0;
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt === -1) break;
    if (lt > start) pieces.push(text.slice(start, lt));
    if (text[lt + 1] === "/") {
      const run = /^<\/[a-zA-Z]*/.exec(text.slice(lt))[0];
      pieces.push(run);
      i = start = lt + run.length;
    } else {
      pieces.push("<");
      i = start = lt + 1;
    }
  }
  if (start < text.length) pieces.push(text.slice(start));
  return pieces;
}

function matchesAny(rule, stack) {
  for (const complex of rule.selectors) if (matchesComplex(complex, stack)) return true;
  return false;
}

const ASYNC_ON_STRING =
  "HTMLRewriter: an async handler is only supported when transforming a Response. " +
  "This input is rewritten synchronously, so anything the handler does after its first " +
  "`await` would be silently dropped. Wrap the input: " +
  "`await rewriter.transform(new Response(html)).text()`.";

function runSync(html, rules, documentHandlers) {
  const iterator = rewrite(html, rules, documentHandlers);
  let step = iterator.next();
  while (!step.done) {
    const value = step.value;
    if (value != null && typeof value.then === "function") throw new Error(ASYNC_ON_STRING);
    step = iterator.next(value);
  }
  return step.value;
}

async function runAsync(html, rules, documentHandlers) {
  const iterator = rewrite(html, rules, documentHandlers);
  let step = iterator.next();
  while (!step.done) {
    const value = step.value;
    step = iterator.next(value != null && typeof value.then === "function" ? await value : value);
  }
  return step.value;
}

// ---- the global ---------------------------------------------------------------

export function createHTMLRewriter() {
  class HTMLRewriter {
    constructor() {
      this._rules = [];
      this._document = {};
    }

    on(selector, handlers) {
      // Parsing here, not at match time, is deliberate: an unsupported selector is
      // a programming error and should surface at the call that made it.
      this._rules.push({ selectors: parseSelectorList(selector), handlers: handlers || {} });
      return this;
    }

    onDocument(handlers) {
      for (const [key, fn] of Object.entries(handlers || {})) this._document[key] = fn;
      return this;
    }

    transform(input) {
      if (typeof input === "string") return runSync(input, this._rules, this._document);

      if (input instanceof ArrayBuffer || ArrayBuffer.isView(input)) {
        const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        const text = runSync(new TextDecoder().decode(bytes), this._rules, this._document);
        const encoded = new TextEncoder().encode(text);
        // Both a buffer and a view come back as a plain ArrayBuffer — measured.
        return encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
      }

      if (input && typeof input === "object" && typeof input.text === "function" && "headers" in input) {
        const rules = this._rules;
        const documentHandlers = this._document;
        const body = input
          .text()
          .then((text) => runAsync(text, rules, documentHandlers))
          .then((text) => new TextEncoder().encode(text));
        return new Response(
          new ReadableStream({
            async start(controller) {
              try {
                controller.enqueue(await body);
                controller.close();
              } catch (err) {
                controller.error(err);
              }
            },
          }),
          { status: input.status, statusText: input.statusText, headers: input.headers }
        );
      }

      // Bun's own error, including for a Blob — which its published types say is
      // accepted and which the binary rejects.
      const err = new TypeError("Expected Response or Body");
      err.code = "ERR_INVALID_ARG_TYPE";
      throw err;
    }
  }

  return HTMLRewriter;
}
