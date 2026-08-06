// Spike (NET tier — installs react/react-dom/jsdom/esbuild): the notebook's
// VIEW, rendered headlessly, asserting that every cell actually gets a working
// editor.
//
// Why this exists. `scripts/spike-notebook.mjs` covers the document model, the
// .ipynb round-trip, the execution queue and the output policy — 186 assertions,
// all green — and the feature shipped with EVERY CELL EDITOR DEAD. The split was
// drawn honestly ("everything in the components is layout") and it was still the
// wrong split, because the first thing a user touches had no coverage at all.
// This is the collection on that.
//
// What broke, precisely, so this file can be read against it: the studio renders
// under <StrictMode> (packages/studio/src/main.tsx), so every effect runs twice —
// mount, clean up, mount again — and building a cell editor is asynchronous,
// because Monaco is imported on demand. The first run's cleanup therefore landed
// while the second run was still in flight, and it disposed the MODEL that the
// second run's live editor had just adopted at the same URI. Monaco's response
// to disposing an attached model is to detach: it pulls its own DOM out of the
// container and getContentHeight() returns -1. On screen: an empty bordered box
// at the caller's 22px floor, showing none of the cell's source, that cannot be
// clicked into or typed in.
//
// So this renders under <StrictMode>, because that is what ships. Running it
// against the broken version reproduces the symptom exactly; the assertions
// below are written against the symptom rather than against the mechanism.
//
// ── the second browser round, and what it changed about this file ────────────
//
// That fix shipped and the tab was still close to unusable: outputs did not
// appear until the tab was switched away and back, and Backspace, Cmd+A and
// Cmd+Z did nothing while typing and Enter worked. Every assertion here was
// green throughout, including "printed output reaches the page" — because this
// file bundled the view with esbuild alone, and the studio bundles it through
// the React Compiler. It was testing a program the repo does not serve. So the
// bundle above now runs babel-plugin-react-compiler, exactly as vite.config
// does, and those assertions turned red against the same source that had been
// passing. That is the shape of the failure to watch for in this whole tier:
// not a missing check, a faithful-looking harness that differs from the build.
//
// What is REAL here: NotebookView.tsx itself, compiled the way it is served;
// notebook/cell-editors.js (the ownership rules), notebook/doc.js,
// notebook/ipynb.js and notebook/render.js — the shipped bytes, imported. What
// is STUBBED: `monaco`, the icon components, the Button primitive and `cn`. The
// Monaco stub is not invented — each of its four load-bearing behaviours was
// MEASURED against monaco-editor 0.55.1 under jsdom before being written down
// here; see fakeMonaco().
//
// What this still cannot do, and where each of those lives instead:
//   · Show a widget being CLIPPED. jsdom has no layout engine, so the section on
//     editor options asserts that `fixedOverflowWidgets` is set and that nothing
//     above a cell traps a fixed-position descendant. Both are real conditions
//     for the fix to work and neither is the user's tooltip. roadmap.md's
//     browser tier holds the tooltip.
//   · Show that Monaco paints, that fonts resolve, or that suggestion, hover and
//     the context menu land in the right place.
//   · Prove a keystroke reaches the interpreter. `key()` proves dispatch, which
//     is where the bug was; it does not re-implement Monaco's editing.
//
//   run:  node scripts/spike-notebook-view.mjs /tmp/vv-vendor-nbview
//         (or `node scripts/run-spikes.mjs --net notebook-view`, which provisions it)

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "packages/studio/src");

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
};
const eq = (got, want, msg) =>
  ok(got === want, `${msg}${got === want ? "" : ` (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`}`);
/** The computed `contain` of a node that may not be there. jsdom's
 *  getComputedStyle throws on null, which ends the process rather than failing
 *  one check — and a node that is missing is exactly the state a red run is in. */
const containOf = (node) => (node ? getComputedStyle(node).contain : "<no such element>");

const VENDOR = process.argv[2] || "/tmp/vv-vendor-nbview";
for (const need of ["react-dom", "babel-plugin-react-compiler"]) {
  if (fs.existsSync(path.join(VENDOR, "node_modules", need))) continue;
  console.log(`  ✗ no ${need} under ${VENDOR} — run via scripts/run-spikes.mjs --net notebook-view`);
  process.exit(1);
}
const require = createRequire(path.join(VENDOR, "spike.cjs"));

// ───────────────────────────────────────────────────────────────────────────
console.log("== bundling the real NotebookView.tsx ==");

// The component is TSX with `~icons/*` virtual modules and `@/…` aliases, so it
// has to go through a bundler to be importable at all. Only the leaves are
// replaced; the component's own code is untouched.
const esbuild = require("esbuild");
const ENTRY = path.join(VENDOR, "entry.tsx");
const BUNDLE = path.join(VENDOR, "notebook-view.bundle.mjs");
fs.writeFileSync(
  ENTRY,
  `export { NotebookView } from ${JSON.stringify(path.join(SRC, "components/ide/NotebookView.tsx"))};\n`,
);

const stubs = {
  "@/lib/utils": "export const cn = (...a) => a.flat(9).filter(Boolean).join(' ');",
  "@/components/ui/button": "export function Button({ children, ...p }) { return <button {...p}>{children}</button>; }",
};

// THE REACT COMPILER, and this bundle was wrong without it.
//
// The studio compiles every component through babel-plugin-react-compiler
// (packages/studio/vite.config.ts: `babel({ presets: [reactCompilerPreset()] })`),
// and the compiler MEMOISES ON IDENTITY. This file used to bundle the view with
// esbuild alone, so it rendered a program the studio does not ship — one with no
// memoisation at all — and every assertion below about output reaching the page
// passed while the shipped build showed the user a frozen notebook until they
// switched tabs. A view tier that compiles differently from the app is not a view
// tier, and that is the second time this feature has been caught by the gap
// between what is tested and what is served.
//
// Removing this plugin turns roughly a dozen assertions below green-but-worthless
// again, so: measured, not assumed — with it in place and NotebookView.tsx at the
// commit before this one, "printed output reaches the page" goes red.
const babel = require("@babel/core");
const reactCompiler = require("babel-plugin-react-compiler");
const compileLikeTheStudio = {
  name: "vv-react-compiler",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/ }, (args) => {
      const source = fs.readFileSync(args.path, "utf8");
      const out = babel.transformSync(source, {
        filename: args.path,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: ["typescript", "jsx"] },
        // `panicThreshold: "none"` is the preset's own default: a component the
        // compiler cannot handle is left alone rather than failing the build,
        // which is also what happens in the studio.
        plugins: [[reactCompiler, { panicThreshold: "none" }]],
      });
      return { contents: out.code, loader: "tsx" };
    });
  },
};

