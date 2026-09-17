// Does a guest get V8's structured stacks on an engine that has none?
//
// The bug this gates is GitHub #4, "Can't import express on Firefox". `express`
// -> `body-parser` -> `depd` calls Error.captureStackTrace and then indexes the
// result as an array of CallSites. Firefox 138+ HAS Error.captureStackTrace and
// gives back a writable STRING, so depd's feature test passes, `obj.stack[1]` is
// one character, and require() dies with a TypeError that mentions neither
// Firefox nor stacks.
//
// THIS CANNOT BE TESTED BY RUNNING NODE, and that is the whole reason the bug
// shipped: node is V8, so `Error.captureStackTrace` here does the right thing and
// every existing spike passed while real Firefox failed. So the engine is BUILT —
// a fake Error whose captureStackTrace behaves the way MDN documents Firefox's,
// and whose `stack` is a canned string in SpiderMonkey's `func@file:line:col`
// format, taken from the require chain in the issue. That is the same trick
// spike-realm.mjs uses for the browser global object, and for the same reason.
//
// The parser cases below are literal engine output, not invented: SpiderMonkey
// scoped-package paths (`@babel/…`, which is why frames split on the FIRST `@`),
// anonymous top-level frames, `async*` resumptions, `file line N > eval`, and
// JavaScriptCore's `[native code]`.
//
// The last section asserts the opposite: on this host, which IS V8, the shim
// installs NOTHING. A compat layer that engages on Chrome is a worse bug than the
// one it fixes, because it would be silent.
//
//   run: node scripts/run-spikes.mjs --offline error-stack

import {
  hasV8StructuredStacks,
  installV8StackCompat,
  captureCallSites,
  parseStack,
  formatUncaught,
} from "../packages/runtime/error-stack.js";

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) return console.log("  ok   " + label);
  failures++;
  console.log("  FAIL " + label + (detail ? " — " + detail : ""));
};

// ---------------------------------------------------------------------------
// A SpiderMonkey, built.
//
// The two frames at the top are OUR OWN: on a real Firefox the stack a capture
// sees begins inside error-stack.js, and the shim drops exactly that many. Baking
// them in is what makes the drop count testable rather than assumed.
const SHIM_FRAMES = [
  "captureFrames@/vivari/packages/runtime/error-stack.js:372:17",
  "captureStackTrace@/vivari/packages/runtime/error-stack.js:455:20",
];

// The real require chain from the Firefox 154 run in issue #4, in SpiderMonkey's
// own format, as it is after our loader has named each module with a sourceURL.
const EXPRESS_CHAIN = [
  "getStack@/home/project/node_modules/depd/index.js:268:9",
  "depd@/home/project/node_modules/depd/index.js:109:15",
  "@/home/project/node_modules/body-parser/index.js:14:30",
  "require@/vivari/packages/runtime/module.js:585:11",
  "@/home/project/node_modules/express/lib/express.js:15:22",
  "require@/vivari/packages/runtime/module.js:585:11",
  "@/home/project/node_modules/express/index.js:11:18",
  "require@/vivari/packages/runtime/module.js:585:11",
  "@/home/project/src/index.js:1:19",
];

/**
 * An Error constructor that behaves the way Firefox's does:
 *   - `stack` is an ACCESSOR on the prototype, returning frames and ONLY frames
 *     (no "Name: message" header — that is a V8 convention);
 *   - `captureStackTrace` exists (Firefox 138+, bug 1950508) and assigns `stack`
 *     as a writable string data property;
 *   - `prepareStackTrace` is an ordinary property nobody reads.
 */
function makeSpiderMonkey(frames) {
  const raw = frames.join("\n");
  function SMError(message) {
    if (!(this instanceof SMError)) return new SMError(message);
    this.message = message === undefined ? "" : String(message);
  }
  SMError.prototype.name = "Error";
  SMError.prototype.message = "";
  SMError.prototype.toString = function () {
    return this.message ? this.name + ": " + this.message : this.name;
  };
  Object.defineProperty(SMError.prototype, "stack", {
    configurable: true,
    enumerable: false,
    get() {
      const limit = SMError.stackTraceLimit;
      const n = typeof limit === "number" ? limit : 50;
      return frames.slice(0, n).join("\n");
    },
    set(value) {
      Object.defineProperty(this, "stack", { value, writable: true, configurable: true });
    },
  });
  SMError.stackTraceLimit = 50;
  SMError.captureStackTrace = function (target) {
    // Firefox's, per MDN: a plain writable string. This is the line that makes
    // the bug silent instead of loud.
    target.stack = raw;
  };
  return SMError;
}

