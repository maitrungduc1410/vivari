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

// node_zlib_mode enum (matches src/node_zlib.cc order). Brotli is backed by the
// codec; zstd is present so lib/zlib.js's module-level range asserts pass, but
// its handles throw.
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
  // No Z_TREES / Z_BINARY / Z_TEXT / Z_ASCII / Z_UNKNOWN / Z_DEFLATED: they are
  // real zlib values, and Node's zlib.constants does not carry them (a guest reads
  // undefined there). Exposing more than Node does is the direction that makes code
  // work here and fail on Node.
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
  // brotli encoder parameters. These are load-bearing twice over: they are what
  // `{ params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }` reads (an absent one
  // is `undefined`, which lib/zlib.js rejects as ERR_BROTLI_INVALID_PARAM), and
  // lib/zlib.js sizes its params array by the LARGEST BROTLI_PARAM_* it can find
  // here — so a missing key silently truncates the array for every other param.
  BROTLI_PARAM_MODE: 0,
  BROTLI_MODE_GENERIC: 0,
  BROTLI_MODE_TEXT: 1,
  BROTLI_MODE_FONT: 2,
  BROTLI_DEFAULT_MODE: 0,
  BROTLI_PARAM_QUALITY: 1,
  BROTLI_MIN_QUALITY: 0,
  BROTLI_MAX_QUALITY: 11,
  BROTLI_DEFAULT_QUALITY: 11,
  BROTLI_PARAM_LGWIN: 2,
  BROTLI_MIN_WINDOW_BITS: 10,
  BROTLI_MAX_WINDOW_BITS: 24,
  BROTLI_LARGE_MAX_WINDOW_BITS: 30,
  BROTLI_DEFAULT_WINDOW: 22,
  BROTLI_PARAM_LGBLOCK: 3,
  BROTLI_MIN_INPUT_BLOCK_BITS: 16,
  BROTLI_MAX_INPUT_BLOCK_BITS: 24,
  BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING: 4,
  BROTLI_PARAM_SIZE_HINT: 5,
  BROTLI_PARAM_LARGE_WINDOW: 6,
  BROTLI_PARAM_NPOSTFIX: 7,
  BROTLI_PARAM_NDIRECT: 8,
  // brotli decoder results/params/error codes. Ours reports one failure rather
  // than these 25 distinct ones, but the names have to resolve: libraries print
  // and compare them, and an undefined comparand matches nothing.
  BROTLI_DECODER_RESULT_ERROR: 0,
  BROTLI_DECODER_RESULT_SUCCESS: 1,
  BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT: 2,
  BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT: 3,
  BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION: 0,
  BROTLI_DECODER_PARAM_LARGE_WINDOW: 1,
  BROTLI_DECODER_NO_ERROR: 0,
  BROTLI_DECODER_SUCCESS: 1,
  BROTLI_DECODER_NEEDS_MORE_INPUT: 2,
  BROTLI_DECODER_NEEDS_MORE_OUTPUT: 3,
  BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE: -1,
  BROTLI_DECODER_ERROR_FORMAT_RESERVED: -2,
  BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_META_NIBBLE: -3,
  BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET: -4,
  BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME: -5,
  BROTLI_DECODER_ERROR_FORMAT_CL_SPACE: -6,
  BROTLI_DECODER_ERROR_FORMAT_HUFFMAN_SPACE: -7,
  BROTLI_DECODER_ERROR_FORMAT_CONTEXT_MAP_REPEAT: -8,
  BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_1: -9,
  BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_2: -10,
  BROTLI_DECODER_ERROR_FORMAT_TRANSFORM: -11,
  BROTLI_DECODER_ERROR_FORMAT_DICTIONARY: -12,
  BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS: -13,
  BROTLI_DECODER_ERROR_FORMAT_PADDING_1: -14,
  BROTLI_DECODER_ERROR_FORMAT_PADDING_2: -15,
  BROTLI_DECODER_ERROR_FORMAT_DISTANCE: -16,
  BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET: -19,
  BROTLI_DECODER_ERROR_INVALID_ARGUMENTS: -20,
  BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES: -21,
  BROTLI_DECODER_ERROR_ALLOC_TREE_GROUPS: -22,
  BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MAP: -25,
  BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1: -26,
  BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2: -27,
  BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES: -30,
  BROTLI_DECODER_ERROR_UNREACHABLE: -31,
  // zstd end directives (~flush levels)
  ZSTD_e_continue: 0,
  ZSTD_e_flush: 1,
  ZSTD_e_end: 2,
  // Zstandard's parameter/strategy/error tables. We do not implement zstd (see
  // ZstdCompress below), but the constants are read before any handle is made:
  // lib/zlib.js sizes its params array by the largest ZSTD_c_* value, so leaving
  // them out turns a plain `zstdCompressSync(buf)` into ERR_ZSTD_INVALID_PARAM
  // naming the caller's option, instead of the "no zstd codec" error that says
  // what is actually missing. Same trap the brotli table fell into.
  ZLIB_VERNUM: 4880,
  ZSTD_DECOMPRESS: 11,
  ZSTD_COMPRESS: 10,
  ZSTD_e_continue: 0,
  ZSTD_e_flush: 1,
  ZSTD_e_end: 2,
  ZSTD_fast: 1,
  ZSTD_dfast: 2,
  ZSTD_greedy: 3,
  ZSTD_lazy: 4,
  ZSTD_lazy2: 5,
  ZSTD_btlazy2: 6,
  ZSTD_btopt: 7,
  ZSTD_btultra: 8,
  ZSTD_btultra2: 9,
  ZSTD_c_compressionLevel: 100,
  ZSTD_c_windowLog: 101,
  ZSTD_c_hashLog: 102,
  ZSTD_c_chainLog: 103,
  ZSTD_c_searchLog: 104,
  ZSTD_c_minMatch: 105,
  ZSTD_c_targetLength: 106,
  ZSTD_c_strategy: 107,
  ZSTD_c_enableLongDistanceMatching: 160,
  ZSTD_c_ldmHashLog: 161,
  ZSTD_c_ldmMinMatch: 162,
  ZSTD_c_ldmBucketSizeLog: 163,
  ZSTD_c_ldmHashRateLog: 164,
  ZSTD_c_contentSizeFlag: 200,
  ZSTD_c_checksumFlag: 201,
  ZSTD_c_dictIDFlag: 202,
  ZSTD_c_nbWorkers: 400,
  ZSTD_c_jobSize: 401,
  ZSTD_c_overlapLog: 402,
  ZSTD_d_windowLogMax: 100,
  ZSTD_CLEVEL_DEFAULT: 3,
  ZSTD_error_no_error: 0,
  ZSTD_error_GENERIC: 1,
  ZSTD_error_prefix_unknown: 10,
  ZSTD_error_version_unsupported: 12,
  ZSTD_error_frameParameter_unsupported: 14,
  ZSTD_error_frameParameter_windowTooLarge: 16,
  ZSTD_error_corruption_detected: 20,
  ZSTD_error_checksum_wrong: 22,
  ZSTD_error_literals_headerWrong: 24,
  ZSTD_error_dictionary_corrupted: 30,
  ZSTD_error_dictionary_wrong: 32,
  ZSTD_error_dictionaryCreation_failed: 34,
  ZSTD_error_parameter_unsupported: 40,
  ZSTD_error_parameter_combination_unsupported: 41,
  ZSTD_error_parameter_outOfBound: 42,
  ZSTD_error_tableLog_tooLarge: 44,
  ZSTD_error_maxSymbolValue_tooLarge: 46,
  ZSTD_error_maxSymbolValue_tooSmall: 48,
  ZSTD_error_stabilityCondition_notRespected: 50,
  ZSTD_error_stage_wrong: 60,
  ZSTD_error_init_missing: 62,
  ZSTD_error_memory_allocation: 64,
  ZSTD_error_workSpace_tooSmall: 66,
  ZSTD_error_dstSize_tooSmall: 70,
  ZSTD_error_srcSize_wrong: 72,
  ZSTD_error_dstBuffer_null: 74,
  ZSTD_error_noForwardProgress_destFull: 80,
  ZSTD_error_noForwardProgress_inputEmpty: 82
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

