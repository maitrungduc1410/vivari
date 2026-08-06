// Turning what a cell produced into something to look at: which mime type to
// prefer, what markdown means here, and what of a notebook's HTML we are willing
// to put in the page.
//
// Plain JS (not TS) so `scripts/spike-notebook.mjs` drives this exact code.
//
// WHY THERE IS A SANITISER AT ALL, when Jupyter mostly just renders the HTML.
// Jupyter's answer to this is the trust signature: a notebook you did not
// execute yourself is untrusted and its HTML is stripped. We have no signature
// store, and a `.ipynb` is a thing people download from strangers — so an
// `execute_result` carrying `<img src=x onerror=...>` would run script in the
// STUDIO's origin, which holds the kernel bridge, without the user executing
// anything at all. Opening a file is not consent to run it. The allowlist below
// is the whole policy, and it is exported as data so the spike can enumerate it
// rather than trust a description of it.

/** Richest first. The first one present is the one rendered; the rest are kept
 *  in the file and ignored, which is what a front end is supposed to do. */
export const MIME_ORDER = [
  "image/png",
  "image/jpeg",
  "image/svg+xml",
  "text/html",
  "text/markdown",
  "text/latex",
  "text/plain",
];

/**
 * Every representation in a bundle worth trying, richest first: the ones this
 * knows about in order, then anything else the bundle carries.
 *
 * A LIST rather than a single choice, because picking the richest mime and
 * rendering it are two different decisions and the second one can fail. SVG
 * shipped ranked third and rendering it produced an empty box, with `text/plain`
 * sitting in the same bundle and unreachable — so what a caller needs is the next
 * candidate, not just the best one.
 */
export function mimeCandidates(data) {
  if (!data) return [];
  const out = MIME_ORDER.filter((mime) => mime in data);
  // A mime type invented after this was written. Rendered as text if it is text,
  // named if it is not — either beats an empty box.
  for (const key of Object.keys(data)) if (!out.includes(key)) out.push(key);
  return out;
}

/** The richest representation present. What to actually draw is `chooseRender`. */
export function pickMime(data) {
  const candidates = mimeCandidates(data);
  return candidates.length ? candidates[0] : null;
}

/**
 * nbformat's `multiline_string`: a value is a string OR a list of lines, and real
 * notebooks contain both — `String(["<b>", "x"])` is `"<b>,x"`, which renders the
 * commas.
 */
export function asText(value) {
  return Array.isArray(value) ? value.join("") : String(value);
}

// ── ANSI ────────────────────────────────────────────────────────────────────

// Nothing on the Python side emits colour: `traceback.format_exception` never
// has, and `rich` sees `isatty() is False` on the notebook's streams and writes
// plain text. This exists for the case where something does anyway — a raw
// escape sequence rendered literally is unreadable in a way that looks like the
// output itself is corrupt.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

export function stripAnsi(s) {
  return String(s).replace(ANSI, "");
}

// ── HTML escaping and the output allowlist ──────────────────────────────────

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * Tags an output may use. Chosen from what actually turns up: pandas writes
 * tables with inline styles, matplotlib and friends write images, `_repr_html_`
 * implementations write spans and divs.
 *
 * Everything that can fetch, navigate or execute is absent, and that is the
 * point: no `script`, no `iframe`/`object`/`embed`/`frame`, no `link`, no
 * `form`/`input`/`button`, no `base`, no `meta`.
 *
 * `style` is absent too, and it was here once. A `<style>` element is RAW TEXT:
 * the parser makes its CSS a single text child, the walk below skips text nodes,
 * and the serializer writes raw-text content back out literally — so the CSS came
 * through untouched, and a stylesheet is not scoped to the element it arrived in.
 * An output subtree goes into the studio's own document, so that was unscoped CSS
 * out of a downloaded file restyling the whole IDE: hide the chrome, overlay the
 * viewport, repaint a control. Not script execution, but UI redressing in the
 * origin that holds the kernel bridge, and reachable by OPENING a file rather than
 * by running it — the exact boundary the paragraph above says this exists to hold.
 *
 * WHY IT WENT UNNOTICED, which is the more useful half. The HTML parser hoists a
 * `<style>` arriving before any body content into `<head>`, and this walks
 * `doc.body` — so the shape pandas emits, style block first, was dropped by the
 * parser and looked deliberate. A `<style>` anywhere after the first element
 * stayed in the body and survived, `@import` and all. A check written against the
 * first shape passes against the hole; both are asserted in
 * `spike-notebook-view.mjs` for that reason.
 *
 * pandas needs none of it: the styling it emits is on the `style` ATTRIBUTE, which
 * is still allowed and still refuses `url(`. Putting `<style>` back needs a scoped
 * container (a shadow root) and a CSS parser, not a line in this list.
 */