console.log("\n1) the parser, against literal engine output");
{
  const cases = [
    // [line, fileName, lineNumber, columnNumber, functionName]
    [
      "getStack@/home/project/node_modules/depd/index.js:268:9",
      "/home/project/node_modules/depd/index.js", 268, 9, "getStack",
    ],
    // Anonymous top level — a module body. The name is empty, not missing.
    [
      "@/home/project/node_modules/body-parser/index.js:14:30",
      "/home/project/node_modules/body-parser/index.js", 14, 30, null,
    ],
    // EVERY scoped package puts an `@` in the path. Splitting on the last one
    // instead of the first turns this into function "pick@/home/project/node_
    // modules/" in file "babel/core/lib/index.js".
    [
      "pick@/home/project/node_modules/@babel/core/lib/config/index.js:9:3",
      "/home/project/node_modules/@babel/core/lib/config/index.js", 9, 3, "pick",
    ],
    // A full URL, which is what a frame looks like before the loader's sourceURL
    // rewrites it (and what vendored bundles still produce).
    [
      "onMessage@http://localhost:5173/packages/runtime/loop.js:121:19",
      "http://localhost:5173/packages/runtime/loop.js", 121, 19, "onMessage",
    ],
    // SpiderMonkey's nested-anonymous marker. The name is kept verbatim: `send`
    // is a DIFFERENT function from `send/<`.
    [
      "send/<@/home/project/src/server.js:42:7",
      "/home/project/src/server.js", 42, 7, "send/<",
    ],
    // No column, which older SpiderMonkey omits for some frames.
    ["boot@/home/project/src/boot.js:7", "/home/project/src/boot.js", 7, 0, "boot"],
  ];
  for (const [line, file, ln, col, name] of cases) {
    const [frame] = parseStack(line);
    check(
      "parsed: " + line,
      frame &&
        frame.getFileName() === file &&
        frame.getLineNumber() === ln &&
        frame.getColumnNumber() === col &&
        frame.getFunctionName() === name,
      frame
        ? JSON.stringify([frame.getFileName(), frame.getLineNumber(), frame.getColumnNumber(), frame.getFunctionName()])
        : "no frame",
    );
  }

  const [asyncFrame] = parseStack("async*handle@/home/project/src/api.js:31:5");
  check(
    "an `async*` resumption is a frame, and knows it is async",
    asyncFrame.isAsync() === true &&
      asyncFrame.getFunctionName() === "handle" &&
      asyncFrame.getLineNumber() === 31,
    JSON.stringify([asyncFrame.isAsync(), asyncFrame.getFunctionName()]),
  );

  const [evalFrame] = parseStack("run@/home/project/src/x.js line 12 > eval:1:9");
  check(
    "an eval frame reports its host in getEvalOrigin, and no fileName — as V8 does",
    evalFrame.isEval() === true &&
      evalFrame.getFileName() === undefined &&
      evalFrame.getEvalOrigin() === "eval at <anonymous> (/home/project/src/x.js:12)",
    JSON.stringify([evalFrame.isEval(), evalFrame.getFileName(), evalFrame.getEvalOrigin()]),
  );

  const [nativeFrame] = parseStack("map@[native code]");
  check("a JavaScriptCore native frame is native, not a file called [native code]",
    nativeFrame.isNative() === true && nativeFrame.getFileName() === undefined,
    JSON.stringify([nativeFrame.isNative(), nativeFrame.getFileName()]));

  const [method] = parseStack("Router.handle@/home/project/node_modules/express/lib/router/index.js:47:12");
  check(
    "a dotted name splits into type + method, the way V8 reports one",
    method.getFunctionName() === "Router.handle" &&
      method.getTypeName() === "Router" &&
      method.getMethodName() === "handle" &&
      method.isToplevel() === false,
    JSON.stringify([method.getFunctionName(), method.getTypeName(), method.getMethodName()]),
  );

  check(
    "toString renders V8's frame text",
    String(method) === "Router.handle (/home/project/node_modules/express/lib/router/index.js:47:12)",
    String(method),
  );

  // A V8-format string parses too, header and all — the header must NOT become
  // frame 0, or every index a caller reads is one out.
  const v8Shaped = parseStack(
    [
      "TypeError: callSite.getFileName is not a function",
      "    at getStack (/home/project/node_modules/depd/index.js:268:9)",
      "    at /home/project/node_modules/body-parser/index.js:14:30",
    ].join("\n"),
  );
  check(
    "a V8 header is dropped, and its frames parse",
    v8Shaped.length === 2 &&
      v8Shaped[0].getFunctionName() === "getStack" &&
      v8Shaped[0].getLineNumber() === 268 &&
      v8Shaped[1].getFunctionName() === null &&
      v8Shaped[1].getColumnNumber() === 30,
    JSON.stringify(v8Shaped.map((f) => [f.getFunctionName(), f.getLineNumber(), f.getColumnNumber()])),
  );
}