// makeZStream(mode, level, windowBits, brotliParams) -> codec stream, or null
// when the wasm codec isn't wired for this process (then only crc32/constants
// work). One factory serves both engines because `mode` already distinguishes
// them: 8/9 are brotli, everything below is zlib.
export function createZlibBinding({ makeZStream, process }) {
  // Everything a handle does once it has a stream. Zlib and Brotli differ only
  // in their init() signature — Node's C++ has the same split (ZlibStream vs
  // BrotliEncoderStream) over one CompressionStream template.
  class Handle {
    constructor(mode) {
      this.mode = mode;
    }

    _run(flush, inBuf, inOff, inLen, outBuf, outOff, outLen) {
      const input = inLen > 0 ? inBuf.subarray(inOff, inOff + inLen) : EMPTY;
      const produced = this._z.process(input, flush, outLen);
      if (produced.length) outBuf.set(produced, outOff);
      this._writeState[0] = outLen - produced.length; // availOutAfter
      this._writeState[1] = inLen - this._z.consumed; // availInAfter
      if (this._z.errored && typeof this.onerror === "function") {
        this.onerror(...this._errorArgs());
      }
    }

    // Z_DATA_ERROR: the only failure our zlib codec surfaces.
    _errorArgs() {
      return ["unexpected end of file", -3, "Z_DATA_ERROR"];
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

    _make(...args) {
      if (!makeZStream) {
        throw new Error("Vivari: zlib wasm codec is not available in this process");
      }
      return makeZStream(...args);
    }
  }

  class Zlib extends Handle {
    init(windowBits, level, _memLevel, _strategy, writeState, processCallback, _dictionary) {
      this.windowBits = windowBits;
      this.level = level;
      this._writeState = writeState;
      this._cb = processCallback;
      this._z = this._make(this.mode, level, windowBits);
      // NB: preset dictionaries and memLevel/strategy are accepted for API
      // parity but not applied by the miniz_oxide backend.
      return this;
    }
  }

  // Brotli. lib/zlib.js hands init() the params array it built (a Uint32Array
  // holding -1 for "unset", which is why we reinterpret it as Int32Array before
  // it crosses into Rust) rather than zlib's positional level/windowBits.
  class Brotli extends Handle {
    init(params, writeState, processCallback, dictionary) {
      if (dictionary !== undefined) {
        // A custom dictionary changes the bytes on the wire, so accepting and
        // ignoring it would produce a stream the peer cannot read.
        throw new Error("Vivari: node:zlib brotli custom dictionaries are not supported");
      }
      this._writeState = writeState;
      this._cb = processCallback;
      const signed = new Int32Array(params.buffer, params.byteOffset, params.length);
      this._z = this._make(this.mode, -1, -1, signed);
      return this;
    }

    // Brotli has no zlib errno; Node reports the engine's own code. Ours is one
    // engine-level failure, and it can only come from input that isn't brotli.
    _errorArgs() {
      return this.mode === MODES.BROTLI_ENCODE
        ? ["Compression failed", -1, "ERR_BROTLI_COMPRESSION_FAILED"]
        : ["Decompression failed", -1, "ERR_BROTLI_DECOMPRESSION_FAILED"];
    }
  }

  const BrotliEncoder = Brotli;
  const BrotliDecoder = Brotli;

  // Zstandard is still missing, and these handles have to EXIST: the op codes
  // above are already admitted so lib/zlib.js loads, which makes
  // `zlib.zstdCompressSync` a real function, so every
  // `typeof zlib.zstdCompressSync === "function"` guard in the ecosystem takes
  // the zstd branch. Leaving the classes off did not prevent that branch — it
  // made it die on `binding.ZstdCompress is not a constructor`, thrown from
  // inside Node's own lib/zlib.js, naming nothing the caller could act on.
  //
  // Same trade as builtins/bun-unsupported.js: no capability is added here, one
  // kind of failure becomes another. Zstd is absent for a specific reason, not a
  // general one: every Rust zstd compressor is a binding to the C library, which
  // does not build for wasm32-unknown-unknown. Brotli was absent for the same
  // reason until the pure-Rust `brotli` crate replaced that reason.
  const missingCodec = (className, apis, codec) => {
    const C = class {
      constructor() {
        throw new Error(
          `node:zlib ${apis} is not implemented in Vivari: the Rust/Wasm codec ` +
            `(packages/codec) provides deflate, gzip and brotli — there is no ${codec} ` +
            `engine behind this binding. If you are choosing an encoding at runtime, ` +
            `prefer gzip or brotli here; if you need ${codec} specifically, it has to be ` +
            `added to packages/codec and the Wasm rebuilt.`
        );
      }
    };
    Object.defineProperty(C, "name", { value: className, configurable: true });
    return C;
  };

  const ZstdCompress = missingCodec("ZstdCompress", "zstdCompress/zstdCompressSync", "Zstandard");
  const ZstdDecompress = missingCodec("ZstdDecompress", "zstdDecompress/zstdDecompressSync", "Zstandard");

  return { Zlib, crc32, BrotliEncoder, BrotliDecoder, ZstdCompress, ZstdDecompress };
}