// Python language intelligence: jedi for completion/hover/signatures/definitions,
// black for formatting.
//
// WHY THIS EXISTS. TypeScript files get Monaco's real language service — compiler
// options, semantic diagnostics, .d.ts fed from the VFS. Python files got file
// icons and Monaco's default word-based suggestions, which scrape strings out of
// the open buffer: they will offer you a word from a comment and have never heard
// of `requests.get`. Both libraries here are pure Python and run on the
// interpreter we already ship, so the intelligence was one boot away.
//
// WHAT THIS IS NOT. There are no diagnostics here. mypy is a different and harder
// problem — heavier, needs scheduling care, and needs stubs for third-party
// packages before it says anything useful — and shipping a half version of it
// would be worse than shipping none. Completion and formatting; no red squiggles.
//
// THE LIFECYCLE, which is the actual design question. Every `python` process
// boots its own Pyodide and dies with it (see builtins/python.js). A language
// service cannot work that way: a REPL exiting must not take completion down, and
// an editor feature must not appear in the process table. So this runs on ONE
// long-lived interpreter that is not a process — see workers/python-lsp-worker.ts
// for where it lives. This module is the part that does not care: the Python
// driver, the request/response contract, and the queue. It is deliberately free
// of Monaco and of Pyodide so the offline tier can gate all of it.

// ---------------------------------------------------------------------------
// What has to be loaded, and where it comes from
// ---------------------------------------------------------------------------

// jedi is IN the Pyodide lock (0.19.2, with parso), so it costs a same-origin
// wheel and no PyPI. black is NOT, and neither are three of its dependencies —
// scripts/vendor-pyodide.mjs vendors the closure so this works with the network
// off. An editor feature that only works online, in a product whose pitch is
// running in the browser, is a different feature.
export const JEDI_PACKAGES = ["jedi"];
export const BLACK_PACKAGES = ["black"];

// The interpreter's own site-packages, and where the project's copy of it lives.
// A definition inside an installed package resolves to the first; the file that
// actually exists on the host is the second (builtins/python-store.js writes it).
export const INTERPRETER_SITE_PACKAGES = "/lib/python3.14/site-packages";
export const STORE_SITE_PACKAGES = ".venv/lib/python3.14/site-packages";

// ---------------------------------------------------------------------------
// The Python side
// ---------------------------------------------------------------------------

