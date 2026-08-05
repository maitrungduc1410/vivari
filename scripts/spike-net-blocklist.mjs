// Spike (OFFLINE, Wasm-free): `net.BlockList` and `net.SocketAddress` must answer
// exactly what real Node answers.
//
// WHY THIS EXISTS. Both are lazy getters on `net`, backed by C++ in Node, and neither
// was vendored — so `{ ...net }` threw "no vendored Node builtin 'internal/blocklist'"
// and took every consumer that enumerates the module down with it. That was the last
// instance of the trap AGENTS.md documents for `fs`.
//
// A stub was deliberately refused here: a BlockList decides whether to ACCEPT a
// connection, so a CIDR matcher that is subtly wrong is worse than an honest throw.
// Which is exactly why the gate compares against real Node rather than against a
// hand-written table — the interesting answers are the boundaries (is `/24` inclusive
// of `.0`? does an IPv4-mapped IPv6 address match an IPv4 rule?), and those are the
// ones I would have got wrong by reasoning.
//
//   run:  node scripts/spike-net-blocklist.mjs

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

const GUEST = String.raw`
const net = require('net');
const util = require('util');

const out = [];
const say = (name, value) => out.push(name + ' ' + value);
const attempt = (name, fn) => {
  try {
    say(name, JSON.stringify(fn()));
  } catch (e) {
    say(name, 'ERR ' + (e && e.code ? e.code : 'no-code'));
  }
};

// Enumerating the module is the thing that used to throw outright.
attempt('spread-net-does-not-throw', () => {
  const copy = { ...net };
  return typeof copy.createServer === 'function' && 'BlockList' in copy;
});
attempt('BlockList-and-SocketAddress-are-exported', () =>
  [typeof net.BlockList, typeof net.SocketAddress]);

// ── rules: the format, and the order they come back in ──────────────────────
attempt('rules-for-every-kind-and-family', () => {
  const b = new net.BlockList();
  b.addAddress('1.1.1.1');
  b.addRange('10.0.0.1', '10.0.0.10');
  b.addSubnet('192.168.1.0', 24);
  b.addAddress('::1', 'ipv6');
  b.addRange('2001:db8::1', '2001:db8::10', 'ipv6');
  b.addSubnet('2001:db8::', 32, 'ipv6');
  return b.rules;
});
attempt('rules-report-a-canonical-ipv6', () => {
  const b = new net.BlockList();
  b.addAddress('2001:0DB8:0000:0000:0000:0000:0000:0001', 'ipv6');
  b.addSubnet('2001:0db8:1234:0000::', 48, 'ipv6');
  b.addAddress('::FFFF:1.2.3.4', 'ipv6');
  b.addAddress('0:0:0:0:0:0:0:0', 'ipv6');
  b.addAddress('1:0:0:2:0:0:0:3', 'ipv6');
  return b.rules;
});
attempt('inspect', () => {
  const b = new net.BlockList();
  b.addAddress('1.1.1.1');
  return util.inspect(b);
});

// ── checks, at the boundaries ───────────────────────────────────────────────
attempt('exact-address', () => {
  const b = new net.BlockList();
  b.addAddress('1.1.1.1');
  return ['1.1.1.0', '1.1.1.1', '1.1.1.2'].map((a) => b.check(a));
});
attempt('range-is-inclusive-at-both-ends', () => {
  const b = new net.BlockList();
  b.addRange('10.0.0.5', '10.0.0.10');
  return ['10.0.0.4', '10.0.0.5', '10.0.0.7', '10.0.0.10', '10.0.0.11'].map((a) => b.check(a));
});
attempt('range-crossing-an-octet-boundary', () => {
  const b = new net.BlockList();
  b.addRange('10.0.1.250', '10.0.2.5');
  return ['10.0.1.249', '10.0.1.255', '10.0.2.0', '10.0.2.5', '10.0.2.6'].map((a) => b.check(a));
});
attempt('subnet-24', () => {
  const b = new net.BlockList();
  b.addSubnet('192.168.1.0', 24);
  return ['192.168.0.255', '192.168.1.0', '192.168.1.255', '192.168.2.0'].map((a) => b.check(a));
});
attempt('subnet-25-splits-an-octet', () => {
  const b = new net.BlockList();
  b.addSubnet('192.168.1.0', 25);
  return ['192.168.1.0', '192.168.1.127', '192.168.1.128', '192.168.1.255'].map((a) => b.check(a));
});
attempt('subnet-32-is-a-single-host', () => {
  const b = new net.BlockList();
  b.addSubnet('192.168.1.5', 32);
  return ['192.168.1.4', '192.168.1.5', '192.168.1.6'].map((a) => b.check(a));
});
attempt('subnet-0-matches-everything', () => {
  const b = new net.BlockList();
  b.addSubnet('0.0.0.0', 0);
  return ['0.0.0.0', '8.8.8.8', '255.255.255.255'].map((a) => b.check(a));
});
attempt('ipv6-subnet', () => {
  const b = new net.BlockList();
  b.addSubnet('2001:db8::', 32, 'ipv6');
  return ['2001:db7:ffff::1', '2001:db8::', '2001:db8:ffff:ffff::1', '2001:db9::1']
    .map((a) => b.check(a, 'ipv6'));
});
attempt('ipv6-subnet-with-an-odd-prefix', () => {
  const b = new net.BlockList();
  b.addSubnet('2001:db8:8000::', 33, 'ipv6');
  return ['2001:db8:7fff::1', '2001:db8:8000::1', '2001:db8:ffff::1', '2001:db9::1']
    .map((a) => b.check(a, 'ipv6'));
});
attempt('ipv6-range', () => {
  const b = new net.BlockList();
  b.addRange('2001:db8::5', '2001:db8::a', 'ipv6');
  return ['2001:db8::4', '2001:db8::5', '2001:db8::7', '2001:db8::a', '2001:db8::b']
    .map((a) => b.check(a, 'ipv6'));
});

// An IPv4-mapped IPv6 address is the same host as its IPv4 form. Which way Node
// bridges the two families is not something to guess at.
attempt('v4-mapped-checked-against-an-ipv4-rule', () => {
  const b = new net.BlockList();
  b.addAddress('1.1.1.1');
  b.addSubnet('10.0.0.0', 8);
  return [b.check('::ffff:1.1.1.1', 'ipv6'), b.check('::ffff:10.1.2.3', 'ipv6'), b.check('::ffff:2.2.2.2', 'ipv6')];
});
attempt('ipv4-checked-against-a-v4-mapped-rule', () => {
  const b = new net.BlockList();
  b.addAddress('::ffff:1.1.1.1', 'ipv6');
  return [b.check('1.1.1.1'), b.check('2.2.2.2')];
});
attempt('families-do-not-leak-into-each-other', () => {
  const b = new net.BlockList();
  b.addAddress('1.1.1.1');
  b.addAddress('::1', 'ipv6');
  return [b.check('1.1.1.1', 'ipv6'), b.check('::1', 'ipv4'), b.check('::1', 'ipv6')];
});
attempt('an-empty-blocklist-blocks-nothing', () => {
  const b = new net.BlockList();
  return [b.check('1.1.1.1'), b.check('::1', 'ipv6')];
});
attempt('check-of-a-malformed-address-is-false-not-a-throw', () => {
  const b = new net.BlockList();
  b.addAddress('1.1.1.1');
  return [b.check('nope'), b.check('999.1.1.1'), b.check('')];
});

// ── SocketAddress as an argument, which the JS layer accepts everywhere ─────
attempt('addAddress-and-check-take-a-SocketAddress', () => {
  const b = new net.BlockList();
  b.addAddress(new net.SocketAddress({ address: '5.5.5.5' }));
  return [b.rules, b.check(new net.SocketAddress({ address: '5.5.5.5', port: 1 })), b.check('5.5.5.6')];
});

// ── the ways they refuse ────────────────────────────────────────────────────
attempt('addAddress-rejects-a-malformed-address', () => new net.BlockList().addAddress('999.1.1.1'));
attempt('addAddress-rejects-an-ipv6-declared-ipv4', () => new net.BlockList().addAddress('::1'));
attempt('addAddress-rejects-an-unknown-family', () => new net.BlockList().addAddress('1.1.1.1', 'ipv5'));
attempt('addAddress-rejects-a-non-string', () => new net.BlockList().addAddress(42));
attempt('addSubnet-rejects-prefix-33-for-ipv4', () => new net.BlockList().addSubnet('10.0.0.0', 33));
attempt('addSubnet-rejects-a-negative-prefix', () => new net.BlockList().addSubnet('10.0.0.0', -1));
attempt('addSubnet-rejects-prefix-129-for-ipv6', () => new net.BlockList().addSubnet('2001:db8::', 129, 'ipv6'));
attempt('addRange-rejects-a-reversed-range', () => new net.BlockList().addRange('10.0.0.10', '10.0.0.1'));
attempt('addRange-accepts-a-single-address-range', () => {
  const b = new net.BlockList();
  b.addRange('10.0.0.1', '10.0.0.1');
  return [b.rules, b.check('10.0.0.1')];
});
attempt('isBlockList', () => [
  net.BlockList.isBlockList(new net.BlockList()),
  net.BlockList.isBlockList({}),
  net.BlockList.isBlockList(null),
]);

// ── SocketAddress ──────────────────────────────────────────────────────────
attempt('SocketAddress-defaults', () => {
  const s = new net.SocketAddress();
  return [s.address, s.port, s.family, s.flowlabel];
});
attempt('SocketAddress-ipv6-defaults', () => {
  const s = new net.SocketAddress({ family: 'ipv6' });
  return [s.address, s.port, s.family];
});
attempt('SocketAddress-getters', () => {
  const s = new net.SocketAddress({ address: '1.2.3.4', port: 99 });
  return [s.address, s.port, s.family, s.flowlabel];
});
attempt('SocketAddress-canonicalises-ipv6', () => {
  const s = new net.SocketAddress({ address: '2001:0DB8::0001', family: 'ipv6', port: 8, flowlabel: 7 });
  return [s.address, s.port, s.family, s.flowlabel];
});
attempt('SocketAddress-uppercase-family', () => new net.SocketAddress({ address: '1.2.3.4', family: 'IPv4' }).family);
attempt('SocketAddress-rejects-an-unknown-family', () => new net.SocketAddress({ address: '1.2.3.4', family: 'ipv9' }));
attempt('SocketAddress-rejects-a-malformed-address', () => new net.SocketAddress({ address: 'nope' }));
attempt('SocketAddress-rejects-a-negative-port', () => new net.SocketAddress({ address: '1.2.3.4', port: -1 }));
attempt('SocketAddress-rejects-a-port-above-65535', () => new net.SocketAddress({ address: '1.2.3.4', port: 70000 }));
attempt('SocketAddress-inspect', () => util.inspect(new net.SocketAddress({ address: '1.2.3.4', port: 99 })));
attempt('isSocketAddress', () => [
  net.SocketAddress.isSocketAddress(new net.SocketAddress()),
  net.SocketAddress.isSocketAddress({}),
]);
attempt('SocketAddress.parse', () => {
  const s = net.SocketAddress.parse('1.2.3.4:99');
  return s ? [s.address, s.port, s.family] : String(s);
});
attempt('SocketAddress.parse-ipv6', () => {
  const s = net.SocketAddress.parse('[::1]:8080');
  return s ? [s.address, s.port, s.family] : String(s);
});
attempt('SocketAddress.parse-of-rubbish', () => String(net.SocketAddress.parse('not-an-address')));

for (const line of out) console.log('CASE ' + line);
`;

