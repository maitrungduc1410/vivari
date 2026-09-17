// V8-shaped error stacks on an engine that is not V8.
//
// `Error.captureStackTrace` and `Error.prepareStackTrace` are V8 extensions, and
// the npm ecosystem treats them as if they were the language. They are not, and
// on Firefox that costs us `express`:
//
//   src/index.js:1 -> express/index.js:11 -> express/lib/express.js:15
//     -> body-parser/index.js:14 -> depd('body-parser')
//     -> depd/index.js:109 -> depd/index.js:268   TypeError
//
// depd@2.0.0's getStack() is the shape half the ecosystem copied:
//
//   Error.prepareStackTrace = prepareObjectStackTrace   // (_, stack) => stack
//   Error.captureStackTrace(obj)
//   var stack = obj.stack.slice(1)                      // wants CallSite[]
//   ...
//   callSiteLocation(stack[1]).callSite.getFileName()
//
// SpiderMonkey has NO `prepareStackTrace` — it is not a hook there, just an
// ordinary property nobody reads. What it DOES have, since Firefox 138
// (Mozilla bug 1950508), is `Error.captureStackTrace`, and that is what makes
// this failure so much worse than a missing function: the call SUCCEEDS. Per MDN
// it installs `stack` as a plain writable STRING data property. So depd's guard
// (`typeof Error.captureStackTrace === 'function'`) passes, `obj.stack` is a
// string, `.slice(1)` is a shorter string rather than a shorter array, `stack[1]`
// is the single character `"e"`, and `"e".getFileName` is undefined. The error
// the user sees names neither express, nor Firefox, nor stacks. A missing
// function would have been a better bug.
//
// WHY THE FIX IS HERE AND NOT IN depd (AGENTS.md golden rule 2). Nothing about
// depd is wrong; it is written against the engine every Node process has ever had
// underneath it. Vivari's whole proposition is that the guest cannot tell it is in
// a browser, and a guest that has to ask which browser is a guest we have failed.
// `depd` is also only the first one to fall over: `callsites`, `stack-trace`,
// `source-map-support`, `@sentry/node`, mocha and jest all read structured stacks
// the same way, and patching them one at a time is unbounded.
//
// STRICTLY OPT-IN. Everything below is gated on `hasV8StructuredStacks()`, which
// asks the engine a question rather than sniffing a user agent: install a
// `prepareStackTrace` hook, capture, read the result back, and see whether real
// CallSite objects came through. Chrome and the Node twin answer yes and NOTHING
// is installed — no wrapper, no parse, no behaviour change, not even a slower
// path. That probe is also what makes install idempotent: once the shim is in,
// the engine passes its own test, so a second install is a no-op.
//
// WHAT CANNOT BE RECOVERED, AND IS THEREFORE NOT FAKED. A V8 CallSite is a view
// onto frames the engine still holds: it can hand back the function object, the
// receiver, whether the frame was a `new` call. SpiderMonkey gives us a STRING
// that was formatted after the fact, so that information is gone before we are
// called. Where V8 would answer from the frame, this answers from the text, and
// where the text does not say, it returns the value V8 returns for "don't know"
// (`undefined` / `null` / `false`) rather than a plausible-looking invention.
// `getFileName`, `getLineNumber`, `getColumnNumber` and `getFunctionName` — the
// four that every consumer in the list above actually reads — are exact.

// V8's default when `Error.stackTraceLimit` has never been assigned.
const DEFAULT_STACK_TRACE_LIMIT = 10;

/**
 * Does this engine implement V8's STRUCTURED stack API — not just the names?
 *
 * The question has to be asked by running it. `typeof Error.captureStackTrace`
 * is true on Firefox 138+ and tells you nothing, and a user-agent test would be
 * wrong the day a third engine ships (and is unavailable in a worker whose
 * `navigator` we have already replaced — see realm.js).
 *
 * `stackTraceLimit` is forced during the probe because a guest that set it to 0
 * would otherwise make a perfectly good V8 look unsupported, and we would shim
 * Chrome.
 */
