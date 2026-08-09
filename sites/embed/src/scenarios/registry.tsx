import type { ReactNode } from "react";
import { ScriptTerminal } from "./ScriptTerminal";
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

// --- python demos ---------------------------------------------------------
//
// Both run `python`, which is CPython 3.14 compiled to WebAssembly by Pyodide.
// Both are deliberately standard library only: the frameworks that sit on top
// of this bridge (Flask, FastAPI, Django) ship as experimental templates, and a
// live demo is the wrong place to blur that line.

// Post: "Flask, Django and FastAPI answering real requests, with no socket
// underneath". Proves the claim the post rests on: what the bridge hands a
// Python web app is a real WSGI call, checked by CPython's own validator, with
// no socket anywhere in it.
const PYTHON_WSGI = `# A WSGI application is a function, and PEP 3333 says nothing about sockets.
# That is the whole reason a Python web app can be served from a browser tab.
import io
import sys
from wsgiref.util import request_uri
from wsgiref.validate import validator


def application(environ, start_response):
    start_response("200 OK", [("Content-Type", "text/plain; charset=utf-8")])
    version = sys.version.split()[0]
    line = environ["REQUEST_METHOD"] + " " + environ["PATH_INFO"]
    return [(line + " answered by CPython " + version).encode("utf-8")]


# The environ Vivari's bridge builds for every request. SCRIPT_NAME is the
# preview prefix the tunnel already stripped off; PATH_INFO is what is left for
# your routes to match against.
environ = {
    "REQUEST_METHOD": "GET",
    "SCRIPT_NAME": "/preview/8000",
    "PATH_INFO": "/hello",
    "QUERY_STRING": "from=blog",
    "SERVER_NAME": "localhost",
    "SERVER_PORT": "80",
    "SERVER_PROTOCOL": "HTTP/1.1",
    "wsgi.version": (1, 0),
    "wsgi.url_scheme": "http",
    "wsgi.input": io.BytesIO(b""),
    "wsgi.errors": sys.stderr,
    # Honestly False, both of them: one interpreter, and no OS threads at all.
    "wsgi.multithread": False,
    "wsgi.multiprocess": False,
    "wsgi.run_once": False,
}

captured = {}


def start_response(status, headers, exc_info=None):
    captured["status"] = status
    captured["headers"] = headers
    return lambda data: None


# wsgiref.validate is CPython's own PEP 3333 conformance checker. If the call
# below returns without raising, the standard library agrees this was a real
# WSGI interaction rather than something merely shaped like one.
result = validator(application)(environ, start_response)
try:
    body = b"".join(result)
finally:
    if hasattr(result, "close"):
        result.close()

print("status: ", captured["status"])
print("headers:", captured["headers"])
print("body:   ", body.decode())

# Why url_for() and reverse() keep working behind the preview: the prefix is
# part of the request, so a generated URL stays inside it instead of escaping.
print("uri:    ", request_uri(environ))
print()
print("Validated by the standard library. No socket was involved.")
`;

// Post: "There was never a second import pandas". Lets the reader check the
// two claims that post depends on: that this really is CPython rather than an
// imitation, and that the two bytecode settings are set the way it says.
const PYTHON_INTERPRETER = `# Not a reimplementation and not a transpiler: this is CPython itself,
# compiled to WebAssembly by Pyodide, running in the tab you are reading.
import platform
import sys
import sysconfig
import time

print("version:       ", sys.version.split()[0])
print("implementation:", sys.implementation.name)
print("platform:      ", sys.platform)
print("build target:  ", sysconfig.get_platform())
print("machine:       ", platform.machine())

# The two interpreter settings the post is about. Pyodide switches bytecode
# writing off, which is the right default when every interpreter is thrown
# away. Vivari switches it back on and keeps what the import produced.
print()
print("sys.dont_write_bytecode:", sys.dont_write_bytecode)
print("sys.pycache_prefix:     ", sys.pycache_prefix)

start = time.perf_counter()
import decimal
import fractions
import statistics

print()
print("three stdlib imports: %.1f ms" % ((time.perf_counter() - start) * 1000))
print()
print("Press Run again. That is a new process with a new interpreter, and")
print("after the first one they resume from a snapshot instead of booting.")
`;

export const SCENARIOS: Record<string, ScenarioDef> = {
  node: { label: "Live Node terminal", render: () => <ScriptTerminal /> },
  react: { label: "Live React dev server", render: () => <ReactPreview /> },
  "sync-fs": {
    label: "A synchronous syscall, for real",
    render: () => <ScriptTerminal source={SYNC_FS} filename="sync-fs.js" />,
  },
  "real-lib": {
    label: "Node's own core modules",
    render: () => <ScriptTerminal source={REAL_LIB} filename="real-lib.js" />,
  },
  "http-parser": {
    label: "An in-VM HTTP server",
    render: () => <ScriptTerminal source={HTTP_PARSER} filename="server.js" />,
  },
  "python-wsgi": {
    label: "A real WSGI call, with no socket",
    render: () => (
      <ScriptTerminal
        source={PYTHON_WSGI}
        filename="wsgi_demo.py"
        command="python"
        packageJson={null}
      />
    ),
  },
  "python-interpreter": {
    label: "Real CPython, and the two settings behind the cache",
    render: () => (
      <ScriptTerminal
        source={PYTHON_INTERPRETER}
        filename="interpreter.py"
        command="python"
        packageJson={null}
      />
    ),
  },
};

export const DEFAULT_SCENARIO = "node";