console.log("\n2) the engine that pretends: detection, and what gets installed");
{
  const SM = makeSpiderMonkey([...SHIM_FRAMES, ...EXPRESS_CHAIN]);
  check("a string-returning captureStackTrace is NOT structured support", hasV8StructuredStacks(SM) === false);

  const report = installV8StackCompat({ Error: SM });
  check("the shim installs on it", report !== null && report.captureStackTrace === true);
  check("and wraps the prototype's stack getter", report !== null && report.prototypeStack === true);
  check("after installing, the engine passes its own probe", hasV8StructuredStacks(SM) === true);
  check("which makes installing twice a no-op", installV8StackCompat({ Error: SM }) === null);
}

console.log("\n3) depd's exact sequence, on the built SpiderMonkey");
{
  const SM = makeSpiderMonkey([...SHIM_FRAMES, ...EXPRESS_CHAIN]);
  installV8StackCompat({ Error: SM });

  // Copied from depd@2.0.0 index.js (getStack, callSiteLocation), with `Error`
  // parameterised so it runs against the built engine. Nothing else is changed —
  // the point is that THIS code, unmodified, has to work.
  function prepareObjectStackTrace(_obj, stack) {
    return stack;
  }
  function getStack() {
    const limit = SM.stackTraceLimit;
    const obj = {};
    const prep = SM.prepareStackTrace;
    SM.prepareStackTrace = prepareObjectStackTrace;
    SM.stackTraceLimit = Math.max(10, limit);
    SM.captureStackTrace(obj);
    const stack = obj.stack.slice(1);
    SM.prepareStackTrace = prep;
    SM.stackTraceLimit = limit;
    return stack;
  }
  function callSiteLocation(callSite) {
    let file = callSite.getFileName() || "<anonymous>";
    const line = callSite.getLineNumber();
    const colno = callSite.getColumnNumber();
    if (callSite.isEval()) file = callSite.getEvalOrigin() + ", " + file;
    const site = [file, line, colno];
    site.callSite = callSite;
    site.name = callSite.getFunctionName();
    return site;
  }

  const stack = getStack();
  check("obj.stack is an ARRAY, which is the entire bug", Array.isArray(stack), typeof stack);
  check("stack[0] is depd's own caller frame", stack[0] && stack[0].getFunctionName() === "depd");

  const site = callSiteLocation(stack[1]);
  check(
    "depd's stack[1] resolves to the body-parser require, at the right line and column",
    site[0] === "/home/project/node_modules/body-parser/index.js" && site[1] === 14 && site[2] === 30,
    JSON.stringify([site[0], site[1], site[2]]),
  );
  check("and callSite.getFileName() is a function, not undefined", typeof site.callSite.getFileName === "function");

  // The failure this replaces, spelled out: with Firefox's own captureStackTrace
  // the same three lines produce a character.
  const raw = makeSpiderMonkey([...SHIM_FRAMES, ...EXPRESS_CHAIN]);
  const obj = {};
  raw.captureStackTrace(obj);
  check(
    "without the shim the same sequence yields a one-character 'call site'",
    typeof obj.stack === "string" && typeof obj.stack.slice(1)[1] === "string" && obj.stack.slice(1)[1].length === 1,
    JSON.stringify(obj.stack.slice(1)[1]),
  );
}