export function hasV8StructuredStacks(E) {
  if (typeof E !== "function" || typeof E.captureStackTrace !== "function") return false;
  const prevPrepare = E.prepareStackTrace;
  const prevLimit = E.stackTraceLimit;
  let structured = false;
  try {
    try {
      E.stackTraceLimit = DEFAULT_STACK_TRACE_LIMIT;
    } catch {
      /* frozen by a guest; the probe still works against whatever it is */
    }
    E.prepareStackTrace = (_err, sites) => {
      structured =
        Array.isArray(sites) && sites.length > 0 && typeof sites[0].getFileName === "function";
      return null;
    };
    const probe = {};
    E.captureStackTrace(probe);
    // V8 runs `prepareStackTrace` lazily, on the first read of `.stack`. On an
    // engine that only pretends, this read is what proves nothing happened.
    void probe.stack;
  } catch {
    structured = false;
  } finally {
    try {
      E.prepareStackTrace = prevPrepare;
      E.stackTraceLimit = prevLimit;
    } catch {
      /* nothing left to restore to */
    }
  }
  return structured;
}

// ---- CallSite -------------------------------------------------------------

/**
 * One frame, shaped like V8's CallSite.
 *
 * The methods are on the prototype and the data is in closed-over fields for the
 * same reason V8's are: a consumer that enumerates a CallSite (util.inspect does,
 * error reporters do) should see what it sees on Chrome, which is nothing.
 */
class CallSite {
  constructor(fields) {
    Object.defineProperty(this, "_", { value: fields, enumerable: false });
  }

  getFileName() {
    return this._.fileName;
  }

  // V8 distinguishes these two only for scripts carrying a `//# sourceURL`, where
  // it returns the sourceURL rather than the compiled name. Our loader attaches a
  // sourceURL to every guest module (module.js) and SpiderMonkey already reports
  // THAT in the stack text, so by the time we see it the two have collapsed.
  getScriptNameOrSourceURL() {
    return this._.fileName;
  }

  getScriptHash() {
    return "";
  }

  getLineNumber() {
    return this._.lineNumber;
  }

  getColumnNumber() {
    return this._.columnNumber;
  }

  getEnclosingLineNumber() {
    return this._.lineNumber;
  }

  getEnclosingColumnNumber() {
    return this._.columnNumber;
  }

  getPosition() {
    return 0;
  }

  // The engine's inferred name, verbatim. V8's is dotted for a prototype-assigned
  // function too (measured: `Foo.prototype.bar = function(){}` reports
  // "Foo.bar"), so passing SpiderMonkey's inferred name through unedited is closer
  // to V8 than any tidying would be.
  getFunctionName() {
    return this._.functionName;
  }

  // V8 answers these from the receiver, which a formatted string does not carry.
  // The dotted prefix of the inferred name is the only evidence there is, so that
  // is what is used, and a name with no dot yields null exactly as V8 does for a
  // plain function call.
  getTypeName() {
    return this._.typeName;
  }

  getMethodName() {
    return this._.methodName;
  }

  // Unknowable from text, and V8 itself returns undefined for both from strict
  // code — which every guest module is, since the loader compiles them as such.
  getThis() {
    return undefined;
  }

  getFunction() {
    return undefined;
  }

  isEval() {
    return this._.isEval;
  }

  getEvalOrigin() {
    return this._.evalOrigin;
  }

  isNative() {
    return this._.isNative;
  }

  // SpiderMonkey marks a resumed async frame with an `async*` prefix, so unlike
  // the two below this one is a fact rather than a guess.
  isAsync() {
    return this._.isAsync;
  }

  isPromiseAll() {
    return false;
  }

  getPromiseIndex() {
    return null;
  }

  // A `new` call leaves no trace in the text. False is the safe answer: a
  // consumer that believes a frame is a constructor when it is not will print the
  // wrong thing, whereas the reverse only loses a `new ` prefix.
  isConstructor() {
    return false;
  }

  isToplevel() {
    return this._.methodName === null;
  }

  toString() {
    const f = this._;
    let where = f.isNative ? "native" : `${f.fileName || "<anonymous>"}:${f.lineNumber}:${f.columnNumber}`;
    if (f.isEval && f.evalOrigin) where = `${f.evalOrigin}, ${where}`;
    return f.functionName ? `${f.functionName} (${where})` : where;
  }
}

// ---- parsing --------------------------------------------------------------

