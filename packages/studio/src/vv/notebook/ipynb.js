// Reading and writing `.ipynb` — the notebook format, which is the only reason
// this feature interoperates with anything.
//
// Plain JS (not TS) so `scripts/spike-notebook.mjs` can round-trip the exact code
// the studio ships; `s3-app-source.js` is here for the same reason.
//
// THE RULE THIS FILE IS BUILT AROUND: a field we do not understand is a field
// somebody else does. A notebook carries kernel specs, language info, per-cell
// tags, slideshow metadata, widget state, Colab and VS Code sections, output mime
// types invented by libraries that did not exist when this was written — and a
// tool that drops them on save has silently damaged the user's file. So every
// cell keeps the object it was parsed from, and serialising re-emits that object
// with only the fields we actually manage written over it. What we do not touch,
// we hand back.
//
// It goes further than preserving keys: a cell whose text was not edited is
// re-emitted byte-for-byte, in whatever shape it arrived in. nbformat allows
// `source` to be a string OR a list of lines, real notebooks contain both, and
// rewriting one as the other turns "opened a notebook" into a diff across every
// cell in the file.

/** The `nbformat` we write when creating a notebook from nothing. */
export const NBFORMAT = 4;
/** `nbformat_minor` 5 is the one that gave cells stable ids. */
export const NBFORMAT_MINOR = 5;

/** nbformat's "multiline string": either a string or a list of lines. */
export function joinSource(v) {
  if (Array.isArray(v)) return v.join("");
  return typeof v === "string" ? v : "";
}

/** Split text the way nbformat does: newline KEPT on every line but the last,
 *  and no trailing empty element. `"a\nb"` is `["a\n", "b"]`, `"a\n"` is `["a\n"]`. */
export function splitSource(text) {
  if (text === "") return [];
  const parts = text.split("\n");
  const out = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts[i] + "\n");
  if (parts[parts.length - 1] !== "") out.push(parts[parts.length - 1]);
  return out;
}

let idSeq = 0;
/** A cell id: `[a-zA-Z0-9-_]{1,64}` per the nbformat 4.5 schema. */
export function newCellId() {
  idSeq++;
  const rand = Math.random().toString(36).slice(2, 8);
  return `c${idSeq.toString(36)}${rand}`;
}

/** Reset the id counter. Tests only — ids are otherwise process-lifetime unique. */
export function resetIdSeq() {
  idSeq = 0;
}

/** An empty notebook, in the shape `parseNotebook` returns. */
export function emptyNotebook() {
  return {
    cells: [newCell("code")],
    metadata: {},
    nbformat: NBFORMAT,
    nbformatMinor: NBFORMAT_MINOR,
    raw: {},
  };
}

/** A fresh cell of `type` (`code` | `markdown` | `raw`). */
export function newCell(type, source = "") {
  return {
    id: newCellId(),
    type,
    source,
    executionCount: null,
    outputs: [],
    raw: null,
  };
}

/**
 * Parse `.ipynb` text. Throws on anything that is not a notebook — a caller that
 * gets an object back can rely on `cells` being an array of the shape above.
 */
export function parseNotebook(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new Error("not valid JSON: " + (e && e.message ? e.message : String(e)));
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("not a JSON object");
  const nbformat = typeof doc.nbformat === "number" ? doc.nbformat : NBFORMAT;
  // Version before shape. v3 and earlier nest cells under `worksheets`, which is
  // a different format rather than a smaller one — checking for `cells` first
  // diagnoses one as "not a notebook", which sends the user looking for the wrong
  // problem in a file that is perfectly valid.
  if (nbformat !== 4) throw new Error(`nbformat ${nbformat} is not supported (this reads nbformat 4)`);
  if (!Array.isArray(doc.cells)) throw new Error("no `cells` array — not a notebook");
  const nbformatMinor = typeof doc.nbformat_minor === "number" ? doc.nbformat_minor : NBFORMAT_MINOR;
  return {
    cells: doc.cells.map((c) => parseCell(c, nbformatMinor)),
    metadata: doc.metadata && typeof doc.metadata === "object" ? doc.metadata : {},
    nbformat,
    nbformatMinor,
    raw: doc,
  };
}

function parseCell(raw, nbformatMinor) {
  const obj = raw && typeof raw === "object" ? raw : {};
  const type = typeof obj.cell_type === "string" ? obj.cell_type : "raw";
  return {
    // Below 4.5 cells have no ids at all, so one is minted to key the UI with.
    // It is NOT written back out — see serializeCell.
    id: typeof obj.id === "string" && obj.id ? obj.id : newCellId(),
    type,
    source: joinSource(obj.source),
    executionCount: typeof obj.execution_count === "number" ? obj.execution_count : null,
    outputs: Array.isArray(obj.outputs) ? obj.outputs.map(parseOutput) : [],
    raw: obj,
    hadId: typeof obj.id === "string" && !!obj.id,
    minor: nbformatMinor,
  };
}

/**
 * An output, normalised just enough to render: the multiline strings joined,
 * everything else left exactly as it came. `raw` carries the original so an
 * output type this does not know about survives a save unchanged.
 */
