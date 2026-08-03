// Spike (NETWORK): prove the S3 backend template actually drives S3 in-VM.
//
// It needs no AWS account. An S3-shaped server runs beside the app in the same
// VM and the app is pointed at it through its own "Endpoint" field (the MinIO
// path), so every gate exercises the real SDK: real SigV4 signing, a real
// multipart upload, real XML responses.
//
// The mock RECOMPUTES the signature and rejects a mismatch, which is what makes
// the upload gates mean something — a 200 says our createHmac/createHash produced
// the exact bytes AWS would have, not merely that a request arrived.
//
// Not gated here, and it cannot be: whether the browser lets the request out at
// all. That is CORS, the host has none, and it is why the template ships the
// bucket policy on its own page. See scripts/probe-egress-headers.mjs.
//
// Gates: install · connect · upload · list · download (bytes match) · multipart
//        (12 MB, >1 part) · presign · delete · a wrong secret is rejected.
//
// Run (Node 22+, Wasm VFS built): node scripts/spike-s3.mjs

import { bootSpikeKernel, writeProject, defaultEnv, npmInstall, waitListen, httpGet } from "./lib/spike-harness.mjs";
import { s3AppFiles } from "../packages/studio/src/vv/s3-app-source.js";

const DIR = "/app";
const APP_PORT = Number(process.env.VV_PORT || 3000);
const S3_PORT = 5399;
const SECRET = "spike-secret-key-not-real";
const ACCESS_KEY = "AKIASPIKESPIKESPIKE";

const h = await bootSpikeKernel();

writeProject(h.kernel, DIR, {
  ...s3AppFiles(),

  // An S3-shaped endpoint with a real SigV4 verifier. Kept in the spike rather
  // than the template: it exists to test the app, not to ship with it.
  "mock-s3.js": `const http = require('http');
const crypto = require('crypto');
const objects = new Map();
const parts = new Map();
const SECRET = ${JSON.stringify(SECRET)};
const pathOf = (u) => u.split('?')[0];
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d, 'utf8').digest();
const sha256hex = (d) => crypto.createHash('sha256').update(d, 'utf8').digest('hex');

function verify(req) {
  const auth = req.headers['authorization'] || '';
  const m = /^AWS4-HMAC-SHA256 Credential=([^,]+), *SignedHeaders=([^,]+), *Signature=([0-9a-f]+)$/.exec(auth);
  if (!m) return 'no AWS4-HMAC-SHA256 Authorization header';
  const [, credential, signedHeaders, theirs] = m;
  const [, date, region, service, term] = credential.split('/');
  const [rawPath, rawQuery = ''] = req.url.split('?');
  const canonicalQuery = rawQuery.split('&').filter(Boolean).map((p) => p.split('='))
    .map(([k, v = '']) => [encodeURIComponent(decodeURIComponent(k)), encodeURIComponent(decodeURIComponent(v))])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => k + '=' + v).join('&');
  const canonicalHeaders = signedHeaders.split(';')
    .map((n) => n + ':' + String(req.headers[n] || '').trim() + '\\n').join('');
  const canonicalRequest = [req.method, rawPath, canonicalQuery, canonicalHeaders, signedHeaders,
    req.headers['x-amz-content-sha256']].join('\\n');
  const scope = [date, region, service, term].join('/');
  const stringToSign = ['AWS4-HMAC-SHA256', req.headers['x-amz-date'], scope, sha256hex(canonicalRequest)].join('\\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + SECRET, date), region), service), term);
  const ours = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');
  return ours === theirs ? null : 'signature mismatch';
}

const xml = (res, body, code) => {
  res.writeHead(code || 200, { 'Content-Type': 'application/xml' });
  res.end('<?xml version="1.0" encoding="UTF-8"?>' + body);
};

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const bad = verify(req);
    if (bad) return xml(res, '<Error><Code>SignatureDoesNotMatch</Code><Message>' + bad + '</Message></Error>', 403);

    const q = new URLSearchParams(req.url.split('?')[1] || '');
    const p = pathOf(req.url);
    const bucketRoot = p.split('/').filter(Boolean).length === 1;
    const key = p.split('/').slice(2).join('/');

    if (req.method === 'HEAD' && bucketRoot) { res.writeHead(200); return res.end(); }

    if (req.method === 'GET' && bucketRoot && (q.get('list-type') === '2' || q.has('prefix') || true)) {
      const prefix = q.get('prefix') || '';
      const items = [...objects.entries()].filter(([k]) => k.startsWith(prefix));
      return xml(res, '<ListBucketResult><Name>spike-bucket</Name><IsTruncated>false</IsTruncated>' +
        items.map(([k, v]) =>
          '<Contents><Key>' + k + '</Key><Size>' + v.length +
          '</Size><LastModified>2026-08-02T00:00:00.000Z</LastModified></Contents>').join('') +
        '</ListBucketResult>');
    }
    if (req.method === 'POST' && q.has('uploads')) {
      const id = 'u' + Math.random().toString(36).slice(2, 10);
      parts.set(id, []);
      return xml(res, '<InitiateMultipartUploadResult><Bucket>spike-bucket</Bucket><Key>' + key +
        '</Key><UploadId>' + id + '</UploadId></InitiateMultipartUploadResult>');
    }
    if (req.method === 'PUT' && q.has('partNumber')) {
      (parts.get(q.get('uploadId')) || []).push([Number(q.get('partNumber')), body]);
      res.writeHead(200, { ETag: '"p' + q.get('partNumber') + '"' });
      return res.end();
    }
    if (req.method === 'POST' && q.has('uploadId')) {
      const list = (parts.get(q.get('uploadId')) || []).sort((a, b) => a[0] - b[0]);
      objects.set(key, Buffer.concat(list.map(([, b]) => b)));
      return xml(res, '<CompleteMultipartUploadResult><Bucket>spike-bucket</Bucket><Key>' + key +
        '</Key><ETag>"joined"</ETag></CompleteMultipartUploadResult>');
    }
    if (req.method === 'PUT') { objects.set(key, body); res.writeHead(200, { ETag: '"e"' }); return res.end(); }
    if (req.method === 'GET') {
      const v = objects.get(key);
      if (!v) return xml(res, '<Error><Code>NoSuchKey</Code></Error>', 404);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(v.length) });
      return res.end(v);
    }
    if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
    res.writeHead(405); res.end();
  });
}).listen(${S3_PORT}, () => console.log('mock-s3 on ${S3_PORT}'));
`,
});

