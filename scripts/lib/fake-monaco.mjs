// A stand-in for the parts of Monaco the Python providers touch, so the offline
// tier can drive them without an editor.
//
// It models what Monaco actually DOES rather than what would be convenient:
// getWordUntilPosition returns the word Monaco would return (which is what the
// completion range is built from, and getting it wrong replaces the wrong
// characters), and a CancellationToken is a mutable object read at the moment the
// provider looks — not a boolean captured when the request was made, which is the
// difference between a token that can fire mid-flight and one that cannot.
//
// The kind numbers are NOT restated here. spike-python-offline.mjs reads them out
// of the shipped monaco-editor instead, so a Monaco upgrade that renumbers the
// enum fails the check rather than passing against a copy of the old numbers.

export function makeFakeMonaco() {
  const registered = {
    completion: [],
    hover: [],
    signature: [],
    definition: [],
    formatting: [],
  };
  const disposed = [];
  // Markers are pushed, not returned from a provider, so the stand-in has to
  // keep them the way Monaco does: per model, per owner, last write wins.
  const markers = new Map(); // "owner\u0000uri" -> marker[]
  const modelWatchers = [];
  const track = (bucket, language, provider) => {
    registered[bucket].push({ language, provider });
    const d = { disposed: false, dispose() { this.disposed = true; disposed.push(bucket); } };
    return d;
  };
  return {
    registered,
    disposed,
    markers,
    // Real Monaco's numbering (monaco.MarkerSeverity), not an invention: 8 is
    // Error and 4 is Warning. The offline spike checks these against the shipped
    // monaco-editor the same way it checks the completion kinds.
    MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
    editor: {
      setModelMarkers: (model, owner, list) => {
        markers.set(owner + "\u0000" + model.uri.toString(), list);
      },
      markersFor: (model, owner) => markers.get(owner + "\u0000" + model.uri.toString()) || null,
      getModels: () => [],
      onDidCreateModel: (fn) => {
        modelWatchers.push(fn);
        return { dispose() {} };
      },
      // Test-side: announce a model the way Monaco does when a file is opened.
      openModel: (model) => { for (const fn of modelWatchers) fn(model); },
    },
    Uri: { file: (p) => ({ path: p, scheme: "file", toString: () => "file://" + p }) },
    languages: {
      registerCompletionItemProvider: (l, p) => track("completion", l, p),
      registerHoverProvider: (l, p) => track("hover", l, p),
      registerSignatureHelpProvider: (l, p) => track("signature", l, p),
      registerDefinitionProvider: (l, p) => track("definition", l, p),
      registerDocumentFormattingEditProvider: (l, p) => track("formatting", l, p),
    },
  };
}

/** A text model over a string, with the few methods the providers call. */
export function makeModel(path, text, language = "python") {
  const contentWatchers = [];
  let disposedFlag = false;
  return {
    uri: { path, scheme: "file", toString: () => "file://" + path },
    getLanguageId: () => language,
    isDisposed: () => disposedFlag,
    onDidChangeContent: (fn) => {
      contentWatchers.push(fn);
      // Monaco's listener disposable really does unsubscribe. A no-op here would
      // make a leaked listener look like a clean teardown.
      return { dispose() {
        const i = contentWatchers.indexOf(fn);
        if (i >= 0) contentWatchers.splice(i, 1);
      } };
    },
    // Test-side: edit the buffer and fire the event, as typing would.
    setValue: (next) => { text = next; for (const fn of contentWatchers) fn({}); },
    dispose: () => { disposedFlag = true; },
    getValue: () => text,
    getFullModelRange: () => {
      const lines = text.split("\n");
      return {
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: lines.length,
        endColumn: lines[lines.length - 1].length + 1,
      };
    },
    // Monaco's own definition: the word characters immediately before the
    // position, and the range they occupy. After a `.` this is empty, with
    // start === end === the cursor — which is why an insert there appends
    // instead of replacing.
    getWordUntilPosition: (pos) => {
      const line = text.split("\n")[pos.lineNumber - 1] || "";
      const upto = line.slice(0, pos.column - 1);
      const m = /[A-Za-z_$][\w$]*$/.exec(upto);
      const word = m ? m[0] : "";
      return { word, startColumn: pos.column - word.length, endColumn: pos.column };
    },
  };
}

/** A cancellation token whose answer can change after the provider has it. */
export function makeToken() {
  const t = { isCancellationRequested: false, cancel() { t.isCancellationRequested = true; } };
  return t;
}

/**
 * A host that records every request and answers from a table, so a test can say
 * what jedi replied without needing jedi.
 */
export function makeHost(answers = {}) {
  const calls = [];
  const notices = [];
  const states = [];
  const opened = [];
  return {
    calls,
    notices,
    states,
    opened,
    // Set to a function to control the reply per request (delays, failures).
    responder: null,
    request(root, req) {
      calls.push({ root, req });
      if (this.responder) return this.responder(root, req);
      const a = answers[req.op];
      if (a === undefined) return Promise.resolve({ ok: false, result: null, error: "no stub for " + req.op });
      return Promise.resolve({ ok: true, result: a, error: "" });
    },
    rootFor: () => "/project",
    notify: (m) => notices.push(m),
    openFileAt: (p, l, c) => opened.push([p, l, c]),
    setState: (s, d) => states.push([s, d || ""]),
  };
}