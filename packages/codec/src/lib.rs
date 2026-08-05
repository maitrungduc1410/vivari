// Vivari compression codec — the Rust/Wasm core beneath Node's real
// lib/zlib.js (Phase 2 #11). Exposes a streaming, z_stream-accurate API that
// mirrors zlib's avail_in/avail_out model so the JS `internalBinding('zlib')`
// layer can drive it exactly like Node's C++ binding drives libz.
//
// Backend: flate2 with the pure-Rust miniz_oxide engine (compiles cleanly to
// wasm32-unknown-unknown, ~50KB). Covers the whole zlib family: deflate/inflate,
// raw, and gzip. gzip framing (10-byte header, CRC32 + ISIZE trailer, header
// parsing on decode) is layered here so the JS side stays a thin binding.
//
// Brotli (RFC 7932) comes from the pure-Rust `brotli` crate and is driven the
// same way, through BrotliStream below. Zstandard is still absent: every Rust
// zstd COMPRESSOR is a binding to the C library, which this target cannot build.

use brotli::enc::encode::BrotliEncoderOperation;
use brotli::enc::encode::BrotliEncoderStateStruct;
use brotli::enc::encode::BrotliEncoderParameter;
use brotli::enc::StandardAlloc;
use brotli::{BrotliDecompressStream, BrotliResult, BrotliState};
use flate2::{Compress, Compression, Crc, Decompress, FlushCompress, FlushDecompress, Status};
use wasm_bindgen::prelude::*;

// node_zlib_mode (matches src/node_zlib.cc enum order).
const DEFLATE: i32 = 1;
const INFLATE: i32 = 2;
const GZIP: i32 = 3;
const GUNZIP: i32 = 4;
const DEFLATERAW: i32 = 5;
const INFLATERAW: i32 = 6;
const UNZIP: i32 = 7;

// Fixed 10-byte gzip header: magic, CM=deflate, no flags, mtime=0, xfl=0,
// OS=unknown(0xff). Decoders ignore mtime/xfl/os, so this is fully portable.
const GZIP_HEADER: [u8; 10] = [0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0xff];

enum Core {
    C(Compress),
    D(Decompress),
}

#[wasm_bindgen]
pub struct ZStream {
    mode: i32,
    core: Core,
    level: Compression,
    zlib_header: bool, // for Decompress::reset
    last_consumed: u32,
    stream_end: bool,
    errored: bool,

    // Output FIFO — lets gzip inject header/trailer bytes that don't fit the
    // caller's fixed out buffer this call; drained over subsequent calls.
    pending: Vec<u8>,

    // gzip encode framing
    gz_header_done: bool,
    gz_trailer_done: bool,
    crc: Crc, // running IEEE CRC32 + byte count of the uncompressed input

    // gunzip/unzip decode: buffer input so we can strip the header and keep
    // feeding the raw inflater across chunk boundaries.
    in_buf: Vec<u8>,
    in_cursor: usize,
    hdr_done: bool,
    is_gzip: Option<bool>, // UNZIP auto-detect: None=undecided
}

fn comp_flush(f: i32) -> FlushCompress {
    match f {
        1 => FlushCompress::Partial,
        2 => FlushCompress::Sync,
        3 => FlushCompress::Full,
        4 => FlushCompress::Finish,
        _ => FlushCompress::None,
    }
}

fn dec_flush(f: i32) -> FlushDecompress {
    // NB: never pass Finish to the decompressor. miniz_oxide treats inflate+Finish
    // as "all input is here"; with our chunked, bounded-output driving that stalls
    // (produces/consumes 0) when the output buffer fills mid-stream. None lets it
    // make progress every call and it still detects end-of-stream (StreamEnd).
    match f {
        2 => FlushDecompress::Sync,
        _ => FlushDecompress::None,
    }
}

