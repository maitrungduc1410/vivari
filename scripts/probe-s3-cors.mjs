// Probe: does a SigV4-signed S3 request survive the BROWSER's egress path?
//
// scripts/spike-*.mjs run headless, where the fetcher forwards every header. The
// browser Fetcher Worker does not: packages/core/src/workers/fetcher-worker.ts
// keeps only the four CORS-safelisted request headers, so `authorization` and
// every `x-amz-*` are dropped before the request leaves the tab. A probe that
// only runs headless therefore cannot see the difference.
//
// The experiment needs no credentials. Sign with a bogus key against a PUBLIC
// bucket and read the answer AWS gives back:
//   header survives -> AWS parses Authorization, rejects the key: InvalidAccessKeyId
//   header stripped -> the request is anonymous, the bucket is public: HTTP 200
//
// Run: node scripts/probe-s3-cors.mjs   (needs the Wasm VFS built)

import { bootSpikeKernel, writeProject, defaultEnv, npmInstall } from "./lib/spike-harness.mjs";

const DIR = "/app";
const BUCKET = "noaa-goes16";

// The browser's policy, copied from fetcher-worker.ts so the two cannot drift
// apart silently within this probe.
const CORS_SAFELISTED = new Set(["accept", "accept-language", "content-language", "content-type"]);
const SAFE_CONTENT_TYPES = new Set(["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"]);
function corsSafeHeaders(headers) {
  if (!headers) return undefined;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = String(k).toLowerCase();
    if (!CORS_SAFELISTED.has(lk)) continue;
    if (lk === "content-type" && !SAFE_CONTENT_TYPES.has(String(v).split(";")[0].trim().toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

const BROWSER = process.env.VV_BROWSER_HEADERS === "1";

const h = await bootSpikeKernel();

if (BROWSER) {
  const inner = h.kernel.fetcher;
  h.kernel.fetcher = (url, init) =>
    inner(url, init ? { ...init, headers: corsSafeHeaders(init.headers) } : init);
}

writeProject(h.kernel, DIR, {
  "package.json": `{
  "name": "s3-cors-probe",
  "private": true,
  "version": "0.0.0",
  "dependencies": { "@aws-sdk/client-s3": "^3.700.0" }
}
`,
  "test.js": `const { S3Client, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

// Deliberately invalid credentials. Nothing real is used or needed here.
const signed = new S3Client({
  region: 'us-east-1',
  credentials: { accessKeyId: 'AKIAPROBE0000000BOGUS', secretAccessKey: 'not-a-real-secret' },
});

(async () => {
  let key = 'ABI-L1b-RadC-Reproc/2017/351/00/';
  try {
    const anon = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'anonymous', secretAccessKey: 'anonymous' },
      signer: { sign: async (r) => r },
    });
    const l = await anon.send(new ListObjectsV2Command({ Bucket: '${BUCKET}', MaxKeys: 1 }));
    key = l.Contents[0].Key;
  } catch (e) { console.log('LIST_ERR=' + e.name); }

  try {
    const r = await signed.send(new GetObjectCommand({ Bucket: '${BUCKET}', Key: key, Range: 'bytes=0-9' }));
    const n = (await r.Body.transformToByteArray()).length;
    console.log('OUTCOME=SUCCEEDED_ANONYMOUSLY bytes=' + n);
  } catch (e) {
    console.log('OUTCOME=REJECTED name=' + e.name);
  }
})();
`,
});

const inst = await npmInstall(h, { dir: DIR });
if (inst.code !== 0) { console.log("RESULT: FAIL — install"); process.exit(1); }

const run = await h.kernel.start("node", ["test.js"], { cwd: DIR, env: defaultEnv(DIR), capture: true });
const stdout = (run.stdout || "").trim();
console.log(`\n---- egress: ${BROWSER ? "BROWSER header policy" : "headless (full headers)"} ----`);
console.log(stdout);

const anonymised = /OUTCOME=SUCCEEDED_ANONYMOUSLY/.test(stdout);
const rejected = /OUTCOME=REJECTED name=InvalidAccessKeyId/.test(stdout);
console.log(
  "\nVERDICT: " +
    (rejected
      ? "the Authorization header REACHED AWS (SigV4 is usable on this path)"
      : anonymised
        ? "the Authorization header was DROPPED — the request went out anonymous"
        : "inconclusive, see output"),
);
process.exit(0);