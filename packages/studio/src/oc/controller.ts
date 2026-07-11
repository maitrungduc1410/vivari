// IDE controller — the imperative core, ported from packages/demo/host.js.
//
// React owns the *chrome* (declarative: title bar, activity bar, explorer, tabs,
// status bar, command palette) and subscribes to an immutable snapshot exposed
// here via useSyncExternalStore. This controller owns the *imperative* pieces
// that don't belong in React's render cycle: the kernel worker bridge, the Monaco
// editor + its models, the xterm terminals (Console + interactive shells), the
// demo "Run" lifecycle, and the preview wiring. Components hand it DOM mount
// points (editor host, terminal containers, preview iframe) and call its methods.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type * as Monaco from "monaco-editor";
import { KernelBridge, type KernelMessage } from "./kernel";

// ── Demo matrix (UI side) ────────────────────────────────────────────────────
// The kernel worker owns the real project files + scaffolding; the host only
// needs the id + a human label for the shell tab it opens (which auto-runs the
// dev command in-VM via OC_RUN). Mirrors the DEMOS keys in kernel-worker.js.
export interface DemoOption {
  id: string;
  title: string;
  runLabel: string;
}
export const DEMOS: DemoOption[] = [
  { id: "react", title: "React + Vite + React Compiler", runLabel: "npm run dev" },
  { id: "nest", title: "NestJS", runLabel: "npm run start:dev" },
];

export interface TerminalMeta {
  id: string;
  label: string;
  kind: "console" | "shell";
  alive: boolean;
}

export interface IdeSnapshot {
  booted: boolean;
  status: string;
  cwd: string;
  projectTitle: string | null;
  files: string[]; // rel paths (tree + quick-open)
  openTabs: string[]; // rel paths
  activeTab: string | null;
  dirty: string[]; // rel paths with unsaved edits
  terminals: TerminalMeta[];
  activeTermId: string | null;
  previewPort: number | null;
  previewNonce: number;
  selectedDemo: string;
  sidebarCollapsed: boolean;
  panelCollapsed: boolean;
  paletteOpen: boolean;
  paletteMode: "command" | "file";
}

const TERM_THEME = {
  background: "#181818",
  foreground: "#cccccc",
  cursor: "#aeafad",
  selectionBackground: "#264f78",
  black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510",
  blue: "#2472c8", magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5",
  brightBlack: "#666666", brightRed: "#f14c4c", brightGreen: "#23d18b",
  brightYellow: "#f5f543", brightBlue: "#3b8eea", brightMagenta: "#d670d6",
  brightCyan: "#29b8db", brightWhite: "#ffffff",
};

const ESC = "\x1b[";

function languageFor(path: string): string {
  if (/\.(jsx?|mjs|cjs)$/.test(path)) return "javascript";
  if (/\.tsx?$/.test(path)) return "typescript";
  if (/\.css$/.test(path)) return "css";
  if (/\.html?$/.test(path)) return "html";
  if (/\.json$/.test(path)) return "json";
  if (/\.md$/.test(path)) return "markdown";
  return "plaintext";
}

interface TermEntry {
  term: Terminal;
  fit: FitAddon;
  kind: "console" | "shell";
  label: string;
  demo: string | null;
  pid: number | null;
  alive: boolean;
  started: boolean;
  opened: boolean;
  openedAt: number;
  pendingInput: string[];
}

interface CurrentDemo {
  id: string;
  dir: string;
  reload: boolean;
  title: string;
}

export class IdeController {
  readonly bridge: KernelBridge;

  // ── external store ──
  private listeners = new Set<() => void>();
  private snap: IdeSnapshot = {
    booted: false,
    status: "booting…",
    cwd: "",
    projectTitle: null,
    files: [],
    openTabs: [],
    activeTab: null,
    dirty: [],
    terminals: [],
    activeTermId: null,
    previewPort: null,
    previewNonce: 0,
    selectedDemo: DEMOS[0].id,
    sidebarCollapsed: false,
    panelCollapsed: true,
    paletteOpen: false,
    paletteMode: "command",
  };