console.log("\n4) the hook contract: guest-assigned prepareStackTrace");
{
  const SM = makeSpiderMonkey([...SHIM_FRAMES, ...EXPRESS_CHAIN]);
  installV8StackCompat({ Error: SM });

  let seen = null;
  SM.prepareStackTrace = (err, sites) => {
    seen = { err, sites };
    return sites;
  };
  const obj = { name: "Deprecation", message: "boom" };
  SM.captureStackTrace(obj);
  const out = obj.stack;
  check("the hook is called with the error object it was given", seen && seen.err === obj);
  check("and with an array of CallSites", Array.isArray(out) && typeof out[0].getFileName === "function");
  check("whose first frame is the caller, not the shim", out[0].getFunctionName() === "getStack", out[0] && out[0].getFunctionName());

  // V8 reads the hook at the first ACCESS of .stack, not at capture, and then
  // memoises. mocha and source-map-support install the hook after the error
  // already exists and depend on the first half of that.
  SM.prepareStackTrace = undefined;
  const late = {};
  SM.captureStackTrace(late);
  SM.prepareStackTrace = (_e, sites) => "LATE:" + sites.length;
  check("the hook is read lazily, on first access", String(late.stack).startsWith("LATE:"), String(late.stack));
  SM.prepareStackTrace = (_e, sites) => "SECOND:" + sites.length;
  check("and the first answer is memoised", String(late.stack).startsWith("LATE:"), String(late.stack));

  // The other half of the ecosystem never calls captureStackTrace at all: it
  // reads `new Error().stack` with a hook installed and expects the array.
  SM.prepareStackTrace = (_e, sites) => sites;
  const sites = new SM("x").stack;
  check("`new Error().stack` honours the hook too", Array.isArray(sites) && sites.length > 0);
  SM.prepareStackTrace = undefined;
  check(
    "and with NO hook it is the engine's own string, untouched",
    typeof new SM("x").stack === "string" && new SM("x").stack.startsWith("captureFrames@"),
  );
}

console.log("\n5) stackTraceLimit and constructorOpt");
{
  const SM = makeSpiderMonkey([...SHIM_FRAMES, ...EXPRESS_CHAIN]);
  installV8StackCompat({ Error: SM });
  SM.prepareStackTrace = (_e, sites) => sites;

  SM.stackTraceLimit = 3;
  const few = {};
  SM.captureStackTrace(few);
  check("stackTraceLimit caps the frames", few.stack.length === 3, String(few.stack.length));

  SM.stackTraceLimit = 0;
  const none = {};
  SM.captureStackTrace(none);
  check("a limit of 0 means no frames, as in V8", Array.isArray(none.stack) && none.stack.length === 0);

  SM.stackTraceLimit = 50;
  const trimmed = {};
  SM.captureStackTrace(trimmed, function depd() {});
  check(
    "constructorOpt drops every frame up to and including its own",
    trimmed.stack[0].getFileName() === "/home/project/node_modules/body-parser/index.js",
    trimmed.stack[0] && trimmed.stack[0].getFileName(),
  );

  // Deliberately NOT V8's behaviour, and error-stack.js says why: V8 returns zero
  // frames for a constructorOpt it cannot find, but here a miss can also mean the
  // engine inferred a different name, and deleting a user's whole stack over our
  // own shortcoming is the worse failure.
  const missed = {};
  SM.captureStackTrace(missed, function notOnTheStack() {});
  check("a constructorOpt that is not on the stack keeps the stack", missed.stack.length > 0, String(missed.stack.length));

  SM.prepareStackTrace = undefined;
  const text = { name: "TypeError", message: "callSite.getFileName is not a function" };
  SM.captureStackTrace(text);
  const lines = String(text.stack).split("\n");
  check(
    "with no hook the default rendering is V8's: header, then `    at` frames",
    lines[0] === "TypeError: callSite.getFileName is not a function" &&
      lines[1] === "    at getStack (/home/project/node_modules/depd/index.js:268:9)",
    JSON.stringify(lines.slice(0, 2)),
  );
}

