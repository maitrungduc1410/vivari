// In-guest CDP Debugger backend for Python: breakpoints, stepping and variables
// in a .py file, in the Studio's existing debug UI.
//
// The frontend half of this already exists and is not Node-specific. The studio
// speaks the Chrome DevTools Protocol (packages/studio/src/vv/debug-session.ts),
// keeps breakpoints per VFS path, and renders whatever `Debugger.paused` gives
// it. So the whole job here is to be a second backend that speaks the same
// protocol as packages/runtime/debugger.js, over the same transport, for a
// language it knows nothing about. Nothing in the studio changed.
//
// WHY THIS IS A SEPARATE BACKEND rather than a branch inside that one. The Node
// backend exists because JS in a Web Worker has no inspector to talk to, so it
// weaves probes into the guest's source with acorn and keeps a shadow call
// stack. Python needs none of that: CPython has had a debugging interface since
// forever, and the frames are real. What the two share is the protocol and the
// transport, and those are exactly what is reused.
//
// WHY sys.monitoring AND NOT sys.settrace. This is the difference between a
// debugger you can leave on and one you cannot. Measured here on a 300k-iteration
// loop: 22ms untraced, 217ms under a sys.settrace hook that does nothing but a
// dict lookup — a debugger that makes the program 10x slower changes what you
// are debugging. PEP 669 (3.12+, and this interpreter is 3.14) lets a callback
// answer DISABLE, which retires that bytecode location permanently, so the
// second time round a line that is not a breakpoint costs nothing at all: 23ms
// against a 22ms baseline. A breakpoint on the hot line itself is 83ms, and that
// is a line you are about to stop on anyway.
//
// The cost of DISABLE is that stepping has to undo it: a location that answered
// DISABLE never fires again until sys.monitoring.restart_events(), so entering a
// step re-arms everything and leaving one lets the lines go quiet again.
//
// WHAT RUNS WHERE. The hot path is Python — deciding whether this line matters
// is a set lookup in the callback, and JS never hears about the lines that do
// not. Once a pause is decided, Python calls into JS and blocks there, and JS
// runs the whole CDP conversation, calling back into Python for the things only
// Python can answer (frames, scopes, the repr of a value, evaluating an
// expression in a frame). That re-entrancy — JS in a Python call, calling Python
// again — is the same shape as the blocking stdin syscall, where CPython's read
// calls JS which parks on Atomics.wait.

/**
 * The Python half: a monitoring tool, a breakpoint table, and the ability to
 * describe a paused stack to something that has never heard of Python.
 *
 * Exported so scripts/spike-python-offline.mjs can hold the source itself to
 * account, and so the bridge tier can run it under a real interpreter.
 */
