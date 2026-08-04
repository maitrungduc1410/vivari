// bun:jsc serialize/deserialize, compared case by case against a real Bun.
//
// The bytes are not compared and never should be: JSC's format is internal and
// versioned against the engine, and Bun's own documentation says the output is
// not portable. What is compared is everything a program can observe about the
// value that comes back — its type, its contents, whether a cycle survived,
// whether two views still share one buffer, whether a hole is still a hole —
// recorded from bun 1.3.14 by scripts/record-bun-serialize.mjs.
//
// Run: node scripts/run-spikes.mjs --offline serialize

import { readFileSync } from "node:fs";
import { serialize, deserialize } from "../packages/runtime/builtins/bun-serialize.js";
import { collect } from "./lib/serialize-cases.mjs";

const expected = JSON.parse(readFileSync(new URL("./fixtures/bun-serialize.json", import.meta.url), "utf8"));
const actual = collect(serialize, deserialize);

let failures = 0;
const compare = (label, mine, theirs) => {
  const a = JSON.stringify(mine);
  const b = JSON.stringify(theirs);
  if (a === b) return console.log("  ok   " + label);
  failures++;
  console.log("  FAIL " + label + "\n         bun: " + b + "\n        vivari: " + a);
};

console.log("\nround-trip, against bun " + expected.recordedFrom.replace("bun ", ""));
for (const [name, theirs] of Object.entries(expected.results)) compare(name, actual.results[name], theirs);

console.log("\nwhat must be refused");
for (const [name, theirs] of Object.entries(expected.refusals)) compare(name, actual.refusals[name], theirs);

console.log("\ncorrupt input");
for (const [name, theirs] of Object.entries(expected.corrupt)) compare(name, actual.corrupt[name], theirs);

console.log("\nthe shape of the result");
{
  const out = serialize({ a: 1 });
  // Real Bun hands back a SharedArrayBuffer, and code that checks or transfers it
  // sees that type; deserialize takes the buffer or any view of it.
  const ok = (label, cond) => (cond ? console.log("  ok   " + label) : (failures++, console.log("  FAIL " + label)));
  ok("serialize returns a SharedArrayBuffer", Object.prototype.toString.call(out) === "[object SharedArrayBuffer]");
  ok("deserialize accepts the buffer", deserialize(out).a === 1);
  ok("deserialize accepts a Uint8Array view of it", deserialize(new Uint8Array(out)).a === 1);
  ok("deserialize accepts a copy into a plain ArrayBuffer", deserialize(new Uint8Array(out).slice().buffer).a === 1);
}

console.log("\nthe loss this replaces");
{
  // The four JSON was silently getting wrong, stated as regressions so they
  // cannot come back: each one used to round-trip into something that looked
  // fine and was not the value that went in.
  const ok = (label, cond) => (cond ? console.log("  ok   " + label) : (failures++, console.log("  FAIL " + label)));
  const map = deserialize(serialize(new Map([["k", 1]])));
  ok("a Map is a Map, not {}", map instanceof Map && map.get("k") === 1);
  const date = deserialize(serialize(new Date(1700000000000)));
  ok("a Date is a Date, not a string", date instanceof Date && date.getTime() === 1700000000000);
  const cyc = { name: "c" };
  cyc.self = cyc;
  ok("a cycle round-trips instead of throwing", deserialize(serialize(cyc)).self.name === "c");
  ok("a BigInt round-trips instead of throwing", deserialize(serialize({ n: 7n })).n === 7n);
  ok("`{a: undefined}` keeps its key", "a" in deserialize(serialize({ a: undefined })));
}

console.log("");
if (failures) {
  console.log("FAIL: " + failures + " difference(s) from real Bun");
  process.exit(1);
}
console.log("PASS: bun:jsc round-trips as Bun's does");