await esbuild.build({
  entryPoints: [ENTRY],
  bundle: true,
  outfile: BUNDLE,
  format: "esm",
  platform: "node",
  jsx: "automatic",
  // Left to node to resolve from VENDOR/node_modules, next to the bundle.
  // `react/compiler-runtime` is where the compiler's memo cache helper lives on
  // React 19; left external with the rest so node resolves it from VENDOR.
  external: ["react", "react-dom", "react/jsx-runtime", "react-dom/client", "react/compiler-runtime"],
  alias: { "@": SRC },
  plugins: [
    compileLikeTheStudio,
    {
      name: "vv-stubs",
      setup(build) {
        build.onResolve({ filter: /^~icons\/|useIde$/ }, (a) => ({ path: a.path, namespace: "vv" }));
        build.onResolve({ filter: /^@\/(lib\/utils|components\/ui\/button)$/ }, (a) => ({ path: a.path, namespace: "vv" }));
        build.onLoad({ filter: /.*/, namespace: "vv" }, (a) => ({
          loader: "tsx",
          contents:
            stubs[a.path] ??
            (a.path.startsWith("~icons/")
              ? "export default function Icon() { return null; }"
              : "export function useIde() { return globalThis.__VV_IDE__; }"),
        }));
      },
    },
  ],
});
ok(fs.existsSync(BUNDLE), "NotebookView.tsx bundles (its own code untouched; only icons, Button and cn stubbed)");
{
  // The bundle went through the compiler rather than past it. `_c(` is the memo
  // cache helper the compiler emits; if it is absent the plugin silently did
  // nothing and everything downstream is testing the wrong program again.
  const built = fs.readFileSync(BUNDLE, "utf8");
  ok(/react-compiler-runtime|useMemoCache|_c\(\d+\)/.test(built),
    "…through babel-plugin-react-compiler, as the studio's vite config does — the bundle carries memo caches");
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n== a DOM, and a Monaco whose behaviour was measured rather than imagined ==");

const { JSDOM } = require("jsdom");
const dom = new JSDOM("<!doctype html><div id=root></div>", { pretendToBeVisual: true, url: "http://localhost/" });
for (const k of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event",
  "MouseEvent", "KeyboardEvent", "DOMParser", "getComputedStyle", "requestAnimationFrame",
  "cancelAnimationFrame", "ResizeObserver"]) {
  if (dom.window[k] === undefined) continue;
  Object.defineProperty(globalThis, k, { value: dom.window[k], configurable: true, writable: true });
}
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** The four facts this stub has to get right, all four measured against
 *  monaco-editor 0.55.1 under jsdom before being written down here:
 *
 *    1. disposing a model DETACHES every editor attached to it — the editor's
 *       DOM leaves its container and getModel() returns null;
 *    2. a detached editor's getContentHeight() is -1, which is what turns the
 *       view's `Math.max(22, …)` into the empty 22px box the user saw;
 *    3. an editor STAMPS `data-keybinding-context` on the container it is given
 *       and REMOVES it when disposed, complaining to console.error if the
 *       container already carries one
 *       (platform/contextkey/browser/contextKeyService.js);
 *    4. the container's keydown listener is registered on create and removed on
 *       dispose MATCHED BY CONTAINER DOM NODE — and a repeat dispose() of an
 *       already-dead editor still removes one, because `removeCodeEditor` guards
 *       on `delete this._codeEditors[id]`, which is true for an absent key
 *       (standalone/browser/standaloneServices.js, browser/services/…).
 *
 *  3 and 4 are here because they are the whole of the dead-keyboard bug: keys
 *  that reach Monaco through the textarea (typing, Enter) worked throughout,
 *  and everything dispatched by the keybinding service against
 *  `EditorContextKeys.textInputFocus` — Backspace, Cmd+A, Cmd+Z, Tab, the arrow
 *  keys — did not. `key()` below resolves exactly the way Monaco does, so an
 *  assertion can press Backspace and look at the text.
 *
 *  Everything else here is bookkeeping so the assertions can see what happened. */