// Parse a gzip member header. Returns Some(len) once the full header is present,
// or None if more input is needed. Handles the optional FEXTRA/FNAME/FCOMMENT/
// FHCRC fields.
fn parse_gzip_header(buf: &[u8]) -> Option<usize> {
    if buf.len() < 10 {
        return None;
    }
    let flg = buf[3];
    let mut pos = 10usize;
    if flg & 0x04 != 0 {
        // FEXTRA
        if buf.len() < pos + 2 {
            return None;
        }
        let xlen = u16::from_le_bytes([buf[pos], buf[pos + 1]]) as usize;
        pos += 2 + xlen;
        if buf.len() < pos {
            return None;
        }
    }
    if flg & 0x08 != 0 {
        // FNAME (zero-terminated)
        loop {
            if pos >= buf.len() {
                return None;
            }
            let b = buf[pos];
            pos += 1;
            if b == 0 {
                break;
            }
        }
    }
    if flg & 0x10 != 0 {
        // FCOMMENT (zero-terminated)
        loop {
            if pos >= buf.len() {
                return None;
            }
            let b = buf[pos];
            pos += 1;
            if b == 0 {
                break;
            }
        }
    }
    if flg & 0x02 != 0 {
        // FHCRC
        if buf.len() < pos + 2 {
            return None;
        }
        pos += 2;
    }
    Some(pos)
}

#[wasm_bindgen]
impl ZStream {
    // `window_bits` is accepted for API parity with Node's binding but the pure
    // Rust (miniz_oxide) backend always uses the default 15-bit window (which is
    // Node's default too).
    #[wasm_bindgen(constructor)]
    pub fn new(mode: i32, level: i32, _window_bits: i32) -> ZStream {
        let level = if level < 0 {
            Compression::default()
        } else {
            Compression::new(level as u32)
        };
        // gzip encodes over a raw deflate stream (we add the gzip wrapper).
        let (core, zlib_header) = match mode {
            DEFLATE => (Core::C(Compress::new(level, true)), true),
            DEFLATERAW => (Core::C(Compress::new(level, false)), false),
            GZIP => (Core::C(Compress::new(level, false)), false),
            INFLATE => (Core::D(Decompress::new(true)), true),
            INFLATERAW => (Core::D(Decompress::new(false)), false),
            GUNZIP => (Core::D(Decompress::new(false)), false),
            // UNZIP: decompressor is (re)built once we sniff zlib vs gzip.
            _ => (Core::D(Decompress::new(false)), false),
        };
        ZStream {
            mode,
            core,
            level,
            zlib_header,
            last_consumed: 0,
            stream_end: false,
            errored: false,
            pending: Vec::new(),
            gz_header_done: false,
            gz_trailer_done: false,
            crc: Crc::new(),
            in_buf: Vec::new(),
            in_cursor: 0,
            hdr_done: mode != GZIP && mode != GUNZIP && mode != UNZIP,
            is_gzip: None,
        }
    }

    /// Feed `input`, produce up to `out_len` bytes. Returns the produced bytes;
    /// `consumed`/`ended`/`errored` report the counters for this call.
    pub fn process(&mut self, input: &[u8], flush: i32, out_len: usize) -> Vec<u8> {
        self.errored = false;
        self.last_consumed = 0;
        let cap = out_len.max(1);
        match self.core {
            Core::C(_) => self.process_compress(input, flush, cap),
            Core::D(_) => self.process_decompress(input, flush, cap),
        }
    }

    #[wasm_bindgen(getter)]
    pub fn consumed(&self) -> u32 {
        self.last_consumed
    }

    #[wasm_bindgen(getter)]
    pub fn ended(&self) -> bool {
        self.stream_end
    }

    #[wasm_bindgen(getter)]
    pub fn errored(&self) -> bool {
        self.errored
    }

    pub fn reset(&mut self) {
        match &mut self.core {
            Core::C(c) => c.reset(),
            Core::D(d) => d.reset(self.zlib_header),
        }
        self.pending.clear();
        self.gz_header_done = false;
        self.gz_trailer_done = false;
        self.crc = Crc::new();
        self.in_buf.clear();
        self.in_cursor = 0;
        self.hdr_done = self.mode != GZIP && self.mode != GUNZIP && self.mode != UNZIP;
        self.is_gzip = None;
        self.stream_end = false;
    }
}

