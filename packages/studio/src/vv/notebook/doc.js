// The notebook document: cells, the edits you can make to them, and the sink the
// session writes execution results into.
//
// Plain JS (not TS) so `scripts/spike-notebook.mjs` drives this exact code.
//
// This is the store the React view subscribes to. It is deliberately the only
// place that mutates a notebook, so "what does Run do to the document" is one
// readable file rather than something reconstructed from a component tree.

import { newCell, newCellId, parseNotebook, serializeNotebook, emptyNotebook } from "./ipynb.js";

/** Consecutive stream outputs of the same name are merged into one. Both Jupyter
 *  and the .ipynb schema expect this — and without it, a loop printing 10,000
 *  lines becomes 10,000 output objects in the saved file. */
function appendStream(outputs, name, text) {
  const last = outputs[outputs.length - 1];
  if (last && last.output_type === "stream" && last.name === name) {
    // The merged output is no longer the one that was read from disk, so its
    // `raw` must go: keeping it would make the writer emit the original bytes and
    // silently drop everything appended since.
    outputs[outputs.length - 1] = { output_type: "stream", name, text: last.text + text, raw: null };
    return;
  }
  outputs.push({ output_type: "stream", name, text, raw: null });
}

export class NotebookDoc {
  constructor(nb) {
    this.nb = nb ?? emptyNotebook();
    this.listeners = new Set();
    this.version = 0;
    /** Cells whose outputs came from an interpreter that is no longer running.
     *  Shown dimmed: the number next to a cell is only meaningful for the kernel
     *  that produced it. */
    this.stale = new Set();
    this.selected = this.nb.cells.length ? this.nb.cells[0].id : null;
    this.dirty = false;
    this.getSnapshot = this.getSnapshot.bind(this);
    this.subscribe = this.subscribe.bind(this);
  }

  static fromText(text) {
    return new NotebookDoc(parseNotebook(text));
  }

  toText() {
    return serializeNotebook(this.nb);
  }

  // ── store ──────────────────────────────────────────────────────────────────

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getSnapshot() {
    return this.version;
  }

  changed({ dirty = true } = {}) {
    if (dirty) this.dirty = true;
    this.version++;
    for (const fn of this.listeners) fn();
  }

  get cells() {
    return this.nb.cells;
  }

  indexOf(id) {
    return this.nb.cells.findIndex((c) => c.id === id);
  }

  cell(id) {
    return this.nb.cells.find((c) => c.id === id) ?? null;
  }

  // ── editing ────────────────────────────────────────────────────────────────

  setSource(id, source) {
    const c = this.cell(id);
    if (!c || c.source === source) return;
    c.source = source;
    this.changed();
  }

  select(id) {
    if (this.selected === id) return;
    this.selected = id;
    this.changed({ dirty: false });
  }

  /** Insert a cell at `index` (default: after the selection). Returns its id. */
  insert(type = "code", index = null, source = "") {
    const at = index == null ? this.indexOf(this.selected) + 1 : index;
    const cell = newCell(type, source);
    cell.minor = this.nb.nbformatMinor;
    this.nb.cells.splice(Math.max(0, Math.min(at, this.nb.cells.length)), 0, cell);
    this.selected = cell.id;
    this.changed();
    return cell.id;
  }

  remove(id) {
    const i = this.indexOf(id);
    if (i < 0) return;
    this.nb.cells.splice(i, 1);
    // A notebook with no cells has no way back to having one, since every insert
    // is relative to a selection.
    if (this.nb.cells.length === 0) {
      const cell = newCell("code");
      cell.minor = this.nb.nbformatMinor;
      this.nb.cells.push(cell);
    }
    this.selected = this.nb.cells[Math.min(i, this.nb.cells.length - 1)].id;
    this.changed();
  }

  move(id, delta) {
    const i = this.indexOf(id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.nb.cells.length) return;
    const [c] = this.nb.cells.splice(i, 1);
    this.nb.cells.splice(j, 0, c);
    this.changed();
  }

  setType(id, type) {
    const c = this.cell(id);
    if (!c || c.type === type) return;
    c.type = type;
    if (type !== "code") {
      c.outputs = [];
      c.executionCount = null;
    }
    this.changed();
  }

  /**
   * Split a cell at a line/column offset into two, keeping the head selected.
   * Outputs stay with the head — they were produced by code that is now split
   * across both halves, and attributing them to the tail would be a lie either way.
   */
  split(id, offset) {
    const c = this.cell(id);
    if (!c) return null;
    const head = c.source.slice(0, offset);
    const tail = c.source.slice(offset);
    c.source = head;
    const cell = newCell(c.type, tail);
    cell.minor = this.nb.nbformatMinor;
    this.nb.cells.splice(this.indexOf(id) + 1, 0, cell);
    this.changed();
    return cell.id;
  }

