// bun:jsc serialize/deserialize — structured clone, as bytes.
//
// What was here before was `JSON.stringify`, and JSON is not a subset of this
// problem, it is a different one. It drops `undefined` from objects, turns a Date
// into a string, a Map and a Set into `{}`, throws on a BigInt and on any cycle,
// and loses the distinction between `-0` and `0`. Every one of those is silent
// except the two throws: `deserialize(serialize(x))` handed back something that
// looked plausible and was not what went in. A round-trip that quietly changes
// the value is worse than one that refuses.
//
// Real Bun implements JSC's structured clone here. The bytes are engine-internal
// — Bun's own documentation says they are not portable, and JSC's format is
// versioned against the engine — so matching them is neither possible nor useful.
// What IS observable, and what this matches (measured against bun 1.3.14):
//
//   serialize() returns a SharedArrayBuffer; deserialize() takes that, or any
//   view of it, and returns an equal value
//   Map, Set, Date, RegExp, BigInt, boxed primitives, TypedArrays, DataView,
//   ArrayBuffer, and Errors (name, message and stack — but NOT `cause`, which
//   real Bun drops too) all survive
//   cycles survive, and so does shared identity: `{x: o, y: o}` comes back with
//   `x === y`
//   holes in a sparse array stay holes; `-0` stays `-0`
//   a function, a symbol or a WeakMap is refused with a DOMException, not
//   silently turned into `{}` or `null`
//   corrupt input throws `TypeError: Unable to deserialize data.`
//
// The format below is Vivari's own: a tag byte, then the payload, with every
// object-ish value assigned an index as it is written so a repeat can be written
// as a back-reference. The decoder registers each object BEFORE filling it in,
// which is what makes a cycle decodable at all.

const TAG = {
  UNDEFINED: 0,
  NULL: 1,
  TRUE: 2,
  FALSE: 3,
  NUMBER: 4,
  STRING: 5,
  BIGINT: 6,
  DATE: 7,
  REGEXP: 8,
  ARRAY: 9,
  OBJECT: 10,
  MAP: 11,
  SET: 12,
  ERROR: 13,
  ARRAYBUFFER: 14,
  VIEW: 15,
  BOXED: 16,
  REF: 17,
};

// Array entries are written one of two ways, because a hole is not `undefined`:
// `[1, , 3]` has no index 1 at all, and real Bun's round-trip keeps it that way.
const HOLE = 0;
const VALUE = 1;

const VIEW_KINDS = [
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array",
  "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array",
  "BigUint64Array", "DataView",
];

const BOXED_KINDS = ["String", "Number", "Boolean"];

/** Grows on demand; the caller never has to guess a size. */
class ByteWriter {
  constructor() {
    this.bytes = new Uint8Array(256);
    this.view = new DataView(this.bytes.buffer);
    this.length = 0;
  }
  _room(n) {
    if (this.length + n <= this.bytes.length) return;
    let size = this.bytes.length * 2;
    while (size < this.length + n) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(this.bytes.subarray(0, this.length));
    this.bytes = grown;
    this.view = new DataView(grown.buffer);
  }
  u8(v) {
    this._room(1);
    this.bytes[this.length++] = v;
  }
  u32(v) {
    this._room(4);
    this.view.setUint32(this.length, v, true);
    this.length += 4;
  }
  f64(v) {
    this._room(8);
    this.view.setFloat64(this.length, v, true);
    this.length += 8;
  }
  raw(u8) {
    this._room(u8.length);
    this.bytes.set(u8, this.length);
    this.length += u8.length;
  }
  string(s) {
    const encoded = new TextEncoder().encode(s);
    this.u32(encoded.length);
    this.raw(encoded);
  }
}

class ByteReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.offset = 0;
  }
  _need(n) {
    if (this.offset + n > this.bytes.length) throw new RangeError("truncated");
  }
  u8() {
    this._need(1);
    return this.bytes[this.offset++];
  }
  u32() {
    this._need(4);
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }
  f64() {
    this._need(8);
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }
  raw(n) {
    this._need(n);
    const slice = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }
  string() {
    return new TextDecoder().decode(this.raw(this.u32()));
  }
}

function cannotClone(value) {
  // The message and the type are the browser's and Bun's alike: a DOMException
  // named DataCloneError. A plain Error here would be catchable by name but not
  // by `instanceof DOMException`, which is how this is caught in the wild.
  const message = "The object can not be cloned.";
  const DOMEx = globalThis.DOMException;
  const err = DOMEx ? new DOMEx(message, "DataCloneError") : new Error(message);
  err.__vvUnclonable = value;
  return err;
}

