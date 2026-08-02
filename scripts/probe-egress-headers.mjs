// Probe (offline, Wasm-free): the browser egress header policy.
//
// The Fetcher Worker drops non-CORS-safelisted request headers so npm's registry
// GETs stay preflight-free. That strip used to apply to every host, which meant a
// SigV4-signed S3 request lost its `Authorization` and `x-amz-*` headers and went
// out anonymous — succeeding with the wrong bytes instead of failing. No headless
// spike can catch that (Node has no CORS, and the headless fetchers forward every
// header), so the policy is asserted here as pure logic instead.
//
// Run: npm run probe:egress-headers

import {
  stripsCustomHeaders,
  corsSafeHeaders,
  egressHeaders,
} from "../packages/runtime/egress-header-policy.js";

let failed = 0;
const check = (name, actual, expected) => {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}\n          expected ${e}\n          actual   ${a}`);
  }
};

const ORIGIN = "https://studio.example.dev";

console.log("── the registries keep getting stripped (why the policy exists) ──");
for (const u of [
  "https://registry.npmjs.org/left-pad",
  "https://registry.npmjs.org/left-pad/-/left-pad-1.3.0.tgz",
  "https://registry.yarnpkg.com/left-pad",
  "https://registry.npmmirror.com/left-pad",
]) {
  check(`strips ${new URL(u).hostname}`, stripsCustomHeaders(u, ORIGIN), true);
}

console.log("\n── everyone else keeps their headers ──");
for (const u of [
  "https://my-bucket.s3.amazonaws.com/key.txt",
  "https://s3.us-east-1.amazonaws.com/my-bucket/key.txt",
  "https://api.github.com/user",
  "https://example.com/anything",
]) {
  check(`keeps ${new URL(u).hostname}`, stripsCustomHeaders(u, ORIGIN), false);
}

console.log("\n── same-origin is not subject to CORS at all ──");
check("studio origin", stripsCustomHeaders(`${ORIGIN}/preview/3000/api`, ORIGIN), false);
check("relative URL", stripsCustomHeaders("/preview/3000/api", ORIGIN), false);

console.log("\n── the safelist itself ──");
check(
  "drops authorization/range/x-amz-*, keeps accept",
  corsSafeHeaders({
    accept: "application/json",
    authorization: "AWS4-HMAC-SHA256 Credential=…",
    range: "bytes=0-99",
    "x-amz-content-sha256": "abc",
    "x-amz-date": "20260802T000000Z",
  }),
  { accept: "application/json" },
);
check(
  "drops a non-simple content-type",
  corsSafeHeaders({ "content-type": "application/json" }),
  {},
);
check(
  "keeps a simple content-type",
  corsSafeHeaders({ "content-type": "text/plain;charset=UTF-8" }),
  { "content-type": "text/plain;charset=UTF-8" },
);

console.log("\n── end to end: what actually goes on the wire ──");
const signed = {
  authorization: "AWS4-HMAC-SHA256 Credential=AKIA…",
  "x-amz-content-sha256": "e3b0c442",
  "x-amz-date": "20260802T000000Z",
  range: "bytes=0-99",
};
check(
  "a signed S3 request keeps its signature",
  egressHeaders("https://my-bucket.s3.amazonaws.com/key.txt", signed, ORIGIN),
  signed,
);
check(
  "the same headers aimed at the registry are dropped",
  egressHeaders("https://registry.npmjs.org/left-pad", signed, ORIGIN),
  {},
);

console.log(`\nRESULT: ${failed === 0 ? "PASS (0 checks failed)" : `FAIL (${failed} checks failed)`}`);
process.exit(failed === 0 ? 0 : 1);