// SpiderMonkey's eval and `new Function` frames name their host script inline:
//   run@/home/project/app.js line 12 > eval:1:9
const EVAL_HOST = / line (\d+) > (?:eval|Function|new Function)$/;

/**
 * One line of a SpiderMonkey (or JavaScriptCore) stack -> a CallSite, or null for
 * a line that carries no frame.
 *
 * THE SPLIT IS ON THE **FIRST** `@`, NOT THE LAST, and that is not a detail:
 * every scoped package on npm puts an `@` in its path, so
 * `pick@/home/project/node_modules/@babel/core/lib/index.js:9:3` splits at the
 * last one into the function name "pick@/home/project/node_modules/" and the file
 * "babel/core/lib/index.js". Splitting at the first is wrong only for a function
 * whose INFERRED NAME contains an `@`, which needs a property key like
 * `obj["a@b"] = function () {}`; paths with `@` are the common case by orders of
 * magnitude.
 */
function parseFrame(line) {
  let text = line.trim();
  if (!text) return null;

  // `async*` (and `Async*`, on older builds) prefixes a frame resumed after an
  // await; it can repeat for nested resumptions.
  let isAsync = false;
  while (/^(?:async|Async)\*/.test(text)) {
    isAsync = true;
    text = text.replace(/^(?:async|Async)\*/, "");
  }

  // A V8-shaped line, in case something upstream hands us one: a mixed stack
  // (an error crossing a Node-twin boundary) should not lose half its frames.
  if (/^at\s/.test(text)) return parseV8Frame(text.slice(3).trim(), isAsync);

  const at = text.indexOf("@");
  if (at === -1) {
    // JavaScriptCore prints bare `global code` / `[native code]` / a lone name.
    if (text === "[native code]" || text === "native code") {
      return makeFrame({ functionName: null, isNative: true, isAsync });
    }
    return makeFrame({ functionName: text, isAsync });
  }
  const functionName = text.slice(0, at);
  return makeFrame({ functionName, isAsync, ...parseLocation(text.slice(at + 1)) });
}

/** `fn (file:line:col)` or `file:line:col`, V8's own format. */
function parseV8Frame(text, isAsync) {
  const paren = text.lastIndexOf(" (");
  if (paren === -1) return makeFrame({ functionName: null, isAsync, ...parseLocation(text) });
  const inner = text.slice(paren + 2).replace(/\)$/, "");
  return makeFrame({ functionName: text.slice(0, paren), isAsync, ...parseLocation(inner) });
}

/** Split a trailing `:line:col` (or `:line`) off a location that may be a URL. */
function parseLocation(loc) {
  if (loc === "[native code]" || loc === "native") return { isNative: true };
  let fileName = loc;
  let lineNumber = 0;
  let columnNumber = 0;
  const both = /:(\d+):(\d+)$/.exec(loc);
  if (both) {
    fileName = loc.slice(0, both.index);
    lineNumber = Number(both[1]);
    columnNumber = Number(both[2]);
  } else {
    const lineOnly = /:(\d+)$/.exec(loc);
    if (lineOnly) {
      fileName = loc.slice(0, lineOnly.index);
      lineNumber = Number(lineOnly[1]);
    }
  }
  const evalHost = EVAL_HOST.exec(fileName);
  if (!evalHost) return { fileName, lineNumber, columnNumber };
  // V8 reports `getFileName()` as undefined for an eval frame and puts the host
  // script in `getEvalOrigin()` instead (measured on node 22). depd, among
  // others, branches on exactly that, so follow it rather than the tempting
  // alternative of reporting the host script as the file.
  return {
    fileName: undefined,
    lineNumber,
    columnNumber,
    isEval: true,
    evalOrigin: `eval at <anonymous> (${fileName.slice(0, evalHost.index)}:${evalHost[1]})`,
  };
}

function makeFrame(f) {
  const functionName = f.functionName ? f.functionName : null;
  // Only a plain dotted name is split. SpiderMonkey writes nested anonymous
  // functions as `outer/<` and `outer/inner`, where the part before the slash
  // names a DIFFERENT function, so reading a receiver out of it would be a lie.
  let typeName = null;
  let methodName = null;
  if (functionName && !/[/<>]/.test(functionName)) {
    const dot = functionName.lastIndexOf(".");
    if (dot > 0) {
      typeName = functionName.slice(0, dot);
      methodName = functionName.slice(dot + 1);
    }
  }
  return new CallSite({
    functionName,
    typeName,
    methodName,
    fileName: "fileName" in f ? f.fileName : undefined,
    lineNumber: f.lineNumber || 0,
    columnNumber: f.columnNumber || 0,
    isEval: f.isEval === true,
    evalOrigin: f.isEval === true ? f.evalOrigin : null,
    isNative: f.isNative === true,
    isAsync: f.isAsync === true,
  });
}

