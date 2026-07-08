// internalBinding('zlib') — the native seam beneath Node's real lib/zlib.js
// (Phase 2 #11). In real Node this is the C++ wrapper around libz/brotli/zstd.
// Here it's a thin JS adapter over our Rust/Wasm streaming codec
// (packages/codec, flate2/miniz_oxide), driven exactly like Node's C++ binding:
//
//   handle = new Zlib(mode)
//   handle.init(windowBits, level, memLevel, strategy, writeState, cb, dict)
//   handle.writeSync(flush, in, inOff, inLen, out, outOff, outLen)   // sync path
//   handle.write(...)                                                // async path
//   -> writeState[0] = availOutAfter, writeState[1] = availInAfter
//
// The codec exposes a z_stream-accurate `process(input, flush, outLen)` that
// respects avail_in/avail_out, so lib/zlib.js's chunk loop works unchanged.

const EMPTY = new Uint8Array(0);

// node_zlib_mode enum (matches src/node_zlib.cc order); brotli/zstd are present
// so lib/zlib.js's module-level range asserts pass, but their handles throw.
const MODES = {
  DEFLATE: 1,
  INFLATE: 2,
  GZIP: 3,
  GUNZIP: 4,
  DEFLATERAW: 5,
  INFLATERAW: 6,
  UNZIP: 7,
  BROTLI_DECODE: 8,
  BROTLI_ENCODE: 9,
  ZSTD_COMPRESS: 10,
  ZSTD_DECOMPRESS: 11,
};

// The full zlib constant surface lib/zlib.js destructures. Values match zlib.h /
// Node. brotli/zstd op codes are included so the module loads; unused otherwise.
export const ZLIB_CONSTANTS = {
  // flush levels
  Z_NO_FLUSH: 0,
  Z_PARTIAL_FLUSH: 1,
  Z_SYNC_FLUSH: 2,
  Z_FULL_FLUSH: 3,
  Z_FINISH: 4,
  Z_BLOCK: 5,
  Z_TREES: 6,
  // return codes
  Z_OK: 0,
  Z_STREAM_END: 1,
  Z_NEED_DICT: 2,
  Z_ERRNO: -1,
  Z_STREAM_ERROR: -2,
  Z_DATA_ERROR: -3,
  Z_MEM_ERROR: -4,
  Z_BUF_ERROR: -5,
  Z_VERSION_ERROR: -6,
  // compression levels
  Z_NO_COMPRESSION: 0,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: -1,
  // strategy
  Z_FILTERED: 1,
  Z_HUFFMAN_ONLY: 2,
  Z_RLE: 3,
  Z_FIXED: 4,
  Z_DEFAULT_STRATEGY: 0,
  // data type
  Z_BINARY: 0,
  Z_TEXT: 1,
  Z_ASCII: 1,
  Z_UNKNOWN: 2,
  // method
  Z_DEFLATED: 8,
  // option ranges/defaults
  Z_MIN_WINDOWBITS: 8,
  Z_MAX_WINDOWBITS: 15,
  Z_DEFAULT_WINDOWBITS: 15,
  Z_MIN_CHUNK: 64,
  Z_MAX_CHUNK: Infinity,
  Z_DEFAULT_CHUNK: 16384,
  Z_MIN_MEMLEVEL: 1,
  Z_MAX_MEMLEVEL: 9,
  Z_DEFAULT_MEMLEVEL: 8,
  Z_MIN_LEVEL: -1,
  Z_MAX_LEVEL: 9,
  Z_DEFAULT_LEVEL: -1,
  // stream modes
  ...MODES,
  // brotli operations (~flush levels)
  BROTLI_OPERATION_PROCESS: 0,
  BROTLI_OPERATION_FLUSH: 1,
  BROTLI_OPERATION_FINISH: 2,
  BROTLI_OPERATION_EMIT_METADATA: 3,
  // zstd end directives (~flush levels)
  ZSTD_e_continue: 0,
  ZSTD_e_flush: 1,
  ZSTD_e_end: 2,
};

// Standard IEEE CRC-32 with a resumable seed, matching zlib's crc32(seed, buf).
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data, seed = 0) {
  let bytes;
  if (typeof data === "string") {
    bytes = new TextEncoder().encode(data);
  } else if (data instanceof Uint8Array) {
    bytes = data;
  } else if (ArrayBuffer.isView(data)) {
    bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  } else {
    bytes = new Uint8Array(data);
  }
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    crc = (CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// makeZStream(mode, level, windowBits) -> codec stream, or null when the wasm
// codec isn't wired for this process (then only crc32/constants work).
export function createZlibBinding({ makeZStream, process }) {
  class Zlib {
    constructor(mode) {
      this.mode = mode;
    }

    init(windowBits, level, _memLevel, _strategy, writeState, processCallback, _dictionary) {
      if (!makeZStream) {
        throw new Error("OpenContainer: zlib wasm codec is not available in this process");
      }
      this.windowBits = windowBits;
      this.level = level;
      this._writeState = writeState;
      this._cb = processCallback;
      this._z = makeZStream(this.mode, level, windowBits);
      // NB: preset dictionaries and memLevel/strategy are accepted for API
      // parity but not applied by the miniz_oxide backend.
      return this;
    }

    _run(flush, inBuf, inOff, inLen, outBuf, outOff, outLen) {
      const input = inLen > 0 ? inBuf.subarray(inOff, inOff + inLen) : EMPTY;
      const produced = this._z.process(input, flush, outLen);
      if (produced.length) outBuf.set(produced, outOff);
      this._writeState[0] = outLen - produced.length; // availOutAfter
      this._writeState[1] = inLen - this._z.consumed; // availInAfter
      if (this._z.errored && typeof this.onerror === "function") {
        // Z_DATA_ERROR: the only failure our one-shot codec surfaces.
        this.onerror("unexpected end of file", -3, "Z_DATA_ERROR");
      }
    }

    writeSync(flush, inBuf, inOff, inLen, outBuf, outOff, outLen) {
      this._run(flush, inBuf, inOff, inLen, outBuf, outOff, outLen);
    }

    write(flush, inBuf, inOff, inLen, outBuf, outOff, outLen) {
      // The work is synchronous, but Node's contract is async: the C++ binding
      // runs on the threadpool and then invokes the JS callback. We mirror that
      // by deferring processCallback (bound to this handle) onto nextTick, so
      // ZlibBase.processCallback drives continuation exactly as in real Node.
      this._run(flush, inBuf, inOff, inLen, outBuf, outOff, outLen);
      const cb = this._cb;
      const self = this;
      process.nextTick(() => cb.call(self));
      return this;
    }

    reset() {
      if (this._z) this._z.reset();
    }

    // params() adjusts level/strategy mid-stream in real zlib (deflateParams).
    // The pure-Rust backend can't retune an in-flight stream; accept and ignore.
    params(_level, _strategy) {}

    close() {
      this._z = null;
    }
  }

  return { Zlib, crc32 };
}
