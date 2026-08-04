// Every matcher Bun's expect() has, and whether this one has it.
//
// The gap this closes was not cosmetic. A suite written against Bun that calls
// `expect(n).toBeOdd()` did not FAIL here — it crashed with "toBeOdd is not a
// function", which reads as a broken test rather than a missing runner feature,
// and sends the reader to their own code. 34 of Bun's 87 matchers were in that
// state, including the jest spellings (`toBeCalledWith`, `lastCalledWith`) that
// any suite ported from jest uses.
//
// The list is recorded from the binary (scripts/record-bun-test-api.mjs), so the
// next matcher Bun adds arrives here as a failing check rather than as a crash in
// somebody's suite.
//
// Run: node scripts/run-spikes.mjs --offline bun-test-matchers

import { readFileSync } from "node:fs";
import { createBunTest } from "../packages/runtime/builtins/bun-test.js";
// The same three dependencies the runtime injects (packages/runtime/builtins/bun.js):
// deepEquals is Bun's own comparison, and half the matcher table is a thin layer
// over it, so building this with a stub would test the stub.
import {
  bunDeepEquals,
  bunDeepMatch,
} from "../packages/runtime/builtins/bun.js";

const recorded = JSON.parse(
  readFileSync(
    new URL("./fixtures/bun-test-api.json", import.meta.url),
    "utf8",
  ),
);

let failures = 0;
const ok = (cond, label) => {
  console.log((cond ? "  ok   " : "  FAIL ") + label);
  if (!cond) failures++;
};

const api = createBunTest({
  process,
  lazy: () => ({}),
  deepEquals: bunDeepEquals,
  deepMatch: bunDeepMatch,
});
const { expect } = api;

console.log("\n1) the table, against " + recorded.recordedFrom);
{
  const mine = expect(1);
  const missing = [];
  for (const raw of recorded.matchers) {
    const name = raw.replace(" (accessor)", "");
    let present = false;
    try {
      present = typeof mine[name] === "function" || raw.endsWith("(accessor)");
    } catch {
      present = true; // an accessor that throws when read is still present
    }
    if (!present) missing.push(name);
  }
  ok(
    missing.length === 0,
    "every matcher real Bun has: " +
      (missing.length
        ? "MISSING " + missing.join(" ")
        : recorded.matchers.length + " present"),
  );
}

console.log("\n2) the new ones pass and fail in the right places");
const check = (label, fn, shouldPass) => {
  let threw = null;
  try {
    fn();
  } catch (err) {
    threw = err;
  }
  ok(
    shouldPass ? !threw : !!threw,
    label +
      (shouldPass ? "" : " (must fail)") +
      (threw && shouldPass ? " — " + threw.message : ""),
  );
};

check("toBeEven(4)", () => expect(4).toBeEven(), true);
check("toBeEven(3)", () => expect(3).toBeEven(), false);
check("toBeOdd(3)", () => expect(3).toBeOdd(), true);
check("toBeOdd(-3)", () => expect(-3).toBeOdd(), true);
// Bun refuses a non-number rather than answering "false": a string here is a
// mistake in the test, not a fact about the string.
check("toBeOdd('3') refuses", () => expect("3").toBeOdd(), false);
check(
  "toBePositive(1) / toBeNegative(-1)",
  () => {
    expect(1).toBePositive();
    expect(-1).toBeNegative();
  },
  true,
);
check("toBePositive(0) fails", () => expect(0).toBePositive(), false);
// Half-open, as in Bun: [start, end).
check("toBeWithin(1, 1, 2)", () => expect(1).toBeWithin(1, 2), true);
check(
  "toBeWithin(2, 1, 2) fails — the range excludes its end",
  () => expect(2).toBeWithin(1, 2),
  false,
);
check(
  "toBeEven(2.5) fails — even means an even INTEGER",
  () => expect(2.5).toBeEven(),
  false,
);
check(
  "toBeTrue / toBeFalse",
  () => {
    expect(true).toBeTrue();
    expect(false).toBeFalse();
  },
  true,
);
check(
  "toBeTrue(1) fails — truthy is not true",
  () => expect(1).toBeTrue(),
  false,
);
check("toBeSymbol", () => expect(Symbol("s")).toBeSymbol(), true);
check("toBeValidDate", () => expect(new Date()).toBeValidDate(), true);
check(
  "toBeValidDate(new Date(NaN)) fails",
  () => expect(new Date(NaN)).toBeValidDate(),
  false,
);
check("toBeEmptyObject({})", () => expect({}).toBeEmptyObject(), true);
// All four of these were probed against the binary; the array in particular is the
// one a from-first-principles implementation gets wrong.
check(
  "toBeEmptyObject([]) — Bun counts an empty array",
  () => expect([]).toBeEmptyObject(),
  true,
);
check(
  "toBeEmptyObject(class instance)",
  () => expect(new (class {})()).toBeEmptyObject(),
  true,
);
check(
  "toBeEmptyObject(new Set()) fails — an empty Set is a Set",
  () => expect(new Set()).toBeEmptyObject(),
  false,
);
check(
  "toBeEmptyObject(new Date()) fails",
  () => expect(new Date()).toBeEmptyObject(),
  false,
);
check("toBeEmptyObject('') fails", () => expect("").toBeEmptyObject(), false);
check(
  "toEqualIgnoringWhitespace",
  () => expect(" a  b ").toEqualIgnoringWhitespace("ab"),
  true,
);
check(
  "toIncludeRepeated('aaa', 'aa', 1) — non-overlapping",
  () => expect("aaa").toIncludeRepeated("aa", 1),
  true,
);
check(
  "toIncludeRepeated('aaa', 'aa', 2) fails",
  () => expect("aaa").toIncludeRepeated("aa", 2),
  false,
);