// V8 opens `stack` with "Name: message"; SpiderMonkey opens it with a frame. A
// header read as a frame would shift every index by one, which is the same
// off-by-one that makes depd read the wrong call site in the first place — so it
// is recognised and dropped. The test is deliberately narrow (a first line with a
// `: ` and no `@location`), because a JavaScriptCore stack can legitimately begin
// with a bare `global code` that has no location either.
const V8_HEADER = /^[^@]*: /;

/** Every frame in a raw engine stack string, in order, outermost call last. */
export function parseStack(raw) {
  if (typeof raw !== "string" || raw === "") return [];
  const lines = raw.split("\n");
  if (lines.length > 1 && !/^\s*at\s/.test(lines[0]) && V8_HEADER.test(lines[0])) lines.shift();
  const frames = [];
  for (const line of lines) {
    const frame = parseFrame(line);
    if (frame) frames.push(frame);
  }
  return frames;
}

// ---- capture --------------------------------------------------------------

// Each wrapped Error's OWN `stack` getter, saved when `wrapPrototypeStack`
// replaces it.
//
// Without this the shim eats itself: `captureFrames` reads `new Error().stack` to
// get the raw text, and once the wrapper is in place that read would be routed
// through the guest's `prepareStackTrace` hook and come back as whatever the hook
// returns — an ARRAY, for every consumer in this file's opening list. depd would
// then have had its own hook applied to the frames it was about to be handed.
const nativeStackGetters = new WeakMap();

function stackLimit(E) {
  const limit = E.stackTraceLimit;
  return typeof limit === "number" && limit >= 0 ? limit : DEFAULT_STACK_TRACE_LIMIT;
}

/**
 * The frames above the caller, as CallSites.
 *
 * `skip` is how many frames sit between the `new Error()` below and the frame the
 * CALLER wants at index 0, not counting this function's own. Every call site
 * passes a literal, because a count is the only thing here that survives a build:
 * matching our own frames by function name would break under a minifier. (The
 * worker bundle sets `minify: false` — packages/core/vite.config.ts — so names do
 * survive today, but nothing should depend on that from a distance.)
 *
 * The engine's own limit is raised by the same amount before capturing, so a
 * guest asking for 10 frames gets 10 of ITS frames rather than 10 minus ours.
 */
function captureFrames(E, skip, limit, constructorOpt) {
  if (limit <= 0) return [];
  const drop = skip + 1;
  const prevLimit = E.stackTraceLimit;
  let raw;
  try {
    try {
      E.stackTraceLimit = limit + drop;
    } catch {
      /* not writable here; capture whatever the engine is willing to give */
    }
    const carrier = new E();
    const nativeGet = nativeStackGetters.get(E);
    raw = nativeGet ? nativeGet.call(carrier) : carrier.stack;
  } finally {
    try {
      E.stackTraceLimit = prevLimit;
    } catch {
      /* ignore */
    }
  }
  let frames = parseStack(raw).slice(drop);

  if (typeof constructorOpt === "function") {
    // V8 hides everything up to and including the frame for `constructorOpt`,
    // which is how a library keeps its own error factory out of the trace. We can
    // only match it by NAME, because the frame is text by the time we see it.
    //
    // A DELIBERATE DIVERGENCE: when the name is not found, V8 returns zero frames
    // (measured) and this returns all of them. On V8 a miss means the function
    // genuinely is not on the stack; here it can also mean the name was inferred
    // differently or is empty, and answering "no stack at all" to what is really
    // "I could not tell" would delete the user's trace over our own shortcoming.
    const name = constructorOpt.name;
    if (name) {
      const cut = frames.findIndex((f) => f.getFunctionName() === name);
      if (cut !== -1) frames = frames.slice(cut + 1);
    }
  }

  return frames.slice(0, limit);
}