console.log("\n6) formatUncaught: the message survives an engine that omits it");
{
  // What Firefox actually handed loop.js's reportError: frames, and no message.
  const smError = {
    name: "TypeError",
    message: "callSite.getFileName is not a function",
    stack: EXPRESS_CHAIN.join("\n"),
  };
  const out = formatUncaught(smError);
  check(
    "a SpiderMonkey stack gains the `Name: message` line it never had",
    out.split("\n")[0] === "TypeError: callSite.getFileName is not a function" &&
      out.split("\n")[1] === EXPRESS_CHAIN[0],
    JSON.stringify(out.split("\n").slice(0, 2)),
  );

  const v8Error = new TypeError("already headed");
  check(
    "a V8 stack is passed through unchanged — no duplicated header",
    formatUncaught(v8Error) === v8Error.stack,
  );

  // The header is added only where the stack opens with a FRAME. A guest that
  // rewrote err.stack itself (clean-stack and friends) is printing prose on
  // purpose, and Node would print it verbatim — so that stays verbatim here.
  check(
    "a guest-rewritten stack is printed as the guest wrote it",
    formatUncaught({ name: "Error", message: "x", stack: "the deploy failed, see above" }) ===
      "the deploy failed, see above",
  );
  // Same rule covers a message reassigned after construction: V8 baked the OLD
  // header into `stack`, so the computed one will not match and must not be added.
  const mutated = new TypeError("first");
  mutated.message = "second";
  check("a mutated message does not grow a second header", formatUncaught(mutated) === mutated.stack);

  check("a thrown string is still just the string", formatUncaught("boom") === "boom");
  check("a thrown null does not throw", formatUncaught(null) === "null");
  check(
    "an error with no stack still reports its message",
    formatUncaught({ name: "RangeError", message: "no stack here" }) === "RangeError: no stack here",
  );
  check(
    "a non-string stack (a hook left installed) falls back to the header",
    formatUncaught({ name: "Error", message: "hooked", stack: [1, 2] }) === "Error: hooked",
  );
}

console.log("\n7) the V8 host: nothing is installed, nothing changes");
{
  // This process IS V8. Every assertion here is about the shim staying out of
  // Chrome's way — the failure mode that would be silent in production.
  check("real V8 is detected as structured", hasV8StructuredStacks(Error) === true);

  const before = Error.captureStackTrace;
  const beforeProto = Object.getOwnPropertyDescriptor(Error.prototype, "stack");
  check("installV8StackCompat reports it installed nothing", installV8StackCompat(globalThis) === null);
  check("Error.captureStackTrace is still V8's own function", Error.captureStackTrace === before);
  check(
    "Error.prototype.stack is untouched",
    JSON.stringify(Object.getOwnPropertyDescriptor(Error.prototype, "stack")) === JSON.stringify(beforeProto),
  );
  check(
    "captureStackTrace is still native code",
    /\[native code\]/.test(Function.prototype.toString.call(Error.captureStackTrace)),
  );

  // A scope whose Error is not a function (spike-realm.mjs builds one out of
  // recorded property names) must not make the installer reach for the ambient
  // global instead.
  check("a scope with no usable Error installs nothing", installV8StackCompat({ Error: "host:Error" }) === null);
  check("and the host Error survived that", Error.captureStackTrace === before);

  // depd's own sequence on the untouched host, as the control.
  function prepareObjectStackTrace(_obj, stack) {
    return stack;
  }
  function getStack() {
    const obj = {};
    const prep = Error.prepareStackTrace;
    Error.prepareStackTrace = prepareObjectStackTrace;
    Error.captureStackTrace(obj);
    const stack = obj.stack.slice(1);
    Error.prepareStackTrace = prep;
    return stack;
  }
  const hostStack = (function caller() {
    return getStack();
  })();
  check(
    "depd's sequence still works on V8, through real CallSites",
    Array.isArray(hostStack) && hostStack[0].getFunctionName() === "caller",
    Array.isArray(hostStack) ? String(hostStack[0].getFunctionName()) : typeof hostStack,
  );
}

console.log("\n8) captureCallSites, which backs util.getCallSites()");
{
  // On this host it takes the V8 path; the SpiderMonkey path is the one section 3
  // exercises through the shim. Both must name the CALLER, never the helper.
  const sites = (function outerCaller() {
    const inner = () => captureCallSites(5, inner);
    return inner();
  })();
  check("the first frame is the caller of the helper, not the helper", sites.length > 0 && sites[0].getFunctionName() === "outerCaller",
    sites.length ? String(sites[0].getFunctionName()) : "none");
  check("frames carry a real file name", sites.length > 0 && /spike-error-stack\.mjs$/.test(String(sites[0].getFileName())),
    sites.length ? String(sites[0].getFileName()) : "none");
  check("a frameCount of 0 asks for nothing and gets nothing", captureCallSites(0).length === 0);
  // Node ships its OWN Error.prepareStackTrace (the source-map-aware formatter),
  // so "restored" here means restored to that, not to undefined — a helper that
  // left its own hook behind would silently take over every stack in the process.
  const hook = Error.prepareStackTrace;
  captureCallSites(3);
  check("the helper restores whatever prepareStackTrace it found", Error.prepareStackTrace === hook);
}

console.log("");
if (failures) {
  console.log("FAIL: " + failures + " check(s) failed");
  process.exit(1);
}
console.log("PASS: a guest gets V8-shaped stacks on an engine that has none");