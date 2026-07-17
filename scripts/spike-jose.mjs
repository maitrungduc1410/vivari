// Spike (NETWORK) — the phase-3 driver: `jose` importX509. jose's Node runtime
// implements importX509 via `crypto.createPublicKey(certPem)` (Node extracts the
// SPKI from an X.509 CERTIFICATE), which our phase-3 X.509 support now handles.
// This proves the feature drives a real library end-to-end: sign a JWT with the
// cert's private key, import the PUBLIC key straight from the certificate, and
// verify the JWT with it (RS256 + ES256).
//
// Uses the committed test certs in scripts/fixtures/x509/ (throwaway keys).
// Manual (like scripts/spike-jwt.mjs) — needs the live registry + the crypto Wasm
// (`npm run build:crypto:node`); NOT wired into the offline gate in run-spikes.mjs.
//
// Run: npm run build:crypto:node && node scripts/spike-jose.mjs

import { readFileSync } from "node:fs";
import { bootSpikeKernel, writeProject, defaultEnv, npmInstall } from "./lib/spike-harness.mjs";

const DIR = "/app";
const fx = (f) => readFileSync(new URL(`./fixtures/x509/${f}`, import.meta.url), "utf8");
const RSA_CERT = fx("rsa-cert.pem");
const RSA_PRIV = fx("rsa-key.pem"); // PKCS#8 (openssl req -newkey ... -nodes)
const EC_CERT = fx("ec-cert.pem");
const EC_PRIV = fx("ec-key-pkcs8.pem"); // PKCS#8 (jose.importPKCS8 requires PKCS#8)

const h = await bootSpikeKernel();

writeProject(h.kernel, DIR, {
  "package.json": `{
  "name": "jose-spike",
  "private": true,
  "version": "0.0.0",
  "dependencies": { "jose": "^5" }
}
`,
  "test.js": `const assert = require('assert');
const jose = require('jose');
const CERTS = {
  RS256: { cert: ${JSON.stringify(RSA_CERT)}, priv: ${JSON.stringify(RSA_PRIV)} },
  ES256: { cert: ${JSON.stringify(EC_CERT)}, priv: ${JSON.stringify(EC_PRIV)} },
};

(async () => {
  const results = [];
  const check = async (name, fn) => {
    try { await fn(); results.push('PASS ' + name); }
    catch (e) { results.push('FAIL ' + name + ': ' + ((e && e.message) || e)); }
  };

  for (const alg of ['RS256', 'ES256']) {
    await check('jose importX509 ' + alg, async () => {
      const { cert, priv } = CERTS[alg];
      const privateKey = await jose.importPKCS8(priv, alg);
      const jwt = await new jose.SignJWT({ sub: 'alice', role: 'admin' })
        .setProtectedHeader({ alg })
        .setIssuedAt()
        .setExpirationTime('1h')
        .sign(privateKey);
      // The public key comes straight from the X.509 certificate.
      const publicKey = await jose.importX509(cert, alg);
      const { payload } = await jose.jwtVerify(jwt, publicKey);
      assert.strictEqual(payload.sub, 'alice');
      assert.strictEqual(payload.role, 'admin');
      // A tampered token must be rejected.
      let rejected = false;
      try { await jose.jwtVerify(jwt.slice(0, -3) + 'abc', publicKey); }
      catch { rejected = true; }
      assert.ok(rejected, 'tampered token must be rejected');
    });
  }

  console.log(results.join('\\n'));
  console.log('JOSE_OK=' + results.every((r) => r.startsWith('PASS')));
})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });
`,
});

const priv = RSA_PRIV.includes("BEGIN PRIVATE KEY");
console.log(`  rsa-key.pem is PKCS#8: ${priv}` + (priv ? "" : " (WARN: jose.importPKCS8 expects PKCS#8)"));

console.log("\n== [jose] npm install ==");
const inst = await npmInstall(h, { dir: DIR });
if (inst.code !== 0) {
  console.log("RESULT: FAIL — npm install jose failed");
  process.exit(1);
}

console.log("\n== [jose] importX509 + verify in-VM ==");
const run = await h.kernel.start("node", ["test.js"], { cwd: DIR, env: defaultEnv(DIR), capture: true });
const stdout = (run.stdout || "").trim();
console.log(stdout);
if (run.stderr && run.stderr.trim()) console.log("stderr:\n" + run.stderr.trim());
console.log(`  (exit ${run.code})`);

const ok = run.code === 0 && /JOSE_OK=true/.test(stdout);
console.log(
  "\nRESULT: " +
    (ok
      ? "PASS — jose.importX509 -> jwtVerify works for RS256 + ES256 (X509Certificate.publicKey)"
      : "FAIL — see logs above"),
);
process.exit(ok ? 0 : 1);