// One dispatch function, JSON in and JSON out. Not a PyProxy per field: a proxy
// has to be destroyed by hand and a leak here would be per-keystroke.
//
// The environment= argument is the load-bearing line in this file. jedi's default
// is to DISCOVER an environment, which means running sys.executable in a
// subprocess to ask it for its version — and Pyodide answers that with
// `OSError(138, 'emscripten does not support processes')`, so every request
// raises InvalidPythonEnvironment. That is not hypothetical: builtins/python.js
// sets sys.executable to "python" so runpy's errors read correctly, which is
// precisely what jedi then tries to execute. InterpreterEnvironment introspects
// the RUNNING interpreter instead, with no subprocess — so it also means
// completions see whatever the store restored into this interpreter, which is
// what makes `pip install tabulate` visible to the editor.
export const LSP_DRIVER_SOURCE = `
import json, os, sys

import jedi
from jedi.api.environment import InterpreterEnvironment

_VV_ENV = InterpreterEnvironment()
_VV_ROOT = "/"
_VV_PROJECT = None

# The last completion list, kept so resolve() can fetch one docstring for the one
# item the user highlighted. jedi's own docs warn that calling docstring() on a
# whole completion list is slow, and a popup that takes a second to appear is not
# worth a docstring nobody read.
_VV_LAST = {"token": None, "items": []}


def _vv_project(root):
    global _VV_ROOT, _VV_PROJECT
    if _VV_PROJECT is None or root != _VV_ROOT:
        _VV_ROOT = root
        _VV_PROJECT = jedi.Project(root)
    return _VV_PROJECT


def _vv_script(req):
    return jedi.Script(
        code=req["code"],
        path=req.get("path") or None,
        project=_vv_project(req.get("root") or "/"),
        environment=_VV_ENV,
    )


def _vv_where(d):
    """Where a definition lives, and whether that is a file anyone can open."""
    p = str(d.module_path) if d.module_path else ""
    return {"path": p, "line": d.line or 1, "column": (d.column or 0) + 1, "name": d.name or ""}


def _vv_complete(req):
    script = _vv_script(req)
    comps = script.complete(req["line"], req["column"])
    _VV_LAST["token"] = req.get("token")
    _VV_LAST["items"] = comps
    out = []
    for i, c in enumerate(comps):
        # description is jedi's one-liner ("def dumps", "instance int", "module
        # json"). No docstring here — see _VV_LAST.
        out.append({"i": i, "label": c.name, "type": c.type, "detail": c.description})
    return {"items": out}


def _vv_resolve(req):
    if _VV_LAST["token"] != req.get("token"):
        # The list this index refers to has been superseded. Answering from the
        # current list would attach one symbol's documentation to another's name.
        return {"stale": True}
    i = req.get("index", -1)
    if i < 0 or i >= len(_VV_LAST["items"]):
        return {"stale": True}
    c = _VV_LAST["items"][i]
    try:
        doc = c.docstring(raw=False)
    except Exception:
        doc = ""
    return {"doc": doc}


def _vv_hover(req):
    script = _vv_script(req)
    out = []
    for d in script.help(req["line"], req["column"]):
        doc = ""
        try:
            doc = d.docstring(raw=False)
        except Exception:
            pass
        if not doc and not d.description:
            continue
        out.append({"signature": d.description or "", "doc": doc, "type": d.type or ""})
    return {"items": out}


def _vv_signature(req):
    script = _vv_script(req)
    out = []
    for s in script.get_signatures(req["line"], req["column"]):
        params = []
        for p in s.params:
            params.append({"label": p.name, "detail": p.description or ""})
        out.append({
            "label": s.to_string(),
            "params": params,
            # index is None when the cursor is past the last parameter.
            "active": s.index if s.index is not None else -1,
        })
    return {"items": out}


def _vv_goto(req):
    script = _vv_script(req)
    defs = script.goto(req["line"], req["column"], follow_imports=True)
    return {"items": [_vv_where(d) for d in defs]}


def _vv_format(req):
    import black
    from black.parsing import ASTSafetyError

    src = req["code"]
    mode = black.Mode(line_length=req.get("lineLength") or 88)
    try:
        dst = black.format_str(src, mode=mode)
    except Exception as e:
        # InvalidInput carries "Cannot parse: 3:10", which is the only useful
        # thing anyone can be told here. Returning the input unchanged instead
        # would report success for a file black refused to read.
        return {"error": "parse", "message": str(e).split(chr(10))[0]}
    try:
        # black's own --safe check. format_str does NOT run it, and the failure
        # it catches is black changing what the code MEANS. Returning mangled
        # source over someone's buffer is the one outcome worth any cost.
        black.assert_equivalent(src, dst)
    except ASTSafetyError as e:
        return {"error": "unsafe", "message": str(e).split(chr(10))[0]}
    except Exception as e:
        return {"error": "unsafe", "message": type(e).__name__ + ": " + str(e)[:200]}
    return {"text": dst, "changed": dst != src}


_VV_OPS = {
    "complete": _vv_complete,
    "resolve": _vv_resolve,
    "hover": _vv_hover,
    "signature": _vv_signature,
    "goto": _vv_goto,
    "format": _vv_format,
}


def _vv_lsp(req_json):
    req = json.loads(req_json)
    op = req.get("op")
    fn = _VV_OPS.get(op)
    if fn is None:
        return json.dumps({"error": "op", "message": "unknown language-service op: " + str(op)})
    try:
        return json.dumps(fn(req))
    except Exception as e:
        # A jedi crash on one keystroke must not take the service down. Report it
        # as this request failing, and let the next one try again.
        return json.dumps({"error": "raised", "message": type(e).__name__ + ": " + str(e)[:300]})
`;

// ---------------------------------------------------------------------------
// Translating jedi's answers into what an editor wants
// ---------------------------------------------------------------------------

// Monaco's CompletionItemKind, by number. Numbers rather than the enum because
// this module must not import monaco-editor — it is loaded in a worker and in the
// offline spike, neither of which has it. Checked against the shipped enum in
// spike-python-offline.mjs, so a Monaco upgrade that renumbers them fails there
// rather than silently drawing a Class icon for every function.
export const MONACO_KIND = {
  METHOD: 0,
  FUNCTION: 1,
  FIELD: 3,
  VARIABLE: 4,
  CLASS: 5,
  MODULE: 8,
  PROPERTY: 9,
  VALUE: 13,
  KEYWORD: 17,
  FILE: 20,
  FOLDER: 23,
};

