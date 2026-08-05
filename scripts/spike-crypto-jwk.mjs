// Spike (OFFLINE): HKDF, and keys as JWKs.
//
// WHY THIS EXISTS. Two gaps that a caller met as "this Node is broken", not as
// "this runtime is incomplete":
//
//   • `crypto.hkdfSync is not a function`. HKDF is how a service turns one
//     secret into a key per purpose — jose, @hapi/iron, WebAuthn and most
//     session libraries derive with it — and the error reads like an old Node.
//   • `KeyObject.export({ format: 'jwk' })` threw, and `createPublicKey({ key:
//     jwk, format: 'jwk' })` threw. A JWK is how a key travels: a JWKS endpoint
//     publishes them, and jose's importJWK is the ordinary way a service gets
//     the key it verifies tokens with. Exporting without importing would have
//     been half a capability.
//
// WHAT IS PINNED HERE. The host's real Node runs the same script, and the
// transcripts must match. That matters more than usual for this file: a JWK is
// consumed field by field by whoever receives it, so "close enough" is a key
// that silently fails to verify somewhere else. The HKDF cases include RFC 5869
// A.1 and A.3 verbatim, so the two implementations are pinned to the standard
// and not merely to each other.
//
// Random keys can't be compared byte for byte across the two runs, so the
// generated-key cases assert STRUCTURE (which fields, which lengths, which
// curve names) plus a round trip: export to JWK, import it back, and the DER
// must be identical to the original's.
//
// EXCEPT for RSA widths, which cannot be compared across two different keys at
// all: an RSA private exponent is minimally encoded, so its length is 256 bytes
// for most 2048-bit keys and 255 for the ~1 in 256 whose `d` starts with a zero
// byte. Comparing the host's key to ours therefore disagreed at that rate — a
// real bug (we were fixed-width, Node is minimal) hidden inside a test that would
// have flaked anyway once it was fixed. The width case now uses a FIXED key,
// checked in below, deliberately chosen so that `d` is one of the short ones: both
// sides export the same key, the comparison is exact, and it is exact on the case
// that the trimming bug gets wrong.
//
//   run:  node scripts/spike-crypto-jwk.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { bootSpikeKernel, writeProject } from "./lib/spike-harness.mjs";

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};

