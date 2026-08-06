// Who owns a notebook cell's Monaco editor, who owns its model, and for how long.
//
// Plain JS (not TS) with a sibling .d.ts, like the rest of this folder, so
// `scripts/spike-notebook-view.mjs` drives the exact code the studio ships
// against a stand-in `monaco`. Monaco is a PARAMETER here for the same reason
// `python-lsp.js` takes one.
//
// ── the bug this file exists to make impossible ──────────────────────────────
//
// The first version of this logic lived inline in a React effect in
// NotebookView: the effect created a model at the cell's URI, and its cleanup
// disposed the editor AND the model. Two facts turned that into a dead notebook:
// the studio renders under <StrictMode> (main.tsx), which runs every effect
// twice — mount, clean up, mount again — and building an editor is asynchronous,
// because Monaco is imported on demand. So the two runs overlapped:
//
//     run 1 starts        awaiting import("monaco-editor")
//     run 1 cleans up     marks itself dead; nothing built yet to tear down
//     run 2 starts        same cell, same URI
//     run 1 finishes      creates model M, creates editor E1 on it
//     run 2 finishes      getModel(uri) HITS M, creates editor E2 on it
//     run 1's cleanup     disposes E1 — and M
//
// E2 is the editor the user is looking at, and its model is gone. Monaco's
// reaction to disposing an attached model is to detach the editor entirely: it
// removes its own DOM from the container, and getContentHeight() returns -1.
// Measured, not reasoned about — monaco-editor 0.55.1 under jsdom. On screen
// that is an empty bordered box at whatever minimum height the caller clamps to,
// which cannot be clicked into and cannot be typed in, and which shows none of
// the cell's source. That is exactly what shipped.
//
// The rule that removes the whole class of it:
//
//     A MOUNT OWNS ITS EDITOR. THE NOTEBOOK OWNS ITS MODELS.
//
// Disposing an editor never touches a model, so a cleanup that lands late can no
// longer damage a live one — the worst it can do is dispose an editor that is
// already gone. Models are reaped exactly once, in disposeAll(), when the
// notebook tab closes; doing it by URI prefix also collects the models of cells
// that were deleted or retyped while it was open, which no per-cell bookkeeping
// was doing. And a cell holds at most one editor: mounting releases whatever was
// in the slot, and release() is a no-op once a later mount has taken it, so the
// two StrictMode runs converge on one live editor either way round.
//
// Keeping the model also turns out to be what the user wants: a cell that is
// remounted (a type change and back, a re-render) keeps the text they typed
// rather than reverting to what was last written to the document.
//
// ── the second rule, from the second bug ─────────────────────────────────────
//
// That fix left the two mounts overlapping in the CONTAINER instead: the new
// editor was created on the cell's div while the old one was still on it, and
// the old one was disposed a line later. Monaco keys two things off that div —
// the keybinding context attribute and the container's keydown listener — and
// both are torn down by the disposal of the editor that is leaving, taking the
// surviving editor's keyboard with them. The result was a notebook you could
// type in but not edit: no Backspace, no Cmd+A, no Cmd+Z. So:
//
//     ONE LIVE EDITOR PER CONTAINER, AND THE OLD ONE GOES FIRST.
//
// mount() releases before it creates, and release() is idempotent so a cleanup
// arriving late cannot dispose a dead editor a second time. The long-form
// version, with the Monaco source lines and the measurements, is on mount().

/** The folder a notebook's cell models live under: `/dir/.name.ipynb.cells/`.
 *
 *  They are given real file URIs, under the notebook's own directory, because
 *  that is what the Python language service keys on — `python-lsp.js` sends
 *  `model.uri.path` as the file and `rootFor(path)` as the workspace root, so a
 *  cell with a synthetic URI would be completed against no project at all.
 *  Nothing ever writes to this path: the cells live in the .ipynb, not beside it.
 *  The leading dot keeps it out of the Explorer for the same reason. */
export function cellFolder(notebookAbs) {
  const dir = notebookAbs.slice(0, notebookAbs.lastIndexOf("/")) || "/";
  const name = notebookAbs.slice(notebookAbs.lastIndexOf("/") + 1) || notebookAbs;
  return `${dir === "/" ? "" : dir}/.${name}.cells/`;
}

