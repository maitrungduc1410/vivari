// Browser host (main thread) — UI + orchestration ONLY.
//
// A VS Code-style IDE around the OpenContainer kernel worker:
//   - boots the kernel worker (kernel + Rust/Wasm VFS + process workers),
//   - registers the preview Service Worker and relays its HTTP requests in,
//   - a Monaco editor with multiple file tabs over the running project's VFS,
//   - a bottom terminal PANEL with multiple tabs: a read-only "Console" for demo
//     / kernel output, plus fully INTERACTIVE shells (real stdin — type a command,
//     press Enter, cwd/env persist) backed by long-lived in-VM `sh` processes,
//   - a command palette (Ctrl/Cmd+Shift+P) and quick-open (Ctrl/Cmd+P),
//   - a live preview iframe for the running dev server.
// The heavy work stays off the main thread; here we only orchestrate + render.

import { monaco, Terminal, FitAddon } from "./vendor/editor/editor.js";

// Monaco's language *services* (diagnostics/IntelliSense) run in web workers we
// would have to wire up; we don't need them for this editor. Syntax coloring runs
// on the main thread regardless, so hand Monaco a silent no-op worker to keep it
// from trying (and to stay COEP-safe — no cross-origin worker URLs).
self.MonacoEnvironment = {
  getWorker() {
    const blob = new Blob([""], { type: "text/javascript" });
    return new Worker(URL.createObjectURL(blob));
  },
};
try {
  for (const d of [monaco.languages.typescript?.typescriptDefaults, monaco.languages.typescript?.javascriptDefaults]) {
    d?.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true });
    d?.setEagerModelSync(false);
  }
} catch {
  /* language pack not present — fine */
}

// ── DOM refs ────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const demoSelect = $("demo-select");
const runDemoBtn = $("run-demo");
const statusEl = $("status");
const statusCwdEl = $("status-cwd");
const frame = $("preview");
const previewUrlEl = $("preview-url");
const treeEl = $("filetree");
const tabsEl = $("tabs");
const editorHost = $("editor");
const editorEmpty = $("editor-empty");
const projectNameEl = $("project-name");
const workbench = $("workbench");
const sidebar = $("sidebar");
const panel = $("panel");
const termTabsEl = $("term-tabs");
const terminalsEl = $("terminals");
const titlebarCenter = $("titlebar-center");

let previewPort = null; // the demo server that owns the preview iframe
let currentDemo = null; // { id, dir, reload, title }
const runningDemos = new Map(); // demo id -> { terminalId, port } (a live dev-server tab)
const localFiles = {}; // abs VFS path -> latest editor text (per session)
const models = new Map(); // abs VFS path -> monaco model

// ── Editor + tabs ─────────────────────────────────────────────────────────
let editor = null;
const openTabs = []; // ordered list of rel paths
let activeTab = null; // rel path
const dirty = new Set(); // rel paths with unsaved changes (cleared on save flush)

function ensureEditor() {
  if (editor) return;
  editor = monaco.editor.create(editorHost, {
    model: null,
    theme: "vs-dark",
    automaticLayout: true,
    fontSize: 13,
    minimap: { enabled: true },
    scrollBeyondLastLine: false,
    tabSize: 2,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  });
}

function languageFor(path) {
  if (/\.(jsx?|mjs|cjs)$/.test(path)) return "javascript";
  if (/\.tsx?$/.test(path)) return "typescript";
  if (/\.css$/.test(path)) return "css";
  if (/\.html?$/.test(path)) return "html";
  if (/\.json$/.test(path)) return "json";
  if (/\.md$/.test(path)) return "markdown";
  return "plaintext";
}

const baseName = (rel) => rel.split("/").pop();

function renderTabs() {
  tabsEl.innerHTML = "";
  for (const rel of openTabs) {
    const tab = document.createElement("div");
    tab.className = "tab" + (rel === activeTab ? " active" : "") + (dirty.has(rel) ? " dirty" : "");
    tab.title = rel;
    tab.innerHTML =
      `<span class="tab-name">${baseName(rel)}</span>` +
      `<span class="dirty"></span>` +
      `<span class="tab-close" title="Close">&times;</span>`;
    tab.querySelector(".tab-name").addEventListener("click", () => openFile(rel));
    tab.querySelector(".tab-close").addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(rel);
    });
    tabsEl.appendChild(tab);
  }
}

