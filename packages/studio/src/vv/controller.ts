// IDE controller — the imperative core, ported from the original raw-ESM demo UI (host.js).
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
import { KernelBridge, resetVfs } from "./kernel";
import { DebugSession } from "./debug-session";
import { getTemplate, type TemplateManifest } from "./templates";
import { createZip, encodeShare, decodeShare } from "../../../kernel-host/archive.js";
import {
  parseGithubSpec, fetchGithubRepo, parseNpmSpec, fetchNpmPackage, type ProgressFn,
} from "./import-remote";

// Validate + normalize the build-time VITE_PREVIEW_ORIGIN (mode B). Returns the
// bare origin (scheme+host+port) of a same-scheme, cross-origin absolute URL, or
// undefined for anything falsy / malformed / same-origin (→ mode A, the default).
function normalizePreviewOrigin(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const origin = new URL(raw).origin;
    if (typeof location !== "undefined" && origin === location.origin) return undefined;
    return origin;
  } catch {
    return undefined;
  }
}

// Build-time pop-out behavior (VITE_PREVIEW_POPOUT). Anything other than the
// explicit "isolated" opt-in falls back to the frictionless same-origin default.
function normalizePreviewPopout(raw: string | undefined): "same-origin" | "isolated" {
  return raw === "isolated" ? "isolated" : "same-origin";
}

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
  paths: string[]; // absolute paths of the copied/cut entries (multi-select)
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
  title?: string; // the running app's real document.title (reported by the preview)
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
  // Cold-boot progress shown on Home until `kernelReady`. `bootPhase` is one of
  // "init" | "restore" | "finalize" (""=not started); during "restore",
  // bootDone/bootTotal drive a determinate progress bar (OPFS re-hydration).
  bootPhase: string;
  bootDone: number;
  bootTotal: number;
  status: string;
  cwd: string;
  view: "home" | "workspace";
  // A shared link (#share=) is bootstrapping: show a full-screen blocking overlay.
  shareLoading: boolean;
  shareMessage: string;
  // The "Import from GitHub or npm" dialog is open.
  importRemoteOpen: boolean;
  projectTitle: string | null;
  workspaceFolders: WorkspaceFolder[];
  activeFolderId: string | null;
  recentProjects: ProjectMeta[];
  treeVersion: number; // bump to make the Explorer re-read expanded dirs
  files: string[]; // absolute paths (flat index for quick-open + search)
  openTabs: string[]; // absolute paths
  activeTab: string | null;
  tabKinds: Record<string, "text" | "image" | "directory">; // how each open tab renders
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
  activeView: "explorer" | "search" | "debug";
  sidebarCollapsed: boolean;
  panelCollapsed: boolean;
  panelTab: "console" | "terminal" | "ports";
  clipboard: Clipboard | null;
  paletteOpen: boolean;
  paletteMode: "command" | "file";
  problems: { errors: number; warnings: number }; // live TS/JS diagnostics (status bar)
  memInfo: MemInfo | null; // last "Measure Memory" result (StatusBar readout)
}

// A snapshot of the tab's memory, produced by measureMemory(). `total` is the
// whole-page estimate (performance.measureUserAgentSpecificMemory, which covers
// dedicated workers); `vfsBytes`/`vfsFiles` are the VFS's in-RAM content size
// reported by the File System Worker. `measuring` gates the StatusBar spinner.
export interface MemInfo {
  total: number | null;
  vfsBytes: number;
  vfsFiles: number;
  // Uncompressed VFS footprint; equals vfsBytes when compression is off. When
  // compression is on, vfsBytes/vfsLogicalBytes is the realized ratio.
  vfsLogicalBytes: number;
  ts: number;
}

// Per-Process-Worker memory row for the "Measure Memory" breakdown. `heap` is the
// worker's own JS heap (performance.memory, Chrome-only; -1 if unavailable),
// `modules` the guest module-cache entry count, `esbuildInproc` whether it hosts
// the resident esbuild Go wasm service.
export interface ProcMem {
  pid: number;
  name: string;
  heap: number;
  modules: number;
  esbuildInproc: boolean;
  // Bytes of the in-process esbuild Go wasm heap (0 if not hosted in this PID).
  esbuildBytes: number;
}

// Render the esbuild-wasm annotation for a per-PID memory row: the resident Go
// heap size when known (grows-and-stays for the worker's life), else just a flag.
function esbuildLabel(p: ProcMem): string {
  if (!p.esbuildInproc) return "";
  const bytes = Number(p.esbuildBytes);
  return bytes > 0 ? `, esbuild-wasm ${fmtBytes(bytes)}` : ", esbuild-wasm";
}

const TERM_THEME_DARK = {
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

// Light terminal palette mirrors VS Code's default light theme so the terminal
// stays legible when the UI switches to light mode.
const TERM_THEME_LIGHT = {
  background: "#ffffff",
  foreground: "#3b3b3b",
  cursor: "#3b3b3b",
  selectionBackground: "#add6ff",
  black: "#000000", red: "#cd3131", green: "#00bc00", yellow: "#949800",
  blue: "#0451a5", magenta: "#bc05bc", cyan: "#0598bc", white: "#555555",
  brightBlack: "#666666", brightRed: "#cd3131", brightGreen: "#14ce14",
  brightYellow: "#b5ba00", brightBlue: "#0451a5", brightMagenta: "#bc05bc",
  brightCyan: "#0598bc", brightWhite: "#a5a5a5",
};

type UiTheme = "light" | "dark";
const termThemeFor = (t: UiTheme) => (t === "light" ? TERM_THEME_LIGHT : TERM_THEME_DARK);
const monacoThemeFor = (t: UiTheme) => (t === "light" ? "vs" : "vs-dark");

const ESC = "\x1b[";
const REGISTRY_KEY = "vv-workspace-projects";

const baseName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const parentOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

// Drag-and-drop wire format: an internal Explorer drag carries the source's
// absolute path under this MIME type; an OS drag carries File entries instead.
export const VV_PATH_MIME = "application/x-vv-path";

// A flat, path-keyed file tree used by import/export/share.
export type FileTree = { path: string; bytes: Uint8Array }[];

// The result of reading an OS folder/drop into a project tree: the files plus a
// flag noting whether a (skipped) node_modules was present, so import can say so.
export type ImportTree = { name: string; files: FileTree; excludedNodeModules: boolean };

// Practical cap on a shareable-URL length; beyond this the link is unwieldy.
const MAX_SHARE_URL_LEN = 1_800_000;

// True when the current URL carries a #share= payload (opened a shared link).
function hasSharePayload(): boolean {
  return typeof location !== "undefined" && (location.hash || "").includes("#share=");
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Download an in-memory Blob to the user's disk (zip export).
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Never import these into a project — at ANY depth (monorepos have many nested
// node_modules), since they're regenerated, huge, or VCS metadata.
function skipImportPath(path: string): boolean {
  return path.split("/").some((seg) => seg === "node_modules" || seg === ".git");
}
function hasNodeModules(path: string): boolean {
  return path.split("/").some((seg) => seg === "node_modules");
}

// Read a <input type="file" webkitdirectory> selection into a flat file tree.
// webkitRelativePath is "<pickedDir>/a/b.js"; strip the leading picked-dir
// segment so the project root holds a/b.js directly. Returns a suggested name.
export async function treeFromFileList(list: FileList): Promise<ImportTree> {
  let top = "";
  let excludedNodeModules = false;
  const files: FileTree = [];
  for (const file of Array.from(list)) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    const parts = rel.split("/").filter(Boolean);
    if (parts.length > 1 && !top) top = parts[0];
    const path = parts.length > 1 && parts[0] === top ? parts.slice(1).join("/") : rel;
    if (!path || skipImportPath(path)) {
      if (path && hasNodeModules(path)) excludedNodeModules = true;
      continue;
    }
    files.push({ path, bytes: new Uint8Array(await file.arrayBuffer()) });
  }
  return { name: top || "imported-project", files, excludedNodeModules };
}

// Read an OS drop (DataTransfer entries) into a flat file tree. A single dropped
// folder becomes the project; loose files / multiple items land at the root.
export async function treeFromDrop(entries: FileSystemEntry[]): Promise<ImportTree> {
  const files: FileTree = [];
  let excludedNodeModules = false;
  const single = entries.length === 1 && entries[0].isDirectory ? entries[0] : null;
  const roots = single ? await readDirEntries(single as FileSystemDirectoryEntry) : entries;
  const walk = async (entry: FileSystemEntry, prefix: string): Promise<void> => {
    const path = prefix ? prefix + "/" + entry.name : entry.name;
    if (skipImportPath(path)) {
      if (hasNodeModules(path)) excludedNodeModules = true;
      return;
    }
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      files.push({ path, bytes: new Uint8Array(await file.arrayBuffer()) });
    } else if (entry.isDirectory) {
      const children = await readDirEntries(entry as FileSystemDirectoryEntry);
      for (const c of children) await walk(c, path);
    }
  };
  for (const r of roots) await walk(r, "");
  return { name: single ? single.name : "imported-project", files, excludedNodeModules };
}

// Extract OS FileSystemEntry objects from a drop's DataTransfer. MUST be called
// SYNCHRONOUSLY inside the drop handler — the DataTransferItemList (and thus
// webkitGetAsEntry) is invalidated once the handler yields to an await.
export function entriesFromDataTransfer(dt: DataTransfer): FileSystemEntry[] {
  const out: FileSystemEntry[] = [];
  const items = dt.items;
  if (!items) return out;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind !== "file") continue;
    const entry = (it as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.();
    if (entry) out.push(entry);
  }
  return out;
}