impl ZStream {
    fn drain(&mut self, out_len: usize) -> Vec<u8> {
        let n = out_len.min(self.pending.len());
        self.pending.drain(..n).collect()
    }

    fn process_compress(&mut self, input: &[u8], flush: i32, out_len: usize) -> Vec<u8> {
        let gzip = self.mode == GZIP;
        if gzip && !self.gz_header_done {
            self.pending.extend_from_slice(&GZIP_HEADER);
            self.gz_header_done = true;
        }
        let mut temp = vec![0u8; out_len];
        let (consumed, produced, ended, err) = match &mut self.core {
            Core::C(c) => {
                let bi = c.total_in();
                let bo = c.total_out();
                let st = c.compress(input, &mut temp, comp_flush(flush));
                (
                    (c.total_in() - bi) as usize,
                    (c.total_out() - bo) as usize,
                    matches!(st, Ok(Status::StreamEnd)),
                    st.is_err(),
                )
            }
            _ => unreachable!(),
        };
        self.last_consumed = consumed as u32;
        self.errored = err;
        if gzip {
            self.crc.update(&input[..consumed]);
        }
        self.pending.extend_from_slice(&temp[..produced]);
        if gzip && ended && !self.gz_trailer_done {
            self.pending.extend_from_slice(&self.crc.sum().to_le_bytes());
            self.pending.extend_from_slice(&self.crc.amount().to_le_bytes());
            self.gz_trailer_done = true;
        }
        // Fully done only once the (gzip) trailer has been queued.
        self.stream_end = ended && (!gzip || self.gz_trailer_done);
        self.drain(out_len)
    }

    fn process_decompress(&mut self, input: &[u8], flush: i32, out_len: usize) -> Vec<u8> {
        // Plain zlib/raw inflate needs no framing: drive the engine directly.
        if self.mode == INFLATE || self.mode == INFLATERAW {
            let mut temp = vec![0u8; out_len];
            let (consumed, produced, ended, err) = match &mut self.core {
                Core::D(d) => {
                    let bi = d.total_in();
                    let bo = d.total_out();
                    let st = d.decompress(input, &mut temp, dec_flush(flush));
                    (
                        (d.total_in() - bi) as usize,
                        (d.total_out() - bo) as usize,
                        matches!(st, Ok(Status::StreamEnd)),
                        st.is_err(),
                    )
                }
                _ => unreachable!(),
            };
            self.last_consumed = consumed as u32;
            self.stream_end = ended;
            self.errored = err;
            temp.truncate(produced);
            return temp;
        }

        // gunzip / unzip: buffer input so we can strip the gzip header and keep
        // feeding the raw inflater across chunk boundaries.
        self.in_buf.extend_from_slice(input);
        self.last_consumed = input.len() as u32;

        // UNZIP: sniff zlib (0x78 ...) vs gzip (0x1f 0x8b) once we have 2 bytes.
        if self.mode == UNZIP && self.is_gzip.is_none() {
            if self.in_buf.len() - self.in_cursor < 2 {
                return self.drain(out_len);
            }
            let g = self.in_buf[self.in_cursor] == 0x1f && self.in_buf[self.in_cursor + 1] == 0x8b;
            self.is_gzip = Some(g);
            self.zlib_header = !g;
            self.core = Core::D(Decompress::new(!g));
            self.hdr_done = !g; // zlib streams have no gzip header to strip
        }

        let gzip = self.mode == GUNZIP || self.is_gzip == Some(true);
        if gzip && !self.hdr_done {
            match parse_gzip_header(&self.in_buf[self.in_cursor..]) {
                Some(hlen) => {
                    self.in_cursor += hlen;
                    self.hdr_done = true;
                }
                None => return self.drain(out_len),
            }
        }

        let mut temp = vec![0u8; out_len];
        // Disjoint field borrows: &mut self.core and &self.in_buf are distinct.
        let cursor = self.in_cursor;
        let (consumed, produced, ended, err) = match &mut self.core {
            Core::D(d) => {
                let src = &self.in_buf[cursor..];
                let bi = d.total_in();
                let bo = d.total_out();
                let st = d.decompress(src, &mut temp, dec_flush(flush));
                (
                    (d.total_in() - bi) as usize,
                    (d.total_out() - bo) as usize,
                    matches!(st, Ok(Status::StreamEnd)),
                    st.is_err(),
                )
            }
            _ => unreachable!(),
        };
        self.in_cursor += consumed;
        self.stream_end = ended;
        self.errored = err;
        temp.truncate(produced);
        temp
    }
}