console.log("\n== [s3] npm install ==");
const inst = await npmInstall(h, { dir: DIR });
if (inst.code !== 0) {
  console.log((inst.stderr || "").slice(-2000));
  console.log("RESULT: FAIL — install");
  process.exit(1);
}
const installed = h.kernel.exists(DIR + "/node_modules/@aws-sdk/client-s3/package.json");
console.log("  @aws-sdk/client-s3 installed: " + installed);
if (process.env.VV_INSTALL_ONLY === "1") process.exit(installed ? 0 : 1);

console.log("\n== [s3] start the S3-shaped endpoint ==");
h.kernel.start("node", ["mock-s3.js"], { cwd: DIR, env: defaultEnv(DIR), capture: true });
await new Promise((r) => setTimeout(r, 1200));

console.log("\n== [s3] boot the app ==");
const bound = await waitListen(h, { dir: DIR, port: APP_PORT, argv: ["src/server.js"] });
console.log("  app listening on " + APP_PORT + ": " + bound);

// The app's own HTTP API, driven exactly as the page drives it.
async function call(method, url, body, headers = {}) {
  const payload = body === undefined ? "" : typeof body === "string" ? body : Buffer.from(body);
  const res = await h.kernel.handleHttpRequest(APP_PORT, {
    port: APP_PORT,
    method,
    url,
    headers: { host: "127.0.0.1:" + APP_PORT, "content-length": String(Buffer.byteLength(payload)), ...headers },
    body: payload,
  });
  const text = typeof res.body === "string" ? res.body : Buffer.from(res.body || "").toString();
  let json = null;
  try { json = JSON.parse(text); } catch { /* a download, not JSON */ }
  return { status: res.status, body: text, json };
}

const json = (o) => [JSON.stringify(o), { "content-type": "application/json" }];