export const PY_DEBUG_SOURCE = `
import json
import sys

_MAX_DESC = 160
_MAX_PROPS = 300
# Names every module frame has and nobody wants to see in a Variables panel.
# __builtins__ in particular reprs to about 3 kB of the entire builtins dict.
_HIDDEN = frozenset(("__builtins__", "__loader__", "__spec__", "__cached__", "__package__"))


class _VvDebugger:
    def __init__(self):
        self.tool = sys.monitoring.DEBUGGER_ID
        self.on_pause = None
        self.roots = ()
        self.bps = set()
        self.active = True
        self.step = None
        self.step_depth = 0
        self.started = False
        self.frames = []
        self.objects = {}
        self.seq = 0

    # -- lifecycle ---------------------------------------------------------
    def start(self, on_pause, roots):
        self.on_pause = on_pause
        self.roots = tuple(roots)
        if self.started:
            return
        mon = sys.monitoring
        mon.use_tool_id(self.tool, "vivari")
        mon.register_callback(self.tool, mon.events.LINE, self._line)
        mon.set_events(self.tool, mon.events.LINE)
        self.started = True

    def stop(self):
        if not self.started:
            return
        mon = sys.monitoring
        try:
            mon.set_events(self.tool, 0)
            mon.register_callback(self.tool, mon.events.LINE, None)
            mon.free_tool_id(self.tool)
        except Exception:
            pass
        self.started = False

    def set_breakpoints(self, pairs):
        self.bps = set((str(f), int(l)) for f, l in pairs)
        # Locations that answered DISABLE before this breakpoint existed have to
        # be given another chance to fire.
        if self.started:
            sys.monitoring.restart_events()

    def set_active(self, on):
        self.active = bool(on)
        if self.started:
            sys.monitoring.restart_events()

    def request_pause(self):
        # An asynchronous "pause" button: stop at the next user line there is.
        self.step = "into"
        self.step_depth = 0
        if self.started:
            sys.monitoring.restart_events()

    # -- the hot path ------------------------------------------------------
    def _mine(self, filename):
        for root in self.roots:
            if filename.startswith(root):
                return True
        return False

    def _line(self, code, lineno):
        filename = code.co_filename
        if not self._mine(filename):
            # Library code, and the answer will not change: never ask again.
            return sys.monitoring.DISABLE
        if self.step is not None:
            frame = sys._getframe(1)
            depth = self._depth(frame)
            if (
                self.step == "into"
                or (self.step == "over" and depth <= self.step_depth)
                or (self.step == "out" and depth < self.step_depth)
            ):
                self._pause(frame, "step", [])
            # While stepping, every location has to stay live.
            return None
        if self.active and (filename, lineno) in self.bps:
            self._pause(sys._getframe(1), "breakpoint", [filename + ":" + str(lineno)])
            return None
        return sys.monitoring.DISABLE

    def _depth(self, frame):
        n = 0
        f = frame
        while f is not None:
            if self._mine(f.f_code.co_filename):
                n += 1
            f = f.f_back
        return n

    # -- pausing -----------------------------------------------------------
    def _pause(self, frame, reason, hits):
        self.frames = []
        f = frame
        while f is not None:
            if self._mine(f.f_code.co_filename):
                self.frames.append(f)
            f = f.f_back
        self.objects = {}
        payload = json.dumps({
            "reason": reason,
            "hits": hits,
            "frames": [
                {"name": fr.f_code.co_name, "file": fr.f_code.co_filename, "line": fr.f_lineno}
                for fr in self.frames
            ],
        })
        action = "resume"
        try:
            if self.on_pause is not None:
                action = str(self.on_pause(payload))
        except Exception:
            # The frontend went away mid-pause. Failing open means the program
            # finishes; failing closed means a process wedged with no way to
            # reach it, which is worse than a debugger that stopped working.
            action = "resume"
        self.frames = []
        self.objects = {}
        if action in ("into", "over", "out"):
            self.step = action
            self.step_depth = self._depth(frame)
            sys.monitoring.restart_events()
        else:
            self.step = None

    # -- describing values -------------------------------------------------
    def _store(self, value):
        self.seq += 1
        handle = "py:" + str(self.seq)
        self.objects[handle] = value
        return handle

    def _describe(self, value):
        try:
            text = repr(value)
        except Exception as exc:
            text = "<unrepresentable: " + type(exc).__name__ + ">"
        if len(text) > _MAX_DESC:
            text = text[:_MAX_DESC] + "…"
        return text

    def remote(self, value):
        # CDP's RemoteObject, in the terms a JS frontend understands. Python's
        # bool has to be tested before int, being a subclass of it.
        if value is None:
            return {"type": "undefined", "description": "None"}
        if isinstance(value, bool):
            return {"type": "boolean", "value": value, "description": repr(value)}
        if isinstance(value, int) and not isinstance(value, bool):
            return {"type": "number", "value": value, "description": repr(value)}
        if isinstance(value, float):
            return {"type": "number", "value": value, "description": repr(value)}
        if isinstance(value, str):
            return {"type": "string", "value": value}
        kind = type(value).__name__
        out = {
            "type": "function" if callable(value) and not isinstance(value, type) else "object",
            "className": kind,
            "description": self._describe(value),
            "objectId": self._store(value),
        }
        if isinstance(value, (list, tuple, set, frozenset)):
            out["subtype"] = "array"
        return out

    def _entries(self, value):
        # What expanding this value in the panel should show.
        if isinstance(value, dict):
            return [(self._describe(k) if not isinstance(k, str) else k, v)
                    for k, v in list(value.items())[:_MAX_PROPS]]
        if isinstance(value, (list, tuple)):
            return [(str(i), v) for i, v in enumerate(value[:_MAX_PROPS])]
        if isinstance(value, (set, frozenset)):
            return [(str(i), v) for i, v in enumerate(list(value)[:_MAX_PROPS])]
        out = []
        for name in dir(value):
            if name.startswith("__"):
                continue
            try:
                out.append((name, getattr(value, name)))
            except Exception:
                continue
            if len(out) >= _MAX_PROPS:
                break
        return out

    # -- what the frontend asks for ---------------------------------------
    def scope(self, index, kind):
        try:
            frame = self.frames[index]
        except IndexError:
            return json.dumps([])
        source = frame.f_locals if kind == "local" else frame.f_globals
        out = []
        for name, value in list(source.items())[:_MAX_PROPS]:
            if name in _HIDDEN:
                continue
            out.append({"name": name, "value": self.remote(value)})
        return json.dumps(out)

    def props(self, handle):
        if handle not in self.objects:
            return json.dumps([])
        value = self.objects[handle]
        return json.dumps([
            {"name": name, "value": self.remote(item)} for name, item in self._entries(value)
        ])

    def evaluate(self, index, expression):
        try:
            frame = self.frames[index]
        except IndexError:
            return json.dumps({"error": "no such call frame"})
        try:
            value = eval(expression, frame.f_globals, frame.f_locals)
            return json.dumps({"result": self.remote(value)})
        except Exception as exc:
            return json.dumps({"error": type(exc).__name__ + ": " + str(exc)})

    def breakable(self, path):
        # Every line the interpreter can actually stop on, so a breakpoint put on
        # a blank line or a comment binds to the next statement instead of never
        # being hit. Nested code objects hold the lines of functions and classes.
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                code = compile(handle.read(), path, "exec")
        except Exception:
            return json.dumps([])
        lines = set()
        pending = [code]
        while pending:
            current = pending.pop()
            for _start, _end, line in current.co_lines():
                if line:
                    lines.add(line)
            for const in current.co_consts:
                if hasattr(const, "co_lines"):
                    pending.append(const)
        return json.dumps(sorted(lines))


_vv_dbg = _VvDebugger()
`;

