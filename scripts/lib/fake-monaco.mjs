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
  const track = (bucket, language, provider) => {
    registered[bucket].push({ language, provider });
    const d = { disposed: false, dispose() { this.disposed = true; disposed.push(bucket); } };
    return d;
  };
  return {
    registered,
    disposed,
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
export function makeModel(path, text) {
  return {
    uri: { path, scheme: "file" },
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