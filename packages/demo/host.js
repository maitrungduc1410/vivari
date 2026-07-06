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
  await navigator.serviceWorker.register("./sw.js");
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

  const kernelWorker = new Worker(new URL("./kernel-worker.js", import.meta.url), {
    type: "module",
    name: "Kernel Worker",
  });

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
        previewUrlEl.textContent = `/packages/demo/preview/${m.port}/`;
        frame.src = url;
        break;
      }
    }
  };

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