function closeTab(rel) {
  const i = openTabs.indexOf(rel);
  if (i === -1) return;
  openTabs.splice(i, 1);
  if (activeTab === rel) {
    const next = openTabs[i] || openTabs[i - 1] || null;
    if (next) openFile(next);
    else {
      activeTab = null;
      editor?.setModel(null);
      editorEmpty.style.display = "flex";
    }
  }
  renderTabs();
}

function openFile(rel) {
  if (!currentDemo) return;
  ensureEditor();
  editorEmpty.style.display = "none";
  const abs = currentDemo.dir + "/" + rel;
  let model = models.get(abs);
  if (!model) {
    const uri = monaco.Uri.file(abs);
    model = monaco.editor.getModel(uri) || monaco.editor.createModel(localFiles[abs] ?? "", languageFor(rel), uri);
    model.onDidChangeContent(() => {
      dirty.add(rel);
      renderTabs();
      scheduleSave(abs, rel);
    });
    models.set(abs, model);
  }
  editor.setModel(model);
  activeTab = rel;
  if (!openTabs.includes(rel)) openTabs.push(rel);
  renderTabs();
  for (const el of treeEl.querySelectorAll(".tree-item.file")) {
    el.classList.toggle("active", el.dataset.rel === rel);
  }
  editor.focus();
}

let saveTimer = null;
function scheduleSave(abs, rel) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const contents = models.get(abs)?.getValue() ?? localFiles[abs] ?? "";
    localFiles[abs] = contents;
    kernelWorker.postMessage({ type: "oc-write", path: abs, contents });
    dirty.delete(rel);
    renderTabs();
    const short = rel;
    statusEl.textContent = currentDemo?.reload
      ? `saved ${short} — recompiling…`
      : `saved ${short} — hot-updating…`;
  }, 350); // debounce so a burst of keystrokes is one write (real-editor feel)
}

// ── File tree ─────────────────────────────────────────────────────────────
let projectFiles = {}; // rel -> contents (for quick open)
function renderTree(files) {
  treeEl.innerHTML = "";
  const root = {};
  for (const rel of Object.keys(files)) {
    const parts = rel.split("/");
    let node = root;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const isFile = i === parts.length - 1;
      node[p] = node[p] || (isFile ? { __file: rel } : {});
      node = node[p];
    }
  }
  const walk = (node, depth) => {
    const dirs = [];
    const filez = [];
    for (const [name, child] of Object.entries(node)) {
      if (child.__file) filez.push([name, child.__file]);
      else dirs.push([name, child]);
    }
    dirs.sort((a, b) => a[0].localeCompare(b[0]));
    filez.sort((a, b) => a[0].localeCompare(b[0]));
    for (const [name, child] of dirs) {
      const row = document.createElement("div");
      row.className = "tree-item dir";
      row.style.paddingLeft = 16 + depth * 14 + "px";
      row.innerHTML = `<span class="tree-icon">&#9662;</span><span>${name}</span>`;
      treeEl.appendChild(row);
      walk(child, depth + 1);
    }
    for (const [name, rel] of filez) {
      const row = document.createElement("div");
      row.className = "tree-item file";
      row.style.paddingLeft = 16 + depth * 14 + "px";
      row.dataset.rel = rel;
      row.innerHTML = `<span class="tree-icon">&#9926;</span><span>${name}</span>`;
      row.addEventListener("click", () => openFile(rel));
      treeEl.appendChild(row);
    }
  };
  walk(root, 0);
}

function loadProject(m) {
  currentDemo = { id: m.id, dir: m.dir, reload: !!m.reload, title: m.title };
  projectFiles = m.files || {};
  for (const [rel, contents] of Object.entries(projectFiles)) {
    localFiles[m.dir + "/" + rel] = contents;
  }
  projectNameEl.textContent = m.title || m.id;
  titlebarCenter.textContent = `${m.title} — running in this tab`;
  renderTree(projectFiles);
  if (m.entry && projectFiles[m.entry]) openFile(m.entry);
  else {
    const first = Object.keys(projectFiles)[0];
    if (first) openFile(first);
  }
}

// ── Terminals (Console + interactive shells) ───────────────────────────────
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

const terminals = new Map(); // id -> { term, fit, view, tab, kind, pid, alive }
let activeTermId = null;
let termSeq = 0;

