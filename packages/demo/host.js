// Browser host (main thread) — UI + orchestration ONLY.
//
// A StackBlitz-style IDE around the OpenContainer kernel worker. This file:
//   - boots the kernel worker (kernel + Rust/Wasm VFS + process workers),
//   - registers the preview Service Worker and relays its HTTP requests in,
//   - drives a Monaco editor + file tree over the running project's VFS files,
//   - streams ALL process/kernel output into an xterm terminal verbatim (ANSI
//     colors intact — the Vite banner and Nest's colored logs look exactly like
//     a local run), and
//   - auto-saves edits into the VFS, where the real in-VM watcher drives HMR
//     (Vite) or a recompile+restart (Nest --watch).
// The heavy work stays off the main thread; here we only orchestrate + render.

import { monaco, Terminal, FitAddon } from "./vendor/editor/editor.js";

// Monaco's language *services* (diagnostics/IntelliSense) run in web workers we
// would have to wire up; we don't need them for a demo editor. Syntax coloring
// runs on the main thread regardless, so hand Monaco a silent no-op worker to
// keep it from trying (and to stay COEP-safe — no cross-origin worker URLs).
self.MonacoEnvironment = {
  getWorker() {
    const blob = new Blob([""], { type: "text/javascript" });
    return new Worker(URL.createObjectURL(blob));
  },
};

// The language *services* (diagnostics) are what would drive the worker; turn them
// off so nothing tries to talk to our silent worker. Syntax coloring (Monarch)
// runs on the main thread and is unaffected — files still highlight correctly.
try {
  for (const d of [monaco.languages.typescript?.typescriptDefaults, monaco.languages.typescript?.javascriptDefaults]) {
    d?.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: true });
    d?.setEagerModelSync(false);
  }
} catch {
  /* language pack not present — fine */
}

const demoSelect = document.getElementById("demo-select");
const runDemoBtn = document.getElementById("run-demo");
const statusEl = document.getElementById("status");
const frame = document.getElementById("preview");
const previewUrlEl = document.getElementById("preview-url");
const treeEl = document.getElementById("filetree");
const editorHost = document.getElementById("editor");
const tabNameEl = document.getElementById("tab-name");
const termHost = document.getElementById("terminal");
const clearTermBtn = document.getElementById("clear-term");

let previewPort = null; // the demo server that owns the preview iframe
let currentDemo = null; // { id, dir, reload }
const localFiles = {}; // abs VFS path -> latest editor text (per session)
const models = new Map(); // abs VFS path -> monaco model
let editor = null;
let activePath = null;

// ── Terminal ────────────────────────────────────────────────────────────────
const term = new Terminal({
  convertEol: true, // process output uses "\n"; xterm needs CR — convert on write
  cursorBlink: false,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  fontSize: 12,
  scrollback: 5000,
  theme: {
    background: "#05070b",
    foreground: "#cdd2dc",
    cursor: "#4a9eff",
    selectionBackground: "#26344d",
  },
});
const fit = new FitAddon();
term.loadAddon(fit);
term.open(termHost);
const refit = () => {
  try {
    fit.fit();
  } catch {
    /* not visible yet */
  }
};
new ResizeObserver(refit).observe(termHost);
setTimeout(refit, 0);

const ESC = "\x1b[";
const termLine = (text, color) => term.writeln(color ? `${ESC}${color}m${text}${ESC}0m` : text);
clearTermBtn.addEventListener("click", () => term.clear());

// ── File tree ─────────────────────────────────────────────────────────────
// Render the project's real files as a collapsible-looking tree (dirs then
// files, alphabetical). Clicking a file opens it in the editor.
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
      row.style.paddingLeft = 12 + depth * 14 + "px";
      row.innerHTML = `<span class="tree-icon">▸</span><span>${name}</span>`;
      treeEl.appendChild(row);
      walk(child, depth + 1);
    }
    for (const [name, rel] of filez) {
      const row = document.createElement("div");
      row.className = "tree-item file";
      row.style.paddingLeft = 12 + depth * 14 + "px";
      row.dataset.rel = rel;
      row.innerHTML = `<span class="tree-icon">▪</span><span>${name}</span>`;
      row.addEventListener("click", () => openFile(rel));
      treeEl.appendChild(row);
    }
  };
  walk(root, 0);
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

let saveTimer = null;
function scheduleSave(abs) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const contents = models.get(abs)?.getValue() ?? localFiles[abs] ?? "";
    localFiles[abs] = contents;
    kernelWorker.postMessage({ type: "oc-write", path: abs, contents });
    const short = abs.split("/").slice(-2).join("/");
    statusEl.textContent = currentDemo?.reload
      ? `saved ${short} → recompiling + restarting…`
      : `saved ${short} → hot-updating…`;
  }, 350); // debounce so a burst of keystrokes is one write (real-editor feel)
}

function ensureEditor() {
  if (editor) return;
  editorHost.innerHTML = "";
  editor = monaco.editor.create(editorHost, {
    model: null,
    theme: "vs-dark",
    automaticLayout: true,
    fontSize: 13,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    tabSize: 2,
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  });
}

