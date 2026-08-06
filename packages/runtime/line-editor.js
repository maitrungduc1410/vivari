// The interactive line editor, as a runtime module.
//
// WHY IT LIVES HERE. There are now three places that want to read an edited line
// from a terminal: the shell's own prompt (kernel-host/coreutils.js,
// runInteractive), the node/bun REPLs (kernel-host/programs/repl-kit.js) and
// `readline` (node/lib/readline.js). The first two are GUEST SOURCE — text embedded
// into a program string — while readline is a runtime builtin, and there is no
// module path from a program string into a builtin. The editor therefore belongs on
// the runtime side, which every one of the three can reach: builtins by importing
// it, guest programs through the global the runtime installs.
//
// This lands with readline as its first consumer. The REPL kit keeps its own copy
// for now and switches over next, because it is a file that has already been through
// review twice and the safe order is to land the shared editor WITH a consumer and
// tests before moving the one that works.
//
// The key table is deliberately the same as those two editors', down to the
// limitations: a fixed-width CSI skip rather than a real parser (so \x1b[1;5C leaks
// ';5C' and an escape split across two stdin chunks is not recognised), and
// single-row redraw (so a line wider than the terminal draws in the wrong place,
// which needs the width and SIGWINCH to fix). Those are not defended as good — they
// are inherited on purpose, because an editor that disagreed with the shell about a
// keystroke would be worse than one that is equally limited.

/**
 * Read edited lines from a stream.
 *
 * @param {object} opts
 *   input        Readable to read keystrokes from (a TTY-ish process.stdin).
 *   output       Writable for the prompt, the echo and the redraws. May be null,
 *                which turns the editor into a silent line splitter.
 *   getPrompt()  The prompt to draw. A function, not a string, because a consumer
 *                that continues a statement across lines shows a different one.
 *   onLine(s)    A completed line, without its terminator.
 *   onEOF()      Ctrl+D on an EMPTY line — end of input.
 *   onSigint()   \x03 arrived as a BYTE, which only happens on a piped stdin; a
 *                real Ctrl+C at an interactive prompt is a signal (see repl-kit).
 *   completer(line, pos)  Optional; returns { matches, prefix } for Tab.
 *   echo         false hides typed characters (password prompts). The line is still
 *                edited and returned, just never drawn.
 *   history      Optional array to seed from; kept up to date in place.
 *   historyMax   Trim to this many entries (default 1000).
 *   onHistory(h) Called after a line is added, so a consumer can persist it.
 */