// ── the host's real Node ─────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vv-blocklist-"));
const guestFile = path.join(tmp, "guest.js");
fs.writeFileSync(guestFile, GUEST);

let hostRaw = "";
try {
  hostRaw = execFileSync(process.execPath, [guestFile], { encoding: "utf8", timeout: 60000 });
} catch (e) {
  hostRaw = "HOST_FAILED: " + ((e && e.stderr) || e);
}
const pick = (raw) =>
  raw
    .split("\n")
    .filter((l) => l.startsWith("CASE "))
    .map((l) => l.slice(5).trim());
const hostCases = pick(hostRaw);

// ── and the VM ───────────────────────────────────────────────────────────────
const h = await bootSpikeKernel();
writeProject(h.kernel, "/t", { "guest.js": GUEST });
const r = await h.kernel.start("node", ["/t/guest.js"], { cwd: "/t", capture: true });
const vmCases = pick(r.stdout || "");

if (!hostCases.length) {
  console.log("  ✗ the host produced no transcript — the gate cannot judge anything");
  console.log(hostRaw.slice(0, 2000));
  process.exit(1);
}
if (!vmCases.length) {
  console.log(`  ✗ the VM produced no transcript (exit ${r.code})`);
  console.log((r.stderr || "").split("\n").slice(0, 10).join("\n"));
  process.exit(1);
}

