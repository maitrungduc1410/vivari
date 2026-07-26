// Studio-side breakpoint debugger session (CDP client).
//
// This is the main-thread half of the breakpoint debugger. It speaks the Chrome
// DevTools Protocol to the in-guest Debugger backend (packages/runtime/debugger.js)
// through the kernel bridge: it announces/attaches to debug targets (Node guest
// processes launched under VV_DEBUG=1), forwards breakpoint + step + evaluate
// commands, and turns `Debugger.paused` into UI state — a call stack, per-frame
// scopes/variables, and a paused-line highlight in Monaco.
//
// The same protocol powers the chii Sources panel for previews, so a later change
// can multiplex these events to chii too; here we drive the VS Code-style Monaco
// debug UI (gutter breakpoints + Call Stack / Variables panel).
//
// State is exposed as an immutable snapshot for useSyncExternalStore, mirroring the
// IdeController's store pattern.

import type * as Monaco from "monaco-editor";
import type { KernelBridge } from "./kernel";

export interface DebugTarget {
  pid: number;
  label: string;
}

export interface DebugScopeVar {
  name: string;
  value: string; // display string
  type: string;
  objectId?: string; // set when expandable
  expandable: boolean;
}

export interface DebugScope {
  type: string; // 'local' | 'global' | 'closure' | …
  name: string;
  objectId?: string;
  vars: DebugScopeVar[] | null; // null = not fetched yet
}

export interface DebugCallFrame {
  callFrameId: string;
  functionName: string;
  url: string;
  path: string; // VFS abs path (url minus file://)
  line: number; // 1-based
  column: number;
  scopeChain: { type: string; name: string; objectId?: string }[];
}

export interface DebugSnapshot {
  enabled: boolean;
  targets: DebugTarget[];
  activePid: number | null;
  paused: boolean;
  pauseReason: string;
  callFrames: DebugCallFrame[];
  selectedFrame: number;
  scopes: DebugScope[];
  pausedPath: string | null;
  pausedLine: number | null;
  // absPath -> sorted line numbers (1-based). Breakpoints are global to the
  // workspace and (re)sent to whichever target attaches.
  breakpoints: Record<string, number[]>;
}

type Pending = (result: any, error?: any) => void;

const stripFileUrl = (u: string) => (u && u.startsWith("file://") ? u.slice("file://".length) : u);
const toFileUrl = (p: string) => "file://" + p;

export class DebugSession {
  private readonly bridge: KernelBridge;
  private listeners = new Set<() => void>();
  private snap: DebugSnapshot = {
    enabled: false,
    targets: [],
    activePid: null,
    paused: false,
    pauseReason: "",
    callFrames: [],
    selectedFrame: 0,
    scopes: [],
    pausedPath: null,
    pausedLine: null,
    breakpoints: {},
  };

  // CDP request/response correlation, keyed by `${pid}:${id}`.
  private cmdSeq = 1;
  private pending = new Map<string, Pending>();
  // Per-active-target: scriptParsed url -> scriptId, and breakpoint key -> id.
  private scriptIdByUrl = new Map<string, string>();
  private bpIdByKey = new Map<string, string>(); // `${path}:${line}` -> breakpointId

  // Monaco wiring.
  private monaco: typeof Monaco | null = null;
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private decorations: Monaco.editor.IEditorDecorationsCollection | null = null;
  private mouseDisposable: Monaco.IDisposable | null = null;
  private modelDisposable: Monaco.IDisposable | null = null;
  private moveDisposable: Monaco.IDisposable | null = null;
  private leaveDisposable: Monaco.IDisposable | null = null;
  // The gutter line currently hovered (line-number or glyph margin) — gets a faded
  // "click to add a breakpoint" dot, VS Code style.
  private hoverLine: number | null = null;

  constructor(bridge: KernelBridge) {
    this.bridge = bridge;
    this.bridge.on("dbg-target", (m: any) => this.onTarget(m.pid | 0, !!m.added, m.info));
    this.bridge.on("dbg-event", (m: any) => this.onEvent(m.pid | 0, m.data));
  }

