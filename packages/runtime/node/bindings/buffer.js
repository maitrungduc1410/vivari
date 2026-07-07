// internalBinding('buffer') — the native core beneath Node's real lib/buffer.js.
//
// This is where Path B pays for itself: Node's JS Buffer (vendored verbatim)
// calls down here for the things V8/C++ normally provide — utf8/base64/hex/ucs2
// codecs, byte search, compare/copy/fill, byte swaps, atob/btoa. We map each to
// browser primitives (TextEncoder/TextDecoder, typed-array loops). The read/
// write numeric methods (readUInt32LE, ...) are NOT here: internal/buffer.js
// implements those in pure JS.

const encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8"); // lossy (U+FFFD), like Node
const utf8Strict = new TextDecoder("utf-8", { fatal: true });

// A Uint8Array view over whatever byte-ish thing we're handed.
function asBytes(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }
  return input;
}

// ---------------------------------------------------------------- base64 -----

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const B64REV = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < 64; i++) t[B64.charCodeAt(i)] = i;
  t["-".charCodeAt(0)] = 62;
  t["_".charCodeAt(0)] = 63;
  return t;
})();

function encodeBase64(buf, start, end, url) {
  const alpha = url ? B64URL : B64;
  let out = "";
  let i = start;
  for (; i + 2 < end; i += 3) {
    const n = (buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2];
    out += alpha[(n >> 18) & 63] + alpha[(n >> 12) & 63] + alpha[(n >> 6) & 63] + alpha[n & 63];
  }
  const rem = end - i;
  if (rem === 1) {
    const n = buf[i] << 16;
    out += alpha[(n >> 18) & 63] + alpha[(n >> 12) & 63];
    if (!url) out += "==";
  } else if (rem === 2) {
    const n = (buf[i] << 16) | (buf[i + 1] << 8);
    out += alpha[(n >> 18) & 63] + alpha[(n >> 12) & 63] + alpha[(n >> 6) & 63];
    if (!url) out += "=";
  }
  return out;
}

// Lenient base64 decode (accepts std + url alphabet, ignores non-alphabet chars),
// matching Node's forgiving Buffer base64 parsing. Returns a Uint8Array.
function decodeBase64(str) {
  const bytes = [];
  let acc = 0;
  let nbits = 0;
  for (let i = 0; i < str.length; i++) {
    const v = B64REV[str.charCodeAt(i) & 0xff];
    if (v < 0) continue; // skip whitespace / '=' / junk
    acc = (acc << 6) | v;
    nbits += 6;
    if (nbits >= 8) {
      nbits -= 8;
      bytes.push((acc >> nbits) & 0xff);
    }
  }
  return Uint8Array.from(bytes);
}

// ------------------------------------------------------------------ slices ---
// (buf, start, end) -> string

const utf8Slice = (buf, start, end) => utf8Decoder.decode(buf.subarray(start, end));

function latin1Slice(buf, start, end) {
  let s = "";
  for (let i = start; i < end; i++) s += String.fromCharCode(buf[i]);
  return s;
}

function asciiSlice(buf, start, end) {
  let s = "";
  for (let i = start; i < end; i++) s += String.fromCharCode(buf[i] & 0x7f);
  return s;
}

function hexSlice(buf, start, end) {
  let s = "";
  for (let i = start; i < end; i++) s += buf[i].toString(16).padStart(2, "0");
  return s;
}

function ucs2Slice(buf, start, end) {
  let s = "";
  for (let i = start; i + 1 < end; i += 2) {
    s += String.fromCharCode(buf[i] | (buf[i + 1] << 8));
  }
  return s;
}

const base64Slice = (buf, start, end) => encodeBase64(buf, start, end, false);
const base64urlSlice = (buf, start, end) => encodeBase64(buf, start, end, true);

// ------------------------------------------------------------------ writes ---
// (buf, string, offset, length) -> bytesWritten

function utf8WriteStatic(buf, string, offset, length) {
  const { written } = encoder.encodeInto(string, buf.subarray(offset, offset + length));
  return written;
}

function asciiWriteStatic(buf, string, offset, length) {
  const n = Math.min(string.length, length);
  for (let i = 0; i < n; i++) buf[offset + i] = string.charCodeAt(i) & 0x7f;
  return n;
}

