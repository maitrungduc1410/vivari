// Minimal ustar tar reader (P2 import).
//
// Environment-agnostic like archive.js: only `TextDecoder` + typed arrays, so it
// runs in a browser main thread and in Node. Used by the studio to unpack an npm
// package tarball (after gunzip) into a project tree.
//
// NOTE: an equivalent parser lives inside packages/kernel-host/programs/npm.js
// (the in-VM `npm` program, which unpacks tarballs it downloads at runtime).
// That copy runs inside the guest and can't be imported here, so this standalone
// module is the one the studio's importer uses. The small duplication is
// intentional.

const dec = new TextDecoder();

function cstr(buf, o, len) {
  let end = o;
  const max = o + len;
  while (end < max && buf[end] !== 0) end++;
  return dec.decode(buf.subarray(o, end));
}

// Parse a (already gunzipped) tar buffer into regular-file entries. Handles the
// ustar `prefix` field, GNU `L` long names, and pax `x`/`g` `path` overrides.
// Returns [{ name, bytes }] where `bytes` is a standalone copy (safe to transfer
// / structured-clone without dragging the whole tar buffer along).
export function parseTar(input) {
  const buf = input instanceof Uint8Array ? input : new Uint8Array(input || 0);
  const files = [];
  let off = 0;
  let override = null; // pending long name from a GNU 'L' or pax 'path' record
  while (off + 512 <= buf.length) {
    let allZero = true;
    for (let z = off; z < off + 512; z++) {
      if (buf[z] !== 0) { allZero = false; break; }
    }
    if (allZero) break;
    const name = cstr(buf, off, 100);
    const size = parseInt(cstr(buf, off + 124, 12).trim(), 8) || 0;
    const typeByte = buf[off + 156];
    const type = String.fromCharCode(typeByte);
    const prefix = cstr(buf, off + 345, 155);
    const full = prefix ? prefix + "/" + name : name;
    const dataStart = off + 512;
    const blocks = Math.ceil(size / 512) * 512;
    if (type === "L") {
      override = cstr(buf, dataStart, size);
      off = dataStart + blocks;
      continue;
    }
    if (type === "x" || type === "g") {
      const pax = dec.decode(buf.subarray(dataStart, dataStart + size));
      for (const line of pax.split("\n")) {
        if (!line) continue;
        const sp = line.indexOf(" ");
        if (sp < 0) continue;
        const kv = line.slice(sp + 1);
        const eq = kv.indexOf("=");
        if (eq < 0) continue;
        if (kv.slice(0, eq) === "path") override = kv.slice(eq + 1);
      }
      off = dataStart + blocks;
      continue;
    }
    const entry = override || full;
    override = null;
    if (type === "0" || type === "" || typeByte === 0) {
      files.push({ name: entry, bytes: buf.slice(dataStart, dataStart + size) });
    }
    off = dataStart + blocks;
  }
  return files;
}

// Drop the leading path segment. Tar archives wrap everything under a single
// root dir — `package/` for npm, `<repo>-<ref>/` for a GitHub archive. Returns
// "" for a top-level entry (which the caller then skips).
export function stripFirstSegment(name) {
  const i = name.indexOf("/");
  return i >= 0 ? name.slice(i + 1) : "";
}