const START_GATE_MS = 2500;

/**
 * The JS half: the protocol, the transport, and the bookkeeping a frontend
 * expects to be able to rely on across a pause.
 *
 * `send` posts a CDP event or response toward the studio; `waitForCommand`
 * blocks the worker on the debug SAB until one arrives. Both come from the
 * runtime and are the same ones the Node backend is given.
 */
export function createPythonDebugger({ send, waitForCommand, pyodide, roots }) {
  send = send || (() => {});
  waitForCommand = waitForCommand || (() => null);

  const py = pyodide.runPython("_vv_dbg");

  let enabled = false;
  let breakpointsActive = true;
  let paused = false;
  let started = false; // the start gate has been opened
  let action = "resume"; // what the pause loop last decided

  let scriptSeq = 0;
  const scripts = new Map(); // scriptId -> { scriptId, url, path, breakable }
  const scriptIdByPath = new Map();

  let bpSeq = 0;
  const breakpoints = new Map(); // breakpointId -> { id, path, line }

  let frames = []; // the frame list of the current pause, innermost first
  const scopeIds = new Map(); // objectId -> { index, kind }
  let scopeSeq = 0;

  const toUrl = (p) => (/^[a-z]+:\/\//i.test(p) ? p : "file://" + p);
  const fromUrl = (u) => (u && u.startsWith("file://") ? u.slice("file://".length) : u);

  const emit = (method, params) => send({ method, params: params || {} });
  const reply = (id, result) => send({ id, result: result || {} });
  const replyError = (id, message) => send({ id, error: { code: -32000, message: String(message) } });

  // ── scripts ───────────────────────────────────────────────────────────────
  /**
   * Tell the frontend a file exists, and learn where it can be stopped.
   *
   * Called for the entry script before it runs. A breakpoint the user set
   * earlier is bound here, which is what makes a breakpoint on line 1 of a
   * script that runs in 3ms work at all.
   */
  function registerScript(path) {
    if (scriptIdByPath.has(path)) return scriptIdByPath.get(path);
    const scriptId = String(++scriptSeq);
    let breakable = [];
    try {
      breakable = JSON.parse(py.breakable(path)) || [];
    } catch {
      /* an unparseable file has no breakable lines, and will say so itself */
    }
    const rec = { scriptId, url: toUrl(path), path, breakable: new Set(breakable) };
    scripts.set(scriptId, rec);
    scriptIdByPath.set(path, scriptId);
    if (enabled) emitScriptParsed(rec);
    // A breakpoint set before the file was known now has somewhere to bind.
    syncBreakpoints();
    return scriptId;
  }

  function emitScriptParsed(rec) {
    let endLine = 0;
    for (const line of rec.breakable) if (line > endLine) endLine = line;
    emit("Debugger.scriptParsed", {
      scriptId: rec.scriptId,
      url: rec.url,
      startLine: 0,
      startColumn: 0,
      endLine,
      endColumn: 0,
      executionContextId: 1,
      hash: "",
    });
  }

  // Bind a requested line to the nearest line the interpreter can stop on, so a
  // breakpoint on a comment or a blank line lands on the statement below it
  // rather than silently never firing.
  function resolveLine(path, line) {
    const rec = scripts.get(scriptIdByPath.get(path));
    if (!rec || !rec.breakable.size || rec.breakable.has(line)) return line;
    let best = null;
    for (const candidate of rec.breakable) {
      if (candidate >= line && (best === null || candidate < best)) best = candidate;
    }
    return best === null ? line : best;
  }

  function syncBreakpoints() {
    const pairs = [];
    for (const bp of breakpoints.values()) pairs.push([bp.path, resolveLine(bp.path, bp.line)]);
    try {
      py.set_breakpoints(pairs);
    } catch {
      /* the interpreter is gone; nothing left to stop */
    }
  }

  // ── pausing ───────────────────────────────────────────────────────────────
  /**
   * Called from Python, with the interpreter stopped on a line. Returns the word
   * Python needs to know: resume, into, over or out.
   */
  function onPause(payloadJson) {
    let payload;
    try {
      payload = JSON.parse(payloadJson);
    } catch {
      return "resume";
    }
    paused = true;
    frames = payload.frames || [];
    scopeIds.clear();
    action = "resume";
    emit("Debugger.paused", {
      callFrames: buildCallFrames(),
      reason: payload.reason === "breakpoint" ? "other" : payload.reason || "other",
      hitBreakpoints: hitIdsFor(payload.hits || []),
    });
    for (;;) {
      let cmd;
      try {
        cmd = waitForCommand();
      } catch {
        break; // transport gone: fail open, or the program never finishes
      }
      if (!cmd) continue;
      if (handleWhilePaused(cmd)) break;
    }
    paused = false;
    frames = [];
    scopeIds.clear();
    emit("Debugger.resumed", {});
    return action;
  }

  function hitIdsFor(hits) {
    const out = [];
    for (const hit of hits) {
      const at = String(hit).lastIndexOf(":");
      if (at < 0) continue;
      const path = String(hit).slice(0, at);
      const line = Number(String(hit).slice(at + 1));
      for (const bp of breakpoints.values()) {
        if (bp.path === path && resolveLine(bp.path, bp.line) === line) out.push(bp.id);
      }
    }
    return out;
  }

  function buildCallFrames() {
    return frames.map((frame, index) => {
      const scriptId = scriptIdByPath.get(frame.file) || registerScript(frame.file);
      return {
        callFrameId: "cf:" + index,
        // A module's frame is called <module> in Python, which is accurate and
        // means nothing to someone reading a call stack.
        functionName: frame.name === "<module>" ? "(module)" : frame.name || "",
        location: { scriptId, lineNumber: Math.max(0, (frame.line | 0) - 1), columnNumber: 0 },
        url: toUrl(frame.file),
        scopeChain: [
          { type: "local", object: scopeObject(index, "local", "Local") },
          { type: "global", object: scopeObject(index, "global", "Global") },
        ],
        this: { type: "undefined" },
      };
    });
  }

  function scopeObject(index, kind, label) {
    const objectId = "sc:" + ++scopeSeq;
    scopeIds.set(objectId, { index, kind });
    return { type: "object", className: "Object", description: label, objectId };
  }

  function handleWhilePaused(cmd) {
    const { id, method, params } = cmd;
    switch (method) {
      case "Debugger.resume":
        action = "resume";
        reply(id, {});
        return true;
      case "Debugger.stepOver":
        action = "over";
        reply(id, {});
        return true;
      case "Debugger.stepInto":
        action = "into";
        reply(id, {});
        return true;
      case "Debugger.stepOut":
        action = "out";
        reply(id, {});
        return true;
      case "Debugger.evaluateOnCallFrame":
      case "Runtime.evaluate": {
        const index = frameIndexOf(params && params.callFrameId);
        let answer;
        try {
          answer = JSON.parse(py.evaluate(index, String((params && params.expression) || "")));
        } catch (e) {
          answer = { error: String((e && e.message) || e) };
        }
        if (answer.error) {
          reply(id, {
            result: { type: "string", value: answer.error },
            exceptionDetails: {
              exceptionId: 1,
              text: answer.error,
              lineNumber: 0,
              columnNumber: 0,
              exception: { type: "string", value: answer.error },
            },
          });
        } else {
          reply(id, { result: answer.result });
        }
        return false;
      }
      default:
        handleCommon(cmd);
        return false;
    }
  }

  function frameIndexOf(callFrameId) {
    const index = Number(String(callFrameId || "cf:0").replace(/^cf:/, ""));
    return Number.isFinite(index) ? index : 0;
  }

  // ── commands that are valid whether or not the program is stopped ─────────
  function handleCommon(cmd) {
    const { id, method, params } = cmd;
    switch (method) {
      case "Debugger.enable":
        enabled = true;
        for (const rec of scripts.values()) emitScriptParsed(rec);
        reply(id, { debuggerId: "vivari-python" });
        return;
      case "Runtime.enable":
      case "Debugger.setAsyncCallStackDepth":
      case "Debugger.setBlackboxPatterns":
      case "Debugger.setPauseOnExceptions":
      case "Debugger.setSkipAllPauses":
        reply(id, {});
        return;
      case "Debugger.disable":
        enabled = false;
        reply(id, {});
        return;
      case "Debugger.setBreakpointsActive":
        breakpointsActive = !!(params && params.active);
        try {
          py.set_active(breakpointsActive);
        } catch {
          /* nothing to deactivate */
        }
        reply(id, {});
        return;
      case "Debugger.setBreakpointByUrl": {
        const path = fromUrl((params && params.url) || "");
        const line = ((params && params.lineNumber) | 0) + 1;
        const bp = { id: "bp:" + ++bpSeq, path, line };
        breakpoints.set(bp.id, bp);
        syncBreakpoints();
        const scriptId = scriptIdByPath.get(path);
        const bound = resolveLine(path, line);
        reply(id, {
          breakpointId: bp.id,
          locations: scriptId
            ? [{ scriptId, lineNumber: Math.max(0, bound - 1), columnNumber: 0 }]
            : [],
        });
        return;
      }
      case "Debugger.removeBreakpoint":
        breakpoints.delete((params && params.breakpointId) || "");
        syncBreakpoints();
        reply(id, {});
        return;
      case "Debugger.pause":
        try {
          py.request_pause();
        } catch {
          /* nothing running to interrupt */
        }
        reply(id, {});
        return;
      case "Debugger.getScriptSource": {
        const rec = scripts.get(String((params && params.scriptId) || ""));
        reply(id, { scriptSource: rec ? readSource(rec.path) : "" });
        return;
      }
      case "Runtime.getProperties": {
        const objectId = (params && params.objectId) || "";
        let list = [];
        try {
          const scope = scopeIds.get(objectId);
          list = JSON.parse(scope ? py.scope(scope.index, scope.kind) : py.props(objectId)) || [];
        } catch {
          list = [];
        }
        reply(id, {
          result: list.map((entry) => ({
            name: entry.name,
            value: entry.value,
            writable: false,
            configurable: false,
            enumerable: true,
            isOwn: true,
          })),
        });
        return;
      }
      case "Runtime.runIfWaitingForDebugger":
        started = true;
        reply(id, {});
        return;
      default:
        if (id != null) reply(id, {});
    }
  }

  function readSource(path) {
    try {
      return pyodide.FS.readFile(path, { encoding: "utf8" });
    } catch {
      return "";
    }
  }

  /**
   * The --inspect-brk-style gate.
   *
   * Without it, a script short enough to finish in a few milliseconds would be
   * over before the frontend had sent a single breakpoint. Bounded, so a process
   * launched under a debug session nobody is watching still runs.
   */
  function waitForStart(timeoutMs = START_GATE_MS) {
    const deadline = Date.now() + Math.max(0, timeoutMs | 0);
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      let cmd;
      try {
        cmd = waitForCommand(remaining);
      } catch {
        break; // transport gone — fail open (run) so the guest never wedges
      }
      // null means the wait ran out, not "ask again": re-looping on it would
      // spin the thread hot for the rest of the gate.
      if (!cmd) break;
      handleCommon(cmd);
      if (cmd.method === "Runtime.runIfWaitingForDebugger" || cmd.method === "Debugger.resume") break;
    }
    started = true;
    // Tell the kernel the gate is done. Until it hears this it keeps routing
    // commands into the debug SAB, which only has a reader while this process is
    // parked in the gate or at a breakpoint — so without it, a breakpoint set
    // after the program starts would sit in a queue nobody drains.
    emit("Debugger.resumed", {});
  }

  /** Arm the interpreter. `roots` are the paths whose code counts as the user's. */
  function attach() {
    py.start(onPause, roots || ["/"]);
  }

  function close() {
    try {
      py.stop();
    } catch {
      /* the interpreter may already be gone */
    }
  }

  return {
    attach,
    close,
    registerScript,
    waitForStart,
    onCommand: (cmd) => {
      // Commands that arrive while the program is RUNNING come by postMessage;
      // the ones that arrive while it is stopped are read off the SAB inside the
      // pause loop, which is the only place that can answer them.
      if (!paused) handleCommon(cmd);
    },
  };
}