function makeTermView() {
  const view = document.createElement("div");
  view.className = "term-view";
  terminalsEl.appendChild(view);
  const term = new Terminal({
    convertEol: true, // programs emit "\n"; xterm needs CRLF — translate on write
    cursorBlink: true,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: 12.5,
    scrollback: 8000,
    theme: TERM_THEME,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(view);
  return { term, fit, view };
}

function renderTermTabs() {
  termTabsEl.innerHTML = "";
  for (const [id, t] of terminals) {
    const tab = document.createElement("div");
    tab.className = "term-tab" + (id === activeTermId ? " active" : "");
    const label = t.kind === "console" ? "Console" : t.label;
    tab.innerHTML =
      `<span>${label}</span>` +
      (t.kind === "console" ? "" : `<span class="tclose" title="Kill Terminal">&times;</span>`);
    tab.addEventListener("click", () => switchTerminal(id));
    const close = tab.querySelector(".tclose");
    if (close)
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        closeTerminal(id);
      });
    termTabsEl.appendChild(tab);
  }
}

function switchTerminal(id) {
  if (!terminals.has(id)) return;
  activeTermId = id;
  for (const [tid, t] of terminals) t.view.classList.toggle("active", tid === id);
  renderTermTabs();
  const t = terminals.get(id);
  requestAnimationFrame(() => {
    try {
      t.fit.fit();
    } catch {
      /* not visible */
    }
    t.term.focus();
  });
}

function addConsole() {
  const { term, fit, view } = makeTermView();
  terminals.set("console", { term, fit, view, kind: "console", label: "Console", alive: true });
  renderTermTabs();
  switchTerminal("console");
  return term;
}

// Create the terminal tab/xterm, but DON'T spawn its shell yet. Spawning a shell
// means booting a Process Worker (~the most expensive single step of a cold
// start), so for the auto first terminal we defer that off the boot burst and
// only actually spawn on first interaction (focus/keystroke) or when the browser
// goes idle — whichever comes first. Explicit "New Terminal" starts immediately.
function newShellTerminal({ defer = false, demo = null, label = null } = {}) {
  const id = "sh" + ++termSeq;
  const { term, fit, view } = makeTermView();
  const entry = {
    term, fit, view, kind: "shell", label: label || "sh " + termSeq,
    demo, pid: null, alive: true, started: false, pendingInput: [],
  };
  terminals.set(id, entry);
  term.onData((data) => {
    if (!entry.started) {
      startShell(id); // first keystroke wakes the shell; buffer it until ready
      entry.pendingInput.push(data);
      return;
    }
    kernelWorker.postMessage({ type: "term-input", terminalId: id, chunk: data });
  });
  view.addEventListener("mousedown", () => startShell(id), { once: true });
  renderTermTabs();
  switchTerminal(id);
  if (defer) {
    if (typeof requestIdleCallback === "function") requestIdleCallback(() => startShell(id), { timeout: 2500 });
    else setTimeout(() => startShell(id), 1500);
  } else {
    startShell(id);
  }
  return id;
}

function startShell(id) {
  const entry = terminals.get(id);
  if (!entry || entry.kind !== "shell" || entry.started) return;
  entry.started = true;
  entry.openedAt = performance.now(); // measure Process Worker boot (spawn → ready)
  // A demo shell auto-runs the project's dev command in-VM (OC_RUN, kernel side).
  kernelWorker.postMessage({ type: "term-open", terminalId: id, demo: entry.demo, cwd: currentDemo?.dir });
}

function closeTerminal(id) {
  const t = terminals.get(id);
  if (!t || t.kind === "console") return;
  kernelWorker.postMessage({ type: "term-close", terminalId: id });
  t.term.dispose();
  t.view.remove();
  terminals.delete(id);
  if (activeTermId === id) {
    const remaining = [...terminals.keys()];
    switchTerminal(remaining[remaining.length - 1] || "console");
  } else {
    renderTermTabs();
  }
}

const ESC = "\x1b[";
const consoleWrite = (chunk) => terminals.get("console")?.term.write(chunk);
const consoleLine = (text, color) =>
  terminals.get("console")?.term.write((color ? `${ESC}${color}m${text}${ESC}0m` : text) + "\r\n");

new ResizeObserver(() => {
  const t = terminals.get(activeTermId);
  if (!t) return;
  try {
    t.fit.fit();
  } catch {
    /* hidden */
  }
}).observe(terminalsEl);

