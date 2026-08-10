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

// Post: "Node can require() an ES module now, and it refuses two things".
// The two things Node's own synchronous loader declines, a cycle across the
// CommonJS/ESM boundary and top-level await, both happen here in front of the
// reader. The module graph is written into the VFS by the entry file, so the
// whole thing stays one editable buffer.
const ESM_LIVE_BINDINGS = `import fs from "node:fs";

// Node's own require(esm) is stable now, and documents two refusals:
// no top-level await anywhere in the required graph, and no cycles
// across the CommonJS/ESM boundary. It can refuse, because import() is always
// there as an escape hatch. In a browser worker there is no escape hatch, so
// this loader had to say yes to both. Everything below is written into the
// virtual filesystem and then imported, so the whole graph is one editable file.

fs.writeFileSync(
  "/counter.mjs",
  \`import { report } from "./reporter.mjs";

export let count = 0;              // mutable, and exported through a getter
export function bump() { count += 1; }

// The cycle: reporter.mjs imports this module right back, and it runs this
// line before this module has finished evaluating.
report("counter.mjs body is still running");
\`,
);

fs.writeFileSync(
  "/reporter.mjs",
  \`import { count } from "./counter.mjs";

// Not a getter read on the default path: transpileEsm compiles this to one
// eager const count = __oc_m0["count"]. That throws mid-cycle, because
// counter.mjs is still in its temporal dead zone, so module.js recompiles this
// file through transpileEsmLive, which rebinds the imports as getters inside a
// with block. Both are load-bearing: emit those export getters after the
// import requires and the fallback has nothing to read, so this is undefined
// forever and nothing throws. Astro's middleware failed exactly there.
export function report(msg) {
  console.log("   reporter:", msg, "| count =", count);
}
\`,
);

fs.writeFileSync(
  "/legacy.cjs",
  \`// What every transpiler emits, and the interop question that follows it.
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = { from: "the default export" };
exports.named = "the named export";
\`,
);

fs.writeFileSync(
  "/shape.ts",
  \`// No tsc, no esbuild, no await. A synchronous token rewriter strips this at
// load time, and the hard part is deciding that the '<' below opens a generic
// rather than being a less-than.
export interface Point { x: number; y: number }

export function first<T>(items: T[]): T | undefined {
  return items[0];
}

export const origin = { x: 0, y: 0 } satisfies Point;
\`,
);

console.log("1. a circular import, and a live binding that is really a fallback");
const counter = await import("./counter.mjs");
const reporter = await import("./reporter.mjs");
reporter.report("both modules finished");
counter.bump();
counter.bump();
reporter.report("after two bump() calls");
console.log("   read from the namespace:", counter.count);

console.log();
console.log("2. CommonJS with __esModule, imported as ESM");
const legacy = await import("./legacy.cjs");
console.log("   .default:", legacy.default);
console.log("   .named:  ", legacy.named);
console.log("   (delete the __esModule line and .default becomes the whole");
console.log("    module.exports, which is what Node gives you for plain CJS)");

console.log();
console.log("3. TypeScript, stripped synchronously at load");
const shape = await import("./shape.ts");
console.log("   first([10, 20, 30]) =", shape.first([10, 20, 30]));
console.log("   origin =", shape.origin);

console.log();
console.log("Edit any module source above and press Run again.");
`;

