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
import { toast } from "sonner";
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

export interface PortInfo {
  port: number;
  pid: number;
}

export interface Clipboard {
  mode: "copy" | "cut";
  rel: string;
}

// One browser tab in the Preview panel.
export interface PreviewTab {
  id: string;
  url: string; // editable address-bar text (what the user sees / types)
  port: number | null; // the in-VM dev-server port this tab mirrors (null = empty tab)
  path: string; // the request path within the dev server (starts with "/")
  nonce: number; // per-tab reload counter (bump to force the iframe to reload)
}

export interface IdeSnapshot {
  booted: boolean;
  status: string;
  cwd: string;
  projectTitle: string | null;
  files: string[]; // rel paths (tree + quick-open)
  openTabs: string[]; // rel paths
  activeTab: string | null;
  previewTab: string | null; // the single "preview" (italic, single-click) tab
  dirty: string[]; // rel paths with unsaved edits
  terminals: TerminalMeta[];
  activeTermId: string | null;
  ports: PortInfo[];
  previewTabs: PreviewTab[];
  activePreviewId: string | null;
  devtoolsOpen: boolean; // the chii DevTools panel (bottom split of the preview)
  devtoolsNonce: number; // bump to reload the DevTools frontend (re-attach to a new target)
  selectedDemo: string;
  activeView: "explorer" | "search";
  sidebarCollapsed: boolean;
  panelCollapsed: boolean;
  panelTab: "console" | "terminal" | "ports";
  clipboard: Clipboard | null;
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
    previewTab: null,
    dirty: [],
    terminals: [],
    activeTermId: null,
    ports: [],
    previewTabs: [],
    activePreviewId: null,
    devtoolsOpen: false,
    devtoolsNonce: 0,
    selectedDemo: DEMOS[0].id,
    activeView: "explorer",
    sidebarCollapsed: false,
    panelCollapsed: true,
    panelTab: "console",
    clipboard: null,
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
  private previewFrames = new Map<string, HTMLIFrameElement>(); // preview tab id -> iframe
  private previewSeq = 0;
  private devtoolsFrame: HTMLIFrameElement | null = null; // the chii DevTools frontend iframe
  private devtoolsTargetId: string | null = null; // which preview tab DevTools is attached to
  private currentDemo: CurrentDemo | null = null;
  private projectFiles: Record<string, string> = {}; // rel -> contents
  private localFiles: Record<string, string> = {}; // abs -> latest text
  private runningDemos = new Map<string, { terminalId: string | null; port: number | null }>();
  private portMap = new Map<number, number>(); // port -> pid (live listeners)
  private started = false;

  constructor() {
    this.bridge = new KernelBridge();
    this.createConsole();
    this.wireBridge();
    this.wirePreviewMessages();
  }