// ── Panel + sidebar toggles + resize ───────────────────────────────────────
function togglePanel(force) {
  const collapsed = force === undefined ? !panel.classList.contains("collapsed") : !force;
  panel.classList.toggle("collapsed", collapsed);
  $("act-terminal").classList.toggle("active", !collapsed);
  if (!collapsed) switchTerminal(activeTermId || "console");
}
function toggleSidebar(force) {
  const collapsed = force === undefined ? !workbench.classList.contains("sidebar-collapsed") : !force;
  workbench.classList.toggle("sidebar-collapsed", collapsed);
  $("act-explorer").classList.toggle("active", !collapsed);
}

(function wirePanelResize() {
  const handle = $("panel-resize");
  let startY = 0;
  let startH = 0;
  const onMove = (e) => {
    const dy = startY - e.clientY;
    const h = Math.max(80, Math.min(startH + dy, window.innerHeight * 0.8));
    panel.style.setProperty("--panel-h", h + "px");
  };
  const onUp = () => {
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  handle.addEventListener("mousedown", (e) => {
    startY = e.clientY;
    startH = panel.getBoundingClientRect().height;
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });
})();

// ── Command palette / quick open ───────────────────────────────────────────
const paletteBackdrop = $("palette-backdrop");
const paletteInput = $("palette-input");
const paletteList = $("palette-list");
let paletteSel = 0;
let paletteItems = [];

const COMMANDS = [
  { label: "New Terminal", icon: "+", run: () => newShellTerminal() },
  { label: "Run Project", icon: "\u25B6", run: () => runDemoBtn.click() },
  { label: "Toggle Terminal Panel", icon: "\u2757", run: () => togglePanel() },
  { label: "Toggle Sidebar", icon: "\u2630", run: () => toggleSidebar() },
  { label: "Clear Active Terminal", icon: "\u2327", run: () => terminals.get(activeTermId)?.term.clear() },
  { label: "Reload Preview", icon: "\u21BB", run: () => reloadPreview() },
  { label: "Reset & Reload (wipe VFS)", icon: "\u26A0", run: () => (location.href = location.pathname + "?reset") },
];

function openPalette(mode) {
  paletteBackdrop.classList.add("open");
  paletteInput.value = mode === "command" ? ">" : "";
  updatePalette();
  paletteInput.focus();
}
function closePalette() {
  paletteBackdrop.classList.remove("open");
}
function updatePalette() {
  const q = paletteInput.value;
  const commandMode = q.startsWith(">");
  const needle = (commandMode ? q.slice(1) : q).trim().toLowerCase();
  if (commandMode) {
    paletteItems = COMMANDS.filter((c) => c.label.toLowerCase().includes(needle)).map((c) => ({
      label: c.label,
      icon: c.icon,
      desc: "command",
      run: c.run,
    }));
  } else {
    const files = Object.keys(projectFiles);
    paletteItems = files
      .filter((f) => f.toLowerCase().includes(needle))
      .slice(0, 200)
      .map((f) => ({ label: baseName(f), icon: "\u25A6", desc: f, run: () => openFile(f) }));
  }
  paletteSel = 0;
  renderPalette();
}
function renderPalette() {
  paletteList.innerHTML = "";
  if (!paletteItems.length) {
    paletteList.innerHTML = `<div class="palette-empty">No matches</div>`;
    return;
  }
  paletteItems.forEach((it, i) => {
    const el = document.createElement("div");
    el.className = "palette-item" + (i === paletteSel ? " sel" : "");
    el.innerHTML =
      `<span class="pi-icon">${it.icon}</span><span>${it.label}</span><span class="pi-desc">${it.desc || ""}</span>`;
    el.addEventListener("click", () => runPaletteItem(i));
    paletteList.appendChild(el);
  });
}
function runPaletteItem(i) {
  const it = paletteItems[i];
  closePalette();
  if (it) it.run();
}
paletteInput.addEventListener("input", updatePalette);
paletteInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") return closePalette();
  if (e.key === "ArrowDown") {
    e.preventDefault();
    paletteSel = Math.min(paletteSel + 1, paletteItems.length - 1);
    renderPalette();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    paletteSel = Math.max(paletteSel - 1, 0);
    renderPalette();
  } else if (e.key === "Enter") {
    e.preventDefault();
    runPaletteItem(paletteSel);
  }
});
paletteBackdrop.addEventListener("click", (e) => {
  if (e.target === paletteBackdrop) closePalette();
});