  // ── imperative state (not reactive) ──
  private terms = new Map<string, TermEntry>();
  private termOrder: string[] = [];
  private termSeq = 0;
  private monaco: typeof Monaco | null = null;
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private editorMounting = false; // guards the async create against StrictMode double-mount
  private models = new Map<string, Monaco.editor.ITextModel>(); // abs -> model
  private previewFrame: HTMLIFrameElement | null = null;
  private currentDemo: CurrentDemo | null = null;
  private projectFiles: Record<string, string> = {}; // rel -> contents
  private localFiles: Record<string, string> = {}; // abs -> latest text
  private runningDemos = new Map<string, { terminalId: string | null; port: number | null }>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor() {
    this.bridge = new KernelBridge();
    this.createConsole();
    this.wireBridge();
  }

  // ── store plumbing ──
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getSnapshot = (): IdeSnapshot => this.snap;
  private set(partial: Partial<IdeSnapshot>) {
    this.snap = { ...this.snap, ...partial };
    for (const l of this.listeners) l();
  }
  private syncTerminals() {
    this.set({
      terminals: this.termOrder.map((id) => {
        const t = this.terms.get(id)!;
        return { id, label: t.label, kind: t.kind, alive: t.alive };
      }),
    });
  }

  // ── boot ──
  async start() {
    if (this.started) return;
    this.started = true;
    const ok = await this.bridge.registerServiceWorker();
    this.consoleLine(
      ok ? "Service Worker registered (preview proxy ready)." : "Service workers unavailable — preview disabled.",
      ok ? "32" : "31",
    );
    this.bridge.boot();
  }

  // ── console + terminals ───────────────────────────────────────────────────
  private consoleWrite(chunk: string) {
    this.terms.get("console")?.term.write(chunk);
  }
  private consoleLine(text: string, color?: string) {
    this.terms.get("console")?.term.write((color ? `${ESC}${color}m${text}${ESC}0m` : text) + "\r\n");
  }

  private makeTerm(): { term: Terminal; fit: FitAddon } {
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 12.5,
      scrollback: 8000,
      theme: TERM_THEME,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    return { term, fit };
  }

  private createConsole() {
    const { term, fit } = this.makeTerm();
    this.terms.set("console", {
      term, fit, kind: "console", label: "Console", demo: null,
      pid: null, alive: true, started: true, opened: false, openedAt: 0, pendingInput: [],
    });
    this.termOrder.push("console");
    this.snap.activeTermId = "console";
  }

  // Create a shell terminal tab (defer = spawn the Process Worker lazily, off the
  // cold-boot burst; explicit New Terminal / Run start it right away).
  newShellTerminal({ defer = false, demo = null, label = null }: {
    defer?: boolean; demo?: string | null; label?: string | null;
  } = {}): string {
    const id = "sh" + ++this.termSeq;
    const { term, fit } = this.makeTerm();
    const entry: TermEntry = {
      term, fit, kind: "shell", label: label || "sh " + this.termSeq, demo,
      pid: null, alive: true, started: false, opened: false, openedAt: 0, pendingInput: [],
    };
    this.terms.set(id, entry);
    this.termOrder.push(id);
    term.onData((data) => {
      if (!entry.started) {
        this.startShell(id);
        entry.pendingInput.push(data);
        return;
      }
      this.bridge.post("term-input", { terminalId: id, chunk: data });
    });
    this.syncTerminals();
    this.switchTerminal(id);
    if (defer) {
      if (typeof requestIdleCallback === "function") requestIdleCallback(() => this.startShell(id), { timeout: 2500 });
      else setTimeout(() => this.startShell(id), 1500);
    } else {
      this.startShell(id);
    }
    return id;
  }