// ---------------------------------------------------------------------------
// Brotli
//
// Same contract as ZStream — process(input, op, out_len) with a consumed count
// and a pending FIFO — so the JS binding drives both engines with one code path.
// The difference is what "op" means: brotli has no z_stream, it has operations
// (PROCESS/FLUSH/FINISH), and the encoder holds input internally until it has a
// whole metablock to emit. So input is always fully consumed and output arrives
// when the encoder decides, which is what the pending FIFO is for.

// Output is pulled from the engine in chunks this size and buffered in `pending`,
// independent of the caller's out_len: brotli's encoder emits a metablock at a
// time and there is no way to ask it for fewer bytes.
const BROTLI_SCRATCH: usize = 16384;

type Decoder = BrotliState<StandardAlloc, StandardAlloc, StandardAlloc>;

enum BrotliCore {
    Enc(Box<BrotliEncoderStateStruct<StandardAlloc>>),
    Dec(Box<Decoder>),
}

fn new_decoder() -> Box<Decoder> {
    Box::new(BrotliState::new(
        StandardAlloc::default(),
        StandardAlloc::default(),
        StandardAlloc::default(),
    ))
}

// The BROTLI_PARAM_* keys Node passes down in its params array, in the crate's
// terms. Node sends the whole array with -1 for "not set"; anything outside this
// list (the crate's tuning knobs, 150+) has no Node-side name and is ignored.
fn brotli_param(key: usize) -> Option<BrotliEncoderParameter> {
    Some(match key {
        0 => BrotliEncoderParameter::BROTLI_PARAM_MODE,
        1 => BrotliEncoderParameter::BROTLI_PARAM_QUALITY,
        2 => BrotliEncoderParameter::BROTLI_PARAM_LGWIN,
        3 => BrotliEncoderParameter::BROTLI_PARAM_LGBLOCK,
        4 => BrotliEncoderParameter::BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING,
        5 => BrotliEncoderParameter::BROTLI_PARAM_SIZE_HINT,
        6 => BrotliEncoderParameter::BROTLI_PARAM_LARGE_WINDOW,
        _ => return None,
    })
}

fn new_encoder(params: &[i32]) -> Box<BrotliEncoderStateStruct<StandardAlloc>> {
    let mut state = Box::new(BrotliEncoderStateStruct::new(StandardAlloc::default()));
    for (key, &value) in params.iter().enumerate() {
        if value < 0 {
            continue; // Node's "unset" marker
        }
        if let Some(p) = brotli_param(key) {
            state.set_parameter(p, value as u32);
        }
    }
    state
}

#[wasm_bindgen]
pub struct BrotliStream {
    core: BrotliCore,
    params: Vec<i32>,
    pending: Vec<u8>,
    last_consumed: u32,
    stream_end: bool,
    errored: bool,
}

#[wasm_bindgen]
impl BrotliStream {
    #[wasm_bindgen(constructor)]
    pub fn new(encode: bool, params: Vec<i32>) -> BrotliStream {
        let core = if encode {
            BrotliCore::Enc(new_encoder(&params))
        } else {
            BrotliCore::Dec(new_decoder())
        };
        BrotliStream {
            core,
            params,
            pending: Vec::new(),
            last_consumed: 0,
            stream_end: false,
            errored: false,
        }
    }

    /// Feed `input` under brotli operation `op`, return up to `out_len` bytes.
    pub fn process(&mut self, input: &[u8], op: i32, out_len: usize) -> Vec<u8> {
        self.errored = false;
        self.last_consumed = 0;
        let cap = out_len.max(1);
        match self.core {
            BrotliCore::Enc(_) => self.encode(input, op, cap),
            BrotliCore::Dec(_) => self.decode(input, cap),
        }
    }