// ── Preview ─────────────────────────────────────────────────────────────────
function pointPreview(port) {
  previewPort = port;
  previewUrlEl.textContent = `localhost:${port}`;
  frame.src = `./preview/${port}/`;
}
function reloadPreview() {
  if (previewPort) frame.src = `./preview/${previewPort}/?t=${Date.now()}`;
}
$("preview-refresh").addEventListener("click", reloadPreview);
$("preview-open").addEventListener("click", () => {
  if (previewPort) window.open(`./preview/${previewPort}/`, "_blank");
});

// ── Global keybindings + activity bar ───────────────────────────────────────
$("act-explorer").addEventListener("click", () => toggleSidebar());
$("act-terminal").addEventListener("click", () => togglePanel());
$("act-command").addEventListener("click", () => openPalette("command"));
$("term-new").addEventListener("click", () => newShellTerminal());
$("panel-toggle").addEventListener("click", () => togglePanel());

addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.shiftKey && (e.key === "P" || e.key === "p")) {
    e.preventDefault();
    openPalette("command");
  } else if (mod && (e.key === "p" || e.key === "P")) {
    e.preventDefault();
    openPalette("file");
  } else if (mod && e.key === "`") {
    e.preventDefault();
    togglePanel();
  } else if (mod && e.shiftKey && (e.key === "C" || e.key === "c")) {
    e.preventDefault();
    newShellTerminal();
  }
});

// ── Service Worker (preview proxy) ─────────────────────────────────────────
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    consoleLine("Service workers unavailable — preview disabled.", "31");
    return false;
  }
  await navigator.serviceWorker.register("./sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  consoleLine("Service Worker registered (preview proxy ready).", "32");
  return true;
}

// ── Kernel worker ─────────────────────────────────────────────────────────
let kernelWorker = null;

