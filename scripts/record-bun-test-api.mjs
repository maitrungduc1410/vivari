// Records real Bun's expect() matcher table into scripts/fixtures/bun-test-api.json.
//
// bun:test only exists under `bun test`, so this is a TEST FILE rather than a
// script, and it has to be run by a real binary:
//
//   /path/to/bun test scripts/record-bun-test-api.mjs
//
// Two of the names on expect() are accessors that THROW when read out of context
// (`expect(1).resolves` complains about chaining), so the enumeration catches per
// property rather than mapping over the list.
import { expect, test, describe } from "bun:test";

test("record the bun:test API", async () => {
  const e = expect(1);
  const names = new Set();
  let o = e;
  while (o && o !== Object.prototype) {
    for (const n of Object.getOwnPropertyNames(o)) names.add(n);
    o = Object.getPrototypeOf(o);
  }
  const matchers = [];
  for (const n of names) {
    if (n.startsWith("_") || n === "constructor") continue;
    try {
      if (typeof e[n] === "function") matchers.push(n);
    } catch {
      matchers.push(n + " (accessor)");
    }
  }
  const out = {
    recordedFrom: "bun " + Bun.version,
    matchers: matchers.sort(),
    statics: Object.getOwnPropertyNames(expect).sort(),
    testProps: Object.getOwnPropertyNames(test).sort(),
    describeProps: Object.getOwnPropertyNames(describe).sort(),
  };
  await Bun.write(
    new URL("./fixtures/bun-test-api.json", import.meta.url).pathname,
    JSON.stringify(out, null, 1) + "\n",
  );
});