  // ── store plumbing ──
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getSnapshot = (): DebugSnapshot => this.snap;
  private set(partial: Partial<DebugSnapshot>) {
    this.snap = { ...this.snap, ...partial };
    for (const l of this.listeners) l();
  }

  // ── debug-mode toggle ──
  setEnabled(enabled: boolean) {
    if (this.snap.enabled === enabled) return;
    this.set({ enabled });
    this.bridge.post("vv-debug-mode", { enabled });
  }

  // ── target lifecycle ──
  private onTarget(pid: number, added: boolean, info: any) {
    if (added) {
      const label = info && info.command ? `${info.command} (pid ${pid})` : `pid ${pid}`;
      const targets = [...this.snap.targets.filter((t) => t.pid !== pid), { pid, label }];
      this.set({ targets });
      // Auto-attach so breakpoints "just work". Attach to a freshly launched target
      // whenever we're not currently parked at a breakpoint — so each `node …` the
      // user runs becomes the active target — but never steal focus from a live
      // pause the user is inspecting.
      if (this.snap.activePid == null || !this.snap.paused) this.attach(pid);
    } else {
      const targets = this.snap.targets.filter((t) => t.pid !== pid);
      const wasActive = this.snap.activePid === pid;
      this.set({ targets });
      if (wasActive) {
        this.detachState();
        // Fall back to another live target if one exists.
        if (targets.length) this.attach(targets[0].pid);
        else this.set({ activePid: null });
      }
    }
  }

  /** Make `pid` the active debug target: reset CDP state, enable the domains, and
   * (re)send every workspace breakpoint so they bind as its scripts load. */
  attach(pid: number) {
    this.detachState();
    this.set({ activePid: pid });
    this.send(pid, "Runtime.enable");
    this.send(pid, "Debugger.enable");
    this.send(pid, "Debugger.setBreakpointsActive", { active: true });
    for (const [path, lines] of Object.entries(this.snap.breakpoints)) {
      for (const line of lines) this.sendSetBreakpoint(pid, path, line);
    }
    // Open the guest's --inspect-brk-style start gate (debugger.js waitForStart):
    // the process is parked before its entry runs until this arrives, so even a
    // short synchronous script pauses on breakpoints set above. Sent last so all
    // config is queued ahead of it (the kernel delivers commands in FIFO order).
    this.send(pid, "Runtime.runIfWaitingForDebugger");
  }

  private detachState() {
    this.scriptIdByUrl.clear();
    this.bpIdByKey.clear();
    this.set({
      paused: false,
      pauseReason: "",
      callFrames: [],
      selectedFrame: 0,
      scopes: [],
      pausedPath: null,
      pausedLine: null,
    });
    this.renderDecorations();
  }

  // ── CDP transport ──
  private send(pid: number, method: string, params?: any): Promise<any> {
    const id = this.cmdSeq++;
    const key = pid + ":" + id;
    return new Promise((resolve, reject) => {
      this.pending.set(key, (result, error) => (error ? reject(error) : resolve(result)));
      this.bridge.post("dbg-cmd", { pid, data: JSON.stringify({ id, method, params: params || {} }) });
    });
  }

  private onEvent(pid: number, dataStr: string) {
    let msg: any;
    try {
      msg = JSON.parse(dataStr);
    } catch {
      return;
    }
    if (msg.id != null) {
      const key = pid + ":" + msg.id;
      const p = this.pending.get(key);
      if (p) {
        this.pending.delete(key);
        p(msg.result, msg.error);
      }
      return;
    }
    // Only surface events from the active target.
    if (pid !== this.snap.activePid) {
      if (msg.method === "Debugger.scriptParsed") this.rememberScript(msg.params);
      return;
    }
    switch (msg.method) {
      case "Debugger.scriptParsed":
        this.rememberScript(msg.params);
        break;
      case "Debugger.paused":
        this.onPaused(msg.params);
        break;
      case "Debugger.resumed":
        this.onResumed();
        break;
      default:
        break;
    }
  }

