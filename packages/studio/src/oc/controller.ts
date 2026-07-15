// IDE controller — the imperative core, ported from packages/demo/host.js.
//
// React owns the *chrome* (declarative: title bar, activity bar, explorer, tabs,
// status bar, command palette) and subscribes to an immutable snapshot exposed
// here via useSyncExternalStore. This controller owns the *imperative* pieces
// that don't belong in React's render cycle: the kernel worker bridge, the Monaco
// editor + its models, the xterm terminals (Console + interactive shells), the
// project "Run" lifecycle, and the preview wiring. Components hand it DOM mount
// points (editor host, terminal containers, preview iframe) and call its methods.
//
// Since the multi-root rewrite, the workspace is a set of folders (roots), the
// Explorer reads the VFS live, and every open file / tab / model is keyed by its
// ABSOLUTE path so files from different roots never collide.

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { toast } from "sonner";
import type * as Monaco from "monaco-editor";
import { KernelBridge } from "./kernel";
import { getTemplate, type TemplateManifest } from "./templates";

// ── Demo matrix (UI side) ────────────────────────────────────────────────────
// The two hard-coded example projects the kernel worker still scaffolds on demand
// (the "Run" button's legacy path). New projects come from Home (blank/template).
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
  abs: string; // absolute path of the copied/cut entry
}

// A root folder open in the workspace (VSCode-style multi-root).
export interface WorkspaceFolder {
  id: string;
  name: string;
  rootPath: string; // absolute, no trailing slash
}

// A persisted project (Home "recent projects" list). Content lives in the VFS
// (OPFS); this registry just tracks what exists + when it was last touched.
export interface ProjectMeta {
  name: string;
  rootPath: string;
  template: string | null;
  createdAt: number;
  lastModified: number;
}

// One browser tab in the Preview panel.
export interface PreviewTab {
  id: string;
  url: string; // editable address-bar text (what the user sees / types)
  port: number | null; // the in-VM dev-server port this tab mirrors (null = empty tab)
  path: string; // the request path within the dev server (starts with "/")
  nonce: number; // per-tab reload counter (bump to force the iframe to reload)
}

// ── Full-text search (VS Code-style) ─────────────────────────────────────────
export interface SearchOptions {
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
  includeGlob: string;
  excludeGlob: string;
}
export interface SearchMatch {
  line: number; // 1-based
  column: number; // 1-based
  length: number;
  preview: string; // the full (capped) source line, for highlighting
}
export interface SearchFileResult {
  file: string; // absolute path
  root: string; // the workspace root it was found under
  matches: SearchMatch[];
}
export interface SearchDone {
  matchCount: number;
  fileCount: number;
  limitHit: boolean;
  error?: string;
}

export interface IdeSnapshot {
  booted: boolean;
  kernelReady: boolean; // kernel + VFS up (can create/open projects) — earlier than `booted`
  status: string;
  cwd: string;
  view: "home" | "workspace";
  projectTitle: string | null;
  workspaceFolders: WorkspaceFolder[];
  activeFolderId: string | null;
  recentProjects: ProjectMeta[];
  treeVersion: number; // bump to make the Explorer re-read expanded dirs
  files: string[]; // absolute paths (flat index for quick-open + search)
  openTabs: string[]; // absolute paths
  activeTab: string | null;
  previewTab: string | null; // the single "preview" (italic, single-click) tab
  dirty: string[]; // absolute paths with unsaved edits
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
  problems: { errors: number; warnings: number }; // live TS/JS diagnostics (status bar)
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
const REGISTRY_KEY = "oc-workspace-projects";

const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const normDir = (p: string) => {
  const n = "/" + p.split("/").filter((s) => s && s !== ".").join("/");
  return n === "/" ? "/" : n.replace(/\/+$/, "");
};
const folderIdFor = (rootPath: string) => "wf:" + rootPath;

function languageFor(path: string): string {
  if (/\.(jsx?|mjs|cjs)$/.test(path)) return "javascript";
  if (/\.tsx?$/.test(path)) return "typescript";
  if (/\.css$/.test(path)) return "css";
  if (/\.(html?|vue|svelte)$/.test(path)) return "html";
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
  cwd: string | null;
  run: string | null; // explicit OC_RUN (created/opened project run shells)
  pid: number | null;
  alive: boolean;
  started: boolean;
  opened: boolean;
  openedAt: number;
  pendingInput: string[];
}

export class IdeController {
  readonly bridge: KernelBridge;

  // ── external store ──
  private listeners = new Set<() => void>();
  private snap: IdeSnapshot = {
    booted: false,
    kernelReady: false,
    status: "booting…",
    cwd: "",
    view: "home",
    projectTitle: null,
    workspaceFolders: [],
    activeFolderId: null,
    recentProjects: [],
    treeVersion: 0,
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
    problems: { errors: 0, warnings: 0 },
  };

