// Spike (OFFLINE): the constant tables, compared to the host key by key AND value
// by value — plus the four behaviours that made the gaps matter.
//
// WHY. Node builds `os.constants`, `fs.constants`, `crypto.constants` and the
// deprecated `constants` module from ONE internal table. We had four hand-written
// partial copies, one per consumer, and they had drifted from Node and from each
// other: os.constants.signals and .priority were empty objects, .dlopen was
// missing, fs.constants had the owner permission bits but neither group nor other,
// crypto.constants had 7 of 56 names, and `constants` carried a second copy of
// errno/signals including two Windows-only names on Linux.
//
// A missing constant cannot announce itself. Reading one is `undefined`, not an
// error, and `undefined` in a bitmask is a silently wrong number:
// `child.kill(os.constants.signals.SIGKILL)` sent `undefined`, and a mode built
// from `S_IRWXG | S_IROTH` came out NaN. So the gate is a full comparison rather
// than a list of the names someone happened to need — the previous approach, and
// the reason the table stayed one entry long for so long.
//
//   run:  node scripts/spike-constants.mjs

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

// Dumped the same way in both places, values included. Infinity survives as a
// string tag: JSON.stringify(Infinity) is `null`, which would have quietly made
// Z_MAX_CHUNK "equal" to a host value of null.
const DUMP = `
const flat = (obj, prefix, into) => {
  for (const k of Object.keys(obj || {})) {
    const v = obj[k];
    if (v && typeof v === "object") flat(v, prefix + k + ".", into);
    else into[prefix + k] = typeof v === "number" && !Number.isFinite(v) ? "Infinity:" + String(v) : v;
  }
  return into;
};
const out = {};
const surface = (label, get) => {
  try { out[label] = flat(get(), "", {}); } catch (e) { out[label] = { THREW: String(e && e.code || e) }; }
};
surface("constants", () => require("constants"));
surface("os.constants", () => require("os").constants);
surface("fs.constants", () => require("fs").constants);
surface("crypto.constants", () => require("crypto").constants);
surface("zlib.constants", () => require("zlib").constants);
console.log(JSON.stringify(out));
`;

// The consequences, not the table: a signal number that reaches kill(2), a mode
// built from group/other bits that round-trips through chmod, the deprecated
// aggregate agreeing with the modern view, and zstd failing for the reason it is
// actually missing rather than on a parameter lookup.
const BEHAVIOUR = `
const os = require("os"), fs = require("fs"), zlib = require("zlib");
const lines = [];
lines.push("SIGKILL=" + os.constants.signals.SIGKILL + " SIGTERM=" + os.constants.signals.SIGTERM);
lines.push("PRIORITY_NORMAL=" + os.constants.priority.PRIORITY_NORMAL + " RTLD_LAZY=" + os.constants.dlopen.RTLD_LAZY);

const mode = fs.constants.S_IRUSR | fs.constants.S_IWUSR | fs.constants.S_IRGRP | fs.constants.S_IROTH;
lines.push("mode=" + mode.toString(8));
fs.writeFileSync("cmode", "x");
fs.chmodSync("cmode", mode);
lines.push("stat=" + (fs.statSync("cmode").mode & 0o777).toString(8));

const legacy = require("constants");
lines.push("agree=" + [
  legacy.O_CREAT === fs.constants.O_CREAT,
  legacy.ENOENT === os.constants.errno.ENOENT,
  legacy.SIGTERM === os.constants.signals.SIGTERM,
  legacy.RSA_PKCS1_PADDING === require("crypto").constants.RSA_PKCS1_PADDING,
].join(","));

// zstd is not implemented. The error must say so, rather than dying inside the
// parameter table on the way there.
try {
  zlib.zstdCompressSync(Buffer.from("hi"));
  lines.push("zstd=UNEXPECTEDLY-WORKED");
} catch (e) {
  lines.push("zstd=" + (e && e.code ? e.code + " " : "") + String(e && e.message).slice(0, 60));
}
console.log(lines.join("\\n"));
`;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vv-consts-"));
fs.writeFileSync(path.join(tmp, "dump.js"), DUMP);
fs.writeFileSync(path.join(tmp, "behaviour.js"), BEHAVIOUR);
const runHost = (f) =>
  execFileSync(process.execPath, [f], {
    cwd: tmp,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });

const h = await bootSpikeKernel();
writeProject(h.kernel, "/app", { "dump.js": DUMP, "behaviour.js": BEHAVIOUR });
const runVm = async (f) => {
  const r = await h.kernel.start("node", [f], { cwd: "/app", capture: true });
  if (!r.stdout)
    throw new Error(
      `in-VM ${f} produced nothing (stderr: ${String(r.stderr || "").slice(0, 400)})`,
    );
  return r.stdout;
};

// ── the tables ───────────────────────────────────────────────────────────────
const host = JSON.parse(runHost("dump.js"));
const vm = JSON.parse(await runVm("dump.js"));

console.log("constant tables, against the host:\n");
for (const label of Object.keys(host)) {
  const H = host[label];
  const V = vm[label] || {};
  const missing = Object.keys(H).filter((k) => !(k in V));
  const extra = Object.keys(V).filter((k) => !(k in H));
  const differ = Object.keys(H).filter((k) => k in V && V[k] !== H[k]);
  const clean = !missing.length && !extra.length && !differ.length;
  ok(clean, `${label} — ${Object.keys(H).length} names, values included`);
  if (missing.length)
    console.log(
      `      missing (${missing.length}): ${missing.slice(0, 40).join(" ")}`,
    );
  if (extra.length)
    console.log(
      `      extra (${extra.length}): ${extra.slice(0, 40).join(" ")}`,
    );
  if (differ.length)
    console.log(
      `      differ (${differ.length}): ${differ
        .slice(0, 20)
        .map((k) => `${k} host=${H[k]} vm=${V[k]}`)
        .join("  ")}`,
    );
}

// ── the consequences ─────────────────────────────────────────────────────────
console.log("\nwhat the numbers are for:\n");
const hostB = runHost("behaviour.js").trim().split("\n");
const vmB = (await runVm("behaviour.js")).trim().split("\n");
for (let i = 0; i < Math.max(hostB.length, vmB.length); i++) {
  const hl = hostB[i] || "(missing)";
  const vl = vmB[i] || "(missing)";
  // zstd is the one line that cannot match: the host has the codec and we do not,
  // so what is checked is that our error names the codec rather than a parameter.
  if (hl.startsWith("zstd=")) {
    ok(
      /no zstd|zstd.*not|unsupported|missing/i.test(vl) &&
        !/INVALID_PARAM/.test(vl),
      `zstd says what is missing — ${vl}`,
    );
    continue;
  }
  ok(hl === vl, hl === vl ? hl : `host: ${hl}   vm: ${vl}`);
}

console.log(
  failed === 0
    ? "\nPASS: the tables and their consequences match Node."
    : `\nFAIL: ${failed} check(s) differ`,
);
process.exit(failed === 0 ? 0 : 1);