export const ALLOWED_TAGS = new Set([
  "a", "abbr", "b", "blockquote", "br", "caption", "code", "col", "colgroup", "dd", "del", "details",
  "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i",
  "img", "ins", "kbd", "li", "mark", "ol", "p", "pre", "q", "s", "samp", "small", "span", "strong",
  "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul", "var",
]);

/**
 * Tags whose *content* is text to the parser rather than markup, so removing the
 * element is the only way to remove what is inside it. The walk cannot sanitise
 * these and must not be given the chance to think it did.
 *
 * This is the HTML tokenizer's own list, not a judgement call: `script` and `style`
 * are its raw-text elements, `textarea` and `title` its escapable raw-text ones,
 * and `iframe`, `noembed`, `noframes`, `plaintext`, `xmp` and `noscript` (with
 * scripting enabled, which is the only case that ships) are tokenized the same way.
 * Written out in full because a partial copy of a spec list is the kind of thing
 * that is only wrong for the names nobody thought of — `noframes` and `plaintext`
 * were the two missing, and no assertion could notice while the gate iterated this
 * set to test itself. `spike-notebook.mjs` drives it from an independent copy now.
 */
export const RAW_TEXT_TAGS = new Set([
  "iframe", "noembed", "noframes", "noscript", "plaintext", "script", "style", "textarea", "title", "xmp",
]);

/**
 * Elements whose content a tree walk cannot reach for a reason OTHER than raw
 * text, kept apart from the set above so that neither list has to be read as
 * something it is not.
 *
 * `template` is the whole membership and it is the worse case: its children are
 * parsed into a separate `DocumentFragment` hanging off `.content`, so the element
 * has no child nodes at all — the walk finds nothing to inspect, concludes there is
 * nothing to remove, and the serializer then writes the fragment back out. Measured
 * with it allowlisted, `<template><script>alert(1)</script></template>` survives
 * intact, which `<style>` at least could not manage. Same lock, different door.
 */
export const OPAQUE_TAGS = new Set(["template"]);

/**
 * Attributes allowed on any permitted tag. `on*` is absent by construction —
 * the check below rejects the whole prefix rather than listing handlers.
 *
 * `style` is here, and the third hole in this policy was what it PAINTS. The two
 * before it were found by asking what the allowlist forbids and finding a way
 * through; this one by asking what it permits, which is a different question and
 * the one that had not been asked: the policy modelled execution and egress and
 * had no category for LAYOUT. `position:fixed;inset:0;width:100vw;height:100vh`
 * executes nothing and fetches nothing, so every check here passes it, and it
 * covers the IDE.
 *
 * The fix is not in this file, deliberately. Refusing `position` and `z-index`
 * here would be a denylist of property names read out of CSS text with a regex —
 * the technique the sanitiser docblock below already says is how these are always
 * defeated — and it would be incomplete on the day it landed: `transform` and
 * negative margins escape a box just as well, measured. The container that holds
 * sanitised output takes `contain: layout paint` instead, in `NotebookView.tsx`,
 * which bounds the category rather than enumerating it, and costs nothing for the
 * case `style` is allowed for, since pandas' `Styler` writes colours, borders,
 * alignment and widths and never positioning.
 */
export const ALLOWED_ATTRS = new Set([
  "align", "alt", "border", "cellpadding", "cellspacing", "class", "colspan", "dir", "headers",
  "height", "href", "id", "lang", "rel", "rowspan", "scope", "span", "src", "start", "style",
  "title", "type", "valign", "width",
]);

/** Attributes whose value is a URL, and therefore a way to execute or exfiltrate. */
export const URL_ATTRS = new Set(["href", "src"]);

/**
 * Is this URL safe to put in an output?
 *
 * `data:` is allowed ONLY for images, because that is how an inline PNG arrives
 * and refusing it would break the main case this feature exists for. A
 * `data:text/html` document, on the other hand, is a script delivery mechanism
 * with a different prefix.
 */