  // ── imperative state (not reactive) ──
  private terms = new Map<string, TermEntry>();
  private termOrder: string[] = [];
  private termSeq = 0;
  private monaco: typeof Monaco | null = null;
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private editorMounting = false; // guards the async create against StrictMode double-mount
  private models = new Map<string, Monaco.editor.ITextModel>(); // abs -> model
  private depLibsByRoot = new Map<string, Map<string, string>>(); // root -> (extra-lib uri -> content)
  private depsSig = new Map<string, string>(); // root -> last node_modules fingerprint
  private dtsWarnedNoNM = new Set<string>(); // roots we've already noted lack node_modules
  private tsCompilerOptions: Monaco.typescript.CompilerOptions | null = null; // re-applied to force a worker rebuild after extra libs load
  private dtsTimer: ReturnType<typeof setTimeout> | null = null; // debounce dependency-type loads
  private dtsSeq = 0; // supersede in-flight dependency-type refreshes
  private previewFrames = new Map<string, HTMLIFrameElement>(); // preview tab id -> iframe
  private previewSeq = 0;
  private devtoolsFrame: HTMLIFrameElement | null = null; // the chii DevTools frontend iframe
  private devtoolsTargetId: string | null = null; // which preview tab DevTools is attached to
  private localFiles: Record<string, string> = {}; // abs -> latest saved text (editor cache)
  private pendingReveal: { abs: string; line: number; column: number; length: number } | null = null;
  private searchSeq = 0;
  private searchCbs: { token: number; onBatch: (files: SearchFileResult[]) => void; onDone: (d: SearchDone) => void } | null = null;
  private fileIndex = new Map<string, string[]>(); // rootPath -> abs files (quick-open/search)
  private folderManifests = new Map<string, TemplateManifest>(); // rootPath -> run manifest
  private runningProjects = new Map<string, { terminalId: string | null; port: number | null }>();
  private runningDemos = new Map<string, { terminalId: string | null; port: number | null }>();
  private portMap = new Map<number, number>(); // port -> pid (live listeners)
  private treeBump: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor() {
    this.bridge = new KernelBridge();
    this.snap.recentProjects = this.loadRegistry();
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

  // ── VFS queries (request/response over the bridge) ─────────────────────────
  async readdir(absPath: string): Promise<{ name: string; dir: boolean }[]> {
    const m = await this.bridge.request("oc-readdir", { path: absPath });
    return m.ok ? ((m.entries as { name: string; dir: boolean }[]) ?? []) : [];
  }
  async readFileText(absPath: string): Promise<string> {
    const m = await this.bridge.request("oc-read", { path: absPath });
    return m.ok ? String(m.contents ?? "") : "";
  }
  async pathInfo(absPath: string): Promise<{ exists: boolean; isDir: boolean }> {
    const m = await this.bridge.request("oc-stat", { path: absPath });
    return { exists: !!m.exists, isDir: !!m.isDir };
  }

  // ── workspace registry (localStorage) ──────────────────────────────────────
  private loadRegistry(): ProjectMeta[] {
    try {
      const raw = localStorage.getItem(REGISTRY_KEY);
      const list = raw ? (JSON.parse(raw) as ProjectMeta[]) : [];
      return list.sort((a, b) => b.lastModified - a.lastModified);
    } catch {
      return [];
    }
  }
  private saveRegistry(list: ProjectMeta[]) {
    const sorted = [...list].sort((a, b) => b.lastModified - a.lastModified);
    try {
      localStorage.setItem(REGISTRY_KEY, JSON.stringify(sorted));
    } catch {
      /* storage full / disabled — the in-memory list still works this session */
    }
    this.set({ recentProjects: sorted });
  }
  private upsertProjectMeta(meta: { name: string; rootPath: string; template: string | null }) {
    const now = Date.now();
    const list = this.snap.recentProjects.filter((p) => p.rootPath !== meta.rootPath);
    const existing = this.snap.recentProjects.find((p) => p.rootPath === meta.rootPath);
    list.push({
      name: meta.name,
      rootPath: meta.rootPath,
      template: meta.template,
      createdAt: existing?.createdAt ?? now,
      lastModified: now,
    });
    this.saveRegistry(list);
  }
  private touchProject(rootPath: string) {
    const list = this.snap.recentProjects.map((p) =>
      p.rootPath === rootPath ? { ...p, lastModified: Date.now() } : p,
    );
    if (list.some((p) => p.rootPath === rootPath)) this.saveRegistry(list);
  }
  removeProjectMeta(rootPath: string) {
    this.saveRegistry(this.snap.recentProjects.filter((p) => p.rootPath !== rootPath));
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
      term, fit, kind: "console", label: "Console", demo: null, cwd: null, run: null,
      pid: null, alive: true, started: true, opened: false, openedAt: 0, pendingInput: [],
    });
    this.termOrder.push("console");
  }

  // Create a shell terminal tab (defer = spawn the Process Worker lazily, off the
  // cold-boot burst; explicit New Terminal / Run start it right away). `activate`
  // = switch the panel to this terminal (false for the background boot shell).
  // `cwd`/`run` = start the shell in a project dir and (optionally) auto-run its
  // dev command (created/opened projects).
  newShellTerminal({ defer = false, demo = null, label = null, activate = true, cwd = null, run = null }: {
    defer?: boolean; demo?: string | null; label?: string | null; activate?: boolean;
    cwd?: string | null; run?: string | null;
  } = {}): string {
    const id = "sh" + ++this.termSeq;
    const { term, fit } = this.makeTerm();
    const entry: TermEntry = {
      term, fit, kind: "shell", label: label || "sh " + this.termSeq, demo, cwd, run,
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
    const cwd = entry.cwd ?? this.activeFolder?.rootPath ?? undefined;
    this.bridge.post("term-open", { terminalId: id, demo: entry.demo, cwd, run: entry.run ?? undefined });
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
    // Real language intelligence: wire Monaco's own web workers. Vite bundles each
    // `?worker` entry into a same-origin chunk (COEP-safe), and we run them
    // off-main-thread so completions, hover, signature help, go-to-definition and
    // diagnostics never block the UI. The editor worker backs cross-file services;
    // the typescript worker hosts a full TS language service (bundled TS compiler).
    const [editorWorker, tsWorker, jsonWorker, cssWorker, htmlWorker] = await Promise.all([
      import("monaco-editor/esm/vs/editor/editor.worker?worker"),
      import("monaco-editor/esm/vs/language/typescript/ts.worker?worker"),
      import("monaco-editor/esm/vs/language/json/json.worker?worker"),
      import("monaco-editor/esm/vs/language/css/css.worker?worker"),
      import("monaco-editor/esm/vs/language/html/html.worker?worker"),
    ]);
    (self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = {
      getWorker(_workerId: string, label: string): Worker {
        switch (label) {
          case "typescript":
          case "javascript":
            return new tsWorker.default();
          case "json":
            return new jsonWorker.default();
          case "css":
          case "scss":
          case "less":
            return new cssWorker.default();
          case "html":
          case "handlebars":
          case "razor":
            return new htmlWorker.default();
          default:
            return new editorWorker.default();
        }
      },
    };
    const monaco = await import("monaco-editor");
    this.monaco = monaco;
    this.configureLanguageService(monaco);
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
    // Seed the language service with any folders indexed before the editor was
    // ready (source files as models for cross-file IntelliSense; dependency types
    // as extra libs), then open whatever tab was requested during load.
    for (const list of this.fileIndex.values()) this.ensureBackgroundModels(list);
    this.scheduleDependencyTypes();
    if (this.snap.activeTab) void this.openFile(this.snap.activeTab);
  }

  // ── language service (IntelliSense) ─────────────────────────────────────────
  // Turn on the TS/JS language service: sensible compiler options, semantic +
  // syntax diagnostics, and eager model sync so every model we create (open tabs
  // AND the seeded project files) is visible to the worker for cross-file
  // completion/navigation. Installed-package types are fed in separately as extra
  // libs (see loadDependencyTypes).
  private configureLanguageService(monaco: typeof Monaco) {
    const ts = monaco.typescript; // typed re-export of the TS language contribution
    if (!ts) return;
    const compilerOptions: Monaco.typescript.CompilerOptions = {
      target: ts.ScriptTarget.ESNext,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeJs,
      jsx: ts.JsxEmit.ReactJSX,
      allowJs: true,
      checkJs: false,
      allowNonTsExtensions: true,
      allowSyntheticDefaultImports: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      skipLibCheck: true,
      // Vite templates import with explicit extensions (`import App from "./App.tsx"`);
      // allow it (requires noEmit, which the language service is anyway).
      allowImportingTsExtensions: true,
      noEmit: true,
      // NB: do NOT set an explicit `lib` array — Monaco's worker then fails to load
      // the individual lib.*.d.ts files (DOM globals, iterators… all vanish). Letting
      // `target: ESNext` pick the default `lib.esnext.full.d.ts` (which bundles ESNext
      // + DOM + iterable) is what actually works.
    };
    this.tsCompilerOptions = compilerOptions;
    for (const d of [ts.typescriptDefaults, ts.javascriptDefaults]) {
      d.setCompilerOptions(compilerOptions);
      d.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false, onlyVisible: false });
      d.setEagerModelSync(true);
    }
    // Mirror the worker's markers into a Problems count in the status bar.
    monaco.editor.onDidChangeMarkers(() => this.recomputeProblems());
  }