export function createLineEditor(opts) {
  const input = opts.input;
  const output = opts.output || null;
  const getPrompt = opts.getPrompt || (() => "");
  const onLine = opts.onLine || (() => {});
  const onEOF = opts.onEOF || (() => {});
  const onSigint = opts.onSigint || (() => {});
  const completer = opts.completer || null;
  const historyMax = opts.historyMax || 1000;
  const onHistory = opts.onHistory || (() => {});

  let echo = opts.echo !== false;
  let line = "";
  let pos = 0; // cursor offset within `line`
  let history = opts.history || [];
  let histIdx = history.length; // == history.length means "editing a fresh line"
  let attached = false;
  let paused = false;

  const write = (s) => {
    if (output && output.write) output.write(s);
  };
  const showPrompt = () => write(getPrompt());

  // Redraw in place: column 0, erase to end, prompt + line, cursor back where it
  // was. Every edit that is not a plain append needs this. Under `echo: false` the
  // line must not appear, so only the prompt is redrawn.
  const redraw = () => {
    if (!echo) {
      write("\r\x1b[K" + getPrompt());
      return;
    }
    write("\r\x1b[K" + getPrompt() + line);
    const back = line.length - pos;
    if (back > 0) write("\x1b[" + back + "D");
  };
  const setLine = (s) => {
    line = s;
    pos = s.length;
    redraw();
  };

  const pushHistory = (raw) => {
    if (raw.trim() && history[history.length - 1] !== raw) {
      history.push(raw);
      if (history.length > historyMax) history.splice(0, history.length - historyMax);
      onHistory(history);
    }
    histIdx = history.length;
  };

  // Returns whatever onLine returned, so feed() can learn that the consumer wants no
  // more input for now — see the carry note there.
  const submit = () => {
    write("\n");
    const raw = line;
    line = "";
    pos = 0;
    pushHistory(raw);
    return onLine(raw);
  };

  const deleteWordBack = () => {
    if (!pos) return;
    let i = pos;
    while (i > 0 && /\s/.test(line.charAt(i - 1))) i--;
    while (i > 0 && !/\s/.test(line.charAt(i - 1))) i--;
    line = line.slice(0, i) + line.slice(pos);
    pos = i;
    redraw();
  };

  const onCtrlD = () => {
    // On a non-empty line Ctrl+D deletes forward, exactly like the terminal it is
    // imitating; only an empty line means end of input.
    if (line.length) {
      if (pos < line.length) {
        line = line.slice(0, pos) + line.slice(pos + 1);
        redraw();
      }
      return;
    }
    onEOF();
  };

  const complete = () => {
    if (!completer) return;
    let r;
    try {
      r = completer(line, pos);
    } catch {
      return; // a completer that throws must not take the prompt down
    }
    if (!r || !r.matches || !r.matches.length) return;
    const prefix = r.prefix == null ? "" : r.prefix;
    if (r.matches.length === 1) {
      const add = r.matches[0].slice(prefix.length);
      line = line.slice(0, pos) + add + line.slice(pos);
      pos += add.length;
      redraw();
      return;
    }
    write("\n" + r.matches.join("  ") + "\n");
    redraw();
  };

  const feed = (chunk) => {
    const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (let i = 0; i < s.length; i++) {
      const ch = s.charAt(i);
      // CSI: arrows, Home/End, Delete. A fixed-width skip — see the header.
      if (ch === "\x1b" && s.charAt(i + 1) === "[") {
        const code = s.charAt(i + 2);
        if (code === "A") { if (histIdx > 0) { histIdx--; setLine(history[histIdx]); } i += 2; continue; }
        if (code === "B") {
          if (histIdx < history.length - 1) { histIdx++; setLine(history[histIdx]); }
          else if (histIdx < history.length) { histIdx = history.length; setLine(""); }
          i += 2; continue;
        }
        if (code === "C") { if (pos < line.length) { pos++; if (echo) write("\x1b[C"); } i += 2; continue; }
        if (code === "D") { if (pos > 0) { pos--; if (echo) write("\x1b[D"); } i += 2; continue; }
        if (code === "H") { pos = 0; redraw(); i += 2; continue; }
        if (code === "F") { pos = line.length; redraw(); i += 2; continue; }
        if (code === "3" && s.charAt(i + 3) === "~") {
          if (pos < line.length) { line = line.slice(0, pos) + line.slice(pos + 1); redraw(); }
          i += 3; continue;
        }
        if (code === "1" && s.charAt(i + 3) === "~") { pos = 0; redraw(); i += 3; continue; }
        if (code === "4" && s.charAt(i + 3) === "~") { pos = line.length; redraw(); i += 3; continue; }
        i += 2; continue;
      }
      if (ch === "\r" || ch === "\n") {
        // \r\n is one Enter, not two. A terminal sends \r, a pipe sends \n, and a
        // Windows-authored file piped in sends both.
        if (ch === "\r" && s.charAt(i + 1) === "\n") i++;
        const more = submit();
        // The rest of this chunk may not be ours. A consumer that reads ONE line at a
        // time — rl.question, and so every scaffolder — has no reader left the instant
        // its line is delivered, and the next question is asked a turn later. Feeding
        // the remainder on regardless is what made three answers PASTED as one chunk
        // (which is what a paste into xterm produces) answer only the first question
        // and then throw the other two away. So onLine returning false, or closing us,
        // means: hold the tail for whoever reads next.
        if (more === false || !attached) {
          pushBack(s.slice(i + 1));
          return;
        }
        continue;
      }
      if (ch === "\x7f" || ch === "\b") {
        if (pos > 0) { line = line.slice(0, pos - 1) + line.slice(pos); pos--; redraw(); }
        continue;
      }
      if (ch === "\x04") { onCtrlD(); if (!attached) { pushBack(s.slice(i + 1)); return; } continue; }
      if (ch === "\x03") { onSigint(); continue; } // only from a pipe; see the header
      if (ch === "\x01") { pos = 0; redraw(); continue; }                            // Ctrl+A
      if (ch === "\x05") { pos = line.length; redraw(); continue; }                   // Ctrl+E
      if (ch === "\x02") { if (pos > 0) { pos--; if (echo) write("\x1b[D"); } continue; }        // Ctrl+B
      if (ch === "\x06") { if (pos < line.length) { pos++; if (echo) write("\x1b[C"); } continue; } // Ctrl+F
      if (ch === "\x15") { line = line.slice(pos); pos = 0; redraw(); continue; }     // Ctrl+U
      if (ch === "\x0b") { line = line.slice(0, pos); redraw(); continue; }           // Ctrl+K
      if (ch === "\x17") { deleteWordBack(); continue; }                              // Ctrl+W
      if (ch === "\x0c") { write("\x1b[H\x1b[2J\x1b[3J"); redraw(); continue; }       // Ctrl+L
      if (ch === "\x10") { if (histIdx > 0) { histIdx--; setLine(history[histIdx]); } continue; } // Ctrl+P
      if (ch === "\x0e") {                                                            // Ctrl+N
        if (histIdx < history.length - 1) { histIdx++; setLine(history[histIdx]); }
        else if (histIdx < history.length) { histIdx = history.length; setLine(""); }
        continue;
      }
      if (ch === "\x14") {                                                            // Ctrl+T
        if (pos >= 2) {
          line = line.slice(0, pos - 2) + line.charAt(pos - 1) + line.charAt(pos - 2) + line.slice(pos);
          redraw();
        }
        continue;
      }
      if (ch === "\t") { complete(); continue; }
      if (ch >= " ") {
        line = line.slice(0, pos) + ch + line.slice(pos);
        pos++;
        // Appending at the end is one character of output; anywhere else has to
        // redraw so the tail shifts and the cursor lands correctly.
        if (!echo) continue;
        if (pos === line.length) write(ch);
        else redraw();
      }
    }
  };

  // Keystrokes that arrived in the same chunk as the Enter that detached us. A
  // scaffolder that asks five questions in a row is answered by five separate
  // editors, and a user who pasted all five answers at once sent them in ONE chunk —
  // so the tail has to be held for the next reader instead of dropped on the floor.
  let carry = "";
  const pushBack = (rest) => {
    if (rest) carry += rest;
  };
  const takeCarry = () => {
    const c = carry;
    carry = "";
    return c;
  };

  const onData = (chunk) => {
    if (paused) return;
    feed(chunk);
  };
  const onEnd = () => {
    if (attached) onEOF();
  };

  const attach = () => {
    if (attached) return;
    attached = true;
    if (input.setRawMode) input.setRawMode(true);
    input.on("data", onData);
    input.on("end", onEnd);
    // resume() refs the loop like an open handle, which is what lets a program
    // sitting at a prompt wait for input instead of falling off the end and exiting.
    if (input.resume) input.resume();
  };
  const detach = () => {
    if (!attached) return;
    attached = false;
    if (input.off) input.off("data", onData);
    else if (input.removeListener) input.removeListener("data", onData);
    if (input.off) input.off("end", onEnd);
    else if (input.removeListener) input.removeListener("end", onEnd);
  };

  return {
    attach,
    detach,
    feed,
    showPrompt,
    redraw,
    write,
    setLine,
    pushBack,
    takeCarry,
    get line() { return line; },
    get cursor() { return pos; },
    get history() { return history; },
    setHistory(h) { history = h || []; histIdx = history.length; },
    setEcho(on) { echo = !!on; },
    resetLine() { line = ""; pos = 0; histIdx = history.length; },
    pause() { paused = true; },
    resume() { paused = false; },
    isAttached() { return attached; },
  };
}