function fakeMonaco() {
  const models = new Map();
  const log = [];
  const editors = [];
  const LINE_HEIGHT = 19;
  const CTX_ATTR = "data-keybinding-context";
  /** Live container keydown listeners, in registration order, as Monaco keeps them. */
  const keydownContainers = [];
  const complaints = [];
  let nextContextId = 1;

  class Model {
    constructor(value, language, uri) {
      this.value = value;
      this.language = language;
      this.uri = uri;
      this.disposed = false;
      this.attached = new Set();
      log.push(`createModel ${uri.path}`);
    }
    getLineCount() { return this.value.split("\n").length; }
    getValue() {
      if (this.disposed) throw new Error(`read of disposed model ${this.uri.path}`);
      return this.value;
    }
    setValue(v) { this.value = v; for (const fn of this.changeListeners) fn(); }
    isDisposed() { return this.disposed; }
    dispose() {
      if (this.disposed) return;
      this.disposed = true;
      models.delete(this.uri.toString());
      for (const ed of [...this.attached]) ed._detach();
      log.push(`disposeModel ${this.uri.path}`);
    }
    changeListeners = new Set();
  }

  class Editor {
    constructor(el, opts) {
      this.el = el;
      this.model = opts.model ?? null;
      this.disposed = false;
      this.node = dom.window.document.createElement("div");
      this.node.className = "monaco-editor";
      el.appendChild(this.node);
      this.model?.attached.add(this);
      this._contentListeners = new Set();
      this._modelChangeListeners = new Set();
      // (3) and (4): the container is where Monaco keeps the keyboard.
      if (el.hasAttribute(CTX_ATTR)) complaints.push("Element already has context attribute");
      this._contextId = nextContextId++;
      el.setAttribute(CTX_ATTR, String(this._contextId));
      this._contextDisposed = false;
      keydownContainers.push({ el, editor: this });
      this.options = { ...opts };
      editors.push(this);
      log.push(`createEditor ${this.model?.uri.path}`);
    }
    getRawOptions() { return this.options; }
    _detach() {
      this.model?.attached.delete(this);
      this.model = null;
      this.node.remove();
    }
    getModel() { return this.model; }
    getContentHeight() {
      if (!this.model || this.model.disposed) return -1; // measured
      return this.model.getLineCount() * LINE_HEIGHT + 12;
    }
    layout() {}
    focus() {}
    addCommand() {}
    trigger() {}
    onDidContentSizeChange(fn) { this._contentListeners.add(fn); return { dispose: () => this._contentListeners.delete(fn) }; }
    onDidChangeModelContent(fn) {
      const relay = () => fn();
      this._modelChangeListeners.add(relay);
      this.model?.changeListeners.add(relay);
      return { dispose: () => { this.model?.changeListeners.delete(relay); this._modelChangeListeners.delete(relay); } };
    }
    onDidFocusEditorText() { return { dispose() {} }; }
    onDidBlurEditorText() { return { dispose() {} }; }
    dispose() {
      // (4), and it is deliberately OUTSIDE the `disposed` guard: a second
      // dispose() of a dead editor still de-registers one container listener,
      // and if a live editor is in that container it is the live one that loses
      // its keyboard. Measured; it is why release() has to be idempotent.
      const i = keydownContainers.findIndex((c) => c.el === this.el);
      if (i !== -1) keydownContainers.splice(i, 1);
      if (this.disposed) return;
      this.disposed = true;
      // (3): the scoped context service guards its OWN disposal, so only the
      // first dispose clears the attribute — but it does not check whose value
      // is currently on the node, so a leaving editor takes the attribute a
      // later one wrote. That is the difference between the two failure modes
      // and both end with a dead keyboard. Measured: create/create/dispose
      // leaves it null, not "the second editor's id".
      if (!this._contextDisposed) {
        this._contextDisposed = true;
        this.el.removeAttribute(CTX_ATTR);
      }
      for (const relay of this._modelChangeListeners) this.model?.changeListeners.delete(relay);
      log.push(`disposeEditor ${this.model?.uri.path}`);
      this._detach();
    }
  }

  /**
   * Press a key at `editor`, resolved the way Monaco resolves one.
   *
   * A container listener has to exist for this editor's box, and the DOM walk up
   * from it has to find a keybinding context — those two are what
   * `EditorContextKeys.textInputFocus` is reached through. Miss either and the
   * keypress is simply not dispatched, which on screen is a Backspace that does
   * nothing while typing keeps working.
   */
  function key(editor, name) {
    const heard = keydownContainers.some((c) => c.el === editor.el);
    let node = editor.el;
    let ctx = 0;
    while (node) {
      if (node.hasAttribute?.(CTX_ATTR)) { ctx = parseInt(node.getAttribute(CTX_ATTR), 10); break; }
      node = node.parentElement;
    }
    if (!heard || !ctx) return false; // dispatched into the root context: nothing runs
    const model = editor.getModel();
    if (!model || model.disposed) return false;
    // Only Backspace does anything to the text. What is being asserted is
    // whether the keypress is DISPATCHED at all — the editing itself is Monaco's
    // and is not re-implemented here — and Backspace, Cmd+A and Cmd+Z all reach
    // the editor through this one path.
    if (name === "Backspace") model.setValue(model.getValue().slice(0, -1));
    return true;
  }

  return {
    log,
    editors,
    key,
    complaints,
    live: () => editors.filter((e) => !e.disposed),
    Uri: { file: (p) => ({ path: p, scheme: "file", toString: () => `file://${p}` }) },
    KeyMod: { Shift: 1024, CtrlCmd: 2048 },
    KeyCode: { Enter: 3 },
    editor: {
      getModel: (uri) => models.get(uri.toString()) ?? null,
      getModels: () => [...models.values()],
      createModel: (v, l, uri) => {
        const m = new Model(v, l, uri);
        models.set(uri.toString(), m);
        return m;
      },
      create: (el, opts) => new Editor(el, opts),
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// The shipped modules, imported as-is.
const { NotebookDoc } = await import(pathToFileURL(path.join(SRC, "vv/notebook/doc.js")));
const { NotebookSession, RS } = await import(pathToFileURL(path.join(SRC, "vv/notebook/session.js")));
const { CellEditors, cellFolder, cellPath } = await import(pathToFileURL(path.join(SRC, "vv/notebook/cell-editors.js")));
// The shipped sanitiser, imported directly as well as through the component: the
// policy and what the page ends up holding are two different assertions.
const { sanitizeHtml, ALLOWED_TAGS } = await import(pathToFileURL(path.join(SRC, "vv/notebook/render.js")));
const { NotebookView } = await import(pathToFileURL(BUNDLE));
const React = require("react");
const { createRoot } = require("react-dom/client");
const { act } = React;

const ABS = "/home/project/analysis.ipynb";
const SOURCES = {
  intro: "# Analysis\n\nProse, which renders rather than opening an editor.",
  load: "import pandas as pd\n\ndf = pd.DataFrame({\"city\": [\"Lisbon\", \"Oslo\"]})\ndf.head()",
  plot: "import matplotlib.pyplot as plt\n\nplt.plot([1, 2, 3])\nplt.show()",
};
const IPYNB = JSON.stringify({
  cells: [
    { cell_type: "markdown", id: "intro", metadata: {}, source: [SOURCES.intro] },
    { cell_type: "code", id: "load", execution_count: null, metadata: {}, outputs: [], source: [SOURCES.load] },
    { cell_type: "code", id: "plot", execution_count: null, metadata: {}, outputs: [], source: [SOURCES.plot] },
  ],
  metadata: {},
  nbformat: 4,
  nbformat_minor: 5,
});

/**
 * Mount NotebookView the way the studio does.
 *
 * `createCellEditor` is the four lines of IdeController.createCellEditor that
 * survive the removal of Monaco's import — the await, the deleted-cell check and
 * the delegation to CellEditors. The section at the bottom of this file asserts
 * the controller really is those four lines, so this cannot quietly drift into
 * testing a different program.
 */
async function mountNotebook({ strict, failFirstCell = false, realSession = false }) {
  const monaco = fakeMonaco();
  const doc = NotebookDoc.fromText(IPYNB);
  const ran = [];
  const errors = [];
  const reports = []; // what the controller would put in the status bar
  // Everything the handle asks of a kernel, in order. `realSession` puts the
  // shipped NotebookSession between the button and this list, so a click has to
  // survive the queue, the status machine and the frame reader to appear here.
  const sent = [];
  const io = {
    launch: () => sent.push("<launch>"),
    stop: () => sent.push("<stop>"),
    interrupt: () => sent.push("<interrupt>"),
    send: (line) => sent.push(line),
  };
  const session = realSession
    ? new NotebookSession(io, doc.sink())
    : { status: "off", queue: [], log: [], info: null };
  // Stands in for `await import("monaco-editor")`: one shared, genuinely slow
  // promise, which is the gap the two StrictMode runs overlap inside.
  const monacoLoad = new Promise((r) => setTimeout(r, 5));

  const handle = {
    abs: ABS,
    doc,
    editors: null,
    session,
    dispose() { handle.editors?.disposeAll(); handle.editors = null; },
    run: (id) => {
      const cell = doc.cell(id);
      if (!cell) return;
      if (cell.type !== "code") {
        reports.push("markdown cells have nothing to run — select a code cell, or press its ▶");
        return;
      }
      const model = handle.editors?.modelFor(id);
      if (model) doc.setSource(id, model.getValue());
      ran.push([id, doc.cell(id)?.source ?? ""]);
      if (realSession) session.run(id, doc.cell(id)?.source ?? "");
    },
    runSelected: () => { if (doc.selected) handle.run(doc.selected); },
    runAll: () => { for (const cell of doc.cells) if (cell.type === "code") handle.run(cell.id); },
    interrupt: () => { session.interrupt?.(); },
    restart: () => { session.restart?.(); },
    focusAfter() {},
    createCellEditor: async (el, id, language) => {
      await monacoLoad;
      if (failFirstCell && id === "load") throw new Error("monaco failed to load");
      const cell = doc.cell(id);
      if (!cell) return null;
      const editors = (handle.editors ??= new CellEditors(monaco, ABS));
      return editors.mount(el, id, language, cell.source, { theme: "vs-dark" });
    },
  };

  globalThis.__VV_IDE__ = { c: { notebook: (p) => (p === ABS ? handle : null) }, snap: {} };
  const container = dom.window.document.createElement("div");
  dom.window.document.getElementById("root").appendChild(container);
  const root = createRoot(container);
  const view = React.createElement(NotebookView, { abs: ABS });

  const consoleError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(" "));
  try {
    await act(async () => {
      root.render(strict ? React.createElement(React.StrictMode, null, view) : view);
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 40)); });
  } finally {
    console.error = consoleError;
  }
  return { monaco, doc, handle, session, sent, reports, root, container, ran, errors };
}