  private recomputeProblems() {
    if (!this.monaco) return;
    const Severity = this.monaco.MarkerSeverity;
    let errors = 0, warnings = 0;
    for (const mk of this.monaco.editor.getModelMarkers({})) {
      if (mk.severity === Severity.Error) errors++;
      else if (mk.severity === Severity.Warning) warnings++;
    }
    if (errors !== this.snap.problems.errors || warnings !== this.snap.problems.warnings) {
      this.set({ problems: { errors, warnings } });
    }
  }

  // Create Monaco models for a folder's own source files so the language service
  // can resolve cross-file imports (and power go-to-definition) even before a
  // file is opened. Bounded, and only creates models that don't already exist —
  // node_modules is excluded from the file index, so this is just user code.
  private ensureBackgroundModels(files: string[]) {
    if (!this.monaco) return;
    const monaco = this.monaco;
    let created = 0;
    for (const abs of files) {
      if (created >= 800) break;
      if (!/\.(tsx?|jsx?|mjs|cjs)$/.test(abs)) continue;
      if (this.models.has(abs) || monaco.editor.getModel(monaco.Uri.file(abs))) continue;
      created++;
      void this.seedModel(abs);
    }
  }

  private async seedModel(abs: string) {
    if (!this.monaco || this.models.has(abs)) return;
    const monaco = this.monaco;
    const uri = monaco.Uri.file(abs);
    if (monaco.editor.getModel(uri)) return;
    const text = await this.readFileText(abs);
    // The file may have been opened (→ has a real model) while we awaited the read.
    if (this.models.has(abs) || monaco.editor.getModel(uri)) return;
    monaco.editor.createModel(text, languageFor(abs), uri);
  }

  // Debounced load of dependency type declarations (node_modules **/*.d.ts +
  // package.json) into the language service as "extra libs" so imports of
  // installed packages resolve with real types. The bulk VFS scan happens in the
  // kernel worker (sole holder of the sync Wasm VFS) to avoid thousands of read
  // round-trips; we just register the returned files. Re-runs after installs
  // (every fs change re-indexes the folder, which reschedules this).
  private scheduleDependencyTypes() {
    if (!this.monaco) return;
    if (this.dtsTimer) clearTimeout(this.dtsTimer);
    this.dtsTimer = setTimeout(() => void this.loadDependencyTypes(), 1200);
  }

  private async loadDependencyTypes() {
    if (!this.monaco) return;
    const monaco = this.monaco;
    const seq = ++this.dtsSeq;
    const roots = new Set(this.snap.workspaceFolders.map((f) => f.rootPath));
    let changed = false;
    // Forget libs for roots that are no longer open.
    for (const r of [...this.depLibsByRoot.keys()]) {
      if (!roots.has(r)) { this.depLibsByRoot.delete(r); this.depsSig.delete(r); changed = true; }
    }
    // Harvest each root, passing its last node_modules fingerprint so an unchanged
    // tree short-circuits in the worker (no file reads).
    for (const root of roots) {
      const res = await this.bridge.request("oc-collect-dts", { root, sig: this.depsSig.get(root) ?? "" });
      if (seq !== this.dtsSeq) return; // a newer refresh superseded us
      if (!res.ok) continue;
      const sig = typeof res.sig === "string" ? res.sig : "";
      this.depsSig.set(root, sig);
      // sig === "" ⟺ no node_modules on disk yet. Nudge the user once (types come
      // from installed packages — nothing to resolve until deps are installed).
      if (sig === "") {
        if (!this.dtsWarnedNoNM.has(root)) {
          this.dtsWarnedNoNM.add(root);
          const nm = (res.nm as string) ?? root + "/node_modules";
          const entries = (res.rootEntries as string[]) ?? [];
          const hasNm = entries.includes("node_modules");
          this.consoleLine(`[intellisense] ${baseName(root)}: no node_modules at ${nm} — run \`npm install\` for dependency types`, "33");
          this.consoleLine(`[intellisense]   root ${root} contains: ${entries.length ? entries.slice(0, 40).join(", ") : "(empty/unreadable)"}${hasNm ? "  ← node_modules IS listed (path/mount mismatch!)" : ""}`, "90");
        }
        continue;
      }
      this.dtsWarnedNoNM.delete(root);
      if (res.unchanged) continue;
      const map = new Map<string, string>();
      for (const f of (res.files as { path: string; content: string }[]) ?? []) {
        map.set(monaco.Uri.file(f.path).toString(), f.content);
      }
      this.depLibsByRoot.set(root, map);
      changed = true;
      this.consoleLine(
        `[intellisense] ${baseName(root)}: loaded ${map.size} dependency type file(s)${res.truncated ? " (capped)" : ""}`,
        "36",
      );
    }
    if (!changed) return;
    const libs: { filePath: string; content: string }[] = [];
    for (const map of this.depLibsByRoot.values()) {
      for (const [filePath, content] of map) libs.push({ filePath, content });
    }
    monaco.typescript.typescriptDefaults.setExtraLibs(libs);
    monaco.typescript.javascriptDefaults.setExtraLibs(libs);
    // Critical: the TS worker/LanguageService was created (and validated open
    // files) BEFORE these types existed. Monaco pushes the new libs to the live
    // worker, but a worker created with an empty `node_modules` view can keep
    // serving stale "Cannot find module" results. Re-applying the compiler
    // options fires `onDidChange`, which makes Monaco's WorkerManager tear the
    // worker down; the next validation spins up a fresh LanguageService that is
    // born already seeing every dependency .d.ts — so imports resolve cleanly.
    if (this.tsCompilerOptions) {
      monaco.typescript.typescriptDefaults.setCompilerOptions(this.tsCompilerOptions);
      monaco.typescript.javascriptDefaults.setCompilerOptions(this.tsCompilerOptions);
    }
  }