const obj = { a: 1, b: 2 };
check("toContainKey", () => expect(obj).toContainKey("a"), true);
check("toContainKeys", () => expect(obj).toContainKeys(["a", "b"]), true);
check(
  "toContainKeys with an extra fails",
  () => expect(obj).toContainKeys(["a", "z"]),
  false,
);
check("toContainAllKeys", () => expect(obj).toContainAllKeys(["b", "a"]), true);
check(
  "toContainAllKeys missing one fails",
  () => expect(obj).toContainAllKeys(["a"]),
  false,
);
check("toContainAnyKeys", () => expect(obj).toContainAnyKeys(["z", "a"]), true);
check("toContainValue", () => expect(obj).toContainValue(2), true);
check("toContainValues", () => expect(obj).toContainValues([1, 2]), true);
check("toContainAllValues", () => expect(obj).toContainAllValues([2, 1]), true);
check("toContainAnyValues", () => expect(obj).toContainAnyValues([9, 1]), true);

console.log("\n3) mock matchers, including the jest spellings");
{
  const fn = api.mock((x) => x * 2);
  fn(2);
  fn(3);
  check("toHaveReturnedWith", () => expect(fn).toHaveReturnedWith(4), true);
  check(
    "toHaveLastReturnedWith",
    () => expect(fn).toHaveLastReturnedWith(6),
    true,
  );
  check(
    "toHaveNthReturnedWith(1)",
    () => expect(fn).toHaveNthReturnedWith(1, 4),
    true,
  );
  check(
    "toHaveNthReturnedWith is 1-based, not 0-based",
    () => expect(fn).toHaveNthReturnedWith(0, 4),
    false,
  );
  const once = api.mock(() => 1);
  once();
  check(
    "toHaveBeenCalledOnce",
    () => expect(once).toHaveBeenCalledOnce(),
    true,
  );
  check(
    "toHaveBeenCalledOnce after two calls fails",
    () => {
      once();
      expect(once).toHaveBeenCalledOnce();
    },
    false,
  );
  // The aliases must be the SAME behaviour, not a second implementation.
  check(
    "toBeCalledWith === toHaveBeenCalledWith",
    () => expect(fn).toBeCalledWith(2),
    true,
  );
  check("lastCalledWith", () => expect(fn).lastCalledWith(3), true);
  check("nthCalledWith", () => expect(fn).nthCalledWith(1, 2), true);
  check("toReturn", () => expect(fn).toReturn(), true);
  check("lastReturnedWith", () => expect(fn).lastReturnedWith(6), true);
  check("nthReturnedWith", () => expect(fn).nthReturnedWith(2, 6), true);
  check("toBeCalledTimes(2)", () => expect(fn).toBeCalledTimes(2), true);
}