// jedi's `type` vocabulary is fixed and short (api/classes.py): module, class,
// instance, function, param, path, keyword, property, statement.
const KIND_BY_JEDI_TYPE = {
  module: MONACO_KIND.MODULE,
  class: MONACO_KIND.CLASS,
  instance: MONACO_KIND.VARIABLE,
  function: MONACO_KIND.FUNCTION,
  param: MONACO_KIND.VARIABLE,
  path: MONACO_KIND.FILE,
  keyword: MONACO_KIND.KEYWORD,
  property: MONACO_KIND.PROPERTY,
  statement: MONACO_KIND.VARIABLE,
};

export function completionKind(jediType) {
  // VALUE, not a guess at something prettier: an unknown type means jedi has
  // told us something this map has not been taught, and a wrong icon is a
  // small lie told confidently.
  const k = KIND_BY_JEDI_TYPE[jediType];
  return k === undefined ? MONACO_KIND.VALUE : k;
}

// Monaco counts columns from 1; jedi counts them from 0. Lines agree at 1. This
// is one subtraction and it is the single easiest thing in the feature to get
// wrong — off by one and every completion is for the character before the cursor.
export function toJediPosition(position) {
  return { line: position.lineNumber, column: Math.max(0, position.column - 1) };
}

/**
 * Where a definition lives on the HOST, given the path jedi reported inside the
 * interpreter. Three cases, and only one of them is a file the editor can open:
 *
 *  - the project itself -> already a host path
 *  - an installed package -> /lib/python3.14/site-packages/... inside the
 *    interpreter, which is the store's own contents; the host copy is under
 *    <project>/.venv, so rewrite it
 *  - the standard library -> /lib/python314.zip/..., a member of a zip archive
 *    inside the WASM build. There is no host file, and saying so is better than
 *    opening a blank tab.
 */
export function hostPathFor(interpreterPath, projectRoot) {
  const p = String(interpreterPath || "");
  if (!p) return { openable: false, reason: "jedi did not report a file for this definition" };
  if (p.startsWith(INTERPRETER_SITE_PACKAGES + "/")) {
    const rel = p.slice(INTERPRETER_SITE_PACKAGES.length + 1);
    const root = String(projectRoot || "").replace(/\/+$/, "");
    return { openable: true, path: root + "/" + STORE_SITE_PACKAGES + "/" + rel };
  }
  if (p.includes("/python314.zip/") || p.startsWith("/lib/python3.14/")) {
    return {
      openable: false,
      reason: "this is in the Python standard library, which is compiled into the interpreter rather than kept as files",
    };
  }
  const root = String(projectRoot || "").replace(/\/+$/, "");
  if (root && (p === root || p.startsWith(root + "/"))) return { openable: true, path: p };
  return { openable: false, reason: "this definition is outside the project: " + p };
}

// ---------------------------------------------------------------------------
// Failure, said out loud
// ---------------------------------------------------------------------------

// The states the editor can be in, and what the status bar says for each. An
// empty completion list is indistinguishable from "no suggestions", so a service
// that is starting, or broken, has to say so somewhere the user is looking.
export const LSP_STATE = {
  OFF: "off",
  STARTING: "starting",
  READY: "ready",
  FAILED: "failed",
};

export function stateLabel(state, detail) {
  switch (state) {
    case LSP_STATE.STARTING:
      return "Python: starting\u2026";
    case LSP_STATE.READY:
      return "Python: jedi";
    case LSP_STATE.FAILED:
      return "Python: unavailable" + (detail ? " \u2014 " + detail : "");
    default:
      return null;
  }
}

/**
 * What to tell someone whose format request did not produce formatted text.
 * Never "nothing happened": a formatter that silently no-ops is indistinguishable
 * from a file that was already formatted, so the two must not look the same.
 */
