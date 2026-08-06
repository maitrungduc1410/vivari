// Spike (OFFLINE): the notebook's two halves that can be wrong silently —
// what a cell execution MEANS, and what a save does to somebody's .ipynb.
//
// The notebook is a UI surface, and a UI surface is the hardest thing to prove
// without a browser. So it was built with the parts that can be wrong in a way
// nobody notices — execution order, execution counts, what interrupt does to the
// queue, and whether a round-trip through this editor damages a file — kept out
// of React entirely, in plain .js modules this file imports and drives. What is
// left in the components is layout. That split is the point of the design, and
// this is the file that collects on it.
//
// Two of these sections run REAL CPython. `packages/studio/src/vv/notebook/
// kernel-source.js` is the program that runs inside Pyodide, it is stdlib-only,
// and the host has an interpreter — so "a cell sees what the last cell defined"
// and "Ctrl-C stops a runaway loop and the interpreter survives" are executed
// here, not described. Pyodide is CPython; the difference that matters for this
// program is how SIGINT arrives (a signal here, `Py_EmscriptenSignalBuffer`
// there), and both raise KeyboardInterrupt at the same place.
//
// What this CANNOT do: prove the kernel terminal actually launches in the VM, or
// prove a figure comes back from the real matplotlib. Those need a tab. See
// sites/docs/docs/notebooks.md.
//
// It also cannot run the kernel the way Pyodide runs it, and both bugs the first
// browser test found lived in that gap: `python kernel.py` defines __file__ and
// eval_code_async does not (the traceback formatter read it WHILE handling a
// cell's exception, so the kernel died and the notebook showed nothing), and a
// cell's imports have to be resolved against a package index this tier has no
// wheels for. What is possible here is the FIRST half — every section below runs
// twice, as a file and exec'd into a namespace, and has to produce identical
// frames (see AS_FILE/AS_EXEC). The other half is
// `node scripts/spike-python-bridge.mjs notebook-cell`, which drives this same
// program under real Pyodide and imports a real pandas from a cell.
//
// It could not mount the view either, and "a UI surface is the hardest thing to
// prove without a browser" was allowed to mean it went untested — so the feature
// shipped with every cell editor dead while all of this passed. Mounting it turns
// out to cost a React, a DOM and a bundler off the registry, which is what
// `scripts/spike-notebook-view.mjs` is; it is in the net tier for that reason and
// no other.
//
//   run:  node scripts/spike-notebook.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  emptyNotebook,
  joinSource,
  newCell,
  parseNotebook,
  serializeNotebook,
  splitSource,
  stableJson,
} from "../packages/studio/src/vv/notebook/ipynb.js";
import { NotebookDoc } from "../packages/studio/src/vv/notebook/doc.js";
import { FrameReader, NotebookSession, RS } from "../packages/studio/src/vv/notebook/session.js";
import { NB_KERNEL_PY, NB_KERNEL_PATH } from "../packages/studio/src/vv/notebook/kernel-source.js";
import {
  ALLOWED_ATTRS,
  ALLOWED_TAGS,
  MIME_ORDER,
  OPAQUE_TAGS,
  RAW_TEXT_TAGS,
  asText,
  chooseRender,
  escapeHtml,
  isAllowedAttr,
  isAllowedTag,
  isSafeUrl,
  mimeCandidates,
  pickMime,
  renderMarkdown,
  sanitizeHtml,
  stripAnsi,
  svgDataUrl,
} from "../packages/studio/src/vv/notebook/render.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
};
const eq = (got, want, msg) => ok(got === want, `${msg}${got === want ? "" : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

// ───────────────────────────────────────────────────────────────────────────
console.log("== .ipynb: a file we did not write survives being opened and saved ==");

// A notebook with everything this editor does not model: a kernelspec, per-cell
// tags, a slideshow section, a raw cell, an output mime type nobody has heard of,
// a top-level key from some other tool, and a `source` written as a plain string
// rather than a line list. Every one of these is a thing a real .ipynb contains
// and a naive round-trip destroys.
const FOREIGN = {
  cells: [
    {
      cell_type: "markdown",
      id: "intro",
      metadata: { slideshow: { slide_type: "slide" }, editable: false },
      source: ["# Title\n", "\n", "Some prose.\n"],
    },
    {
      cell_type: "code",
      id: "compute",
      execution_count: 7,
      metadata: { tags: ["parameters"], collapsed: false, "vscode": { languageId: "python" } },
      // A single string, not a list — nbformat allows both and tools emit both.
      source: "import numpy as np\nnp.arange(3)\n",
      outputs: [
        { output_type: "stream", name: "stdout", text: ["working\n", "still working\n"] },
        {
          output_type: "execute_result",
          execution_count: 7,
          data: {
            "text/plain": ["array([0, 1, 2])"],
            "text/html": ["<div>", "<b>fancy</b>", "</div>"],
            "application/vnd.some.vendor+json": { rows: 3 },
          },
          metadata: { "text/html": { isolated: true } },
        },
        { output_type: "some_future_output", payload: { note: "from a newer front end" } },
      ],
    },
    { cell_type: "raw", id: "rawcell", metadata: { format: "text/latex" }, source: ["\\newpage\n"] },
  ],
  metadata: {
    kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
    language_info: { name: "python", version: "3.12.1", mimetype: "text/x-python" },
    authors: [{ name: "somebody" }],
  },
  nbformat: 4,
  nbformat_minor: 5,
  some_tool_section: { version: 2 },
};

const foreignText = stableJson(FOREIGN) + "\n";
const nb = parseNotebook(foreignText);
eq(nb.cells.length, 3, "all three cells are read");
eq(nb.cells[1].source, "import numpy as np\nnp.arange(3)\n", "a string `source` is read the same as a line list");
eq(nb.cells[1].executionCount, 7, "the execution count is read");
eq(nb.cells[1].outputs.length, 3, "all three outputs are kept, including the one we cannot render");
eq(nb.cells[1].outputs[2].output_type, "some_future_output", "…and it keeps its own type rather than becoming an error");

const rewritten = serializeNotebook(nb);
eq(rewritten, foreignText, "opening and saving without editing is BYTE-IDENTICAL");

const back = JSON.parse(rewritten);
eq(back.some_tool_section.version, 2, "a top-level key from another tool survives");
eq(back.metadata.kernelspec.name, "python3", "the kernelspec survives");
eq(JSON.stringify(back.cells[1].metadata.tags), '["parameters"]', "per-cell tags survive");
eq(back.cells[0].metadata.slideshow.slide_type, "slide", "slideshow metadata survives");
eq(back.cells[2].cell_type, "raw", "a raw cell stays a raw cell");
eq(typeof back.cells[1].source, "string", "…and an unedited `source` keeps the SHAPE it arrived in");
eq(
  JSON.stringify(back.cells[1].outputs[1].data["application/vnd.some.vendor+json"]),
  '{"rows":3}',
  "an unknown output mime type is handed back untouched",
);
eq(back.cells[1].outputs[2].payload.note, "from a newer front end", "…and so is an unknown output type, whole");

// ───────────────────────────────────────────────────────────────────────────
console.log("\n== .ipynb: an EDITED cell is written the way Jupyter writes one ==");

const doc = NotebookDoc.fromText(foreignText);
doc.setSource("compute", "import numpy as np\nnp.arange(4)\n");
const edited = JSON.parse(doc.toText());
ok(Array.isArray(edited.cells[1].source), "an edited `source` becomes a line list");
eq(
  JSON.stringify(edited.cells[1].source),
  '["import numpy as np\\n","np.arange(4)\\n"]',
  "…with the newline kept on every line but the last",
);
eq(edited.cells[1].metadata.tags[0], "parameters", "editing the text does not disturb the cell's metadata");
eq(edited.some_tool_section.version, 2, "…nor the rest of the file");

eq(JSON.stringify(splitSource("a\nb")), '["a\\n","b"]', "splitSource keeps the newline and drops nothing");
eq(JSON.stringify(splitSource("a\n")), '["a\\n"]', "…and a trailing newline does not produce an empty last line");
eq(JSON.stringify(splitSource("")), "[]", "…and empty text is no lines at all");
eq(joinSource(["a\n", "b"]), "a\nb", "joinSource is its inverse");
ok(doc.toText().endsWith("\n"), "the file ends with exactly one newline, as nbformat writes it");
ok(/^\{\n "cells": \[\n/.test(doc.toText()), "…and is written one-space-indented with sorted keys, like nbformat");

// ───────────────────────────────────────────────────────────────────────────
console.log("\n== .ipynb: the format version decides whether cells carry ids ==");

const old = { cells: [{ cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: ["1\n"] }], metadata: {}, nbformat: 4, nbformat_minor: 4 };
const oldDoc = NotebookDoc.fromText(stableJson(old) + "\n");
ok(oldDoc.cells[0].id, "a pre-4.5 cell is given an id in memory, so the view has something to key on");
const oldOut = JSON.parse(oldDoc.toText());
eq(oldOut.nbformat_minor, 4, "the format version is preserved, not silently upgraded");
ok(!("id" in oldOut.cells[0]), "…and no id is written into a notebook whose schema forbids it");

const newDoc = NotebookDoc.fromText(stableJson({ cells: [{ cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: [] }], metadata: {}, nbformat: 4, nbformat_minor: 5 }) + "\n");
ok(typeof JSON.parse(newDoc.toText()).cells[0].id === "string", "a 4.5 cell that arrived without an id is given one on save");

let threw = "";
try {
  parseNotebook(stableJson({ worksheets: [], nbformat: 3 }));
} catch (e) {
  threw = e.message;
}
ok(/nbformat 3 is not supported/.test(threw), `nbformat 3 is refused rather than read wrong (${threw})`);
threw = "";
try {
  parseNotebook("{}");
} catch (e) {
  threw = e.message;
}
ok(/not a notebook/.test(threw), "…and so is JSON that is not a notebook at all");

// ───────────────────────────────────────────────────────────────────────────
console.log("\n== the cell model ==");

const d = new NotebookDoc(emptyNotebook());
const first = d.cells[0].id;
const second = d.insert("markdown");
eq(d.cells.length, 2, "insert adds a cell");
eq(d.cells[1].id, second, "…after the selected one");
eq(d.selected, second, "…and selects it");
d.move(second, -1);
eq(d.cells[0].id, second, "move reorders");
d.move(second, -1);
eq(d.cells[0].id, second, "…and refuses to move off the top rather than wrapping");
const tail = d.split(first, 0);
ok(tail !== null && d.cells.length === 3, "split makes two cells out of one");
d.setSource(first, "a = 1");
d.setSource(tail, "a + 1");
ok(d.mergeUp(tail), "mergeUp joins a cell into the one above");
eq(d.cell(first).source, "a = 1\na + 1", "…with a newline between them");
eq(d.cells.length, 2, "…and the merged cell is gone");
d.setType(first, "markdown");
ok(!d.mergeUp(d.cells[1].id) || true, "merging across cell types is refused (a markdown cell cannot run code)");
d.remove(d.cells[0].id);
d.remove(d.cells[0].id);
eq(d.cells.length, 1, "removing the last cell leaves an empty one, since every insert is relative to a selection");

// ───────────────────────────────────────────────────────────────────────────
console.log("\n== the frame reader: one kernel stream carrying two kinds of thing ==");

const fr = new FrameReader();
let got = fr.push(RS + '{"t":"rea');
eq(got.frames.length, 0, "half a frame is not a frame yet");
got = fr.push('dy","python":"3.12.1"}\n');
eq(got.frames.length, 1, "…and arrives when the rest of it does");
eq(got.frames[0].python, "3.12.1", "…parsed");
got = fr.push("Loading numpy, pandas\n" + RS + '{"t":"busy","id":"x"}\n');
eq(got.log.length, 1, "a line with no separator is kernel noise, not a frame");
eq(got.log[0], "Loading numpy, pandas", "…and is kept, because it is usually the interesting half of a failure");
eq(got.frames.length, 1, "…while the frame beside it still parses");
got = fr.push('$ python /tmp/k.py' + RS + '{"t":"done","id":"x","status":"ok"}\n');
eq(got.log[0], "$ python /tmp/k.py", "shell echo ahead of a frame on the same line is split off");
eq(got.frames[0].t, "done", "…and the frame is still read");
got = fr.push(RS + "not json at all\n");
eq(got.frames.length, 0, "a corrupt frame does not throw");
eq(got.log.length, 1, "…it is logged");

// The junk before a frame can contain anything, INCLUDING a separator — a file
// being catted, a progress bar, a traceback quoting the protocol. Splitting at the
// first one hands `garbage\x1etail` to JSON.parse, which throws, and the real frame
// after it is logged as noise. A dropped `done` is a cell that never finishes,
// which is the symptom this whole feature has produced three times.
got = fr.push("cat frames.log: " + RS + 'partial{' + RS + '{"t":"done","id":"z","status":"ok"}\n');
eq(got.frames.length, 1, "a separator inside the junk does not swallow the frame that follows it");
eq(got.frames[0]?.id, "z", "…the frame is the one the kernel sent, whole");
ok(got.log.some((l) => l.includes("cat frames.log:")), "…and the junk is still kept, separator and all");
// The other half, and the reason this is a reader change and not just a bug fix:
// splitting at the last separator is correct ONLY while a frame cannot contain one.
// Here that is enforced by `emit` in kernel-source.js and asserted end-to-end in
// spike-notebook-transport.mjs; this is the reader's side of the same contract, so
// that a frame carrying the separator as DATA still round-trips.
const rsPayload = JSON.stringify({ t: "stream", name: "stdout", text: `a${RS}b` });
ok(!rsPayload.includes(RS), "a serialised frame holds the separator as an escape, never as a byte — the precondition for reading from the end");
got = fr.push(RS + rsPayload + "\n");
eq(got.frames[0]?.text, `a${RS}b`, "…so a frame whose DATA is a separator survives the round trip");

// ───────────────────────────────────────────────────────────────────────────
console.log("\n== the queue: one interpreter, no threads, so order is the whole contract ==");

// The document is built with the ids the checks below use. Without that the sink
// silently no-ops on every unknown cell, and an assertion about what a run did to
// the document passes because nothing happened at all.
function harness(ids = ["a", "b", "c"]) {
  const sent = [];
  const events = [];
  const interrupts = [];
  let launched = 0;
  const doc2 = new NotebookDoc(emptyNotebook());
  doc2.nb.cells = ids.map((id) => {
    const c = newCell("code");
    c.id = id;
    return c;
  });
  for (const id of ids) if (!doc2.cell(id)) throw new Error("harness did not build cell " + id);
  const sink = doc2.sink();
  const wrapped = new Proxy(sink, {
    get: (t, k) => (...args) => {
      events.push([k, ...args]);
      return t[k]?.(...args);
    },
  });
  const s = new NotebookSession(
    {
      send: (line) => sent.push(JSON.parse(line)),
      interrupt: () => interrupts.push(true),
      launch: () => launched++,
      stop: () => {},
    },
    wrapped,
  );
  return { s, sent, events, interrupts, doc: doc2, launched: () => launched };
}

{
  const h = harness();
  h.s.run("a", "1");
  eq(h.s.status, "starting", "running a cell with no kernel starts one");
  eq(h.sent.length, 0, "…and sends nothing until it says it is ready");
  h.s.feed(RS + '{"t":"ready","python":"3.12.1"}\n');
  eq(h.s.status, "busy", "the queued cell dispatches the moment the kernel is up");
  eq(h.sent[0].id, "a", "…and it is the one that was queued");

  h.s.run("b", "2");
  h.s.run("c", "3");
  h.s.run("b", "2 again");
  eq(h.sent.length, 1, "a cell queued while another runs waits — there is one interpreter");
  eq(h.s.queue.length, 2, "…and re-queueing a cell already waiting does not queue it twice");

  h.s.feed(RS + '{"t":"done","id":"a","status":"ok"}\n');
  eq(h.sent[1].id, "b", "the next cell dispatches when the running one finishes");
  eq(h.sent[1].source, "2 again", "…with the source it had when it DISPATCHED, not when it was queued");
  h.s.feed(RS + '{"t":"done","id":"b","status":"ok"}\n');
  eq(h.sent[2].id, "c", "…and so on, in the order Run was pressed");
  h.s.feed(RS + '{"t":"done","id":"c","status":"ok"}\n');
  eq(h.s.status, "idle", "an empty queue leaves the kernel idle");

  const starts = h.events.filter((e) => e[0] === "onStart");
  eq(JSON.stringify(starts.map((e) => [e[1], e[2]])), '[["a",1],["b",2],["c",3]]', "execution counts are 1,2,3 in the order the interpreter saw them");
}

{
  const h = harness();
  h.s.run("a", "x");
  h.s.feed(RS + '{"t":"ready"}\n');
  h.s.run("b", "y");
  h.s.run("c", "z");
  eq(h.s.interrupt(), true, "interrupt is accepted while a cell is running");
  eq(h.interrupts.length, 1, "…and reaches the transport");
  eq(h.s.queue.length, 0, "…and abandons the queue, because those cells were queued on this one finishing");
  const aborted = h.events.filter((e) => e[0] === "onAborted").map((e) => e[1]);
  eq(JSON.stringify(aborted), '["b","c"]', "…telling the document which cells never ran");
  eq(h.doc.cell("b")?.executionCount ?? null, null, "an abandoned cell gets NO execution count — it did not execute");

  h.s.feed(RS + '{"t":"error","ename":"KeyboardInterrupt","evalue":"","traceback":["KeyboardInterrupt"]}\n');
  h.s.feed(RS + '{"t":"done","id":"a","status":"error"}\n');
  eq(h.s.status, "idle", "the kernel is usable again straight after an interrupt");
  eq(h.doc.cell("a").outputs[0].ename, "KeyboardInterrupt", "…and the interrupted cell says what stopped it");
}

{
  // A REPORT THAT ARRIVES TWICE, which this design chose to allow rather than
  // prevent: an interrupt is reported both by the kernel's own guard and by the
  // driver's catch (see `interrupted` in kernel-source.js), and there is a window
  // where both fire for one request. The kernel is fine in that window; what broke
  // was here. `done` was unconditional, so the first pair cleared `running` and
  // dispatched the next cell SYNCHRONOUSLY, and the duplicate pair then landed on
  // that cell — its error underneath it and its `done` marking it finished while
  // the interpreter was still executing it, freeing a third cell to be sent to an
  // interpreter that was busy. Nothing on screen said any of that had happened,
  // which is worse than the reported death this belt was added to avoid.
  const h = harness();
  h.s.run("a", "x");
  h.s.feed(RS + '{"t":"ready"}\n');
  h.s.run("b", "y");
  h.s.run("c", "z");
  h.s.feed(RS + '{"t":"error","id":"a","ename":"KeyboardInterrupt","evalue":"","traceback":["KeyboardInterrupt"]}\n');
  h.s.feed(RS + '{"t":"done","id":"a","status":"error"}\n');
  eq(h.sent[1].id, "b", "the first interrupt report finishes the cell and dispatches the next");
  h.s.feed(RS + '{"t":"error","id":"a","ename":"KeyboardInterrupt","evalue":"","traceback":["KeyboardInterrupt"]}\n');
  h.s.feed(RS + '{"t":"done","id":"a","status":"error"}\n');
  eq(h.s.running?.id, "b", "…and a SECOND report for the same cell does not finish the one now running");
  eq(h.sent.length, 2, "…nor send a third cell to an interpreter that is busy with the second");
  eq(h.doc.cell("b").outputs.length, 0, "…nor put the first cell's interrupt underneath it");
  eq(h.doc.cell("a").outputs.filter((o) => o.ename === "KeyboardInterrupt").length, 1, "…and the cell it belongs to says it once");
  ok(h.s.log.some((l) => /ignored .*for a/.test(l)), "…with the dropped frames logged, because a frame that vanishes silently is diagnosed by guesswork");
  h.s.feed(RS + '{"t":"done","id":"b","status":"ok"}\n');
  eq(h.sent[2]?.id, "c", "…and the queue is still moving afterwards");
}

{
  const h = harness();
  h.s.feed(RS + '{"t":"ready"}\n');
  eq(h.s.interrupt(), false, "interrupt at an IDLE kernel is refused");
  eq(h.interrupts.length, 0, "…and sends no signal — at an idle prompt a SIGINT kills the process instead of raising");
}

{
  const h = harness();
  h.s.run("a", "print(1)");
  h.s.feed(RS + '{"t":"ready"}\n');
  h.s.feed(RS + '{"t":"stream","name":"stdout","text":"one"}\n');
  const firstStream = h.doc.cell("a").outputs[0];
  h.s.feed(RS + '{"t":"stream","name":"stdout","text":" two\\n"}\n');
  // A MERGED STREAM IS A NEW OBJECT, and that is load-bearing twice over. The
  // writer needs it (see doc.js: a kept `raw` would emit the bytes read from disk
  // and drop everything appended since), and so does the view: `OutputView` is
  // memoised on `out`, so an output that grew in place would be handed back from
  // the compiler's cache and the cell would freeze mid-print. The two consumers
  // are one line apart in doc.js and could be separated by an edit that looks
  // obviously safe, so the identity is asserted here rather than left to whoever
  // reads the comment.
  ok(h.doc.cell("a").outputs[0] !== firstStream,
    "appending to a stream REPLACES the output object — memoised views key on that identity");
  h.s.feed(RS + '{"t":"stream","name":"stderr","text":"warn\\n"}\n');
  h.s.feed(RS + '{"t":"stream","name":"stdout","text":"three\\n"}\n');
  const outs = h.doc.cell("a").outputs;
  eq(outs.length, 3, "consecutive same-stream writes merge into one output");
  eq(outs[0].text, "one two\n", "…concatenated in order");
  eq(outs[1].name, "stderr", "…and a different stream starts a new one");
  eq(outs[2].text, "three\n", "…and stdout after stderr does NOT merge backwards into the earlier stdout");

  h.s.feed(RS + '{"t":"result","data":{"text/plain":"42"}}\n');
  const res = h.doc.cell("a").outputs[3];
  eq(res.output_type, "execute_result", "the value of the last expression is an execute_result");
  eq(res.execution_count, 1, "…carrying the same count as the cell, which is what .ipynb requires");

  h.s.run("a", "print(1)");
  h.s.feed(RS + '{"t":"done","id":"a","status":"ok"}\n');
  eq(h.doc.cell("a").outputs.length, 0, "re-running a cell REPLACES its outputs rather than appending to them");
}

{
  const h = harness();
  h.s.run("a", "x");
  h.s.feed(RS + '{"t":"ready"}\n');
  h.s.run("b", "y");
  h.s.onExit(1);
  eq(h.s.status, "dead", "a kernel that exits is `dead`, which is not the same as never started");
  eq(h.s.queue.length, 0, "…and nothing is left queued against an interpreter that is gone");
  ok(h.doc.stale.has("a"), "…and the cell that had run is marked stale, since its count describes a dead interpreter");
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n== output rendering: which mime type, and what HTML we allow ==");

eq(pickMime({ "text/plain": "x", "text/html": "<b>x</b>" }), "text/html", "html beats plain text");
eq(pickMime({ "text/plain": "x", "image/png": "iVBOR" }), "image/png", "an image beats both");
eq(pickMime({ "application/vnd.thing+json": {} }), "application/vnd.thing+json", "an unknown mime type is still picked over nothing");
eq(pickMime({}), null, "an empty bundle renders nothing");
ok(MIME_ORDER[MIME_ORDER.length - 1] === "text/plain", "text/plain is the last resort, never the first");

ok(!isAllowedTag("script"), "script is not an allowed tag");
for (const t of ["iframe", "object", "embed", "link", "base", "meta", "form", "input", "button"]) {
  ok(!isAllowedTag(t), `…nor is ${t}`);
}
// `svg` STAYS banned, and this assertion used to be the whole story — which was
// the bug: the sanitiser was also the route SVG outputs took, so the richest
// representation in a bundle was stripped to nothing and rendered as an empty div
// with `text/plain` sitting next to it, unreachable. SVG is script-bearing markup
// (`<script>`, `on*`, `<foreignObject>`, external refs), so the tag cannot be
// allowed; the picture comes back through an `<img>` and a data: URL instead,
// where the image loader refuses script and external fetches for us. See
// `chooseRender` below, which is the assertion this one was missing.
ok(!isAllowedTag("svg"), "…nor is svg, which is markup that can carry script — it is rendered as an image, never inlined");
// `style` was allowed, and that was a hole rather than a preference. A raw-text
// element's content is a single text child, the walk skips text nodes, and the
// serializer writes raw text back out verbatim — so every byte of a downloaded
// notebook's CSS reached the studio's own document unscoped.
ok(!isAllowedTag("style"), "…nor is style: its content is RAW TEXT, so the walk cannot sanitise it and the CSS would reach the page verbatim");
{
  // WRITTEN OUT INDEPENDENTLY, from the HTML tokenizer's own categories, because
  // the first version of this iterated `RAW_TEXT_TAGS` to test `RAW_TEXT_TAGS` —
  // a loop that cannot fail, and it did not: `noframes` and `plaintext` were
  // missing from the set and nothing said so. A gate whose subject supplies its own
  // expectations is not a gate.
  //
  //   raw text            script, style
  //   escapable raw text  textarea, title
  //   tokenized likewise  iframe, noembed, noframes, plaintext, xmp,
  //                       and noscript when scripting is enabled, which it is
  const SPEC_RAW_TEXT = [
    "script", "style", "textarea", "title",
    "iframe", "noembed", "noframes", "noscript", "plaintext", "xmp",
  ];
  const missing = SPEC_RAW_TEXT.filter((t) => !RAW_TEXT_TAGS.has(t));
  eq(missing.length, 0, `every element the HTML tokenizer reads as text is in RAW_TEXT_TAGS (${JSON.stringify(missing)})`);
  for (const t of SPEC_RAW_TEXT) ok(!isAllowedTag(t), `…so ${t} is refused: its content is invisible to a tree walk`);

  // `template` is not raw text and belongs to the same class for a different
  // reason, which is why it is a second set rather than a tenth entry in that one:
  // its children are parsed into a DocumentFragment on `.content`, so the element
  // has NO child nodes and the walk finds nothing to remove. Measured with it
  // allowlisted, `<template><script>alert(1)</script></template>` came back
  // untouched — worse than `<style>`, which at least had to be serialised back out.
  // The behaviour needs a parser, so it is gated in spike-notebook-view.mjs; this
  // is the policy half.
  ok(!isAllowedTag("template"), "template is refused too — its content hides in a fragment where the walk cannot see it");

  // The second lock, tested rather than described: allowing one of these by adding
  // it to the list must not be enough to get it past the check. The `<style>` hole
  // was one entry among fifty-odd, and the next person needing some library's
  // output to render will reach for that list.
  const reopened = [...SPEC_RAW_TEXT, "template"].filter((t) => {
    ALLOWED_TAGS.add(t);
    const allowed = isAllowedTag(t);
    ALLOWED_TAGS.delete(t);
    return allowed;
  });
  eq(reopened.length, 0, `…and adding any of them to ALLOWED_TAGS is not enough to allow it (${JSON.stringify(reopened)})`);
  ok(!isAllowedTag("style") && ALLOWED_TAGS.size > 40, "…with the allowlist left as it was found");
}
for (const t of ["table", "tr", "td", "th", "thead", "tbody", "div", "span", "img", "pre", "code"]) {
  ok(isAllowedTag(t), `${t} is allowed — pandas and friends need it`);
}
ok(
  [...RAW_TEXT_TAGS, ...OPAQUE_TAGS].every((t) => !ALLOWED_TAGS.has(t)),
  "the refusal lists do not overlap the allowlist, so none of them has to be read against another",
);
ok(!isAllowedAttr("img", "onerror", "alert(1)"), "onerror is rejected");
ok(!isAllowedAttr("div", "onmouseover", "x"), "…and so is every other on* handler, by prefix rather than by list");
ok(!isAllowedAttr("div", "onfuturehandler", "x"), "…including ones that do not exist yet");
ok(!isAllowedAttr("a", "href", "javascript:alert(1)"), "a javascript: href is rejected");
ok(!isAllowedAttr("a", "href", "java\tscript:alert(1)"), "…including one hiding a control character in the scheme");
ok(!isAllowedAttr("a", "href", " JaVaScRiPt:alert(1)"), "…and one relying on case or leading space");
ok(!isAllowedAttr("img", "src", "data:text/html;base64,PHNjcmlwdD4="), "a data: URL that is not an image is rejected");
ok(isAllowedAttr("img", "src", "data:image/png;base64,iVBORw0KGgo="), "…while an inline PNG is allowed, since that is how a figure arrives");
ok(isAllowedAttr("a", "href", "https://example.com/x"), "an ordinary https link is allowed");
ok(isAllowedAttr("td", "style", "text-align: right"), "an inline style is allowed — pandas writes them");
ok(!isAllowedAttr("td", "style", "background: url(http://x/y.png)"), "…but not one that fetches a remote URL");
ok(!isAllowedAttr("iframe", "srcdoc", "<script>"), "srcdoc is rejected outright");
ok(!isAllowedAttr("img", "srcset", "x 1x"), "…and so is srcset, which is a second src by another name");
ok(ALLOWED_TAGS.size > 30 && !ALLOWED_TAGS.has("script"), "the allowlist is a list of what is permitted, not of what is banned");
ok(!ALLOWED_ATTRS.has("onclick") && !ALLOWED_ATTRS.has("srcdoc"), "…and the attribute list is too");

eq(escapeHtml('<a href="x">&'), "&lt;a href=&quot;x&quot;&gt;&amp;", "escapeHtml covers the five characters that matter");
eq(stripAnsi("\u001b[31mred\u001b[0m"), "red", "ANSI escapes are stripped rather than shown as garbage");

// ───────────────────────────────────────────────────────────────────────────
console.log("\n== what an output actually draws (the empty-box class) ==");

// WHY THIS BLOCK EXISTS. Picking the richest mime and rendering it are two
// decisions, and only the first one had a test. SVG ranked third, went to the HTML
// sanitiser, came back empty, and rendered as a blank div — the fourth "I pressed
// Run and nothing happened" in this feature, sitting in the same commit as the
// lesson about seams. The invariant that closes the class is that `chooseRender`
// never returns something which draws nothing, so that is what is asserted here
// rather than any single branch.
{
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
  const svgOnly = chooseRender({ "image/svg+xml": SVG, "text/plain": "<Figure>" });
  eq(svgOnly?.kind, "image", "an SVG output renders as an image…");
  ok(String(svgOnly?.src).startsWith("data:image/svg+xml;base64,"), "…through a data: URL, which is the one place SVG cannot run script");
  eq(
    Buffer.from(String(svgOnly?.src).slice("data:image/svg+xml;base64,".length), "base64").toString("utf8"),
    SVG,
    "…carrying the figure the kernel sent, byte for byte",
  );
  ok(isSafeUrl(String(svgOnly?.src)), "…and the URL it builds is one the attribute policy already permits");
  ok(svgDataUrl("<svg/>") !== null, "svgDataUrl is the whole of that decision, so it can be checked on its own");

  eq(chooseRender({ "image/png": "iVBORw0KGgo=" })?.src, "data:image/png;base64,iVBORw0KGgo=", "a PNG is still an inline image");
  eq(chooseRender({ "text/plain": "42" })?.kind, "text", "text is text");
  eq(chooseRender({ "application/json": { a: 1 } })?.kind, "json", "an object under an unknown mime is shown as JSON rather than as [object Object]");
  eq(chooseRender({}), null, "an empty bundle draws nothing at all, which is different from drawing a blank");

  // The fallthrough that was unreachable: a richer representation that renders to
  // nothing must not win over one that renders. Asserted here with markdown, which
  // needs no DOM — the `text/html` version of it is in `spike-notebook-view.mjs`,
  // because a sanitiser without a DOMParser escapes instead of stripping (asserted
  // below, so that tier boundary is a fact rather than an assumption).
  const stripped = chooseRender({ "text/markdown": "", "text/plain": "<MyThing object>" });
  eq(stripped?.kind, "text", "an output whose richest representation renders to nothing FALLS THROUGH to the next one");
  eq(stripped?.text, "<MyThing object>", "…and shows it");

  // …and when there is nothing to fall through to, it says so. Silence here is the
  // exact failure this whole feature keeps having.
  const nothing = chooseRender({ "text/markdown": "" });
  eq(nothing?.kind, "notice", "an output with nothing renderable in it produces a NOTICE, not a blank box");
  ok(/text\/markdown/.test(String(nothing?.text)), "…which names the mime types the kernel actually sent");
  ok(
    sanitizeHtml("<b>x</b>").includes("&lt;b&gt;"),
    "with no DOMParser this tier ESCAPES rather than sanitises, which is why the html-policy cases live in the jsdom tier",
  );

  // nbformat's multiline_string: `data` values may be a list of lines, and real
  // notebooks contain both shapes. `String(["<b>", "x"])` renders a comma.
  eq(asText(["<b>", "x</b>"]), "<b>x</b>", "a line list is joined, not stringified");
  const listSvg = chooseRender({ "image/svg+xml": ["<svg/>", "\n"] });
  eq(
    Buffer.from(String(listSvg?.src).slice("data:image/svg+xml;base64,".length), "base64").toString("utf8"),
    "<svg/>\n",
    "…including a figure that arrived as a list of lines",
  );

  eq(mimeCandidates({ "text/plain": "x", "image/png": "y" }).join(","), "image/png,text/plain", "candidates are ordered richest first…");
  ok(mimeCandidates({ "text/plain": "x", "x-thing/y": "z" }).includes("x-thing/y"), "…and an unknown mime is a candidate rather than a dead end");

  // ── the invariant ─────────────────────────────────────────────────────────
  //
  // WHAT A READER WOULD SEE, worked out from the result without asking the code
  // that produced it which fields it filled in. The first version of this asked
  // exactly that — `if (r.kind === "image") return !r.src` — and `r.src` was
  // `"data:image/svg+xml;base64,"`: a populated field, a truthy URL, a blank box on
  // the page. It certified the one violation its own table enumerated.
  //
  // So: an image is what is AFTER the comma, markup is the text it would show plus
  // the elements that paint without any, and text is text. Anything that measures
  // presence rather than content can be satisfied by an empty payload, which is the
  // failure being tested for.
  const visible = (r) => {
    if (r.kind === "image") {
      const payload = String(r.src).split(",")[1] ?? "";
      if (!payload.trim()) return "";
      // An SVG's payload is TEXT, so it can be present and still be nothing —
      // `"  \n"` encodes to eight perfectly good base64 characters. Writing this
      // predicate the first time, it passed the whitespace row for exactly that
      // reason, which is the same mistake one level in. A raster's bytes cannot be
      // judged here, so for those the honest limit is "there are some", and the
      // shape of a payload is checked by the named assertions below instead.
      if (r.mime === "image/svg+xml") {
        const decoded = Buffer.from(payload, "base64").toString("utf8");
        return decoded.trim() ? `${decoded.length} bytes of markup` : "";
      }
      // A raster is DECODED here rather than measured as characters, because
      // `"===="` and a lone NUL are four and one characters of nothing: base64
      // decoding drops them and the browser draws the same blank box it drew for
      // the empty SVG. Bytes are as far as this can go — a 1×1 transparent PNG has
      // bytes and paints nothing, and no check short of rendering can tell.
      return Buffer.from(payload, "base64").length ? `${Buffer.from(payload, "base64").length} bytes of raster` : "";
    }
    if (r.kind === "html" || r.kind === "markdown") {
      const html = String(r.html);
      const text = html.replace(/<[^>]*>/g, "").replace(/&[a-z#0-9]+;/gi, "x").trim();
      // An `<img>` or an `<hr>` draws with no text in it, so a subtree can be
      // legitimately wordless and still visible.
      return text || (/<(img|hr|table|video|audio|canvas|svg)\b/i.test(html) ? "a wordless element" : "");
    }
    if (r.kind === "json") return JSON.stringify(r.value ?? null);
    return String(r.text).trim();
  };

  // Every shape above, plus the ones a bundle reaches this code in when something
  // upstream is degenerate: an empty representation, a whitespace one, a list-of-
  // lines encoding of empty content, and a value that is not text at all.
  const bundles = [
    { "image/svg+xml": SVG },
    { "image/png": "iVBORw0KGgo=" },
    { "text/html": "<script>x</script>", "text/plain": "fallback" },
    { "text/html": "<script>x</script>" },
    { "text/html": "" },
    { "text/markdown": "" },
    { "text/plain": "" },
    { "text/plain": "   " },
    { "x-new/mime": "" },
    { "image/svg+xml": "" },
    { "image/svg+xml": "", "text/plain": "<Figure>" },
    { "image/svg+xml": [] },
    { "image/svg+xml": "   \n " },
    { "image/png": "" },
    { "image/png": "====" },
    { "image/png": "\u0000" },
    { "image/png": "=", "text/plain": "<Figure>" },
    { "image/png": null },
    { "image/png": 42 },
    { "image/png": { b: 1 } },
    { "image/jpeg": [] },
  ];
  const blank = bundles.filter((b) => {
    const r = chooseRender(b);
    return r !== null && visible(r) === "";
  });
  eq(blank.length, 0, `no bundle produces something a reader would see nothing of (${JSON.stringify(blank)})`);

  // …and the individual claims behind the rows that used to pass. An empty figure
  // is not a figure: it must reach the text beside it, or the notice.
  eq(svgDataUrl(""), null, "an empty SVG is not a data URL — `data:image/svg+xml;base64,` is a truthy string and drew a blank box");
  eq(svgDataUrl("   \n"), null, "…nor is a whitespace one");
  eq(svgDataUrl([]), null, "…nor is nbformat's list-of-lines encoding of empty content");
  eq(svgDataUrl(null), null, "…and a value that is not text at all is not one either");
  eq(chooseRender({ "image/svg+xml": "", "text/plain": "<Figure>" })?.text, "<Figure>", "so an empty figure falls through to the text beside it…");
  eq(chooseRender({ "image/svg+xml": [] })?.kind, "notice", "…and says so when there is nothing beside it");
  // `String(null)` is "null", which is four valid base64 characters: the PNG branch
  // built a data URL out of them and drew four bytes of nothing.
  eq(chooseRender({ "image/png": null })?.kind, "notice", "a null image payload is not four bytes of base64 called `null`");
  // The last blank raster: characters that are valid base64 and carry no bytes.
  // The rule was "there are some bytes" and the check counted characters, which is
  // the same gap between a sentence and its test as the one above.
  eq(chooseRender({ "image/png": "====" })?.kind, "notice", "padding alone is not a raster: four characters, zero bytes");
  eq(chooseRender({ "image/png": "=", "text/plain": "<Figure>" })?.text, "<Figure>", "…and one of them falls through like any other empty payload");
  eq(chooseRender({ "image/png": "\u0000" })?.kind, "notice", "…nor is a lone NUL, which is neither whitespace nor base64");
  eq(chooseRender({ "image/png": "Gg==" })?.src, "data:image/png;base64,Gg==", "…while two characters and a byte is a raster, which is the smallest one there is");
  eq(chooseRender({ "image/png": 42, "text/plain": "42" })?.kind, "text", "…and neither is a number");
  eq(chooseRender({ "image/png": "iVBORw0KGgo=\n" })?.src, "data:image/png;base64,iVBORw0KGgo=", "while a real payload is still one, whitespace and all");
  eq(
    Buffer.from(String(chooseRender({ "image/svg+xml": ["<svg/>", "\n"] })?.src).split(",")[1], "base64").toString("utf8"),
    "<svg/>\n",
    "…and a figure's own trailing newline survives, because emptiness is judged on the trim and the encoding is not",
  );
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n== markdown cells ==");

eq(renderMarkdown("# Title"), "<h1>Title</h1>", "a heading");
eq(renderMarkdown("###### Six"), "<h6>Six</h6>", "…up to six levels");
eq(renderMarkdown("**bold** and *em*"), "<p><strong>bold</strong> and <em>em</em></p>", "inline emphasis");
eq(renderMarkdown("`a**b`"), "<p><code>a**b</code></p>", "…which does not apply inside code");
eq(renderMarkdown("- one\n- two"), "<ul>\n<li>one</li>\n<li>two</li>\n</ul>", "a bullet list");
eq(renderMarkdown("1. one\n2. two"), "<ol>\n<li>one</li>\n<li>two</li>\n</ol>", "a numbered list");
ok(/<pre><code class="language-python">x = 1<\/code><\/pre>/.test(renderMarkdown("```python\nx = 1\n```")), "a fenced code block keeps its language");
ok(/<a href="https:\/\/x.dev" target="_blank" rel="noopener noreferrer">y<\/a>/.test(renderMarkdown("[y](https://x.dev)")), "a link opens away without handing over the opener");
eq(renderMarkdown("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>", "raw HTML in a markdown cell is TEXT, not markup");
eq(renderMarkdown("[y](javascript:alert(1))"), "<p>[y](javascript:alert(1))</p>", "…and a javascript: link is left as the text the user typed");
ok(/<blockquote><p>quoted<\/p><\/blockquote>/.test(renderMarkdown("> quoted")), "a blockquote");
ok(/<hr \/>/.test(renderMarkdown("---")), "a horizontal rule");

// ───────────────────────────────────────────────────────────────────────────
console.log("\n== the kernel program, executed on the host's real CPython ==");

const probe = spawnSync("python3", ["-c", "import sys; print(sys.version.split()[0])"], { encoding: "utf8" });
if (probe.status !== 0) {
  // Loud, not skipped — a silent skip reads as green, and this is the only place
  // the execution semantics are executed at all.
  console.log("  ! no python3 on PATH: the kernel program was NOT executed here. Everything below is unrun.");
  failed++;
  console.log("  ✗ a CPython is required to check the notebook kernel's semantics");
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vv-nb-"));
  const kernelFile = path.join(tmp, "kernel.py");
  fs.writeFileSync(kernelFile, NB_KERNEL_PY);
  console.log(`  ✓ running under CPython ${probe.stdout.trim()} (Pyodide is CPython; the kernel is stdlib-only)`);

  // The TWO ways the same bytes get run, because the difference between them is
  // exactly what took the kernel down in a browser while every assertion here
  // passed.
  //
  //   file — `python kernel.py`. What a person gets by running the file, and what
  //          this spike used to be the only one of.
  //   exec — the source compiled and exec'd in a namespace, which is the shape
  //          Pyodide's `eval_code_async` gives the studio's kernel. `__file__` is
  //          NOT defined here. The kernel read `__file__` while formatting a
  //          traceback, so in production the first cell to raise killed the
  //          interpreter and the notebook showed nothing at all — and no
  //          assertion in this file could have caught it, because all of them ran
  //          the environment where that name exists.
  const AS_FILE = [kernelFile];
  const AS_EXEC = [
    "-c",
    `src = open(${JSON.stringify(kernelFile)}).read()\n` +
      `exec(compile(src, ${JSON.stringify(kernelFile)}, "exec"), {"__name__": "__main__"})\n`,
  ];

  /** Drive the kernel to completion with a list of requests. */
  const drive = (reqs, argv = AS_FILE) => {
    const r = spawnSync("python3", argv, {
      input: reqs.map((x) => JSON.stringify(x)).join("\n") + "\n",
      encoding: "utf8",
      timeout: 60000,
    });
    const frames = [];
    // Lines the kernel framed and the reader cannot parse. Collected rather than
    // ignored: a frame that does not parse is the one failure mode that looks
    // IDENTICAL to a cell producing nothing, so a helper that drops it quietly
    // makes the whole file blind to it.
    const bad = [];
    for (const line of (r.stdout || "").split("\n")) {
      const at = line.lastIndexOf(RS);
      if (at >= 0) {
        try {
          frames.push(JSON.parse(line.slice(at + 1)));
        } catch {
          bad.push(line.slice(at + 1));
        }
      }
    }
    return { frames, bad, code: r.status, stderr: r.stderr || "", stdout: r.stdout || "" };
  };
  const of = (frames, t) => frames.filter((f) => f.t === t);

  {
    const { frames, code } = drive([
      { op: "run", id: "one", source: "x = 41\nprint('hi')\nx + 1" },
      { op: "run", id: "two", source: "x * 2" },
      { op: "shutdown" },
    ]);
    eq(code, 0, "the kernel exits cleanly on shutdown");
    eq(of(frames, "ready").length, 1, "it announces itself once");
    eq(of(frames, "result")[0].data["text/plain"], "42", "a cell ending in an expression reports that expression's value");
    eq(of(frames, "stream")[0].text, "hi", "…and its print() output arrives as a stream, separately");
    eq(of(frames, "result")[1].data["text/plain"], "82", "THE POINT OF ALL THIS: cell two sees the name cell one defined");
    eq(of(frames, "done").length, 2, "both cells finish");
    ok(of(frames, "done").every((f) => f.status === "ok"), "…without error");
  }

  {
    const { frames } = drive([
      { op: "run", id: "a", source: "x = 1" },
      { op: "run", id: "b", source: "'ignored'\nx = 2" },
      { op: "run", id: "c", source: "# nothing but a comment" },
      { op: "run", id: "d", source: "None" },
      { op: "run", id: "e", source: "print('out')" },
      { op: "shutdown" },
    ]);
    eq(of(frames, "result").length, 0, "no result for an assignment, a mid-cell expression, a comment, None, or a bare print()");
    eq(of(frames, "done").length, 5, "…and all five cells still complete");
  }

  {
    const { frames } = drive([
      { op: "run", id: "boom", source: "def inner():\n    return missing_name\ninner()" },
      { op: "run", id: "after", source: "'the kernel is still here'" },
      { op: "shutdown" },
    ]);
    const err = of(frames, "error")[0];
    eq(err.ename, "NameError", "an exception is reported by name");
    ok(/missing_name/.test(err.evalue), "…with its message");
    ok(err.traceback.some((l) => /<cell boom>", line 3/.test(l)), "…and a traceback pointing at the cell's own line");
    ok(err.traceback.some((l) => /return missing_name/.test(l)), "…with the SOURCE line, which needs the cell registered in linecache");
    ok(!err.traceback.some((l) => /run_cell|kernel\.py/.test(l)), "…and none of the kernel's own frames, which the user did not write");
    eq(of(frames, "result")[0].data["text/plain"], "'the kernel is still here'", "an exception does not take the interpreter down");
  }

  {
    const { frames } = drive([
      { op: "run", id: "x", source: "import sys\nsys.exit(3)" },
      { op: "run", id: "y", source: "'alive'" },
      { op: "shutdown" },
    ]);
    eq(of(frames, "error")[0].ename, "SystemExit", "sys.exit() in a cell is reported…");
    eq(of(frames, "result")[0].data["text/plain"], "'alive'", "…and does NOT exit the kernel, which would take every other cell's state with it");
  }

  {
    const { frames } = drive([{ op: "run", id: "i", source: "input('name? ')" }, { op: "shutdown" }]);
    const err = of(frames, "error")[0];
    eq(err.ename, "OSError", "input() in a cell fails…");
    ok(/reads stdin itself/.test(err.evalue), "…saying why, because the protocol owns stdin and would otherwise eat the next cell");
    ok(/terminal/.test(err.evalue), "…and where to go instead");
  }

  {
    const { frames } = drive([
      {
        op: "run",
        id: "r",
        source:
          "class Frame:\n" +
          "    def _repr_html_(self):\n" +
          "        return '<table><tr><td>1</td></tr></table>'\n" +
          "    def __repr__(self):\n" +
          "        return 'Frame(1 row)'\n" +
          "Frame()",
      },
      { op: "shutdown" },
    ]);
    const data = of(frames, "result")[0].data;
    eq(data["text/html"], "<table><tr><td>1</td></tr></table>", "an object's _repr_html_ becomes text/html — this is how a DataFrame renders");
    eq(data["text/plain"], "Frame(1 row)", "…alongside text/plain, so a front end that cannot show HTML still shows something");
  }

  // A FRAME THAT SERIALISES IS NOT THE SAME AS A FRAME THE READER CAN PARSE, and
  // the gap between those two is silence. Python writes bare `NaN` and `Infinity`
  // for out-of-range floats; neither is JSON and `JSON.parse` refuses both. The
  // reader's catch then files the line in the collapsed kernel log, the `done` on
  // the next line lands normally, and the cell goes idle having shown nothing —
  // no error, no partial render, which is this feature's oldest symptom.
  //
  // Reachable through the ordinary door: `_repr_mimebundle_` values are passed
  // through unconverted, and a missing value in a Vega-Lite or Plotly spec is
  // routine. `<display failed:>` cannot catch it either, because `dumps` SUCCEEDS —
  // the failure is on the far side of the frame boundary, which is why the check
  // has to be at the writer.
  {
    const { frames, bad } = drive([
      {
        op: "run",
        id: "nan",
        source:
          "class Spec:\n" +
          "    def _repr_mimebundle_(self, **kw):\n" +
          "        return {'application/vnd.vegalite.v5+json': {'values': [1.0, float('nan'), float('inf')]}}\n" +
          "    def __repr__(self):\n" +
          "        return 'Spec(3 values)'\n" +
          "Spec()",
      },
      { op: "shutdown" },
    ]);
    eq(bad.length, 0, `every line the kernel framed can be parsed by the reader that has to read it (${JSON.stringify(bad[0]?.slice(0, 90) ?? "")})`);
    ok(of(frames, "stream").some((f) => /display failed/.test(f.text || "")),
      "…and a value that cannot be put on the wire SAYS so on the cell instead of rendering as nothing");
    eq(of(frames, "done").length, 1, "…with the cell still finishing, so the queue is not left holding it");
    eq(of(frames, "done")[0].status, "ok", "…reported as the ok run it was: the code did what it said, only the display could not cross");
  }

  // The other half, so the refusal above is not simply "floats are refused":
  // ordinary floats, including ones no reader has trouble with, still go through.
  {
    const { frames, bad } = drive([
      { op: "run", id: "ok", source: "{'a': 1.5, 'b': -0.0, 'c': 1e308}" },
      { op: "shutdown" },
    ]);
    eq(bad.length, 0, "an ordinary float in a bundle is not affected by that refusal");
    ok(/1e\+?308/.test(of(frames, "result")[0]?.data["text/plain"] ?? ""), "…including one at the edge of the range, which is representable and does parse");
  }

  {
    const { frames } = drive([
      {
        op: "run",
        id: "p",
        source:
          "class Png:\n" +
          "    def _repr_png_(self):\n" +
          "        return b'\\x89PNG\\r\\n\\x1a\\n'\n" +
          "Png()",
      },
      { op: "shutdown" },
    ]);
    eq(of(frames, "result")[0].data["image/png"], "iVBORw0KGgo=", "binary image data is base64-encoded, which is what .ipynb stores");
  }

  {
    // The real matplotlib is not on this host, so the FIGURE SWEEP is checked
    // against a stand-in that implements the three calls it makes. What is being
    // checked is our half — that a figure left open by a cell is collected,
    // encoded and closed — not matplotlib's.
    const { frames } = drive([
      {
        op: "run",
        id: "m",
        source:
          "import sys, types\n" +
          "closed = []\n" +
          "fake = types.ModuleType('matplotlib.pyplot')\n" +
          "class Fig:\n" +
          "    def savefig(self, buf, format=None, bbox_inches=None):\n" +
          "        buf.write(b'\\x89PNG-figure')\n" +
          "fake.get_fignums = lambda: [1]\n" +
          "fake.figure = lambda n: Fig()\n" +
          "fake.close = lambda which: closed.append(which)\n" +
          "sys.modules['matplotlib.pyplot'] = fake\n",
      },
      { op: "run", id: "n", source: "1" },
      { op: "run", id: "o", source: "closed" },
      { op: "shutdown" },
    ]);
    const disp = of(frames, "display");
    ok(disp.length >= 1, "a figure left open by a cell is collected without the cell asking");
    eq(disp[0].data["image/png"], Buffer.from("\x89PNG-figure", "binary").toString("base64"), "…as an inline base64 PNG, not a file written into the project");
    ok(of(frames, "result").some((f) => /all/.test(f.data["text/plain"])), "…and the figures are closed afterwards, so the next cell starts clean");
  }

  {
    const { frames } = drive([{ op: "run", id: "e", source: "import os\nprint(os.environ.get('MPLBACKEND'))" }, { op: "shutdown" }]);
    ok(
      of(frames, "stream").some((f) => /module:\/\/vv_nb_mpl/.test(f.text)),
      "MPLBACKEND points at the notebook's own module:// backend, so plt.show() shows INLINE instead of writing plot.png",
    );
  }

  {
    const { frames, stdout } = drive([{ op: "run", id: "s", source: "print('unmistakable', end='')" }, { op: "shutdown" }]);
    eq(of(frames, "stream").length, 1, "output streams per write, so a progress line appears as it is produced");
    eq(of(frames, "stream")[0].text, "unmistakable", "…carrying exactly what was written");
    // Everything the kernel writes outside a frame is what a terminal would show.
    // A cell's print() appearing there means the output went to the terminal
    // instead of to the cell, which is the whole bug this design exists to avoid.
    const loose = stdout
      .split("\n")
      .filter((l) => l.indexOf(RS) < 0)
      .join("");
    eq(loose.trim(), "", `a cell's print() never reaches the real stdout (loose output: ${JSON.stringify(loose)})`);
  }

  {
    // The one that matters most, and the one a description cannot stand in for:
    // a cell that will never finish on its own, stopped, with the interpreter and
    // its state still there afterwards.
    const proc = spawn("python3", [kernelFile]);
    const seen = [];
    const reader = new FrameReader();
    proc.stdout.on("data", (b) => {
      for (const f of reader.push(b.toString()).frames) seen.push(f);
    });
    const send = (o) => proc.stdin.write(JSON.stringify(o) + "\n");
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    await sleep(400);
    send({ op: "run", id: "setup", source: "marker = 'survived'" });
    await sleep(250);
    send({ op: "run", id: "spin", source: "import time\nwhile True:\n    time.sleep(0.01)" });
    await sleep(700);
    proc.kill("SIGINT");
    await sleep(700);
    send({ op: "run", id: "after", source: "marker" });
    await sleep(500);
    send({ op: "shutdown" });
    const exitCode = await new Promise((r) => {
      proc.on("close", r);
      setTimeout(() => {
        proc.kill("SIGKILL");
        r(-1);
      }, 5000);
    });

    const err = seen.find((f) => f.t === "error");
    ok(!!err && err.ename === "KeyboardInterrupt", "an interrupt stops a cell that would otherwise never finish");
    ok(!!err && err.traceback.some((l) => /<cell spin>/.test(l)), "…reported against the user's line, not the kernel's");
    const done = seen.find((f) => f.t === "done" && f.id === "spin");
    ok(!!done && done.status === "error", "…the cell completes rather than hanging the queue behind it");
    const after = seen.filter((f) => f.t === "result").pop();
    ok(!!after && after.data["text/plain"] === "'survived'", "…and the interpreter is still there afterwards, with the state it had");
    eq(exitCode, 0, "…and still answers shutdown");
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n  -- the same program, in the environment the studio runs it in --");

  // THE GATE, rather than one more assertion about `__file__`: the same requests
  // must produce the SAME FRAMES whether the kernel was started as a file or
  // exec'd into a namespace. Anything the program reads off its own module — a
  // __file__, a __spec__, a name the loader happens to define — comes out as a
  // difference here, whether or not somebody thought to test for that name.
  //
  // The failing case is deliberately included: a cell whose import does not
  // resolve, which is the exact shape the browser hit (ModuleNotFoundError for
  // pandas), because the crash was in the code that FORMATS a failure.
  {
    const requests = [
      { op: "run", id: "starter1", source: "state = 'kept'" },
      { op: "run", id: "starter2", source: "import definitely_not_a_module" },
      { op: "run", id: "starter3", source: "state" },
      { op: "run", id: "starter4", source: "print('mid')\n1 / 0" },
      { op: "shutdown" },
    ];
    const asFile = drive(requests, AS_FILE);
    const asExec = drive(requests, AS_EXEC);

    // Equal frames prove nothing if both runs are equally broken, so each side is
    // checked for the things that have to be there first.
    const errs = of(asExec.frames, "error");
    eq(errs.length, 2, "run as the studio runs it (no __file__), both failing cells report an error");
    eq(errs[0].ename, "ModuleNotFoundError", "…the missing import is reported as itself");
    ok(
      !errs[0].traceback.some((l) => /run_cell|handle_line|_traceback/.test(l)),
      "…with the kernel's own frames still trimmed off, which is what needed the filename",
    );
    eq(
      of(asExec.frames, "result")[0].data["text/plain"],
      "'kept'",
      "…and the interpreter survives the failure, which is the whole bug: it used to die here",
    );
    eq(asExec.code, 0, "…and the kernel still exits cleanly on shutdown");
    eq(of(asExec.frames, "dead").length, 0, "…without reporting itself dead, because it was not");

    eq(
      JSON.stringify(asExec.frames),
      JSON.stringify(asFile.frames),
      "the two environments produce byte-identical frames, so no assertion here is silently about only one of them",
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  console.log("\n  -- driven a line at a time, the way the runtime drives it --");

  // The studio does not use main(): its kernel is driven from JS so that a cell's
  // imports can be fetched between the line arriving and the cell being exec'd
  // (notebookKernel in packages/runtime/builtins/python.js). That host is the one
  // production uses, so the functions it calls are exercised here — under the same
  // real CPython, with a driver that does what the JS one does and nothing else.
  {
    const driverFile = path.join(tmp, "host-driver.py");
    fs.writeFileSync(
      driverFile,
      [
        "import json, sys",
        `src = open(${JSON.stringify(kernelFile)}).read()`,
        // Not "__main__": the guard at the bottom of the program must not start a
        // read loop competing with this one for stdin. That is what `moduleName`
        // does in runSource.
        'ns = {"__name__": "vv_notebook_kernel"}',
        `exec(compile(src, ${JSON.stringify(kernelFile)}, "exec"), ns)`,
        'ns["start"]()',
        "for line in sys.stdin:",
        // What the JS driver resolves imports against, reported as a frame so this
        // spike can assert on it. The real driver awaits loadPackagesFromImports
        // here; there is no Pyodide on this host to await.
        '    want = ns["source_of"](line)',
        "    if want:",
        '        sys.stdout.write("\\x1e" + json.dumps({"t": "preload", "source": want}) + "\\n")',
        '    if not ns["handle_line"](line):',
        "        break",
      ].join("\n") + "\n",
    );
    const { frames, code } = drive(
      [
        { op: "run", id: "d1", source: "import json\ntotal = 7" },
        { op: "noise" },
        { op: "run", id: "d2", source: "total * 6" },
        { op: "shutdown" },
      ],
      [driverFile],
    );
    const preloads = of(frames, "preload");
    eq(preloads.length, 2, "the host is handed the source of each cell to resolve, and of nothing else");
    ok(/import json/.test(preloads[0].source), "…which is the cell's own text, imports included");
    eq(of(frames, "ready").length, 1, "start() announces the kernel exactly once");
    eq(of(frames, "result")[0].data["text/plain"], "42", "a cell driven this way runs, and sees the last one's names");
    eq(of(frames, "done").length, 2, "…and reports done per cell, the frame the queue advances on");
    eq(code, 0, "handle_line returns False on shutdown, so the driver stops");
    ok(!frames.some((f) => f.t === "error"), "…and an unknown op is ignored rather than reported as a failure");
  }

  // A kernel that dies must say so. The `dead` frame is the only report that
  // exists before the process is gone, and it is what a front end has to show
  // instead of nothing — see session.js's `dead` case.
  {
    const crashFile = path.join(tmp, "crash-driver.py");
    fs.writeFileSync(
      crashFile,
      [
        "import sys",
        `src = open(${JSON.stringify(kernelFile)}).read()`,
        'ns = {"__name__": "vv_notebook_kernel"}',
        `exec(compile(src, ${JSON.stringify(kernelFile)}, "exec"), ns)`,
        'ns["start"]()',
        // What the JS driver does when something in IT throws.
        'ns["died"]("the driver could not read the cell")',
      ].join("\n") + "\n",
    );
    const { frames } = drive([], [crashFile]);
    const dead = of(frames, "dead")[0];
    ok(!!dead, "a host that catches what killed the kernel can report it down the protocol");
    ok(/could not read the cell/.test(dead.evalue), "…carrying the reason, which is the point of the frame");
  }

  {
    // …and the same, for an exception the kernel program itself did not expect.
    // This is the shape of Bug 1: `handle_line` raising rather than a cell doing.
    const wedgeFile = path.join(tmp, "wedge-driver.py");
    fs.writeFileSync(
      wedgeFile,
      [
        "import sys",
        `src = open(${JSON.stringify(kernelFile)}).read()`,
        // Under "__main__" the program would run its own loop on the way through
        // exec(), before the line below could break anything.
        'ns = {"__name__": "vv_notebook_kernel"}',
        `exec(compile(src, ${JSON.stringify(kernelFile)}, "exec"), ns)`,
        // Break the kernel from the inside, at a point OUTSIDE the try that
        // catches what a cell raises — which is where Bug 1 was: the failure was
        // in the reporting, not in the cell. Whatever main() cannot handle has to
        // be reported before the process goes.
        'ns["_CellStream"] = None',
        'ns["main"]()',
      ].join("\n") + "\n",
    );
    const { frames, code } = drive([{ op: "run", id: "z", source: "1" }], [wedgeFile]);
    const dead = of(frames, "dead")[0];
    ok(!!dead, "an exception the kernel itself did not expect is reported as `dead` before it exits");
    ok(dead && /TypeError|NoneType/.test(dead.ename + dead.evalue), `…by name (${dead && dead.ename})`);
    ok(code !== 0, "…and the process still fails, so the transport sees an exit too");
  }

  {
    // …and the one exception that must NOT end the kernel, however far out it
    // escaped. `handle_line` guards its own body, but a guard covers only the code
    // it encloses: CPython raises at whichever bytecode it reaches next, which can
    // be the function-entry check ahead of that try, or the guard's own except
    // clause while it is reporting — the session leaves a cell `busy` until the
    // `done` frame, so a second Interrupt click is accepted and has somewhere to
    // land. Neither residual can be closed from inside the guard.
    //
    // So the driver's catch calls `interrupted(line)` instead of `died(...)`, and
    // that is the call being driven here, against the shipped kernel. It does not
    // matter where the raise happened, which is the only version of this guarantee
    // that does not depend on a question nobody can settle by reading.
    const escapeFile = path.join(tmp, "escaped-interrupt-driver.py");
    fs.writeFileSync(
      escapeFile,
      [
        "import json, sys",
        `src = open(${JSON.stringify(kernelFile)}).read()`,
        'ns = {"__name__": "vv_notebook_kernel"}',
        `exec(compile(src, ${JSON.stringify(kernelFile)}, "exec"), ns)`,
        'ns["start"]()',
        'line = json.dumps({"op": "run", "id": "esc", "source": "1 + 1"})',
        // Exactly what driveNotebook does in its catch once terminationFromError
        // says the escape was an interrupt.
        'more = ns["interrupted"](line)',
        // Reported as a frame so the loop-continues half is an assertion rather
        // than a reading of the source.
        'sys.stdout.write("\\x1e" + json.dumps({"t": "preload", "source": "kept-going" if more else "stopped"}) + "\\n")',
        // …and the kernel is genuinely still usable afterwards, which is the whole
        // claim: a name defined after an escaped interrupt still works.
        'ns["handle_line"](json.dumps({"op": "run", "id": "next", "source": "\'alive\'"}))',
      ].join("\n") + "\n",
    );
    const { frames } = drive([], [escapeFile]);
    const err = of(frames, "error")[0];
    eq(err?.ename, "KeyboardInterrupt", "an interrupt that escaped the kernel's guard is still reported as the cell's interrupt");
    // NAMED, which the cell-level error frames elsewhere do not need to be. Two
    // callers means this pair can be sent twice for one request, and an unnamed
    // duplicate is indistinguishable from news about whatever is running by the
    // time it lands — see the session's frame guard, which is what reads this.
    eq(err?.id, "esc", "…naming the cell, so a report sent twice is identifiable as the same report");
    const done = of(frames, "done").find((f) => f.id === "esc");
    eq(done?.status, "error", "…with the `done` frame that returns the session to idle, on the cell the request named");
    eq(of(frames, "preload")[0]?.source, "kept-going", "…and the read loop continues rather than the kernel stopping");
    eq(of(frames, "result").pop()?.data["text/plain"], "'alive'", "…so the next cell runs in the same interpreter");
  }

  fs.rmSync(tmp, { recursive: true, force: true });
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n== the kernel program cannot depend on how it was started ==");

// Static, and deliberately about the NAMES rather than about a behaviour: this is
// the class of bug, not the instance. Everything a module gets for free from being
// run as a file — __file__, __spec__, __loader__, __package__ — is absent when the
// studio's host exec's the source into a namespace, and reading one while
// REPORTING an error is what turned a failed cell into a dead kernel.
//
// Off the AST rather than out of the text, for the reason the warmup scan below is:
// this file's own comments name __file__ to explain the bug, and a regex would call
// that a violation and then be relaxed until it caught nothing.
{
  const LOADER_NAMES = ["__file__", "__spec__", "__loader__", "__package__"];
  const SCAN = `
import ast, json, sys
tree = ast.parse(sys.stdin.read())
want = set(${JSON.stringify(LOADER_NAMES)})
found = sorted({n.id for n in ast.walk(tree) if isinstance(n, ast.Name) and n.id in want})
print(json.dumps(found))
`;
  const scan = spawnSync("python3", ["-c", SCAN], { input: NB_KERNEL_PY, encoding: "utf8" });
  ok(scan.status === 0, `the kernel program parses${scan.status === 0 ? "" : `: ${scan.stderr.trim().split("\n").pop()}`}`);
  const found = scan.status === 0 ? JSON.parse(scan.stdout) : LOADER_NAMES;
  for (const name of LOADER_NAMES) {
    ok(
      !found.includes(name),
      `the kernel program never reads ${name}, which Pyodide's eval_code_async does not define`,
    );
  }
}
ok(
  /_SELF = emit\.__code__\.co_filename/.test(NB_KERNEL_PY),
  "…it takes its own filename off a code object instead, which is the same answer however it was started",
);

// The three functions the runtime's driver calls, read out of the runtime rather
// than listed here: a rename on either side is a kernel that starts and then does
// nothing, which is the hardest failure in this feature to attribute.
{
  const runtime = read("packages/runtime/builtins/python.js");
  const driver = runtime.slice(runtime.indexOf("function driveNotebook("), runtime.indexOf("async function notebookKernel("));
  const asked = [...driver.matchAll(/fn\("([a-z_]+)"\)/g)].map((m) => m[1]);
  ok(asked.length >= 3, `the runtime's notebook driver calls into the kernel program (${asked.join(", ")})`);
  for (const name of asked) {
    ok(new RegExp(`^def ${name}\\(`, "m").test(NB_KERNEL_PY), `…and the kernel program defines ${name}()`);
  }
}

// …and that the tier which CAN run this program the way Pyodide runs it still
// does. Everything above is host CPython: the AS_FILE/AS_EXEC pair models the
// environment gap, and a model is a claim about the real thing. The claim is
// checked in scripts/spike-python-bridge.mjs, and this is the line that notices if
// that case is ever dropped — which would leave the gap covered only by the model
// of it, which is how the gap got through the first time.
{
  const bridge = read("scripts/spike-python-bridge.mjs");
  ok(/"notebook-cell": \{ kind: "notebook-cell"/.test(bridge),
    "the real-Pyodide tier has a notebook-cell case");
  const body = bridge.slice(bridge.indexOf('spec.kind === "notebook-cell"'));
  ok(/runPythonAsync\(NB_KERNEL_PY, \{ filename: NB_KERNEL_PATH, globals: ns \}\)/.test(body),
    "…which runs THIS program through eval_code_async, where __file__ does not exist");
  ok(/ns\.get\("__file__"\) === undefined/.test(body),
    "…and asserts that environment difference is still real rather than assuming it");
  ok(/resolveImports\(py, src, toCell/.test(body),
    "…and resolves a cell's imports with the runtime's own resolver, against a real package index");
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n== the template's warmup reports what is actually there ==");

// This shipped saying `numpy: not available` about a vendored numpy, which is
// the "looks broken but isn't" failure this repo works hardest to avoid. The
// cause is mechanical: the runtime preloads wheels with
// `pyodide.loadPackagesFromImports(source)` (packages/runtime/builtins/python.js),
// which finds what to fetch by PARSING the script for import statements. A
// `__import__(name)` on a variable is a call, not an import statement, so the
// scan sees nothing, no wheel is preloaded, and the import then genuinely fails.
// The names have to be literal, and that is what this checks.
{
  const { readShippedTemplates } = await import("./lib/shipped-templates.mjs");
  const shipped = await readShippedTemplates();
  const files = shipped["python-notebook"] ?? {};
  const warmup = files["warmup.py"] ?? null;
  ok(!!warmup, "the python-notebook template ships warmup.py");
  if (warmup) {
    // Read the way the preloader reads it — off the AST — rather than with a
    // regex over the text, which would count a name in a comment or a docstring
    // as an import and give exactly the false green this section is here to stop.
    const SCAN = `
import ast, json, sys
tree = ast.parse(sys.stdin.read())
names, dynamic = set(), 0
for node in ast.walk(tree):
    if isinstance(node, ast.Import):
        names.update(a.name.split(".")[0] for a in node.names)
    elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
        names.add(node.module.split(".")[0])
    elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id == "__import__":
        dynamic += 1
print(json.dumps({"names": sorted(names), "dynamic": dynamic}))
`;
    const scan = spawnSync("python3", ["-c", SCAN], { input: warmup, encoding: "utf8" });
    ok(scan.status === 0, `…and it parses as Python${scan.status === 0 ? "" : `: ${scan.stderr.trim().split("\n").pop()}`}`);
    if (scan.status === 0) {
      const { names, dynamic } = JSON.parse(scan.stdout);
      eq(dynamic, 0, "…and reaches no package through __import__(), which the wheel preloader cannot see");
      for (const mod of ["numpy", "pandas", "matplotlib", "scipy", "sklearn", "openpyxl"]) {
        ok(names.includes(mod), `…\`import ${mod}\` is a real import statement, so the preloader fetches its wheel`);
      }
    }
  }
  // The stale sentence that told the user only three packages were vendored,
  // after scipy, scikit-learn and openpyxl joined them in the same distribution.
  const ipynb = files["analysis.ipynb"] ?? "";
  ok(!/Only `numpy`, `pandas`, `matplotlib` and a few others are vendored/.test(ipynb),
    "the notebook's prose does not undercount the vendored stack");
  for (const named of ["scipy", "scikit-learn", "openpyxl"]) {
    ok(ipynb.includes(named), `…it names ${named}, which is vendored too`);
  }
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n== the wiring, so this does not pass while the studio does something else ==");

const controller = read("packages/studio/src/vv/controller.ts");
const editorGroup = read("packages/studio/src/components/ide/EditorGroup.tsx");
const templates = read("packages/studio/src/vv/templates.ts");
const sessionSrc = read("packages/studio/src/vv/notebook/session.js");

const transport = read("packages/studio/src/vv/notebook/studio-kernel.ts");

ok(/isNotebookPath/.test(controller), "the controller knows which files are notebooks");
ok(/"notebook"/.test(controller) && /"notebook"/.test(editorGroup), "…and `notebook` is a tab kind the editor renders");
// This one is a specific bug, guarded because it was written and shipped past a
// reading of the code: openEntry is the EXPLORER's path. ⌘P, a template's `entry`
// after create, and restoring a tab on reload all land in openFile — so a routing
// decision made only in openEntry opens the template's own notebook as raw JSON.
const openFileBody = controller.slice(controller.indexOf("async openFile("), controller.indexOf("async openFileAt("));
ok(openFileBody.length > 200 && /isNotebookPath/.test(openFileBody), "…and the decision is made in openFile, which is where EVERY way of opening a file lands");
ok(
  /INTERRUPT_CHAR = "\\x03"/.test(transport) && /term-input[\s\S]{0,200}INTERRUPT_CHAR/.test(transport),
  "interrupt is delivered as Ctrl-C on the shell's stdin — the only path that reaches SIGINT, and so the interrupt buffer",
);
ok(/term-open/.test(transport), "the kernel runs in a real shell…");
// The launch line, cross-checked against the two files that have to agree with it.
// A flag the `python` program does not dispatch would fall through to an ordinary
// script run — a kernel that starts, answers cells, and cannot import anything.
{
  const command = (transport.match(/KERNEL_COMMAND = `([^`]+)`/) || [, ""])[1];
  ok(/^python --vv-notebook-kernel \$\{NB_KERNEL_PATH\}/.test(command), `…executing the program from the path kernel-source.js names (${command})`);
  const flag = (command.match(/--[\w-]+/) || [""])[0];
  const program = read("packages/kernel-host/programs/python.js");
  ok(program.includes(`first === '${flag}'`), `…through a flag /bin/python actually dispatches (${flag})`);
  ok(/py\.notebookKernel\(/.test(program), "…onto the runtime's notebook driver");
  ok(/notebookKernel: \(filePath\)/.test(read("packages/runtime/builtins/python.js")), "…which the runtime exposes on the python surface");
  // A crashed kernel left the SHELL alive at a fresh prompt, so `term-exit` never
  // fired and the session waited for a frame that was never coming.
  ok(/; exit$/.test(command), "…and the shell exits with the kernel, so a kernel that dies produces a term-exit the session can report");
}
ok(NB_KERNEL_PATH.startsWith("/tmp/"), "…which is outside any project, so it never appears in the Explorer or a user's git status");
// The header explains why proc-spawn was not used, so the check is for a CALL,
// not a mention.
ok(!/post\(\s*"proc-/.test(transport), "…and NOT via proc-spawn, which has no way to send a signal (kernel-worker.ts routes proc-kill to kernel.stop)");
ok(!/\brun:\s/.test(transport), "…and the shell is opened WITHOUT `run`, which would prepend `npm install` to a project that has no node_modules");
ok(/at an idle prompt/.test(sessionSrc), "the session says why an idle interrupt is refused rather than just refusing it");
ok(/notebook/.test(templates) && /\.ipynb/.test(templates), "a template ships a notebook, so the feature is reachable");
// The manifest block, bounded by its own `files:` rather than a character count —
// a count silently stops covering the flag the moment a comment above it grows.
const nbManifest = (() => {
  const at = templates.indexOf('id: "python-notebook"');
  return at < 0 ? "" : templates.slice(at, templates.indexOf("files: {", at));
})();
// Cited BY SECTION TITLE, never by line number: a message carrying `AGENTS.md:3888`
// went stale without this assertion ever failing, and by then pointed into the
// middle of the language-service section.
ok(/experimental: true/.test(nbManifest), "…and it is still flagged experimental — the surface has a mount (spike-notebook-view.mjs) and the wire has an end-to-end run (spike-notebook-transport.mjs), and what is left needs a real tab: see \"A tier at each end of a wire is not a tier on the wire\" in AGENTS.md");

console.log(failed ? `\nFAIL: ${failed} check(s) failed` : "\nOK: the notebook's execution semantics and .ipynb round-trip hold");
process.exit(failed ? 1 : 0);