// Spike (OFFLINE, host only): a web stream a process builds must carry the closed-promise
// stream.finished() reads, settled by the same events as Node's own, and
// performance.markResourceTiming must exist. One timing difference is pinned rather than
// hidden: see "known divergence" at the end.
//
// WHY THIS EXISTS. In a browser Worker a process's ReadableStream and WritableStream
// are the platform's, which lack the closed-promise Node's own web streams carry under
// Symbol.for('nodejs.webstream.isClosedPromise'). finished() (end-of-stream.js eosWeb)
// threw on them, and undici's fetch, which pnpm 11 uses for the registry, aborted
// every response with that TypeError. packages/runtime/web-globals.js adds it.
//
// HOW IT IS GATED. The headless harness runs processes on Node's own classes, which
// already have it, so the VM cannot show the bug here. Instead each scenario runs on
// real Node's classes (the oracle) and on browser-like ones (Node's, with the
// closed-promise taken off each instance) after installWebGlobals(), and reads
// `stream[kIsClosedPromise].promise` exactly as the vendored eosWeb does; the
// transcripts must match line for line. A control run without installWebGlobals must
// throw where eosWeb threw. (The host's own finished() is not the code under test:
// newer Node tolerates the missing promise.)
//
// The scenarios compare each stream's END state, so they cannot see WHEN the promise
// settles. That matters for one case: Node settles a readable's promise only when the
// stream really closes, after its queued chunks are read, while web-globals.js settles it
// at controller.close() because nothing observable fires when a platform queue drains.
// So finished() reports a readable done while chunks are still queued. The last block
// measures that on both sides and asserts the difference, so it goes red if the gap is
// closed (update the docs then) or grows into the other events.
//
//   run:  node scripts/spike-web-globals.mjs

import { installWebGlobals } from "../packages/runtime/web-globals.js";

const k = Symbol.for("nodejs.webstream.isClosedPromise");
let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};

function browserLike() {
  const strip = (Native) => {
    // Node keeps it on an instance or behind a getter on the prototype, by version.
    const C = class extends Native {
      constructor(...args) {
        super(...args);
        delete this[k];
      }
      get [k]() {
        return undefined;
      }
    };
    Object.defineProperty(C, "name", { value: Native.name });
    return C;
  };
  return { ReadableStream: strip(ReadableStream), WritableStream: strip(WritableStream), performance: { now: () => performance.now() } };
}

function settle(stream, act) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve("timeout"), 500);
    try {
      // end-of-stream.js eosWeb: PromisePrototypeThen(stream[kIsClosedPromise].promise, …)
      const done = (err) => {
        clearTimeout(timer);
        resolve(err ? `error ${err.message ?? err}` : "ok");
      };
      stream[k].promise.then(() => done(), done);
    } catch (e) {
      clearTimeout(timer);
      return resolve(`threw ${e.message}`);
    }
    Promise.resolve(act()).catch(() => {});
  });
}

async function scenarios({ ReadableStream: RS, WritableStream: WS }) {
  const out = [];
  const drain = async (s) => {
    const r = s.getReader();
    while (!(await r.read()).done);
  };
  let s = new RS({ start(c) { c.enqueue("a"); c.close(); } });
  out.push("read to end: " + (await settle(s, () => drain(s))));
  s = new RS({ pull(c) { c.enqueue("x"); } });
  out.push("cancel: " + (await settle(s, () => s.cancel("stop"))));
  let ctl;
  s = new RS({ start(c) { ctl = c; } });
  out.push("controller.error: " + (await settle(s, () => ctl.error(new Error("boom")))));
  s = new RS({ pull() { throw new Error("pull failed"); } });
  out.push("pull throws: " + (await settle(s, () => drain(s))));
  s = new RS({ type: "bytes", start(c) { c.enqueue(new Uint8Array([1, 2])); c.close(); } });
  out.push("byte stream: " + (await settle(s, () => drain(s))));
  let w = new WS({ write() {} });
  out.push("writable close: " + (await settle(w, async () => { const x = w.getWriter(); await x.write("a"); await x.close(); })));
  w = new WS({ write() { throw new Error("nope"); } });
  out.push("writable write throws: " + (await settle(w, () => w.getWriter().write("a"))));
  w = new WS({});
  out.push("writable abort: " + (await settle(w, () => w.abort(new Error("gone")))));
  return out;
}

console.log("== control: browser-like streams without installWebGlobals ==");
const control = await scenarios(browserLike());
ok(control.every((l) => l.includes("threw Cannot read properties of undefined (reading 'promise')")), "the read eosWeb does throws on every scenario, as finished() did in the browser");

console.log("== browser-like streams with installWebGlobals, against real Node ==");
const oracle = await scenarios(globalThis);
const g = browserLike();
installWebGlobals(g);
const vm = await scenarios(g);
for (let i = 0; i < oracle.length; i++) ok(vm[i] === oracle[i], `${vm[i]}${vm[i] === oracle[i] ? "" : `  (node: ${oracle[i]})`}`);

const platform = browserLike();
const platformMade = new platform.ReadableStream();
installWebGlobals(platform);
ok(platformMade instanceof platform.ReadableStream, "a stream the platform made is still instanceof ReadableStream");
ok(platform.ReadableStream.name === "ReadableStream", "the class keeps its name");
ok(typeof g.performance.markResourceTiming === "function", "performance.markResourceTiming exists");

const native = { ReadableStream, WritableStream, performance };
installWebGlobals(native);
ok(native.ReadableStream === ReadableStream && native.WritableStream === WritableStream, "Node's own classes are left alone");

// Known divergence: when does a readable with queued chunks count as closed?
console.log("== known divergence: a readable closed with chunks still queued ==");
async function closeTiming(RS) {
  const s = new RS({ start(c) { c.enqueue("a"); c.enqueue("b"); c.close(); } });
  let settled = false;
  s[k].promise.then(() => (settled = true));
  await new Promise((r) => setTimeout(r, 20));
  const before = settled;
  const r = s.getReader();
  while (!(await r.read()).done);
  await new Promise((r) => setTimeout(r, 20));
  return `before reading: ${before}, after reading: ${settled}`;
}
const nodeTiming = await closeTiming(ReadableStream);
const oursTiming = await closeTiming(g.ReadableStream);
ok(nodeTiming === "before reading: false, after reading: true", `Node settles only once the queue is read (${nodeTiming})`);
ok(
  oursTiming === "before reading: true, after reading: true",
  `ours settles at controller.close(), before the queue is read (${oursTiming}); if this changes, the gap moved: update this check, AGENTS.md and roadmap.md`,
);

console.log(failed ? `\nFAILED: ${failed}` : "\nall passed");
process.exit(failed ? 1 : 0);
