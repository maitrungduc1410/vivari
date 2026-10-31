// Read the version a vendored-CLI pack was built from, without unpacking it.
//
// Every packer writes the same frame — [u32le headerLen][headerJSON][file bytes…]
// then gzip the lot — and the header carries { version, files: [...] }. That stamp
// is the only thing that can tell a pack left by an older pin from a current one:
// the asset is gitignored, and the runtime reports whatever the header says, so no
// gate downstream would notice a packer reusing the previous CLI under the new
// version's name.
//
// "" means the header cannot be read; callers treat that as stale (rebuild), not as
// "matches", because the failure this exists for is a silent reuse.
import fs from "node:fs";
import zlib from "node:zlib";

export function readPackVersion(file) {
  try {
    const raw = zlib.gunzipSync(fs.readFileSync(file));
    const headerLen = raw.readUInt32LE(0);
    const header = JSON.parse(raw.subarray(4, 4 + headerLen).toString("utf8"));
    return typeof header.version === "string" ? header.version : "";
  } catch {
    return "";
  }
}
