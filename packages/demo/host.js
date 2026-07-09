// Browser host (main thread) — UI + orchestration ONLY.
//
// Phase 2, item #1 (Kernel worker): the Kernel + Rust/Wasm VFS + process
// workers now live in kernel-worker.js, off the main thread. This file just:
//   - boots the kernel worker,
//   - registers the preview Service Worker,
//   - relays Service-Worker HTTP requests to the kernel worker (transferring the
//     reply port so it answers directly),
//   - renders the log/listen/exit messages the kernel worker posts back.
// Keeping user/kernel work off the main thread leaves the UI responsive and
// matches the target architecture (Main = UI/orchestration).

const out = document.getElementById("output");
const frame = document.getElementById("preview");
const previewUrlEl = document.getElementById("preview-url");
const startViteBtn = document.getElementById("start-vite");
const hmrStatusEl = document.getElementById("hmr-status");
const editorPanel = document.getElementById("editor-panel");
const editorPathEl = document.getElementById("editor-path");
const editorEl = document.getElementById("editor");
const applyEditBtn = document.getElementById("apply-edit");
let previewPort = null; // the first server to listen wins the preview iframe

function print(line, cls = "") {
  const el = document.createElement("div");
  el.className = "line " + cls;
  el.textContent = line;
  out.appendChild(el);
  out.scrollTop = out.scrollHeight;
}
const printChunk = (chunk, cls) => {
  for (const line of chunk.replace(/\n$/, "").split("\n")) print(line, cls);
};

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    print("Service workers unavailable — preview disabled.", "err");
    return false;
  }
  // Root scope: Vite (and other tools) serve subresources at root-absolute URLs
  // (/@vite/client, /src/main.js, /node_modules/...). Those escape a
  // /packages/demo/ scope, so the preview SW must control the whole origin to
  // intercept them; it routes each to the right in-VM port by the requesting
  // iframe's client URL. Needs `Service-Worker-Allowed: /` on the script (see
  // server.mjs) since the script itself lives under /packages/demo/.
  await navigator.serviceWorker.register("./sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  print("Service Worker registered (preview proxy ready).", "ok");
  return true;
}

async function main() {
  if (typeof SharedArrayBuffer === "undefined") {
    print(
      "SharedArrayBuffer is undefined — the page is NOT cross-origin isolated. " +
        "Serve it with COOP/COEP headers (use the dev server).",
      "err",
    );
    return;
  }
  print("crossOriginIsolated = " + self.crossOriginIsolated, "muted");

  // Persistence reset: `?reset` wipes the OPFS-mirrored VFS before boot, for a
  // clean slate (e.g. after a schema change or to clear a big node_modules).
  if (new URLSearchParams(location.search).has("reset")) {
    try {
      const dir = await navigator.storage.getDirectory();
      await dir.removeEntry("oc-vfs", { recursive: true });
      print("OPFS persistence reset — cleared the persisted VFS.", "muted");
    } catch {
      /* nothing persisted yet */
    }
  }

  const kernelWorker = new Worker(new URL("./kernel-worker.js", import.meta.url), {
    type: "module",
    name: "Kernel Worker",
  });

  // On page hide, ask the kernel to flush the write-behind OPFS mirror so the
  // last few writes reach disk before the tab is frozen/closed (best-effort).
  addEventListener("pagehide", () => kernelWorker.postMessage({ type: "fs-flush" }));

  kernelWorker.onmessage = (event) => {
    const m = event.data;
    switch (m.type) {
      case "stdout":
        printChunk(m.chunk, "");
        break;
      case "stderr":
        printChunk(m.chunk, "err");
        break;
      case "log":
        print(m.line, m.cls || "");
        break;
      case "exit":
        print(`  [kernel] pid ${m.pid} exited with code ${m.code}`, "muted");
        break;
      case "listen": {
        const url = `./preview/${m.port}/`;
        print(`  [kernel] pid ${m.pid} is listening on port ${m.port} → preview ${url}`, "ok");
        // Point the preview iframe at the first server that comes up (the app on
        // :3000). Later listens are real too — e.g. the ephemeral loopback servers
        // the /api/net and /api/http demos spin up — but they shouldn't hijack the
        // preview, so we only log them.
        if (!previewPort) {
          previewPort = m.port;
          previewUrlEl.textContent = `/packages/demo/preview/${m.port}/`;
          frame.src = url;
        }
        break;
      }
      // roadmap #19 stage C: a ws frame the kernel routed OUT of the VM (Vite's
      // HMR server -> the process' in-VM WebSocket). Deliver it to the preview
      // iframe's WebSocket polyfill (installed by the Service Worker).
      case "oc-ws": {
        // Spread FIRST, then stamp type/dir — m.msg carries the VM relay's own
        // `type: "ws-out"`, which would otherwise clobber the envelope type the
        // iframe's polyfill filters on (`type === "oc-ws"`).
        frame.contentWindow?.postMessage({ ...m.msg, type: "oc-ws", dir: "in" }, "*");
        break;
      }
      // The in-VM Vite dev server is up: swap the preview to it and open the
      // editor on the file whose edits will hot-update the running app.
      case "vite-ready": {
        previewPort = m.port;
        previewUrlEl.textContent = `/packages/demo/preview/${m.port}/`;
        frame.src = `./preview/${m.port}/`;
        startViteBtn.textContent = "Vite dev running";
        startViteBtn.disabled = true;
        hmrStatusEl.textContent = "edit the file below, then save — the app hot-updates with no reload";
        editorPathEl.textContent = m.editPath;
        editorEl.value = m.editContents;
        editorPanel.hidden = false;
        editorEl.dataset.path = m.editPath;
        break;
      }
      case "vite-status":
        hmrStatusEl.textContent = m.line;
        break;
    }
  };

  // roadmap #19 stage C: the reverse tunnel. The preview iframe's WebSocket
  // polyfill posts each connection event UP to this window; relay it to the
  // kernel worker, which routes it to the process owning the preview port.
  addEventListener("message", (event) => {
    const d = event.data;
    if (!d || d.type !== "oc-ws" || d.dir !== "out") return;
    kernelWorker.postMessage({ type: "oc-ws", msg: d });
  });

  startViteBtn.addEventListener("click", () => {
    startViteBtn.disabled = true;
    startViteBtn.textContent = "starting Vite… (installing from npm)";
    hmrStatusEl.textContent = "npm install vite + boot dev server (first run downloads ~20 packages)";
    kernelWorker.postMessage({ type: "start-vite" });
  });

  applyEditBtn.addEventListener("click", () => {
    const path = editorEl.dataset.path;
    if (!path) return;
    kernelWorker.postMessage({ type: "oc-write", path, contents: editorEl.value });
    hmrStatusEl.textContent = "saved " + path + " → hot-updating…";
  });

  // The Service Worker posts preview requests to this window (it can only reach
  // window clients). We forward them to the kernel worker, transferring the SW's
  // reply port so it can respond directly without a second relay hop.
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "oc-http") return;
    kernelWorker.postMessage({ type: "oc-http", req: event.data.req }, [event.ports[0]]);
  });

  await registerServiceWorker();
  kernelWorker.postMessage({ type: "init" });
}

main();
