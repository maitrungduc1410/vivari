// The shared REPL kit — a line editor + read/eval/print loop, as guest source, so
// that `node` and `bun` (and later `python`) each get an interactive prompt without
// a third copy of the cursor arithmetic.
//
// WHY THIS IS A STRING AND NOT A MODULE. Everything in programs/ is embedded into a
// program's source (coreutils.js installs each as /bin/<name>.js and the runtime
// runs it as an ordinary CommonJS Node program). A guest program cannot `import`
// from packages/runtime, so a shared piece has to be shared the way NODE_GYP_STUB
// and PYTHON_DELEGATES already are: as text that the consumer concatenates.
//
// APPEND IT, DON'T PREPEND IT. `createRepl` is a function DECLARATION, so it hoists
// and can be called from anywhere in the program — and appending keeps the
// consumer's own `'use strict';` first in the file, where a directive prologue has
// to be. programs/bun.js additionally forbids backticks/${}/backslashes inside its
// own template string; this file is a DIFFERENT template string, so its escaping is
// its own business and `\\n` / `\\x1b` are spelled out here rather than assembled
// from String.fromCharCode. A REPL is mostly escape sequences, and
// String.fromCharCode(27) + '[' + 'K' is not more readable than '\\x1b[K'.
//
// WHY THE SHELL IS NOT A CONSUMER (yet). `sh`'s editor in coreutils.js looks like
// this one but does a different job: it dispatches COMMANDS and hands its raw stdin
// to a foreground child while one runs (`currentChild`), which is the opposite of
// owning the line for an evaluator. Folding the two together would mean one editor
// with a mode flag threaded through every keystroke branch. The overlap is real and
// noted; the merge is not obviously an improvement, so it has not been made.
//
// ── THIS IS A PROGRAM, NOT node:repl ────────────────────────────────────────────
//
// `require('repl')` still answers MODULE_NOT_FOUND, and deliberately. There is no
// blocklist entry to remove — 'repl' is in NODE_PUBLIC_CORE_IDS but has no
// node/lib/repl.js, so it is filtered out of what we can actually serve — and
// nothing here changes that, because the two are different jobs. This file is the
// prompt `node` opens; node:repl is a LIBRARY for building one, and its export is
// REPLServer: an EventEmitter with .context, .displayPrompt, .defineCommand,
// .setupHistory, .clearBufferedCommand, replaceable `eval` and `writer` hooks,
// `useGlobal`, `terminal`, `completer`, and a documented event contract.
//
// A repl.start() that took those options and honoured half of them would be worse
// than the MODULE_NOT_FOUND it replaces: that is a load-time failure with an
// obvious cause, and this codebase's rule (see the unsupported-surface notes in
// packages/runtime/builtins/bun-unsupported.js) is to refuse where the reason is
// visible rather than to succeed differently. It is also the shape of a module
// callers FEATURE-DETECT, so a shim that loads turns a working fallback path into
// a silent one. If node:repl is wanted later it is its own change, with its own
// tests, and it can be built on this kit.
//
// ── WHY FLOWING stdin AND NOT THE BLOCKING SYSCALL ──────────────────────────────
//
// packages/runtime/builtins/python.js reads its REPL lines through OP_READ_STDIN
// (`__ocReadStdin`), which parks the worker. It has to: Pyodide's stdin callback is
// a synchronous C-level read with no loop of its own to turn, and a python process
// has one stdin that both the REPL and a user's `input()` want.
//
// A JavaScript REPL has neither constraint, and parking would be WRONG here rather
// than merely costly. `setTimeout(() => console.log('hi'), 1000)` typed at a prompt
// must print after a second with nothing else typed; a server started at the prompt
// must serve requests between lines; a promise must settle. All of those need the
// event loop to turn while the prompt waits, so this reads `process.stdin` as the
// flowing TTY Readable the runtime already provides (packages/runtime/index.js) and
// evaluates on the 'data' turn.
//
// ── WHAT THE HOST DOES NOT DO FOR US ────────────────────────────────────────────
//
//   * NO ECHO. Nothing between xterm and here echoes a keystroke — `setRawMode` only
//     records a flag (there is no line discipline below us), so every character the
//     user sees on screen is written by this file.
//   * CTRL+C NEVER ARRIVES AS A BYTE. The interactive `sh` turns \\x03 into a SIGINT
//     for the whole foreground job and forwards nothing, so a REPL cannot see it in
//     the stream. It arrives as a signal, which is why `config.onSigint` is wired
//     through `process.on('SIGINT')` — and why the process must also tell the kernel
//     it is staying (globalThis.__ocSignalHandled), or the force-kill window that
//     exists for signal-swallowing guests will collect it.
//   * CTRL+D DOES arrive as a byte (\\x04), because that branch only intercepts
//     \\x03. The asymmetry is the host's, not ours.
//   * ENTER IS \\r FROM A TERMINAL AND \\n FROM A PIPE. `sh` rewrites \\r to \\n on
//     the way to a child, but the SDK's `proc.input` does not, so both are handled.
//   * A CHUNK IS NOT A KEYSTROKE. A paste arrives as one chunk with newlines in it,
//     so the reader loops over the whole chunk instead of assuming one key.
//
// ── CONFIG ──────────────────────────────────────────────────────────────────────
//
// The kit owns the TERMINAL (echo, cursor, history, keys, dot-commands, printing);
// the consumer owns the LANGUAGE (how a line becomes runnable, and what "runnable"
// even means). That line is exactly where node, bun and python differ, so none of it
// is hardcoded:
//
//   banner        string printed once at startup
//   prompt        primary prompt, e.g. '> '
//   contPrompt    continuation prompt, e.g. '... '
//   historyFile   absolute path to persist history to, or null for session-only
//   historyMax    cap on persisted entries (default 1000)
//   isIncomplete  (src) => boolean. Runs BEFORE `transform` — see below.
//   transform     (src) => src. Source-to-source, e.g. strip TypeScript.
//   rewrite       (src) => { code, names }. REPL semantics, e.g. let/const -> var.
//   hoistAwait    boolean. Whether `await` at the top level is wrapped for the user.
//   errorVar      name to bind the last error to ('_error'), or null for none.
//   commands      extra dot-commands: { '.name': { help, run(arg, api) } }
//   inspectDepth  util.inspect depth (default 2)
//
// WHY `isIncomplete` RUNS FIRST, AND IS NOT "CATCH SyntaxError". Node's own REPL
// decides to continue a line by evaluating it and inspecting the SyntaxError, which
// works because eval is the first thing that touches the source. It is not available
// to us: for bun, `transform` (the TypeScript stripper) runs BEFORE any eval and
// throws on `function f() {` all by itself, so the error that would have to be
// classified never comes from the evaluator at all. Deciding "is there more coming?"
// on the RAW text, before anything can reject it, is the only ordering that works
// for both consumers — so it is the contract, not an implementation detail.