export function isSafeUrl(value) {
  const v = String(value).trim();
  // Control characters and whitespace inside a scheme are the classic way to
  // smuggle `javascript:` past a prefix test (`java\tscript:`).
  const flat = v.replace(/[\u0000-\u0020]/g, "").toLowerCase();
  if (flat.startsWith("javascript:") || flat.startsWith("vbscript:")) return false;
  if (flat.startsWith("data:")) return /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,/.test(flat);
  if (/^[a-z][a-z0-9+.-]*:/.test(flat)) return flat.startsWith("http:") || flat.startsWith("https:") || flat.startsWith("mailto:");
  // Relative, a fragment, or protocol-relative (`//host/x`). The last of those is
  // allowed rather than overlooked: it inherits the page's scheme, which is the
  // same http/https already permitted outright, so excluding it would buy nothing.
  return true;
}

/** The whole attribute policy, as one function, so the spike can enumerate it. */
export function isAllowedAttr(tag, name, value) {
  const n = String(name).toLowerCase();
  // Every event handler, including ones that do not exist yet.
  if (n.startsWith("on")) return false;
  if (n === "srcdoc" || n === "srcset" || n === "formaction" || n === "xlink:href") return false;
  if (!ALLOWED_ATTRS.has(n)) return false;
  if (URL_ATTRS.has(n)) return isSafeUrl(value);
  // `style` cannot execute in any browser this ships to, but it can load a
  // remote URL, which is a tracking pixel by another name.
  if (n === "style" && /url\s*\(/i.test(String(value))) return false;
  return true;
}

export function isAllowedTag(tag) {
  const t = String(tag).toLowerCase();
  // An element whose content the walk cannot see can never be allowed, however the
  // list above changes. This is a second lock on the same door: `<style>` was one
  // entry among fifty-odd, and the next person who adds `title` or `textarea` to
  // make some library's output render would reopen it without either of us
  // noticing.
  if (RAW_TEXT_TAGS.has(t) || OPAQUE_TAGS.has(t)) return false;
  return ALLOWED_TAGS.has(t);
}

/**
 * Sanitise a fragment against the policy above.
 *
 * The parse and the walk are the browser's — `DOMParser` is the only HTML parser
 * that agrees with the one that will render the result, and a regex sanitiser
 * that disagrees with the renderer is how these are always defeated. That means
 * this function itself is browser-only; the POLICY it enforces is the pure part
 * above, and that is what the spike checks.
 */
export function sanitizeHtml(html) {
  if (typeof DOMParser === "undefined") return escapeHtml(html);
  const doc = new DOMParser().parseFromString(String(html), "text/html");
  const walk = (node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3 /* text */) continue;
      if (child.nodeType !== 1 /* element */) {
        child.remove();
        continue;
      }
      const tag = child.tagName.toLowerCase();
      if (!isAllowedTag(tag)) {
        child.remove();
        continue;
      }
      for (const attr of Array.from(child.attributes)) {
        if (!isAllowedAttr(tag, attr.name, attr.value)) child.removeAttribute(attr.name);
      }
      if (tag === "a") {
        // An output's link opens away from the studio, and must not hand the
        // opener over with it.
        child.setAttribute("target", "_blank");
        child.setAttribute("rel", "noopener noreferrer");
      }
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
}

// ── what to draw ─────────────────────────────────────────────────────────────

/** Base64 of a UTF-8 string. `btoa` is bytes-only, and an SVG can hold any text. */
function base64Utf8(text) {
  if (typeof btoa !== "function") return null;
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  // Chunked because `fromCharCode(...bytes)` on a large figure overflows the
  // argument list, and a figure is exactly the large case.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * An output value as the text nbformat says it is, or null when it is not text.
 *
 * A value that is not text at all is not content: `String(null)` is `"null"`, four
 * valid base64 characters and four bytes of garbage in an `<img>`. The format says
 * these are strings or lists of strings, so anything else is a bundle that lied,
 * and the next candidate in it is a better bet than four bytes.
 */
function textValue(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) return value.join("");
  return null;
}

/**
 * The base64 payload of an inline raster, or null when there is not one.
 *
 * Emptiness reaches here ordinarily, which is why it is checked rather than
 * assumed away: `mimebundle` skips only `None`, so a repr returning `""` lands in
 * the bundle, and an `.ipynb` may carry `[]`, the natural encoding of empty content
 * in a format whose values are lists of lines.
 *
 * Returning null is what puts the fall-through back in play. `data:...;base64,` is
 * a perfectly TRUTHY string, which is how an empty figure got past a check written
 * as `if (src)`.
 */
function imagePayload(value) {
  const text = textValue(value);
  if (text === null) return null;
  const b64 = text.replace(/\s+/g, "");
  // Two non-padding characters is the smallest base64 that carries a byte, so this
  // is the difference between "some characters" and "some bytes" — `"===="` and a
  // lone NUL are both non-empty and both decode to nothing, and both drew a blank
  // box. Counting characters was the check; having bytes was the claim.
  return b64.replace(/=+$/, "").length >= 2 ? b64 : null;
}

/**
 * An SVG output, as something safe to put on the page.
 *
 * SVG is markup, and markup that carries `<script>`, `on*` handlers,
 * `<foreignObject>` and external references — so it is NOT in `ALLOWED_TAGS` and
 * must not be. It went to `sanitizeHtml` anyway, which duly removed the root
 * element and returned nothing: the richest representation in the bundle rendered
 * as an empty box with `text/plain` sitting next to it, unreachable.
 *
 * The route that fixes it is an `<img>` with a `data:` URL. An SVG loaded as an
 * image is a *restricted* document in every browser this ships to: script does not
 * run and external references do not load, enforced by the image loader rather
 * than by an allowlist of ours. So the picture comes back, `svg` stays banned as a
 * tag, and no closed SVG subset has to be invented and then maintained against
 * whatever the next spec adds. `isSafeUrl` already permits exactly this shape.
 */
export function svgDataUrl(svg) {
  // An SVG's payload is markup rather than base64, so the emptiness rule is the
  // text one: judged on the TRIM while the encoding is not, so a figure's own
  // trailing newline survives a round trip and `"  "` does not become a URL.
  const text = textValue(svg);
  if (text === null || !text.trim()) return null;
  const b64 = base64Utf8(text);
  return b64 ? `data:image/svg+xml;base64,${b64}` : null;
}

/**
 * Decide what an output's mime bundle should become on screen.
 *
 * This exists as one pure-ish function — the only impurity is `sanitizeHtml`
 * needing a DOM — because the decision is where the bugs were, and a decision
 * spread across a component's `if`s is a decision no tier can drive. It has one
 * invariant worth stating: **it never returns something it can tell draws
 * nothing.** A representation with no content is not rendered; the next candidate
 * is tried, and if the bundle runs out the result says so out loud. "Run pressed,
 * nothing on screen, nothing said" is the recurring failure of this feature — the
 * instances are enumerated in AGENTS.md, under the kernel-transport lesson — and
 * two of them shipped from right here: an SVG stripped to an empty div, and an
 * empty payload accepted as an image. The fix for that class is structural rather
 * than another patched branch.
 *
 * The zero-byte raster is not a sixth, and this is settled by measurement rather
 * than by taste. In the original commit `DataView` rendered a raster as
 * `` src={`data:${mime};base64,${String(value)}`} `` with no guard of any kind, so
 * `""`, `"===="` and `"\u0000"` were one unguarded expression drawing one blank
 * box, character for character — the empty payload and the zero-byte raster are
 * two shapes reaching the same line, not two defects. The stripped SVG was live in
 * that same commit too. All three were reachable before this function existed;
 * only their discovery was spread across three rounds, and a defect already present
 * when an instance was counted cannot be a later instance of it.
 *
 * WHERE THAT STOPS, said here so the sentence above is not read as more than it is:
 * emptiness is decidable and is what shipped both of the boxes above — no bytes, no
 * text, no elements. Blankness is not. `<svg/>` is a well-formed document that paints
 * nothing, a 1×1 transparent PNG is bytes and paints nothing, and telling either
 * apart from a figure needs a layout, which is a browser rather than a function.
 * The line is drawn where a decision can be made honestly, and the fall-through
 * cannot rescue what is beyond it.
 *
 * The invariant is about WHAT A READER SEES, not about which fields are set, and
 * the difference is not pedantic: the first version of it returned
 * `{kind:"image", src:"data:image/svg+xml;base64,"}` for an empty figure — every
 * field populated, a truthy URL, and a blank box on the page. So each branch below
 * checks its payload rather than its plumbing, and the assertion that guards this
 * in `spike-notebook.mjs` measures what would be visible rather than reading these
 * fields back.
 *
 * @returns {{kind: "image"|"html"|"markdown"|"json"|"text"|"notice", mime: string|null,
 *            src?: string, html?: string, text?: string, value?: unknown} | null}
 */
export function chooseRender(data) {
  const candidates = mimeCandidates(data);
  if (!candidates.length) return null;
  for (const mime of candidates) {
    const value = data[mime];
    if (mime === "image/png" || mime === "image/jpeg" || mime === "image/gif" || mime === "image/webp") {
      const b64 = imagePayload(value);
      if (b64) return { kind: "image", mime, src: `data:${mime};base64,${b64}` };
      continue;
    }
    if (mime === "image/svg+xml") {
      const src = svgDataUrl(value);
      if (src) return { kind: "image", mime, src };
      continue;
    }
    if (mime === "text/html") {
      const html = sanitizeHtml(asText(value));
      // Empty after sanitising: everything the output was made of is refused by
      // the policy. Falling through is the honest move — the bundle almost always
      // carries a `text/plain` that says what the object was.
      if (html.trim()) return { kind: "html", mime, html };
      continue;
    }
    if (mime === "text/markdown") {
      const html = renderMarkdown(asText(value));
      if (html.trim()) return { kind: "markdown", mime, html };
      continue;
    }
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      return { kind: "json", mime, value };
    }
    const text = asText(value);
    if (text.trim()) return { kind: "text", mime, text };
  }
  // Every representation was empty or unrenderable. Name them: a user looking at
  // this needs to know the kernel sent something, and what.
  return {
    kind: "notice",
    mime: null,
    text: `[${candidates.join(", ")} — nothing in this output could be rendered here; it is preserved on save]`,
  };
}