  private rememberScript(params: any) {
    if (params && params.url) this.scriptIdByUrl.set(params.url, String(params.scriptId));
  }

  private onPaused(params: any) {
    const frames: DebugCallFrame[] = (params.callFrames || []).map((f: any) => ({
      callFrameId: f.callFrameId,
      functionName: f.functionName || "(anonymous)",
      url: f.url || "",
      path: stripFileUrl(f.url || ""),
      line: (f.location.lineNumber | 0) + 1,
      column: (f.location.columnNumber | 0) + 1,
      scopeChain: (f.scopeChain || []).map((s: any) => ({
        type: s.type,
        name: s.type === "local" ? "Local" : s.type === "global" ? "Global" : s.type,
        objectId: s.object && s.object.objectId,
      })),
    }));
    const top = frames[0];
    this.set({
      paused: true,
      pauseReason: params.reason || "",
      callFrames: frames,
      selectedFrame: 0,
      scopes: [],
      pausedPath: top ? top.path : null,
      pausedLine: top ? top.line : null,
    });
    if (top) {
      this.onReveal?.(top.path, top.line);
      this.loadScopes(0);
    }
    this.renderDecorations();
  }

  private onResumed() {
    this.set({
      paused: false,
      pauseReason: "",
      callFrames: [],
      scopes: [],
      pausedPath: null,
      pausedLine: null,
    });
    this.renderDecorations();
  }

  // ── stepping / resume ──
  private ctrl(method: string) {
    const pid = this.snap.activePid;
    if (pid == null || !this.snap.paused) return;
    this.send(pid, method);
  }
  resume() {
    this.ctrl("Debugger.resume");
  }
  stepOver() {
    this.ctrl("Debugger.stepOver");
  }
  stepInto() {
    this.ctrl("Debugger.stepInto");
  }
  stepOut() {
    this.ctrl("Debugger.stepOut");
  }
  pause() {
    const pid = this.snap.activePid;
    if (pid != null) this.send(pid, "Debugger.pause");
  }

  selectTarget(pid: number) {
    if (pid !== this.snap.activePid) this.attach(pid);
  }

  // ── call stack / scopes ──
  async selectFrame(i: number) {
    if (i === this.snap.selectedFrame) return;
    this.set({ selectedFrame: i, scopes: [] });
    const frame = this.snap.callFrames[i];
    if (frame) {
      this.onReveal?.(frame.path, frame.line);
      await this.loadScopes(i);
    }
    this.renderDecorations();
  }

  private async loadScopes(frameIndex: number) {
    const pid = this.snap.activePid;
    const frame = this.snap.callFrames[frameIndex];
    if (pid == null || !frame) return;
    const scopes: DebugScope[] = [];
    for (const s of frame.scopeChain) {
      // Only auto-expand the Local scope; Global is huge, so fetch it lazily.
      let vars: DebugScopeVar[] | null = null;
      if (s.type === "local" && s.objectId) vars = await this.fetchProps(pid, s.objectId);
      scopes.push({ type: s.type, name: s.name, objectId: s.objectId, vars });
    }
    // Guard against a resume/step landing between the await and here.
    if (this.snap.selectedFrame === frameIndex && this.snap.paused) this.set({ scopes });
  }

  /** Fetch an object's properties (scope object or an expandable value). */
  async getProperties(objectId: string): Promise<DebugScopeVar[]> {
    const pid = this.snap.activePid;
    if (pid == null) return [];
    return this.fetchProps(pid, objectId);
  }