  /** Merge a cell into the one above it. Refuses across types — merging markdown
   *  into code would produce a cell that cannot run. */
  mergeUp(id) {
    const i = this.indexOf(id);
    if (i <= 0) return false;
    const above = this.nb.cells[i - 1];
    const c = this.nb.cells[i];
    if (above.type !== c.type) return false;
    above.source = above.source + (above.source.endsWith("\n") ? "" : "\n") + c.source;
    above.outputs = [];
    above.executionCount = null;
    this.nb.cells.splice(i, 1);
    this.selected = above.id;
    this.changed();
    return true;
  }

  clearOutputs(id) {
    const c = this.cell(id);
    if (!c) return;
    c.outputs = [];
    c.executionCount = null;
    c.aborted = null;
    this.stale.delete(id);
    this.changed();
  }

  clearAllOutputs() {
    for (const c of this.nb.cells) {
      c.outputs = [];
      c.executionCount = null;
      c.aborted = null;
    }
    this.stale.clear();
    this.changed();
  }

  // ── the session's sink ─────────────────────────────────────────────────────

  /**
   * The object `NotebookSession` reports into. Kept here rather than in the
   * session so that every mutation of a notebook is in this file.
   */
  sink() {
    return {
      onQueued: (id) => {
        const c = this.cell(id);
        if (!c) return;
        c.queued = true;
        this.changed({ dirty: false });
      },
      onStart: (id, count) => {
        const c = this.cell(id);
        if (!c) return;
        c.queued = false;
        c.loading = "";
        // The note from the last run that did not finish. It described the PREVIOUS
        // attempt, and nothing cleared it — so a cell that died with the kernel,
        // was restarted and then ran clean sat there showing its fresh output under
        // "the kernel died before this cell ran", which is a false sentence about
        // the run the user is looking at.
        c.aborted = null;
        // Outputs are replaced, not appended to: a cell shows the result of its
        // LAST run. Clearing at start rather than at the end means a cell that
        // never finishes does not sit there showing the previous run's answer.
        c.outputs = [];
        c.executionCount = count;
        this.stale.delete(id);
        this.changed();
      },
      onStream: (id, name, text) => {
        const c = this.cell(id);
        if (!c) return;
        appendStream(c.outputs, name, text);
        this.changed();
      },
      /** What the kernel is fetching for this cell right now. NOT an output: it is
       *  true only while the cell runs, and a wait is not a result. `dirty: false`
       *  for the same reason — waiting for a wheel does not modify the notebook. */
      onLoading: (id, text) => {
        const c = this.cell(id);
        if (!c) return;
        c.loading = text;
        this.changed({ dirty: false });
      },
      onDisplay: (id, data) => {
        const c = this.cell(id);
        if (!c) return;
        c.outputs.push({ output_type: "display_data", data, metadata: {}, execution_count: null, raw: null });
        this.changed();
      },
      onResult: (id, data, count) => {
        const c = this.cell(id);
        if (!c) return;
        c.outputs.push({ output_type: "execute_result", data, metadata: {}, execution_count: count, raw: null });
        this.changed();
      },
      onError: (id, ename, evalue, traceback) => {
        const c = this.cell(id);
        if (!c) return;
        c.outputs.push({ output_type: "error", ename, evalue, traceback, raw: null });
        this.changed();
      },
      onDone: (id) => {
        const c = this.cell(id);
        if (!c) return;
        c.queued = false;
        c.loading = "";
        this.changed();
      },
      onAborted: (id, reason, started) => {
        const c = this.cell(id);
        if (!c) return;
        c.queued = false;
        c.loading = "";
        // A cell that never reached the interpreter has its number taken back —
        // one left next to it would say it ran. A cell that was RUNNING when the
        // kernel went away keeps its number, because it did run; it just did not
        // get to finish, which is what `aborted` records.
        if (!started) c.executionCount = null;
        c.aborted = reason;
        this.changed({ dirty: false });
      },
      onRestart: () => {
        // Counters describe an interpreter that no longer exists. The outputs
        // stay — they are the record of what happened — but they are marked so
        // the view can show that nothing below is live any more.
        for (const c of this.nb.cells) if (c.outputs.length || c.executionCount != null) this.stale.add(c.id);
        this.changed({ dirty: false });
      },
      onKernelExit: () => {
        for (const c of this.nb.cells) if (c.outputs.length || c.executionCount != null) this.stale.add(c.id);
        this.changed({ dirty: false });
      },
      // The view subscribes to this store and to nothing else, so kernel status
      // and the kernel log have to come through here or the toolbar renders the
      // state the notebook was in when a cell last changed.
      onStatus: () => this.changed({ dirty: false }),
      onLog: () => this.changed({ dirty: false }),
    };
  }
}

export { newCellId };