/**
 * Structured frames for the CALLER of whoever calls this, on any engine.
 *
 * Used by `internalBinding('util').getCallSites` (util.getCallSites), which has to
 * work whether or not the realm shim was installed — it can be reached from a
 * Node-twin process on real V8, from a browser worker after the shim is in, and
 * in principle before sealGuestRealm has run.
 */
export function captureCallSites(limit, constructorOpt) {
  if (!(limit > 0)) return [];
  const E = Error;
  const prevPrepare = E.prepareStackTrace;
  const prevLimit = E.stackTraceLimit;
  try {
    E.stackTraceLimit = limit;
    E.prepareStackTrace = (_err, sites) => sites;
    const target = {};
    E.captureStackTrace(target, constructorOpt);
    const sites = target.stack;
    // The string-returning impostor described at the top of this file lands here
    // as a string, not an array — which is the check depd forgot to make.
    if (Array.isArray(sites) && (sites.length === 0 || typeof sites[0].getFileName === "function")) {
      return sites.slice(0, limit);
    }
  } catch {
    /* fall through to the parse */
  } finally {
    try {
      E.prepareStackTrace = prevPrepare;
      E.stackTraceLimit = prevLimit;
    } catch {
      /* ignore */
    }
  }
  return captureFrames(E, 1, limit, constructorOpt);
}

// ---- install --------------------------------------------------------------

/**
 * Give `scope`'s Error the V8 structured-stack API, if its engine lacks it.
 *
 * Returns what was installed (for the spike and for `__vv.diag()`), or null when
 * the engine already has the real thing — the Chrome and Node-twin path, where
 * this function's only effect is one probe at startup.
 */
