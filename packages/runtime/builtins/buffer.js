// A minimal Node `Buffer` polyfill on top of Uint8Array. Enough for typical
// program usage: Buffer.from/alloc/concat/isBuffer and toString/write in
// utf8/hex/base64/latin1. `atob`/`btoa` exist in both browser workers and Node.

export function createBuffer() {
  const enc = new TextEncoder();
  const dec = new TextDecoder();

  const b64encode = (bytes) => {
    let s = "";
    for (const byte of bytes) s += String.fromCharCode(byte);
    return btoa(s);
  };
  const b64decode = (str) => {
    const s = atob(str);
    const a = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  };

  function fromString(str, encoding = "utf8") {
    encoding = String(encoding).toLowerCase();
    if (encoding === "utf8" || encoding === "utf-8") return new Buffer(enc.encode(str));
    if (encoding === "hex") {
      const a = new Buffer(str.length >> 1);
      for (let i = 0; i < a.length; i++) a[i] = parseInt(str.substr(i * 2, 2), 16);
      return a;
    }
    if (encoding === "base64") return new Buffer(b64decode(str));
    if (encoding === "ascii" || encoding === "latin1" || encoding === "binary") {
      const a = new Buffer(str.length);
      for (let i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) & 0xff;
      return a;
    }
    return new Buffer(enc.encode(str));
  }

  class Buffer extends Uint8Array {
    static from(value, encoding) {
      if (typeof value === "string") return fromString(value, encoding);
      if (value instanceof ArrayBuffer) return new Buffer(value);
      if (value instanceof Uint8Array || Array.isArray(value)) return new Buffer(value);
      return new Buffer(value);
    }
    static alloc(size, fill = 0) {
      const buf = new Buffer(size);
      if (fill) buf.fill(fill);
      return buf;
    }
    static allocUnsafe(size) {
      return new Buffer(size);
    }
    static concat(list, totalLength) {
      if (totalLength == null) totalLength = list.reduce((n, b) => n + b.length, 0);
      const out = new Buffer(totalLength);
      let off = 0;
      for (const b of list) {
        if (off >= totalLength) break;
        const take = Math.min(b.length, totalLength - off);
        out.set(b.subarray(0, take), off);
        off += take;
      }
      return out;
    }
    static isBuffer(x) {
      return x instanceof Buffer;
    }
    static isEncoding(e) {
      return ["utf8", "utf-8", "hex", "base64", "ascii", "latin1", "binary"].includes(
        String(e).toLowerCase(),
      );
    }
    static byteLength(str, encoding = "utf8") {
      return fromString(String(str), encoding).length;
    }

    toString(encoding = "utf8", start = 0, end = this.length) {
      const slice = this.subarray(start, end);
      encoding = String(encoding).toLowerCase();
      if (encoding === "utf8" || encoding === "utf-8") return dec.decode(slice);
      if (encoding === "hex")
        return Array.from(slice, (b) => b.toString(16).padStart(2, "0")).join("");
      if (encoding === "base64") return b64encode(slice);
      if (encoding === "ascii" || encoding === "latin1" || encoding === "binary")
        return String.fromCharCode(...slice);
      return dec.decode(slice);
    }
    toJSON() {
      return { type: "Buffer", data: Array.from(this) };
    }
    equals(other) {
      if (this.length !== other.length) return false;
      for (let i = 0; i < this.length; i++) if (this[i] !== other[i]) return false;
      return true;
    }
    write(str, offset = 0, length, encoding = "utf8") {
      if (typeof length === "string") {
        encoding = length;
        length = undefined;
      }
      const bytes = fromString(str, encoding);
      const n = Math.min(bytes.length, length ?? this.length - offset);
      this.set(bytes.subarray(0, n), offset);
      return n;
    }
  }

  return Buffer;
}
