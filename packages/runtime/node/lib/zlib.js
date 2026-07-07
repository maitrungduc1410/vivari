// Minimal `zlib` builtin. The browser exposes gzip/deflate through the async
// Compression/DecompressionStream Web APIs; we wrap them as Node Transform
// streams (collect-then-transform — correct for the request/response bodies
// userland libs like body-parser push through). Brotli and the *Sync variants
// have no Web equivalent, so they throw loudly instead of pretending.
//
// This is enough for body-parser/compression to LOAD and to actually handle
// gzip/deflate-encoded bodies; it is a partial implementation (Phase 2 #11).

export default function (exports, require, module) {
  const { Transform } = require("stream");
  const { Buffer } = require("buffer");

  const hasWebStreams =
    typeof globalThis.DecompressionStream === "function" &&
    typeof globalThis.CompressionStream === "function";

  // kind: "compress" | "decompress"; fmt: "gzip" | "deflate" | "deflate-raw"
  function webCodec(kind, fmt, label) {
    const t = new Transform();
    const chunks = [];
    t._transform = function (chunk, enc, cb) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk, enc) : Buffer.from(chunk));
      cb();
    };
    t._flush = function (cb) {
      if (!hasWebStreams) {
        cb(new Error(`OpenContainer zlib: ${label} unavailable (no Web Compression Streams)`));
        return;
      }
      (async () => {
        try {
          const input = Buffer.concat(chunks);
          const Ctor = kind === "compress" ? globalThis.CompressionStream : globalThis.DecompressionStream;
          const cs = new Ctor(fmt);
          const writer = cs.writable.getWriter();
          writer.write(input);
          writer.close();
          const reader = cs.readable.getReader();
          const out = [];
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            out.push(Buffer.from(value));
          }
          t.push(Buffer.concat(out));
          cb();
        } catch (e) {
          cb(e);
        }
      })();
    };
    return t;
  }

  const notSupported = (name) => () => {
    throw new Error(`OpenContainer zlib: ${name} is not supported in the browser runtime`);
  };
  const brotli = (name) => () => {
    const t = new Transform();
    t._transform = (_c, _e, cb) => cb(new Error(`OpenContainer zlib: ${name} (brotli) is not supported yet`));
    return t;
  };

  // Standard flush/return-code constants — libs read these at module scope.
  const constants = {
    Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3,
    Z_FINISH: 4, Z_BLOCK: 5, Z_TREES: 6,
    Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1, Z_STREAM_ERROR: -2,
    Z_DATA_ERROR: -3, Z_MEM_ERROR: -4, Z_BUF_ERROR: -5, Z_VERSION_ERROR: -6,
    Z_NO_COMPRESSION: 0, Z_BEST_SPEED: 1, Z_BEST_COMPRESSION: 9, Z_DEFAULT_COMPRESSION: -1,
    Z_DEFAULT_STRATEGY: 0, Z_DEFAULT_WINDOWBITS: 15, Z_DEFAULT_MEMLEVEL: 8,
    BROTLI_OPERATION_PROCESS: 0, BROTLI_OPERATION_FLUSH: 1, BROTLI_OPERATION_FINISH: 2,
  };

  module.exports = {
    createGzip: () => webCodec("compress", "gzip", "gzip"),
    createGunzip: () => webCodec("decompress", "gzip", "gunzip"),
    createDeflate: () => webCodec("compress", "deflate", "deflate"),
    createInflate: () => webCodec("decompress", "deflate", "inflate"),
    createDeflateRaw: () => webCodec("compress", "deflate-raw", "deflateRaw"),
    createInflateRaw: () => webCodec("decompress", "deflate-raw", "inflateRaw"),
    // unzip auto-detects gzip vs zlib; we default to gzip (most common on the wire).
    createUnzip: () => webCodec("decompress", "gzip", "unzip"),
    createBrotliCompress: brotli("createBrotliCompress"),
    createBrotliDecompress: brotli("createBrotliDecompress"),

    gzipSync: notSupported("gzipSync"),
    gunzipSync: notSupported("gunzipSync"),
    deflateSync: notSupported("deflateSync"),
    inflateSync: notSupported("inflateSync"),
    deflateRawSync: notSupported("deflateRawSync"),
    inflateRawSync: notSupported("inflateRawSync"),
    brotliCompressSync: notSupported("brotliCompressSync"),
    brotliDecompressSync: notSupported("brotliDecompressSync"),

    // async one-shots delegate to the stream codecs.
    gzip: cb1("compress", "gzip"),
    gunzip: cb1("decompress", "gzip"),
    deflate: cb1("compress", "deflate"),
    inflate: cb1("decompress", "deflate"),

    constants,
    codes: constants,
  };

  function cb1(kind, fmt) {
    return function (buf, opts, cb) {
      if (typeof opts === "function") { cb = opts; }
      const stream = webCodec(kind, fmt, fmt);
      const out = [];
      stream.on("data", (d) => out.push(d));
      stream.on("end", () => cb(null, Buffer.concat(out)));
      stream.on("error", (e) => cb(e));
      stream.end(typeof buf === "string" ? Buffer.from(buf) : buf);
    };
  }
}