/** The path of one cell's model. The extension is what the LSP and Monaco's own
 *  language detection read, so a type change is genuinely a different file. */
export function cellPath(notebookAbs, id, language) {
  return `${cellFolder(notebookAbs)}${id}.${language === "python" ? "py" : "md"}`;
}

/**
 * The editor options a notebook cell needs, as opposed to a file editor.
 *
 * `overrides` carries the things only the studio knows (theme, font).
 */
export function cellEditorOptions(overrides) {
  return {
    fontSize: 13,
    minimap: { enabled: false },
    // A cell grows to fit its code (the view measures it off
    // onDidContentSizeChange), so it must never scroll on its own — two nested
    // scrollbars is the classic notebook bug.
    scrollBeyondLastLine: false,
    scrollbar: { vertical: "hidden", alwaysConsumeMouseWheel: false },
    lineNumbers: "off",
    folding: false,
    glyphMargin: false,
    lineDecorationsWidth: 4,
    lineNumbersMinChars: 0,
    overviewRulerLanes: 0,
    renderLineHighlight: "none",
    wordWrap: "on",
    tabSize: 4, // Python
    padding: { top: 6, bottom: 6 },
    // Width follows the container (the panel is resizable); HEIGHT is driven by
    // the view, because a cell is as tall as its code rather than as tall as a
    // box it was given.
    automaticLayout: true,
    dropIntoEditor: { enabled: false },
    // Completion, hover, signature help and the context menu are drawn INSIDE
    // the editor's own DOM by default, and a cell editor is the worst possible
    // place for that: its container is `overflow-hidden` and only as tall as the
    // code in it, and the cell list above that is an `overflow-y-auto` scroller.
    // A suggest list therefore had nowhere to go — worst on the first cell,
    // where the widget wants to open upward and there is neither room nor a
    // visible overflow to open into. This makes those widgets `position: fixed`
    // in page coordinates, which is not clipped by an ancestor's overflow.
    //
    // What it does NOT do, checked in monaco-editor 0.55.1 rather than assumed:
    // it does not REPARENT them (browser/view.js only moves them when an
    // `overflowWidgetsDomNode` is supplied, which we do not). They stay inside
    // the cell's div and merely stop being positioned by it. So this holds only
    // while nothing between the widget and the viewport establishes a containing
    // block for fixed descendants — `transform`, `filter`, `perspective`,
    // `backdrop-filter`, `will-change`, or `contain` with layout/paint. The
    // notebook has two `contain: layout paint` boundaries (NotebookView.tsx: the
    // sanitised output, and a markdown cell), both deliberate security ones, and
    // neither is an ancestor of a cell editor. `spike-notebook-view.mjs` asserts
    // that stays true, because the failure mode is a tooltip that quietly goes
    // back to being clipped.
    //
    // AND WHAT THIS NOW PERMITS, which is the other half of the same question. A
    // widget escaping its box paints over the whole page, and what it paints is
    // hover and suggest documentation — docstrings out of the user's project and
    // whatever is installed in it, which is third-party text arriving one round
    // after "content out of a file painting outside its box" became this feature's
    // security boundary. Monaco owns that sanitisation and we do not weaken it,
    // verified in 0.55.1 rather than assumed: `getDomSanitizerConfig` defaults
    // `isTrusted` to false, `command:` is added to the allowed schemes only when
    // trusted, and the anchor pass drops `data:`, `javascript:` and untrusted
    // `command:` outright. We never build an `IMarkdownString`, never register a
    // hover provider and never pass `allowedLinkSchemes.augment`, so nothing here
    // opts into trust. Setting `isTrusted` anywhere in this studio would make a
    // docstring in an installed package a click away from a command, so it is a
    // decision to take deliberately rather than a flag to reach for.
    fixedOverflowWidgets: true,
    // A cell does not scroll — it has no vertical scrollbar and its height is
    // its content's height — so the sticky header can never do its job here, and
    // can only cover the first lines of a short cell with a copy of themselves.
    stickyScroll: { enabled: false },
    ...overrides,
  };
}

