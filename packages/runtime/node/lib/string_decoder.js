// string_decoder — pure-JS StringDecoder (Phase 2 #6).
//
// NOT verbatim: Node's lib/string_decoder.js wraps a native C++ decoder via
// internalBinding('string_decoder') (an opaque state buffer). Rather than
// reimplement that native contract, we use the canonical pure-JS algorithm from
// the `string_decoder` npm package (MIT, by the Node/readable-stream team) — the
// exact implementation readable-stream ships to browsers. It produces identical
// output for utf8 / utf16le(ucs2) / base64 and passes through the rest, running
// on our REAL Buffer. This is the only StringDecoder consumers need (Readable's
// setEncoding). Wrapped as a builtin factory to match the loader.
export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const Buffer = require("buffer").Buffer;

  const isEncoding =
    Buffer.isEncoding ||
    function (encoding) {
      encoding = "" + encoding;
      switch (encoding && encoding.toLowerCase()) {
        case "hex":
        case "utf8":
        case "utf-8":
        case "ascii":
        case "binary":
        case "base64":
        case "ucs2":
        case "ucs-2":
        case "utf16le":
        case "utf-16le":
        case "raw":
          return true;
        default:
          return false;
      }
    };

  function _normalizeEncoding(enc) {
    if (!enc) return "utf8";
    let retried;
    for (;;) {
      switch (enc) {
        case "utf8":
        case "utf-8":
          return "utf8";
        case "ucs2":
        case "ucs-2":
        case "utf16le":
        case "utf-16le":
          return "utf16le";
        case "latin1":
        case "binary":
          return "latin1";
        case "base64":
        case "ascii":
        case "hex":
          return enc;
        default:
          if (retried) return; // undefined
          enc = ("" + enc).toLowerCase();
          retried = true;
      }
    }
  }

  function normalizeEncoding(enc) {
    const nenc = _normalizeEncoding(enc);
    if (typeof nenc !== "string" && (Buffer.isEncoding === isEncoding || !isEncoding(enc)))
      throw new Error("Unknown encoding: " + enc);
    return nenc || enc;
  }

  function StringDecoder(encoding) {
    this.encoding = normalizeEncoding(encoding);
    let nb;
    switch (this.encoding) {
      case "utf16le":
        this.text = utf16Text;
        this.end = utf16End;
        nb = 4;
        break;
      case "utf8":
        this.fillLast = utf8FillLast;
        nb = 4;
        break;
      case "base64":
        this.text = base64Text;
        this.end = base64End;
        nb = 3;
        break;
      default:
        this.write = simpleWrite;
        this.end = simpleEnd;
        return;
    }
    this.lastNeed = 0;
    this.lastTotal = 0;
    this.lastChar = Buffer.allocUnsafe(nb);
  }

  StringDecoder.prototype.write = function (buf) {
    if (buf.length === 0) return "";
    let r;
    let i;
    if (this.lastNeed) {
      r = this.fillLast(buf);
      if (r === undefined) return "";
      i = this.lastNeed;
      this.lastNeed = 0;
    } else {
      i = 0;
    }
    if (i < buf.length) return r ? r + this.text(buf, i) : this.text(buf, i);
    return r || "";
  };

  StringDecoder.prototype.end = utf8End;
  StringDecoder.prototype.text = utf8Text;

  StringDecoder.prototype.fillLast = function (buf) {
    if (this.lastNeed <= buf.length) {
      buf.copy(this.lastChar, this.lastTotal - this.lastNeed, 0, this.lastNeed);
      return this.lastChar.toString(this.encoding, 0, this.lastTotal);
    }
    buf.copy(this.lastChar, this.lastTotal - this.lastNeed, 0, buf.length);
    this.lastNeed -= buf.length;
  };

  function utf8CheckByte(byte) {
    if (byte <= 0x7f) return 0;
    else if (byte >> 5 === 0x06) return 2;
    else if (byte >> 4 === 0x0e) return 3;
    else if (byte >> 3 === 0x1e) return 4;
    return byte >> 6 === 0x02 ? -1 : -2;
  }

  function utf8CheckIncomplete(self, buf, i) {
    let j = buf.length - 1;
    if (j < i) return 0;
    let nb = utf8CheckByte(buf[j]);
    if (nb >= 0) {
      if (nb > 0) self.lastNeed = nb - 1;
      return nb;
    }
    if (--j < i || nb === -2) return 0;
    nb = utf8CheckByte(buf[j]);
    if (nb >= 0) {
      if (nb > 0) self.lastNeed = nb - 2;
      return nb;
    }
    if (--j < i || nb === -2) return 0;
    nb = utf8CheckByte(buf[j]);
    if (nb >= 0) {
      if (nb > 0) {
        if (nb === 2) nb = 0;
        else self.lastNeed = nb - 3;
      }
      return nb;
    }
    return 0;
  }

  function utf8CheckExtraBytes(self, buf) {
    if ((buf[0] & 0xc0) !== 0x80) {
      self.lastNeed = 0;
      return "\ufffd";
    }
    if (self.lastNeed > 1 && buf.length > 1) {
      if ((buf[1] & 0xc0) !== 0x80) {
        self.lastNeed = 1;
        return "\ufffd";
      }
      if (self.lastNeed > 2 && buf.length > 2) {
        if ((buf[2] & 0xc0) !== 0x80) {
          self.lastNeed = 2;
          return "\ufffd";
        }
      }
    }
  }

  function utf8FillLast(buf) {
    const p = this.lastTotal - this.lastNeed;
    const r = utf8CheckExtraBytes(this, buf);
    if (r !== undefined) return r;
    if (this.lastNeed <= buf.length) {
      buf.copy(this.lastChar, p, 0, this.lastNeed);
      return this.lastChar.toString(this.encoding, 0, this.lastTotal);
    }
    buf.copy(this.lastChar, p, 0, buf.length);
    this.lastNeed -= buf.length;
  }

  function utf8Text(buf, i) {
    const total = utf8CheckIncomplete(this, buf, i);
    if (!this.lastNeed) return buf.toString("utf8", i);
    this.lastTotal = total;
    const end = buf.length - (total - this.lastNeed);
    buf.copy(this.lastChar, 0, end);
    return buf.toString("utf8", i, end);
  }

  function utf8End(buf) {
    const r = buf && buf.length ? this.write(buf) : "";
    if (this.lastNeed) return r + "\ufffd";
    return r;
  }

  function utf16Text(buf, i) {
    if ((buf.length - i) % 2 === 0) {
      const r = buf.toString("utf16le", i);
      if (r) {
        const c = r.charCodeAt(r.length - 1);
        if (c >= 0xd800 && c <= 0xdbff) {
          this.lastNeed = 2;
          this.lastTotal = 4;
          this.lastChar[0] = buf[buf.length - 2];
          this.lastChar[1] = buf[buf.length - 1];
          return r.slice(0, -1);
        }
      }
      return r;
    }
    this.lastNeed = 1;
    this.lastTotal = 2;
    this.lastChar[0] = buf[buf.length - 1];
    return buf.toString("utf16le", i, buf.length - 1);
  }

  function utf16End(buf) {
    const r = buf && buf.length ? this.write(buf) : "";
    if (this.lastNeed) {
      const end = this.lastTotal - this.lastNeed;
      return r + this.lastChar.toString("utf16le", 0, end);
    }
    return r;
  }

  function base64Text(buf, i) {
    const n = (buf.length - i) % 3;
    if (n === 0) return buf.toString("base64", i);
    this.lastNeed = 3 - n;
    this.lastTotal = 3;
    if (n === 1) {
      this.lastChar[0] = buf[buf.length - 1];
    } else {
      this.lastChar[0] = buf[buf.length - 2];
      this.lastChar[1] = buf[buf.length - 1];
    }
    return buf.toString("base64", i, buf.length - n);
  }

  function base64End(buf) {
    const r = buf && buf.length ? this.write(buf) : "";
    if (this.lastNeed) return r + this.lastChar.toString("base64", 0, 3 - this.lastNeed);
    return r;
  }

  function simpleWrite(buf) {
    return buf.toString(this.encoding);
  }

  function simpleEnd(buf) {
    return buf && buf.length ? this.write(buf) : "";
  }

  exports.StringDecoder = StringDecoder;
}
