// The shared corpus for bun:jsc serialize/deserialize, and the description of
// what came back.
//
// The values cannot live in a JSON fixture — a Map, a cycle and a hole are the
// interesting cases and none of them survive JSON — so both sides build them from
// this module and record a DESCRIPTION of the round-trip instead. The recorder
// runs it under a real bun (scripts/record-bun-serialize.mjs); the spike runs it
// under Vivari's implementation. Same corpus, same describe(), so a difference in
// the output is a difference in behaviour rather than in how it was measured.

export function makeCases() {
  const cyclic = { name: "cyclic" };
  cyclic.self = cyclic;
  const shared = { s: 1 };
  const buffer = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer;
  const nested = new Map([["k", new Set([1, { deep: [null, undefined] }])]]);
  return [
    ["number", 42],
    ["negative-zero", -0],
    ["nan", NaN],
    ["infinity", -Infinity],
    ["string", "héllo \u{1f600}"],
    ["empty-string", ""],
    ["true", true],
    ["null", null],
    ["undefined", undefined],
    ["bigint", 123456789012345678901234567890n],
    ["bigint-negative", -7n],
    ["date", new Date(1700000000000)],
    ["invalid-date", new Date(NaN)],
    ["regexp", /ab+c/gi],
    ["map", new Map([["a", 1], ["b", { x: 1 }]])],
    ["map-nested", nested],
    ["set", new Set([1, "two", { three: 3 }])],
    ["error", new TypeError("bad")],
    ["error-cause", new Error("with cause", { cause: "why" })],
    ["uint8", new Uint8Array([1, 2, 3])],
    ["float64", new Float64Array([1.5, -0.25])],
    ["bigint64", new BigInt64Array([1n, -2n])],
    ["dataview", new DataView(new Uint8Array([9, 8, 7]).buffer)],
    ["arraybuffer", new Uint8Array([7, 7]).buffer],
    ["two-views-one-buffer", { a: new Uint8Array(buffer, 0, 4), b: new Uint8Array(buffer, 4, 4) }],
    ["sparse", [1, , 3]],
    ["array-with-props", Object.assign([1, 2], { note: "extra" })],
    ["nested-plain", { a: [1, { b: 2 }], c: { d: [3] } }],
    ["cyclic", cyclic],
    ["shared-identity", { x: shared, y: shared }],
    ["boxed-string", new String("boxed")],
    ["boxed-number", new Number(3)],
    ["undefined-property", { present: undefined }],
    ["empty-object", {}],
    ["empty-array", []],
  ];
}

/** Values every implementation must REFUSE rather than mangle. */
export function makeRefusals() {
  return [
    ["function", () => 1],
    ["symbol", Symbol("s")],
    ["weakmap", new WeakMap()],
    ["promise", Promise.resolve(1)],
  ];
}

/**
 * A comparable summary of one round-tripped value: enough detail that a silent
 * loss shows up as a difference, and nothing that varies between runs (no
 * addresses, no stacks, no byte counts — the byte format is engine-internal and
 * deliberately not compared).
 */
export function describe(value, original) {
  const tag = Object.prototype.toString.call(value).slice(8, -1);
  const out = { tag };
  if (typeof value === "bigint") out.value = value.toString();
  else if (typeof value === "number") out.value = Object.is(value, -0) ? "-0" : String(value);
  else if (typeof value === "string" || typeof value === "boolean" || value === null || value === undefined) out.value = String(value);

  if (value instanceof Date) out.time = String(value.getTime());
  if (value instanceof RegExp) out.re = value.source + "/" + value.flags;
  if (value instanceof Map) out.entries = [...value].map(([k, v]) => [shallow(k), shallow(v)]);
  if (value instanceof Set) out.values = [...value].map(shallow);
  if (value instanceof Error) {
    out.name = value.name;
    out.message = value.message;
    out.hasStack = typeof value.stack === "string" && value.stack.length > 0;
    out.cause = value.cause === undefined ? "dropped" : String(value.cause);
  }
  if (ArrayBuffer.isView(value)) {
    out.kind = value.constructor.name;
    out.byteOffset = value.byteOffset;
    out.byteLength = value.byteLength;
    out.contents = [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)].join(",");
  }
  if (value instanceof ArrayBuffer) out.contents = [...new Uint8Array(value)].join(",");
  if (Array.isArray(value)) {
    out.length = value.length;
    out.holes = Array.from({ length: value.length }, (_, i) => (i in value ? "v" : "h")).join("");
    out.named = Object.keys(value).filter((k) => String(Number(k)) !== k).map((k) => k + "=" + shallow(value[k]));
  }
  if (tag === "Object") {
    out.keys = Object.keys(value);
    // `{present: undefined}` must keep the key: JSON drops it, structured clone
    // does not, and that difference is the whole reason this file exists.
    out.hasUndefinedProps = Object.keys(value).filter((k) => value[k] === undefined);
  }
  if (tag === "String" || tag === "Number" || tag === "Boolean") out.boxed = String(value.valueOf());

  // Identity questions, asked of the ROUND-TRIPPED value only — the point is
  // whether the structure survived, not whether it equals the input by reference.
  if (original && original.name === "cyclic") out.cycle = value.self === value ? "preserved" : "LOST";
  if (original && original.x && original.y) out.identity = value.x === value.y ? "preserved" : "LOST";
  if (value && value.a && value.b && ArrayBuffer.isView(value.a) && ArrayBuffer.isView(value.b)) {
    out.sharedBuffer = value.a.buffer === value.b.buffer ? "preserved" : "LOST";
  }
  return out;
}

function shallow(v) {
  if (v === null) return "null";
  if (typeof v === "object") return Object.prototype.toString.call(v).slice(8, -1) + JSON.stringify(Object.keys(v));
  return typeof v + ":" + String(v);
}

/** Runs the corpus through one implementation and returns comparable results. */
export function collect(serialize, deserialize) {
  const results = {};
  for (const [name, value] of makeCases()) {
    try {
      const back = deserialize(serialize(value));
      results[name] = describe(back, value);
    } catch (err) {
      results[name] = { threw: err.constructor.name + ": " + err.message };
    }
  }
  const refusals = {};
  for (const [name, value] of makeRefusals()) {
    try {
      serialize(value);
      refusals[name] = "NOT REFUSED";
    } catch (err) {
      refusals[name] = err.constructor.name + ": " + err.message;
    }
  }
  const corrupt = {};
  for (const [name, input] of [
    ["garbage", new Uint8Array([200, 200, 200]).buffer],
    ["truncated", new Uint8Array(serializeToBytes(serialize, { a: 1 }).slice(0, 3)).buffer],
    ["empty", new ArrayBuffer(0)],
    ["not-a-buffer", "hello"],
  ]) {
    try {
      corrupt[name] = "returned " + JSON.stringify(deserialize(input));
    } catch (err) {
      corrupt[name] = err.constructor.name + ": " + err.message;
    }
  }
  return { results, refusals, corrupt };
}

function serializeToBytes(serialize, value) {
  const out = serialize(value);
  return new Uint8Array(out instanceof ArrayBuffer || (typeof SharedArrayBuffer === "function" && out instanceof SharedArrayBuffer) ? out : out.buffer);
}