/** The Monaco editors and models behind one open notebook's cells. */
export class CellEditors {
  /** @param monaco the `monaco-editor` module (a parameter, so a spike can drive this)
   *  @param notebookAbs absolute path of the .ipynb */
  constructor(monaco, notebookAbs) {
    this.monaco = monaco;
    this.abs = notebookAbs;
    this.folder = cellFolder(notebookAbs);
    /** cell id -> the one editor currently mounted for it. */
    this.slots = new Map();
  }

  uriFor(id, language) {
    return this.monaco.Uri.file(cellPath(this.abs, id, language));
  }

  /**
   * Put an editor for `id` into `el`, replacing whatever was there.
   *
   * Synchronous on purpose: everything that has to await (importing Monaco,
   * reading the cell) happens before this is called, so the ordering rules in
   * the header hold no matter which of two overlapping mounts arrives first.
   */
  mount(el, id, language, source, overrides) {
    const monaco = this.monaco;
    const uri = this.uriFor(id, language);
    // BEFORE the create, not after, and this ordering is the whole of the second
    // bug this file has had. Monaco stamps `data-keybinding-context` on the
    // container it is given and REMOVES that attribute when the editor is
    // disposed (platform/contextkey/browser/contextKeyService.js), and it hangs
    // the container's keydown listener off onCodeEditorAdd/Remove keyed on the
    // same DOM node (standalone/browser/standaloneServices.js). So creating the
    // second editor on a container that still holds the first, and disposing the
    // first afterwards — which is what a StrictMode double-mount did here — ends
    // with the LIVE editor's container carrying no context at all. Its keydown
    // then resolves against the root context, where `textInputFocus` is false,
    // and every keybinding guarded by it silently stops resolving: Backspace,
    // Cmd+A, Cmd+Z, Tab, Home/End, the arrow keys, Cmd+F, Ctrl+Space. Typing and
    // Enter keep working, because those never go through the keybinding service
    // at all — they arrive as `input` on Monaco's textarea — and so do this
    // notebook's own Shift-Enter and Cmd-Enter, because `editor.addCommand`
    // registers a dynamic keybinding with no `when` clause. That is the exact
    // shape of the report: a cell you can type into and run, but not edit.
    //
    // Measured against monaco-editor 0.55.1 under jsdom, not reasoned about:
    // create/create/dispose leaves the attribute null and a real Backspace
    // keydown changes nothing; dispose-then-create leaves it live and the same
    // keydown deletes a character.
    this.slots.get(id)?.release();
    // Reused when it is already there. The model outlives any one mount by
    // design — see the header — so this is the normal path, not the rare one.
    const model = monaco.editor.getModel(uri) ?? monaco.editor.createModel(source, language, uri);
    const editor = monaco.editor.create(el, { ...cellEditorOptions(overrides), model });
    let releasedOnce = false;
    const slot = {
      editor,
      model,
      monaco,
      release: () => {
        // Idempotent, and that is load-bearing rather than tidiness. The late
        // half of a StrictMode double-mount calls release() on a slot a newer
        // mount has already released, and a REPEAT dispose() of a dead editor
        // still re-fires onCodeEditorRemove — `removeCodeEditor` guards on
        // `delete this._codeEditors[id]`, which is true for a key that is not
        // there — and the removal is matched by container DOM node, so it tears
        // the keydown listener off the editor now living in that container.
        // Same dead keyboard as above, reached the other way round; also
        // measured.
        if (releasedOnce) return;
        releasedOnce = true;
        // The editor, and ONLY the editor.
        editor.dispose();
        if (this.slots.get(id) === slot) this.slots.delete(id);
      },
    };
    this.slots.set(id, slot);
    return slot;
  }

  /** The live model for a cell, or null. Run reads this rather than the document
   *  so a cell that is mid-edit is sent as it looks, not as it was last stored. */
  modelFor(id) {
    const slot = this.slots.get(id);
    if (!slot) return null;
    return slot.model.isDisposed() ? null : slot.model;
  }

  /** The notebook tab is closing. Editors first, then every model under this
   *  notebook's folder — including cells deleted or retyped while it was open. */
  disposeAll() {
    for (const slot of [...this.slots.values()]) slot.release();
    this.slots.clear();
    for (const model of this.monaco.editor.getModels()) {
      if (!model.isDisposed() && model.uri.path.startsWith(this.folder)) model.dispose();
    }
  }
}