// Post: "Bun runs in the tab and there is no Bun in it". Real wyhash, real
// argon2id and a real SQLite, and then the part the post is about: the sentence
// a shim owes you when an API cannot exist in a browser, which is a different
// sentence from the one for an API nobody has written yet.
const BUN_SHIM = `// There is no wasm32 build of Bun, so there is no Bun binary in this page.
// What is here is Bun's API, implemented on top of Vivari's Node runtime,
// including the parts that say no.
import { Database } from "bun:sqlite";

interface Row { id: number; name: string }

console.log("Bun", Bun.version, "- and there is no Bun executable anywhere.");
console.log();

// --- things that are exactly what they claim to be -------------------------
// wyhash final v3, pinned to the published vectors. This used to be a bespoke
// multiply-xor hash that agreed with real Bun on nothing.
console.log("Bun.hash('vivari')      ", Bun.hash("vivari"));
console.log("CryptoHasher sha256     ", new Bun.CryptoHasher("sha256").update("vivari").digest("hex").slice(0, 32) + "...");
console.log("Bun.escapeHTML          ", Bun.escapeHTML('<a href="#">&</a>'));
console.log("Bun.semver.satisfies    ", Bun.semver.satisfies("1.4.2", "^1.2.0"));
console.log("Bun.deepEquals          ", Bun.deepEquals({ a: [1, 2] }, { a: [1, 2] }));
console.log("Bun.stringWidth         ", Bun.stringWidth("hello"), "vs", Bun.stringWidth("\\u4f60\\u597d"));

// Real argon2id at Bun's own cost parameters: m=65536 KiB, t=2, p=1. That is
// 64 MiB of memory-hard work, so the number below is supposed to be large.
const t0 = Bun.nanoseconds();
const stored = Bun.password.hashSync("correct horse battery staple");
const hashMs = (Bun.nanoseconds() - t0) / 1e6;
console.log();
console.log("Bun.password.hashSync   ", stored.slice(0, 32) + "...");
console.log("  algorithm              argon2id, took", hashMs.toFixed(0), "ms");
console.log("  verifySync             ", Bun.password.verifySync("correct horse battery staple", stored));

// --- real SQLite, with the Emscripten glue thrown away ---------------------
// The engine is the official sqlite3.wasm. Its 578 KB of Emscripten runtime is
// not here; the .wasm is driven directly, and its file I/O lands on the same
// synchronous syscall bridge that fs.readFileSync uses.
const db = new Database(":memory:");
db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)");
db.run("INSERT INTO t (name) VALUES (?), (?), (?)", "ada", "grace", "radia");
const rows = db.query("SELECT id, name FROM t ORDER BY name").all() as Row[];
console.log();
console.log("bun:sqlite              ", db.query("SELECT sqlite_version() AS v").get());
console.log("  rows                  ", rows.map((r) => \`\${r.id}:\${r.name}\`).join(", "));
db.close();

// --- and the part this post is actually about ------------------------------
try {
  Bun.udpSocket({ port: 0 });
} catch (err) {
  console.log();
  console.log("Bun.udpSocket()          throws, and the sentence is the point:");
  console.log("  " + (err as Error).message);
}

console.log();
console.log("Two message shapes, and the difference is load-bearing:");
console.log('  "not supported in Vivari (browser sandbox)" = stop, redesign.');
console.log('  "not implemented in the Vivari shim"        = a gap, send a patch.');
console.log();
console.log("Uncomment any of these and run again to read its refusal:");
// Bun.listen({ hostname: "0.0.0.0", port: 3000, socket: {} });
// Bun.dlopen("libc.so", {});
// Bun.zstdCompressSync(Buffer.from("hello"));
// new Bun.RedisClient("redis://localhost:6379");
// Bun.generateHeapSnapshot();
`;

// Post: "A Nuxt dev server in a tab cost 3.46 GB". The filesystem does not tell
// guest code whether it stored a file compressed, so this recomputes the gate's
// own two tests on three samples rather than reporting its verdict. The third
// sample is the one that matters: deflating it makes it bigger.
const VFS_COMPRESSION = `import fs from "node:fs";
import zlib from "node:zlib";
import { randomBytes } from "node:crypto";

// The largest addressable object in a tab running a real project is not the
// framework. It is node_modules, held as bytes in a Rust filesystem's linear
// memory. Compressing cold files took a Nuxt tree from 929.0 MB to 273.6 MB.
//
// Two constants decide it, straight out of packages/vfs/src/lib.rs:
const MIN_COMPRESS_BYTES = 4096;   // below this, zlib framing is not worth it
const MIN_COMPRESS_RATIO = 0.95;   // above this, inflating later costs more

const SIZE = 1 << 20;              // 1 MiB, so each write is chunked at 512 KiB

const samples = {
  // What node_modules is actually made of.
  "javascript source": Buffer.from(
    'export function greet(name) { return "hello, " + name; }\\n'.repeat(
      Math.ceil(SIZE / 57),
    ),
  ).subarray(0, SIZE),

  // The best case, and a useful upper bound on what the gate can win.
  "one byte, repeated": Buffer.alloc(SIZE, 0x61),

  // A .tgz, a .png, a .wasm. Compressing this twice is pure loss, which is
  // exactly what the ratio test exists to notice.
  "already compressed": randomBytes(SIZE),
};

for (const [label, bytes] of Object.entries(samples)) {
  const t0 = performance.now();
  fs.writeFileSync("/sample.bin", bytes);
  const wrote = performance.now() - t0;

  const t1 = performance.now();
  const back = fs.readFileSync("/sample.bin");
  const read = performance.now() - t1;

  // The same deflate, from the same Rust crate the filesystem uses. This is
  // the gate's own test, run here in front of you rather than reported by it:
  // the VFS does not tell guest code what it decided.
  const t2 = performance.now();
  const packed = zlib.deflateSync(bytes);
  const deflate = performance.now() - t2;

  const ratio = packed.length / bytes.length;
  const bigEnough = bytes.length >= MIN_COMPRESS_BYTES;
  const worthIt = packed.length < bytes.length * MIN_COMPRESS_RATIO;

  console.log(label);
  console.log("  size            ", bytes.length.toLocaleString(), "bytes");
  console.log("  deflates to     ", packed.length.toLocaleString(), "bytes  (ratio " + ratio.toFixed(3) + ")");
  console.log("  >= 4096 bytes   ", bigEnough);
  console.log("  beats 0.95      ", worthIt);
  console.log("  the VFS keeps it", bigEnough && worthIt ? "COMPRESSED" : "RAW");
  console.log(
    "  writeFileSync    " + wrote.toFixed(1) + " ms   readFileSync " +
      read.toFixed(1) + " ms   deflate " + deflate.toFixed(1) + " ms",
  );
  console.log("  round-trips     ", back.equals(bytes));
  console.log();
}

fs.unlinkSync("/sample.bin");
console.log("Change SIZE to 2048 and run again. Every sample fails the gate on");
console.log("the size test alone, before the ratio is ever computed.");
`;