// Read every child of a directory entry (createReader is paginated — keep
// reading until a batch comes back empty).
function readDirEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    const readBatch = () =>
      reader.readEntries((batch) => {
        if (!batch.length) { resolve(all); return; }
        all.push(...batch);
        readBatch();
      }, reject);
    readBatch();
  });
}
// Human-readable byte size for the memory readout (MB/GB with one decimal).
export const fmtBytes = (n: number): string => {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
};
const normDir = (p: string) => {
  const n = "/" + p.split("/").filter((s) => s && s !== ".").join("/");
  return n === "/" ? "/" : n.replace(/\/+$/, "");
};
const folderIdFor = (rootPath: string) => "wf:" + rootPath;

// Extensions we render in the image viewer instead of the text editor. SVG is
// grouped here too (it's an image); flip it to text if you'd rather edit it.
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "avif", "svg"]);
function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot > 0 && IMAGE_EXTS.has(path.slice(dot + 1).toLowerCase());
}
// The MIME type for an image path, so the viewer's Blob renders correctly.
function imageMime(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "svg") return "image/svg+xml";
  if (ext === "jpg") return "image/jpeg";
  if (ext === "ico") return "image/x-icon";
  return "image/" + ext;
}

function languageFor(path: string): string {
  // JS files use the `typescript` language too (the TS worker handles JS via
  // allowJs). This runs ONE language service instead of a second full ~310 MB
  // `javascript` ts.worker fed the same dependency .d.ts payload. See
  // configureLanguageService.
  if (/\.(tsx?|jsx?|mjs|cjs)$/.test(path)) return "typescript";
  if (/\.css$/.test(path)) return "css";
  if (/\.(html?|vue|svelte)$/.test(path)) return "html";
  if (/\.json$/.test(path)) return "json";
  if (/\.md$/.test(path)) return "markdown";
  // Python: Monaco's bundled Monarch grammar highlights on the main thread — no
  // dedicated worker/language service (we don't ship a python.worker).
  if (/\.pyi?$/.test(path)) return "python";
  return "plaintext";
}

interface TermEntry {
  term: Terminal;
  fit: FitAddon;
  kind: "console" | "shell";
  label: string;
  demo: string | null;
  cwd: string | null;
  run: string | null; // explicit VV_RUN (created/opened project run shells)
  pid: number | null;
  alive: boolean;
  started: boolean;
  opened: boolean;
  openedAt: number;
  pendingInput: string[];
}

export class IdeController {
  readonly bridge: KernelBridge;
  // Breakpoint debugger session (CDP client for Node guest targets). Drives the
  // Monaco gutter breakpoints, paused-line highlight, and the Debug panel.
  readonly debug: DebugSession;

  // ── external store ──
  private listeners = new Set<() => void>();
  private snap: IdeSnapshot = {
    booted: false,
    kernelReady: false,
    bootPhase: "init",
    bootDone: 0,
    bootTotal: 0,
    status: "booting…",
    cwd: "",
    // A shared link lands straight on the (loading) workspace, never Home — so the
    // user can't accidentally start a new project while it bootstraps.
    view: hasSharePayload() ? "workspace" : "home",
    shareLoading: hasSharePayload(),
    shareMessage: "Booting the runtime…",
    importRemoteOpen: false,
    projectTitle: null,
    workspaceFolders: [],
    activeFolderId: null,
    recentProjects: [],
    treeVersion: 0,
    files: [],
    openTabs: [],
    activeTab: null,
    tabKinds: {},
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
    memInfo: null,
  };

  // ── imperative state (not reactive) ──
  private terms = new Map<string, TermEntry>();
  private termOrder: string[] = [];
  private termSeq = 0;
  private monaco: typeof Monaco | null = null;
  private editor: Monaco.editor.IStandaloneCodeEditor | null = null;
  private editorMounting = false; // guards the async create against StrictMode double-mount
  private editorOpener: Monaco.IDisposable | null = null; // cross-file go-to-definition hook
  private models = new Map<string, Monaco.editor.ITextModel>(); // abs -> model
  private imageUrls = new Map<string, string>(); // abs -> object URL (image viewer)
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
  // Current resolved UI theme, seeded from the pre-paint <html> class the
  // no-flash script sets, then kept in sync with next-themes via applyUiTheme.
  private uiTheme: UiTheme =
    typeof document !== "undefined" && document.documentElement.classList.contains("dark")
      ? "dark"
      : "light";

  // Mode B (separate preview origin): configured at build time via
  // VITE_PREVIEW_ORIGIN. Empty in the default same-origin deploy + local dev, so
  // preview URLs stay relative and nothing changes. When set, previews are served
  // from that origin (see KernelBridge.previewBase) for IDE↔preview isolation.
  private readonly previewBase: string;
  // Mode B pop-out behavior. When true, "Open in new tab" opens on the isolated
  // preview origin (behind a connect gate); otherwise it opens same-origin with
  // the IDE. Always false in mode A. See normalizePreviewPopout / openExternalPreview.
  private readonly popoutIsolated: boolean;

  constructor() {
    const previewOrigin = normalizePreviewOrigin(import.meta.env.VITE_PREVIEW_ORIGIN);
    const previewPopout = normalizePreviewPopout(import.meta.env.VITE_PREVIEW_POPOUT);
    this.bridge = new KernelBridge({ previewOrigin, previewPopout });
    this.previewBase = this.bridge.previewBase;
    this.popoutIsolated = this.bridge.popoutIsolated;
    this.debug = new DebugSession(this.bridge);
    // When execution pauses (or a frame is selected), open the file + reveal the line.
    this.debug.onReveal = (path, line) => void this.openFileAt(path, line);
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
    // Opened via a shared link: show a full-screen blocking overlay immediately so
    // the (blank) workspace doesn't look idle while the kernel boots + unpacks.
    if (hasSharePayload()) {
      this.set({ status: "opening shared project…", shareLoading: true, shareMessage: "Booting the runtime…" });
    }
    const ok = await this.bridge.registerServiceWorker();
    this.consoleLine(
      ok ? "Service Worker registered (preview proxy ready)." : "Service workers unavailable — preview disabled.",
      ok ? "32" : "31",
    );
    this.bridge.boot();
  }

