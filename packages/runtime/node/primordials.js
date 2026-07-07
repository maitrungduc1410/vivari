// primordials — Node's "safe intrinsics" object.
//
// Node's real lib/ modules are written against `primordials` (e.g.
// `StringPrototypeSlice(str, a, b)` instead of `str.slice(a, b)`) so they can't
// be broken by user code monkey-patching Array/String/Object prototypes. Each
// entry is the prototype method "uncurried" so the receiver is the first arg.
//
// This is our own infrastructure (imported by the loader), not vendored Node
// source. It starts with the set the vendored modules need and grows as we add
// more real lib/ modules (Path B). Node generates a much larger table; we add
// entries on demand.

const uncurryThis =
  (fn) =>
  (self, ...args) =>
    fn.apply(self, args);

export const primordials = {
  // Globals / constructors
  globalThis,
  Array,
  ArrayIsArray: Array.isArray,
  Boolean,
  Error,
  Number,
  Object,
  RangeError,
  Reflect,
  ReflectApply: Reflect.apply,
  ReflectOwnKeys: Reflect.ownKeys,
  String,
  Symbol,
  SymbolIterator: Symbol.iterator,
  TypeError,

  // Number statics
  NumberIsInteger: Number.isInteger,
  NumberIsNaN: Number.isNaN,
  NumberMAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
  NumberMIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
  NumberParseInt: Number.parseInt,
  NumberParseFloat: Number.parseFloat,

  // Object statics
  ObjectKeys: Object.keys,
  ObjectValues: Object.values,
  ObjectEntries: Object.entries,
  ObjectAssign: Object.assign,
  ObjectCreate: Object.create,
  ObjectFreeze: Object.freeze,
  ObjectDefineProperty: Object.defineProperty,
  ObjectDefineProperties: Object.defineProperties,
  ObjectGetPrototypeOf: Object.getPrototypeOf,
  ObjectSetPrototypeOf: Object.setPrototypeOf,
  ObjectGetOwnPropertyDescriptor: Object.getOwnPropertyDescriptor,
  ObjectGetOwnPropertyNames: Object.getOwnPropertyNames,
  ObjectPrototypeHasOwnProperty: uncurryThis(Object.prototype.hasOwnProperty),
  ObjectPrototypeToString: uncurryThis(Object.prototype.toString),

  // Function
  FunctionPrototypeBind: uncurryThis(Function.prototype.bind),
  FunctionPrototypeCall: uncurryThis(Function.prototype.call),
  FunctionPrototypeApply: uncurryThis(Function.prototype.apply),

  // Array.prototype
  ArrayPrototypePush: uncurryThis(Array.prototype.push),
  ArrayPrototypePop: uncurryThis(Array.prototype.pop),
  ArrayPrototypeShift: uncurryThis(Array.prototype.shift),
  ArrayPrototypeUnshift: uncurryThis(Array.prototype.unshift),
  ArrayPrototypeSlice: uncurryThis(Array.prototype.slice),
  ArrayPrototypeSplice: uncurryThis(Array.prototype.splice),
  ArrayPrototypeIncludes: uncurryThis(Array.prototype.includes),
  ArrayPrototypeIndexOf: uncurryThis(Array.prototype.indexOf),
  ArrayPrototypeJoin: uncurryThis(Array.prototype.join),
  ArrayPrototypeMap: uncurryThis(Array.prototype.map),
  ArrayPrototypeForEach: uncurryThis(Array.prototype.forEach),
  ArrayPrototypeFilter: uncurryThis(Array.prototype.filter),
  ArrayPrototypeConcat: uncurryThis(Array.prototype.concat),
  ArrayPrototypeReverse: uncurryThis(Array.prototype.reverse),

  // String.prototype
  StringPrototypeCharCodeAt: uncurryThis(String.prototype.charCodeAt),
  StringPrototypeCodePointAt: uncurryThis(String.prototype.codePointAt),
  StringPrototypeIndexOf: uncurryThis(String.prototype.indexOf),
  StringPrototypeLastIndexOf: uncurryThis(String.prototype.lastIndexOf),
  StringPrototypeSlice: uncurryThis(String.prototype.slice),
  StringPrototypeSubstring: uncurryThis(String.prototype.substring),
  StringPrototypeReplace: uncurryThis(String.prototype.replace),
  StringPrototypeSplit: uncurryThis(String.prototype.split),
  StringPrototypeStartsWith: uncurryThis(String.prototype.startsWith),
  StringPrototypeEndsWith: uncurryThis(String.prototype.endsWith),
  StringPrototypeIncludes: uncurryThis(String.prototype.includes),
  StringPrototypeToLowerCase: uncurryThis(String.prototype.toLowerCase),
  StringPrototypeToUpperCase: uncurryThis(String.prototype.toUpperCase),
  StringPrototypeTrim: uncurryThis(String.prototype.trim),
  StringPrototypeRepeat: uncurryThis(String.prototype.repeat),
  StringPrototypePadStart: uncurryThis(String.prototype.padStart),

  // RegExp.prototype
  RegExpPrototypeExec: uncurryThis(RegExp.prototype.exec),
  RegExpPrototypeTest: uncurryThis(RegExp.prototype.test),
  RegExpPrototypeSymbolReplace: uncurryThis(RegExp.prototype[Symbol.replace]),
};