  // Ensure a Monaco model exists for `abs` (loading its content from the VFS on
  // first open). Wires dirty tracking against the last-saved text.
  private async ensureModel(abs: string): Promise<Monaco.editor.ITextModel | null> {
    if (!this.monaco) return null;
    const cached = this.models.get(abs);
    if (cached) return cached;
    if (!(abs in this.localFiles)) this.localFiles[abs] = await this.readFileText(abs);
    const monaco = this.monaco;
    const uri = monaco.Uri.file(abs);
    const model =
      monaco.editor.getModel(uri) ||
      monaco.editor.createModel(this.localFiles[abs] ?? "", languageFor(abs), uri);
    model.onDidChangeContent(() => {
      const changed = model.getValue() !== (this.localFiles[abs] ?? "");
      const isDirty = this.snap.dirty.includes(abs);
      if (changed && !isDirty) this.set({ dirty: [...this.snap.dirty, abs] });
      else if (!changed && isDirty) this.set({ dirty: this.snap.dirty.filter((x) => x !== abs) });
      if (changed && this.snap.previewTab === abs) this.set({ previewTab: null }); // editing pins the tab
    });
    this.models.set(abs, model);
    return model;
  }

  // Open a file by ABSOLUTE path. `preview` (single-click from the Explorer)
  // reuses a single italic "preview" tab; a permanent open (double-click, or an
  // edit) pins it.
  async openFile(abs: string, { preview = false }: { preview?: boolean } = {}) {
    // Reconcile the tab strip + preview slot.
    const already = this.snap.openTabs.includes(abs);
    let openTabs = this.snap.openTabs;
    let previewTab = this.snap.previewTab;
    if (preview) {
      if (already) {
        // existing tab — activate it; a permanent tab stays permanent.
      } else if (previewTab && this.snap.openTabs.includes(previewTab)) {
        openTabs = this.snap.openTabs.map((t) => (t === previewTab ? abs : t)); // reuse the slot
        previewTab = abs;
      } else {
        openTabs = [...this.snap.openTabs, abs];
        previewTab = abs;
      }
    } else {
      if (!already) openTabs = [...this.snap.openTabs, abs];
      if (previewTab === abs) previewTab = null; // promote to permanent
    }
    this.set({ openTabs, previewTab, activeTab: abs });

    if (!this.editor || !this.monaco) return; // editor still loading — intent remembered
    const model = await this.ensureModel(abs);
    if (model && this.snap.activeTab === abs) {
      this.editor.setModel(model);
      this.editor.focus();
      if (this.pendingReveal && this.pendingReveal.abs === abs) {
        const r = this.pendingReveal;
        this.pendingReveal = null;
        this.revealInEditor(r.line, r.column, r.length);
      }
    }
  }

  // Open a file and jump to a 1-based line/column, selecting `length` chars (used
  // by Search results + quick-open's `:line` suffix). If the editor is still
  // loading, the reveal is remembered and applied once its model is set.
  async openFileAt(abs: string, line: number, column = 1, length = 0) {
    this.pendingReveal = { abs, line, column, length };
    await this.openFile(abs);
    if (this.pendingReveal && this.pendingReveal.abs === abs && this.editor) {
      this.pendingReveal = null;
      this.revealInEditor(line, column, length);
    }
  }

  private revealInEditor(line: number, column: number, length: number) {
    if (!this.editor || !this.monaco) return;
    const range = new this.monaco.Range(line, column, line, column + (length || 0));
    this.editor.setSelection(range);
    this.editor.revealRangeInCenterIfOutsideViewport(range);
    this.editor.focus();
  }

  // ── full-text search / replace (delegated to the kernel worker) ─────────────
  // Stream a search across every open workspace root. Results arrive via
  // `onBatch` (partial, progressive) then a final `onDone`. Returns a cancel fn.
  runSearch(
    opts: SearchOptions,
    cb: { onBatch: (files: SearchFileResult[]) => void; onDone: (d: SearchDone) => void },
  ): () => void {
    const token = ++this.searchSeq;
    this.searchCbs = { token, onBatch: cb.onBatch, onDone: cb.onDone };
    this.bridge.post("oc-search", {
      token,
      roots: this.snap.workspaceFolders.map((f) => f.rootPath),
      query: opts.query,
      matchCase: opts.matchCase,
      wholeWord: opts.wholeWord,
      regex: opts.regex,
      includeGlob: opts.includeGlob,
      excludeGlob: opts.excludeGlob,
    });
    return () => {
      if (this.searchCbs?.token === token) this.searchCbs = null;
      this.bridge.post("oc-search-cancel", {});
    };
  }

