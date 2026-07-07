// primordials — Node's "safe intrinsics" object, generated on demand.
//
// Node's real lib/ modules are written against `primordials` (e.g.
// `StringPrototypeSlice(str, a, b)` instead of `str.slice(a, b)`, `ArrayIsArray`
// instead of `Array.isArray`) so user code can't break them by patching
// prototypes. Node ships a huge hand-maintained table. We instead resolve names
// from their well-known naming scheme via a Proxy, so adopting a new real lib/
// module doesn't require hand-listing dozens of intrinsics:
//
//   <Global>                       -> globalThis[Global]              (Array, Uint8Array)
//   <Ns><Static>                   -> Ns[static]                      (ArrayIsArray, MathFloor)
//   <Ns>Prototype                  -> Ns.prototype                    (Uint8ArrayPrototype)
//   <Ns>Prototype<Method>          -> uncurry(Ns.prototype.method)    (StringPrototypeSlice)
//   <Ns>PrototypeGet<Accessor>     -> uncurry(getter)                 (TypedArrayPrototypeGetBuffer)
//   <Ns>PrototypeSymbol<WellKnown> -> uncurry(proto[Symbol.wellKnown])(RegExpPrototypeSymbolReplace)
//   Symbol<WellKnown>              -> Symbol.wellKnown                 (SymbolIterator, SymbolSpecies)
//
// Resolved values are memoized so identities stay stable. Unknown names throw
// loudly, which surfaces the exact intrinsic a newly-vendored module needs.

// Uncurry a prototype method so the receiver is passed as the first argument:
// StringPrototypeSlice(str, 1, 2) === str.slice(1, 2).
const uncurryThis =
  (fn) =>
  (self, ...args) =>
    fn.apply(self, args);

const lowerFirst = (s) => (s.length ? s[0].toLowerCase() + s.slice(1) : s);

// %TypedArray% — the abstract base constructor shared by Uint8Array etc.
const TypedArray = Object.getPrototypeOf(Uint8Array);

// Namespaces we resolve `<Ns>...` names against, longest first so that e.g.
// "ArrayBufferIsView" matches ArrayBuffer, not Array.
const NAMESPACES = {
  TypedArray,
  ...(typeof SharedArrayBuffer !== "undefined" ? { SharedArrayBuffer } : {}),
  ArrayBuffer,
  Uint8ClampedArray,
  BigInt64Array,
  BigUint64Array,
  Float32Array,
  Float64Array,
  Uint16Array,
  Uint32Array,
  Int16Array,
  Int32Array,
  Uint8Array,
  Int8Array,
  WeakMap,
  WeakSet,
  Array,
  Object,
  Function,
  Boolean,
  Number,
  BigInt,
  Math,
  JSON,
  Reflect,
  String,
  Symbol,
  RegExp,
  Date,
  Error,
  TypeError,
  RangeError,
  SyntaxError,
  Promise,
  Map,
  Set,
  Proxy,
  DataView,
};
const NS_NAMES = Object.keys(NAMESPACES).sort((a, b) => b.length - a.length);

const GLOBALS = {
  globalThis,
  ...NAMESPACES,
  Infinity,
  NaN,
  undefined,
  // Bare global functions Node lists in its primordials table (used verbatim by
  // e.g. lib/querystring.js). They don't follow the <Ns><Member> scheme.
  decodeURIComponent,
  encodeURIComponent,
  decodeURI,
  encodeURI,
};

function findDescriptor(obj, prop) {
  let cur = obj;
  while (cur) {
    const d = Object.getOwnPropertyDescriptor(cur, prop);
    if (d) return d;
    cur = Object.getPrototypeOf(cur);
  }
  return undefined;
}

function resolvePrototypeMember(proto, methodPart) {
  // Well-known symbol member, e.g. PrototypeSymbolReplace -> proto[Symbol.replace].
  if (methodPart.startsWith("Symbol")) {
    const sym = Symbol[lowerFirst(methodPart.slice(6))];
    if (sym && typeof proto[sym] === "function") return uncurryThis(proto[sym]);
    return undefined;
  }
  // Direct method or accessor named exactly (lowerFirst).
  const direct = findDescriptor(proto, lowerFirst(methodPart));
  if (direct) {
    if (typeof direct.value === "function") return uncurryThis(direct.value);
    if (direct.get) return uncurryThis(direct.get);
  }
  // Accessor getters/setters spelled Get<Prop> / Set<Prop>.
  if (methodPart.startsWith("Get")) {
    const d = findDescriptor(proto, lowerFirst(methodPart.slice(3)));
    if (d && d.get) return uncurryThis(d.get);
  }
  if (methodPart.startsWith("Set")) {
    const d = findDescriptor(proto, lowerFirst(methodPart.slice(3)));
    if (d && d.set) return uncurryThis(d.set);
  }
  return undefined;
}

// %AsyncIteratorPrototype% — the shared prototype at the top of the async
// iterator chain. There is no named global for it, so derive it structurally.
const AsyncIteratorPrototype = Object.getPrototypeOf(
  Object.getPrototypeOf(async function* () {}).prototype,
);

// Names that don't follow the <Ns><Member> scheme. `uncurryThis` is a primordial
// helper itself; the Safe* collections are Node's monkeypatch-proof subclasses —
// plain Map/Set/WeakMap are behaviourally equivalent for our vendored modules.
// Symbol.dispose / Symbol.asyncDispose fall back to fresh symbols on engines
// that predate the explicit-resource-management proposal.
const SPECIALS = {
  uncurryThis,
  SafeMap: Map,
  SafeSet: Set,
  SafeWeakMap: WeakMap,
  SafeWeakSet: WeakSet,
  AsyncIteratorPrototype,
  SymbolDispose: Symbol.dispose ?? Symbol("nodejs.dispose"),
  SymbolAsyncDispose: Symbol.asyncDispose ?? Symbol("nodejs.asyncDispose"),
};

function resolve(name) {
  if (Object.prototype.hasOwnProperty.call(SPECIALS, name)) return SPECIALS[name];
  if (Object.prototype.hasOwnProperty.call(GLOBALS, name)) return GLOBALS[name];

  for (const ns of NS_NAMES) {
    if (name.length <= ns.length || !name.startsWith(ns)) continue;
    const base = NAMESPACES[ns];
    const rest = name.slice(ns.length);

    if (rest === "Prototype") return base.prototype;
    if (rest.startsWith("Prototype")) {
      const hit = resolvePrototypeMember(base.prototype, rest.slice("Prototype".length));
      if (hit !== undefined) return hit;
      continue;
    }
    // Static method or constant: try lowerFirst (isArray, defineProperty) then
    // the raw name (MAX_SAFE_INTEGER, POSITIVE_INFINITY).
    const lf = lowerFirst(rest);
    if (lf in base) return base[lf];
    if (rest in base) return base[rest];
  }
  return undefined;
}

const cache = { __proto__: null };

export const primordials = new Proxy(
  { __proto__: null },
  {
    get(_target, prop) {
      if (typeof prop !== "string") return undefined;
      if (prop in cache) return cache[prop];
      const value = resolve(prop);
      if (value === undefined && !["undefined", "NaN"].includes(prop)) {
        throw new Error(
          `OpenContainer: primordials.${prop} is not resolvable — add it to node/primordials.js`,
        );
      }
      cache[prop] = value;
      return value;
    },
    has(_target, prop) {
      return typeof prop === "string" && resolve(prop) !== undefined;
    },
  },
);
