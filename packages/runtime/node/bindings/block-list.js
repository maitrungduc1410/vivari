// internalBinding('block_list') — the native half of `net.BlockList` and
// `net.SocketAddress`.
//
// Both are C++ in Node, so the vendored internal/blocklist.js and
// internal/socketaddress.js are the real bodies and this is the only part written
// here. Enumerating `net` used to throw on their lazy getters ("no vendored Node
// builtin 'internal/blocklist'"), which is the trap AGENTS.md documents for `fs`:
// one library or bundler spreading `net` and the whole module is unusable.
//
// A stub was deliberately refused for these: BlockList decides whether to ACCEPT a
// connection, and a CIDR matcher that is subtly wrong is worse than an honest throw.
// So the matching is byte-wise on parsed addresses, and every rule and answer is
// compared against real Node's for the same input by scripts/spike-net-blocklist.mjs.
//
// The contract the vendored JS expects of this binding:
//   AF_INET / AF_INET6                     — family tags it stores and compares
//   new SocketAddress(addr, port, af, fl)  — throws for a malformed address
//     .detail({...})                       — { address, port, family, flowlabel }
//     .flowlabel()                         — number
//   new BlockList()
//     .addAddress(saHandle) / .addRange(startHandle, endHandle) → false if reversed
//     .addSubnet(saHandle, prefix) / .check(saHandle) / .getRules()

import { formatIPv4, formatIPv6, parseIPv4, parseIPv6 } from "./ip.js";

// Linux values, matching what the vendored JS compares `detail().family` against.
const AF_INET = 2;
const AF_INET6 = 10;

// The first 12 bytes of an IPv4-mapped IPv6 address (::ffff:a.b.c.d).
const V4_MAPPED_PREFIX = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff];

const isV4Mapped = (bytes) =>
  bytes.length === 16 && V4_MAPPED_PREFIX.every((b, i) => bytes[i] === b);

// Compare two equal-length byte arrays as big-endian numbers: <0, 0 or >0.
const cmp = (a, b) => {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
};

export function createBlockListBindings() {
  class SocketAddress {
    constructor(address, port, family, flowlabel) {
      // Node's native constructor is what rejects a malformed address (the JS above
      // only checks that it is a string), and it reports ERR_INVALID_ADDRESS.
      let bytes;
      try {
        bytes = family === AF_INET6 ? parseIPv6(address) : parseIPv4(address);
      } catch {
        const err = new Error(`Invalid address: ${address}`);
        err.code = "ERR_INVALID_ADDRESS";
        throw err;
      }
      this.bytes = bytes;
      this.af = family;
      this.port = port | 0;
      this.fl = flowlabel | 0;
    }

    get canonical() {
      return this.af === AF_INET6 ? formatIPv6(this.bytes) : formatIPv4(this.bytes);
    }

    detail() {
      return {
        address: this.canonical,
        port: this.port,
        family: this.af,
        flowlabel: this.fl,
      };
    }

    flowlabel() {
      return this.fl;
    }
  }

  const label = (af) => (af === AF_INET6 ? "IPv6" : "IPv4");

  class BlockList {
    constructor() {
      this.rules = [];
    }

    addAddress(sa) {
      // Newest first, which is the order real Node's getRules() reports.
      this.rules.unshift({ kind: "Address", af: sa.af, bytes: sa.bytes });
    }

    addRange(start, end) {
      if (start.af !== end.af) return false;
      if (cmp(start.bytes, end.bytes) > 0) return false;
      this.rules.unshift({ kind: "Range", af: start.af, bytes: start.bytes, end: end.bytes });
      return true;
    }

    addSubnet(sa, prefix) {
      this.rules.unshift({ kind: "Subnet", af: sa.af, bytes: sa.bytes, prefix: prefix | 0 });
    }

    check(sa) {
      if (this.matches(sa.bytes, sa.af)) return true;
      // An IPv4-mapped IPv6 address is the same host as its IPv4 form, and real Node
      // answers true when it is checked against an IPv4 rule. Compare both ways so a
      // rule added in either family covers the other.
      if (sa.af === AF_INET6 && isV4Mapped(sa.bytes)) {
        return this.matches(sa.bytes.slice(12), AF_INET);
      }
      if (sa.af === AF_INET) {
        const mapped = new Uint8Array(16);
        mapped.set(V4_MAPPED_PREFIX, 0);
        mapped.set(sa.bytes, 12);
        return this.matches(mapped, AF_INET6);
      }
      return false;
    }

    matches(bytes, af) {
      for (const rule of this.rules) {
        if (rule.af !== af) continue;
        if (rule.kind === "Address") {
          if (cmp(rule.bytes, bytes) === 0) return true;
        } else if (rule.kind === "Range") {
          if (cmp(bytes, rule.bytes) >= 0 && cmp(bytes, rule.end) <= 0) return true;
        } else if (inSubnet(bytes, rule.bytes, rule.prefix)) {
          return true;
        }
      }
      return false;
    }

    getRules() {
      return this.rules.map((rule) => {
        const fmt = (b) => (rule.af === AF_INET6 ? formatIPv6(b) : formatIPv4(b));
        if (rule.kind === "Address") return `Address: ${label(rule.af)} ${fmt(rule.bytes)}`;
        if (rule.kind === "Range") {
          return `Range: ${label(rule.af)} ${fmt(rule.bytes)}-${fmt(rule.end)}`;
        }
        return `Subnet: ${label(rule.af)} ${fmt(rule.bytes)}/${rule.prefix}`;
      });
    }
  }

  return { BlockList, SocketAddress, AF_INET, AF_INET6 };
}

// Whole bytes then the partial one, so a /0 matches everything and a /33 cannot be
// reached (the JS above range-checks the prefix before we see it).
function inSubnet(bytes, network, prefix) {
  const whole = prefix >> 3;
  for (let i = 0; i < whole; i++) {
    if (bytes[i] !== network[i]) return false;
  }
  const bits = prefix & 7;
  if (bits === 0) return true;
  const mask = (0xff << (8 - bits)) & 0xff;
  return (bytes[whole] & mask) === (network[whole] & mask);
}