  // Apply a replacement. Scope is either a single `match`, or an explicit list of
  // `files` (Replace All / per-file). Refreshes any affected open editor models
  // from disk so the buffer + dirty state stay in sync.
  async replace(params: {
    query: string; matchCase: boolean; wholeWord: boolean; regex: boolean;
    replacement: string; preserveCase: boolean;
    files?: string[];
    match?: { file: string; line: number; column: number; length: number };
  }): Promise<{ ok: boolean; filesChanged: number; replaced: number; error?: string }> {
    const res = await this.bridge.request("oc-replace", {
      query: params.query,
      matchCase: params.matchCase,
      wholeWord: params.wholeWord,
      regex: params.regex,
      replacement: params.replacement,
      preserveCase: params.preserveCase,
      files: params.files,
      match: params.match,
    });
    if (res.ok) {
      const affected = params.match ? [params.match.file] : params.files ?? [];
      for (const abs of affected) await this.refreshFileFromDisk(abs);
    } else {
      toast.error(`Replace failed: ${res.error ?? "unknown error"}`);
    }
    return {
      ok: !!res.ok,
      filesChanged: Number(res.filesChanged ?? 0),
      replaced: Number(res.replaced ?? 0),
      error: res.error as string | undefined,
    };
  }

  // Re-sync an open model + cache with the VFS after an out-of-band write.
  private async refreshFileFromDisk(abs: string) {
    const text = await this.readFileText(abs);
    this.localFiles[abs] = text;
    const model = this.models.get(abs);
    if (model && model.getValue() !== text) model.setValue(text);
    if (this.snap.dirty.includes(abs)) this.set({ dirty: this.snap.dirty.filter((x) => x !== abs) });
  }

  // Double-clicking a preview tab (or Explorer entry) pins it permanently.
  pinTab(abs: string) {
    if (this.snap.previewTab === abs) this.set({ previewTab: null });
  }

  closeTab(abs: string) {
    const i = this.snap.openTabs.indexOf(abs);
    if (i === -1) return;
    const openTabs = this.snap.openTabs.filter((x) => x !== abs);
    const previewTab = this.snap.previewTab === abs ? null : this.snap.previewTab;
    if (this.snap.activeTab === abs) {
      const next = openTabs[i] || openTabs[i - 1] || null;
      this.set({ openTabs, previewTab, activeTab: next });
      if (next) void this.openFile(next);
      else this.editor?.setModel(null);
    } else {
      this.set({ openTabs, previewTab });
    }
  }

  // Persist a file to the VFS (⌘S, or "Save" in the close prompt). The dev server
  // hot-updates/recompiles off the resulting notifyWatch.
  saveFile(abs: string) {
    if (!this.snap.dirty.includes(abs)) return;
    const contents = this.models.get(abs)?.getValue() ?? this.localFiles[abs] ?? "";
    this.localFiles[abs] = contents;
    this.bridge.post("oc-write", { path: abs, contents });
    const folder = this.folderForPath(abs);
    if (folder) this.touchProject(folder.rootPath);
    const reload = folder ? this.folderManifests.get(folder.rootPath)?.reload : false;
    this.set({
      dirty: this.snap.dirty.filter((x) => x !== abs),
      status: reload ? `saved ${baseName(abs)} — recompiling…` : `saved ${baseName(abs)} — hot-updating…`,
    });
  }

  saveActiveFile() {
    if (this.snap.activeTab) this.saveFile(this.snap.activeTab);
  }

  // Throw away unsaved edits, reverting the model to the last-saved text.
  discardFile(abs: string) {
    const model = this.models.get(abs);
    const saved = this.localFiles[abs] ?? "";
    if (model && model.getValue() !== saved) model.setValue(saved); // fires onDidChangeContent → clears dirty
    this.set({ dirty: this.snap.dirty.filter((x) => x !== abs) });
  }

  // ── workspace folders ──────────────────────────────────────────────────────
  get activeFolder(): WorkspaceFolder | null {
    return this.snap.workspaceFolders.find((f) => f.id === this.snap.activeFolderId) ?? null;
  }
  private folderForPath(abs: string): WorkspaceFolder | null {
    let best: WorkspaceFolder | null = null;
    for (const f of this.snap.workspaceFolders) {
      if (abs === f.rootPath || abs.startsWith(f.rootPath + "/")) {
        if (!best || f.rootPath.length > best.rootPath.length) best = f;
      }
    }
    return best;
  }

  // Add a root to the workspace (or focus it if already open) and show it.
  openFolder(rootPath: string, name?: string): WorkspaceFolder {
    const root = normDir(rootPath);
    const id = folderIdFor(root);
    let folder = this.snap.workspaceFolders.find((f) => f.id === id);
    if (!folder) {
      folder = { id, name: name || baseName(root) || root, rootPath: root };
      this.set({ workspaceFolders: [...this.snap.workspaceFolders, folder] });
    }
    this.set({
      activeFolderId: id,
      view: "workspace",
      projectTitle: folder.name,
      treeVersion: this.snap.treeVersion + 1,
    });
    void this.indexFolder(root);
    return folder;
  }

  closeFolder(id: string) {
    const folder = this.snap.workspaceFolders.find((f) => f.id === id);
    if (!folder) return;
    const root = folder.rootPath;
    // Drop the folder's open tabs/models + its file index.
    for (const abs of [...this.snap.openTabs]) {
      if (abs === root || abs.startsWith(root + "/")) {
        this.disposeModel(abs);
        delete this.localFiles[abs];
      }
    }
    const keep = (p: string) => !(p === root || p.startsWith(root + "/"));
    const openTabs = this.snap.openTabs.filter(keep);
    let activeTab = this.snap.activeTab && keep(this.snap.activeTab) ? this.snap.activeTab : openTabs[openTabs.length - 1] ?? null;
    this.fileIndex.delete(root);
    this.folderManifests.delete(root);
    const folders = this.snap.workspaceFolders.filter((f) => f.id !== id);
    const activeFolderId = this.snap.activeFolderId === id ? folders[folders.length - 1]?.id ?? null : this.snap.activeFolderId;
    this.set({
      workspaceFolders: folders,
      activeFolderId,
      openTabs,
      activeTab,
      previewTab: this.snap.previewTab && keep(this.snap.previewTab) ? this.snap.previewTab : null,
      dirty: this.snap.dirty.filter(keep),
      files: this.rebuildFileIndex(),
      view: folders.length ? "workspace" : "home",
      projectTitle: folders.length ? (folders.find((f) => f.id === activeFolderId)?.name ?? null) : null,
    });
    if (activeTab) void this.openFile(activeTab);
    else this.editor?.setModel(null);
  }

