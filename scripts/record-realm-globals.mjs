// Records what each realm actually has, into scripts/fixtures/realm-globals.json.
//
// The realm sweep (packages/runtime/realm.js) decides what a guest may see by
// comparing the realm it is in against the globals of a real node. That list has
// to come from a real node, not from memory — and the browser side of the
// comparison has to come from a real browser Worker, because the shape of those
// properties (own vs inherited, data vs accessor) is what decides whether hiding
// a name works at all. Both are recorded here so the numbers in realm.js and
// spike-realm.mjs can be re-derived rather than believed.
//
//   node scripts/record-realm-globals.mjs --node                 # this node
//   /path/to/bun scripts/record-realm-globals.mjs --bun          # a real bun
//   node scripts/record-realm-globals.mjs --browser /path/to/chrome
//
// Each pass rewrites only its own section, so the three can be recorded on
// different machines. The browser pass drives a headless Chrome over the
// DevTools Protocol, loads a page that spawns a Worker, and asks the WORKER —
// a window's globals are a different (much larger) set, and it is a Worker a
// Vivari process runs in.

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "fixtures", "realm-globals.json");

function load() {
  try {
    return JSON.parse(readFileSync(FIXTURE, "utf8"));
  } catch {
    return { recordedFrom: {}, node: [], bun: [], browserWorker: { chain: [], own: {}, proto: {} } };
  }
}

function save(fixture) {
  mkdirSync(dirname(FIXTURE), { recursive: true });
  writeFileSync(FIXTURE, JSON.stringify(fixture, null, 1) + "\n");
  console.log("wrote " + FIXTURE);
}

/** Every name reachable on this realm's global, own and inherited. */
function names() {
  const found = new Set();
  let o = globalThis;
  while (o) {
    for (const n of Object.getOwnPropertyNames(o)) found.add(n);
    o = Object.getPrototypeOf(o);
  }
  return [...found].sort();
}

const mode = process.argv[2];

if (mode === "--node" || mode === "--bun") {
  const isBun = typeof globalThis.Bun !== "undefined";
  if (mode === "--bun" && !isBun) {
    console.error("--bun must be run BY a real bun binary, not by node:\n  /path/to/bun " + process.argv[1] + " --bun");
    process.exit(2);
  }
  if (mode === "--node" && isBun) {
    console.error("--node must be run by node; this is bun " + globalThis.Bun.version);
    process.exit(2);
  }
  const fixture = load();
  const key = isBun ? "bun" : "node";
  fixture[key] = names();
  fixture.recordedFrom[key] = isBun ? globalThis.Bun.version : process.version;
  save(fixture);
  console.log(key + ": " + fixture[key].length + " globals");
} else if (mode === "--browser") {
  const chrome = process.argv[3];
  if (!chrome) {
    console.error("usage: node scripts/record-realm-globals.mjs --browser /path/to/chrome");
    process.exit(2);
  }
  await recordBrowser(chrome);
} else {
  console.error(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(0, 20).join("\n"));
  process.exit(2);
}

async function recordBrowser(chromePath) {
  // The worker asks itself the same question `captureHostRealm` asks, and adds
  // the detail that only a real browser can answer: which names are the scope's
  // own, which are inherited, and which of those are accessors (17 of them, where
  // assigning `undefined` throws and `delete` does nothing).
  const workerJs = `
    const reply = postMessage.bind(globalThis);
    const own = {};
    for (const n of Object.getOwnPropertyNames(globalThis)) {
      own[n] = Object.getOwnPropertyDescriptor(globalThis, n).get ? "accessor" : "data";
    }
    const proto = {}; const chain = [];
    let o = Object.getPrototypeOf(globalThis);
    while (o && o !== Object.prototype) {
      const label = (o.constructor && o.constructor.name) || "?";
      chain.push(label);
      for (const n of Object.getOwnPropertyNames(o)) {
        if (proto[n]) continue;
        proto[n] = { on: label, kind: Object.getOwnPropertyDescriptor(o, n).get ? "accessor" : "data" };
      }
      o = Object.getPrototypeOf(o);
    }
    reply({ chain, own, proto, ua: navigator.userAgent });
  `;
  const dir = mkdtempSync(join(tmpdir(), "vv-realm-"));
  writeFileSync(join(dir, "w.js"), workerJs);
  // The page relays the worker's answer back over HTTP. A websocket to the
  // DevTools protocol would do too, and is three times the code for the same
  // sentence: "tell me what you have".
  writeFileSync(
    join(dir, "i.html"),
    "<script>const w=new Worker('w.js');w.onmessage=(e)=>fetch('/report',{method:'POST',body:JSON.stringify(e.data)});</script>",
  );

  // Serve over http rather than file:, because a file: page may not spawn a
  // Worker. One request handler, no dependencies.
  const { createServer } = await import("node:http");
  let deliver = null;
  const reported = new Promise((resolve) => {
    deliver = resolve;
  });
  const server = createServer((req, res) => {
    if (req.url === "/report") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(204).end();
        deliver(JSON.parse(Buffer.concat(chunks).toString()));
      });
      return;
    }
    const name = req.url === "/" ? "i.html" : req.url.slice(1);
    let body;
    try {
      body = readFileSync(join(dir, name));
    } catch {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": name.endsWith(".js") ? "text/javascript" : "text/html" });
    res.end(body);
  });
  // 127.0.0.1, not localhost: node resolves the name to ::1 while chrome binds v4.
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  // 127.0.0.1 in the URL for the same reason the listener uses it.
  const child = spawn(chromePath, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--user-data-dir=" + join(dir, "profile"),
    "http://127.0.0.1:" + port + "/",
  ]);
  const data = await Promise.race([
    reported,
    new Promise((_, reject) => setTimeout(() => reject(new Error("the browser did not report within 60s")), 60000)),
  ]).finally(() => {
    child.kill();
    server.close();
  });

  const fixture = load();
  fixture.browserWorker = { chain: data.chain, own: data.own, proto: data.proto };
  fixture.recordedFrom.browser = data.ua.replace(/^Mozilla\/[\d.]+ \([^)]*\) /, "") + " (DedicatedWorkerGlobalScope)";
  save(fixture);
  console.log(
    "browser worker: " +
      Object.keys(data.own).length +
      " own + " +
      Object.keys(data.proto).length +
      " inherited, chain " +
      data.chain.join(" -> "),
  );
}
