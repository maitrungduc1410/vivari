// Read templates straight out of packages/studio/src/vv/templates.ts.
//
// The studio file is TypeScript and the repo's own type-stripper cannot parse
// it, so rather than keep a copy of ~1500 lines of template source in a spike
// (and watch it drift), scan the shipped file for the `manifest: { … }` and
// `files: { "<name>": `…`, … }` blocks and attribute each to its `id:`. If
// templates.ts is ever reformatted past what this understands, the caller fails
// loudly — which is the correct outcome, not a silent pass against a stale copy.
//
// Shared by scripts/spike-python-offline.mjs (registry integrity, no Pyodide)
// and scripts/spike-python-bridge.mjs (runs the files against real Pyodide).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const TEMPLATES_TS = path.join(ROOT, "packages/studio/src/vv/templates.ts");

export function readTemplatesSource() {
  return fs.readFileSync(TEMPLATES_TS, "utf8");
}

// Whitespace, plus the // and /* */ comments several templates carry between
// their entries.
function skipTrivia(source, pos) {
  for (;;) {
    while (pos < source.length && /\s/.test(source[pos])) pos++;
    if (source.startsWith("//", pos)) { pos = source.indexOf("\n", pos) + 1; continue; }
    if (source.startsWith("/*", pos)) { pos = source.indexOf("*/", pos) + 2; continue; }
    return pos;
  }
}

// Step over a non-literal value to the comma (or closing brace) that ends it.
function skipValue(source, pos) {
  let depth = 0;
  while (pos < source.length) {
    const c = source[pos];
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      pos++;
      while (source[pos] !== quote) pos += source[pos] === "\\" ? 2 : 1;
    } else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return pos;
      depth--;
    } else if (c === "," && depth === 0) return pos;
    pos++;
  }
  return pos;
}

function readFileEntries(source, pos) {
  const files = {};
  for (;;) {
    pos = skipTrivia(source, pos);
    if (source[pos] === "}") return files;
    // Computed keys ([`src/index.${ext}`]) and spreads aren't statically
    // resolvable. Nothing the Python spikes cover uses them, so step over the pair.
    if (source[pos] !== '"') {
      pos = skipValue(source, pos);
      if (source[pos] === ",") pos++;
      continue;
    }
    // Key: a JSON string.
    let end = pos + 1;
    while (source[end] !== '"') end += source[end] === "\\" ? 2 : 1;
    const name = JSON.parse(source.slice(pos, end + 1));
    pos = skipTrivia(source, end + 1);
    if (source[pos] !== ":") throw new Error(`expected ':' after ${name} at offset ${pos}`);
    pos = skipTrivia(source, pos + 1);
    // Some templates build a file from a shared helper (reactViteConfig,
    // reactIndexHtml("jsx"), …) rather than an inline literal. Nothing the
    // Python spikes cover does, so step over those instead of failing on them.
    if (source[pos] !== "`") {
      pos = skipValue(source, pos);
      if (source[pos] === ",") pos++;
      continue;
    }
    // Value: a template literal, up to the first unescaped backtick.
    pos++;
    let body = "";
    while (source[pos] !== "`") {
      if (source[pos] === "\\") {
        const next = source[pos + 1];
        body += next === "`" ? "`" : next === "\\" ? "\\" : next === "$" ? "$" : "\\" + next;
        pos += 2;
      } else {
        body += source[pos];
        pos++;
      }
    }
    files[name] = body;
    pos = skipTrivia(source, pos + 1);
    if (source[pos] === ",") pos++;
  }
}

/** { templateId: { "path/in/project": contents } } for every inline-literal file. */
export function readShippedTemplates(source) {
  const ids = [...source.matchAll(/\n {6}id: "([^"]+)",/g)].map((m) => ({
    id: m[1],
    at: m.index,
  }));
  const out = {};
  for (const m of source.matchAll(/\n {4}files: \{\n/g)) {
    const start = m.index + m[0].length;
    const owner = ids.filter((i) => i.at < m.index).pop();
    if (!owner) continue;
    out[owner.id] = readFileEntries(source, start);
  }
  return out;
}

// Everything up to the `}` that closes the block opened just before `pos`.
// (skipValue stops at the first top-level comma, which is one manifest field.)
function sliceBraceBlock(source, pos) {
  let depth = 0;
  let i = pos;
  while (i < source.length) {
    const c = source[i];
    // A `'` inside a comment ("don't") would otherwise open a string that never
    // closes, so comments are skipped before quotes are considered.
    if (source.startsWith("//", i)) {
      const nl = source.indexOf("\n", i);
      i = nl === -1 ? source.length : nl;
      continue;
    }
    if (source.startsWith("/*", i)) {
      const close = source.indexOf("*/", i);
      i = close === -1 ? source.length : close + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i++;
      while (i < source.length && source[i] !== quote) i += source[i] === "\\" ? 2 : 1;
    } else if (c === "{") depth++;
    else if (c === "}") {
      if (depth === 0) return source.slice(pos, i);
      depth--;
    }
    i++;
  }
  return source.slice(pos, i);
}

/** { templateId: { id, name, dev, install, entry, port, experimental, … } }. */
export function readShippedManifests(source) {
  const out = {};
  for (const m of source.matchAll(/\n {4}manifest: \{\n/g)) {
    const start = m.index + m[0].length;
    const body = sliceBraceBlock(source, start);
    const fields = {};
    for (const f of body.matchAll(/^ {6}(\w+): (?:"((?:[^"\\]|\\.)*)"|(true|false)|(-?\d+)),$/gm)) {
      fields[f[1]] =
        f[2] !== undefined ? JSON.parse(`"${f[2]}"`) : f[3] !== undefined ? f[3] === "true" : Number(f[4]);
    }
    if (fields.id) out[fields.id] = fields;
  }
  return out;
}