function parseOutput(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const kind = typeof o.output_type === "string" ? o.output_type : "";
  if (kind === "stream") {
    return { output_type: "stream", name: o.name === "stderr" ? "stderr" : "stdout", text: joinSource(o.text), raw: o };
  }
  if (kind === "execute_result" || kind === "display_data") {
    return {
      output_type: kind,
      data: joinData(o.data),
      metadata: o.metadata && typeof o.metadata === "object" ? o.metadata : {},
      execution_count: typeof o.execution_count === "number" ? o.execution_count : null,
      raw: o,
    };
  }
  if (kind === "error") {
    return {
      output_type: "error",
      ename: typeof o.ename === "string" ? o.ename : "",
      evalue: typeof o.evalue === "string" ? o.evalue : "",
      traceback: Array.isArray(o.traceback) ? o.traceback.map(String) : [],
      raw: o,
    };
  }
  // Something this version does not know. Kept whole; the renderer says so
  // rather than showing nothing, and the writer hands it straight back.
  return { output_type: kind || "unknown", raw: o };
}

/** Every text mime type in a bundle is a multiline string; image ones are base64
 *  strings and must NOT be touched. Joining both is safe — join is identity on a
 *  string — but the distinction matters when writing, so it is made there. */
function joinData(data) {
  if (!data || typeof data !== "object") return {};
  const out = {};
  for (const [mime, v] of Object.entries(data)) out[mime] = Array.isArray(v) ? v.join("") : v;
  return out;
}

/**
 * Serialise back to `.ipynb` text.
 *
 * Byte-for-byte matching `nbformat.writes`: one-space indent, keys sorted, one
 * trailing newline. That is not cosmetic — it is what keeps a notebook this
 * studio saved from showing up as a whole-file diff next to one Jupyter saved.
 */
export function serializeNotebook(nb) {
  const base = nb.raw && typeof nb.raw === "object" ? nb.raw : {};
  const doc = {
    ...base,
    cells: nb.cells.map(serializeCell),
    metadata: nb.metadata ?? {},
    nbformat: nb.nbformat ?? NBFORMAT,
    nbformat_minor: nb.nbformatMinor ?? NBFORMAT_MINOR,
  };
  return stableJson(doc) + "\n";
}

function serializeCell(cell) {
  const base = cell.raw && typeof cell.raw === "object" ? cell.raw : {};
  const out = { ...base, cell_type: cell.type, source: emitSource(cell) };
  if (!out.metadata || typeof out.metadata !== "object") out.metadata = {};

  // Cell ids arrived in 4.5. Writing one into a 4.4 notebook makes it fail
  // validation against its own declared version, so the id is emitted only where
  // it belongs — and a 4.5 cell that came in without one gets the one we minted.
  const minor = typeof cell.minor === "number" ? cell.minor : NBFORMAT_MINOR;
  if (minor >= 5) out.id = cell.id;
  else delete out.id;

  if (cell.type === "code") {
    out.execution_count = cell.executionCount ?? null;
    out.outputs = (cell.outputs ?? []).map(serializeOutput);
  } else {
    // A markdown cell carrying `outputs` is not valid nbformat; if one arrived
    // that way it was a code cell before someone changed its type here.
    delete out.execution_count;
    delete out.outputs;
  }
  return out;
}

/** Unedited text goes back exactly as it arrived — same shape, same bytes. An
 *  edited cell is written as a line list, which is what Jupyter writes. */
function emitSource(cell) {
  const base = cell.raw && typeof cell.raw === "object" ? cell.raw : null;
  if (base && "source" in base && joinSource(base.source) === cell.source) return base.source;
  return splitSource(cell.source);
}

function serializeOutput(out) {
  const base = out.raw && typeof out.raw === "object" ? out.raw : {};
  if (out.output_type === "stream") {
    const text = "text" in base && joinSource(base.text) === out.text ? base.text : splitSource(out.text);
    return { ...base, output_type: "stream", name: out.name, text };
  }
  if (out.output_type === "execute_result" || out.output_type === "display_data") {
    const o = { ...base, output_type: out.output_type, data: emitData(out.data, base.data), metadata: out.metadata ?? {} };
    if (out.output_type === "execute_result") o.execution_count = out.execution_count ?? null;
    else delete o.execution_count;
    return o;
  }
  if (out.output_type === "error") {
    return { ...base, output_type: "error", ename: out.ename, evalue: out.evalue, traceback: out.traceback };
  }
  return base;
}

/** Text mime types are written as line lists; `image/png` and friends are single
 *  base64 strings and splitting them on newlines would corrupt them. */
function emitData(data, baseData) {
  const out = {};
  for (const [mime, v] of Object.entries(data ?? {})) {
    if (typeof v !== "string") {
      out[mime] = v; // application/json and friends: a real object, not a string
      continue;
    }
    const prior = baseData && typeof baseData === "object" ? baseData[mime] : undefined;
    if (prior !== undefined && joinSource(prior) === v) {
      out[mime] = prior; // untouched: hand back the exact shape it arrived in
      continue;
    }
    out[mime] = mime.startsWith("image/") && mime !== "image/svg+xml" ? v : splitSource(v);
  }
  return out;
}

/** `JSON.stringify` with keys sorted at every level — `json.dumps(sort_keys=True)`,
 *  which is what nbformat writes with. */
export function stableJson(value) {
  return JSON.stringify(sortKeys(value), null, 1);
}

function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
    return out;
  }
  return v;
}
