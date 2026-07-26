// In-guest CDP Debugger backend (breakpoint debugger for the Vivari Node runtime).
//
// There is no V8 Inspector reachable from a Web Worker, so this module implements
// enough of the Chrome DevTools Protocol — the Debugger and (a slice of) the
// Runtime domain — in plain JS, driven by probes woven into the guest source by
// instrument.js. It speaks the SAME protocol the chii/chobitsu frontend already
// consumes, so the studio can surface Node debugging in the chii Sources panel
// AND in a VS Code-style Monaco debug UI over one shared backend.
//
// How a pause works: instrumented code calls `__vvdbg.line(sid, line)` before each
// statement and `__vvdbg.push/pop` around each function body. When a line matches
// an active breakpoint (or a pending step), the probe calls `doPause`, which emits
// `Debugger.paused` and then SYNCHRONOUSLY pumps inbound CDP commands via the
// injected transport's `waitForCommand()` — evaluating expressions in the paused
// frame's own scope (a direct-eval closure captured per frame) — until a
// resume/step command arrives. In the real runtime `waitForCommand()` blocks on
// `Atomics.wait` over a debug SharedArrayBuffer; in headless tests it drains a
// queue. Everything else (breakpoints, script registry, RemoteObjects) is
// transport-agnostic.

import { instrumentSource } from "./instrument.js";

const PROTOCOL_HASH = "vivari";