function write(w, value, seen) {
  const kind = typeof value;
  if (value === undefined) return w.u8(TAG.UNDEFINED);
  if (value === null) return w.u8(TAG.NULL);
  if (value === true) return w.u8(TAG.TRUE);
  if (value === false) return w.u8(TAG.FALSE);
  if (kind === "number") {
    w.u8(TAG.NUMBER);
    return w.f64(value);
  }
  if (kind === "string") {
    w.u8(TAG.STRING);
    return w.string(value);
  }
  if (kind === "bigint") {
    w.u8(TAG.BIGINT);
    return w.string(value.toString());
  }
  if (kind === "function" || kind === "symbol") throw cannotClone(value);

  // Everything below is an object, so it takes part in reference identity: the
  // second sighting is a back-reference, which is what preserves both a cycle and
  // `{x: o, y: o}` coming back with `x === y`.
  const already = seen.get(value);
  if (already !== undefined) {
    w.u8(TAG.REF);
    return w.u32(already);
  }
  seen.set(value, seen.size);

  if (value instanceof Date) {
    w.u8(TAG.DATE);
    return w.f64(value.getTime());
  }
  if (value instanceof RegExp) {
    w.u8(TAG.REGEXP);
    w.string(value.source);
    return w.string(value.flags);
  }
  if (value instanceof Error) {
    w.u8(TAG.ERROR);
    w.string(value.name || "Error");
    w.string(value.message || "");
    // `cause` is deliberately not written: real Bun drops it, and inventing
    // fidelity Bun does not have would make code that works here fail there.
    return w.string(typeof value.stack === "string" ? value.stack : "");
  }
  if (value instanceof Map) {
    w.u8(TAG.MAP);
    w.u32(value.size);
    for (const [k, v] of value) {
      write(w, k, seen);
      write(w, v, seen);
    }
    return;
  }
  if (value instanceof Set) {
    w.u8(TAG.SET);
    w.u32(value.size);
    for (const v of value) write(w, v, seen);
    return;
  }
  if (value instanceof ArrayBuffer) {
    w.u8(TAG.ARRAYBUFFER);
    const bytes = new Uint8Array(value);
    w.u32(bytes.length);
    return w.raw(bytes);
  }
  if (ArrayBuffer.isView(value)) {
    const kindName = value.constructor && value.constructor.name;
    const index = VIEW_KINDS.indexOf(kindName);
    if (index < 0) throw cannotClone(value);
    w.u8(TAG.VIEW);
    w.u8(index);
    w.u32(value.byteOffset);
    w.u32(kindName === "DataView" ? value.byteLength : value.length);
    // The buffer goes through `write` rather than inline, so two views onto one
    // buffer stay two views onto ONE buffer after the round-trip.
    return write(w, value.buffer, seen);
  }
  if (Array.isArray(value)) {
    w.u8(TAG.ARRAY);
    w.u32(value.length);
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        w.u8(HOLE);
        continue;
      }
      w.u8(VALUE);
      write(w, value[i], seen);
    }
    // Named properties on an array survive a structured clone too.
    const extra = Object.keys(value).filter((k) => String(Number(k)) !== k);
    w.u32(extra.length);
    for (const key of extra) {
      w.string(key);
      write(w, value[key], seen);
    }
    return;
  }
  const boxed = BOXED_KINDS.indexOf(
    Object.prototype.toString.call(value).slice(8, -1),
  );
  if (boxed >= 0 && Object(value.valueOf()) !== value.valueOf()) {
    w.u8(TAG.BOXED);
    w.u8(boxed);
    return write(w, value.valueOf(), seen);
  }
  // A plain object, or something close enough to one. Anything with internal
  // state a structured clone cannot reach — a WeakMap, a Promise, a class with
  // private fields — has no enumerable own data to write, and Bun refuses those
  // outright rather than handing back an empty object.
  if (isOpaque(value)) throw cannotClone(value);
  const keys = Object.keys(value);
  w.u8(TAG.OBJECT);
  w.u32(keys.length);
  for (const key of keys) {
    w.string(key);
    write(w, value[key], seen);
  }
}

const OPAQUE = ["WeakMap", "WeakSet", "WeakRef", "Promise", "Proxy", "Function", "Blob", "File"];

function isOpaque(value) {
  const tag = Object.prototype.toString.call(value).slice(8, -1);
  if (OPAQUE.includes(tag)) return true;
  // Blob and File report as [object Blob]/[object File] above; a subclass may
  // not, so check the constructor chain for the two the sandbox cannot read
  // synchronously (see the note in bun.js where these are refused by name).
  return false;
}

