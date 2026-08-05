// IP literal parsing and formatting, shared by the bindings that need addresses as
// bytes rather than as strings: `cares_wrap` (bindings/net.js) and `block_list`
// (bindings/block-list.js, where every comparison is byte-wise).
//
// The IPv6 parser was written for `cares_wrap` and lived inside bindings/net.js; it
// moved here rather than being copied, because two IPv6 parsers that disagree about
// an edge case is a worse outcome than either of them being wrong.

export function isIPv4(s) {
  return (
    typeof s === "string" &&
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) &&
    s.split(".").every((o) => +o <= 255)
  );
}

export function isIPv6(s) {
  if (typeof s !== "string") return false;
  const a = s.indexOf("%") === -1 ? s : s.slice(0, s.indexOf("%"));
  if (a.indexOf(":") === -1) return false;
  try {
    parseIPv6(a);
    return true;
  } catch {
    return false;
  }
}

// Parse a dotted-quad into its 4 bytes. Throws for anything else, so callers can
// treat a throw as "not an IPv4 address".
export function parseIPv4(addr) {
  if (!isIPv4(addr)) throw new Error("invalid IPv4 address: " + addr);
  const out = new Uint8Array(4);
  const parts = addr.split(".");
  for (let i = 0; i < 4; i++) out[i] = Number(parts[i]) & 0xff;
  return out;
}

// Parse an IPv6 literal into its 16-byte big-endian form. Handles `::`
// zero-compression, an optional zone id (`%eth0`), and an embedded IPv4 tail
// (`::ffff:1.2.3.4`). Returns a Uint8Array(16); callers only index bytes.
export function parseIPv6(addr) {
  if (typeof addr !== "string") throw new TypeError("invalid IPv6 address");
  const pct = addr.indexOf("%");
  if (pct !== -1) addr = addr.slice(0, pct); // drop zone id

  // Fold a trailing embedded IPv4 (e.g. ::ffff:127.0.0.1) into two hextets.
  const lastColon = addr.lastIndexOf(":");
  const tail = addr.slice(lastColon + 1);
  if (tail.indexOf(".") !== -1) {
    const p = tail.split(".");
    if (p.length !== 4) throw new Error("invalid IPv6 address: " + addr);
    const o = p.map((x) => Number(x));
    if (!o.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new Error("invalid IPv6 address: " + addr);
    }
    const hi = ((o[0] << 8) | o[1]).toString(16);
    const lo = ((o[2] << 8) | o[3]).toString(16);
    addr = addr.slice(0, lastColon + 1) + hi + ":" + lo;
  }

  const halves = addr.split("::");
  if (halves.length > 2) throw new Error("invalid IPv6 address: " + addr);
  const head = halves[0] === "" ? [] : halves[0].split(":");
  let groups;
  if (halves.length === 2) {
    const rest = halves[1] === "" ? [] : halves[1].split(":");
    const missing = 8 - head.length - rest.length;
    if (missing < 0) throw new Error("invalid IPv6 address: " + addr);
    groups = head.concat(new Array(missing).fill("0"), rest);
  } else {
    groups = head;
    if (groups.length !== 8) throw new Error("invalid IPv6 address: " + addr);
  }

  const buf = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i] || "0";
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) throw new Error("invalid IPv6 address: " + addr);
    const v = parseInt(g, 16) & 0xffff;
    buf[i * 2] = v >> 8;
    buf[i * 2 + 1] = v & 0xff;
  }
  return buf;
}

export function formatIPv4(bytes) {
  return `${bytes[0]}.${bytes[1]}.${bytes[2]}.${bytes[3]}`;
}

// Format 16 bytes the way RFC 5952 requires, because `BlockList#rules` and
// `SocketAddress#address` report a canonical string and are compared against real
// Node's output: lower-case hex, no leading zeros, and the LONGEST run of zero
// hextets collapsed to `::` — leftmost run when two are equally long, and never a
// run of only one.
export function formatIPv6(bytes) {
  // RFC 5952 §5: an IPv4-mapped address keeps its dotted-quad tail, so
  // ::ffff:1.2.3.4 must not print as ::ffff:102:304. Real Node does this and the
  // gate caught the omission.
  let mapped = bytes[10] === 0xff && bytes[11] === 0xff;
  for (let i = 0; i < 10 && mapped; i++) if (bytes[i] !== 0) mapped = false;
  if (mapped) return "::ffff:" + formatIPv4(bytes.subarray(12));

  const groups = [];
  for (let i = 0; i < 8; i++) groups.push((bytes[i * 2] << 8) | bytes[i * 2 + 1]);

  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] !== 0) continue;
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) {
      bestLen = j - i;
      bestStart = i;
    }
    i = j - 1;
  }
  if (bestLen < 2) {
    bestStart = -1;
    bestLen = 0;
  }

  const hex = groups.map((g) => g.toString(16));
  if (bestStart === -1) return hex.join(":");
  const head = hex.slice(0, bestStart).join(":");
  const tail = hex.slice(bestStart + bestLen).join(":");
  return head + "::" + tail;
}