function latin1WriteStatic(buf, string, offset, length) {
  const n = Math.min(string.length, length);
  for (let i = 0; i < n; i++) buf[offset + i] = string.charCodeAt(i) & 0xff;
  return n;
}

function ucs2Write(buf, string, offset, length) {
  const units = Math.min(string.length, length >> 1);
  let p = offset;
  for (let i = 0; i < units; i++) {
    const c = string.charCodeAt(i);
    buf[p++] = c & 0xff;
    buf[p++] = (c >> 8) & 0xff;
  }
  return units * 2;
}

function hexWrite(buf, string, offset, length) {
  const max = Math.min(length, string.length >> 1);
  let i = 0;
  for (; i < max; i++) {
    const byte = parseInt(string.substr(i * 2, 2), 16);
    if (Number.isNaN(byte)) break;
    buf[offset + i] = byte;
  }
  return i;
}

function base64Write(buf, string, offset, length) {
  const bytes = decodeBase64(string);
  const n = Math.min(length, bytes.length);
  buf.set(bytes.subarray(0, n), offset);
  return n;
}
const base64urlWrite = base64Write; // decoder accepts both alphabets

// ----------------------------------------------------------------- compare ---

function compareRange(a, aStart, aEnd, b, bStart, bEnd) {
  const aLen = aEnd - aStart;
  const bLen = bEnd - bStart;
  const len = Math.min(aLen, bLen);
  for (let i = 0; i < len; i++) {
    const x = a[aStart + i];
    const y = b[bStart + i];
    if (x < y) return -1;
    if (x > y) return 1;
  }
  if (aLen < bLen) return -1;
  if (aLen > bLen) return 1;
  return 0;
}

const compare = (a, b) => compareRange(a, 0, a.length, b, 0, b.length);
const compareOffset = (source, target, targetStart, sourceStart, targetEnd, sourceEnd) =>
  compareRange(source, sourceStart, sourceEnd, target, targetStart, targetEnd);

// -------------------------------------------------------------------- misc ---

function copy(source, target, targetStart, sourceStart, nb) {
  target.set(source.subarray(sourceStart, sourceStart + nb), targetStart);
  return nb;
}

function bindingFill(buf, value, offset, end, encoding) {
  let bytes;
  if (typeof value === "string") {
    const enc = normalizeForFill(encoding);
    bytes = encodeString(value, enc);
  } else {
    bytes = asBytes(value);
  }
  if (!bytes || bytes.length === 0) return -1;
  for (let i = offset, j = 0; i < end; i++, j++) buf[i] = bytes[j % bytes.length];
  return end - offset;
}

function normalizeForFill(encoding) {
  if (!encoding) return "utf8";
  const e = String(encoding).toLowerCase();
  return e === "utf-8" ? "utf8" : e;
}

function encodeString(str, enc) {
  switch (enc) {
    case "utf8":
    case "utf-8":
      return encoder.encode(str);
    case "ascii": {
      const b = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) b[i] = str.charCodeAt(i) & 0x7f;
      return b;
    }
    case "latin1":
    case "binary": {
      const b = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) b[i] = str.charCodeAt(i) & 0xff;
      return b;
    }
    case "utf16le":
    case "ucs2":
    case "ucs-2":
    case "utf-16le": {
      const b = new Uint8Array(str.length * 2);
      for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        b[i * 2] = c & 0xff;
        b[i * 2 + 1] = (c >> 8) & 0xff;
      }
      return b;
    }
    case "hex": {
      const n = str.length >> 1;
      const b = new Uint8Array(n);
      for (let i = 0; i < n; i++) b[i] = parseInt(str.substr(i * 2, 2), 16) || 0;
      return b;
    }
    case "base64":
    case "base64url":
      return decodeBase64(str);
    default:
      return encoder.encode(str);
  }
}

// --------------------------------------------------------------- searching ---