  // ── VFS queries (request/response over the bridge) ─────────────────────────
  async readdir(absPath: string): Promise<{ name: string; dir: boolean }[]> {
    const m = await this.bridge.request("vv-readdir", { path: absPath });
    return m.ok ? ((m.entries as { name: string; dir: boolean }[]) ?? []) : [];
  }
  async readFileText(absPath: string): Promise<string> {
    const m = await this.bridge.request("vv-read", { path: absPath });
    return m.ok ? String(m.contents ?? "") : "";
  }
  async readFileBytes(absPath: string): Promise<Uint8Array> {
    const m = await this.bridge.request("vv-read-bytes", { path: absPath });
    return m.ok && m.bytes instanceof Uint8Array ? m.bytes : new Uint8Array();
  }
  // The object URL for an open image tab (created lazily in openEntry).
  imageUrlFor(abs: string): string | undefined {
    return this.imageUrls.get(abs);
  }
  async pathInfo(absPath: string): Promise<{ exists: boolean; isDir: boolean }> {
    const m = await this.bridge.request("vv-stat", { path: absPath });
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

  // Switch the editor + all live terminals to the given resolved theme. Called
  // from a React effect that mirrors next-themes' resolvedTheme.
  applyUiTheme(theme: UiTheme) {
    if (theme === this.uiTheme) return;
    this.uiTheme = theme;
    this.monaco?.editor.setTheme(monacoThemeFor(theme));
    const termTheme = termThemeFor(theme);
    for (const { term } of this.terms.values()) {
      term.options.theme = termTheme;
    }
  }

  private makeTerm(): { term: Terminal; fit: FitAddon } {
    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      // Each terminal retains `scrollback` lines of parsed buffer; with several
      // terminals (console + shells) 8000 each adds up. 2000 keeps ample history
      // while cutting the per-terminal buffer footprint.
      fontSize: 12.5,
      scrollback: 2000,
      theme: termThemeFor(this.uiTheme),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Cmd+K (macOS) / Ctrl+K (Win/Linux) clears the focused terminal, mirroring
    // VS Code's integrated terminal. Scoped to the focused xterm (not a global
    // shortcut) so it never clobbers the editor's Cmd+K chord bindings.
    term.attachCustomKeyEventHandler((e) => {
      if (
        e.type === "keydown" &&
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        !e.shiftKey &&
        e.key.toLowerCase() === "k"
      ) {
        term.clear();
        return false;
      }
      return true;
    });
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

  setActiveView(view: "explorer" | "search" | "debug") {
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
    this.wireGoToDefinition(monaco);
    this.editor = monaco.editor.create(el, {
      model: null,
      theme: monacoThemeFor(this.uiTheme),
      automaticLayout: true,
      fontSize: 13,
      // Minimap renders (and retains) a second tokenized view of the whole file;
      // disabling it trims per-editor memory at no real usability cost here.
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      tabSize: 2,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      // Go-to-definition should NAVIGATE, not peek. The Peek widget's preview pane
      // can only render an existing Monaco model, but dependency types live only as
      // extra libs (see loadDependencyTypes) — never as models — so peeking a
      // node_modules definition shows an empty preview. Jumping straight to the
      // first location routes through our editor opener, which reads the target
      // from the VFS and opens it as a real tab (so .d.ts targets render fine).
      gotoLocation: {
        multipleDefinitions: "goto",
        multipleTypeDefinitions: "goto",
        multipleDeclarations: "goto",
        multipleImplementations: "goto",
      },
      // We handle drops onto the editor ourselves (open the dropped entry), so
      // turn off Monaco's built-in "drop text into the buffer" behavior.
      dropIntoEditor: { enabled: false },
      // Breakpoint debugger: the glyph margin hosts breakpoint dots + the paused
      // arrow, and a click there toggles a breakpoint (see DebugSession).
      glyphMargin: true,
      // Don't over-reserve the line-number column (Monaco defaults to 5 chars,
      // which right-aligns single digits and leaves a big gap to their left).
      lineNumbersMinChars: 2,
    });
    // Breakpoint debugger: wire gutter breakpoints + paused-line decorations.
    this.debug.attachEditor(this.editor, monaco);
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
    // Run a SINGLE TS language service. Every JS/TS model uses the `typescript`
    // language (see languageFor) with allowJs, so only the `typescript` ts.worker
    // ever spawns. Monaco otherwise runs a SECOND full language service for the
    // `javascript` mode — a duplicate ~310 MB worker fed the same dependency
    // .d.ts payload. Keep the `javascript` defaults inert (diagnostics off, no
    // eager sync, no extra libs) so its WorkerManager — created lazily on first
    // JS-model use — never starts.
    ts.typescriptDefaults.setCompilerOptions(compilerOptions);
    ts.typescriptDefaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false, onlyVisible: false });
    ts.typescriptDefaults.setEagerModelSync(true);
    ts.javascriptDefaults.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true, onlyVisible: false });
    ts.javascriptDefaults.setEagerModelSync(false);
    // Mirror the worker's markers into a Problems count in the status bar.
    monaco.editor.onDidChangeMarkers(() => this.recomputeProblems());
  }

  // Wire cross-file "go to definition" (⌘/Ctrl+click, F12) into our tab system.
  // A Monaco standalone editor does NOTHING for a resource other than the model
  // it currently has attached unless an opener is registered — so a definition in
  // another file (or an installed package's .d.ts) silently no-ops. We intercept
  // it and route through openFileAt, which opens/activates the React tab AND
  // reveals the target line/column. (Same-file definitions are handled by Monaco
  // internally and never reach this hook.)
  private wireGoToDefinition(monaco: typeof Monaco) {
    if (this.editorOpener) return;
    this.editorOpener = monaco.editor.registerEditorOpener({
      openCodeEditor: (_source, resource, selectionOrPosition) => {
        const abs = resource.path; // Uri.file(abs).path === abs
        let line = 1, column = 1, length = 0;
        if (selectionOrPosition) {
          if ("startLineNumber" in selectionOrPosition) {
            line = selectionOrPosition.startLineNumber;
            column = selectionOrPosition.startColumn;
            if (selectionOrPosition.endLineNumber === selectionOrPosition.startLineNumber) {
              length = selectionOrPosition.endColumn - selectionOrPosition.startColumn;
            }
          } else {
            line = selectionOrPosition.lineNumber;
            column = selectionOrPosition.column;
          }
        }
        void this.openFileAt(abs, line, column, length);
        return true; // handled — suppress Monaco's default no-op
      },
    });
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
      const res = await this.bridge.request("vv-collect-dts", { root, sig: this.depsSig.get(root) ?? "" });
      if (seq !== this.dtsSeq) return; // a newer refresh superseded us
      if (!res.ok) continue;
      const sig = typeof res.sig === "string" ? res.sig : "";
      this.depsSig.set(root, sig);
      // sig === "" ⟺ no node_modules on disk yet. Nudge the user once (types come
      // from installed packages — nothing to resolve until deps are installed).
      if (sig === "") {
        if (!this.dtsWarnedNoNM.has(root)) {
          this.dtsWarnedNoNM.add(root);
          this.consoleLine(`[intellisense] ${baseName(root)}: no node_modules yet — run \`npm install\` for dependency types`, "33");
        }
        continue;
      }
      this.dtsWarnedNoNM.delete(root);
      if (res.unchanged) continue;
      const map = new Map<string, string>();
      for (const f of (res.files as { path: string; content: string }[]) ?? []) {
        // toString(TRUE) = skip encoding. Monaco's Uri.toString() percent-encodes
        // '@' → '%40', but TS's module resolver looks up '@types/…'/'@scope/…'
        // with a LITERAL '@'. Encoded keys never match the resolver's queries, so
        // every @types-backed import (react, react-dom, jsx-runtime) fails. Keep
        // '@' literal so extra-lib keys line up with what the worker asks for.
        map.set(monaco.Uri.file(f.path).toString(true), f.content);
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
    // Only the `typescript` service is live (see configureLanguageService), so
    // feed the dependency .d.ts to it alone — no duplicate payload to a second
    // worker.
    monaco.typescript.typescriptDefaults.setExtraLibs(libs);
    // Critical: the TS worker/LanguageService was created (and validated open
    // files) BEFORE these types existed. Monaco pushes the new libs to the live
    // worker, but a worker created with an empty `node_modules` view can keep
    // serving stale "Cannot find module" results. Re-applying the compiler
    // options fires `onDidChange`, which makes Monaco's WorkerManager tear the
    // worker down; the next validation spins up a fresh LanguageService that is
    // born already seeing every dependency .d.ts — so imports resolve cleanly.
    if (this.tsCompilerOptions) {
      monaco.typescript.typescriptDefaults.setCompilerOptions(this.tsCompilerOptions);
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

  // Open any Explorer entry by ABSOLUTE path, choosing how it renders: a
  // directory shows the "…is a directory" message, an image opens the image
  // viewer, everything else opens in Monaco. Use this (not openFile) wherever a
  // path could be a folder or an image (Explorer clicks, drag-to-editor).
  async openEntry(abs: string, { preview = false, focus = true }: { preview?: boolean; focus?: boolean } = {}) {
    let kind = this.snap.tabKinds[abs];
    if (!kind) {
      const info = await this.pathInfo(abs);
      kind = info.isDir ? "directory" : isImagePath(abs) ? "image" : "text";
      this.set({ tabKinds: { ...this.snap.tabKinds, [abs]: kind } });
    }
    if (kind === "image" && !this.imageUrls.has(abs)) {
      const bytes = await this.readFileBytes(abs);
      this.imageUrls.set(abs, URL.createObjectURL(new Blob([bytes as BlobPart], { type: imageMime(abs) })));
    }
    await this.openFile(abs, { preview, focus });
  }

  // Open a file by ABSOLUTE path. `preview` (single-click from the Explorer)
  // reuses a single italic "preview" tab; a permanent open (double-click, or an
  // edit) pins it.
  async openFile(abs: string, { preview = false, focus = true }: { preview?: boolean; focus?: boolean } = {}) {
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
    // Image / directory tabs don't get a Monaco model — the EditorGroup renders a
    // custom pane for them. Detach the editor's model so it doesn't show stale text.
    const kind = this.snap.tabKinds[abs] ?? "text";
    if (kind !== "text") {
      if (this.snap.activeTab === abs) this.editor.setModel(null);
      return;
    }
    const model = await this.ensureModel(abs);
    if (model && this.snap.activeTab === abs) {
      this.editor.setModel(model);
      if (focus) this.editor.focus();
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
    this.bridge.post("vv-search", {
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
      this.bridge.post("vv-search-cancel", {});
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
    const res = await this.bridge.request("vv-replace", {
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

  // Reorder the open-tabs strip (VSCode-style drag): move `fromAbs` to sit
  // immediately before/after `toAbs`. Doesn't change which tab is active.
  reorderTab(fromAbs: string, toAbs: string, placeAfter: boolean) {
    if (fromAbs === toAbs) return;
    const tabs = [...this.snap.openTabs];
    const fromIdx = tabs.indexOf(fromAbs);
    if (fromIdx === -1) return;
    tabs.splice(fromIdx, 1);
    let toIdx = tabs.indexOf(toAbs);
    if (toIdx === -1) return;
    if (placeAfter) toIdx += 1;
    tabs.splice(toIdx, 0, fromAbs);
    this.set({ openTabs: tabs });
  }

  // Revoke + forget an image tab's object URL (freeing the decoded bitmap).
  private revokeImage(abs: string) {
    const url = this.imageUrls.get(abs);
    if (url) { URL.revokeObjectURL(url); this.imageUrls.delete(abs); }
  }
  // Drop the render-kind entry for a closed/removed tab (image URLs revoked too).
  private forgetKind(abs: string): Record<string, "text" | "image" | "directory"> {
    this.revokeImage(abs);
    if (!(abs in this.snap.tabKinds)) return this.snap.tabKinds;
    const next = { ...this.snap.tabKinds };
    delete next[abs];
    return next;
  }

  closeTab(abs: string) {
    const i = this.snap.openTabs.indexOf(abs);
    if (i === -1) return;
    const openTabs = this.snap.openTabs.filter((x) => x !== abs);
    const previewTab = this.snap.previewTab === abs ? null : this.snap.previewTab;
    const tabKinds = this.forgetKind(abs);
    if (this.snap.activeTab === abs) {
      const next = openTabs[i] || openTabs[i - 1] || null;
      this.set({ openTabs, previewTab, tabKinds, activeTab: next });
      if (next) void this.openFile(next);
      else this.editor?.setModel(null);
    } else {
      this.set({ openTabs, previewTab, tabKinds });
    }
  }

  // Persist a file to the VFS (⌘S, or "Save" in the close prompt). The dev server
  // hot-updates/recompiles off the resulting notifyWatch.
  saveFile(abs: string) {
    if (!this.snap.dirty.includes(abs)) return;
    const contents = this.models.get(abs)?.getValue() ?? this.localFiles[abs] ?? "";
    this.localFiles[abs] = contents;
    this.bridge.post("vv-write", { path: abs, contents });
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
    const tabKinds = { ...this.snap.tabKinds };
    for (const abs of [...this.snap.openTabs]) {
      if (abs === root || abs.startsWith(root + "/")) {
        this.disposeModel(abs);
        delete this.localFiles[abs];
        this.revokeImage(abs);
        delete tabKinds[abs];
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
      tabKinds,
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
      "README.md": `# ${name}\n\nA blank project created in Vivari Studio.\n`,
    };
    const res = await this.bridge.request("vv-create-project", { dir: root, files, title: name });
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
    const res = await this.bridge.request("vv-create-project", {
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
    // Until the kernel is ready the VFS hasn't finished restoring from OPFS, so
    // the project's files legitimately aren't on disk *yet*. Don't mistake that
    // for a deleted project (which would wrongly drop it from the recent list) —
    // just tell the user to wait for the restore to finish.
    if (!this.snap.kernelReady) {
      toast.info("Still restoring your saved project — please wait until Studio finishes loading, then try again.");
      return;
    }
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
        this.bridge.post("vv-register-project", { dir: root, manifest: t.manifest, title: meta.name });
      }
    }
    this.touchProject(root);
    this.openFolder(root, meta.name);
    const manifest = this.folderManifests.get(root);
    if (manifest) void this.openFile(root + "/" + manifest.entry);
    // node_modules is no longer mirrored file-by-file — it's restored from the
    // dependency-cache snapshot on demand. Bring it back now the project is open
    // (one blob read), then refresh the Explorer + IntelliSense to reflect it.
    void this.bridge.request("vv-ensure-deps", { dir: root }).then((res) => {
      if ((res as { restored?: boolean }).restored) {
        this.bumpTree();
        this.scheduleDependencyTypes();
      }
    });
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
    const tabKinds = { ...this.snap.tabKinds };
    for (const abs of this.snap.openTabs) {
      if (abs === oldAbs || abs.startsWith(oldAbs + "/")) {
        const dest = map(abs);
        this.disposeModel(abs);
        if (abs in this.localFiles) { this.localFiles[dest] = this.localFiles[abs]; delete this.localFiles[abs]; }
        // Carry the render-kind + any image object URL over to the new path.
        if (abs in tabKinds) { tabKinds[dest] = tabKinds[abs]; delete tabKinds[abs]; }
        const url = this.imageUrls.get(abs);
        if (url) { this.imageUrls.set(dest, url); this.imageUrls.delete(abs); }
      }
    }
    this.set({
      openTabs: this.snap.openTabs.map(map),
      activeTab: this.snap.activeTab ? map(this.snap.activeTab) : null,
      tabKinds,
      previewTab: this.snap.previewTab ? map(this.snap.previewTab) : null,
      dirty: this.snap.dirty.map(map),
    });
    if (this.snap.activeTab) void this.openFile(this.snap.activeTab, { preview: this.snap.previewTab === this.snap.activeTab });
  }

  private dropOpenPaths(abs: string) {
    const affected = new Set(this.snap.openTabs.filter((p) => p === abs || p.startsWith(abs + "/")));
    const tabKinds = { ...this.snap.tabKinds };
    for (const p of affected) {
      this.disposeModel(p);
      delete this.localFiles[p];
      this.revokeImage(p);
      delete tabKinds[p];
    }
    const openTabs = this.snap.openTabs.filter((p) => !affected.has(p));
    let activeTab = this.snap.activeTab;
    if (activeTab && affected.has(activeTab)) activeTab = openTabs[openTabs.length - 1] ?? null;
    this.set({
      openTabs,
      activeTab,
      tabKinds,
      previewTab: this.snap.previewTab && affected.has(this.snap.previewTab) ? null : this.snap.previewTab,
      dirty: this.snap.dirty.filter((p) => !affected.has(p)),
    });
    if (activeTab) void this.openFile(activeTab);
    else this.editor?.setModel(null);
  }

  copyEntry(abs: string) { this.copyEntries([abs]); }
  cutEntry(abs: string) { this.cutEntries([abs]); }
  copyEntries(paths: string[]) { if (paths.length) this.set({ clipboard: { mode: "copy", paths: [...paths] } }); }
  cutEntries(paths: string[]) { if (paths.length) this.set({ clipboard: { mode: "cut", paths: [...paths] } }); }

  renameEntry(oldAbs: string, newName: string) {
    const name = newName.trim();
    if (!name || name === baseName(oldAbs)) return;
    const parent = oldAbs.slice(0, oldAbs.lastIndexOf("/"));
    const newAbs = parent + "/" + name;
    this.bridge.post("vv-rename", { from: oldAbs, to: newAbs });
    this.remapOpenPaths(oldAbs, newAbs);
    if (this.snap.clipboard?.paths.includes(oldAbs)) this.set({ clipboard: null });
    this.bumpTree();
  }

  deleteEntry(abs: string) { this.deleteEntries([abs]); }
  // Delete every entry in `paths` (batch delete from a multi-selection).
  deleteEntries(paths: string[]) {
    if (!paths.length) return;
    for (const abs of paths) {
      this.bridge.post("vv-rm", { path: abs });
      this.dropOpenPaths(abs);
    }
    const cb = this.snap.clipboard;
    if (cb) {
      const remaining = cb.paths.filter((p) => !paths.includes(p));
      if (remaining.length !== cb.paths.length) {
        this.set({ clipboard: remaining.length ? { ...cb, paths: remaining } : null });
      }
    }
    this.bumpTree();
  }

  // Paste every clipboard entry into `destDirAbs`.
  async pasteInto(destDirAbs: string) {
    const cb = this.snap.clipboard;
    if (!cb) return;
    const dest = normDir(destDirAbs);
    for (const src of cb.paths) {
      // Cutting into itself/descendant/current parent is a no-op — skip.
      if (cb.mode === "cut" && (dest === src || dest.startsWith(src + "/") || dest === parentOf(src))) continue;
      const target = await this.uniqueChild(dest, baseName(src));
      if (cb.mode === "copy") {
        this.bridge.post("vv-copy", { from: src, to: target });
      } else {
        this.bridge.post("vv-rename", { from: src, to: target });
        this.remapOpenPaths(src, target);
      }
    }
    if (cb.mode === "cut") this.set({ clipboard: null });
    this.bumpTree();
  }

  // ── drag & drop (Explorer reorg + OS import + open-in-editor) ──────────────
  // Compute a non-colliding child path in `destDir` for `name`, appending
  // -copy, -copy-2, … (matches pasteInto's clobber-avoidance).
  private async uniqueChild(destDir: string, name: string): Promise<string> {
    const target = destDir + "/" + name;
    if (!(await this.pathInfo(target)).exists) return target;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    for (let n = 1; ; n++) {
      const cand = `${destDir}/${stem}-copy${n > 1 ? `-${n}` : ""}${ext}`;
      if (!(await this.pathInfo(cand)).exists) return cand;
    }
  }

  // Move an entry into `destDirAbs` (default Explorer drag). No-ops for a drop
  // into the current parent or a folder dropped into itself/a descendant.
  async moveEntry(fromAbs: string, destDirAbs: string) {
    const from = fromAbs.replace(/\/+$/, "");
    const dest = normDir(destDirAbs);
    if (dest === parentOf(from)) return;
    if (dest === from || dest.startsWith(from + "/")) return;
    const target = await this.uniqueChild(dest, baseName(from));
    this.bridge.post("vv-rename", { from, to: target });
    this.remapOpenPaths(from, target);
    if (this.snap.clipboard?.paths.includes(from)) this.set({ clipboard: null });
    this.bumpTree();
  }

  // Copy an entry into `destDirAbs` (Ctrl/Cmd-drag). A folder can't be copied
  // into itself or a descendant.
  async copyEntryTo(fromAbs: string, destDirAbs: string) {
    const from = fromAbs.replace(/\/+$/, "");
    const dest = normDir(destDirAbs);
    if (dest === from || dest.startsWith(from + "/")) return;
    const target = await this.uniqueChild(dest, baseName(from));
    this.bridge.post("vv-copy", { from, to: target });
    this.bumpTree();
  }

  // Batch move/copy for a multi-selection drag. Sequential so per-item
  // collision suffixes (-copy, -copy-2, …) resolve against prior writes.
  async moveEntries(paths: string[], destDirAbs: string) {
    for (const p of paths) await this.moveEntry(p, destDirAbs);
  }
  async copyEntriesTo(paths: string[], destDirAbs: string) {
    for (const p of paths) await this.copyEntryTo(p, destDirAbs);
  }

  // Import OS files/folders (dragged from the desktop) into `destDirAbs`.
  // `entries` come from entriesFromDataTransfer (extracted synchronously in the
  // drop handler). Returns the created top-level target paths.
  async importInto(destDirAbs: string, entries: FileSystemEntry[]): Promise<string[]> {
    const dest = normDir(destDirAbs);
    const targets: string[] = [];
    let count = 0;
    for (const entry of entries) {
      const target = await this.uniqueChild(dest, entry.name);
      count += await this.writeEntry(entry, target);
      targets.push(target);
    }
    if (count) {
      this.bumpTree();
      this.set({ status: `imported ${count} file${count === 1 ? "" : "s"} into ${baseName(dest) || "/"}` });
    }
    return targets;
  }

  // Recursively write one OS FileSystemEntry to `targetAbs` in the VFS. Returns
  // the number of files written.
  private async writeEntry(entry: FileSystemEntry, targetAbs: string): Promise<number> {
    if (entry.isFile) {
      const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
      const bytes = new Uint8Array(await file.arrayBuffer());
      await this.bridge.request("vv-write", { path: targetAbs, bytes });
      return 1;
    }
    if (entry.isDirectory) {
      await this.bridge.request("vv-mkdirp", { path: targetAbs });
      const children = await readDirEntries(entry as FileSystemDirectoryEntry);
      let n = 0;
      for (const child of children) n += await this.writeEntry(child, targetAbs + "/" + child.name);
      return n;
    }
    return 0;
  }

  // A drop landed on the Monaco editor. Internal entries open directly; OS
  // files are imported into the active folder's root, then opened.
  async dropOnEditor({ paths, entries }: { paths: string[]; entries: FileSystemEntry[] }) {
    if (paths.length) { for (const p of paths) void this.openEntry(p); return; }
    if (!entries.length) return;
    const root = this.activeFolder?.rootPath;
    if (!root) { toast.error("Open a project first to view dropped files"); return; }
    const targets = await this.importInto(root, entries);
    if (targets[0]) void this.openEntry(targets[0]);
  }

  // ── import / export / share (P2) ────────────────────────────────────────────
  // Read a project's whole source tree (node_modules/.git excluded) in one bulk
  // reply — the basis for both zip export and the shareable-URL payload.
  async readProjectTree(rootPath: string): Promise<{ files: FileTree; truncated: boolean }> {
    const m = await this.bridge.request("vv-read-tree", { root: normDir(rootPath) });
    if (!m.ok) return { files: [], truncated: false };
    const files = ((m.files as FileTree) ?? []).filter((f) => f.bytes instanceof Uint8Array);
    return { files, truncated: !!m.truncated };
  }

  // Export a project as a .zip downloaded to disk.
  async exportProjectZip(rootPath: string) {
    const root = normDir(rootPath);
    const { files, truncated } = await this.readProjectTree(root);
    if (!files.length) { toast.error("Nothing to export in this project."); return; }
    try {
      const zip = await createZip(files);
      const filename = (baseName(root) || "project") + ".zip";
      downloadBlob(new Blob([zip as BlobPart], { type: "application/zip" }), filename);
      const count = `${files.length} file${files.length === 1 ? "" : "s"}`;
      this.set({ status: `exported ${count} → ${filename}` });
      toast.success(`Exported ${filename}`, {
        description: `${count} · node_modules excluded`,
      });
      if (truncated) toast.warning("Project was large — the export was truncated.");
    } catch (err) {
      toast.error("Export failed: " + errText(err));
    }
  }

  // Synthesize a run manifest for an imported/shared project from its package.json
  // (so Run auto-installs + starts a dev server). Null when there's no runnable
  // script — the project still opens; Run just drops into a shell.
  private synthManifest(files: FileTree, name: string): TemplateManifest | null {
    const pkgFile = files.find((f) => f.path === "package.json");
    if (!pkgFile) return null;
    let pkg: { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try { pkg = JSON.parse(new TextDecoder().decode(pkgFile.bytes)); } catch { return null; }
    const scripts = pkg.scripts || {};
    const devKey = scripts.dev ? "dev" : scripts.start ? "start" : scripts.serve ? "serve" : null;
    if (!devKey) return null;
    const dev = devKey === "start" ? "npm start" : `npm run ${devKey}`;
    const allDeps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const usesVite = "vite" in allDeps || /vite/.test(scripts[devKey] || "");
    const hasTs = files.some((f) => /\.tsx?$/.test(f.path)) || "typescript" in allDeps;
    const entryCandidates = [
      "src/App.tsx", "src/App.jsx", "src/main.tsx", "src/main.ts", "src/index.tsx",
      "src/index.ts", "src/index.js", "index.ts", "index.js", "README.md",
    ];
    const entry = entryCandidates.find((c) => files.some((f) => f.path === c)) || files[0]?.path || "package.json";
    return {
      id: "imported",
      framework: "node",
      icon: "package",
      category: "Frontend",
      name,
      language: hasTs ? "TypeScript" : "JavaScript",
      description: "Imported project",
      port: usesVite ? 5173 : 3000,
      openPath: "/",
      entry,
      hmr: usesVite,
      reload: !usesVite,
      install: "npm install",
      dev,
    };
  }

  // Create a NEW project from an in-memory file tree (folder import / shared URL).
  async importFilesAsProject(
    { name, dir, files, excludedNodeModules, silent }:
    { name: string; dir: string; files: FileTree; excludedNodeModules?: boolean; silent?: boolean },
  ): Promise<boolean> {
    if (!this.snap.kernelReady) { toast.error("Kernel is still starting — try again in a moment."); return false; }
    if (!files.length) { toast.error("No files to import."); return false; }
    const root = normDir(dir);
    const err = await this.validateNewDir(root);
    if (err) { toast.error(err); return false; }
    const res = await this.bridge.request("vv-import-tree", { dir: root, files });
    if (!res.ok) { toast.error(`Import failed: ${res.error ?? "unknown error"}`); return false; }
    const manifest = this.synthManifest(files, name);
    if (manifest) {
      this.folderManifests.set(root, manifest);
      this.bridge.post("vv-register-project", { dir: root, manifest, title: name });
    }
    this.upsertProjectMeta({ name, rootPath: root, template: null });
    this.openFolder(root, name);
    const openTarget = manifest?.entry || files.find((f) => f.path === "package.json")?.path || files[0]?.path;
    if (openTarget) void this.openFile(root + "/" + openTarget);
    const note = excludedNodeModules ? " (node_modules excluded)" : "";
    const count = `${files.length} file${files.length === 1 ? "" : "s"}`;
    this.set({ status: `imported ${count} as ${name}${note}` });
    if (!silent) {
      toast.success(`Imported ${name} — ${count}${note}`, {
        description: excludedNodeModules ? "Run the project to reinstall dependencies." : undefined,
      });
    }
    return true;
  }

  // Build a self-contained shareable URL (compressed project source in the hash)
  // and copy it to the clipboard. Source-only (node_modules excluded); capped so
  // the link stays usable. Returns the URL, or null if it can't be shared.
  async shareProject(rootPath: string): Promise<string | null> {
    const root = normDir(rootPath);
    const { files, truncated } = await this.readProjectTree(root);
    if (!files.length) { toast.error("Nothing to share in this project."); return null; }
    if (truncated) { toast.error("Project is too large to share as a link."); return null; }
    try {
      const payload = await encodeShare({ name: baseName(root) || "project", files });
      const url = location.origin + location.pathname + "#share=" + payload;
      if (url.length > MAX_SHARE_URL_LEN) { toast.error("Project is too big to share as a link."); return null; }
      const kb = Math.max(1, Math.round(url.length / 1024));
      try {
        await navigator.clipboard.writeText(url);
        this.set({ status: `share link copied (${kb} KB)` });
        toast.success("Share link copied to clipboard.", {
          description: `Self-contained · source only · ${kb} KB`,
          position: "bottom-left",
        });
      } catch {
        this.set({ status: "share link ready" });
        toast.warning("Couldn't copy to clipboard — copy the link from the address bar.", {
          position: "bottom-left",
        });
      }
      return url;
    } catch (err) {
      toast.error("Share failed: " + errText(err));
      return null;
    }
  }

  // A default project dir for `name` that doesn't collide with an open/known one.
  private async freeDirFor(name: string): Promise<string> {
    const base = this.slug(name);
    let dir = this.defaultDirFor(base);
    let n = 2;
    while (await this.validateNewDir(dir)) {
      dir = this.defaultDirFor(base + "-" + n++);
      if (n > 50) break;
    }
    return dir;
  }

  // Open the OS folder picker and import the chosen directory as a new project.
  importFolderViaPicker() {
    if (!this.snap.kernelReady) { toast.error("Kernel is still starting — try again in a moment."); return; }
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
    input.onchange = async () => {
      const list = input.files;
      if (!list || !list.length) return;
      const { name, files, excludedNodeModules } = await treeFromFileList(list);
      if (!files.length) { toast.error("No importable files in that folder."); return; }
      const dir = await this.freeDirFor(name);
      await this.importFilesAsProject({ name: baseName(dir) || name, dir, files, excludedNodeModules });
    };
    input.click();
  }

  // Import an OS drop (folder / files) as a new project (Home dropzone).
  async importDropAsProject(entries: FileSystemEntry[]) {
    if (!this.snap.kernelReady) { toast.error("Kernel is still starting — try again in a moment."); return; }
    if (!entries.length) return;
    const { name, files, excludedNodeModules } = await treeFromDrop(entries);
    if (!files.length) { toast.error("No importable files were dropped."); return; }
    const dir = await this.freeDirFor(name);
    await this.importFilesAsProject({ name: baseName(dir) || name, dir, files, excludedNodeModules });
  }

  // ── Import from a remote source (GitHub repo / npm package) ────────────────
  openImportRemote() {
    if (!this.snap.kernelReady) { toast.error("Kernel is still starting — try again in a moment."); return; }
    this.set({ importRemoteOpen: true });
  }
  closeImportRemote() { this.set({ importRemoteOpen: false }); }

  // Fetch a remote tree, then land it as a new project. Shared spine for the
  // GitHub/npm importers: both just supply a fetcher. Returns true on success so
  // the dialog can close itself. Progress flows to the dialog via onProgress.
  private async importRemoteTree(
    fetchTree: () => Promise<{ name: string; files: FileTree; excludedNodeModules: boolean; truncated?: boolean }>,
  ): Promise<boolean> {
    if (!this.snap.kernelReady) { toast.error("Kernel is still starting — try again in a moment."); return false; }
    const { name, files, excludedNodeModules, truncated } = await fetchTree();
    if (!files.length) { toast.error("Nothing to import."); return false; }
    const dir = await this.freeDirFor(name);
    const ok = await this.importFilesAsProject({
      name: baseName(dir) || name, dir, files, excludedNodeModules,
    });
    if (ok && truncated) {
      toast.warning("Project was large — some files were skipped past the import limit.", {
        position: "bottom-left",
      });
    }
    return ok;
  }

  // Import a public GitHub repo. `input` is a URL or `owner/repo[@ref]` shorthand.
  async importGithubRepo(input: string, onProgress?: ProgressFn): Promise<boolean> {
    const spec = parseGithubSpec(input);
    if (!spec) { toast.error("Enter a GitHub repo, e.g. owner/repo or a github.com URL."); return false; }
    return this.importRemoteTree(() => fetchGithubRepo(spec, onProgress));
  }

  // Import an npm package. `input` is `name`, `name@version`, or `name@tag`.
  async importNpmPackage(input: string, onProgress?: ProgressFn): Promise<boolean> {
    const spec = parseNpmSpec(input);
    if (!spec) { toast.error("Enter an npm package name, e.g. left-pad or @scope/pkg@1.2.3."); return false; }
    return this.importRemoteTree(() => fetchNpmPackage(spec, onProgress));
  }

  // Command-palette convenience: export / share the active workspace folder.
  exportActiveFolder() {
    const root = this.activeFolder?.rootPath;
    if (!root) { toast.error("Open a project first."); return; }
    void this.exportProjectZip(root);
  }
  shareActiveFolder() {
    const root = this.activeFolder?.rootPath;
    if (!root) { toast.error("Open a project first."); return; }
    void this.shareProject(root);
  }

  // On boot, if the URL carries a #share= payload, decode it into a new project
  // and open it. Clears the hash afterward so a reload doesn't re-import.
  private async loadSharedFromUrl() {
    const marker = "#share=";
    const hash = location.hash || "";
    const idx = hash.indexOf(marker);
    if (idx < 0) return;
    const payload = hash.slice(idx + marker.length);
    if (!payload) {
      this.set({ shareLoading: false });
      return;
    }
    history.replaceState(null, "", location.pathname + location.search);
    try {
      this.set({ shareLoading: true, shareMessage: "Unpacking files…" });
      const { name, files } = await decodeShare(payload);
      const dir = await this.freeDirFor(name);
      const projName = baseName(dir) || this.slug(name);
      const ok = await this.importFilesAsProject({ name: projName, dir, files, silent: true });
      if (ok) {
        toast.success(`Opened shared project “${projName}”`, {
          position: "bottom-left",
          description: `${files.length} file${files.length === 1 ? "" : "s"} · source only · Run to install deps.`,
        });
      } else if (!this.snap.workspaceFolders.length) {
        this.goHome();
      }
    } catch (err) {
      toast.error("Couldn't open shared project: " + errText(err), { position: "bottom-left" });
      if (!this.snap.workspaceFolders.length) this.goHome();
    } finally {
      this.set({ shareLoading: false });
    }
  }

  // Create an empty file / folder (Explorer "New File" / "New Folder").
  async newFile(destDirAbs: string, name: string) {
    const clean = name.trim();
    if (!clean) return;
    const abs = normDir(destDirAbs) + "/" + clean;
    if ((await this.pathInfo(abs)).exists) { toast.error(`"${clean}" already exists`); return; }
    await this.bridge.request("vv-write", { path: abs, contents: "" });
    this.bumpTree();
    void this.openFile(abs);
  }
  async newFolder(destDirAbs: string, name: string) {
    const clean = name.trim();
    if (!clean) return;
    const abs = normDir(destDirAbs) + "/" + clean;
    if ((await this.pathInfo(abs)).exists) { toast.error(`"${clean}" already exists`); return; }
    await this.bridge.request("vv-mkdirp", { path: abs });
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
    // previewBase is "" in mode A (relative, same-origin) and the preview origin
    // in mode B (absolute, cross-origin iframe served by the preview SW).
    return `${this.previewBase}/preview/${tab.port}${path}${bust}`;
  }
  private setTab(id: string, patch: Partial<PreviewTab>) {
    this.set({ previewTabs: this.snap.previewTabs.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  }

  // A demo's dev server is up — reuse the tab that already mirrors this port, or
  // open one, and make it active.
  private pointPreview(port: number) {
    const existing = this.snap.previewTabs.find((t) => t.port === port);
    if (existing) {
      this.setTab(existing.id, { nonce: existing.nonce + 1, title: "" });
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

    this.setTab(id, { url: `localhost:${port}${path === "/" ? "" : path}`, port, path, nonce: tab.nonce + 1, title: "" });
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
    if (t?.port != null) this.openExternalPreview(t.port);
  }

  // Open a preview port in a standalone browser tab.
  //
  // Default (same-origin pop-out): open on the studio's OWN origin so the tab
  // lands in the kernel's storage partition and proxies through the same-origin
  // SW — frictionless, but not isolated from the IDE. COOP:same-origin puts the
  // new tab in a separate browsing-context group (no window.opener), so HTTP
  // routes via the SW and the ws/SSE tunnels do too (the opened tab's shim talks
  // to the SW; we relay inbound frames back via relayToExternalPreviews).
  //
  // Isolated pop-out (previewPopout: "isolated", mode B): open on the preview
  // origin so it can't touch IDE storage/OPFS. It only auto-connects when the
  // browser's storage is unpartitioned; otherwise the preview SW serves a
  // "connect this tab" gate (see previewConnectingHtml in sw.js).
  openExternalPreview(port: number) {
    const base = this.popoutIsolated ? this.previewBase : "";
    window.open(`${base}/preview/${port}/`, "_blank");
  }

  // Relay an inbound ws/SSE frame to any preview opened in its OWN tab. Those tabs
  // can't be reached by postMessage (COOP severs the handle), so hand the frame to
  // the Service Worker(s), which broadcast it to every top-level preview client;
  // each shim keeps only the connIds it owns. A pop-out may be same-origin OR on
  // the preview origin, so relay to both transports (bridge.broadcastToPreviewSWs).
  private relayToExternalPreviews(payload: object) {
    this.bridge.broadcastToPreviewSWs(payload);
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
    target?.contentWindow?.postMessage({ source: "vv-cdp", dir: "init" }, "*");
  }

  // Called when a preview iframe finishes (re)loading. A reload swaps in a fresh
  // document with a brand-new chobitsu/CDP bootstrap; the persistent chii frontend
  // would otherwise (a) stay attached to the dead old context and (b) keep every
  // stale row (a synthetic Page.frameNavigated does NOT reset the frontend's
  // network log — chobitsu's own resetDevtools() has to poke the ResourceTreeModel
  // directly). Remounting the frontend (React key = devtoolsNonce) gives a clean
  // log and a fresh attach, exactly like the tab-switch path; onDevtoolsReady then
  // re-runs init against the reloaded document.
  onPreviewFrameLoad(id: string) {
    if (!this.snap.devtoolsOpen || this.devtoolsTargetId !== id) return;
    const tab = this.snap.previewTabs.find((t) => t.id === id);
    if (!tab || tab.port == null) return;
    this.set({ devtoolsNonce: this.snap.devtoolsNonce + 1 });
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
    // Preview frames are cross-origin in mode B; only trust their messages from
    // the configured preview origin (mode A: same-origin as the studio).
    const previewMsgOrigin = this.previewBase
      ? new URL(this.previewBase).origin
      : typeof location !== "undefined"
        ? location.origin
        : "";
    window.addEventListener("message", (event: MessageEvent) => {
      const src = event.source;
      const data = event.data;

      // DevTools frontend → target tab. chii posts raw CDP JSON strings. The
      // frontend is always same-origin (served by the studio), so guard it so.
      if (this.devtoolsFrame && src && src === this.devtoolsFrame.contentWindow) {
        if (event.origin !== location.origin) return;
        if (typeof data !== "string") return;
        const target = this.devtoolsTargetId ? this.previewFrames.get(this.devtoolsTargetId) : null;
        target?.contentWindow?.postMessage({ source: "vv-cdp", dir: "frontend", data }, "*");
        return;
      }

      if (!data || typeof data !== "object") return;
      // Everything below originates from a preview frame — enforce its origin.
      if (previewMsgOrigin && event.origin !== previewMsgOrigin) return;

      // Preview tab's chobitsu → frontend (only if this tab is the attached target).
      if (data.source === "vv-cdp" && data.dir === "target") {
        const tabId = this.tabIdForSource(src);
        if (tabId && tabId === this.devtoolsTargetId) {
          this.devtoolsFrame?.contentWindow?.postMessage(data.data, "*");
        }
        return;
      }

      // Preview tab navigated (link click / SPA route) → sync the address bar.
      if (data.source === "vv-nav") {
        const tabId = this.tabIdForSource(src);
        if (tabId) this.syncTabLocation(tabId, String(data.href || "/"));
        return;
      }

      // Preview reported its document.title → show it on the tab.
      if (data.source === "vv-title") {
        const tabId = this.tabIdForSource(src);
        if (tabId) this.setTab(tabId, { title: typeof data.title === "string" ? data.title.trim() : "" });
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
  // Force a clean slate: wipe the OPFS-mirrored VFS + the dependency cache, then
  // reload. The FS worker holds OPFS sync-access handles, so we tear the worker
  // down FIRST (releasing them) — otherwise removeEntry() on `vv-vfs` can throw
  // NoModificationAllowedError. Best-effort throughout; we reload regardless.
  async resetEverything() {
    try {
      this.bridge.destroy();
    } catch {
      /* worker already gone */
    }
    // Wipe the recent-projects registry too, so "reset everything" truly starts
    // from a clean slate (the Home screen's Recent list is backed by this key).
    try {
      localStorage.removeItem(REGISTRY_KEY);
      this.set({ recentProjects: [] });
    } catch {
      /* storage disabled — nothing to clear */
    }
    try {
      await resetVfs();
    } catch {
      /* OPFS unavailable / nothing persisted — reload into a fresh session anyway */
    }
    location.reload();
  }

  // ── memory diagnostics ─────────────────────────────────────────────────────
  // Measure the tab's memory and log a breakdown to the Console. This is possible
  // because the studio is cross-origin isolated (COOP/COEP for SharedArrayBuffer),
  // which is exactly what unlocks performance.measureUserAgentSpecificMemory().
  // The page estimate covers this window + its dedicated workers; we additionally
  // ask the kernel/FS worker for the VFS's in-RAM content size, which is what
  // balloons when a heavy node_modules (Docusaurus/Nuxt) is loaded.
  async measureMemory() {
    this.consoleLine("Measuring memory…", "90");
    let total: number | null = null;
    type MemResult = { bytes: number; breakdown?: { bytes: number; types?: string[]; attribution?: { url?: string }[] }[] };
    const perf = performance as Performance & {
      measureUserAgentSpecificMemory?: () => Promise<MemResult>;
    };
    try {
      if (typeof perf.measureUserAgentSpecificMemory === "function") {
        const r = await perf.measureUserAgentSpecificMemory();
        total = r.bytes;
        this.consoleLine(`Tab total (page + workers): ${fmtBytes(total)}`, "36");
        // Largest attributed buckets first, so the dominant consumer is obvious.
        const rows = (r.breakdown ?? [])
          .filter((b) => b.bytes > 0)
          .sort((a, b) => b.bytes - a.bytes)
          .slice(0, 12);
        for (const b of rows) {
          const label =
            (b.attribution ?? []).map((a) => a.url).filter(Boolean).join(", ") ||
            (b.types ?? []).join("/") ||
            "(unattributed)";
          this.consoleLine(`  ${fmtBytes(b.bytes).padStart(9)}  ${label}`, "90");
        }
      } else {
        this.consoleLine(
          "performance.measureUserAgentSpecificMemory() unavailable (needs a Chromium browser + cross-origin isolation).",
          "31",
        );
      }
    } catch (err) {
      this.consoleLine(`memory measurement failed: ${(err as Error)?.message ?? err}`, "31");
    }

    // VFS content footprint (the File System Worker's Wasm) + the kernel worker's
    // own measurement, gathered over the bridge.
    let vfsBytes = -1;
    let vfsFiles = -1;
    let vfsLogicalBytes = -1;
    try {
      const m = await this.bridge.request("vv-mem");
      vfsBytes = Number(m.vfsBytes ?? -1);
      vfsFiles = Number(m.vfsFiles ?? -1);
      vfsLogicalBytes = Number(m.vfsLogicalBytes ?? -1);
      if (vfsBytes >= 0) {
        this.consoleLine(`VFS content in RAM: ${fmtBytes(vfsBytes)} across ${vfsFiles} files`, "36");
        // Show the realized compression ratio when the logical size is larger
        // (i.e. some files are stored compressed).
        if (vfsLogicalBytes > vfsBytes) {
          const saved = vfsLogicalBytes - vfsBytes;
          const ratio = (vfsBytes / vfsLogicalBytes) * 100;
          this.consoleLine(
            `  compressed from ${fmtBytes(vfsLogicalBytes)} (${ratio.toFixed(0)}% of logical, saved ${fmtBytes(saved)})`,
            "90",
          );
        }
      } else {
        this.consoleLine("VFS content size unavailable (rebuild the VFS wasm: `npm run build:vfs`).", "90");
      }
      if (typeof m.kernelBytes === "number") {
        this.consoleLine(`Kernel worker: ${fmtBytes(m.kernelBytes as number)}`, "90");
      }
      // Per-PID Process Worker breakdown: turns the flat "N GB on process-worker.js"
      // figure into which process holds it (dev servers dominate), how many modules
      // its guest cache retains, and whether it hosts the resident esbuild wasm.
      const procs = Array.isArray(m.procs) ? (m.procs as ProcMem[]) : [];
      const withHeap = procs.filter((p) => Number(p.heap) >= 0);
      if (withHeap.length > 0) {
        this.consoleLine("Process workers (own JS heap):", "36");
        for (const p of withHeap) {
          const mods = Number(p.modules) >= 0 ? `${p.modules} modules` : "modules n/a";
          this.consoleLine(
            `  ${fmtBytes(Number(p.heap)).padStart(9)}  ${p.name} (${mods}${esbuildLabel(p)})`,
            "90",
          );
        }
      } else if (procs.length > 0) {
        // Heap sizing unavailable (performance.memory off) — still show retention.
        this.consoleLine("Process workers (heap size unavailable):", "36");
        for (const p of procs) {
          this.consoleLine(
            `  ${p.name}: ${Number(p.modules) >= 0 ? p.modules + " modules" : "modules n/a"}${esbuildLabel(p)}`,
            "90",
          );
        }
      }
    } catch {
      /* kernel not ready */
    }

    this.set({ memInfo: { total, vfsBytes, vfsFiles, vfsLogicalBytes, ts: Date.now() } });
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
    // Cold-boot progress (relayed from the FS worker's OPFS restore + kernel
    // phase markers). Drives the Home boot indicator until `kernelReady`.
    b.on("boot-progress", (m) => {
      this.set({
        bootPhase: (m.phase as string) || "",
        bootDone: (m.done as number) ?? 0,
        bootTotal: (m.total as number) ?? 0,
      });
    });
    // The kernel + VFS are up (before the PM tarballs finish loading) — the Home
    // screen can create/open projects now, so don't make the user wait for `ready`.
    b.on("kernel-online", () => this.set({ kernelReady: true, bootPhase: "" }));
    b.on("ready", () => {
      this.consoleLine("Kernel ready.", "32");
      this.set({ booted: true, kernelReady: true, status: "ready — create or open a project" });
      this.newShellTerminal({ defer: true, activate: false });
      // If the URL carries a #share= payload, import it into a new project.
      void this.loadSharedFromUrl();
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
      // don't emit vv-fs-changed, so re-harvest dependency types (debounced; the
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
    b.on("vv-ws", (m) => {
      const payload = { ...(m.msg as object), type: "vv-ws", dir: "in" };
      for (const t of this.snap.previewTabs) {
        if (t.port != null) this.previewFrames.get(t.id)?.contentWindow?.postMessage(payload, "*");
      }
      this.relayToExternalPreviews(payload);
    });

    // SSE tunnel: a text/event-stream chunk routed OUT of the VM → preview iframes.
    // Like the ws frame it doesn't carry a port, so deliver to every bound tab; the
    // iframe's EventSource polyfill ignores chunks for connIds it doesn't own.
    b.on("vv-sse", (m) => {
      const payload = { ...(m.msg as object), type: "vv-sse", dir: "in" };
      for (const t of this.snap.previewTabs) {
        if (t.port != null) this.previewFrames.get(t.id)?.contentWindow?.postMessage(payload, "*");
      }
      this.relayToExternalPreviews(payload);
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
    b.on("vv-search-result", (m) => {
      if (this.searchCbs && m.token === this.searchCbs.token) {
        this.searchCbs.onBatch((m.files as SearchFileResult[]) ?? []);
      }
    });
    b.on("vv-search-done", (m) => {
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
    b.on("vv-fs-changed", () => this.bumpTree());

    // Result of an Explorer file operation (rename/rm/copy). The UI already updated
    // optimistically; surface any failure so the user knows the VFS is out of sync.
    b.on("vv-fs-result", (m) => {
      if (!m.ok) toast.error(`${m.op} failed: ${m.error ?? "unknown error"}`);
    });
  }
}