const PROBE = `
const c = require('crypto');
const hex = (b) => Buffer.from(b).toString('hex');
const say = (name, fn) => {
  let r;
  try { r = fn(); } catch (e) { r = 'THREW ' + (e.code || '') + ' ' + String(e.message).slice(0, 60); }
  console.log(name + ' ' + r);
};

// ---- HKDF, against RFC 5869's own vectors --------------------------------
say('hkdf-rfc-a1', () => hex(c.hkdfSync('sha256',
  Buffer.from('0b'.repeat(22), 'hex'),
  Buffer.from('000102030405060708090a0b0c', 'hex'),
  Buffer.from('f0f1f2f3f4f5f6f7f8f9', 'hex'), 42)));
// A.3: empty salt and empty info — the case where "no salt" must mean HashLen
// zero bytes, not a zero-length key.
say('hkdf-rfc-a3', () => hex(c.hkdfSync('sha256', Buffer.from('0b'.repeat(22), 'hex'), '', '', 42)));
say('hkdf-sha1', () => hex(c.hkdfSync('sha1', 'key', 'salt', 'info', 20)));
// Longer than one hash block, so the expand loop actually iterates.
say('hkdf-multiblock', () => hex(c.hkdfSync('sha256', 'k', 's', 'i', 100)));
// A zero length is a refusal, not an empty buffer, and the two edges refuse
// differently — checked against the real Node rather than assumed.
say('hkdf-zero-length', () => 'derived ' + hex(c.hkdfSync('sha256', 'k', 's', 'i', 0)));
say('hkdf-returns-arraybuffer', () => String(c.hkdfSync('sha256', 'k', 's', 'i', 8) instanceof ArrayBuffer));
say('hkdf-too-long', () => { c.hkdfSync('sha256', 'k', 's', 'i', 255 * 32 + 1); return 'no throw'; });
say('hkdf-from-keyobject', () =>
  hex(c.hkdfSync('sha256', c.createSecretKey(Buffer.from('secret')), 's', 'i', 16)));

// A fixed 2048-bit RSA key whose private exponent needs 255 bytes, not 256 (its
// top byte is zero). Generated once on the host; the JWK widths below are a
// property of THIS key, so both runs must print the same numbers.
const RSA_FIXED = \`-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC9f7/H0dx3MOkP\nU8xXVPtBSdXkUcnO8f4rksSLrR0lSkjElf/4wzw+9XeM4IFm+l3OD8JBQ3+74xv/\n7v2vCXZDvf3uJ7ZiDUobpCA6ko4ZlNh4miOxjDQhgUTQLEOVUjlpr9jNkoDDZZ48\nRB2H6d3AueQjEeLLDiJnPDkixxG2VQhQRxTUjAtjdjJ17i4xLhTUMaHdnEWAqPkj\nyA9tNxL/xm1SSKrEBgs+UCwQyCE0dSyLnupbxs3xWOWo6XXCatoY2HNsUgjfdLJe\nm95/+igQEoQd8sJYfwxHXYp6vUjHGrHMN2ycgGPsKhZ2R8Nc9HYmkAU/QJuzyw+g\ntlG//gIVAgMBAAECggEAAJMeWwYHJ+JhVo9Pv5UNpQNLD4Py+3pu5aVujKjj/Xy1\n70iwK8o1yNAYQnhc1BnexnT0RxvkC4cTCunn4YvDDM4K8tmyeyYkqyRKh7rxjODP\nbkAzawKslsxsT8BOnSmQbIJgwzDWTKFmgzLGryaVqlO1/ig7+pcqogsD9lfJtTaX\n91RhAzVjmQ3yLV0B4sI3NgLlibPG0wp7iTvpgjDSgnX767zPIfra4Mvn94Az5XrE\nCOsI18niR41xP3dJDoWDvQImfhx/uLNZ/M9qyvou323VSugZF4tQ5HUqlU/MvIqV\nZI4N+/Cfvuv1iuNOCe+dK4MZYTDexul+KJ44qLVROQKBgQDlcGMml7F7sC1BxT9u\nXft+coVxErrpL2yQBMI+OE3Q7yrApAc7FlisyYdLrfI4CysCiohOBlwmPULQaqG0\n/zT620ycjaKennOFqQpn7Igv2FFI6XJKeGOiJrlzYYU/D4GkBNx5xMXnn8zfIIus\nx5RmfS0qTDr2mUKE1VLjaZgGXQKBgQDTb7Uev7e2F7JDDIpc8k1ahE+1qAUR2Ght\nWbIafjnTP/O8fvIQ9NuZgui9Faf+0sgNbilF8KgSXxx1UjPCTJ4xAIHbCn1lfSB9\nU3olPiSOxnaPleP40bwuM+LUeF0B3x18X2m1/UO+5WDN6Wm/VHQ2JAxfkSFhHgzM\nV55TDp6/GQKBgQCwNvcPxuW7V34Ky5GCFJB5dz9hrr77JT8+BUmiO+AYHfg56EDd\ncrY8TrOovjoQLROlafxx4JSZkedk5uC3gGKSYCeg/W7uYEfdWgzx8EpQZNVZKGJt\nK7Vp7k/0e+u4mRI6hLlIlIZi9OqGXBqqYsZpSK6Nk+qdRuw91RFKM+lcyQKBgQCj\nx1rn55/ZeD+IOlWPK82JeQX5c54Btb0mPx178hy+q0IU18yQH+te3Q2FMhpAhGuc\nI6Hq4ECAgpYbtsILFqhO0tLDpjt9+s/I5HmwEZPl2IuMK5I8cdIvg9eHt3hr87T2\nWz4aT4VDgJBc0Bour6+ZJJFFEblmbg2B17j3I1MKOQKBgEx7PTEcIlpoBYzdAy2v\nSuTyuYZHpymwPEPuRo06cR3TsSPthFFZ6YLPPIsgHz0u/IDAap3NuY4EfqFxwqtq\ny5AnWjqe1kSzXoCUM8oXT1PB0z9OHggsuFrUlMerK5zrP1Tsx5FXTh4K2zOsWpby\nEPC6nivfa7xWBYKS/oan1s1E\n-----END PRIVATE KEY-----\`;

// ---- JWK: structure, and a round trip ------------------------------------
const keys = {
  'ec-p256': c.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }),
  'ec-p384': c.generateKeyPairSync('ec', { namedCurve: 'secp384r1' }),
  ed25519: c.generateKeyPairSync('ed25519'),
  rsa: c.generateKeyPairSync('rsa', { modulusLength: 2048 }),
};
for (const [name, kp] of Object.entries(keys)) {
  say('jwk-pub-' + name, () => {
    const j = kp.publicKey.export({ format: 'jwk' });
    return Object.keys(j).sort().join(',') + ' kty=' + j.kty + ' crv=' + j.crv;
  });
  say('jwk-prv-' + name, () => {
    const j = kp.privateKey.export({ format: 'jwk' });
    return Object.keys(j).sort().join(',') + ' kty=' + j.kty + ' crv=' + j.crv;
  });
  // The numbers must be the right WIDTH: an EC coordinate is the curve's octet
  // length, LEFT-PADDED to it (dropping a leading zero there is the classic JWK
  // bug, and it shows up on ~1 key in 256). RSA is the opposite rule — minimal
  // encoding, no padding — so its widths vary per key and are checked on the fixed
  // key below instead of here.
  if (name !== 'rsa') {
    say('jwk-widths-' + name, () => {
      const j = kp.privateKey.export({ format: 'jwk' });
      const len = (v) => (v === undefined ? '-' : Buffer.from(v, 'base64url').length);
      return 'x=' + len(j.x) + ' y=' + len(j.y) + ' d=' + len(j.d) + ' n=' + len(j.n) + ' e=' + len(j.e);
    });
  }
  say('jwk-roundtrip-pub-' + name, () => {
    const der = kp.publicKey.export({ type: 'spki', format: 'der' });
    const back = c.createPublicKey({ key: kp.publicKey.export({ format: 'jwk' }), format: 'jwk' });
    return String(back.export({ type: 'spki', format: 'der' }).equals(der));
  });
  say('jwk-roundtrip-prv-' + name, () => {
    const der = kp.privateKey.export({ type: 'pkcs8', format: 'der' });
    const back = c.createPrivateKey({ key: kp.privateKey.export({ format: 'jwk' }), format: 'jwk' });
    return String(back.export({ type: 'pkcs8', format: 'der' }).equals(der));
  });
}

// The fixed key: every RSA member, minimally encoded per RFC 7518 6.3. A d of 255
// bytes is the whole point — a fixed-width exporter prints 256 here.
say('jwk-widths-rsa-fixed', () => {
  const k = c.createPrivateKey(RSA_FIXED);
  const j = k.export({ format: 'jwk' });
  const len = (v) => (v === undefined ? '-' : Buffer.from(v, 'base64url').length);
  return ['n', 'e', 'd', 'p', 'q', 'dp', 'dq', 'qi'].map((f) => f + '=' + len(j[f])).join(' ');
});
// …and it still imports back to the same key, so trimming did not corrupt it.
say('jwk-roundtrip-rsa-fixed', () => {
  const k = c.createPrivateKey(RSA_FIXED);
  const back = c.createPrivateKey({ key: k.export({ format: 'jwk' }), format: 'jwk' });
  return String(back.export({ type: 'pkcs8', format: 'der' }).equals(k.export({ type: 'pkcs8', format: 'der' })));
});

// An imported JWK is a usable key, not just a parsed one.
say('jwk-imported-key-verifies', () => {
  const kp = keys['ec-p256'];
  const pub = c.createPublicKey({ key: kp.publicKey.export({ format: 'jwk' }), format: 'jwk' });
  const sig = c.sign('sha256', Buffer.from('payload'), kp.privateKey);
  return String(c.verify('sha256', Buffer.from('payload'), pub, sig));
});
say('jwk-imported-private-signs', () => {
  const kp = keys.ed25519;
  const prv = c.createPrivateKey({ key: kp.privateKey.export({ format: 'jwk' }), format: 'jwk' });
  const sig = c.sign(null, Buffer.from('payload'), prv);
  return String(c.verify(null, Buffer.from('payload'), kp.publicKey, sig));
});

// RFC 7518 §6.3.2 makes dp/dq/qi optional; Node requires them anyway, so we do
// too — being more permissive than Node is still a divergence, and the one that
// bites is code that works here and fails on the host.
say('jwk-rsa-without-crt', () => {
  const j = keys.rsa.privateKey.export({ format: 'jwk' });
  const { dp, dq, qi, ...rest } = j;
  const back = c.createPrivateKey({ key: rest, format: 'jwk' });
  return String(
    back.export({ type: 'pkcs8', format: 'der' }).equals(keys.rsa.privateKey.export({ type: 'pkcs8', format: 'der' })),
  );
});

// A private JWK asked for as a PUBLIC key gives the public half, rather than
// refusing — same as Node does with a private PEM.
say('jwk-private-as-public', () => {
  const pub = c.createPublicKey({ key: keys['ec-p256'].privateKey.export({ format: 'jwk' }), format: 'jwk' });
  return pub.type + ' ' + String(
    pub.export({ type: 'spki', format: 'der' }).equals(keys['ec-p256'].publicKey.export({ type: 'spki', format: 'der' })),
  );
});
// A JWK missing a member Node requires is rejected by NAME.
say('jwk-missing-member', () => {
  const { y, ...rest } = keys['ec-p256'].publicKey.export({ format: 'jwk' });
  c.createPublicKey({ key: rest, format: 'jwk' });
  return 'no throw';
});

process.exit(0);
`;