function byteSearch(haystack, needle, byteOffset, dir) {
  const len = haystack.length;
  const nlen = needle.length;
  if (nlen === 0) return dir ? Math.max(0, Math.min(byteOffset, len)) : len;
  if (nlen > len) return -1;
  if (dir) {
    let start = byteOffset < 0 ? Math.max(len + byteOffset, 0) : byteOffset;
    for (let i = start; i <= len - nlen; i++) {
      let m = true;
      for (let j = 0; j < nlen; j++) {
        if (haystack[i + j] !== needle[j]) {
          m = false;
          break;
        }
      }
      if (m) return i;
    }
    return -1;
  }
  let start = byteOffset < 0 ? len + byteOffset : byteOffset;
  if (start > len - nlen) start = len - nlen;
  for (let i = start; i >= 0; i--) {
    let m = true;
    for (let j = 0; j < nlen; j++) {
      if (haystack[i + j] !== needle[j]) {
        m = false;
        break;
      }
    }
    if (m) return i;
  }
  return -1;
}

const indexOfBuffer = (buf, val, byteOffset, _encoding, dir) =>
  byteSearch(buf, asBytes(val), byteOffset, dir);

function indexOfNumber(buf, val, byteOffset, dir) {
  const len = buf.length;
  const target = val & 0xff;
  if (dir) {
    for (let i = byteOffset < 0 ? Math.max(len + byteOffset, 0) : byteOffset; i < len; i++) {
      if (buf[i] === target) return i;
    }
  } else {
    let start = byteOffset < 0 ? len + byteOffset : byteOffset;
    if (start >= len) start = len - 1;
    for (let i = start; i >= 0; i--) if (buf[i] === target) return i;
  }
  return -1;
}

const indexOfString = (buf, val, byteOffset, encoding, dir) =>
  byteSearch(buf, encodeString(val, normalizeForFill(encoding)), byteOffset, dir);

// ---------------------------------------------------------------- byteswap ---

function swap16(buf) {
  for (let i = 0; i < buf.length; i += 2) {
    const t = buf[i];
    buf[i] = buf[i + 1];
    buf[i + 1] = t;
  }
  return buf;
}
function swap32(buf) {
  for (let i = 0; i < buf.length; i += 4) {
    let t = buf[i];
    buf[i] = buf[i + 3];
    buf[i + 3] = t;
    t = buf[i + 1];
    buf[i + 1] = buf[i + 2];
    buf[i + 2] = t;
  }
  return buf;
}
function swap64(buf) {
  for (let i = 0; i < buf.length; i += 8) {
    for (let j = 0; j < 4; j++) {
      const t = buf[i + j];
      buf[i + j] = buf[i + 7 - j];
      buf[i + 7 - j] = t;
    }
  }
  return buf;
}

// ------------------------------------------------------------- atob / btoa ---

function btoa(str) {
  const b = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c > 0xff) return -1;
    b[i] = c;
  }
  return encodeBase64(b, 0, b.length, false);
}

function atob(str) {
  let clean = "";
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f") continue;
    clean += c;
  }
  for (let i = 0; i < clean.length; i++) {
    const ch = clean.charCodeAt(i);
    if (B64REV[ch & 0xff] < 0 && clean[i] !== "=") return -2;
  }
  const bytes = decodeBase64(clean);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

// ----------------------------------------------------------------- exports ---

export function createBufferBinding() {
  return {
    kMaxLength: 4294967295,
    kStringMaxLength: 536870888,

    byteLengthUtf8: (str) => encoder.encode(str).length,
    compare,
    compareOffset,
    copy,
    fill: bindingFill,
    isAscii: (input) => {
      const b = asBytes(input);
      for (let i = 0; i < b.length; i++) if (b[i] > 127) return false;
      return true;
    },
    isUtf8: (input) => {
      try {
        utf8Strict.decode(asBytes(input));
        return true;
      } catch {
        return false;
      }
    },
    indexOfBuffer,
    indexOfNumber,
    indexOfString,
    swap16,
    swap32,
    swap64,
    atob,
    btoa,

    asciiSlice,
    base64Slice,
    base64urlSlice,
    latin1Slice,
    hexSlice,
    ucs2Slice,
    utf8Slice,

    asciiWriteStatic,
    latin1WriteStatic,
    utf8WriteStatic,
    base64Write,
    base64urlWrite,
    hexWrite,
    ucs2Write,

    createUnsafeArrayBuffer: (size) => new ArrayBuffer(size),
    setDetachKey: () => {},
  };
}