console.log(`== ${hostCases.length} cases, host Node vs the VM ==`);
const hostByName = new Map(hostCases.map((l) => [l.split(" ")[0], l]));
const vmByName = new Map(vmCases.map((l) => [l.split(" ")[0], l]));
for (const [name, hostLine] of hostByName) {
  const vmLine = vmByName.get(name);
  const same = vmLine === hostLine;
  ok(same, name + "  →  " + hostLine.slice(name.length + 1));
  if (!same) {
    console.log("      host: " + hostLine);
    console.log("      vm:   " + (vmLine === undefined ? "(case missing)" : vmLine));
  }
}
for (const name of vmByName.keys()) {
  if (!hostByName.has(name)) ok(false, `the VM emitted a case the host did not: ${name}`);
}

// Stated outright, so a transcript that matches because BOTH sides refuse everything
// cannot pass.
console.log("\n== the gap that prompted this, named ==");
{
  const errored = vmCases.filter((l) => l.includes("no vendored Node builtin"));
  ok(errored.length === 0, `no case reports a missing vendored builtin (found ${errored.length})`);
  const spread = vmByName.get("spread-net-does-not-throw") || "";
  ok(spread.endsWith("true"), "enumerating `net` no longer throws");
  const rules = vmByName.get("rules-for-every-kind-and-family") || "";
  ok(rules.includes("Subnet: IPv4 192.168.1.0/24"), "a subnet rule is reported in Node's format");
  const subnet = vmByName.get("subnet-25-splits-an-octet") || "";
  ok(subnet.endsWith("[true,true,false,false]"), "a /25 splits its octet — the matcher is real, not a prefix compare");
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* scratch */
}

console.log(`\nRESULT: ${failed === 0 ? "PASS — BlockList/SocketAddress match real Node" : `FAIL — ${failed} check(s)`}`);
process.exit(failed === 0 ? 0 : 1);
