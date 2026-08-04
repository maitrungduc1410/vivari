// Records real Bun's HTMLRewriter output for the shared corpus. Run with a real
// `bun` binary (see scripts/lib/html-rewriter-cases.mjs for the how and why);
// running it under Node records Vivari's own answers, which would defeat the
// entire point of the fixture.
import { CASES, OBSERVE, BAD_SELECTORS, PAGE_CASES, PAGE_OBSERVE, MORE_BAD_SELECTORS, RECIPES, rng, makeDoc, FUZZ_SEEDS } from "./lib/html-rewriter-cases.mjs";
import { collect } from "./lib/html-rewriter-collect.mjs";

const version = typeof Bun !== "undefined" ? Bun.version : "NOT-BUN-" + process.version;
console.log(JSON.stringify({ recordedFrom: "bun " + version, results: await collect(globalThis.HTMLRewriter, { CASES, OBSERVE, BAD_SELECTORS, PAGE_CASES, PAGE_OBSERVE, MORE_BAD_SELECTORS, RECIPES, rng, makeDoc, FUZZ_SEEDS }) }, null, 1));