  private startShell(id: string) {
    const entry = this.terms.get(id);
    if (!entry || entry.kind !== "shell" || entry.started) return;
    entry.started = true;
    entry.openedAt = performance.now();
    this.bridge.post("term-open", { terminalId: id, demo: entry.demo, cwd: this.currentDemo?.dir });
  }

  switchTerminal(id: string) {
    if (!this.terms.has(id)) return;
    this.set({ activeTermId: id, panelCollapsed: false });
    // Fit + focus once React has flipped visibility.
    requestAnimationFrame(() => {
      const t = this.terms.get(id);
      if (!t) return;
      try { t.fit.fit(); } catch { /* not visible */ }
      t.term.focus();
    });
  }

  closeTerminal(id: string) {
    const t = this.terms.get(id);
    if (!t || t.kind === "console") return;
    this.bridge.post("term-close", { terminalId: id });
    t.term.dispose();
    this.terms.delete(id);
    this.termOrder = this.termOrder.filter((x) => x !== id);
    if (this.snap.activeTermId === id) {
      const next = this.termOrder[this.termOrder.length - 1] || "console";
      this.switchTerminal(next);
    }
    this.syncTerminals();
  }

  // React hands us the container for a terminal tab; mount xterm into it once.
  mountTerminal(id: string, el: HTMLElement | null) {
    const t = this.terms.get(id);
    if (!t || !el) return;
    if (t.opened) {
      // Re-parent if React remounted the node.
      if (t.term.element && t.term.element.parentElement !== el) el.appendChild(t.term.element);
      return;
    }
    t.term.open(el);
    t.opened = true;
    requestAnimationFrame(() => {
      try { t.fit.fit(); } catch { /* hidden */ }
    });
  }

  fitTerminal(id: string | null) {
    if (!id) return;
    const t = this.terms.get(id);
    if (!t) return;
    try { t.fit.fit(); } catch { /* hidden */ }
  }

  clearActiveTerminal() {
    this.terms.get(this.snap.activeTermId ?? "")?.term.clear();
  }