// ── the host's real Node ─────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vv-crypto-jwk-"));
fs.writeFileSync(path.join(tmp, "probe.js"), PROBE);
let hostOut = "";
try {
  hostOut = execFileSync(process.execPath, ["probe.js"], { cwd: tmp, encoding: "utf8", timeout: 120000 });
} catch (e) {
  hostOut = (e.stdout || "") + "\nHOST FAILED " + String(e.message).slice(0, 200);
}

// ── and the VM ───────────────────────────────────────────────────────────────
const h = await bootSpikeKernel();
writeProject(h.kernel, "/app", { "probe.js": PROBE });
const r = await h.kernel.start("node", ["probe.js"], { cwd: "/app", capture: true });
const vmOut = r.stdout || "";

const parse = (s) =>
  new Map(
    s
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^[a-z][\w-]* /.test(l))
      .map((l) => {
        const i = l.indexOf(" ");
        return [l.slice(0, i), l.slice(i + 1)];
      }),
  );
const H = parse(hostOut);
const V = parse(vmOut);
console.log(`crypto hkdf/jwk: ${H.size} cases on the host, ${V.size} in the VM`);
if (!V.size && r.stderr) console.log("  VM stderr: " + String(r.stderr).slice(0, 500));

for (const [name, hostLine] of H) {
  const vmLine = V.get(name);
  if (hostLine === vmLine) {
    // The fixed-key widths are printed, not just compared: `d=255` is the value
    // that says the trimming is live. A silent ✓ here would also be what a
    // fixed-width exporter looked like on the ~255 keys out of 256 where the two
    // rules agree.
    ok(true, /-fixed$/.test(name) ? `${name} — ${vmLine}` : name);
  } else {
    ok(false, name);
    console.log(`      host: ${hostLine}`);
    console.log(`      vm:   ${vmLine === undefined ? "(missing)" : vmLine}`);
  }
}
if (!H.size) {
  ok(false, "the host produced no cases");
  console.log(hostOut.slice(0, 800));
}

console.log(failed === 0 ? "\ncrypto hkdf/jwk: OK" : `\ncrypto hkdf/jwk: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
