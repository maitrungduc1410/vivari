// Spike (NETWORK): prove how much of `jsonwebtoken` runs in-VM. It is pure JS
// (jws/jwa/ms/lodash.*/semver — no native binding), so support hinges on crypto
// coverage. Empirical findings (this spike proves them):
//   - The HMAC PRIMITIVE works: `jws@4` HS256/384/512 sign+verify round-trip
//     through crypto.createHmac (Wasm-backed; verify uses buffer-equal-constant-
//     time, not timingSafeEqual). So a lib that feeds a raw string/Buffer secret to
//     createHmac is fine.
//   - `jsonwebtoken@9` HS256/384/512 now WORKS. Its sign()/verify() destructure
//     crypto.{KeyObject,createSecretKey,createPrivateKey,createPublicKey}, run
//     `secret instanceof KeyObject`, convert raw secrets via createSecretKey()
//     (after createPrivate/PublicKey throw), require `key.type === 'secret'`, then
//     feed the KeyObject to crypto.createHmac. Our symmetric-only KeyObject shim
//     (packages/runtime/node/lib/crypto.js) satisfies all of that. jwa also gates
//     KeyObject support on `typeof crypto.createPublicKey === 'function'`, which our
//     (throwing) stub satisfies.
//   - RS256/384/512 + PS256/384/512 + ES256/384 + EdDSA now WORK (crypto S3):
//     createSign/createVerify + RSA/EC/Ed25519 are Wasm-backed, and
//     createPrivateKey/createPublicKey return real asymmetric KeyObjects, so
//     jsonwebtoken's asymmetric path round-trips. This spike proves RS256 + PS256.
// Run (Node 22+, with the crypto Wasm built — `npm run build:crypto:node`):
//   node scripts/spike-jwt.mjs

import crypto from "node:crypto";
import { bootSpikeKernel, writeProject, defaultEnv, npmInstall } from "./lib/spike-harness.mjs";

const DIR = "/app";

// A throwaway RSA keypair generated on the HOST — fed to jwt.sign/verify in-VM to
// prove the RS256/PS256 asymmetric path round-trips (private is PKCS#1 to also
// exercise our PKCS#1 parsing). Never leaves this process.
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
});

const h = await bootSpikeKernel();