  // ── store plumbing ──
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getSnapshot = (): IdeSnapshot => this.snap;
  private set(partial: Partial<IdeSnapshot>) {
    const prevActive = this.snap.activePreviewId;
    this.snap = { ...this.snap, ...partial };
    // DevTools follows the active preview tab. If the active tab changed while the
    // panel is open, re-attach the (shared) frontend to the new target: close it
    // when there's no tab left, else reload the frontend against the new tab.
    if (this.snap.devtoolsOpen && this.snap.activePreviewId !== prevActive) {
      if (this.snap.activePreviewId == null) {
        this.devtoolsTargetId = null;
        this.snap = { ...this.snap, devtoolsOpen: false };
      } else if (this.snap.activePreviewId !== this.devtoolsTargetId) {
        this.devtoolsTargetId = this.snap.activePreviewId;
        this.snap = { ...this.snap, devtoolsNonce: this.snap.devtoolsNonce + 1 };
      }
    }
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
  private syncPorts() {
    this.set({
      ports: [...this.portMap]
        .map(([port, pid]) => ({ port, pid }))
        .sort((a, b) => a.port - b.port),
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
  }

  // Create a shell terminal tab (defer = spawn the Process Worker lazily, off the
  // cold-boot burst; explicit New Terminal / Run start it right away). `activate`
  // = switch the panel to this terminal (false for the background boot shell).
  newShellTerminal({ defer = false, demo = null, label = null, activate = true }: {
    defer?: boolean; demo?: string | null; label?: string | null; activate?: boolean;
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
    // Adopt as the active shell if none is selected yet (keeps the Terminal tab
    // pointing at a real shell even for the background boot terminal).
    if (this.snap.activeTermId === null) this.set({ activeTermId: id });
    this.syncTerminals();
    if (activate) this.switchTerminal(id);
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
    const t0 = this.terms.get(id);
    if (!t0) return;
    // The console has its own panel tab; shells live under the Terminal tab.
    const patch: Partial<IdeSnapshot> =
      t0.kind === "console"
        ? { panelTab: "console", panelCollapsed: false }
        : { panelTab: "terminal", activeTermId: id, panelCollapsed: false };
    this.set(patch);
    // Fit + focus once React has flipped visibility.
    requestAnimationFrame(() => {
      const t = this.terms.get(id);
      if (!t) return;
      try { t.fit.fit(); } catch { /* not visible */ }
      t.term.focus();
    });
  }

  setPanelTab(tab: "console" | "terminal" | "ports") {
    this.set({ panelTab: tab, panelCollapsed: false });
    if (tab === "console" || tab === "terminal") {
      const id = tab === "console" ? "console" : this.snap.activeTermId;
      requestAnimationFrame(() => {
        if (!id) return;
        const t = this.terms.get(id);
        if (!t) return;
        try { t.fit.fit(); } catch { /* hidden */ }
        t.term.focus();
      });
    }
  }

  setActiveView(view: "explorer" | "search") {
    this.set({ activeView: view, sidebarCollapsed: false });
  }

  closeTerminal(id: string) {
    const t = this.terms.get(id);
    if (!t || t.kind === "console") return;
    this.bridge.post("term-close", { terminalId: id });
    t.term.dispose();
    this.terms.delete(id);
    this.termOrder = this.termOrder.filter((x) => x !== id);
    if (this.snap.activeTermId === id) {
      const nextShell = [...this.termOrder].reverse().find((x) => this.terms.get(x)?.kind === "shell") ?? null;
      if (nextShell) this.switchTerminal(nextShell);
      else this.set({ activeTermId: null, panelTab: "console" });
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
    const id = this.snap.panelTab === "console" ? "console" : this.snap.activeTermId;
    this.terms.get(id ?? "")?.term.clear();
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

  // Open a file. `preview` (single-click from the Explorer) reuses a single
  // italic "preview" tab; a permanent open (double-click, or an edit) pins it.
  openFile(rel: string, { preview = false }: { preview?: boolean } = {}) {
    if (!this.currentDemo) return;

    // Reconcile the tab strip + preview slot.
    const already = this.snap.openTabs.includes(rel);
    let openTabs = this.snap.openTabs;
    let previewTab = this.snap.previewTab;
    if (preview) {
      if (already) {
        // existing tab — activate it; a permanent tab stays permanent.
      } else if (previewTab && this.snap.openTabs.includes(previewTab)) {
        openTabs = this.snap.openTabs.map((t) => (t === previewTab ? rel : t)); // reuse the slot
        previewTab = rel;
      } else {
        openTabs = [...this.snap.openTabs, rel];
        previewTab = rel;
      }
    } else {
      if (!already) openTabs = [...this.snap.openTabs, rel];
      if (previewTab === rel) previewTab = null; // promote to permanent
    }

    if (!this.editor || !this.monaco) {
      // editor still loading — remember the intent
      this.set({ openTabs, previewTab, activeTab: rel });
      return;
    }
    const monaco = this.monaco;
    const abs = this.currentDemo.dir + "/" + rel;
    let model = this.models.get(abs);
    if (!model) {
      const uri = monaco.Uri.file(abs);
      model = monaco.editor.getModel(uri) || monaco.editor.createModel(this.localFiles[abs] ?? "", languageFor(rel), uri);
      model.onDidChangeContent(() => {
        // No auto-save — an edit just marks the tab dirty (⌘S / the close prompt
        // persists it). Reverting back to the saved text clears the dirty flag.
        const changed = model!.getValue() !== (this.localFiles[abs] ?? "");
        const isDirty = this.snap.dirty.includes(rel);
        if (changed && !isDirty) this.set({ dirty: [...this.snap.dirty, rel] });
        else if (!changed && isDirty) this.set({ dirty: this.snap.dirty.filter((x) => x !== rel) });
        if (changed && this.snap.previewTab === rel) this.set({ previewTab: null }); // editing pins the tab
      });
      this.models.set(abs, model);
    }
    this.editor.setModel(model);
    this.set({ activeTab: rel, openTabs, previewTab });
    this.editor.focus();
  }

  // Double-clicking a preview tab (or Explorer entry) pins it permanently.
  pinTab(rel: string) {
    if (this.snap.previewTab === rel) this.set({ previewTab: null });
  }

  closeTab(rel: string) {
    const i = this.snap.openTabs.indexOf(rel);
    if (i === -1) return;
    const openTabs = this.snap.openTabs.filter((x) => x !== rel);
    const previewTab = this.snap.previewTab === rel ? null : this.snap.previewTab;
    if (this.snap.activeTab === rel) {
      const next = openTabs[i] || openTabs[i - 1] || null;
      this.set({ openTabs, previewTab, activeTab: next });
      if (next) this.openFile(next);
      else this.editor?.setModel(null);
    } else {
      this.set({ openTabs, previewTab });
    }
  }

  // Persist a file to the VFS (⌘S, or "Save" in the close prompt). The dev server
  // hot-updates/recompiles off the resulting notifyWatch.
  saveFile(rel: string) {
    if (!this.currentDemo || !this.snap.dirty.includes(rel)) return;
    const abs = this.currentDemo.dir + "/" + rel;
    const contents = this.models.get(abs)?.getValue() ?? this.localFiles[abs] ?? "";
    this.localFiles[abs] = contents;
    this.bridge.post("oc-write", { path: abs, contents });
    this.set({
      dirty: this.snap.dirty.filter((x) => x !== rel),
      status: this.currentDemo.reload ? `saved ${rel} — recompiling…` : `saved ${rel} — hot-updating…`,
    });
  }

  saveActiveFile() {
    if (this.snap.activeTab) this.saveFile(this.snap.activeTab);
  }

  // Throw away unsaved edits, reverting the model to the last-saved text.
  discardFile(rel: string) {
    if (!this.currentDemo) return;
    const abs = this.currentDemo.dir + "/" + rel;
    const model = this.models.get(abs);
    const saved = this.localFiles[abs] ?? "";
    if (model && model.getValue() !== saved) model.setValue(saved); // fires onDidChangeContent → clears dirty
    this.set({ dirty: this.snap.dirty.filter((x) => x !== rel) });
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

  // ── file operations (Explorer context menu) ──────────────────────────────
  private absOf(rel: string): string {
    return this.currentDemo ? this.currentDemo.dir + "/" + rel : rel;
  }
  // Is `rel` an existing file, or a directory prefix of existing files?
  private pathExists(rel: string): boolean {
    return this.snap.files.some((f) => f === rel || f.startsWith(rel + "/"));
  }
  // Return `rel` (or `name-copy.ext`, `-copy-2`, …) so a paste never clobbers.
  private uniqueName(rel: string): string {
    if (!this.pathExists(rel)) return rel;
    const slash = rel.lastIndexOf("/");
    const dir = slash === -1 ? "" : rel.slice(0, slash + 1);
    const base = slash === -1 ? rel : rel.slice(slash + 1);
    const dot = base.lastIndexOf("."); // leading dot (dotfile) => treat as no extension
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    for (let n = 1; ; n++) {
      const candidate = `${dir}${stem}-copy${n > 1 ? `-${n}` : ""}${ext}`;
      if (!this.pathExists(candidate)) return candidate;
    }
  }

  private disposeModel(abs: string) {
    const model = this.models.get(abs);
    if (!model) return;
    if (this.editor && this.editor.getModel() === model) this.editor.setModel(null);
    model.dispose();
    this.models.delete(abs);
  }

  // Remap every rel that is `oldRel` or lives under it → the `newRel` subtree,
  // updating the file list, cached contents, Monaco models, tabs, and dirty set.
  private applyMove(oldRel: string, newRel: string) {
    const map = (r: string) =>
      r === oldRel ? newRel : r.startsWith(oldRel + "/") ? newRel + r.slice(oldRel.length) : r;
    const affected = this.snap.files.filter((f) => f === oldRel || f.startsWith(oldRel + "/"));
    for (const rel of affected) {
      const oldAbs = this.absOf(rel);
      const newAbs = this.absOf(map(rel));
      this.disposeModel(oldAbs);
      if (oldAbs in this.localFiles) { this.localFiles[newAbs] = this.localFiles[oldAbs]; delete this.localFiles[oldAbs]; }
      if (rel in this.projectFiles) { this.projectFiles[map(rel)] = this.projectFiles[rel]; delete this.projectFiles[rel]; }
    }
    this.set({
      files: this.snap.files.map(map),
      openTabs: this.snap.openTabs.map(map),
      activeTab: this.snap.activeTab ? map(this.snap.activeTab) : null,
      previewTab: this.snap.previewTab ? map(this.snap.previewTab) : null,
      dirty: this.snap.dirty.map(map),
    });
    if (this.snap.activeTab) this.openFile(this.snap.activeTab, { preview: this.snap.previewTab === this.snap.activeTab });
  }

  private removePaths(rel: string) {
    const affected = new Set(this.snap.files.filter((f) => f === rel || f.startsWith(rel + "/")));
    for (const r of affected) {
      this.disposeModel(this.absOf(r));
      delete this.localFiles[this.absOf(r)];
      delete this.projectFiles[r];
    }
    const openTabs = this.snap.openTabs.filter((t) => !affected.has(t));
    let activeTab = this.snap.activeTab;
    if (activeTab && affected.has(activeTab)) activeTab = openTabs[openTabs.length - 1] ?? null;
    this.set({
      files: this.snap.files.filter((f) => !affected.has(f)),
      openTabs,
      activeTab,
      previewTab: this.snap.previewTab && affected.has(this.snap.previewTab) ? null : this.snap.previewTab,
      dirty: this.snap.dirty.filter((d) => !affected.has(d)),
    });
    if (activeTab) this.openFile(activeTab);
    else this.editor?.setModel(null);
  }

  private copyPaths(srcRel: string, destRel: string) {
    const affected = this.snap.files.filter((f) => f === srcRel || f.startsWith(srcRel + "/"));
    const added: string[] = [];
    for (const rel of affected) {
      const newRel = rel === srcRel ? destRel : destRel + rel.slice(srcRel.length);
      const srcAbs = this.absOf(rel);
      const destAbs = this.absOf(newRel);
      if (srcAbs in this.localFiles) this.localFiles[destAbs] = this.localFiles[srcAbs];
      if (rel in this.projectFiles) this.projectFiles[newRel] = this.projectFiles[rel];
      added.push(newRel);
    }
    this.set({ files: [...this.snap.files, ...added] });
  }

  copyEntry(rel: string) { this.set({ clipboard: { mode: "copy", rel } }); }
  cutEntry(rel: string) { this.set({ clipboard: { mode: "cut", rel } }); }

  renameEntry(oldRel: string, newRel: string) {
    if (!this.currentDemo || !newRel || oldRel === newRel) return;
    if (this.pathExists(newRel)) { toast.error(`"${newRel}" already exists`); return; }
    this.bridge.post("oc-rename", { from: this.absOf(oldRel), to: this.absOf(newRel) });
    this.applyMove(oldRel, newRel);
    if (this.snap.clipboard?.rel === oldRel) this.set({ clipboard: null });
  }

  deleteEntry(rel: string) {
    if (!this.currentDemo) return;
    this.bridge.post("oc-rm", { path: this.absOf(rel) });
    this.removePaths(rel);
    if (this.snap.clipboard?.rel === rel) this.set({ clipboard: null });
  }

  // Paste the clipboard entry into `destDir` ("" = project root).
  pasteInto(destDir: string) {
    const cb = this.snap.clipboard;
    if (!cb || !this.currentDemo) return;
    const name = cb.rel.split("/").pop()!;
    // Cutting a folder into itself/descendant would be invalid — ignore.
    if (cb.mode === "cut" && (destDir === cb.rel || destDir.startsWith(cb.rel + "/"))) return;
    const target = this.uniqueName(destDir ? destDir + "/" + name : name);
    if (cb.mode === "copy") {
      this.bridge.post("oc-copy", { from: this.absOf(cb.rel), to: this.absOf(target) });
      this.copyPaths(cb.rel, target);
    } else {
      this.bridge.post("oc-rename", { from: this.absOf(cb.rel), to: this.absOf(target) });
      this.applyMove(cb.rel, target);
      this.set({ clipboard: null });
    }
  }

  // ── preview (a multi-tab mini browser) ───────────────────────────────────
  setPreviewFrame(id: string, el: HTMLIFrameElement | null) {
    if (el) this.previewFrames.set(id, el);
    else this.previewFrames.delete(id);
  }
  // The iframe URL for a tab: the SW preview proxy for demo ports, else blank.
  // Includes the in-server path plus a per-tab cache-bust so reload/navigate force
  // a fresh document (the SW re-injects the WS shim + DevTools bootstrap each time).
  previewSrc(tab: PreviewTab): string {
    if (tab.port == null) return "about:blank";
    const path = tab.path && tab.path.startsWith("/") ? tab.path : "/";
    const bust = tab.nonce > 1 ? `${path.includes("?") ? "&" : "?"}t=${tab.nonce}` : "";
    return `/preview/${tab.port}${path}${bust}`;
  }
  private setTab(id: string, patch: Partial<PreviewTab>) {
    this.set({ previewTabs: this.snap.previewTabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  }

  // A demo's dev server is up — reuse the tab that already mirrors this port, or
  // open one, and make it active.
  private pointPreview(port: number) {
    const existing = this.snap.previewTabs.find((t) => t.port === port);
    if (existing) {
      this.setTab(existing.id, { nonce: existing.nonce + 1 });
      this.set({ activePreviewId: existing.id });
      return;
    }
    const id = "pv" + ++this.previewSeq;
    const tab: PreviewTab = { id, url: `localhost:${port}`, port, path: "/", nonce: 1 };
    this.set({ previewTabs: [...this.snap.previewTabs, tab], activePreviewId: id });
  }

  addPreviewTab(url = "") {
    const id = "pv" + ++this.previewSeq;
    const tab: PreviewTab = { id, url, port: null, path: "/", nonce: 1 };
    this.set({ previewTabs: [...this.snap.previewTabs, tab], activePreviewId: id });
  }
  activatePreviewTab(id: string) {
    this.set({ activePreviewId: id });
  }
  // Live edits to the address-bar text (does not navigate — Enter does that).
  setPreviewUrl(id: string, url: string) {
    this.setTab(id, { url });
  }

  // Navigate a tab to a typed address. Local-only for now: localhost / 127.0.0.1
  // (or a bare path / port) load the in-VM dev server; anything else is rejected.
  navigatePreview(id: string, input: string) {
    const tab = this.snap.previewTabs.find((t) => t.id === id);
    if (!tab) return;
    const raw = input.trim();
    if (!raw) return;

    // Strip an optional scheme, then split host[:port] from the path.
    const noScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    let hostPort = noScheme;
    let path = "/";
    const slash = noScheme.indexOf("/");
    if (noScheme.startsWith("/")) {
      // Bare path — keep the tab's current port.
      hostPort = "";
      path = noScheme;
    } else if (slash !== -1) {
      hostPort = noScheme.slice(0, slash);
      path = noScheme.slice(slash);
    }

    let port = tab.port;
    if (/^\d+$/.test(hostPort)) {
      // Bare port, e.g. "3000".
      port = parseInt(hostPort, 10);
    } else if (hostPort) {
      const [host, portStr] = hostPort.split(":");
      const isLocal = host === "localhost" || host === "127.0.0.1" || host === "";
      if (!isLocal) {
        toast.error("Only local URLs are supported for now");
        return;
      }
      if (portStr) port = parseInt(portStr, 10);
    }
    if (port == null || Number.isNaN(port)) {
      toast.error("Enter a local port, e.g. localhost:3000");
      return;
    }
    if (!path.startsWith("/")) path = "/" + path;

    this.setTab(id, { url: `localhost:${port}${path === "/" ? "" : path}`, port, path, nonce: tab.nonce + 1 });
  }
  reloadPreviewTab(id: string) {
    const t = this.snap.previewTabs.find((x) => x.id === id);
    if (!t) return;
    // Reload the *current* in-app location natively (keeps the SPA route + re-runs
    // the SW HTML injection). Fall back to a src cache-bust if the frame is gone.
    const frame = this.previewFrames.get(id);
    if (t.port != null && frame?.contentWindow) {
      try {
        frame.contentWindow.location.reload();
        return;
      } catch {
        /* cross-origin / detached — fall through to the src bump */
      }
    }
    this.setTab(id, { nonce: t.nonce + 1 });
  }
  reloadPreview() {
    if (this.snap.activePreviewId) this.reloadPreviewTab(this.snap.activePreviewId);
  }
  previewBack(id: string) {
    try { this.previewFrames.get(id)?.contentWindow?.history.back(); } catch { /* cross-origin */ }
  }
  previewForward(id: string) {
    try { this.previewFrames.get(id)?.contentWindow?.history.forward(); } catch { /* cross-origin */ }
  }
  openPreviewExternal(id: string) {
    const t = this.snap.previewTabs.find((x) => x.id === id);
    if (t?.port != null) window.open(`/preview/${t.port}/`, "_blank");
  }

  closePreviewTab(id: string) {
    const i = this.snap.previewTabs.findIndex((t) => t.id === id);
    if (i === -1) return;
    const previewTabs = this.snap.previewTabs.filter((t) => t.id !== id);
    let activePreviewId = this.snap.activePreviewId;
    if (activePreviewId === id) activePreviewId = (previewTabs[i] || previewTabs[i - 1])?.id ?? null;
    this.previewFrames.delete(id);
    this.set({ previewTabs, activePreviewId });
  }
  closeOtherPreviewTabs(id: string) {
    this.set({ previewTabs: this.snap.previewTabs.filter((t) => t.id === id), activePreviewId: id });
  }
  closePreviewTabsToRight(id: string) {
    const i = this.snap.previewTabs.findIndex((t) => t.id === id);
    if (i === -1) return;
    const previewTabs = this.snap.previewTabs.slice(0, i + 1);
    const active = this.snap.activePreviewId;
    const activePreviewId = previewTabs.some((t) => t.id === active) ? active : id;
    this.set({ previewTabs, activePreviewId });
  }
  closeAllPreviewTabs() {
    this.previewFrames.clear();
    this.devtoolsTargetId = null;
    this.set({ previewTabs: [], activePreviewId: null, devtoolsOpen: false });
  }

  // ── DevTools (chii frontend ↔ per-tab chobitsu backend) ──────────────────
  setDevtoolsFrame(el: HTMLIFrameElement | null) {
    this.devtoolsFrame = el;
  }
  // The chii frontend URL: local host page + `#?embedded=<origin>` flips chii into
  // its postMessage transport (chii reads `location.search || location.hash`, so the
  // param MUST live in the hash — a `?query` cache-bust would shadow it and break the
  // transport). Re-attach reload is handled by remounting the iframe (React `key`).
  devtoolsSrc(): string {
    return `/devtools-host.html#?embedded=${encodeURIComponent(location.origin)}`;
  }
  toggleDevtools() {
    if (this.snap.devtoolsOpen) this.closeDevtools();
    else this.openDevtools();
  }
  openDevtools() {
    if (!this.snap.activePreviewId) {
      toast.error("Open a preview tab first");
      return;
    }
    this.devtoolsTargetId = this.snap.activePreviewId;
    this.set({ devtoolsOpen: true, devtoolsNonce: this.snap.devtoolsNonce + 1 });
  }
  closeDevtools() {
    this.devtoolsTargetId = null;
    this.set({ devtoolsOpen: false });
  }
  // Called when the DevTools frontend iframe finishes loading — kick the target's
  // chobitsu into replaying the page state (frameNavigated + domain enables).
  onDevtoolsReady() {
    if (!this.snap.devtoolsOpen || !this.devtoolsTargetId) return;
    const target = this.previewFrames.get(this.devtoolsTargetId);
    target?.contentWindow?.postMessage({ source: "oc-cdp", dir: "init" }, "*");
  }

  private tabIdForSource(src: MessageEventSource | null): string | null {
    if (!src) return null;
    for (const [id, el] of this.previewFrames) {
      if (el.contentWindow === src) return id;
    }
    return null;
  }

  // Update a tab's displayed address from an in-app navigation. Display only — it
  // must NOT touch `path` (which drives previewSrc), or React would reload the
  // iframe on every SPA route change (a navigation loop).
  private syncTabLocation(id: string, href: string) {
    const tab = this.snap.previewTabs.find((t) => t.id === id);
    if (!tab || tab.port == null) return;
    // The preview iframe lives at /preview/<port>/… — strip that proxy prefix and
    // our own cache-bust to recover the in-server path.
    const m = href.match(/^\/preview\/\d+(\/.*)?$/);
    let path = m ? m[1] || "/" : href.startsWith("/") ? href : "/" + href;
    path = path.replace(/([?&])t=\d+(&|$)/, (_all, p1: string, p2: string) => (p2 === "&" ? p1 : "")).replace(/[?&]$/, "");
    this.setTab(id, { url: `localhost:${tab.port}${path && path !== "/" ? path : ""}` });
  }

  // The host-page relay: bridges CDP between each preview tab's chobitsu and the
  // shared chii frontend, and syncs the address bar from in-app navigation.
  private wirePreviewMessages() {
    window.addEventListener("message", (event: MessageEvent) => {
      const src = event.source;
      const data = event.data;

      // DevTools frontend → target tab. chii posts raw CDP JSON strings.
      if (this.devtoolsFrame && src && src === this.devtoolsFrame.contentWindow) {
        if (typeof data !== "string") return;
        const target = this.devtoolsTargetId ? this.previewFrames.get(this.devtoolsTargetId) : null;
        target?.contentWindow?.postMessage({ source: "oc-cdp", dir: "frontend", data }, "*");
        return;
      }

      if (!data || typeof data !== "object") return;

      // Preview tab's chobitsu → frontend (only if this tab is the attached target).
      if (data.source === "oc-cdp" && data.dir === "target") {
        const tabId = this.tabIdForSource(src);
        if (tabId && tabId === this.devtoolsTargetId) {
          this.devtoolsFrame?.contentWindow?.postMessage(data.data, "*");
        }
        return;
      }

      // Preview tab navigated (link click / SPA route) → sync the address bar.
      if (data.source === "oc-nav") {
        const tabId = this.tabIdForSource(src);
        if (tabId) this.syncTabLocation(tabId, String(data.href || "/"));
      }
    });
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
    if (!collapsed) this.setPanelTab(this.snap.panelTab);
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
      this.newShellTerminal({ defer: true, activate: false });
    });
    b.on("exit", (m) => {
      this.consoleLine(`[kernel] pid ${m.pid} exited with code ${m.code}`, "90");
      // A listener process died — drop any port it owned from the Ports view.
      const pid = m.pid as number;
      let changed = false;
      for (const [port, owner] of this.portMap) {
        if (owner === pid) { this.portMap.delete(port); changed = true; }
      }
      if (changed) this.syncPorts();
    });
    b.on("listen", (m) => {
      this.consoleLine(`[kernel] pid ${m.pid} listening on :${m.port}`, "90");
      this.portMap.set(m.port as number, m.pid as number);
      this.syncPorts();
    });

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
        if (gone?.port != null && this.portMap.delete(gone.port)) this.syncPorts();
        if (gone?.port != null && this.snap.previewTabs.some((t) => t.port === gone.port))
          this.set({ status: "dev server stopped — preview will 502 until you Run again" });
      }
      this.syncTerminals();
    });

    // HMR tunnel: ws frame routed OUT of the VM → preview iframes. The frame
    // doesn't carry a port, so deliver to every tab bound to a dev server; the
    // HMR client in each iframe ignores frames that aren't its own.
    b.on("oc-ws", (m) => {
      const payload = { ...(m.msg as object), type: "oc-ws", dir: "in" };
      for (const t of this.snap.previewTabs) {
        if (t.port != null) this.previewFrames.get(t.id)?.contentWindow?.postMessage(payload, "*");
      }
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
      for (const t of this.snap.previewTabs) if (t.port === m.port) this.reloadPreviewTab(t.id);
      this.set({ status: `${m.title} restarted — preview reloaded` });
    });
    b.on("demo-status", (m) => this.set({ status: m.line as string }));

    // Result of an Explorer file operation (rename/rm/copy). The UI already updated
    // optimistically; surface any failure so the user knows the VFS is out of sync.
    b.on("oc-fs-result", (m) => {
      if (!m.ok) toast.error(`${m.op} failed: ${m.error ?? "unknown error"}`);
    });
  }
}