// --- python demos ---------------------------------------------------------
//
// All three run `python`, which is CPython 3.14 compiled to WebAssembly by
// Pyodide. All three are deliberately standard library only: the frameworks
// that sit on top of this bridge (Flask, FastAPI, Django) ship as experimental
// templates, and a live demo is the wrong place to blur that line.

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

// Post: "A step debugger with no inspector to talk to". The Python half of that
// post rests on one measurement, and this is where it comes from. Both APIs are
// asked the same question on the same loop; only one of them can answer "stop
// calling me about this line", and the event counts at the end show the size of
// the difference more plainly than the timings do.
const PYTHON_MONITORING = `# There is no V8 inspector in a browser worker, so Vivari's JavaScript debugger
# weaves probes into your source. CPython needs none of that: it has had a
# debugging interface forever. The question is which one, and the answer is
# worth about 10x.
import sys
import time

N = 300_000

# A debugger's breakpoint table. Empty, on purpose: this measures what a
# debugger costs when it is attached and NOT stopping, which is the state a
# debugger spends almost all of its life in.
BREAKPOINTS = set()


def hot():
    total = 0
    for i in range(N):
        total += i
    return total


def bench(label, fn):
    start = time.perf_counter()
    fn()
    print("  %-32s %7.1f ms" % (label, (time.perf_counter() - start) * 1000))


print("CPython", sys.version.split()[0], "on", sys.platform)
print("sys.monitoring present:", hasattr(sys, "monitoring"), "(PEP 669, 3.12+)")
print()

bench("no debugger at all", hot)

# ---------------------------------------------------------------- sys.settrace
# One callback for every event, on every line, of every function. It cannot say
# "stop calling me about this line", because the API has no way to express it.
seen = {"settrace": 0, "monitoring": 0}


def tracer(frame, event, arg):
    if event == "line":
        seen["settrace"] += 1
        if (frame.f_code.co_filename, frame.f_lineno) in BREAKPOINTS:
            pass  # a real debugger would pause here
    return tracer


sys.settrace(tracer)
bench("sys.settrace, 0 breakpoints", hot)
sys.settrace(None)

# ------------------------------------------------------------- sys.monitoring
# Same job. The difference is one return value: DISABLE retires this bytecode
# location permanently, so a line that is not a breakpoint is asked about once
# and then costs nothing at all.
mon = sys.monitoring
try:
    TOOL = mon.DEBUGGER_ID
    mon.use_tool_id(TOOL, "demo")
except ValueError:
    TOOL = 3  # DEBUGGER_ID is taken; any free id will do
    mon.use_tool_id(TOOL, "demo")


def on_line(code, line_number):
    seen["monitoring"] += 1
    if (code.co_filename, line_number) in BREAKPOINTS:
        return None  # keep firing here, we might want to stop
    return mon.DISABLE  # never ask about this location again


mon.register_callback(TOOL, mon.events.LINE, on_line)
mon.set_events(TOOL, mon.events.LINE)
bench("sys.monitoring + DISABLE", hot)
mon.set_events(TOOL, 0)
mon.register_callback(TOOL, mon.events.LINE, None)
mon.free_tool_id(TOOL)

print()
print("  line events delivered, settrace:  ", seen["settrace"])
print("  line events delivered, monitoring:", seen["monitoring"])
print()
print("Now edit the file. Put a line number from inside hot() into")
print("BREAKPOINTS, for example:")
print()
print("    BREAKPOINTS = {(__file__, %d)}" % (hot.__code__.co_firstlineno + 3))
print()
print("That one location stops answering DISABLE, and the third number climbs.")
print("This is why stepping has to call sys.monitoring.restart_events(): a")
print("location that answered DISABLE never fires again until something does.")
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
  "esm-live-bindings": {
    label: "A module graph, rewritten to CommonJS at load time",
    render: () => <ScriptTerminal source={ESM_LIVE_BINDINGS} filename="index.js" />,
  },
  "bun-shim": {
    label: "Bun in a tab, including the parts that refuse",
    render: () => (
      <ScriptTerminal
        source={BUN_SHIM}
        filename="demo.ts"
        command="bun"
        language="typescript"
      />
    ),
  },
  "vfs-compression": {
    label: "The gate the filesystem runs on every file",
    render: () => <ScriptTerminal source={VFS_COMPRESSION} filename="gate.js" />,
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
  "python-monitoring": {
    label: "Why a debugger can be left on",
    render: () => (
      <ScriptTerminal
        source={PYTHON_MONITORING}
        filename="monitoring.py"
        command="python"
        packageJson={null}
      />
    ),
  },
};

export const DEFAULT_SCENARIO = "node";