// Vivari compression codec — the Rust/Wasm core beneath Node's real
// lib/zlib.js (Phase 2 #11). Exposes a streaming, z_stream-accurate API that
// mirrors zlib's avail_in/avail_out model so the JS `internalBinding('zlib')`
// layer can drive it exactly like Node's C++ binding drives libz.
//
// Backend: flate2 with the pure-Rust miniz_oxide engine (compiles cleanly to
// wasm32-unknown-unknown, ~50KB). Covers the whole zlib family: deflate/inflate,
// raw, and gzip. gzip framing (10-byte header, CRC32 + ISIZE trailer, header
// parsing on decode) is layered here so the JS side stays a thin binding.

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