export function createDebugger({ send, waitForCommand, readFileSync = null } = {}) {
  send = send || (() => {});
  waitForCommand = waitForCommand || (() => null);

  // ── script registry ───────────────────────────────────────────────────────
  let scriptSeq = 0;
  const scripts = new Map(); // sid(number) -> { sid, url, path, source, breakable:Set<number> }
  const scriptByUrl = new Map(); // url -> sid

  const toUrl = (p) => (/^[a-z]+:\/\//i.test(p) ? p : "file://" + p);
  const fromUrl = (u) => (u && u.startsWith("file://") ? u.slice("file://".length) : u);

  // ── state ─────────────────────────────────────────────────────────────────
  let enabled = false;
  let breakpointsActive = true;
  let pauseOnExceptions = "none";
  let paused = false;
  let requestPause = false; // an async Debugger.pause() request
  let stepMode = null; // 'into' | 'over' | 'out' | null
  let stepDepth = 0;

  const stack = []; // frame = { sid, line, name, ev, vars }
  // Module top-level pseudo-frame (guest code running outside any function). Kept up
  // to date by line()/brk() whenever the call stack is empty, so a top-level
  // breakpoint / `debugger;` still yields a real call frame + global scope.
  let topLevel = null;
  // The frame objects (top→bottom) captured at the current pause; call-frame ids and
  // scope object ids index into this.
  let pausedFrames = [];
  const breakpoints = new Map(); // id -> { id, url, sid, line, condition }
  let bpSeq = 0;

  // `armed` short-circuits the hot `line()` probe when nothing could pause.
  let armed = false;
  const rearm = () => {
    armed = enabled && (stepMode != null || requestPause || breakpoints.size > 0);
  };

  // ── RemoteObject / objectId table ─────────────────────────────────────────
  let objSeq = 0;
  const objTable = new Map(); // objectId -> { kind:'value', value } | { kind:'scope', frameIndex }
  const storeValue = (value) => {
    const id = "vv:o:" + ++objSeq;
    objTable.set(id, { kind: "value", value });
    return id;
  };
  const storeScope = (frameIndex) => {
    const id = "vv:s:" + ++objSeq;
    objTable.set(id, { kind: "scope", frameIndex });
    return id;
  };
  const clearObjects = () => objTable.clear();

  const funcDesc = (fn) => {
    try {
      const s = Function.prototype.toString.call(fn);
      return s.length > 200 ? s.slice(0, 200) + "…" : s;
    } catch {
      return "function () { … }";
    }
  };
  const objDescription = (v, subtype, className) => {
    try {
      if (subtype === "array") return `${className || "Array"}(${v.length})`;
      if (subtype === "error") return String((v && v.stack) || v);
      if (subtype === "regexp") return String(v);
      if (subtype === "date") return v.toString();
      if (subtype === "map" || subtype === "set") return `${className}(${v.size})`;
      return className || "Object";
    } catch {
      return className || "Object";
    }
  };

  function remoteObject(value) {
    const t = typeof value;
    if (value === null) return { type: "object", subtype: "null", value: null };
    if (t === "undefined") return { type: "undefined" };
    if (t === "string") return { type: "string", value };
    if (t === "boolean") return { type: "boolean", value };
    if (t === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0))
        return { type: "number", description: Object.is(value, -0) ? "-0" : String(value), unserializableValue: String(value) };
      return { type: "number", value, description: String(value) };
    }
    if (t === "bigint")
      return { type: "bigint", description: String(value) + "n", unserializableValue: String(value) + "n" };
    if (t === "symbol")
      return { type: "symbol", description: value.toString(), objectId: storeValue(value) };
    if (t === "function")
      return { type: "function", className: "Function", description: funcDesc(value), objectId: storeValue(value) };
    // object
    let subtype;
    if (Array.isArray(value)) subtype = "array";
    else if (value instanceof Error) subtype = "error";
    else if (value instanceof RegExp) subtype = "regexp";
    else if (value instanceof Date) subtype = "date";
    else if (typeof Map !== "undefined" && value instanceof Map) subtype = "map";
    else if (typeof Set !== "undefined" && value instanceof Set) subtype = "set";
    else if (typeof Promise !== "undefined" && value instanceof Promise) subtype = "promise";
    const className = (value.constructor && value.constructor.name) || "Object";
    return {
      type: "object",
      subtype,
      className,
      description: objDescription(value, subtype, className),
      objectId: storeValue(value),
    };
  }

  function propertyDescriptors(value) {
    const out = [];
    const seen = new Set();
    let obj = value;
    let own = true;
    while (obj != null && obj !== Object.prototype && obj !== Function.prototype && obj !== Array.prototype) {
      let names;
      try {
        names = Object.getOwnPropertyNames(obj);
      } catch {
        break;
      }
      for (const name of names) {
        if (seen.has(name)) continue;
        seen.add(name);
        if (name === "__proto__") continue;
        let desc;
        try {
          desc = Object.getOwnPropertyDescriptor(obj, name);
        } catch {
          continue;
        }
        if (!desc) continue;
        if ("value" in desc) {
          out.push({
            name,
            value: remoteObject(desc.value),
            writable: !!desc.writable,
            configurable: !!desc.configurable,
            enumerable: !!desc.enumerable,
            isOwn: own,
          });
        } else {
          out.push({
            name,
            get: desc.get ? remoteObject(desc.get) : undefined,
            set: desc.set ? remoteObject(desc.set) : undefined,
            configurable: !!desc.configurable,
            enumerable: !!desc.enumerable,
            isOwn: own,
          });
        }
      }
      // Only walk one prototype level for the "own + inherited accessors" view.
      obj = Object.getPrototypeOf(obj);
      own = false;
      if (out.length > 500) break;
    }
    return out;
  }

  // ── frames ────────────────────────────────────────────────────────────────
  // Frame objects, topmost first, INCLUDING the module top-level pseudo-frame at the
  // bottom. Captured once per pause.
  function computeFrames() {
    const out = [];
    for (let i = stack.length - 1; i >= 0; i--) out.push(stack[i]);
    if (topLevel) out.push(topLevel);
    if (out.length === 0 && topLevel) out.push(topLevel);
    return out;
  }

  const frameAt = (callFrameId) => {
    const idx = Number(String(callFrameId).replace(/^cf:/, ""));
    return pausedFrames[idx];
  };

  function buildCallFrames() {
    const out = [];
    for (let i = 0; i < pausedFrames.length; i++) {
      const f = pausedFrames[i];
      const scriptId = String(f.sid);
      const rec = scripts.get(f.sid);
      let thisObj;
      try {
        thisObj = remoteObject(f.ev ? f.ev("this") : undefined);
      } catch {
        thisObj = { type: "undefined" };
      }
      out.push({
        callFrameId: "cf:" + i,
        functionName: f.name || "",
        location: { scriptId, lineNumber: Math.max(0, (f.line | 0) - 1), columnNumber: 0 },
        url: rec ? rec.url : "",
        scopeChain: [
          {
            type: "local",
            object: { type: "object", className: "Object", description: "Local", objectId: storeScope(i) },
          },
          {
            type: "global",
            object: remoteObject(globalThis),
          },
        ],
        this: thisObj,
      });
    }
    return out;
  }

  function scopeProperties(frameIndex) {
    const f = pausedFrames[frameIndex];
    const out = [];
    if (!f || !f.ev) return out;
    for (const name of f.vars) {
      let val;
      try {
        val = f.ev(name);
      } catch {
        continue; // TDZ / not yet initialised
      }
      out.push({
        name,
        value: remoteObject(val),
        writable: true,
        configurable: true,
        enumerable: true,
        isOwn: true,
      });
    }
    return out;
  }

  // ── pause machinery ─────────────────────────────────────────────────────────
  function emit(method, params) {
    send({ method, params: params || {} });
  }
  function reply(id, result) {
    send({ id, result: result || {} });
  }
  function replyError(id, message) {
    send({ id, error: { code: -32000, message: String(message) } });
  }

  function doPause(reason, hitBreakpoints) {
    paused = true;
    requestPause = false;
    stepMode = null;
    rearm();
    clearObjects();
    pausedFrames = computeFrames();
    emit("Debugger.paused", {
      callFrames: buildCallFrames(),
      reason: reason || "other",
      hitBreakpoints: hitBreakpoints || [],
    });
    // Synchronously pump commands until told to resume / step.
    for (;;) {
      let cmd;
      try {
        cmd = waitForCommand();
      } catch {
        break; // transport gone — fail open (resume) so the guest never wedges
      }
      if (!cmd) continue;
      const resumeNow = handleWhilePaused(cmd);
      if (resumeNow) break;
    }
    paused = false;
    clearObjects();
    pausedFrames = [];
    emit("Debugger.resumed", {});
    rearm();
  }

  // Commands accepted while paused. Returns true to leave the pause loop.
  function handleWhilePaused(cmd) {
    const { id, method, params } = cmd;
    switch (method) {
      case "Debugger.resume":
        stepMode = null;
        reply(id, {});
        return true;
      case "Debugger.stepOver":
        stepMode = "over";
        stepDepth = stack.length;
        reply(id, {});
        return true;
      case "Debugger.stepInto":
        stepMode = "into";
        stepDepth = stack.length;
        reply(id, {});
        return true;
      case "Debugger.stepOut":
        stepMode = "out";
        stepDepth = stack.length;
        reply(id, {});
        return true;
      case "Debugger.evaluateOnCallFrame": {
        const f = frameAt(params.callFrameId);
        if (!f) return void replyError(id, "no such call frame");
        try {
          const v = f.ev(params.expression);
          reply(id, { result: remoteObject(v) });
        } catch (e) {
          reply(id, {
            result: remoteObject(e && e.message ? String(e.message) : e),
            exceptionDetails: exceptionDetails(e),
          });
        }
        return false;
      }
      default:
        // Everything else (getProperties, setBreakpointByUrl, Runtime.evaluate,
        // enable, …) is valid while paused too.
        handleCommon(cmd);
        return false;
    }
  }

  function exceptionDetails(e) {
    return {
      exceptionId: ++objSeq,
      text: "Uncaught",
      lineNumber: 0,
      columnNumber: 0,
      exception: remoteObject(e),
    };
  }

  // ── the probes woven into guest code ────────────────────────────────────────
  const __vvdbg = {
    push(sid, line, name, ev, vars) {
      stack.push({ sid, line, name, ev, vars: vars || [] });
    },
    pop() {
      stack.pop();
    },
    line(sid, line, ev) {
      const top = stack[stack.length - 1];
      if (top) {
        top.line = line;
        if (ev) top.ev = ev; // innermost block scope — most accurate for eval/scope
      } else {
        topLevel = { sid, line, name: "(module)", ev, vars: [] };
      }
      if (!armed) return;
      // async pause request
      if (requestPause) return doPause("other", []);
      // stepping
      if (stepMode) {
        const d = stack.length;
        if (
          stepMode === "into" ||
          (stepMode === "over" && d <= stepDepth) ||
          (stepMode === "out" && d < stepDepth)
        ) {
          return doPause("step", []);
        }
      }
      // breakpoints
      if (breakpointsActive && breakpoints.size) {
        const hit = breakpointHitsAt(sid, line);
        if (hit.length) return doPause("breakpoint", hit);
      }
    },
    brk(sid, line, ev) {
      if (!enabled) return;
      const top = stack[stack.length - 1];
      if (top) {
        top.line = line;
        if (ev) top.ev = ev;
      } else {
        topLevel = { sid, line, name: "(module)", ev, vars: [] };
      }
      doPause("other", []);
    },
  };

  function breakpointHitsAt(sid, line) {
    const hit = [];
    for (const bp of breakpoints.values()) {
      if (bp.sid !== sid || bp.line !== line) continue;
      if (bp.condition) {
        let ok = false;
        try {
          const top = stack[stack.length - 1];
          ok = top ? !!top.ev(bp.condition) : false;
        } catch {
          ok = false;
        }
        if (!ok) continue;
      }
      hit.push(bp.id);
    }
    return hit;
  }

  // ── breakpoint resolution ───────────────────────────────────────────────────
  // Bind a requested (url, line1) to the nearest breakable line at or after it.
  function resolveLine(sid, line1) {
    const rec = scripts.get(sid);
    if (!rec) return line1;
    if (rec.breakable.has(line1)) return line1;
    let best = null;
    for (const l of rec.breakable) if (l >= line1 && (best == null || l < best)) best = l;
    return best == null ? line1 : best;
  }

  function setBreakpointByUrl(id, params) {
    const url = params.url || (params.urlRegex ? null : "");
    const line1 = (params.lineNumber | 0) + 1;
    const condition = params.condition || "";
    const locations = [];
    let bpId = "";
    // Resolve against every script whose url matches (usually exactly one).
    const targets = [];
    if (url) {
      const sid = scriptByUrl.get(url) ?? scriptByUrl.get(toUrl(url)) ?? scriptByUrl.get(fromUrl(url));
      if (sid != null) targets.push(sid);
    }
    bpId = ++bpSeq + ":" + (url || params.urlRegex || "") + ":" + line1;
    if (targets.length === 0) {
      // No script yet (breakpoint set before the module loaded): remember it so a
      // future scriptParsed can bind it.
      pendingBreakpoints.push({ id: bpId, url, line1, condition });
    }
    for (const sid of targets) {
      const bound = resolveLine(sid, line1);
      breakpoints.set(bpId, { id: bpId, url: scripts.get(sid).url, sid, line: bound, condition });
      locations.push({ scriptId: String(sid), lineNumber: bound - 1, columnNumber: 0 });
    }
    rearm();
    reply(id, { breakpointId: bpId, locations });
  }

  const pendingBreakpoints = []; // { id, url, line1, condition }

  function bindPending(rec) {
    for (let i = pendingBreakpoints.length - 1; i >= 0; i--) {
      const p = pendingBreakpoints[i];
      const matches = p.url === rec.url || toUrl(p.url) === rec.url || fromUrl(p.url) === rec.path;
      if (!matches) continue;
      const bound = resolveLine(rec.sid, p.line1);
      breakpoints.set(p.id, { id: p.id, url: rec.url, sid: rec.sid, line: bound, condition: p.condition });
      emit("Debugger.breakpointResolved", {
        breakpointId: p.id,
        location: { scriptId: String(rec.sid), lineNumber: bound - 1, columnNumber: 0 },
      });
      pendingBreakpoints.splice(i, 1);
    }
    rearm();
  }

  // ── common command handling (works whether running or paused) ────────────────
  function handleCommon(cmd) {
    const { id, method, params = {} } = cmd;
    switch (method) {
      case "Debugger.enable":
        enabled = true;
        rearm();
        reply(id, { debuggerId: "vv:debugger" });
        for (const rec of scripts.values()) emitScriptParsed(rec);
        return;
      case "Debugger.disable":
        enabled = false;
        rearm();
        return reply(id, {});
      case "Runtime.enable":
        reply(id, {});
        emit("Runtime.executionContextCreated", {
          context: { id: 1, origin: "", name: "node", uniqueId: "1", auxData: { isDefault: true } },
        });
        return;
      case "Runtime.runIfWaitingForDebugger":
        return reply(id, {});
      case "Debugger.setBreakpointsActive":
        breakpointsActive = !!params.active;
        rearm();
        return reply(id, {});
      case "Debugger.setBreakpointByUrl":
        return setBreakpointByUrl(id, params);
      case "Debugger.removeBreakpoint":
        breakpoints.delete(params.breakpointId);
        for (let i = pendingBreakpoints.length - 1; i >= 0; i--)
          if (pendingBreakpoints[i].id === params.breakpointId) pendingBreakpoints.splice(i, 1);
        rearm();
        return reply(id, {});
      case "Debugger.setPauseOnExceptions":
        pauseOnExceptions = params.state || "none";
        return reply(id, {});
      case "Debugger.getScriptSource": {
        const sid = Number(params.scriptId);
        const rec = scripts.get(sid);
        return reply(id, { scriptSource: rec ? rec.source : "" });
      }
      case "Debugger.getPossibleBreakpoints": {
        const s = params.start || {};
        const sid = Number(s.scriptId);
        const bound = resolveLine(sid, (s.lineNumber | 0) + 1);
        return reply(id, { locations: [{ scriptId: String(sid), lineNumber: bound - 1, columnNumber: 0 }] });
      }
      case "Debugger.pause":
        requestPause = true;
        rearm();
        return reply(id, {});
      case "Debugger.resume":
      case "Debugger.stepOver":
      case "Debugger.stepInto":
      case "Debugger.stepOut":
        // Not paused — nothing to resume/step. Ack so the frontend doesn't hang.
        return reply(id, {});
      case "Debugger.evaluateOnCallFrame":
        return replyError(id, "not paused");
      case "Runtime.evaluate": {
        try {
          const v = (0, eval)(String(params.expression)); // indirect eval → global scope
          reply(id, { result: remoteObject(v) });
        } catch (e) {
          reply(id, { result: remoteObject(e), exceptionDetails: exceptionDetails(e) });
        }
        return;
      }
      case "Runtime.getProperties": {
        const entry = objTable.get(params.objectId);
        let result = [];
        if (entry && entry.kind === "scope") result = scopeProperties(entry.frameIndex);
        else if (entry && entry.kind === "value") result = propertyDescriptors(entry.value);
        // Split into named properties; DevTools accepts accessor+data mixed here.
        return reply(id, { result });
      }
      case "Runtime.callFunctionOn": {
        try {
          const entry = objTable.get(params.objectId);
          const self = entry && entry.kind === "value" ? entry.value : undefined;
          const args = (params.arguments || []).map((a) =>
            "value" in a ? a.value : a.objectId ? (objTable.get(a.objectId) || {}).value : undefined,
          );
          const fn = (0, eval)("(" + params.functionDeclaration + ")");
          const v = fn.apply(self, args);
          reply(id, { result: remoteObject(v) });
        } catch (e) {
          reply(id, { result: remoteObject(e), exceptionDetails: exceptionDetails(e) });
        }
        return;
      }
      case "Runtime.releaseObject":
        objTable.delete(params.objectId);
        return reply(id, {});
      case "Runtime.releaseObjectGroup":
        return reply(id, {});
      case "Runtime.getIsolateId":
        return reply(id, { id: "vivari" });
      case "Runtime.discardConsoleEntries":
        return reply(id, {});
      case "Debugger.setAsyncCallStackDepth":
      case "Debugger.setBlackboxPatterns":
      case "Debugger.setBlackboxExecutionContexts":
      case "Debugger.setSkipAllPauses":
      case "Runtime.setMaxCallStackSizeToCapture":
      case "Profiler.enable":
      case "Profiler.disable":
        return reply(id, {});
      default:
        // Unknown method — ack empty so the frontend never blocks on it.
        return reply(id, {});
    }
  }

  function emitScriptParsed(rec) {
    if (!enabled) return;
    emit("Debugger.scriptParsed", {
      scriptId: String(rec.sid),
      url: rec.url,
      startLine: 0,
      startColumn: 0,
      endLine: rec.endLine,
      endColumn: 0,
      executionContextId: 1,
      hash: PROTOCOL_HASH,
      isModule: rec.isModule,
      length: rec.source.length,
      scriptLanguage: "JavaScript",
    });
  }

  // ── public: loader hook ──────────────────────────────────────────────────────
  function shouldInstrument(filename) {
    if (!filename || typeof filename !== "string") return false;
    if (filename.includes("/node_modules/")) return false;
    if (/\.(json|node|wasm)$/.test(filename)) return false;
    return true;
  }

  // Instrument a module's (TS-stripped, pre-ESM) source. Registers the script and
  // returns the woven code. On any failure returns the original source unchanged
  // (that file simply won't be breakpointable) so debugging never breaks a run.
  function instrument(source, filename, options = {}) {
    const sid = ++scriptSeq;
    let woven;
    try {
      const r = instrumentSource(source, sid, { module: !!options.isModule });
      woven = r.code;
      const rec = {
        sid,
        path: filename,
        url: toUrl(filename),
        source, // original source (what the editor/getScriptSource shows)
        breakable: new Set(r.breakableLines),
        endLine: source.split("\n").length,
        isModule: !!options.isModule,
      };
      scripts.set(sid, rec);
      scriptByUrl.set(rec.url, sid);
      emitScriptParsed(rec);
      bindPending(rec);
      return woven;
    } catch {
      scriptSeq--; // reclaim the id
      return source;
    }
  }

  // ── public: inbound command entry point (running state) ──────────────────────
  function onCommand(cmd) {
    if (!cmd || typeof cmd !== "object") return;
    // While paused the pump loop owns the command stream; onCommand is only called
    // in the running state (the host routes paused commands into waitForCommand()).
    handleCommon(cmd);
  }

  // ── public: --inspect-brk-style start gate ───────────────────────────────────
  // Called by the runtime right before the entry module runs. A short synchronous
  // script would otherwise finish before the frontend's async `setBreakpointByUrl`
  // commands are ever read, so nothing would pause. We block the worker here —
  // draining config commands over the SAB (enable, breakpoints, …) — until the
  // frontend signals it's done via `Runtime.runIfWaitingForDebugger` (or resume),
  // then let execution proceed. Bounded by `timeoutMs` so a run never hangs if no
  // frontend attaches (headless, or the debug panel was never opened). The kernel
  // routes commands over the SAB from process creation until we emit the paired
  // `Debugger.resumed` below, which flips it back to postMessage for the run.
  function waitForStart(timeoutMs = 2500) {
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
      if (!cmd) break; // timeout — proceed with whatever config arrived
      handleCommon(cmd);
      if (cmd.method === "Runtime.runIfWaitingForDebugger" || cmd.method === "Debugger.resume") break;
    }
    // Tell the kernel the start gate is done: route subsequent commands over
    // postMessage (the running worker drains its message queue between turns).
    emit("Debugger.resumed", {});
  }

  return {
    __vvdbg,
    instrument,
    shouldInstrument,
    onCommand,
    waitForStart,
    isPaused: () => paused,
    isEnabled: () => enabled,
  };
}