function openFile(rel) {
  if (!currentDemo) return;
  ensureEditor();
  const abs = currentDemo.dir + "/" + rel;
  let model = models.get(abs);
  if (!model) {
    const uri = monaco.Uri.file(abs);
    model = monaco.editor.getModel(uri) || monaco.editor.createModel(localFiles[abs] ?? "", languageFor(rel), uri);
    model.onDidChangeContent(() => scheduleSave(abs));
    models.set(abs, model);
  }
  editor.setModel(model);
  activePath = rel;
  tabNameEl.textContent = rel;
  for (const el of treeEl.querySelectorAll(".tree-item.file")) {
    el.classList.toggle("active", el.dataset.rel === rel);
  }
  editor.focus();
}

function loadProject(m) {
  currentDemo = { id: m.id, dir: m.dir, reload: !!m.reload };
  const files = m.files || {};
  for (const [rel, contents] of Object.entries(files)) {
    localFiles[m.dir + "/" + rel] = contents;
  }
  renderTree(files);
  if (m.entry && files[m.entry]) openFile(m.entry);
  else {
    const first = Object.keys(files)[0];
    if (first) openFile(first);
  }
}

// ── Service Worker (preview proxy) ────────────────────────────────────────
async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    termLine("Service workers unavailable — preview disabled.", "31");
    return false;
  }
  // Root scope so the SW can intercept Vite's root-absolute subresources
  // (/@vite/client, /src/main.jsx, /node_modules/...); it routes each to the
  // right in-VM port by the requesting iframe's URL. Needs Service-Worker-
  // Allowed: / on the script (server.mjs).
  await navigator.serviceWorker.register("./sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  termLine("Service Worker registered (preview proxy ready).", "32");
  return true;
}

function pointPreview(port) {
  previewPort = port;
  previewUrlEl.textContent = `/preview/${port}/`;
  frame.src = `./preview/${port}/`;
}

// ── Kernel worker ─────────────────────────────────────────────────────────
let kernelWorker = null;

async function main() {
  if (typeof SharedArrayBuffer === "undefined") {
    termLine(
      "SharedArrayBuffer is undefined — the page is NOT cross-origin isolated. Serve it with COOP/COEP headers.",
      "31",
    );
    return;
  }

  // `?reset` wipes the OPFS-mirrored VFS before boot (clean slate).
  if (new URLSearchParams(location.search).has("reset")) {
    try {
      const dir = await navigator.storage.getDirectory();
      await dir.removeEntry("oc-vfs", { recursive: true });
      termLine("OPFS persistence reset — cleared the persisted VFS.", "90");
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
        term.write(m.chunk);
        break;
      case "stderr":
        term.write(m.chunk);
        break;
      case "log":
        termLine(m.line, m.stream === "stderr" ? "31" : m.dim ? "90" : "");
        break;
      case "ready":
        termLine("Kernel ready.", "32");
        break;
      case "exit":
        termLine(`[kernel] pid ${m.pid} exited with code ${m.code}`, "90");
        break;
      case "listen":
        termLine(`[kernel] pid ${m.pid} listening on :${m.port}`, "90");
        break;
      // roadmap #19 stage C: a ws frame the kernel routed OUT of the VM (Vite's
      // HMR server) — deliver it to the preview iframe's WebSocket polyfill.
      case "oc-ws":
        frame.contentWindow?.postMessage({ ...m.msg, type: "oc-ws", dir: "in" }, "*");
        break;
      // The selected project's dev/app server is up: open its files + preview.
      case "demo-ready":
        pointPreview(m.port);
        runDemoBtn.disabled = false;
        runDemoBtn.textContent = "Run";
        demoSelect.disabled = false;
        loadProject(m);
        statusEl.textContent = m.reload
          ? `${m.title} running — edit a file, it recompiles + restarts`
          : `${m.title} running — edit a file, it hot-reloads`;
        break;
      // Nest --watch recompiled + restarted after an edit → reload the preview.
      case "demo-reload":
        if (m.port === previewPort) frame.src = `./preview/${m.port}/?t=${Date.now()}`;
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
    if (!d || d.type !== "oc-ws" || d.dir !== "out") return;
    kernelWorker.postMessage({ type: "oc-ws", msg: d });
  });

  runDemoBtn.addEventListener("click", () => {
    const demo = demoSelect.value;
    runDemoBtn.disabled = true;
    demoSelect.disabled = true;
    runDemoBtn.textContent = "starting…";
    statusEl.textContent = "installing from npm + booting in-VM…";
    kernelWorker.postMessage({ type: "start-demo", demo });
  });

  // The Service Worker posts preview requests here; forward to the kernel worker,
  // transferring the reply port so it answers directly.
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "oc-http") return;
    kernelWorker.postMessage({ type: "oc-http", req: event.data.req }, [event.ports[0]]);
  });

  await registerServiceWorker();
  kernelWorker.postMessage({ type: "init" });
}

main();
