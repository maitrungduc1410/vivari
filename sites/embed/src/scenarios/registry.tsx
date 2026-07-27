import type { ReactNode } from "react";
import { NodeTerminal } from "./NodeTerminal";
import { ReactPreview } from "./ReactPreview";

// Every embeddable example, keyed by the `?scenario=` query parameter that
// <Playground scenario="..."> passes from the docs and the blog. Adding a demo
// to a post means adding an entry here, not a new route or a new component.

export type ScenarioDef = {
  /** Shown in the docs chrome bar when the post does not override it. */
  label: string;
  render: () => ReactNode;
};

// --- teardown demos -------------------------------------------------------

// Post: "The one browser API that makes a Node runtime possible". Proves the
// claim the post rests on — that `readFileSync` really does return bytes
// synchronously, with no await anywhere in the call path.
const SYNC_FS = `import fs from "node:fs";

// No await anywhere below. If this prints, a synchronous syscall really did
// cross from this worker into the kernel and back.
fs.writeFileSync("/notes.txt", "written synchronously\\n");

const before = performance.now();
const text = fs.readFileSync("/notes.txt", "utf8");
const elapsed = (performance.now() - before).toFixed(2);

console.log("read back:", JSON.stringify(text));
console.log("blocking round-trip:", elapsed, "ms");

// statSync, readdirSync and friends take the same path.
console.log("size:", fs.statSync("/notes.txt").size, "bytes");
console.log("cwd contains:", fs.readdirSync("/").join(", "));
`;

// Post: "Running Node's real lib/ in a browser tab". Shows core modules that
// are the genuine upstream Node sources, not hand-written approximations.
const REAL_LIB = `import path from "node:path";
import { EventEmitter } from "node:events";
import { format, inspect } from "node:util";

// These are Node's own lib/*.js files, running unmodified.
console.log(path.posix.normalize("/a/b/../c//d/"));
console.log(path.relative("/app/src", "/app/dist/bundle.js"));

const bus = new EventEmitter();
bus.once("ping", (n) => console.log("got ping", n));
bus.emit("ping", 42);
console.log("listeners left:", bus.listenerCount("ping"));

console.log(format("%s has %d %j", "buffer", 3, { modes: ["r", "w"] }));
console.log(inspect(new Map([["nested", new Set([1, 2])]]), { depth: 4 }));

// Buffer is the real implementation too, typed arrays and all.
const buf = Buffer.from("vivari", "utf8");
console.log(buf, buf.toString("base64"), buf.readUInt8(0));
`;

// Post: "llhttp compiled to Wasm". Runs a request through the same parser the
// in-VM HTTP server uses, so the reader can watch it split a raw byte stream.
const HTTP_PARSER = `import http from "node:http";

const server = http.createServer((req, res) => {
  console.log("parsed request line:", req.method, req.url, "HTTP/" + req.httpVersion);
  console.log("parsed headers:", JSON.stringify(req.headers, null, 2));
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, seen: req.url }));
});

server.listen(3000, async () => {
  console.log("listening on 127.0.0.1:3000 - inside this tab\\n");

  const res = await fetch("http://127.0.0.1:3000/hello?from=blog", {
    headers: { "x-demo": "llhttp-in-wasm" },
  });
  console.log("\\nresponse status:", res.status);
  console.log("response body:", await res.text());
  server.close();
});
`;

export const SCENARIOS: Record<string, ScenarioDef> = {
  node: { label: "Live Node terminal", render: () => <NodeTerminal /> },
  react: { label: "Live React dev server", render: () => <ReactPreview /> },
  "sync-fs": {
    label: "A synchronous syscall, for real",
    render: () => <NodeTerminal source={SYNC_FS} filename="sync-fs.js" />,
  },
  "real-lib": {
    label: "Node's own core modules",
    render: () => <NodeTerminal source={REAL_LIB} filename="real-lib.js" />,
  },
  "http-parser": {
    label: "An in-VM HTTP server",
    render: () => <NodeTerminal source={HTTP_PARSER} filename="server.js" />,
  },
};

export const DEFAULT_SCENARIO = "node";