  private async fetchProps(pid: number, objectId: string): Promise<DebugScopeVar[]> {
    try {
      const res = await this.send(pid, "Runtime.getProperties", { objectId, ownProperties: true });
      const props = (res && res.result) || [];
      return props
        .filter((p: any) => p.value || p.get)
        .map((p: any) => this.toVar(p.name, p.value || { type: "accessor", description: "(…)" }));
    } catch {
      return [];
    }
  }

  private toVar(name: string, ro: any): DebugScopeVar {
    return {
      name,
      value: describeRemote(ro),
      type: ro.type || "",
      objectId: ro.objectId,
      expandable: !!ro.objectId && ro.type === "object",
    };
  }

  /** Evaluate an expression in the selected paused frame (Watch / console). */
  async evaluate(expression: string): Promise<string> {
    const pid = this.snap.activePid;
    if (pid == null) return "";
    const frame = this.snap.callFrames[this.snap.selectedFrame];
    try {
      if (this.snap.paused && frame) {
        const res = await this.send(pid, "Debugger.evaluateOnCallFrame", {
          callFrameId: frame.callFrameId,
          expression,
        });
        return describeRemote(res.result) + (res.exceptionDetails ? " (threw)" : "");
      }
      const res = await this.send(pid, "Runtime.evaluate", { expression });
      return describeRemote(res.result) + (res.exceptionDetails ? " (threw)" : "");
    } catch {
      return "<error>";
    }
  }

  // ── breakpoints ──
  toggleBreakpoint(path: string, line: number) {
    const cur = this.snap.breakpoints[path] || [];
    const has = cur.includes(line);
    const next = has ? cur.filter((l) => l !== line) : [...cur, line].sort((a, b) => a - b);
    const breakpoints = { ...this.snap.breakpoints };
    if (next.length) breakpoints[path] = next;
    else delete breakpoints[path];
    this.set({ breakpoints });
    const pid = this.snap.activePid;
    if (pid != null) {
      if (has) this.sendRemoveBreakpoint(pid, path, line);
      else this.sendSetBreakpoint(pid, path, line);
    }
    this.renderDecorations();
  }

  private async sendSetBreakpoint(pid: number, path: string, line: number) {
    try {
      const res = await this.send(pid, "Debugger.setBreakpointByUrl", {
        url: toFileUrl(path),
        lineNumber: line - 1,
        columnNumber: 0,
      });
      if (res && res.breakpointId) this.bpIdByKey.set(path + ":" + line, res.breakpointId);
    } catch {
      /* target may have exited */
    }
  }

  private sendRemoveBreakpoint(pid: number, path: string, line: number) {
    const key = path + ":" + line;
    const id = this.bpIdByKey.get(key);
    if (id) {
      this.bpIdByKey.delete(key);
      this.send(pid, "Debugger.removeBreakpoint", { breakpointId: id }).catch(() => {});
    }
  }

  // ── Monaco integration ──
  // Reveal hook, wired by the controller (open the file + scroll to the line).
  onReveal: ((path: string, line: number) => void) | null = null;

  attachEditor(editor: Monaco.editor.IStandaloneCodeEditor, monaco: typeof Monaco) {
    this.editor = editor;
    this.monaco = monaco;
    this.decorations = editor.createDecorationsCollection();
    this.mouseDisposable?.dispose();
    this.mouseDisposable = editor.onMouseDown((e) => {
      // A click in the glyph margin OR on the line number toggles a breakpoint —
      // the whole gutter is a discoverable click target (VS Code behaviour).
      const t = e.target.type;
      if (
        t !== monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN &&
        t !== monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS
      )
        return;
      const model = editor.getModel();
      const line = e.target.position?.lineNumber;
      if (!model || !line) return;
      this.toggleBreakpoint(model.uri.path, line);
    });
    // Hover the gutter (glyph margin or line number) → show a faded dot on that line
    // hinting a breakpoint can be added there.
    this.moveDisposable?.dispose();
    this.moveDisposable = editor.onMouseMove((e) => {
      const t = e.target.type;
      const inGutter =
        t === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN ||
        t === monaco.editor.MouseTargetType.GUTTER_LINE_NUMBERS;
      const line = inGutter ? e.target.position?.lineNumber ?? null : null;
      if (line !== this.hoverLine) {
        this.hoverLine = line;
        this.renderDecorations();
      }
    });
    this.leaveDisposable?.dispose();
    this.leaveDisposable = editor.onMouseLeave(() => {
      if (this.hoverLine !== null) {
        this.hoverLine = null;
        this.renderDecorations();
      }
    });
    this.modelDisposable?.dispose();
    this.modelDisposable = editor.onDidChangeModel(() => {
      this.hoverLine = null;
      this.renderDecorations();
    });
    this.renderDecorations();
  }