// ── markdown ────────────────────────────────────────────────────────────────

/**
 * Markdown for markdown cells.
 *
 * Deliberately small, and deliberately not a dependency: the studio has no
 * markdown renderer today, adding one to render a heading is a poor trade, and
 * every one of them arrives with its own opinion about raw HTML. This handles
 * what a notebook's prose actually uses. Anything it does not know stays as the
 * text the user typed, which is the failure mode you want in a document editor.
 *
 * The input is escaped BEFORE any rule runs, so a markdown cell cannot inject
 * HTML at all — the same argument as the output sanitiser, settled more cheaply
 * because prose does not need `<table>`.
 */
export function renderMarkdown(src) {
  const lines = String(src).split("\n");
  const out = [];
  let i = 0;
  let list = null; // "ul" | "ol"

  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };

  while (i < lines.length) {
    const line = lines[i];

    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      closeList();
      const body = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence
      const cls = fence[1] ? ` class="language-${escapeHtml(fence[1])}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      closeList();
      out.push("<hr />");
      i++;
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const want = bullet ? "ul" : "ol";
      if (list !== want) {
        closeList();
        out.push(`<${want}>`);
        list = want;
      }
      out.push(`<li>${inline((bullet || numbered)[1])}</li>`);
      i++;
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      closeList();
      const body = [quote[1]];
      i++;
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote><p>${inline(body.join(" "))}</p></blockquote>`);
      continue;
    }

    if (line.trim() === "") {
      closeList();
      i++;
      continue;
    }

    // A paragraph runs until a blank line or a block that starts one.
    closeList();
    const para = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,6}\s|```|>\s?|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i])) {
      para.push(lines[i++]);
    }
    out.push(`<p>${inline(para.join("\n"))}</p>`);
  }
  closeList();
  return out.join("\n");
}

/** Inline spans. Code first, so `**` inside backticks stays literal. */
function inline(text) {
  const codes = [];
  let s = escapeHtml(text).replace(/`([^`]+)`/g, (_m, code) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) =>
    isSafeUrl(url) ? `<img alt="${alt}" src="${url}" />` : m,
  );
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, url) =>
    isSafeUrl(url) ? `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>` : m,
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_])_([^_]+)_/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, n) => `<code>${codes[Number(n)]}</code>`);
}