    #[wasm_bindgen(getter)]
    pub fn consumed(&self) -> u32 {
        self.last_consumed
    }

    #[wasm_bindgen(getter)]
    pub fn ended(&self) -> bool {
        self.stream_end
    }

    #[wasm_bindgen(getter)]
    pub fn errored(&self) -> bool {
        self.errored
    }

    pub fn reset(&mut self) {
        // Neither engine has an in-place reset that is cheaper than a new state,
        // and a half-reset state is a correctness hazard, so rebuild.
        self.core = match self.core {
            BrotliCore::Enc(_) => BrotliCore::Enc(new_encoder(&self.params)),
            BrotliCore::Dec(_) => BrotliCore::Dec(new_decoder()),
        };
        self.pending.clear();
        self.stream_end = false;
        self.errored = false;
    }
}

impl BrotliStream {
    fn drain(&mut self, out_len: usize) -> Vec<u8> {
        let n = out_len.min(self.pending.len());
        self.pending.drain(..n).collect()
    }

    fn encode(&mut self, input: &[u8], op: i32, out_len: usize) -> Vec<u8> {
        let operation = match op {
            1 => BrotliEncoderOperation::BROTLI_OPERATION_FLUSH,
            2 => BrotliEncoderOperation::BROTLI_OPERATION_FINISH,
            3 => BrotliEncoderOperation::BROTLI_OPERATION_EMIT_METADATA,
            _ => BrotliEncoderOperation::BROTLI_OPERATION_PROCESS,
        };
        let mut available_in = input.len();
        let mut input_offset = 0usize;
        let mut scratch = vec![0u8; BROTLI_SCRATCH];
        loop {
            let mut available_out = scratch.len();
            let mut output_offset = 0usize;
            let mut total_out = None;
            let (ok, finished, more) = match &mut self.core {
                BrotliCore::Enc(state) => {
                    let ok = state.compress_stream(
                        operation,
                        &mut available_in,
                        input,
                        &mut input_offset,
                        &mut available_out,
                        &mut scratch,
                        &mut output_offset,
                        &mut total_out,
                        &mut |_, _, _, _| (),
                    );
                    (ok, state.is_finished(), state.has_more_output())
                }
                _ => unreachable!(),
            };
            self.pending.extend_from_slice(&scratch[..output_offset]);
            if !ok {
                self.errored = true;
                break;
            }
            if finished {
                self.stream_end = true;
                break;
            }
            // Nothing left to give and nothing more to take: this operation is as
            // far along as it can get without more input. FINISH is the exception
            // that keeps looping, since it must run to `finished` on its own.
            if available_in == 0 && !more && output_offset == 0 {
                break;
            }
        }
        self.last_consumed = (input.len() - available_in) as u32;
        self.drain(out_len)
    }

    fn decode(&mut self, input: &[u8], out_len: usize) -> Vec<u8> {
        let mut available_in = input.len();
        let mut input_offset = 0usize;
        let mut total_out = 0usize;
        let mut scratch = vec![0u8; BROTLI_SCRATCH];
        loop {
            let mut available_out = scratch.len();
            let mut output_offset = 0usize;
            let result = match &mut self.core {
                BrotliCore::Dec(state) => BrotliDecompressStream(
                    &mut available_in,
                    &mut input_offset,
                    input,
                    &mut available_out,
                    &mut output_offset,
                    &mut scratch,
                    &mut total_out,
                    state,
                ),
                _ => unreachable!(),
            };
            self.pending.extend_from_slice(&scratch[..output_offset]);
            match result {
                // Filled the scratch buffer; there is more where that came from.
                BrotliResult::NeedsMoreOutput => continue,
                BrotliResult::ResultSuccess => {
                    self.stream_end = true;
                    break;
                }
                BrotliResult::NeedsMoreInput => break,
                BrotliResult::ResultFailure => {
                    self.errored = true;
                    break;
                }
            }
        }
        self.last_consumed = input_offset as u32;
        self.drain(out_len)
    }
}