async function main() {
  addConsole();
  if (typeof SharedArrayBuffer === "undefined") {
    consoleLine(
      "SharedArrayBuffer is undefined — the page is NOT cross-origin isolated. Serve it with COOP/COEP headers.",
      "31",
    );
    statusEl.textContent = "not cross-origin isolated";
    return;
  }

  // `?reset` wipes the OPFS-mirrored VFS before boot (clean slate).
  if (new URLSearchParams(location.search).has("reset")) {
    try {
      const dir = await navigator.storage.getDirectory();
      await dir.removeEntry("oc-vfs", { recursive: true });
      consoleLine("OPFS persistence reset — cleared the persisted VFS.", "90");
    } catch {
      /* nothing persisted yet */
    }
  }

  kernelWorker = new Worker(new URL("./kernel-worker.js", import.meta.url), {
    type: "module",
    name: "Kernel Worker",
  });
  addEventListener("pagehide", () => kernelWorker.postMessage({ type: "fs-flush" }));

  kernelWorker.onmessage = (event) => {
    const m = event.data;
    switch (m.type) {
      case "stdout":
      case "stderr":
        consoleWrite(m.chunk);
        break;
      case "log":
        consoleLine(m.line, m.stream === "stderr" ? "31" : m.dim || m.cls === "muted" ? "90" : "");
        break;
      case "ready":
        consoleLine("Kernel ready.", "32");
        statusEl.textContent = "ready — pick a project and press Run";
        // Show a shell tab straight away (like a real IDE), but defer actually
        // spawning it so the Process Worker boot doesn't pile onto the cold-start
        // burst — it starts on first focus/keystroke, or when the browser idles.
        newShellTerminal({ defer: true });
        break;
      case "exit":
        consoleLine(`[kernel] pid ${m.pid} exited with code ${m.code}`, "90");
        break;
      case "listen":
        consoleLine(`[kernel] pid ${m.pid} listening on :${m.port}`, "90");
        break;

      // ── interactive terminals ──
      case "term-ready": {
        const t = terminals.get(m.terminalId);
        if (t) {
          t.pid = m.pid;
          // Flush any keystrokes typed before the shell finished spawning.
          if (t.pendingInput && t.pendingInput.length) {
            for (const chunk of t.pendingInput)
              kernelWorker.postMessage({ type: "term-input", terminalId: m.terminalId, chunk });
            t.pendingInput.length = 0;
          }
        }
        statusCwdEl.textContent = m.cwd || "";
        break;
      }
      case "term-out": {
        const t = terminals.get(m.terminalId);
        if (!t) break;
        // First byte back = the shell actually booted and printed its prompt. This
        // (not the PID round-trip at term-ready) is the real spawn→ready latency.
        if (t.openedAt) {
          consoleLine(`[boot] shell (Process Worker) booted in ${Math.round(performance.now() - t.openedAt)}ms`, "90");
          t.openedAt = 0;
        }
        t.term.write(m.chunk);
        break;
      }
      case "term-exit": {
        const t = terminals.get(m.terminalId);
        if (t) {
          t.term.write(`\r\n\x1b[90m[process exited — code ${m.code}]\x1b[0m\r\n`);
          t.alive = false;
          // A demo's dev-server tab ended → the server is gone. Drop it so Run
          // starts a fresh one, and warn that the preview will now 502.
          if (t.demo && runningDemos.get(t.demo)?.terminalId === m.terminalId) {
            const gone = runningDemos.get(t.demo);
            runningDemos.delete(t.demo);
            if (gone?.port === previewPort)
              statusEl.textContent = "dev server stopped — preview will 502 until you Run again";
          }
        }
        break;
      }

      // roadmap #19 stage C: a ws frame the kernel routed OUT of the VM (Vite's
      // HMR server) — deliver it to the preview iframe's WebSocket polyfill.
      case "oc-ws":
        frame.contentWindow?.postMessage({ ...m.msg, type: "oc-ws", dir: "in" }, "*");
        break;

      // An SSE stream chunk the kernel routed OUT of the VM — deliver it to the
      // preview iframe's EventSource polyfill.
      case "oc-sse":
        frame.contentWindow?.postMessage({ ...m.msg, type: "oc-sse", dir: "in" }, "*");
        break;

      // The selected project's dev/app server is up: open its files + preview.
      case "demo-ready": {
        pointPreview(m.port);
        const r = runningDemos.get(m.id);
        if (r) r.port = m.port;
        else runningDemos.set(m.id, { terminalId: null, port: m.port });
        loadProject(m);
        statusEl.textContent = m.reload
          ? `${m.title} running — edits recompile + restart`
          : `${m.title} running — edits hot-reload`;
        break;
      }
      // Nest --watch recompiled + restarted after an edit → reload the preview.
      case "demo-reload":
        if (m.port === previewPort) reloadPreview();
        statusEl.textContent = `${m.title} restarted — preview reloaded`;
        break;
      case "demo-status":
        statusEl.textContent = m.line;
        if (/failed/i.test(m.line)) {
          runDemoBtn.disabled = false;
          runDemoBtn.textContent = "Run";
          demoSelect.disabled = false;
        }
        break;
    }
  };

  // roadmap #19 stage C: reverse tunnel — the preview iframe's ws polyfill posts
  // connection events UP; relay them to the kernel worker.
  addEventListener("message", (event) => {
    const d = event.data;
    if (!d || d.dir !== "out" || (d.type !== "oc-ws" && d.type !== "oc-sse")) return;
    kernelWorker.postMessage({ type: d.type, msg: d });
  });

  runDemoBtn.addEventListener("click", () => {
    const demo = demoSelect.value;
    togglePanel(true);
    // Already running in a tab? Don't start a second server (that would just
    // EADDRINUSE) — focus its terminal and re-point the preview. To force the
    // clash on purpose, open a manual shell (+) and type the command yourself.
    const running = runningDemos.get(demo);
    if (running && terminals.has(running.terminalId)) {
      switchTerminal(running.terminalId);
      if (running.port) pointPreview(running.port);
      return;
    }
    // Fresh run: open a dedicated shell tab that scaffolds + runs the dev command
    // in-VM (the server lives in this tab; closing it stops the server).
    const label = demo === "nest" ? "npm run start:dev" : "npm run dev";
    const tid = newShellTerminal({ demo, label });
    runningDemos.set(demo, { terminalId: tid, port: null });
    statusEl.textContent = "installing from npm + booting in-VM…";
  });

  // The Service Worker posts preview requests here; forward to the kernel worker,
  // transferring the reply port so it answers directly.
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "oc-http") return;
    kernelWorker.postMessage({ type: "oc-http", req: event.data.req }, [event.ports[0]]);
  });

  await registerServiceWorker();
  // VFS whole-file lazy compression is ON by default; `?compress=0` disables it
  // (A/B comparison or debugging).
  const compress = new URLSearchParams(location.search).get("compress") !== "0";
  kernelWorker.postMessage({ type: "init", compress });
}

main();
