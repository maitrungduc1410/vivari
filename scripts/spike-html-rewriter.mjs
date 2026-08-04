// HTMLRewriter, checked against real Bun's answers rather than against itself.
//
//   node scripts/spike-html-rewriter.mjs
//
// Every expectation in this spike is a string that bun-1.3.14 printed
// (scripts/fixtures/html-rewriter-bun.json, regenerable — see
// scripts/lib/html-rewriter-cases.mjs). That matters more here than almost
// anywhere else in the runtime: an HTML rewriter that is merely SELF-consistent
// is the easiest thing in the world to write and the hardest to trust, because
// its output always looks like plausible HTML. The interesting question is never
// "did it produce HTML" but "did it produce the same bytes Bun would", down to
// the quoting of an attribute nobody touched.
//
// The corpus is hand-written cases plus a deterministic fuzz cross-product
// (documents × rewrite recipes). The fuzz half earned its place immediately: it
// found that a `<td>` at the top level of a document still has a sibling
// position, so `td:first-of-type` matched it in Bun and not here. Every
// hand-written case had its elements nested inside something.

import { readFileSync } from "node:fs";
import { createHTMLRewriter } from "../packages/runtime/builtins/bun-html-rewriter.js";
import {
  CASES, OBSERVE, BAD_SELECTORS,
  PAGE_CASES, PAGE_OBSERVE, MORE_BAD_SELECTORS,
  RECIPES, rng, makeDoc, FUZZ_SEEDS,
} from "./lib/html-rewriter-cases.mjs";
import { collect } from "./lib/html-rewriter-collect.mjs";

let failed = 0;
const ok = (cond, label) => {
  if (!cond) failed++;
  console.log(`  ${cond ? "\u2713" : "\u2717"} ${label}`);
};

const fixture = JSON.parse(readFileSync(new URL("./fixtures/html-rewriter-bun.json", import.meta.url), "utf8"));
const HTMLRewriter = createHTMLRewriter();
const ours = await collect(HTMLRewriter, {
  CASES, OBSERVE, BAD_SELECTORS, PAGE_CASES, PAGE_OBSERVE, MORE_BAD_SELECTORS, RECIPES, rng, makeDoc, FUZZ_SEEDS,
});

console.log(`== HTMLRewriter vs ${fixture.recordedFrom} ==`);
{
  const expected = fixture.results;
  const keys = Object.keys(expected).filter((k) => k !== "FUZZ");
  const mismatched = keys.filter((k) => JSON.stringify(expected[k]) !== JSON.stringify(ours[k]));
  for (const key of mismatched.slice(0, 8)) {
    console.log(`    ${key}\n      bun : ${JSON.stringify(expected[key]).slice(0, 200)}\n      ours: ${JSON.stringify(ours[key]).slice(0, 200)}`);
  }
  ok(mismatched.length === 0, `${keys.length - mismatched.length}/${keys.length} recorded answers reproduced byte for byte`);

  const fuzzExpected = expected.FUZZ;
  const fuzzMismatch = fuzzExpected.filter((v, i) => v !== ours.FUZZ[i]);
  for (let i = 0; i < fuzzExpected.length && fuzzMismatch.length; i++) {
    if (fuzzExpected[i] !== ours.FUZZ[i]) {
      console.log(`    fuzz #${i}\n      bun : ${JSON.stringify(fuzzExpected[i]).slice(0, 200)}\n      ours: ${JSON.stringify(ours.FUZZ[i]).slice(0, 200)}`);
      break;
    }
  }
  ok(fuzzMismatch.length === 0, `${fuzzExpected.length - fuzzMismatch.length}/${fuzzExpected.length} fuzz outputs identical (${FUZZ_SEEDS} documents \u00d7 ${RECIPES.length} recipes)`);
}

// The properties worth stating in their own right, because a reviewer should not
// have to diff a 120 KB fixture to learn what the thing guarantees.
console.log("\n== the guarantees behind the fixture ==");
{
  const untouched = "<P CLASS='a'   data-x=1 >hi</P >\n<!-- keep -->\n<img src=x >";
  ok(new HTMLRewriter().on("nothing", {}).transform(untouched) === untouched,
    "a document nobody rewrote comes back byte for byte — odd quoting, spacing and all");
  ok(new HTMLRewriter().on("p", { element(e) { e.setAttribute("z", "1"); } }).transform("<P A='1'   B=2>x</P >") === `<P A='1' B=2 z="1">x</P >`,
    "…and a document someone DID rewrite keeps the other attributes' original spelling");

  let threw = "";
  try { new HTMLRewriter().on("p:hover", {}); } catch (e) { threw = e.message; }
  ok(threw === "Unsupported pseudo-class or pseudo-element in selector.",
    "an unsupported selector throws at .on(), rather than matching nothing forever");

  // The one behaviour that is deliberately stricter than Bun.
  let asyncErr = "";
  try {
    new HTMLRewriter().on("p", { async element(e) { await Promise.resolve(); e.setAttribute("a", "1"); } }).transform("<p>x</p>");
  } catch (e) { asyncErr = e.message; }
  ok(asyncErr.includes("async handler") && asyncErr.includes("Response"),
    "an async handler on the string path is refused, naming the Response workaround");
  const res = await new HTMLRewriter()
    .on("p", { async element(e) { await new Promise((r) => setTimeout(r, 1)); e.setAttribute("a", "1"); } })
    .transform(new Response("<p>x</p>"))
    .text();
  ok(res === '<p a="1">x</p>', "…and awaited properly on the Response path, which is the workaround");

  // Chunk boundaries are observable, so they are part of the contract: Bun's
  // streaming tokenizer breaks a script body at every `<` it has to consider and
  // reject, and a handler that inspects `t.text` sees exactly that.
  const chunks = [];
  new HTMLRewriter().on("script", { text(t) { chunks.push(t.text); } }).transform(`<script>var a = "<p>x</p>";</script>`);
  ok(JSON.stringify(chunks) === JSON.stringify(["var a = \"", "<", "p>x", "</p", ">\";", ""]),
    "a script body arrives in the same chunks Bun's streaming tokenizer produces, not as one blob");
}

console.log(failed ? `\nFAIL: ${failed} check(s) failed` : "\nOK: HTMLRewriter matches the recorded Bun behaviour");
process.exit(failed ? 1 : 0);