writeProject(h.kernel, DIR, {
  "package.json": `{
  "name": "jwt-spike",
  "private": true,
  "version": "0.0.0",
  "dependencies": {
    "jsonwebtoken": "^9.0.2",
    "jws": "^4.0.0"
  }
}
`,
  "test.js": `const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const jws = require('jws');
const assert = require('assert');
const RSA_PRIVATE_KEY = ${JSON.stringify(privateKey)};
const RSA_PUBLIC_KEY = ${JSON.stringify(publicKey)};

const results = [];
const check = (name, fn) => {
  try { fn(); results.push('PASS ' + name); }
  catch (e) { results.push('FAIL ' + name + ': ' + ((e && e.message) || e)); }
};

// Probe the crypto surface jsonwebtoken@9 depends on for key material.
console.log('crypto.createHmac      = ' + typeof crypto.createHmac);
console.log('crypto.KeyObject       = ' + typeof crypto.KeyObject);
console.log('crypto.createSecretKey = ' + typeof crypto.createSecretKey);
console.log('crypto.createPrivateKey= ' + typeof crypto.createPrivateKey);
console.log('crypto.createSign      = ' + typeof crypto.createSign);

// --- Low level: does the HMAC primitive work through jws directly? ---------
// jws takes a raw string/Buffer secret and calls crypto.createHmac — it does NOT
// use KeyObject. This isolates "is HMAC-SHA* usable" from jsonwebtoken's wrapper.
check('jws-HS256', () => {
  const sig = jws.sign({ header: { alg: 'HS256' }, payload: { sub: '1' }, secret: 'shhhh' });
  assert.ok(jws.verify(sig, 'HS256', 'shhhh'), 'jws HS256 verify');
  assert.ok(!jws.verify(sig, 'HS256', 'wrong'), 'jws HS256 wrong secret must fail');
  assert.strictEqual(JSON.parse(jws.decode(sig).payload).sub, '1');
});
check('jws-HS384', () => {
  const sig = jws.sign({ header: { alg: 'HS384' }, payload: 'x', secret: 's' });
  assert.ok(jws.verify(sig, 'HS384', 's'));
});
check('jws-HS512', () => {
  const sig = jws.sign({ header: { alg: 'HS512' }, payload: 'x', secret: 's' });
  assert.ok(jws.verify(sig, 'HS512', 's'));
});

// --- High level: jsonwebtoken@9 HS* (uses crypto.KeyObject/createSecretKey) ----
// Exercises the full sign()->verify() round-trip for every HMAC variant, a
// wrong-secret rejection, an expiry rejection, and a KeyObject-as-secret input
// (createSecretKey passed straight to jwt.sign, i.e. the instanceof KeyObject
// fast-path). All must pass now that the symmetric KeyObject shim exists.
for (const alg of ['HS256', 'HS384', 'HS512']) {
  check('jwt-' + alg, () => {
    const token = jwt.sign({ sub: '1234', role: 'admin' }, 'shhhh', { algorithm: alg, expiresIn: '1h' });
    const decoded = jwt.verify(token, 'shhhh', { algorithms: [alg] });
    assert.strictEqual(decoded.sub, '1234');
    assert.strictEqual(decoded.role, 'admin');
    assert.ok(typeof decoded.exp === 'number' && decoded.exp > decoded.iat);
    assert.throws(() => jwt.verify(token, 'wrong-secret', { algorithms: [alg] }), /invalid signature/);
  });
}
check('jwt-HS256-expired', () => {
  const token = jwt.sign({ sub: 'x' }, 'shhhh', { algorithm: 'HS256', expiresIn: -10 });
  assert.throws(() => jwt.verify(token, 'shhhh'), /jwt expired/);
});
check('jwt-HS256-KeyObject-secret', () => {
  const key = crypto.createSecretKey(Buffer.from('shhhh'));
  assert.ok(key instanceof crypto.KeyObject && key.type === 'secret');
  const token = jwt.sign({ sub: 'ko' }, key, { algorithm: 'HS256' });
  const decoded = jwt.verify(token, key, { algorithms: ['HS256'] });
  assert.strictEqual(decoded.sub, 'ko');
});

// RS256 + PS256 (asymmetric) — now supported (crypto S3 phase 2): full round-trip.
check('jwt-RS256', () => {
  const t = jwt.sign({ a: 1 }, RSA_PRIVATE_KEY, { algorithm: 'RS256' });
  assert.strictEqual(jwt.verify(t, RSA_PUBLIC_KEY, { algorithms: ['RS256'] }).a, 1);
});
check('jwt-PS256', () => {
  const t = jwt.sign({ a: 2 }, RSA_PRIVATE_KEY, { algorithm: 'PS256' });
  assert.strictEqual(jwt.verify(t, RSA_PUBLIC_KEY, { algorithms: ['PS256'] }).a, 2);
});

console.log(results.join('\\n'));
const jwsHsOk = ['jws-HS256', 'jws-HS384', 'jws-HS512'].every((n) => results.includes('PASS ' + n));
const jwtHsOk =
  ['jwt-HS256', 'jwt-HS384', 'jwt-HS512', 'jwt-HS256-expired', 'jwt-HS256-KeyObject-secret'].every(
    (n) => results.includes('PASS ' + n),
  );
const rsOk = ['jwt-RS256', 'jwt-PS256'].every((n) => results.includes('PASS ' + n));
console.log('JWS_HMAC_OK=' + jwsHsOk);
console.log('JWT9_HS_OK=' + jwtHsOk);
console.log('JWT_RS_OK=' + rsOk);
`,
});

console.log("\n== [jwt] npm install ==");
const inst = await npmInstall(h, { dir: DIR });
if (inst.code !== 0) {
  console.log("RESULT: FAIL — npm install jsonwebtoken failed");
  process.exit(1);
}
const installed = h.kernel.exists(DIR + "/node_modules/jsonwebtoken/package.json");
console.log("  jsonwebtoken installed: " + installed);

console.log("\n== [jwt] run in-VM sign/verify ==");
const run = await h.kernel.start("node", ["test.js"], { cwd: DIR, env: defaultEnv(DIR), capture: true });
const stdout = (run.stdout || "").trim();
console.log(stdout);
if (run.stderr && run.stderr.trim()) console.log("stderr:\n" + run.stderr.trim());
console.log(`  (exit ${run.code})`);

const jwsHmacOk = /JWS_HMAC_OK=true/.test(stdout);
const jwt9HsOk = /JWT9_HS_OK=true/.test(stdout);
const rsOk = /JWT_RS_OK=true/.test(stdout);

// jsonwebtoken@9 HS* + the asymmetric RS256/PS256 path must now round-trip end-to-end.
const ok = installed && run.code === 0 && jwsHmacOk && jwt9HsOk && rsOk;

console.log("\n---- capability summary ----");
console.log("  HMAC primitive (jws HS256/384/512): " + (jwsHmacOk ? "WORKS" : "BROKEN"));
console.log("  jsonwebtoken@9 HS256/384/512 (KeyObject path): " + (jwt9HsOk ? "WORKS" : "BROKEN"));
console.log("  Asymmetric RS256/PS256 (createSign): " + (rsOk ? "WORKS" : "BROKEN"));
console.log(
  "\nRESULT: " +
    (ok
      ? "PASS — jsonwebtoken@9 HS256/384/512 + RS256/PS256 sign+verify work " +
        "(symmetric KeyObject shim + crypto S3 RSA)"
      : "FAIL — see logs above"),
);
process.exit(ok ? 0 : 1);