  setActiveFolder(id: string) {
    const f = this.snap.workspaceFolders.find((x) => x.id === id);
    if (f) this.set({ activeFolderId: id, projectTitle: f.name });
  }

  // Recursively index a folder's files (skipping heavy dirs) for quick-open +
  // filename search. Bounded so a giant tree can't lock up the UI.
  private async indexFolder(root: string) {
    const skip = new Set(["node_modules", ".git", "dist", ".vite", ".next", "build", ".cache"]);
    const out: string[] = [];
    const walk = async (dir: string, depth: number) => {
      if (depth > 8 || out.length > 4000) return;
      const entries = await this.readdir(dir);
      for (const e of entries) {
        const abs = dir + "/" + e.name;
        if (e.dir) {
          if (!skip.has(e.name)) await walk(abs, depth + 1);
        } else {
          out.push(abs);
        }
      }
    };
    await walk(root, 0);
    this.fileIndex.set(root, out);
    this.set({ files: this.rebuildFileIndex() });
    // Feed the language service: this folder's source files (cross-file
    // IntelliSense) + a debounced refresh of installed-package types.
    this.ensureBackgroundModels(out);
    this.scheduleDependencyTypes();
  }
  private rebuildFileIndex(): string[] {
    const all: string[] = [];
    for (const list of this.fileIndex.values()) all.push(...list);
    return all.sort();
  }