  // ── editor ──────────────────────────────────────────────────────────────
  async mountEditor(el: HTMLElement) {
    if (this.editor || this.editorMounting) return;
    this.editorMounting = true;
    // Silence Monaco's language-service workers (we only need syntax coloring,
    // which runs on the main thread) and keep it COEP-safe with a no-op worker.
    (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorker() {
        return new Worker(URL.createObjectURL(new Blob([""], { type: "text/javascript" })));
      },
    };
    const monaco = await import("monaco-editor");
    this.monaco = monaco;
    // Silence the TS/JS language services if this monaco build still ships them
    // (we only want syntax coloring; diagnostics need workers we don't wire up).
    try {
      const ts = (monaco.languages as unknown as {
        typescript?: {
          typescriptDefaults?: { setDiagnosticsOptions: (o: object) => void; setEagerModelSync: (b: boolean) => void };
          javascriptDefaults?: { setDiagnosticsOptions: (o: object) => void; setEagerModelSync: (b: boolean) => void };
        };
      }).typescript;
      for (const d of [ts?.typescriptDefaults, ts?.javascriptDefaults]) {
        d?.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true });
        d?.setEagerModelSync(false);
      }
    } catch { /* language pack absent — fine */ }
    this.editor = monaco.editor.create(el, {
      model: null,
      theme: "vs-dark",
      automaticLayout: true,
      fontSize: 13,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      tabSize: 2,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
    });
    // Open whatever tab was requested before the editor finished loading.
    if (this.snap.activeTab) this.openFile(this.snap.activeTab);
  }

  openFile(rel: string) {
    if (!this.currentDemo) return;
    if (!this.editor || !this.monaco) {
      // editor still loading — remember the intent
      if (!this.snap.openTabs.includes(rel)) this.set({ openTabs: [...this.snap.openTabs, rel] });
      this.set({ activeTab: rel });
      return;
    }
    const monaco = this.monaco;
    const abs = this.currentDemo.dir + "/" + rel;
    let model = this.models.get(abs);
    if (!model) {
      const uri = monaco.Uri.file(abs);
      model = monaco.editor.getModel(uri) || monaco.editor.createModel(this.localFiles[abs] ?? "", languageFor(rel), uri);
      model.onDidChangeContent(() => {
        if (!this.snap.dirty.includes(rel)) this.set({ dirty: [...this.snap.dirty, rel] });
        this.scheduleSave(abs, rel);
      });
      this.models.set(abs, model);
    }
    this.editor.setModel(model);
    const openTabs = this.snap.openTabs.includes(rel) ? this.snap.openTabs : [...this.snap.openTabs, rel];
    this.set({ activeTab: rel, openTabs });
    this.editor.focus();
  }

  closeTab(rel: string) {
    const i = this.snap.openTabs.indexOf(rel);
    if (i === -1) return;
    const openTabs = this.snap.openTabs.filter((x) => x !== rel);
    if (this.snap.activeTab === rel) {
      const next = openTabs[i] || openTabs[i - 1] || null;
      this.set({ openTabs, activeTab: next });
      if (next) this.openFile(next);
      else this.editor?.setModel(null);
    } else {
      this.set({ openTabs });
    }
  }

  private scheduleSave(abs: string, rel: string) {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const contents = this.models.get(abs)?.getValue() ?? this.localFiles[abs] ?? "";
      this.localFiles[abs] = contents;
      this.bridge.post("oc-write", { path: abs, contents });
      this.set({
        dirty: this.snap.dirty.filter((x) => x !== rel),
        status: this.currentDemo?.reload ? `saved ${rel} — recompiling…` : `saved ${rel} — hot-updating…`,
      });
    }, 350); // debounce a burst of keystrokes into one write
  }

  private loadProject(m: KernelMessage) {
    this.currentDemo = { id: m.id as string, dir: m.dir as string, reload: !!m.reload, title: m.title as string };
    this.projectFiles = (m.files as Record<string, string>) || {};
    for (const [rel, contents] of Object.entries(this.projectFiles)) {
      this.localFiles[(m.dir as string) + "/" + rel] = contents;
    }
    this.set({ projectTitle: (m.title as string) || (m.id as string), files: Object.keys(this.projectFiles) });
    const entry = m.entry as string | undefined;
    if (entry && this.projectFiles[entry]) this.openFile(entry);
    else {
      const first = Object.keys(this.projectFiles)[0];
      if (first) this.openFile(first);
    }
  }

  // ── preview ──
  setPreviewFrame(el: HTMLIFrameElement | null) {
    this.previewFrame = el;
  }
  private pointPreview(port: number) {
    this.set({ previewPort: port, previewNonce: this.snap.previewNonce + 1 });
  }
  reloadPreview() {
    if (this.snap.previewPort) this.set({ previewNonce: this.snap.previewNonce + 1 });
  }
  openPreviewTab() {
    if (this.snap.previewPort) window.open(`/preview/${this.snap.previewPort}/`, "_blank");
  }

  // ── demo run ──
  setSelectedDemo(id: string) {
    this.set({ selectedDemo: id });
  }
  runDemo() {
    const demo = this.snap.selectedDemo;
    this.set({ panelCollapsed: false });
    const running = this.runningDemos.get(demo);
    if (running && running.terminalId && this.terms.has(running.terminalId)) {
      this.switchTerminal(running.terminalId);
      if (running.port) this.pointPreview(running.port);
      return;
    }
    const opt = DEMOS.find((d) => d.id === demo);
    const tid = this.newShellTerminal({ demo, label: opt?.runLabel ?? "run" });
    this.runningDemos.set(demo, { terminalId: tid, port: null });
    this.set({ status: "installing from npm + booting in-VM…" });
  }

  // ── UI toggles ──
  togglePanel(force?: boolean) {
    const collapsed = force === undefined ? !this.snap.panelCollapsed : !force;
    this.set({ panelCollapsed: collapsed });
    if (!collapsed) this.switchTerminal(this.snap.activeTermId || "console");
  }
  toggleSidebar(force?: boolean) {
    const collapsed = force === undefined ? !this.snap.sidebarCollapsed : !force;
    this.set({ sidebarCollapsed: collapsed });
  }
  openPalette(mode: "command" | "file") {
    this.set({ paletteOpen: true, paletteMode: mode });
  }
  closePalette() {
    this.set({ paletteOpen: false });
  }
  resetAndReload() {
    location.href = location.pathname + "?reset";
  }

  // ── kernel worker message handling (ported from host.js) ──────────────────
  private wireBridge() {
    const b = this.bridge;
    b.on("stdout", (m) => this.consoleWrite(m.chunk as string));
    b.on("stderr", (m) => this.consoleWrite(m.chunk as string));
    b.on("log", (m) => {
      const stderr = m.stream === "stderr";
      const dim = (m.dim as boolean) || m.cls === "muted";
      this.consoleLine(m.line as string, stderr ? "31" : dim ? "90" : undefined);
    });
    b.on("ready", () => {
      this.consoleLine("Kernel ready.", "32");
      this.set({ booted: true, status: "ready — pick a project and press Run" });
      this.newShellTerminal({ defer: true });
    });
    b.on("exit", (m) => this.consoleLine(`[kernel] pid ${m.pid} exited with code ${m.code}`, "90"));
    b.on("listen", (m) => this.consoleLine(`[kernel] pid ${m.pid} listening on :${m.port}`, "90"));

    // interactive terminals
    b.on("term-ready", (m) => {
      const t = this.terms.get(m.terminalId as string);
      if (t) {
        t.pid = m.pid as number;
        if (t.pendingInput.length) {
          for (const chunk of t.pendingInput) b.post("term-input", { terminalId: m.terminalId, chunk });
          t.pendingInput.length = 0;
        }
      }
      this.set({ cwd: (m.cwd as string) || "" });
    });
    b.on("term-out", (m) => {
      const t = this.terms.get(m.terminalId as string);
      if (!t) return;
      if (t.openedAt) {
        this.consoleLine(`[boot] shell (Process Worker) booted in ${Math.round(performance.now() - t.openedAt)}ms`, "90");
        t.openedAt = 0;
      }
      t.term.write(m.chunk as string);
    });
    b.on("term-exit", (m) => {
      const id = m.terminalId as string;
      const t = this.terms.get(id);
      if (!t) return;
      t.term.write(`\r\n\x1b[90m[process exited — code ${m.code}]\x1b[0m\r\n`);
      t.alive = false;
      // A demo's dev-server tab ended → server gone.
      if (t.demo && this.runningDemos.get(t.demo)?.terminalId === id) {
        const gone = this.runningDemos.get(t.demo);
        this.runningDemos.delete(t.demo);
        if (gone?.port === this.snap.previewPort)
          this.set({ status: "dev server stopped — preview will 502 until you Run again" });
      }
      this.syncTerminals();
    });

    // HMR tunnel: ws frame routed OUT of the VM → preview iframe.
    b.on("oc-ws", (m) => {
      this.previewFrame?.contentWindow?.postMessage({ ...(m.msg as object), type: "oc-ws", dir: "in" }, "*");
    });

    b.on("demo-ready", (m) => {
      this.pointPreview(m.port as number);
      const r = this.runningDemos.get(m.id as string);
      if (r) r.port = m.port as number;
      else this.runningDemos.set(m.id as string, { terminalId: null, port: m.port as number });
      this.loadProject(m);
      this.set({
        status: m.reload ? `${m.title} running — edits recompile + restart` : `${m.title} running — edits hot-reload`,
      });
    });
    b.on("demo-reload", (m) => {
      if (m.port === this.snap.previewPort) this.reloadPreview();
      this.set({ status: `${m.title} restarted — preview reloaded` });
    });
    b.on("demo-status", (m) => this.set({ status: m.line as string }));
  }
}