export const REPL_KIT_SRC = `
// ---- shared REPL kit (packages/kernel-host/programs/repl-kit.js) -------------
function createRepl(config) {
  var util = require('util');
  var fs = require('fs');

  var prompt1 = config.prompt || '> ';
  var prompt2 = config.contPrompt || '... ';
  var historyFile = config.historyFile || null;
  var historyMax = config.historyMax || 1000;
  var inspectDepth = config.inspectDepth == null ? 2 : config.inspectDepth;
  var identity = function (s) { return s; };
  var transform = config.transform || identity;
  var rewrite = config.rewrite || function (s) { return { code: s, names: [] }; };
  var isIncomplete = config.isIncomplete || function () { return false; };

  var line = '';        // the line being edited
  var pos = 0;          // cursor offset within \`line\`
  var buffer = '';      // accumulated lines of an unfinished statement
  var history = [];
  var histIdx = 0;      // == history.length means "editing a fresh line"
  var editorMode = false; // .editor: collect until Ctrl+D, then run it all
  var closed = false;

  // Load persisted history. A REPL that forgets everything on reload is a worse
  // tool than one that does not offer history at all, and the VFS is mirrored to
  // OPFS (opfs-persistence.js), so this genuinely survives an F5.
  if (historyFile) {
    try {
      var saved = fs.readFileSync(historyFile, 'utf8').split('\\n');
      for (var h = 0; h < saved.length; h++) if (saved[h]) history.push(saved[h]);
      if (history.length > historyMax) history = history.slice(history.length - historyMax);
    } catch (e) { /* first run, or no history yet */ }
    histIdx = history.length;
  }
  var flushHistory = function () {
    if (!historyFile) return;
    try {
      var keep = history.length > historyMax ? history.slice(history.length - historyMax) : history;
      fs.writeFileSync(historyFile, keep.length ? keep.join('\\n') + '\\n' : '');
    } catch (e) { /* a read-only or full VFS must not take the REPL down */ }
  };

  var write = function (s) { process.stdout.write(s); };
  var promptStr = function () { return buffer ? prompt2 : prompt1; };
  var showPrompt = function () { write(promptStr()); };

  // Redraw the line in place: column 0, erase to end, prompt + line, then put the
  // cursor back where it was. Used by every edit that is not a plain append.
  //
  // SINGLE-ROW ONLY. \\r, \\x1b[K and \\x1b[nD all address the current terminal row, so
  // once prompt + line is wider than the terminal the line has wrapped and editing it
  // draws in the wrong place. This is the same limitation the shell's editor has
  // (coreutils.js, runInteractive) and it is inherited from it deliberately: fixing
  // it needs the terminal width, which means tracking SIGWINCH and doing the wrap
  // arithmetic in both editors. Not a new defect, and not a fixed one either.
  var redraw = function () {
    write('\\r\\x1b[K' + promptStr() + line);
    var back = line.length - pos;
    if (back > 0) write('\\x1b[' + back + 'D');
  };
  var setLine = function (s) { line = s; pos = s.length; redraw(); };

  // ---- evaluation -----------------------------------------------------------

  // Global-scope evaluation, on purpose. Each process is its own Worker with its
  // own realm, so the worker's global scope already IS this session's scope — and
  // indirect eval is the one form that reaches it, which is what makes a \`let\`
  // typed on one line visible on the next. \`vm\` would be the wrong tool: its
  // runInNewContext here is a with-scoped Proxy approximation (node/lib/vm.js), not
  // a fresh global, so it would buy isolation we do not want and lose the
  // persistence we do.
  var globalEval = function (src) { return (0, eval)(src); };

  // Pre-create names as global \`var\`s so an assignment inside the async wrapper
  // below still lands on the session. Without this, \`const x = await f()\` would
  // assign a variable scoped to the wrapper and vanish when it resolved.
  var predeclare = function (names) {
    if (!names || !names.length) return;
    try { globalEval('var ' + names.join(',')); } catch (e) { /* not an identifier: let the real eval report it */ }
  };

  var parses = function (src) {
    try { new Function(src); return true; } catch (e) { return false; }
  };
  // Does this parse in EXPRESSION position?
  var isExpression = function (src) { return parses('return (' + src + '\\n);'); };

  // \`{ a: 1 }\` is a block containing a labelled statement to a statement-position
  // parser, and an object literal to an expression-position one; a REPL means the
  // latter. Only a leading \`{\` is ambiguous, which is why that is the whole test —
  // wrapping anything that merely CAN parse as an expression was a bug, because
  // \`function f() {}\` can, and parenthesising it turns the declaration into an
  // expression that binds nothing. \`f\` was then gone on the next line.
  //
  // Still asks the parser before wrapping, so \`{ let x = 1; }\` (a real block, not a
  // valid expression) is left as the block it is.
  var parensWrapped = function (src) {
    if (src.trim().charAt(0) !== '{') return null;
    return isExpression(src) ? '(' + src + '\\n)' : null;
  };

  // This util.inspect returns a TOP-LEVEL string unquoted — see the
  // \`depth === 0 ? value : quoteString(value)\` branch in
  // packages/runtime/node/internal/util/inspect.js. That is the right answer for
  // console.log, and the wrong one for a REPL, where it makes 1 and '1' print
  // identically and \`.length\` the only way to tell them apart. Quote it here
  // rather than changing inspect, which console.log, Buffer, events and assert
  // all share.
  //
  // JSON.stringify does the escaping (control characters, quotes, backslashes);
  // the single-quote preference is Node's, and only applies when the string does
  // not contain one itself.
  var quoteForRepl = function (s) {
    var json = JSON.stringify(s);
    if (s.indexOf("'") >= 0) return json;
    return "'" + json.slice(1, -1).replace(/\\\\"/g, '"') + "'";
  };

  var lastResult;
  var printResult = function (value) {
    lastResult = value;
    try { globalThis._ = value; } catch (e) { /* frozen global: not fatal */ }
    if (value === undefined) return;
    write((typeof value === 'string'
      ? quoteForRepl(value)
      : util.inspect(value, { colors: true, depth: inspectDepth, maxArrayLength: 100 })) + '\\n');
  };
  // Everything below the eval is OUR plumbing, not the user's program, and a
  // ReferenceError for a typo should not answer with ten frames of stream internals
  // (\`at globalEval\`, \`at submitLine\`, \`at Readable.emit\`, \`at addChunk\`…). Cut the
  // stack at the first frame whose function IS the eval, so frames above it — a
  // function the user defined at the prompt, a module they required — survive.
  var trimStack = function (stack) {
    var lines = String(stack).split('\\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) {
      if (/^\\s+at (?:eval|globalEval)\\b/.test(lines[i])) break;
      out.push(lines[i]);
    }
    return out.join('\\n');
  };
  // process.exit() unwinds by THROWING — an ordinary Error carrying a
  // \`__processExit\` property with the code (packages/runtime/builtins/process.js).
  // Every layer that owns that sentinel recognises it by the property and not by its
  // message: the loop's raise/raiseRejection, the runtime's host-realm hooks, and
  // the guest programs that also wrap a whole run (python.js, bun.js) all do exactly
  // this check.
  //
  // A REPL has to as well, because the try/catch around the eval is the widest net
  // in the process: it exists to turn a typo into one line of diagnostic instead of
  // a dead prompt, so it caught the exit too and reported it as the user's error —
  // \`process.exit()\` answered with "Error: process.exit called" and two frames of
  // runtime internals, then drew a fresh prompt on the way out. Node exits silently.
  //
  // Nothing needs to be re-thrown to make the exit happen. exit() calls onExit(code)
  // BEFORE it throws, so the loop is already flagged and drive() will return that
  // code; the throw only unwinds the stack. So the sentinel is recognised, not
  // reported, and no prompt follows it.
  var isExitSentinel = function (e) {
    return e && typeof e === 'object' && e.__processExit !== undefined;
  };

  var printError = function (e) {
    if (config.errorVar) {
      try { globalThis[config.errorVar] = e; } catch (e2) { /* ignore */ }
    }
    // A thrown non-Error has no stack, and \`undefined\` is not a diagnostic.
    // 'Uncaught' is Node's own word for "this came from the prompt".
    var text = e && e.stack ? trimStack(e.stack) : 'Uncaught ' + util.inspect(e);
    if (e && e.stack && !/\\n/.test(text)) text = 'Uncaught ' + text;
    write(text + '\\n');
  };

  var evaluate = function (src, done) {
    var code, names, isStatement;
    try {
      var transformed = transform(src);
      var rewritten = rewrite(transformed);
      code = rewritten.code;
      names = rewritten.names || [];
      isStatement = !!rewritten.statement;
    } catch (e) {
      if (isExitSentinel(e)) return;
      printError(e);
      done();
      return;
    }
    // \`await\` cannot appear at the top level of an indirect eval, so code that uses
    // it runs inside an async arrow. That is also why the declarations were hoisted
    // out to globals first — see predeclare.
    //
    // The code is INLINED into the wrapper, not handed to a nested eval. A nested
    // eval cannot use \`await\` either, even lexically inside an async function
    // (eval code is not an async context), so that shape answered every awaiting
    // line with "await is only valid in async functions".
    var needsAsync = config.hoistAwait !== false && /(^|[^.\\w$])await[\\s(]/.test(code);
    var wrapped = parensWrapped(code);
    var finalCode = wrapped || code;
    if (needsAsync) {
      // An expression can be the arrow's body and keep its value; a statement list
      // has to be a block, and a block's value is undefined — which is what the
      // statement it is (\`const v = await f()\`) evaluates to anyway.
      //
      // Both candidates are parsed AS WRITTEN rather than asking isExpression,
      // because expression-ness here depends on the async context the wrapper
      // supplies: \`await x + 1\` is not an expression inside a plain function, so
      // that test said "statement" and threw the value away.
      var exprForm = '(async () => (' + finalCode + '\\n))()';
      finalCode = parses(exprForm) ? exprForm : '(async () => {' + finalCode + '\\n})()';
    }
    predeclare(names);
    var result;
    try {
      result = globalEval(finalCode);
    } catch (e) {
      // An exit is not a diagnosis, and it is not a turn to finish either: no
      // report, and no done() — the prompt that used to follow it was drawn by a
      // process already on its way out.
      if (isExitSentinel(e)) return;
      printError(e);
      done();
      return;
    }
    if (result && typeof result.then === 'function') {
      result.then(function (v) { printResult(isStatement ? undefined : v); done(); },
                  function (e) {
                    // Same sentinel, one turn later: \`await f(); process.exit(1)\`
                    // rejects the wrapper rather than throwing through it.
                    if (isExitSentinel(e)) return;
                    printError(e);
                    done();
                  });
      return;
    }
    printResult(isStatement ? undefined : result);
    done();
  };

  // ---- dot-commands ---------------------------------------------------------

  var api = {
    write: write,
    get last() { return lastResult; },
    history: history,
    exit: function (code) { flushHistory(); process.exit(code | 0); },
  };

  var builtinCommands = {
    '.help': { help: 'Print this help message', run: function () {
      var names = Object.keys(commands).sort();
      var width = 0;
      for (var w = 0; w < names.length; w++) if (names[w].length > width) width = names[w].length;
      for (var i = 0; i < names.length; i++) {
        var pad = '';
        while (pad.length < width - names[i].length) pad += ' ';
        write(names[i] + pad + '  ' + commands[names[i]].help + '\\n');
      }
      write('\\nPress Ctrl+C to abort the current input, Ctrl+D to exit.\\n');
    } },
    // The three marked \`multiline\` stay reachable from a continuation prompt (see
    // submitLine): leaving, clearing the screen and abandoning the input are the ways
    // OUT of a half-typed statement, and a prompt you cannot get out of is a hang.
    '.exit': { help: 'Exit the REPL', multiline: true, run: function () { write('\\n'); api.exit(0); } },
    '.clear': { help: 'Clear the screen', multiline: true, run: function () { write('\\x1b[H\\x1b[2J\\x1b[3J'); } },
    '.break': { help: 'Abandon the current multi-line input', multiline: true, run: function () { buffer = ''; } },
    '.history': { help: 'Print the command history', run: function () {
      for (var i = 0; i < history.length; i++) write(String(i + 1) + '  ' + history[i] + '\\n');
    } },
    '.editor': { help: 'Enter multi-line editor mode (Ctrl+D to run)', run: function () {
      editorMode = true;
      buffer = '';
      write('// Entering editor mode (Ctrl+D to finish, Ctrl+C to cancel)\\n');
    } },
    '.load': { help: 'Load a file into the session: .load ./x.js', run: function (arg, a) {
      if (!arg) { write('.load requires a file path\\n'); return; }
      var src;
      try { src = fs.readFileSync(require('path').resolve(process.cwd(), arg), 'utf8'); }
      catch (e) { write('.load ' + arg + ': ' + ((e && e.code) || (e && e.message) || e) + '\\n'); return; }
      // Returning the source makes .load a source of INPUT rather than a side
      // effect, so it goes through exactly the transform + eval a typed line does.
      return { evaluate: src };
    } },
    '.save': { help: 'Save the session history to a file: .save ./s.txt', run: function (arg) {
      if (!arg) { write('.save requires a file path\\n'); return; }
      try {
        fs.writeFileSync(require('path').resolve(process.cwd(), arg), history.join('\\n') + '\\n');
        write('Session saved to: ' + arg + '\\n');
      } catch (e) { write('.save ' + arg + ': ' + ((e && e.code) || (e && e.message) || e) + '\\n'); }
    } },
  };
  var commands = {};
  for (var bk in builtinCommands) commands[bk] = builtinCommands[bk];
  if (config.commands) for (var ck in config.commands) commands[ck] = config.commands[ck];

  // ---- the loop -------------------------------------------------------------

  var busy = false;
  var pending = [];
  var sigintPending = false;  // a Ctrl+C that landed mid-eval; see the SIGINT handler

  var finishTurn = function () {
    busy = false;
    // An interrupt that arrived MID-EVAL is answered here, now that there is
    // something true to say about it. See the SIGINT handler for why it cannot be
    // answered at the moment it arrives.
    if (sigintPending) { sigintPending = false; signalStandDown(); }
    if (pending.length) { var next = pending.shift(); submitLine(next); return; }
    showPrompt();
  };

  var submitLine = function (raw) {
    if (busy) { pending.push(raw); return; }

    var trimmed = raw.trim();
    // A dot-command is a command on a fresh line, because mid-statement a \`.length\`
    // on its own line is a property access on a continuation, not a directive.
    //
    // But a few of them are ESCAPE HATCHES, and gating those on an empty buffer made
    // them unreachable exactly when they are needed. \`.break\` is documented as
    // "abandon the current multi-line input", so an empty buffer is the one state in
    // which it has nothing to do — and typing it at a \`... \` prompt appended the
    // text ".break" to the buffer, which is the opposite of the ask.
    //
    // So a command may opt into surviving a continuation with \`multiline: true\`, and
    // one of those is only honoured as a WHOLE line with no argument. That keeps the
    // ambiguity narrow: a fluent chain broken across lines is written \`.clear()\` or
    // \`.exit(1)\`, neither of which matches, while a bare \`.clear\` on its own line at
    // a stuck prompt is overwhelmingly the directive.
    var multilineEscape = !!buffer && commands[trimmed] && commands[trimmed].multiline;
    if ((!buffer || multilineEscape) && trimmed.charAt(0) === '.' && !/^\\.\\d/.test(trimmed)) {
      var sp = trimmed.indexOf(' ');
      var name = sp < 0 ? trimmed : trimmed.slice(0, sp);
      var arg = sp < 0 ? '' : trimmed.slice(sp + 1).trim();
      var cmd = commands[name];
      if (!cmd) {
        write('Invalid REPL keyword: ' + name + '. Try .help\\n');
        finishTurn();
        return;
      }
      var out = cmd.run(arg, api);
      if (out && out.evaluate != null) { busy = true; evaluate(out.evaluate, finishTurn); return; }
      finishTurn();
      return;
    }

    var src = buffer ? buffer + '\\n' + raw : raw;
    if (!src.trim()) { finishTurn(); return; }
    // BEFORE the transform — see the note at the top of this file.
    if (isIncomplete(src)) { buffer = src; finishTurn(); return; }
    buffer = '';
    busy = true;
    evaluate(src, finishTurn);
  };

  var submit = function () {
    write('\\n');
    var raw = line;
    line = ''; pos = 0;
    if (raw.trim() && history[history.length - 1] !== raw) {
      history.push(raw);
      flushHistory();
    }
    histIdx = history.length;
    if (editorMode) { buffer = buffer ? buffer + '\\n' + raw : raw; return; }
    submitLine(raw);
  };

  // ---- key handling ---------------------------------------------------------

  var deleteWordBack = function () {
    if (!pos) return;
    var i = pos;
    while (i > 0 && /\\s/.test(line.charAt(i - 1))) i--;
    while (i > 0 && !/\\s/.test(line.charAt(i - 1))) i--;
    line = line.slice(0, i) + line.slice(pos);
    pos = i;
    redraw();
  };

  var onCtrlD = function () {
    if (editorMode) {
      editorMode = false;
      write('\\n');
      var src = buffer;
      buffer = '';
      if (src.trim()) { busy = true; evaluate(src, finishTurn); } else finishTurn();
      return;
    }
    // Ctrl+D on a non-empty line deletes forward, exactly like the terminal it is
    // imitating; only an empty line means end of input.
    if (line.length) {
      if (pos < line.length) { line = line.slice(0, pos) + line.slice(pos + 1); redraw(); }
      return;
    }
    write('\\n');
    api.exit(0);
  };

  var handleChunk = function (chunk) {
    var s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      // CSI: arrows, Home/End, Delete.
      //
      // A FIXED-WIDTH SKIP, not a real CSI parser, and the difference shows. Each
      // branch advances 2 or 3 characters, so a sequence that is longer leaks its
      // tail into the line: \\x1b[1;5C (Ctrl+Right) inserts ';5C', and an escape
      // SPLIT ACROSS TWO stdin chunks — '\\x1b' arriving alone, then '[A' — is not
      // recognised at all and shows up as '[A'. A correct version would consume
      // through the final byte and keep a partial sequence in a carry buffer across
      // chunks.
      //
      // Left as is on purpose: this is a copy of the shell's editor (coreutils.js,
      // runInteractive), character for character, and the two want the same answer.
      // Fixing it here alone would make the REPL and the shell disagree about a key,
      // which is worse than both being equally limited.
      if (ch === '\\x1b' && s.charAt(i + 1) === '[') {
        var code = s.charAt(i + 2);
        if (code === 'A') { if (histIdx > 0) { histIdx--; setLine(history[histIdx]); } i += 2; continue; }
        if (code === 'B') {
          if (histIdx < history.length - 1) { histIdx++; setLine(history[histIdx]); }
          else if (histIdx < history.length) { histIdx = history.length; setLine(''); }
          i += 2; continue;
        }
        if (code === 'C') { if (pos < line.length) { pos++; write('\\x1b[C'); } i += 2; continue; }
        if (code === 'D') { if (pos > 0) { pos--; write('\\x1b[D'); } i += 2; continue; }
        if (code === 'H') { pos = 0; redraw(); i += 2; continue; }
        if (code === 'F') { pos = line.length; redraw(); i += 2; continue; }
        if (code === '3' && s.charAt(i + 3) === '~') {
          if (pos < line.length) { line = line.slice(0, pos) + line.slice(pos + 1); redraw(); }
          i += 3; continue;
        }
        if (code === '1' && s.charAt(i + 3) === '~') { pos = 0; redraw(); i += 3; continue; }
        if (code === '4' && s.charAt(i + 3) === '~') { pos = line.length; redraw(); i += 3; continue; }
        i += 2; continue;
      }
      if (ch === '\\r' || ch === '\\n') {
        // \\r\\n is one Enter, not two. A terminal sends \\r, a pipe sends \\n, and a
        // Windows-authored file piped in sends both.
        if (ch === '\\r' && s.charAt(i + 1) === '\\n') i++;
        submit();
        continue;
      }
      if (ch === '\\x7f' || ch === '\\b') {
        if (pos > 0) { line = line.slice(0, pos - 1) + line.slice(pos); pos--; redraw(); }
        continue;
      }
      if (ch === '\\x04') { onCtrlD(); continue; }
      if (ch === '\\x03') { abortLine(); continue; }       // only from a pipe; see below
      if (ch === '\\x01') { pos = 0; redraw(); continue; }                 // Ctrl+A
      if (ch === '\\x05') { pos = line.length; redraw(); continue; }       // Ctrl+E
      if (ch === '\\x02') { if (pos > 0) { pos--; write('\\x1b[D'); } continue; }        // Ctrl+B
      if (ch === '\\x06') { if (pos < line.length) { pos++; write('\\x1b[C'); } continue; } // Ctrl+F
      if (ch === '\\x15') { line = line.slice(pos); pos = 0; redraw(); continue; }      // Ctrl+U
      if (ch === '\\x0b') { line = line.slice(0, pos); redraw(); continue; }            // Ctrl+K
      if (ch === '\\x17') { deleteWordBack(); continue; }                               // Ctrl+W
      if (ch === '\\x0c') { write('\\x1b[H\\x1b[2J\\x1b[3J'); redraw(); continue; }     // Ctrl+L
      if (ch === '\\x10') { if (histIdx > 0) { histIdx--; setLine(history[histIdx]); } continue; } // Ctrl+P
      if (ch === '\\x0e') {                                                             // Ctrl+N
        if (histIdx < history.length - 1) { histIdx++; setLine(history[histIdx]); }
        else if (histIdx < history.length) { histIdx = history.length; setLine(''); }
        continue;
      }
      if (ch === '\\x14') {                                                             // Ctrl+T
        if (pos >= 2) {
          line = line.slice(0, pos - 2) + line.charAt(pos - 1) + line.charAt(pos - 2) + line.slice(pos);
          redraw();
        }
        continue;
      }
      if (ch === '\\t') { complete(); continue; }
      if (ch >= ' ') {
        line = line.slice(0, pos) + ch + line.slice(pos);
        pos++;
        // Appending at the end is one character of output; anywhere else has to
        // redraw so the tail shifts and the cursor lands correctly.
        if (pos === line.length) write(ch); else redraw();
      }
    }
  };

  // ---- Tab completion -------------------------------------------------------
  // Property completion, which is what a REPL completes: the text before the last
  // '.' is EVALUATED and its keys are offered. A dot-command line completes against
  // the command names instead.
  var identTail = /[A-Za-z_$][A-Za-z0-9_$]*$/;
  var complete = function () {
    var left = line.slice(0, pos);
    var candidates = [], typed = '';
    if (!buffer && left.charAt(0) === '.' && left.indexOf(' ') < 0) {
      typed = left;
      candidates = Object.keys(commands).filter(function (c) { return c.indexOf(typed) === 0; }).sort();
    } else {
      var dot = left.lastIndexOf('.');
      var m = identTail.exec(left);
      var frag = m ? m[0] : '';
      if (dot >= 0 && dot >= left.length - frag.length - 1) {
        var objSrc = left.slice(0, dot);
        var target;
        try { target = globalEval('(' + objSrc + '\\n)'); } catch (e) { return; }
        if (target == null) return;
        var keys = [];
        try {
          for (var k in target) keys.push(k);
          var own = Object.getOwnPropertyNames(Object(target));
          for (var oi = 0; oi < own.length; oi++) if (keys.indexOf(own[oi]) < 0) keys.push(own[oi]);
        } catch (e) { return; }
        typed = frag;
        candidates = keys.filter(function (c) { return c.indexOf(frag) === 0 && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(c); }).sort();
      } else {
        typed = frag;
        if (!typed) return;
        var globals = [];
        try { for (var g in globalThis) globals.push(g); } catch (e) { /* ignore */ }
        candidates = globals.concat(Object.keys(commands))
          .filter(function (c) { return c.indexOf(typed) === 0 && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(c); })
          .sort();
      }
    }
    if (!candidates.length) return;
    if (candidates.length === 1) {
      var insert = candidates[0].slice(typed.length);
      line = line.slice(0, pos) + insert + line.slice(pos);
      pos += insert.length;
      redraw();
      return;
    }
    var lcp = candidates[0];
    for (var ci = 1; ci < candidates.length; ci++) {
      var other = candidates[ci], j = 0;
      while (j < lcp.length && j < other.length && lcp.charAt(j) === other.charAt(j)) j++;
      lcp = lcp.slice(0, j);
      if (!lcp) break;
    }
    if (lcp.length > typed.length) {
      var ins = lcp.slice(typed.length);
      line = line.slice(0, pos) + ins + line.slice(pos);
      pos += ins.length;
      redraw();
      return;
    }
    write('\\n' + candidates.join('  ') + '\\n');
    redraw();
  };

  // ---- interrupt ------------------------------------------------------------

  var abortLine = function () {
    line = ''; pos = 0; buffer = ''; editorMode = false;
    // Lines typed while an eval was running were queued, and an interrupt means the
    // user no longer wants them. Left queued, they ran a turn later — after the
    // Ctrl+C that was meant to call the whole thing off.
    pending.length = 0;
    histIdx = history.length;
    write('\\n');
    if (!busy) showPrompt();
  };

  var signalStandDown = function () {
    if (typeof globalThis.__ocSignalHandled === 'function') globalThis.__ocSignalHandled('SIGINT');
  };

  // Ctrl+C is a SIGNAL here, not a byte: the interactive \`sh\` converts \\x03 into a
  // SIGINT for the whole foreground job and forwards nothing (so the \\x03 branch
  // above only ever fires for a piped stdin). Two halves are needed:
  //   * a listener, which is what tells the kernel not to apply the default action
  //     (terminate) to this process;
  //   * __ocSignalHandled, which stands the force-kill window down. That window
  //     exists for a guest that catches a signal and then never leaves, and a REPL
  //     back at its prompt is the opposite of that — but it is opt-in, so a REPL
  //     that stayed without saying so would be collected on the next Ctrl+C.
  //
  // THE STAND-DOWN IS CONDITIONAL, and that condition is the whole point of it. It
  // used to be unconditional, which handed the kernel a guarantee this code was in
  // no position to make: \`await new Promise(() => {})\` leaves \`busy\` true forever,
  // and standing down cleared proc.sigUnhandled and the grace timer every time — so
  // the escalation in Kernel#signal never fired and a wedged REPL could not be
  // killed from the terminal at all. Ctrl+C is the only way a user has to end a
  // foreground child (coreutils has no \`kill\` builtin), so that took the tab with it.
  //
  // Answering "not yet" and leaving it there is not right either, because an eval
  // may be merely SLOW rather than stuck: never standing down would let the grace
  // timer collect a healthy REPL seconds after a Ctrl+C it had already recovered
  // from. So the interrupt is REMEMBERED and answered from finishTurn, at the moment
  // the prompt actually comes back:
  //   * back at the prompt inside the window -> stood down there, process lives;
  //   * never comes back, or comes back too late -> the window expires and the kernel
  //     collects it, which is exactly what that window is for. Note the limit this
  //     puts on the whole mechanism: it rescues an eval that finishes within
  //     signalGraceMs, not a slow one in general. An eval that runs longer than the
  //     grace is collected at the grace mark whether or not it was healthy.
  //   * Ctrl+C again while still stuck        -> sigUnhandled is still set, so the
  //     kernel reads it as the repeat it is and finalizes immediately.
  process.on('SIGINT', function () {
    abortLine();
    if (busy) { sigintPending = true; return; }
    signalStandDown();
  });

  // ---- errors that arrive off the stack -------------------------------------

  // An error thrown from a callback the user armed at the prompt — a setTimeout body,
  // a rejection nobody caught — does NOT pass through the try/catch around the eval,
  // because by the time it fires that call has long returned. With no listener the
  // loop's default applies: report and exit 1. For a script that is right; for a
  // prompt it is not, and it read badly too, because the report came from the loop
  // rather than from here and so arrived with the internal frames (at runCallback,
  // at runDueTimers, at Object.drive) that printError exists to strip:
  //
  //   > setTimeout(() => { throw new Error('x') }, 300)
  //   Error: x
  //       at eval (...)
  //       at runCallback (.../loop.js:206:7)     <- ours, not theirs
  //       ...and the session is gone
  //
  // A REPL is a place to make mistakes, so a mistake must not end the session.
  // Registering these listeners is what tells the loop that (see raise() and
  // raiseRejection() in packages/runtime/loop.js: a listener is emitted to and the
  // default exit is skipped), and it reports through the same path a synchronous
  // throw takes, so the two look alike.
  //
  // THE COST, stated plainly: while this prompt is open, an uncaught async error is
  // no longer fatal to the process, including one raised by our own plumbing. That is
  // the trade Node's REPL makes as well, and it is scoped to the prompt.
  var reportAsync = function (e) {
    // The loop checks for the exit sentinel before it ever reaches a listener, so
    // this is belt and braces — but it is the same net, and it should not report an
    // exit either.
    if (isExitSentinel(e)) return;
    write('\\n');
    printError(e);
    // redraw() rather than showPrompt(), so a half-typed line survives being
    // interrupted by a report. If an eval is running, finishTurn owns the prompt.
    if (!busy) redraw();
  };
  process.on('uncaughtException', reportAsync);
  process.on('unhandledRejection', reportAsync);

  // ---- start ----------------------------------------------------------------

  if (config.banner) write(config.banner + '\\n');
  // Recorded, not enforced: there is no cooked mode under us to leave. It is set
  // because tools branch on isRaw, and because it documents the intent.
  if (process.stdin.setRawMode) process.stdin.setRawMode(true);
  process.stdin.on('data', handleChunk);
  // 'end' is a closed pipe, i.e. \`echo 1+1 | node\`: run what is buffered and go.
  process.stdin.on('end', function () {
    if (closed) return;
    closed = true;
    if (line.length) submit();
    write('\\n');
    api.exit(0);
  });
  // resume() refs the loop like an open handle, which is what lets an idle prompt
  // wait instead of the process going quiescent and exiting (see stdinLiveness in
  // packages/runtime/index.js).
  process.stdin.resume();
  showPrompt();
  return api;
}

// ---- shared REPL semantics helpers ------------------------------------------
// Used by the consumers' \`isIncomplete\` / \`rewrite\`. Here rather than in each
// program because "is this statement finished?" has one answer for JavaScript.

// Scan for an unclosed (, [, {, backtick or quote — string/template/comment aware,
// because a brace inside a string is not a brace. An unterminated string or block
// comment is the other reason a line continues.
//
// A TEMPLATE LITERAL IS A MODE, NOT A BRACKET. It used to be counted as one, and
// only in the opening direction — every backtick did depth++ with no branch that
// ever decremented — so a COMPLETE template raised depth by two and this answered
// "incomplete" forever. Every one of \`hello\`, console.log(\`hi\`) and
// const s = \`a\${1}b\` wedged both REPLs at the continuation prompt with no way out
// but Ctrl+C: a silent hang on everyday syntax.
//
// Counting it as a bracket was wrong in the other direction too. Inside a template
// the text is TEXT, so the brace in \`a { b\` is not an open brace. Hence a mode
// stack: the top entry says whether we are reading code or template text, and a
// \${…} substitution pushes back into code — which is what makes nested templates
// and \${ xs.map(x => \`\${x}\`) } come out right.
function replIncomplete(src) {
  var stack = [];   // '(' '[' '{' = bracket, backtick = template text, '$' = a \${…}
  var i = 0, n = src.length;
  var q = null, inLine = false, inBlock = false;
  for (; i < n; i++) {
    var c = src.charAt(i);
    if (inLine) { if (c === '\\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && src.charAt(i + 1) === '/') { inBlock = false; i++; } continue; }
    if (q) {
      if (c === '\\\\') { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    // Template TEXT: only an escape, the closing backtick and \${ mean anything.
    if (stack.length && stack[stack.length - 1] === '\\x60') {
      if (c === '\\\\') { i++; continue; }
      if (c === '\\x60') { stack.pop(); continue; }
      if (c === '$' && src.charAt(i + 1) === '{') { stack.push('$'); i++; continue; }
      continue;
    }
    if (c === '/' && src.charAt(i + 1) === '/') { inLine = true; i++; continue; }
    if (c === '/' && src.charAt(i + 1) === '*') { inBlock = true; i++; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '\\x60') { stack.push('\\x60'); continue; }
    if (c === '(' || c === '[' || c === '{') { stack.push(c); continue; }
    // A '}' closes either a block or a \${…}, and popping handles both. An unmatched
    // closer pops nothing, so \`1+1)\` stays "complete" and the evaluator reports it
    // — the same answer the old negative depth gave.
    if (c === ')' || c === ']' || c === '}') { stack.pop(); continue; }
  }
  return stack.length > 0 || q !== null || inBlock;
}

// Rewrite top-level \`let\`/\`const\`/\`class\` into assignments to a hoisted \`var\`, and
// report the names, which is what makes a declaration outlive the line it was typed
// on. Bun's REPL documents doing exactly this ("const and let declarations are
// hoisted to var"), and it is not optional for either consumer:
//
//   THIS IS NOT A STYLE CHOICE. An indirect eval evaluates in global scope, but only
//   \`var\` and function declarations reach the global VARIABLE environment. Per spec
//   an eval gets a fresh LexicalEnvironment of its own, so \`let\`, \`const\` and
//   \`class\` are declared into it and thrown away when the call returns:
//
//     (0,eval)('let b = 2'); (0,eval)('b')   // ReferenceError: b is not defined
//     (0,eval)('var a = 1');  (0,eval)('a')   // 1
//
//   Real Node's REPL escapes this with vm.runInThisContext, whose script-level
//   lexical bindings do persist — a V8 context API that node/lib/vm.js cannot
//   reproduce here (it is a \`new Function\` approximation, see its header). So the
//   choice is between hoisting and a REPL where \`let x = 5\` silently does nothing,
//   and only one of those is a REPL. The cost is that a redeclaration is allowed
//   where real Node reports one — which is Bun's behaviour, and is documented in
//   \`.help\` rather than left to be discovered.
//
// A LEXER, NOT A PARSER, and deliberately conservative: only a declaration at the
// very start of the source or right after a \`;\`/\`}\`/newline at brace depth 0 is
// touched, so a \`const\` inside a function body or a block is left exactly as
// written. Destructuring patterns are reported by scanning the identifiers in the
// pattern, which is why \`const { a, b } = o\` persists both names.
//
// KNOWN LIMIT: it has no notion of a REGEX LITERAL, so a quote inside one reads as
// the start of a string. A regex holding an odd number of quotes therefore swallows
// the rest of the input:
//
//   const re = /['"]/; const b = 2
//     ->  re = /['"]/; const b = 2        names = ["re"]
//
// \`b\` keeps its \`const\`, so it lives in the eval's own lexical environment and is
// GONE on the next line with nothing reported — the code parses and runs, only the
// state fails to persist. Telling a regex from a division needs the preceding token,
// i.e. a real tokenizer, and the trigger needs a quote-bearing regex plus a second
// declaration in one input. Recorded rather than fixed: this is the shape of bug to
// suspect if a variable ever fails to survive a line, and the fix is to type the
// declaration on its own line.
function replHoistDeclarations(src) {
  var names = [];
  var out = '';
  var statement = false;   // the whole input was a declaration -> completion value undefined
  var i = 0, n = src.length;
  var depth = 0, atStatementStart = true;
  var q = null, inLine = false, inBlock = false;
  while (i < n) {
    var c = src.charAt(i);
    if (inLine) { out += c; if (c === '\\n') { inLine = false; atStatementStart = true; } i++; continue; }
    if (inBlock) { out += c; if (c === '*' && src.charAt(i + 1) === '/') { out += '/'; i += 2; inBlock = false; } else i++; continue; }
    if (q) { out += c; if (c === '\\\\') { out += src.charAt(i + 1); i += 2; continue; } if (c === q) q = null; i++; continue; }
    if (c === '/' && src.charAt(i + 1) === '/') { inLine = true; out += '//'; i += 2; continue; }
    if (c === '/' && src.charAt(i + 1) === '*') { inBlock = true; out += '/*'; i += 2; continue; }
    if (c === '"' || c === "'" || c === '\\x60') { q = c; out += c; i++; atStatementStart = false; continue; }
    if (c === '(' || c === '[') { depth++; out += c; i++; atStatementStart = false; continue; }
    if (c === ')' || c === ']') { depth--; out += c; i++; atStatementStart = false; continue; }
    if (c === '{') { depth++; out += c; i++; atStatementStart = true; continue; }
    if (c === '}') { depth--; out += c; i++; atStatementStart = true; continue; }
    if (c === ';') { out += c; i++; atStatementStart = true; continue; }
    if (c === '\\n') { out += c; i++; atStatementStart = true; continue; }
    if (c === ' ' || c === '\\t' || c === '\\r') { out += c; i++; continue; }
    if (atStatementStart && depth === 0) {
      // \`class C { … }\` is lexical too, so it needs the same treatment — but as an
      // assignment of a class EXPRESSION, keeping the inner name so C.name and
      // recursive references inside the body still read 'C'.
      var cls = /^class\\s+([A-Za-z_$][A-Za-z0-9_$]*)/.exec(src.slice(i));
      if (cls) {
        if (names.indexOf(cls[1]) < 0) names.push(cls[1]);
        out += cls[1] + ' = class ' + cls[1];
        i += cls[0].length;
        atStatementStart = false;
        statement = true;
        continue;
      }
      var kw = /^(let|const|var)[\\s([{]/.exec(src.slice(i));
      if (kw) {
        var kwLen = kw[1].length;
        // Find where this declaration ends: a ';' or newline at the depth it
        // started, so \`const a = { x: 1 }\` is one declaration and not two.
        var j = i + kwLen, d2 = 0, q2 = null, end = n;
        for (; j < n; j++) {
          var c2 = src.charAt(j);
          if (q2) { if (c2 === '\\\\') { j++; continue; } if (c2 === q2) q2 = null; continue; }
          if (c2 === '"' || c2 === "'" || c2 === '\\x60') { q2 = c2; continue; }
          if (c2 === '(' || c2 === '[' || c2 === '{') { d2++; continue; }
          if (c2 === ')' || c2 === ']' || c2 === '}') { d2--; continue; }
          if (d2 === 0 && (c2 === ';' || c2 === '\\n')) { end = j; break; }
        }
        var body = src.slice(i + kwLen, end);
        // The declared names: identifiers in binding position. For a plain
        // \`a = 1, b = 2\` those are the heads; for a pattern they are every
        // identifier that is not a property key being renamed away.
        var ids = replBindingNames(body);
        for (var k = 0; k < ids.length; k++) if (names.indexOf(ids[k]) < 0) names.push(ids[k]);
        // A bare \`let a;\` has nothing to assign, so emitting \`a;\` would be an
        // expression statement referencing it — harmless, and simpler than
        // dropping the statement and having to fix up the surrounding text.
        var assigns = body.trim();
        // A destructuring assignment needs parentheses once the keyword is gone,
        // or \`{a} = o\` parses as a block.
        if (/^[{[]/.test(assigns)) out += '(' + assigns + ')';
        else out += assigns;
        // A declaration evaluates to undefined in every REPL (real Node and real
        // Bun both answer \`undefined\` to \`const g = "hi"\`), but rewriting it into an
        // assignment turns it into an expression whose value is the right-hand side
        // — so \`let x = 5\` would answer 5. Only suppress it when the declaration IS
        // the whole input: \`const a = 1; a + 1\` still has a value, and it is 2.
        if (/^[\\s;]*$/.test(src.slice(end))) statement = true;
        i = end;
        atStatementStart = false;
        continue;
      }
    }
    out += c;
    i++;
    atStatementStart = false;
  }
  return { code: out, names: names, statement: statement };
}

// The identifiers a declaration binds. \`{ a, b: c }\` binds a and c; \`[x, , y]\`
// binds x and y; \`a = 1\` binds a. Anything after a top-level \`=\` is an
// initialiser, not a binding, so it is skipped.
function replBindingNames(decl) {
  var names = [];
  var i = 0, n = decl.length, depth = 0, q = null;
  var seenColonAt = -1;
  var pendingKey = null;
  var skipToDepth = -1;
  while (i < n) {
    var c = decl.charAt(i);
    if (q) { if (c === '\\\\') i++; else if (c === q) q = null; i++; continue; }
    if (c === '"' || c === "'" || c === '\\x60') { q = c; i++; continue; }
    if (skipToDepth >= 0) {
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') { depth--; if (depth < skipToDepth) skipToDepth = -1; }
      else if (depth === skipToDepth && c === ',') skipToDepth = -1;
      i++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') { depth++; i++; pendingKey = null; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; if (pendingKey) { names.push(pendingKey); pendingKey = null; } i++; continue; }
    if (c === ':') { pendingKey = null; seenColonAt = depth; i++; continue; }
    if (c === ',') { if (pendingKey) { names.push(pendingKey); pendingKey = null; } if (seenColonAt === depth) seenColonAt = -1; i++; continue; }
    if (c === '=') {
      if (pendingKey) { names.push(pendingKey); pendingKey = null; }
      // \`= <initialiser>\` — skip it. At depth 0 that is the whole rest of this
      // declarator; deeper it is a pattern default, which ends at the next comma.
      skipToDepth = depth;
      i++;
      continue;
    }
    var idm = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(decl.slice(i));
    if (idm) {
      pendingKey = idm[0];
      i += idm[0].length;
      continue;
    }
    i++;
  }
  if (pendingKey) names.push(pendingKey);
  return names;
}

// Rewrite \`import\` statements into dynamic \`import()\`, which is how a REPL can
// accept module syntax at all: a statement-level \`import\` is only legal in a
// module, and an eval is never one. Bun's REPL documents the same conversion.
//
// Four shapes, which is what covers the specifiers people actually type:
//   import "x"                 -> await import("x")
//   import d from "x"          -> { default: d } = await import("x")
//   import * as ns from "x"    -> ns = await import("x")
//   import { a, b as c } from "x" -> { a, b: c } = await import("x")
// A default combined with named/namespace bindings is merged into one pattern.
//
// MATCHED OVER THE WHOLE SOURCE, not line by line. This used to run per line with a
// ^...$ anchor, so the most common shape of all — the one people paste — never
// matched:
//
//   import {
//     basename
//   } from "path"
//
// ...and isIncomplete actively HERDS people into writing it that way, because
// \`import {\` has an unclosed brace and so opens a continuation prompt. What
// reached the evaluator was a statement-level import, i.e. "Cannot use import
// statement outside a module".
//
// The end-of-line lookahead is load-bearing for the other half of that bug. With a
// non-greedy specifier and a $ anchor, two imports on one line matched as ONE and
// everything between the quotes was swallowed into the module name:
//
//   import a from "x"; import b from "y"
//     -> ({default: a} = await import("x...; import b from ...y"))
//
// Syntactically fine, so it failed at run time against a nonsense specifier while
// \`import b\` vanished without a word. Requiring the statement to END at its
// specifier means a line like that is simply not recognised — and an unrecognised
// import is left alone for the evaluator to report, which is what the note further
// down has always claimed this function does.
function replRewriteImports(src) {
  var names = [];
  var rewrote = 0;
  var consumed = 0;   // source characters turned into imports, for \`statement\`

  var FROM = /(^|\\n)([ \\t]*)import\\s+([\\s\\S]*?)\\s+from[ \\t]*(['"])([^'"]*)\\4[ \\t]*;?[ \\t]*(?=\\r?\\n|$)/g;
  var BARE = /(^|\\n)([ \\t]*)import[ \\t]*(['"])([^'"]*)\\3[ \\t]*;?[ \\t]*(?=\\r?\\n|$)/g;

  var out = src.replace(FROM, function (whole, lead, indent, clauseRaw, quote, spec) {
    var clause = clauseRaw.trim();
    var parts = [];
    var found = [];
    var built = null;

    var star = /^(?:([A-Za-z_$][A-Za-z0-9_$]*)\\s*,\\s*)?\\*\\s+as\\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(clause);
    if (star) {
      if (star[1]) { parts.push('default: ' + star[1]); found.push(star[1]); }
      found.push(star[2]);
      built = (parts.length ? '({' + parts.join(', ') + '} = ' : '') + star[2] +
        ' = await import(' + JSON.stringify(spec) + ')' + (parts.length ? ')' : '');
    }
    if (built === null) {
      var braced = /^(?:([A-Za-z_$][A-Za-z0-9_$]*)\\s*,\\s*)?\\{([\\s\\S]*)\\}$/.exec(clause);
      if (braced) {
        if (braced[1]) { parts.push('default: ' + braced[1]); found.push(braced[1]); }
        var inner = braced[2].split(',');
        var shapeOk = true;
        for (var k = 0; k < inner.length; k++) {
          var one = inner[k].trim();
          if (!one) continue;
          var as = /^([A-Za-z_$][A-Za-z0-9_$]*)\\s+as\\s+([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(one);
          if (as) { parts.push(as[1] + ': ' + as[2]); found.push(as[2]); continue; }
          // Only a plain identifier is safe to copy through verbatim. Anything else
          // — a string-literal key, a stray brace — would be pasted into the pattern
          // unchecked, which is the "subtly wrong rewrite" this refuses to emit.
          if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(one)) { parts.push(one); found.push(one); continue; }
          shapeOk = false;
          break;
        }
        if (shapeOk) built = '({' + parts.join(', ') + '} = await import(' + JSON.stringify(spec) + '))';
      }
    }
    if (built === null && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(clause)) {
      found.push(clause);
      built = '({default: ' + clause + '} = await import(' + JSON.stringify(spec) + '))';
    }
    // Something we do not recognise: leave it alone rather than emit a rewrite that
    // is subtly wrong. The eval will report it honestly.
    if (built === null) return whole;

    for (var f = 0; f < found.length; f++) if (names.indexOf(found[f]) < 0) names.push(found[f]);
    rewrote++;
    consumed += whole.length - lead.length;
    // The trailing ';' is not decoration. Every rewrite starts with '(' and most end
    // with ')', so two imports on consecutive lines became ONE expression: automatic
    // semicolon insertion does not fire before a '(', and
    //   ({default: a} = await import("x"))
    //   ({default: b} = await import("y"))
    // parses as the first calling the second. That is a TypeError at run time, from
    // source the user never wrote.
    return lead + indent + built + ';';
  });

  out = out.replace(BARE, function (whole, lead, indent, quote, spec) {
    rewrote++;
    consumed += whole.length - lead.length;
    return lead + indent + 'await import(' + JSON.stringify(spec) + ');';
  });

  // An input that is nothing but imports evaluates to undefined, the way the
  // statement it stands in for does. Without this the rewritten assignment's value
  // — the whole module namespace — was printed, so a one-line
  // \`import { basename } from 'path'\` answered with every export of path.
  //
  // "Nothing but imports" is measured against the ORIGINAL source: what the two
  // passes claimed, plus whitespace and semicolons, has to account for all of it.
  var leftover = src.length - consumed;
  return { code: out, names: names, statement: rewrote > 0 && leftover <= (src.match(/[\\s;]/g) || []).length };
}
`;