const results = {};
const gate = (name, ok, extra = "") => {
  results[name] = ok;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`);
};

if (bound) {
  console.log("\n== [s3] drive the app's API ==");

  const [cbody, chead] = json({
    accessKeyId: ACCESS_KEY, secretAccessKey: SECRET,
    region: "us-east-1", bucket: "spike-bucket", endpoint: `http://127.0.0.1:${S3_PORT}`,
  });
  const conn = await call("POST", "/api/session", cbody, chead);
  gate("connect", conn.status === 200 && conn.json?.connected === true, JSON.stringify(conn.json?.session || conn.json));

  const secretLeaked = JSON.stringify(conn.json || {}).includes(SECRET);
  gate("secret never returned to the page", !secretLeaked);

  // Providers publish a bare host — DigitalOcean Spaces documents
  // 'sgp1.digitaloceanspaces.com' — and that is what gets pasted in. Without a
  // scheme the SDK fails on URL parsing, which tells the user nothing.
  const [nbody, nhead] = json({
    accessKeyId: ACCESS_KEY, secretAccessKey: SECRET,
    region: "us-east-1", bucket: "spike-bucket", endpoint: `127.0.0.1:${S3_PORT}`,
  });
  const noScheme = await call("POST", "/api/session", nbody, nhead);
  gate("an endpoint pasted without https:// still connects",
    noScheme.status === 200 && noScheme.json?.connected === true,
    noScheme.json?.session?.endpoint || `status=${noScheme.status}`);

  const payload = Buffer.from("hello from the sandbox\n".repeat(16));
  const put = await call("PUT", "/api/objects?key=note.txt", payload, { "content-type": "text/plain" });
  gate("upload", put.status === 200 && put.json?.key === "note.txt", `${put.json?.size} bytes`);

  const list = await call("GET", "/api/objects");
  gate("list", list.status === 200 && (list.json?.objects || []).some((o) => o.key === "note.txt"));

  const down = await call("GET", "/api/objects/download?key=note.txt");
  gate("download round-trips the bytes", down.status === 200 && down.body === payload.toString());

  // No content-type: express.raw does not claim the request, so the app must say
  // so plainly rather than handing the page an SDK error about the Body type.
  const noType = await call("PUT", "/api/objects?key=untyped.bin", Buffer.from("bytes"));
  gate("upload without a content-type is refused clearly",
    noType.status === 400 && noType.json?.error === "MissingBody", noType.json?.error || `status=${noType.status}`);

  const big = Buffer.alloc(12 * 1024 * 1024, "v");
  const mp = await call("PUT", "/api/objects?key=big.bin", big, { "content-type": "application/octet-stream" });
  gate("multipart upload (12 MB)", mp.status === 200 && mp.json?.multipart === true, `${mp.json?.size ?? "?"} bytes`);

  const mpList = await call("GET", "/api/objects?prefix=big");
  const bigEntry = (mpList.json?.objects || []).find((o) => o.key === "big.bin");
  gate("multipart reassembled server-side", bigEntry?.size === 12 * 1024 * 1024, `${bigEntry?.size} bytes`);

  const [pbody, phead] = json({ key: "note.txt", expiresIn: 900 });
  const pre = await call("POST", "/api/presign", pbody, phead);
  gate("presign", pre.status === 200 && /X-Amz-Signature=[0-9a-f]{64}/.test(pre.json?.url || ""));

  const del = await call("DELETE", "/api/objects?key=note.txt");
  const after = await call("GET", "/api/objects");
  gate("delete", del.status === 200 && !(after.json?.objects || []).some((o) => o.key === "note.txt"));

  // Negative control: the signature gate must be able to fail. Reconnect with the
  // wrong secret and the mock's verifier should reject it.
  const [wbody, whead] = json({
    accessKeyId: ACCESS_KEY, secretAccessKey: "wrong-secret",
    region: "us-east-1", bucket: "spike-bucket", endpoint: `http://127.0.0.1:${S3_PORT}`,
  });
  const wrong = await call("POST", "/api/session", wbody, whead);
  gate("a wrong secret is rejected", wrong.status === 400 && /SignatureDoesNotMatch/.test(JSON.stringify(wrong.json)), wrong.json?.error || `status=${wrong.status}`);

  const page = await httpGet(h.kernel, APP_PORT, "/");
  gate("page serves", page.status === 200 && /S3 Explorer/.test(page.body) && /AllowedOrigins/.test(page.body));
}

const ok = installed && bound && Object.values(results).every(Boolean);
console.log(
  "\nRESULT: " +
    (ok
      ? "PASS — the S3 template signs, uploads (incl. multipart), lists, downloads, presigns and deletes in-VM"
      : "FAIL — see logs above"),
);
process.exit(ok ? 0 : 1);