console.log("\n4) the throwing snapshot matchers");
{
  check(
    "toThrowErrorMatchingInlineSnapshot on a thrower",
    () =>
      expect(() => {
        throw new Error("boom");
      }).toThrowErrorMatchingInlineSnapshot(`"boom"`),
    true,
  );
  check(
    "…and it fails when the message differs",
    () =>
      expect(() => {
        throw new Error("other");
      }).toThrowErrorMatchingInlineSnapshot(`"boom"`),
    false,
  );
  check(
    "…and a function that does not throw is a failure, not an empty snapshot",
    () => expect(() => 1).toThrowErrorMatchingInlineSnapshot(`"boom"`),
    false,
  );
  check(
    "a non-function receiver is a usage error",
    () => expect(5).toThrowErrorMatchingInlineSnapshot(`"boom"`),
    false,
  );
}

console.log("\n5) `.not` still inverts the new ones");
check("not.toBeEven(3)", () => expect(3).not.toBeEven(), true);
check("not.toBeEven(4) fails", () => expect(4).not.toBeEven(), false);
check("not.toContainKey", () => expect(obj).not.toContainKey("z"), true);

console.log("\n6) expect.assertions / hasAssertions, through a real run");
{
  // These two are the only matchers in the table that depend on the RUNNER: they
  // count what a test did and report at the end of it. Checking them by calling
  // the function would prove nothing, so this drives actual tests.
  const t = createBunTest({
    process,
    lazy: () => ({}),
    deepEquals: bunDeepEquals,
    deepMatch: bunDeepMatch,
  });
  // The runner reports by printing, and `__run` returns an exit code rather than a
  // tally, so the report is what gets read back.
  const printed = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    printed.push(String(chunk));
    return true;
  };
  t.test("counts what the test asserted", () => {
    t.expect.assertions(2);
    t.expect(1).toBe(1);
    t.expect(1).not.toBe(2); // a negated matcher counts too, as in Bun
  });
  t.test("notices a test that asserted less than it promised", () => {
    t.expect.assertions(2);
    t.expect(1).toBe(1);
  });
  t.test("hasAssertions with none", () => {
    t.expect.hasAssertions();
  });
  t.test("hasAssertions with one", () => {
    t.expect.hasAssertions();
    t.expect(1).toBe(1);
  });
  const exitCode = await t.__run({});
  process.stdout.write = write;
  const report = printed.join("");
  ok(exitCode === 1, "the run reports failure");
  ok(
    /2 pass, 2 fail/.test(report),
    "exactly the two under-asserting tests failed: " +
      (report.match(/\d+ pass, \d+ fail/) || ["?"])[0],
  );
  // Bun's wording, which is what somebody reading a red test will search for.
  ok(
    report.includes("expected 2 assertions, but test ended with 1 assertion"),
    "assertions(n) reports the shortfall in Bun's words",
  );
  ok(
    report.includes(
      "received 0 assertions, but expected at least one assertion to be called",
    ),
    "hasAssertions() reports an empty test in Bun's words",
  );
}

console.log("\n7) the remaining statics");
check(
  "expect.unreachable() throws Bun's default message",
  () => expect.unreachable(),
  false,
);
{
  let msg = null;
  try {
    expect.unreachable();
  } catch (e) {
    msg = e.message;
  }
  ok(
    msg === "reached unreachable code",
    `unreachable() message: ${JSON.stringify(msg)}`,
  );
  let passed = null;
  const sentinel = new Error("mine");
  try {
    expect.unreachable(sentinel);
  } catch (e) {
    passed = e;
  }
  ok(passed === sentinel, "unreachable(Error) rethrows that error, not a copy");
}
{
  // Real Bun 1.3 throws "Not implemented" here, so this matches rather than
  // accepting a serializer it would then ignore.
  let msg = null;
  try {
    expect.addSnapshotSerializer({ test: () => false, print: () => "" });
  } catch (e) {
    msg = e.message;
  }
  ok(
    msg === "Not implemented",
    `addSnapshotSerializer: ${JSON.stringify(msg)} (Bun says the same)`,
  );
}
{
  ok(
    typeof expect.resolvesTo === "object" && expect.resolvesTo !== null,
    "expect.resolvesTo is an object, as in Bun",
  );
  let msg = null;
  try {
    expect.resolvesTo.stringContaining("a");
  } catch (e) {
    msg = e.message;
  }
  ok(
    !!msg && msg.includes("await expect(promise).resolves"),
    "…and using it points at the awaited form instead",
  );
}

console.log("");
if (failures) {
  console.log("FAIL: " + failures + " check(s) failed");
  process.exit(1);
}
console.log("PASS: the matcher table matches the binary's");