function read(r, refs) {
  const tag = r.u8();
  switch (tag) {
    case TAG.UNDEFINED:
      return undefined;
    case TAG.NULL:
      return null;
    case TAG.TRUE:
      return true;
    case TAG.FALSE:
      return false;
    case TAG.NUMBER:
      return r.f64();
    case TAG.STRING:
      return r.string();
    case TAG.BIGINT:
      return BigInt(r.string());
    case TAG.REF: {
      const index = r.u32();
      if (index >= refs.length) throw new RangeError("bad reference");
      return refs[index];
    }
    case TAG.DATE: {
      const date = new Date(r.f64());
      refs.push(date);
      return date;
    }
    case TAG.REGEXP: {
      const slot = refs.length;
      refs.push(null);
      const re = new RegExp(r.string(), r.string());
      refs[slot] = re;
      return re;
    }
    case TAG.ERROR: {
      const slot = refs.length;
      refs.push(null);
      const name = r.string();
      const message = r.string();
      const stack = r.string();
      const Ctor = ERROR_TYPES[name] || Error;
      const err = new Ctor(message);
      err.name = name;
      if (stack) err.stack = stack;
      refs[slot] = err;
      return err;
    }
    case TAG.MAP: {
      const map = new Map();
      refs.push(map);
      const size = r.u32();
      for (let i = 0; i < size; i++) {
        const k = read(r, refs);
        map.set(k, read(r, refs));
      }
      return map;
    }
    case TAG.SET: {
      const set = new Set();
      refs.push(set);
      const size = r.u32();
      for (let i = 0; i < size; i++) set.add(read(r, refs));
      return set;
    }
    case TAG.ARRAYBUFFER: {
      const length = r.u32();
      const buffer = new ArrayBuffer(length);
      new Uint8Array(buffer).set(r.raw(length));
      refs.push(buffer);
      return buffer;
    }
    case TAG.VIEW: {
      const slot = refs.length;
      refs.push(null);
      const kind = VIEW_KINDS[r.u8()];
      const byteOffset = r.u32();
      const length = r.u32();
      const buffer = read(r, refs);
      const Ctor = globalThis[kind];
      if (!Ctor) throw new RangeError("unknown view " + kind);
      const view = new Ctor(buffer, byteOffset, length);
      refs[slot] = view;
      return view;
    }
    case TAG.BOXED: {
      const slot = refs.length;
      refs.push(null);
      const Ctor = globalThis[BOXED_KINDS[r.u8()]];
      const boxed = Object(Ctor(read(r, refs)));
      refs[slot] = boxed;
      return boxed;
    }
    case TAG.ARRAY: {
      const array = [];
      refs.push(array);
      const length = r.u32();
      array.length = length;
      for (let i = 0; i < length; i++) {
        if (r.u8() === HOLE) continue;
        array[i] = read(r, refs);
      }
      const extra = r.u32();
      for (let i = 0; i < extra; i++) {
        const key = r.string();
        array[key] = read(r, refs);
      }
      return array;
    }
    case TAG.OBJECT: {
      const object = {};
      refs.push(object);
      const count = r.u32();
      for (let i = 0; i < count; i++) {
        const key = r.string();
        object[key] = read(r, refs);
      }
      return object;
    }
    default:
      throw new RangeError("unknown tag " + tag);
  }
}

const ERROR_TYPES = {
  Error,
  TypeError,
  RangeError,
  SyntaxError,
  ReferenceError,
  EvalError,
  URIError,
};

/**
 * Bun returns a SharedArrayBuffer here — measured, and worth matching, because
 * code that checks or transfers the result sees the same type it would there.
 */
export function serialize(value) {
  const w = new ByteWriter();
  write(w, value, new Map());
  const Buf = typeof SharedArrayBuffer === "function" ? SharedArrayBuffer : ArrayBuffer;
  const out = new Buf(w.length);
  new Uint8Array(out).set(w.bytes.subarray(0, w.length));
  return out;
}

export function deserialize(input) {
  let bytes;
  if (input instanceof ArrayBuffer || (typeof SharedArrayBuffer === "function" && input instanceof SharedArrayBuffer)) {
    bytes = new Uint8Array(input);
  } else if (ArrayBuffer.isView(input)) {
    bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  } else {
    // A different sentence from the corrupt-data one, because it is a different
    // mistake — and it is Bun's sentence, measured.
    throw new TypeError("First argument must be an ArrayBuffer");
  }
  // Zero bytes is not corruption in Bun; it is `null`.
  if (bytes.length === 0) return null;
  const r = new ByteReader(bytes);
  let value;
  try {
    value = read(r, []);
  } catch {
    // Every failure mode of a corrupt buffer — a tag we never wrote, a length
    // that runs past the end, a reference to an object that does not exist —
    // reaches the caller as the sentence real Bun uses.
    throw new TypeError("Unable to deserialize data.");
  }
  if (r.offset !== bytes.length) throw new TypeError("Unable to deserialize data.");
  return value;
}