/** A real click, as the user's is: bubbling, so React's delegated listener sees it. */
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
const button = (container, title) => container.querySelector(`button[title="${title}"]`);
const frame = (obj) => RS + JSON.stringify(obj) + "\n";

// ───────────────────────────────────────────────────────────────────────────
console.log("\n== every cell gets a LIVE editor holding that cell's source (under <StrictMode>, which is what ships) ==");

{
  const { monaco, container, handle } = await mountNotebook({ strict: true });

  const hosts = [...container.querySelectorAll(".vv-cell-editor")];
  eq(hosts.length, 2, "one editor host per code cell (the markdown cell renders as prose)");

  const live = monaco.live();
  eq(live.length, 2, "exactly one LIVE editor per code cell — StrictMode's second run replaces the first, it does not stack");

  // THE regression. Before the fix this was 0 of 2: both live editors had been
  // detached by the first run's cleanup disposing the model out from under them.
  eq(live.filter((e) => e.getModel() && !e.getModel().disposed).length, 2,
    "…and every live editor still has a live model (the bug: a late cleanup disposed the model the mounted editor was on)");

  for (const [id, source] of [["load", SOURCES.load], ["plot", SOURCES.plot]]) {
    const model = handle.editors.modelFor(id);
    ok(!!model, `cell ${id} has a model on the handle`);
    eq(model?.getValue(), source, `…holding exactly that cell's source`);
    eq(model?.uri.path, cellPath(ABS, id, "python"), "…at the cell's own file URI, which is what the Python language service keys on");
  }

  // The symptom as the user described it, asserted directly: the boxes were at
  // the view's `Math.max(22, editor.getContentHeight())` floor because a detached
  // editor reports -1.
  for (const host of hosts) {
    const h = parseInt(host.style.height, 10);
    ok(Number.isFinite(h) && h > 22, `a cell box is sized to its content, not the 22px floor (got ${host.style.height || "none"})`);
    ok(host.querySelector(".monaco-editor") !== null, "…and Monaco's DOM is inside it, rather than an empty bordered box");
  }
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n== the same, without StrictMode — so a green run above is not green by accident ==");

{
  const { monaco } = await mountNotebook({ strict: false });
  eq(monaco.live().length, 2, "one live editor per code cell");
  eq(monaco.live().filter((e) => e.getModel() && !e.getModel().disposed).length, 2, "…each on a live model");
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n== a Run sends what is in the editor, not what was last stored ==");

{
  const { monaco, doc, handle, ran } = await mountNotebook({ strict: true });
  const model = handle.editors.modelFor("load");
  await act(async () => {
    model.setValue("df.tail()"); // as if typed
    handle.run("load");
  });
  eq(ran.length, 1, "the cell ran");
  eq(ran[0][1], "df.tail()", "…with the live model's text, which is the point of reading the model at dispatch");
  eq(doc.cell("load").source, "df.tail()", "…and the document was updated to match");
  eq(monaco.live().length, 2, "no editor was disturbed by any of that");
}

// ───────────────────────────────────────────────────────────────────────────
// The edge nothing owned: the CLICK. Above, `handle.run` is called by name; the
// studio's user presses a button. Between the two are React's listener, the
// handle's guards and the whole of NotebookSession — and "I press Run and
// nothing happens" is a report about exactly that span, three times now. So this
// starts at a DOM click and requires a request line at the other end, then feeds
// the answer back and requires it on screen.
console.log("\n== a click, a request line, and the answer back on screen ==");

{
  const { container, session, sent } = await mountNotebook({ strict: true, realSession: true });
  const play = [...container.querySelectorAll('button[title="Run this cell"]')];
  eq(play.length, 2, "each code cell has a Run button (the markdown cell has none)");
  ok(container.textContent.includes("[ ]"), "…and starts unnumbered");

  await act(async () => { click(play[0]); });
  eq(sent[0], "<launch>", "clicking Run on a cold notebook starts a kernel");
  ok(container.textContent.includes("[*]"), "…and the cell says so, rather than looking untouched");
  eq(sent.filter((s) => s.startsWith("{")).length, 0, "…but sends nothing to an interpreter that is not up yet");

  // The kernel answers. Nothing polls: this frame is the whole trigger.
  await act(async () => { session.feed(frame({ t: "ready", python: "3.14.2", platform: "emscripten" })); });
  const req = JSON.parse(sent.find((s) => s.startsWith("{")) ?? "null");
  eq(req?.op, "run", "the ready frame releases the queued cell");
  eq(req?.id, "load", "…the one whose button was pressed");
  eq(req?.source, SOURCES.load, "…carrying that cell's source");
  ok(container.textContent.includes("3.14.2"), "the toolbar names the interpreter that answered");

  await act(async () => {
    session.feed(frame({ t: "stream", name: "stdout", text: "two rows\n" }));
    session.feed(frame({ t: "result", data: { "text/plain": "  city\n0 Lisbon" } }));
    session.feed(frame({ t: "done", id: "load", status: "ok" }));
  });
  ok(container.textContent.includes("two rows"), "printed output reaches the page");
  ok(container.textContent.includes("Lisbon"), "…and so does the value");
  ok(container.textContent.includes("[1]"), "…and the cell wears the number the interpreter gave it");
}

{
  // The other two routes to the same call, because the user pressed all three.
  const { container, doc, session, sent } = await mountNotebook({ strict: true, realSession: true });
  await act(async () => { session.feed(frame({ t: "ready", python: "3.14.2", platform: "emscripten" })); });

  await act(async () => { click(button(container, "Run every cell, top to bottom")); });
  const ids = sent.filter((s) => s.startsWith("{")).map((s) => JSON.parse(s).id);
  eq(ids.length, 1, "Run all dispatches one cell at a time — there is one interpreter");
  eq(ids[0], "load", "…starting at the top");
  eq(session.queue.length, 1, "…with the rest queued behind it, not dropped");

  // Toolbar Run is `runSelected`, and a freshly opened notebook selects its FIRST
  // cell — markdown, in every template we ship. So the most prominent Run in the
  // notebook sends nothing, which is one of the three "nothing happens" the user
  // reported. It cannot send anything; what it must not do is stay quiet about it.
  const { container: c2, doc: d2, session: s2, sent: sent2, reports } = await mountNotebook({ strict: true, realSession: true });
  await act(async () => { s2.feed(frame({ t: "ready", python: "3.14.2", platform: "emscripten" })); });
  eq(d2.cell(d2.selected)?.type, "markdown", "a freshly opened notebook has its first cell selected, and it is prose");
  await act(async () => { click(button(c2, "Run cell (⇧↵)")); });
  eq(sent2.filter((s) => s.startsWith("{")).length, 0, "so the toolbar Run has nothing to send");
  ok(reports.some((r) => /markdown/.test(r)), `…and says so rather than looking broken (${JSON.stringify(reports)})`);
  await act(async () => { d2.select("plot"); });
  await act(async () => { click(button(c2, "Run cell (⇧↵)")); });
  eq(JSON.parse(sent2.find((s) => s.startsWith("{")) ?? "null")?.id, "plot", "…and runs the selected cell once there is one");
  void doc;
}

// ───────────────────────────────────────────────────────────────────────────
// The user's report: "press Run, nothing visibly happens; open another file,
// come back, and the output is there." The data was right the whole time — the
// document had it, the store notified, useSyncExternalStore re-rendered — and
// the React Compiler handed React back the element tree it had cached, because
// every dependency it memoised on (`doc.cells`, `cell.outputs`, `session.queue`,
// `session.log`) is an object this store mutates in place. Switching tabs
// unmounts the view (EditorGroup keys it on the active tab), which throws the
// cache away, which is why a tab switch "fixed" it.
//
// So the assertion is: WITHOUT REMOUNTING. Everything below happens on one
// mounted tree, and the section above it that feeds frames does too — those go
// red against the unfixed view as well, but as a dozen unexplained collateral
// failures. This one says what it is.
console.log("\n== the screen repaints where it stands, with no remount to rescue it ==");

{
  const { container, session, root } = await mountNotebook({ strict: true, realSession: true });
  await act(async () => { session.feed(frame({ t: "ready", python: "3.14.2", platform: "emscripten" })); });
  ok(container.textContent.includes("idle"), "the toolbar shows the kernel that came up");

  await act(async () => { session.run("load", SOURCES.load); });
  ok(container.textContent.includes("busy"), "the status follows the session, which is a mutable object again and a different one");
  // A second cell behind the first: one interpreter, so it waits, and the wait
  // is drawn by pushing onto session.queue and setting a flag on the cell.
  await act(async () => { session.run("plot", SOURCES.plot); });
  ok(container.textContent.includes("[*]"), "a cell queued behind it is marked, on the tree that is already on screen");
  ok(/1 cell queued/.test(container.textContent), "…and the queue banner counts it, off an array the session pushes into");

  await act(async () => { session.feed(frame({ t: "stream", name: "stdout", text: "first chunk\n" })); });
  ok(container.textContent.includes("first chunk"), "streamed output appears without a remount — THE defect: outputs pushed onto cell.outputs in place");

  // The second chunk is the sharper half. The first one replaced `cell.outputs`
  // (onStart assigns a fresh array), so a view memoised on that array identity
  // would repaint once and then freeze; appendStream pushes into the array that
  // is already there, so only a view that re-reads on every notification shows
  // this one.
  await act(async () => { session.feed(frame({ t: "stream", name: "stdout", text: "second chunk\n" })); });
  ok(container.textContent.includes("second chunk"), "…and so does the NEXT chunk, appended in place to the same array");

  await act(async () => {
    session.feed(frame({ t: "result", data: { "text/plain": "42" } }));
    session.feed(frame({ t: "done", id: "load", status: "ok" }));
  });
  ok(container.textContent.includes("42"), "the result appears");
  ok(container.textContent.includes("[1]"), "…and the execution count, which is a field mutated on the cell object");
  // The queue drains by `shift()`ing the same array, so the banner going away is
  // a repaint driven by an in-place shrink rather than by a new object.
  ok(!/1 cell queued/.test(container.textContent), "…and the queue banner clears as the cell behind it is dispatched");

  // Only now, and only to show the difference the user described: a remount
  // would have shown all of this. The point is that it was not needed.
  const beforeRemount = container.textContent;
  await act(async () => { root.render(React.createElement(React.StrictMode, null, React.createElement(NotebookView, { abs: ABS }))); });
  ok(beforeRemount.includes("42"), "…and the screen already agreed with the document before any re-render was forced");
}

// ───────────────────────────────────────────────────────────────────────────
// The other half of the same StrictMode double-mount. The first fix stopped the
// two runs fighting over the MODEL; they went on sharing the CONTAINER, and
// Monaco keeps the keyboard there.
console.log("\n== the cell you can type in is the cell you can edit ==");

{
  const { monaco, handle, container } = await mountNotebook({ strict: true });
  const hosts = [...container.querySelectorAll(".vv-cell-editor")];

  ok(monaco.complaints.length === 0,
    `Monaco was never handed a container that already had an editor on it (it says "Element already has context attribute" when it is; heard ${JSON.stringify(monaco.complaints)})`);

  eq(hosts.filter((h) => h.hasAttribute("data-keybinding-context")).length, hosts.length,
    "every cell's box carries a live keybinding context — without it a keypress resolves in the root context, where textInputFocus is false");

  // The symptom, pressed. Typing and Enter never came through here, which is why
  // the notebook looked half-alive rather than dead.
  for (const id of ["load", "plot"]) {
    const editor = monaco.live().find((e) => e.getModel()?.uri.path.endsWith(`${id}.py`));
    ok(!!editor, `cell ${id} has a live editor`);
    const before = editor.getModel().getValue();
    let dispatched = false;
    // Deleting a character writes through to the document, so this is a render.
    await act(async () => { dispatched = monaco.key(editor, "Backspace"); });
    ok(dispatched && editor.getModel().getValue() === before.slice(0, -1),
      `…and Backspace in cell ${id} actually deletes (the report: it did not, nor did Cmd+A or Cmd+Z, while typing worked)`);
  }
  void handle;
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n== the options a cell needs that a file editor does not ==");

{
  const monaco = fakeMonaco();
  const editors = new CellEditors(monaco, ABS);
  const el = dom.window.document.createElement("div");
  const slot = editors.mount(el, "load", "python", SOURCES.load, { theme: "vs-dark" });
  const opts = slot.editor.getRawOptions();

  // DECLARATION ONLY, and the distinction matters. jsdom has no layout engine,
  // so nothing here can show a tooltip being clipped or not clipped — that is on
  // the browser tier's list in roadmap.md. What this can do is hold the option
  // on, which is what stops it being dropped by the next edit to this list.
  eq(opts.fixedOverflowWidgets, true,
    "fixedOverflowWidgets is on — the suggest and hover widgets are drawn inside the editor's DOM otherwise, and a cell's box is overflow-hidden and only as tall as its code");
  eq(opts.stickyScroll?.enabled, false, "sticky scroll is off — a cell does not scroll, so the header can only cover its first lines");
  eq(opts.scrollbar?.vertical, "hidden", "…which is the same reason the cell has no scrollbar of its own");
  eq(opts.theme, "vs-dark", "the studio's overrides still win over the defaults");

  // `fixedOverflowWidgets` positions those widgets `fixed` WITHOUT reparenting
  // them (browser/view.js only moves them when an overflowWidgetsDomNode is
  // supplied, which we do not), so it holds only while nothing above a cell
  // establishes a containing block for fixed descendants. `contain: layout paint`
  // does exactly that, and this notebook has two of those — both deliberate
  // security boundaries, neither on this path today. This is the check that they
  // stay off it: the fix for a clipped tooltip is to move a boundary, never to
  // delete one.
  const { container } = await mountNotebook({ strict: true });
  const host = container.querySelector(".vv-cell-editor");
  ok(!!host, "a cell editor is on the page");
  const trapping = ["contain", "transform", "filter", "perspective", "backdropFilter", "willChange"];
  const offenders = [];
  for (let node = host; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    for (const prop of trapping) {
      const v = style[prop];
      if (v && v !== "none" && v !== "auto" && v !== "normal") offenders.push(`${node.className || node.tagName}: ${prop}=${v}`);
    }
  }
  eq(offenders.length, 0,
    `nothing between a cell editor and the page traps a fixed-position widget — that is what would put the tooltip back inside the clipping box (${JSON.stringify(offenders)})`);
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n== what an output DRAWS, with a real DOMParser under it ==");

// WHY THIS IS HERE AND NOT IN spike-notebook.mjs. `sanitizeHtml` needs a DOM,
// deliberately — a regex sanitiser that disagrees with the renderer is how these
// are always defeated — so the offline tier can only enumerate the policy's pure
// predicates, and `render.js` says as much. Two bugs lived in the half that
// sentence excludes, and this is the tier that has the missing half: a real parser,
// a real serializer, and the real component putting the result on a page.
{
  const { container, session } = await mountNotebook({ strict: true, realSession: true });
  await act(async () => { session.feed(frame({ t: "ready", python: "3.14.2", platform: "emscripten" })); });
  const show = async (data) => {
    await act(async () => { session.run("load", SOURCES.load); });
    await act(async () => {
      session.feed(frame({ t: "display", data }));
      session.feed(frame({ t: "done", id: "load", status: "ok" }));
    });
  };

  // 1. THE FOURTH "nothing happened", and it was in the same commit as the lesson
  // about seams: SVG ranked third in MIME_ORDER, went to the HTML sanitiser, and
  // came back stripped to nothing because `svg` is not an allowed tag (correctly).
  // The div rendered empty and `text/plain` was unreachable.
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';
  await show({ "image/svg+xml": SVG, "text/plain": "<Figure size 8x8>" });
  const img = container.querySelector("img[src^='data:image/svg+xml;base64,']");
  ok(!!img, "an SVG output puts a real <img> on the page…");
  // Decoded defensively: a failed assertion above must not throw and take the rest
  // of this block's checks with it, which is how the first version of this section
  // reported one failure where there were five.
  const decoded = (() => {
    try {
      return Buffer.from(String(img?.getAttribute("src")).split(",")[1] ?? "", "base64").toString("utf8");
    } catch {
      return "<undecodable>";
    }
  })();
  eq(decoded, SVG, "…carrying the figure the kernel sent");
  ok(!container.querySelector("svg"), "…and nothing inlines the markup itself, which is where the script would have been");

  // 2. The `<style>` hole, end to end: a downloaded notebook's CSS reaching the
  // studio's own document through dangerouslySetInnerHTML, unscoped, in the origin
  // that holds the kernel bridge. The walk skips text nodes and a raw-text element's
  // content is one text node, so every byte of it survived.
  //
  // THE ORDER MATTERS, and it is why nobody saw this. The HTML parser hoists a
  // `<style>` that arrives BEFORE any body content into `<head>`, and this sanitiser
  // walks `doc.body` and serialises it — so the shape pandas writes, with its style
  // block first, was silently dropped and looked safe. A `<style>` anywhere after
  // the first element stays in the body and came through verbatim, `@import` and
  // all. Both shapes are asserted, because a check that only used the first one
  // passes against the vulnerable code — measured, on the way to writing this.
  await show({ "text/html": "<table><tr><td>42</td></tr></table><style>.vv-tab { display: none !important }</style>" });
  let shown = container.innerHTML;
  ok(!/display: none/.test(shown), "a <style> AFTER an output's first element does not reach the page…");
  ok(!container.querySelector("style"), "…not as an element…");
  ok(!/vv-tab/.test(shown), "…and not as text either, which is the part a tree walk misses");
  ok(container.textContent.includes("42"), "…while the table it arrived with still renders");
  await show({ "text/html": "<p>t</p><style>@import url(https://evil.example/x.css);</style>" });
  ok(!/evil\.example/.test(container.innerHTML), "…and neither does one that fetches, which the style ATTRIBUTE has always refused");
  await show({ "text/html": "<style>.a { color: red }</style><div>first</div>" });
  shown = container.innerHTML;
  ok(!/color: red/.test(shown) && container.textContent.includes("first"), "a LEADING <style> is gone too — it was only ever dropped by the parser hoisting it out of the body");

  // 3. The fallthrough, with a real sanitiser doing the stripping.
  await show({ "text/html": "<script>alert(1)</script>", "text/plain": "<MyThing at 0x1>" });
  ok(container.textContent.includes("<MyThing at 0x1>"), "an output whose HTML is entirely refused falls through to text/plain");
  ok(!/alert\(1\)/.test(container.innerHTML), "…without the script coming along");

  // 4. …and with nothing to fall through to, it SAYS so. This is the whole class:
  // a control or a surface that does nothing and reports nothing is
  // indistinguishable from a broken backend.
  await show({ "text/html": "<iframe src='https://evil.example'></iframe>" });
  ok(/could not be rendered|nothing in this output/i.test(container.textContent), "an output with nothing renderable in it says so instead of rendering blank");
  ok(!container.querySelector("iframe"), "…and the iframe is gone");

  // 5. The sanitiser itself, against the parser that will render its output.
  ok(!/onerror/i.test(sanitizeHtml('<img src=x onerror="alert(1)">')), "sanitizeHtml removes an event handler attribute");
  ok(/<img/.test(sanitizeHtml('<img src="data:image/png;base64,iVBORw0KGgo=">')), "…keeps an inline PNG, which is how a figure arrives");
  eq(sanitizeHtml("<div>x</div><style>body{color:red}</style>"), "<div>x</div>", "…removes a <style> element and its CSS with it, in the position where it used to survive");
  eq(sanitizeHtml("<script>alert(1)</script>"), "", "…and a <script> and its body");
  ok(/target="_blank"/.test(sanitizeHtml('<a href="https://x.dev">y</a>')), "…and a link opens away from the studio");
  // A `<td>` on its own is dropped by the HTML parsing algorithm, so this asks the
  // question in the shape pandas actually writes it.
  ok(
    /style="text-align: right"/.test(sanitizeHtml('<table><tr><td style="text-align: right">1</td></tr></table>')),
    "…while pandas' inline styles survive, which is what <style> was allowed for",
  );

  // 6. `<template>`, which is the same hole through a different mechanism and the
  // reason the refusal is structural rather than a line in the allowlist. Its
  // children are parsed into a fragment on `.content`, so the element has no child
  // nodes at all: the walk inspects nothing, concludes nothing needs removing, and
  // the serializer writes the fragment back out.
  //
  // The second assertion is the one worth having. Dropping the element is what the
  // allowlist does anyway, so it would pass with no structural refusal at all —
  // measured. So the tag is allowlisted for the length of one call, which is
  // exactly the future edit the second lock exists to survive, and against a real
  // parser rather than against a set.
  const TPL = "<div>x</div><template><script>alert(1)</script></template>";
  eq(sanitizeHtml(TPL), "<div>x</div>", "…and a <template> goes, with the script hiding in its fragment");
  ALLOWED_TAGS.add("template");
  const withTemplateAllowed = sanitizeHtml(TPL);
  ALLOWED_TAGS.delete("template");
  eq(
    withTemplateAllowed,
    "<div>x</div>",
    "…still gone with `template` ADDED to the allowlist: the walk cannot see inside it, so no list entry may let it through",
  );

  // 7. The third member of that class, and the one the first two could not have
  // found. `<style>` and `<template>` were both answers to "what does the allowlist
  // forbid, and can I get through it". This is the answer to "what does it PERMIT",
  // which nobody had asked: the `style` attribute is allowed, refused only for
  // `url(`, and painting is neither execution nor egress — so the policy had no
  // category for it and every check passed the div below.
  const REDRESS =
    '<div style="position:fixed;top:0;left:0;width:100vw;height:100vh;background:#fff;z-index:99999">' +
    '<a href="https://evil.example/signin">Your session expired — sign in again</a></div>';
  await show({ "text/html": REDRESS });
  const host = container.querySelector(".vv-nb-html");
  ok(!!host, "sanitised HTML renders in a container this tier can find");
  // The premise, asserted rather than assumed: the policy still lets all of this
  // through. If a later edit starts refusing `position`, this goes red and the
  // assertion below stops meaning what it says.
  ok(/position\s*:\s*fixed/.test(host?.innerHTML ?? ""), "…and the policy DOES pass a fixed-position overlay — it models execution and egress, not layout");
  // The fix, and the reason it is here rather than in the allowlist: containment
  // bounds the category. Measured on the mounted node, not read out of a stylesheet.
  //
  // `containOf` rather than getComputedStyle directly, because jsdom throws on a
  // null node and that ends the process: the run above this one reported eight
  // failures and then died here, hiding the twelve after it. Same argument as the
  // defensive base64 decode further up, and the same one AGENTS.md makes about
  // reading a red run per assertion rather than as a colour.
  eq(containOf(host), "layout paint",
    "…so the container is the containing block for fixed descendants AND clips their paint: a notebook cannot paint outside its own output");
  // The category, not the instance. Neither of these mentions `position`, both
  // escape a box, and both are covered by the same one declaration — which is the
  // argument against a list of refused property names, made against the parser.
  for (const escape of ["transform:translate(-50vw,-50vh)", "margin-left:-100vw;width:200vw", "position:sticky;top:0"]) {
    await show({ "text/html": `<div style="${escape}">x</div>` });
    const el = container.querySelector(".vv-nb-html");
    ok(/style=/.test(el?.innerHTML ?? "") && containOf(el) === "layout paint",
      `…and the same declaration bounds "${escape.split(":")[0]}", which a property denylist would have needed another entry for`);
  }
  // Every container, not just the one with the hole. `renderMarkdown` escapes
  // before any rule runs, so no style attribute can exist in the markdown output or
  // in a markdown CELL today — and that is a property of a hand-written renderer,
  // which is the kind of fact that stops being true when someone swaps in a library.
  // A markdown cell is the same stranger's document rendered on OPEN, so it is the
  // earlier half of the same threat and is asserted here rather than reasoned about.
  await show({ "text/markdown": "# heading\n\ntext" });
  const holders = [...container.querySelectorAll(".vv-nb-html, .vv-md")];
  ok(holders.length >= 2, `the view has more than one container holding markup out of the file (found ${holders.length})`);
  ok(holders.length > 0 && holders.every((el) => containOf(el) === "layout paint"),
    "…and EVERY one of them is contained, the markdown cell included — the category, not the branch the report arrived through");
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n== a fourth place to put file-derived markup would be uncontained ==");

{
  // The assertions above are behavioural and cover the three containers that exist.
  // Neither they nor anything else can see a container somebody adds next month,
  // and adding one is a two-line change that reopens the class in full.
  //
  // This is a SOURCE READ, which this MR's own notes call the weakest kind of
  // assertion here and list as debt the browser tier retires. It is worth its
  // weakness for one job: noticing a new site. Both counts move together or this
  // goes red.
  const src = fs.readFileSync(path.join(SRC, "components/ide/NotebookView.tsx"), "utf8");
  const sites = src.match(/dangerouslySetInnerHTML/g)?.length ?? 0;
  const contained = src.match(/contain:\s*"layout paint"/g)?.length ?? 0;
  ok(sites > 0, `the view still renders file-derived markup as HTML (${sites} sites)`);
  eq(contained, sites,
    "every place that puts file-derived markup into the studio's document carries the containment — a new one without it fails here");
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n== a cell editor that fails to build says so ==");

{
  // The original had no `.catch` anywhere on this promise, so a throw inside it
  // produced an empty box and complete silence — indistinguishable from the bug
  // above, and the reason it took a browser to notice either.
  const { monaco, errors } = await mountNotebook({ strict: true, failFirstCell: true });
  ok(errors.some((e) => /cell load/.test(e) && /monaco failed to load/.test(e)),
    "the rejection reaches the console naming the cell, instead of being swallowed by `.then(made => { if (!made) return; })`");
  eq(monaco.live().length, 1, "…and the cells that did build are unaffected");
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n== closing the notebook takes the models with it ==");

{
  const { monaco, handle, root } = await mountNotebook({ strict: true });
  await act(async () => { root.unmount(); });
  eq(monaco.live().length, 0, "unmounting disposes every editor");
  ok(monaco.editor.getModels().some((m) => m.uri.path.startsWith(cellFolder(ABS))),
    "…and NOT the models, which the notebook owns and a remount reuses");
  handle.dispose();
  eq(monaco.editor.getModels().filter((m) => m.uri.path.startsWith(cellFolder(ABS))).length, 0,
    "closing the notebook reaps them, by URI prefix — which also collects cells deleted or retyped while it was open");
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n== CellEditors' ordering rules, driven directly ==");

{
  // The two orders the StrictMode runs can finish in. Neither may leave a live
  // editor on a disposed model, neither may leave two editors in one box, and —
  // the second bug — neither may leave the survivor without a keyboard.
  for (const order of ["cleanup-last", "cleanup-first"]) {
    const monaco = fakeMonaco();
    const editors = new CellEditors(monaco, ABS);
    const el = dom.window.document.createElement("div");
    const a = editors.mount(el, "load", "python", SOURCES.load, {});
    const b = editors.mount(el, "load", "python", SOURCES.load, {});
    if (order === "cleanup-first") a.release();
    else { b.release(); a.release(); }
    const survivors = monaco.live();
    ok(survivors.every((e) => e.getModel() && !e.getModel().disposed),
      `${order}: no live editor is left on a disposed model`);
    ok(el.querySelectorAll(".monaco-editor").length <= 1, `${order}: at most one editor in the cell's box`);
    eq(monaco.complaints.length, 0, `${order}: no editor was ever created on an occupied container`);
    const survivor = survivors[0];
    if (survivor) {
      const before = survivor.getModel().getValue();
      ok(monaco.key(survivor, "Backspace") && survivor.getModel().getValue() === before.slice(0, -1),
        `${order}: …and the survivor still has a keyboard`);
    } else {
      ok(order === "cleanup-last", `${order}: both mounts were released, so there is nothing left to type in`);
    }
  }

  {
    // release() twice, which is what the late half of a StrictMode cleanup does
    // once a newer mount has already taken the slot. A repeat dispose() reaches
    // into Monaco's container bookkeeping and removes a listener that belongs to
    // somebody else by then, so the idempotence is not tidiness.
    const monaco = fakeMonaco();
    const editors = new CellEditors(monaco, ABS);
    const el = dom.window.document.createElement("div");
    const stale = editors.mount(el, "load", "python", SOURCES.load, {});
    stale.release();
    const live = editors.mount(el, "load", "python", SOURCES.load, {});
    stale.release(); // the cleanup, arriving late
    stale.release(); // and again, because nothing promises it happens once
    const before = live.model.getValue();
    ok(monaco.key(live.editor, "Backspace") && live.model.getValue() === before.slice(0, -1),
      "releasing a slot twice does not take the keyboard off the editor that replaced it");
    eq(monaco.live().length, 1, "…and leaves exactly one live editor");
  }

  const monaco = fakeMonaco();
  const editors = new CellEditors(monaco, ABS);
  const el = dom.window.document.createElement("div");
  const first = editors.mount(el, "load", "python", SOURCES.load, {});
  first.model.setValue("edited in the editor");
  first.release();
  const again = editors.mount(el, "load", "python", SOURCES.load, {});
  eq(again.model.getValue(), "edited in the editor", "a remounted cell keeps what was typed, because the model outlived the mount");
  eq(cellFolder(ABS), "/home/project/.analysis.ipynb.cells/", "cell models live under the notebook's own folder");
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n== the studio really is the program this file just drove ==");

const view = fs.readFileSync(path.join(SRC, "components/ide/NotebookView.tsx"), "utf8");
const controller = fs.readFileSync(path.join(SRC, "vv/controller.ts"), "utf8");
const main = fs.readFileSync(path.join(SRC, "main.tsx"), "utf8");

ok(/<StrictMode>/.test(main), "the studio renders under <StrictMode>, which is why the mount above does");
const create = controller.slice(controller.indexOf("private async createCellEditor("), controller.indexOf("/** ⌘S on a notebook tab"));
ok(/await import\("monaco-editor"\)/.test(create), "the controller still imports Monaco on demand — the async gap this file mounts across");
ok(/editors\.mount\(/.test(create) && /new CellEditors\(/.test(create),
  "…and delegates the editor's lifetime to CellEditors, the module driven above");
ok(!/monaco\.editor\.create\(/.test(create), "…rather than creating one itself, which is how the rules got bypassed the first time");
ok(/\.catch\(/.test(controller.slice(controller.indexOf("createCellEditor: (el, id, language)"), controller.indexOf("createCellEditor: (el, id, language)") + 900)),
  "the handle reports a failed build instead of resolving into silence");
ok(/\.catch\(/.test(view), "the view has a rejection handler on the chain that had none");
ok(!/model\.dispose\(\)|made\.model\.dispose\(\)/.test(view), "the view never disposes a model — the single line that made every cell dead");
ok(/slot\?\.release\(\)/.test(view), "…its cleanup releases the editor through the slot, which is a no-op once a later mount owns it");
ok(/onDidChangeModelContent/.test(view), "…and it listens for edits on the EDITOR, which outlives nothing, not on the model, which outlives the mount");

// The handle above is a copy of the controller's, so the copy has to be pinned to
// the original the same way createCellEditor is — otherwise the click section
// proves a program this repo does not ship.
const runHandler = controller.slice(controller.indexOf("      run: (id) => {"), controller.indexOf("      runSelected:"));
ok(/modelFor\(id\)/.test(runHandler) && /doc\.setSource\(id, model\.getValue\(\)\)/.test(runHandler),
  "the controller's Run still reads the live model before dispatching, which is what the click section drove");
ok(/session\.run\(id,/.test(runHandler), "…and hands it to the session rather than to a transport of its own");
ok(/cell\.type !== "code"/.test(runHandler) && /this\.status\(/.test(runHandler),
  "…and a Run on a markdown cell reports instead of returning into silence");
ok(/if \(doc\.selected\) handle\.run\(doc\.selected\)/.test(controller),
  "the toolbar's Run is still the selected cell, which is why the section above cares what is selected");

console.log(
  failed
    ? `\nFAIL: ${failed} check(s) failed`
    : "\nOK: the notebook view mounts a live editor, holding the cell's source, for every cell",
);
process.exit(failed ? 1 : 0);
