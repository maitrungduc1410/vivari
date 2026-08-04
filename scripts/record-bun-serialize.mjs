// Records real Bun's bun:jsc round-trip behaviour into
// scripts/fixtures/bun-serialize.json. Run it WITH a real bun binary:
//
//   /path/to/bun scripts/record-bun-serialize.mjs
//
// Running it under node records Vivari's own answers, which would turn the
// fixture into a mirror and the comparison into a tautology.
import { writeFileSync } from "node:fs";
import { collect } from "./lib/serialize-cases.mjs";

if (typeof globalThis.Bun === "undefined") {
  console.error("this must be run by a real bun binary, not by node");
  process.exit(2);
}
const { serialize, deserialize } = await import("bun:jsc");
const out = { recordedFrom: "bun " + Bun.version, ...collect(serialize, deserialize) };
writeFileSync(new URL("./fixtures/bun-serialize.json", import.meta.url), JSON.stringify(out, null, 1) + "\n");
console.log("recorded " + Object.keys(out.results).length + " cases from bun " + Bun.version);