  // ── project creation / opening (Home) ──────────────────────────────────────
  private slug(name: string): string {
    return name.trim().toLowerCase().replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "") || "project";
  }
  // A sensible default directory for a new project of the given name.
  defaultDirFor(name: string): string {
    return "/home/user/projects/" + this.slug(name);
  }

  // Validate a target directory for a NEW project. Returns an error string or null.
  async validateNewDir(dir: string): Promise<string | null> {
    const abs = normDir(dir);
    if (!abs.startsWith("/")) return "Path must be absolute (start with /).";
    if (abs === "/" || this.snap.workspaceFolders.some((f) => f.rootPath === abs))
      return "That directory is already open in the workspace.";
    if (this.snap.recentProjects.some((p) => p.rootPath === abs))
      return "A project already exists at that path.";
    const info = await this.pathInfo(abs);
    if (info.exists && !info.isDir) return "A file already exists at that path.";
    if (info.exists && info.isDir) {
      const entries = await this.readdir(abs);
      if (entries.length) return "That directory is not empty.";
    }
    return null;
  }

  async createBlankProject({ name, dir }: { name: string; dir: string }) {
    const root = normDir(dir);
    const files: Record<string, string> = {
      "package.json": JSON.stringify(
        { name: this.slug(name), version: "0.0.0", private: true, type: "module", scripts: { start: "node index.js" } },
        null,
        2,
      ) + "\n",
      "index.js": `console.log("Hello from ${name}!");\n`,
      "README.md": `# ${name}\n\nA blank project created in OpenContainer Studio.\n`,
    };
    const res = await this.bridge.request("oc-create-project", { dir: root, files, title: name });
    if (!res.ok) {
      toast.error(`Couldn't create project: ${res.error ?? "unknown error"}`);
      return;
    }
    this.upsertProjectMeta({ name, rootPath: root, template: null });
    this.openFolder(root, name);
    void this.openFile(root + "/index.js");
    this.set({ status: `created ${name}` });
  }

  async createFromTemplate({ templateId, name, dir, runInit }: {
    templateId: string; name: string; dir: string; runInit: boolean;
  }) {
    const t = getTemplate(templateId);
    if (!t) {
      toast.error("Unknown template");
      return;
    }
    const root = normDir(dir);
    const title = `${t.manifest.name} · ${t.manifest.language}`;
    const res = await this.bridge.request("oc-create-project", {
      dir: root,
      files: t.files,
      manifest: t.manifest,
      title,
    });
    if (!res.ok) {
      toast.error(`Couldn't create project: ${res.error ?? "unknown error"}`);
      return;
    }
    this.folderManifests.set(root, t.manifest);
    this.upsertProjectMeta({ name, rootPath: root, template: templateId });
    this.openFolder(root, name);
    void this.openFile(root + "/" + t.manifest.entry);
    if (runInit) {
      this.runProject(root);
    } else {
      this.set({ status: `${name} created — run \`${t.manifest.install}\` then \`${t.manifest.dev}\`` });
    }
  }

  // Open a previously-created project from the Home recent list.
  async openProject(meta: ProjectMeta) {
    const root = normDir(meta.rootPath);
    const info = await this.pathInfo(root);
    if (!info.exists) {
      toast.error("This project's files are no longer on disk.");
      this.removeProjectMeta(root);
      return;
    }
    if (meta.template) {
      const t = getTemplate(meta.template);
      if (t) {
        this.folderManifests.set(root, t.manifest);
        this.bridge.post("oc-register-project", { dir: root, manifest: t.manifest, title: meta.name });
      }
    }
    this.touchProject(root);
    this.openFolder(root, meta.name);
    const manifest = this.folderManifests.get(root);
    if (manifest) void this.openFile(root + "/" + manifest.entry);
  }

  // Run a project: open a shell in its dir and auto-run install && dev. Re-uses
  // the existing run terminal if it's still alive.
  runProject(rootPath: string) {
    const root = normDir(rootPath);
    const manifest = this.folderManifests.get(root);
    this.set({ panelCollapsed: false });
    const running = this.runningProjects.get(root);
    if (running && running.terminalId && this.terms.has(running.terminalId)) {
      this.switchTerminal(running.terminalId);
      if (running.port) this.pointPreview(running.port);
      return;
    }
    if (!manifest) {
      // No known dev command — just drop the user into a shell in the project.
      this.openTerminalIn(root);
      return;
    }
    const tid = this.newShellTerminal({ cwd: root, run: manifest.dev, label: manifest.dev });
    this.runningProjects.set(root, { terminalId: tid, port: null });
    this.set({ status: "installing from npm + booting in-VM…" });
  }

  // Run the currently-focused folder (TitleBar / command palette Run).
  runActiveFolder() {
    const f = this.activeFolder;
    if (f) this.runProject(f.rootPath);
    else toast.error("Open a project first");
  }

  // Open a new terminal rooted at `absDir` (Explorer "Open in Integrated Terminal").
  openTerminalIn(absDir: string) {
    const dir = normDir(absDir);
    this.set({ panelCollapsed: false });
    this.newShellTerminal({ cwd: dir, label: baseName(dir) || "sh", activate: true });
  }

  goHome() {
    this.set({ view: "home" });
  }
  showWorkspace() {
    if (this.snap.workspaceFolders.length) this.set({ view: "workspace" });
  }

  // ── file operations (Explorer) — all absolute-path based ──────────────────
  private disposeModel(abs: string) {
    const model = this.models.get(abs);
    if (!model) return;
    if (this.editor && this.editor.getModel() === model) this.editor.setModel(null);
    model.dispose();
    this.models.delete(abs);
  }

  private bumpTree() {
    if (this.treeBump) clearTimeout(this.treeBump);
    this.treeBump = setTimeout(() => {
      this.treeBump = null;
      const root = this.activeFolder?.rootPath;
      if (root) void this.indexFolder(root);
      this.set({ treeVersion: this.snap.treeVersion + 1 });
    }, 60);
  }

  // Remap every open path that is `oldAbs` (or lives under it) onto `newAbs`.
  private remapOpenPaths(oldAbs: string, newAbs: string) {
    const map = (p: string) =>
      p === oldAbs ? newAbs : p.startsWith(oldAbs + "/") ? newAbs + p.slice(oldAbs.length) : p;
    for (const abs of this.snap.openTabs) {
      if (abs === oldAbs || abs.startsWith(oldAbs + "/")) {
        const dest = map(abs);
        this.disposeModel(abs);
        if (abs in this.localFiles) { this.localFiles[dest] = this.localFiles[abs]; delete this.localFiles[abs]; }
      }
    }
    this.set({
      openTabs: this.snap.openTabs.map(map),
      activeTab: this.snap.activeTab ? map(this.snap.activeTab) : null,
      previewTab: this.snap.previewTab ? map(this.snap.previewTab) : null,
      dirty: this.snap.dirty.map(map),
    });
    if (this.snap.activeTab) void this.openFile(this.snap.activeTab, { preview: this.snap.previewTab === this.snap.activeTab });
  }

  private dropOpenPaths(abs: string) {
    const affected = new Set(this.snap.openTabs.filter((p) => p === abs || p.startsWith(abs + "/")));
    for (const p of affected) { this.disposeModel(p); delete this.localFiles[p]; }
    const openTabs = this.snap.openTabs.filter((p) => !affected.has(p));
    let activeTab = this.snap.activeTab;
    if (activeTab && affected.has(activeTab)) activeTab = openTabs[openTabs.length - 1] ?? null;
    this.set({
      openTabs,
      activeTab,
      previewTab: this.snap.previewTab && affected.has(this.snap.previewTab) ? null : this.snap.previewTab,
      dirty: this.snap.dirty.filter((p) => !affected.has(p)),
    });
    if (activeTab) void this.openFile(activeTab);
    else this.editor?.setModel(null);
  }

  copyEntry(abs: string) { this.set({ clipboard: { mode: "copy", abs } }); }
  cutEntry(abs: string) { this.set({ clipboard: { mode: "cut", abs } }); }

  renameEntry(oldAbs: string, newName: string) {
    const name = newName.trim();
    if (!name || name === baseName(oldAbs)) return;
    const parent = oldAbs.slice(0, oldAbs.lastIndexOf("/"));
    const newAbs = parent + "/" + name;
    this.bridge.post("oc-rename", { from: oldAbs, to: newAbs });
    this.remapOpenPaths(oldAbs, newAbs);
    if (this.snap.clipboard?.abs === oldAbs) this.set({ clipboard: null });
    this.bumpTree();
  }

  deleteEntry(abs: string) {
    this.bridge.post("oc-rm", { path: abs });
    this.dropOpenPaths(abs);
    if (this.snap.clipboard?.abs === abs) this.set({ clipboard: null });
    this.bumpTree();
  }

  // Paste the clipboard entry into `destDirAbs`.
  async pasteInto(destDirAbs: string) {
    const cb = this.snap.clipboard;
    if (!cb) return;
    const dest = normDir(destDirAbs);
    const name = baseName(cb.abs);
    // Cutting a folder into itself/descendant would be invalid — ignore.
    if (cb.mode === "cut" && (dest === cb.abs || dest.startsWith(cb.abs + "/"))) return;
    let target = dest + "/" + name;
    // Avoid clobbering: append -copy, -copy-2, … until the path is free.
    if ((await this.pathInfo(target)).exists) {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      for (let n = 1; ; n++) {
        const cand = `${dest}/${stem}-copy${n > 1 ? `-${n}` : ""}${ext}`;
        if (!(await this.pathInfo(cand)).exists) { target = cand; break; }
      }
    }
    if (cb.mode === "copy") {
      this.bridge.post("oc-copy", { from: cb.abs, to: target });
    } else {
      this.bridge.post("oc-rename", { from: cb.abs, to: target });
      this.remapOpenPaths(cb.abs, target);
      this.set({ clipboard: null });
    }
    this.bumpTree();
  }

  // Create an empty file / folder (Explorer "New File" / "New Folder").
  async newFile(destDirAbs: string, name: string) {
    const clean = name.trim();
    if (!clean) return;
    const abs = normDir(destDirAbs) + "/" + clean;
    if ((await this.pathInfo(abs)).exists) { toast.error(`"${clean}" already exists`); return; }
    await this.bridge.request("oc-write", { path: abs, contents: "" });
    this.bumpTree();
    void this.openFile(abs);
  }
  async newFolder(destDirAbs: string, name: string) {
    const clean = name.trim();
    if (!clean) return;
    const abs = normDir(destDirAbs) + "/" + clean;
    if ((await this.pathInfo(abs)).exists) { toast.error(`"${clean}" already exists`); return; }
    await this.bridge.request("oc-mkdirp", { path: abs });
    this.bumpTree();
  }

  copyPath(abs: string) {
    try {
      void navigator.clipboard?.writeText(abs);
      this.set({ status: `copied path: ${abs}` });
    } catch {
      toast.error("Clipboard unavailable");
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

  // Push the set of in-VM ports that serve UNDER the /preview/<port>/ prefix
  // (keep-prefix templates) to the preview Service Worker, so it doesn't strip the
  // prefix for them. Recomputed from the live run manifests whenever a project's
  // server starts or stops.
  private syncKeepPrefixPorts() {
    const ports: number[] = [];
    for (const [dir, r] of this.runningProjects) {
      if (r.port != null && this.folderManifests.get(dir)?.keepPreviewPrefix) ports.push(r.port);
    }
    this.bridge.setKeepPrefixPorts(ports);
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

  // ── demo run (legacy built-in examples) ────────────────────────────────────
  setSelectedDemo(id: string) {
    this.set({ selectedDemo: id });
  }
  runDemo() {
    const demo = this.snap.selectedDemo;
    this.set({ panelCollapsed: false, view: "workspace" });
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
    // The kernel + VFS are up (before the PM tarballs finish loading) — the Home
    // screen can create/open projects now, so don't make the user wait for `ready`.
    b.on("kernel-online", () => this.set({ kernelReady: true }));
    b.on("ready", () => {
      this.consoleLine("Kernel ready.", "32");
      this.set({ booted: true, kernelReady: true, status: "ready — create or open a project" });
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
      // A process finished — it may have been `npm/yarn/pnpm install`. In-VM writes
      // don't emit oc-fs-changed, so re-harvest dependency types (debounced; the
      // worker short-circuits via a node_modules fingerprint when nothing changed).
      this.scheduleDependencyTypes();
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
      // A created/opened project's run tab ended → server gone.
      for (const [dir, r] of this.runningProjects) {
        if (r.terminalId === id) {
          this.runningProjects.delete(dir);
          if (r.port != null && this.portMap.delete(r.port)) this.syncPorts();
          this.syncKeepPrefixPorts();
          if (r.port != null && this.snap.previewTabs.some((t) => t.port === r.port))
            this.set({ status: "dev server stopped — preview will 502 until you Run again" });
        }
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

    // Legacy built-in demo became ready.
    b.on("demo-ready", (m) => {
      this.pointPreview(m.port as number);
      const r = this.runningDemos.get(m.id as string);
      if (r) r.port = m.port as number;
      else this.runningDemos.set(m.id as string, { terminalId: null, port: m.port as number });
      const dir = m.dir as string;
      const runLabel = DEMOS.find((d) => d.id === m.id)?.runLabel ?? "npm run dev";
      this.folderManifests.set(normDir(dir), {
        id: m.id as string, framework: "react", name: m.title as string, language: "JavaScript",
        icon: "react", category: "Frontend", description: "", port: m.port as number,
        openPath: "/", entry: m.entry as string,
        hmr: !!m.hmr, reload: !!m.reload, install: "npm install", dev: runLabel,
      });
      this.openFolder(dir, m.title as string);
      if (m.entry) void this.openFile(dir + "/" + (m.entry as string));
      this.set({
        status: m.reload ? `${m.title} running — edits recompile + restart` : `${m.title} running — edits hot-reload`,
      });
    });
    b.on("demo-reload", (m) => {
      for (const t of this.snap.previewTabs) if (t.port === m.port) this.reloadPreviewTab(t.id);
      this.set({ status: `${m.title} restarted — preview reloaded` });
    });
    b.on("demo-status", (m) => this.set({ status: m.line as string }));

    // A created/opened project's dev server is up.
    b.on("project-ready", (m) => {
      const dir = normDir(m.dir as string);
      // An EXTRA service of a multi-server project (e.g. a backend/ws server
      // alongside the frontend): just add its preview tab — the primary already
      // opened the folder + entry file.
      if (m.extra) {
        this.pointPreview(m.port as number);
        this.set({ status: `${m.title as string}: service on :${m.port} ready` });
        return;
      }
      const r = this.runningProjects.get(dir);
      if (r) r.port = m.port as number;
      else this.runningProjects.set(dir, { terminalId: null, port: m.port as number });
      // Tell the SW whether this port serves under the /preview/<port>/ prefix
      // (keep-prefix templates like Docusaurus) BEFORE the iframe loads, so a
      // client-routed SPA resolves its first route instead of hitting NotFound.
      this.syncKeepPrefixPorts();
      this.pointPreview(m.port as number);
      if (!this.snap.workspaceFolders.some((f) => f.rootPath === dir)) this.openFolder(dir, m.title as string);
      if (m.entry) void this.openFile(dir + "/" + (m.entry as string));
      this.touchProject(dir);
      this.set({
        status: m.reload ? `${m.title} running — edits recompile + restart` : `${m.title} running — edits hot-reload`,
      });
    });
    b.on("project-reload", (m) => {
      for (const t of this.snap.previewTabs) if (t.port === m.port) this.reloadPreviewTab(t.id);
      this.set({ status: `${m.title} restarted — preview reloaded` });
    });

    // Streaming full-text search: batches of per-file results, then a final done.
    // Ignore stale tokens (a newer query already superseded this one).
    b.on("oc-search-result", (m) => {
      if (this.searchCbs && m.token === this.searchCbs.token) {
        this.searchCbs.onBatch((m.files as SearchFileResult[]) ?? []);
      }
    });
    b.on("oc-search-done", (m) => {
      if (this.searchCbs && m.token === this.searchCbs.token) {
        const cbs = this.searchCbs;
        this.searchCbs = null;
        cbs.onDone({
          matchCount: Number(m.matchCount ?? 0),
          fileCount: Number(m.fileCount ?? 0),
          limitHit: !!m.limitHit,
          error: m.error as string | undefined,
        });
      }
    });

    // The VFS changed under us (a file op, an install, a create) — refresh the
    // Explorer's live tree + re-index the active folder for quick-open/search.
    b.on("oc-fs-changed", () => this.bumpTree());

    // Result of an Explorer file operation (rename/rm/copy). The UI already updated
    // optimistically; surface any failure so the user knows the VFS is out of sync.
    b.on("oc-fs-result", (m) => {
      if (!m.ok) toast.error(`${m.op} failed: ${m.error ?? "unknown error"}`);
    });
  }
}