export function formatFailureMessage(result) {
  if (!result || typeof result !== "object") return "black: no response from the language service";
  switch (result.error) {
    case "parse":
      // black's message is "Cannot parse: 3:10", which points at the line. Ours
      // would not be better, and would be one more thing to keep true.
      return "black could not parse this file \u2014 " + (result.message || "invalid syntax");
    case "unsafe":
      // Refusing to write is the correct outcome, but it must be visible: a
      // silent skip here means the buffer keeps source black thinks is broken.
      return "black produced code that does not match the original and was discarded \u2014 " + (result.message || "");
    case "raised":
      return "black failed: " + (result.message || "unknown error");
    default:
      return "black: " + (result.message || "unknown error");
  }
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

/**
 * One interpreter, one request at a time — Pyodide has no threads, so language
 * requests serialise whether or not this queue exists. What it adds is DROPPING:
 * keystrokes outrun a 15 ms round trip the moment anyone types quickly, and the
 * difference between an editor that feels alive and one that feels broken is
 * whether the eighth keystroke waits behind seven answers nobody will read.
 *
 * So: at most one request in flight, at most one waiting, and a newer request of
 * the same kind replaces the waiting one rather than joining it. Cancellation is
 * cooperative — a request already handed to the interpreter runs to completion,
 * because Pyodide cannot be interrupted — but its ANSWER is discarded, which is
 * the part the user can tell apart.
 */
export function createRequestQueue(send) {
  let running = false;
  const waiting = new Map(); // kind -> { req, resolve, cancelled }

  const pump = async () => {
    if (running) return;
    const next = waiting.keys().next();
    if (next.done) return;
    const kind = next.value;
    const job = waiting.get(kind);
    waiting.delete(kind);
    if (job.cancelled()) {
      job.resolve(null);
      queueMicrotask(pump);
      return;
    }
    running = true;
    let answer = null;
    try {
      answer = await send(job.req);
    } catch (e) {
      answer = { error: "raised", message: (e && e.message) || String(e) };
    }
    running = false;
    // Superseded while the interpreter was busy: the position it answered for is
    // not where the cursor is any more, so the answer is wrong, not merely late.
    job.resolve(job.cancelled() ? null : answer);
    queueMicrotask(pump);
  };

  return {
    /**
     * @param kind  requests of the same kind supersede each other; `hover` must
     *              not evict a `format` that is waiting behind it.
     * @param cancelled  called at both boundaries, so a token that fires while
     *              the interpreter is busy still suppresses the answer.
     */
    submit(kind, req, cancelled = () => false) {
      const prev = waiting.get(kind);
      if (prev) prev.resolve(null); // the caller is gone; do not leave it pending
      return new Promise((resolve) => {
        waiting.set(kind, { req, resolve, cancelled });
        void pump();
      });
    },
    get depth() {
      return waiting.size + (running ? 1 : 0);
    },
  };
}

// ---------------------------------------------------------------------------
// Registering the providers
// ---------------------------------------------------------------------------

// Monaco is a PARAMETER, not an import. That is what lets the offline tier drive
// every provider below with a stand-in and gate the request shapes, the
// cancellation and the failure wording on every PR — none of which needs an
// editor, and none of which should wait for a browser to be wrong in.
// packages/studio/src/vv/python-language.ts is the typed door onto this.

let completionToken = 0;

export function registerPythonLanguage(monaco, host) {
  const disposables = [];

  // One queue for every provider. Requests of the same kind supersede each other;
  // different kinds do not, so a hover does not evict a format that is waiting.
  const queue = createRequestQueue(async (job) => {
    const reply = await host.request(job.root, job.req);
    if (!reply.ok) {
      // The distinction the house rule is about: a service that is not there has
      // to be distinguishable from a service with nothing to say.
      host.setState(LSP_STATE.FAILED, reply.error);
      return null;
    }
    return reply.result;
  });

  const ask = (kind, model, req, token) => {
    const path = model.uri.path;
    return queue.submit(
      kind,
      { root: host.rootFor(path), req: { ...req, path, root: host.rootFor(path), code: model.getValue() } },
      () => !!token && token.isCancellationRequested,
    );
  };

  // ── completion ─────────────────────────────────────────────────────────────
  disposables.push(
    monaco.languages.registerCompletionItemProvider("python", {
      // "." is the one that matters: without it Monaco only asks after a word
      // character, so `json.` — the single most common thing anyone types before
      // wanting a completion — would produce nothing until another key.
      triggerCharacters: ["."],
      async provideCompletionItems(model, position, _context, token) {
        const pos = toJediPosition(position);
        const myToken = "c" + ++completionToken;
        const result = await ask("complete", model, { op: "complete", ...pos, token: myToken }, token);
        if (!result || result.error || token.isCancellationRequested) return { suggestions: [] };
        // Replace the word already typed rather than appending to it: without an
        // explicit range Monaco guesses, and guesses wrong after a dot.
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          endLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endColumn: word.endColumn,
        };
        return {
          suggestions: (result.items || []).map((it) => ({
            label: it.label,
            kind: completionKind(it.type),
            detail: it.detail,
            insertText: it.label,
            range,
            // Carried through to resolveCompletionItem, which fetches the one
            // docstring for the one item the user actually looks at.
            _vv: { token: myToken, index: it.i, root: host.rootFor(model.uri.path) },
          })),
        };
      },
      async resolveCompletionItem(item, token) {
        const meta = item._vv;
        if (!meta || item.documentation) return item;
        const reply = await host.request(meta.root, { op: "resolve", token: meta.token, index: meta.index });
        if (token.isCancellationRequested || !reply.ok) return item;
        const doc = reply.result && reply.result.doc;
        // `stale` means the list this index belongs to has been superseded;
        // attaching the answer anyway would put one symbol's documentation under
        // another symbol's name.
        if (doc) item.documentation = { value: "```python\n" + doc + "\n```" };
        return item;
      },
    }),
  );

  // ── hover ──────────────────────────────────────────────────────────────────
  disposables.push(
    monaco.languages.registerHoverProvider("python", {
      async provideHover(model, position, token) {
        const result = await ask("hover", model, { op: "hover", ...toJediPosition(position) }, token);
        if (!result || result.error || token.isCancellationRequested) return null;
        const items = result.items || [];
        if (!items.length) return null;
        const contents = [];
        for (const it of items) {
          if (it.signature) contents.push({ value: "```python\n" + it.signature + "\n```" });
          if (it.doc) contents.push({ value: it.doc });
        }
        return contents.length ? { contents } : null;
      },
    }),
  );

  // ── signature help ─────────────────────────────────────────────────────────
  disposables.push(
    monaco.languages.registerSignatureHelpProvider("python", {
      signatureHelpTriggerCharacters: ["(", ","],
      async provideSignatureHelp(model, position, token) {
        const result = await ask("signature", model, { op: "signature", ...toJediPosition(position) }, token);
        if (!result || result.error || token.isCancellationRequested) return null;
        const items = result.items || [];
        if (!items.length) return null;
        return {
          value: {
            signatures: items.map((s) => ({
              label: s.label,
              parameters: (s.params || []).map((p) => ({ label: p.label, documentation: p.detail })),
            })),
            activeSignature: 0,
            // -1 is jedi saying the cursor is past the last parameter. Monaco
            // wants a number; 0 would highlight the wrong one, so clamp to the
            // end rather than to the start.
            activeParameter: Math.max(0, items[0].active < 0 ? (items[0].params || []).length - 1 : items[0].active),
          },
          dispose() {},
        };
      },
    }),
  );

  // ── go to definition ───────────────────────────────────────────────────────
  disposables.push(
    monaco.languages.registerDefinitionProvider("python", {
      async provideDefinition(model, position, token) {
        const result = await ask("goto", model, { op: "goto", ...toJediPosition(position) }, token);
        if (!result || result.error || token.isCancellationRequested) return null;
        const root = host.rootFor(model.uri.path);
        const out = [];
        for (const d of result.items || []) {
          const where = hostPathFor(d.path, root);
          if (!where.openable) {
            // Say why rather than doing nothing. "Nothing happened" when you
            // ctrl-click reads as a broken feature; "this is in the standard
            // library, which is compiled into the interpreter" reads as an answer.
            host.notify(d.name ? d.name + ": " + where.reason : where.reason);
            continue;
          }
          out.push({
            uri: monaco.Uri.file(where.path),
            range: {
              startLineNumber: d.line,
              endLineNumber: d.line,
              startColumn: d.column,
              endColumn: d.column + (d.name ? d.name.length : 0),
            },
          });
        }
        return out;
      },
    }),
  );

  // ── formatting (black) ─────────────────────────────────────────────────────
  disposables.push(
    monaco.languages.registerDocumentFormattingEditProvider("python", {
      async provideDocumentFormattingEdits(model, _options, token) {
        const result = await ask("format", model, { op: "format" }, token);
        if (token.isCancellationRequested) return [];
        if (!result) {
          // The queue returns null for a dropped or failed request. Formatting is
          // an explicit action, so silence here is the lie the house rule names.
          host.notify("black is unavailable — the Python language service is not running");
          return [];
        }
        if (result.error) {
          host.notify(formatFailureMessage(result));
          return [];
        }
        if (!result.changed) {
          // Distinguishable from a failure, deliberately: an empty edit list on
          // its own looks exactly like the formatter having done nothing.
          host.notify("black: already formatted");
          return [];
        }
        return [{ range: model.getFullModelRange(), text: result.text }];
      },
    }),
  );

  return () => {
    for (const d of disposables) d.dispose();
    disposables.length = 0;
  };
}