  /** The set of decorations for the CURRENTLY open model: a red dot per breakpoint
   * line, plus a highlight on the paused line when it belongs to this file. */
  private renderDecorations() {
    if (!this.editor || !this.monaco || !this.decorations) return;
    const model = this.editor.getModel();
    if (!model) {
      this.decorations.clear();
      return;
    }
    const abs = model.uri.path;
    const monaco = this.monaco;
    const decs: Monaco.editor.IModelDeltaDecoration[] = [];
    const pausedLine =
      this.snap.paused && this.snap.pausedPath === abs ? this.snap.pausedLine : null;
    for (const line of this.snap.breakpoints[abs] || []) {
      // The paused line draws its own breakpoint dot (see below). Skipping it here
      // avoids Monaco splitting the glyph margin into two lanes, which shrinks both
      // the dot and the paused arrow.
      if (line === pausedLine) continue;
      decs.push({
        range: new monaco.Range(line, 1, line, 1),
        options: {
          isWholeLine: false,
          glyphMarginClassName: "vv-bp-glyph",
          glyphMarginHoverMessage: { value: "Breakpoint" },
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    }
    if (pausedLine) {
      // When paused on a breakpoint, the single paused glyph renders both the red
      // dot and the centered yellow arrow (vv-paused-on-bp), so they stay full-size.
      const onBp = (this.snap.breakpoints[abs] || []).includes(pausedLine);
      decs.push({
        range: new monaco.Range(pausedLine, 1, pausedLine, 1),
        options: {
          isWholeLine: true,
          className: "vv-paused-line",
          glyphMarginClassName: onBp ? "vv-paused-glyph vv-paused-on-bp" : "vv-paused-glyph",
          stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      });
    }
    // Hovered gutter line: a faded dot hinting a breakpoint can be added. Skipped
    // when the line already has a breakpoint or is the paused line. The tooltip is
    // a glyph-margin hover message, so it only appears over the dot itself — not
    // when hovering the line number.
    if (this.hoverLine != null) {
      const hl = this.hoverLine;
      const hasBp = (this.snap.breakpoints[abs] || []).includes(hl);
      const onPaused = this.snap.paused && this.snap.pausedPath === abs && this.snap.pausedLine === hl;
      if (!hasBp && !onPaused) {
        decs.push({
          range: new monaco.Range(hl, 1, hl, 1),
          options: {
            glyphMarginClassName: "vv-bp-hover-glyph",
            glyphMarginHoverMessage: { value: "Click to add a breakpoint" },
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        });
      }
    }
    this.decorations.set(decs);
  }
}

// Human-readable one-liner for a CDP RemoteObject (Variables/Watch display).
function describeRemote(ro: any): string {
  if (!ro) return "undefined";
  switch (ro.type) {
    case "undefined":
      return "undefined";
    case "string":
      return JSON.stringify(ro.value);
    case "number":
    case "boolean":
      return ro.value != null ? String(ro.value) : ro.description || "";
    case "bigint":
      return ro.description || ro.unserializableValue || "";
    case "symbol":
    case "function":
      return ro.description || ro.type;
    case "object":
      if (ro.subtype === "null") return "null";
      return ro.description || ro.className || "Object";
    default:
      return ro.description || ro.type || "";
  }
}