export function installV8StackCompat(scope) {
  const E = scope && scope.Error;
  if (typeof E !== "function") return null;
  if (hasV8StructuredStacks(E)) return null;

  // V8's `stack` after captureStackTrace is an accessor pair, non-enumerable and
  // configurable, and it is LAZY: `prepareStackTrace` is read at the first access
  // of `.stack`, not at capture, and the result is then memoised forever even if
  // the hook changes (all measured on node 22). depd sets the hook before
  // capturing and reads before restoring, so it would survive an eager
  // implementation — but `mocha` and `source-map-support` install the hook after
  // the error exists, and only laziness serves them.
  const captureStackTrace = function captureStackTrace(target, constructorOpt) {
    if (target === null || (typeof target !== "object" && typeof target !== "function")) return;
    const frames = captureFrames(E, 1, stackLimit(E), constructorOpt);
    let value;
    let resolved = false;
    Object.defineProperty(target, "stack", {
      configurable: true,
      enumerable: false,
      get() {
        if (!resolved) {
          resolved = true;
          value = formatFrames(E, target, frames);
        }
        return value;
      },
      set(next) {
        resolved = true;
        value = next;
      },
    });
  };

  Object.defineProperty(E, "captureStackTrace", {
    value: captureStackTrace,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  return { captureStackTrace: true, prototypeStack: wrapPrototypeStack(E) };
}

/**
 * Make `err.stack` honour a guest's `prepareStackTrace` too, not just
 * `captureStackTrace`.
 *
 * On V8 the hook governs BOTH (measured: with `(_, s) => s` installed,
 * `new Error().stack` is an array), and the `callsites` / `stack-trace` /
 * `source-map-support` family reads it that way — they never call
 * captureStackTrace at all.
 *
 * This is the widest-blast-radius thing in the file, so it is written to be inert
 * by default: with no hook installed the getter returns the engine's own string
 * untouched, byte for byte, with no parsing and no caching. Guest code has to
 * assign `Error.prepareStackTrace` — i.e. ask for V8 semantics — before anything
 * here changes what an error looks like.
 *
 * It needs `stack` to be an ACCESSOR on Error.prototype, which is where
 * SpiderMonkey keeps it. An engine that instead installs an own data property per
 * instance cannot be served from here at all (there is nothing to wrap), and the
 * honest answer is to install nothing and say so rather than to hook the Error
 * constructor, which would change the identity of every error in the runtime to
 * serve a case we have no evidence exists.
 */
function wrapPrototypeStack(E) {
  let desc;
  try {
    desc = Object.getOwnPropertyDescriptor(E.prototype, "stack");
  } catch {
    return false;
  }
  if (!desc || typeof desc.get !== "function" || desc.configurable === false) return false;
  const nativeGet = desc.get;
  const nativeSet =
    typeof desc.set === "function"
      ? desc.set
      : function (value) {
          Object.defineProperty(this, "stack", {
            value,
            writable: true,
            enumerable: false,
            configurable: true,
          });
        };
  try {
    Object.defineProperty(E.prototype, "stack", {
      configurable: true,
      enumerable: desc.enumerable === true,
      get() {
        const raw = nativeGet.call(this);
        const prepare = E.prepareStackTrace;
        if (typeof prepare !== "function" || typeof raw !== "string") return raw;
        try {
          return prepare(this, parseStack(raw).slice(0, stackLimit(E)));
        } catch {
          // A throwing hook must not turn reading a stack into a second error;
          // V8 propagates, but here the caller is often our own reporter and the
          // original error matters more than fidelity to that corner.
          return raw;
        }
      },
      set: nativeSet,
    });
    nativeStackGetters.set(E, nativeGet);
    return true;
  } catch {
    return false;
  }
}

/** V8's `FormatStackTrace`: the guest's hook if it set one, else V8's own text. */
function formatFrames(E, target, frames) {
  const prepare = E.prepareStackTrace;
  if (typeof prepare === "function") {
    try {
      return prepare(target, frames);
    } catch {
      /* fall back to the default rendering rather than throwing from a getter */
    }
  }
  let head;
  try {
    // Measured on node 22: a bare `{}` renders as "Error", `{name, message}` as
    // "Name: message". The header comes from the TARGET, not from the class.
    const name = target.name == null ? "Error" : String(target.name);
    const message = target.message == null ? "" : String(target.message);
    head = message ? `${name}: ${message}` : name;
  } catch {
    head = "Error";
  }
  return frames.reduce((text, frame) => `${text}\n    at ${frame.toString()}`, head);
}

// ---- reporting ------------------------------------------------------------

/**
 * An uncaught error as a user should see it, on any engine.
 *
 * `String(err.stack)` is the idiomatic way to print an error BECAUSE of a V8
 * convention: V8 builds `stack` as "Name: message" followed by the frames, so the
 * message comes along for free. SpiderMonkey's `stack` is frames and ONLY frames.
 * Printing it the V8 way on Firefox is how a real run of the express template
 * reached the terminal as four bare `at`-less frames with no `TypeError:` line
 * anywhere — the user was shown where it broke and never what broke.
 *
 * So: emit the header unless the stack already carries it. "Carries it" is two
 * questions, not one, and collapsing them would change what Chrome prints. The
 * first is cheap — does the text already start with this exact header. The second
 * is for everything that fails the first for a reason that is not ours: a guest
 * that rewrote `err.stack` itself (`clean-stack` and friends), or an error whose
 * `message` was reassigned after construction, so the header V8 baked in no longer
 * matches the one computed now. In both of those the stack opens with prose, not a
 * frame, and Node would print it verbatim — so a header is added only when the
 * first line actually looks like a FRAME, which is the case SpiderMonkey creates.
 *
 * A guest that has left a `prepareStackTrace` hook installed can make `stack` a
 * non-string (an array, on Chrome as much as here), which is why the type is
 * checked before it is printed rather than assumed.
 */
export function formatUncaught(err) {
  if (err === null || typeof err !== "object") return String(err);
  let stack;
  try {
    stack = err.stack;
  } catch {
    stack = null;
  }
  let head;
  try {
    const name = err.name == null ? null : String(err.name);
    const message = err.message == null ? "" : String(err.message);
    head = name === null ? null : message ? `${name}: ${message}` : name;
  } catch {
    head = null;
  }
  if (typeof stack !== "string" || stack === "") return head || String(err);
  if (!head || stack.startsWith(head)) return stack;
  return looksLikeFrame(stack.split("\n", 1)[0]) ? `${head}\n${stack}` : stack;
}

/** `at fn (file:1:2)` (V8) or `fn@file:1:2` (SpiderMonkey, JavaScriptCore). */
function looksLikeFrame(line) {
  const text = line.trim();
  return /^at\s/.test(text) || /@.*:\d+/.test(text);
}