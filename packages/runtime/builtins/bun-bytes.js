// Bun bytes / streams utilities: Bun.ArrayBufferSink, the seven
// Bun.readableStreamTo* consumers, Bun.concatArrayBuffers and Bun.allocUnsafe.
//
// Split out of bun.js for the same reason as bun-text.js — see the note at the top
// of that file. Everything here is pure computation over standard web primitives
// (ReadableStream, Blob, Response, TypedArray), so none of it needs the VFS or the
// kernel and all of it is exercised from scripts/spike-bun-offline.mjs.

// ---- async-generator response bodies: nothing to implement -----------------
// Bun documents async generators as a source for `Response`/`Request` bodies, in
// two forms: `new Response((async function*(){ yield "a" })())` and
// `new Response({[Symbol.asyncIterator]: async function*(){ yield "a" }})`.
//
// Both ALREADY work through the existing Bun.serve path, because that path hands
// the handler's Response straight to Node's http server and the Response ctor is
// the platform's — undici's, which accepts any async iterable as a BodyInit. So
// this file adds no code for it; scripts/spike-bun-offline.mjs pins both forms
// instead, since "works today by inheritance" is exactly the kind of thing a
// future Response polyfill would silently take away.
//
// The one shape that does NOT work is passing the generator FUNCTION itself
// rather than calling it — `new Response(async function*(){})` stringifies the
// function source into the body. That form is not in Bun's docs either, and it is
// unfixable from here: by the time Bun.serve sees the Response the body has
// already been encoded. Pinned as a known divergence rather than left to surprise.

// ---- chunk coercion ---------------------------------------------------------
// The one place that decides what a "chunk" is. Bun's ArrayBufferSink.write()
// accepts string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer; anything
// else is a caller bug and throws rather than being String()-ed into bytes (the
// coerce-and-hope pattern that made Bun.write's fallback path silently wrong).
function chunkToBytes(chunk, Buffer, who) {
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  if (ArrayBuffer.isView(chunk)) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (chunk instanceof ArrayBuffer) return new Uint8Array(chunk);
  if (typeof SharedArrayBuffer !== "undefined" && chunk instanceof SharedArrayBuffer) return new Uint8Array(chunk);
  throw new TypeError(
    who + " expects a string, ArrayBuffer, SharedArrayBuffer or typed array, got " + Object.prototype.toString.call(chunk)
  );
}

function joinBytes(parts, total) {
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function detach(bytes) {
  // Hand back a standalone ArrayBuffer, never a view onto a larger pooled buffer —
  // Buffer.from(string) in Node returns a slice of an 8 KB pool, so returning
  // `.buffer` directly would leak neighbouring writes to the caller.
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

// ---- Bun.ArrayBufferSink ----------------------------------------------------
// An incremental writer that becomes an ArrayBuffer (or Uint8Array) at the end.
//
// The subtle part is flush(), whose return type depends on what start() was given:
//   start({stream: true})                     -> flush() returns an ArrayBuffer
//   start({stream: true, asUint8Array: true}) -> flush() returns a Uint8Array
//   anything else                             -> flush() returns a NUMBER, the byte
//                                                count written since the last flush
// A caller that expects bytes and gets a number (or the reverse) fails somewhere
// far away from the mistake, so this is spelled out here and pinned by a
// regression check in scripts/spike-bun-offline.mjs.
//
// In stream mode flush() also DRAINS the buffer (the next flush/end only sees what
// was written after it); in buffer mode it does not, because end() must still be
// able to return everything.
export function makeArrayBufferSink(Buffer) {
  return class ArrayBufferSink {
    constructor() {
      this._chunks = [];
      this._pending = 0;
      this._sinceFlush = 0;
      this._asUint8Array = false;
      this._stream = false;
      this._ended = false;
    }

    start(options) {
      const o = options || {};
      this._asUint8Array = !!o.asUint8Array;
      this._stream = !!o.stream;
      // highWaterMark is a preallocation hint. We accumulate chunks in an array
      // instead of one growable buffer, so there is nothing to preallocate: it is
      // accepted and ignored. That is a performance difference with no observable
      // behaviour change, which is why it is a comment and not a throw.
      this._chunks = [];
      this._pending = 0;
      this._sinceFlush = 0;
      this._ended = false;
      return undefined;
    }

    write(chunk) {
      if (this._ended) {
        throw new Error("ArrayBufferSink.write() after end(): the sink is closed. Call start() to reuse it.");
      }
      const bytes = chunkToBytes(chunk, Buffer, "ArrayBufferSink.write()");
      this._chunks.push(bytes);
      this._pending += bytes.length;
      this._sinceFlush += bytes.length;
      // Bun returns the number of BYTES written, which is not chunk.length for a
      // string with any character outside ASCII.
      return bytes.length;
    }

    flush() {
      if (!this._stream) {
        const n = this._sinceFlush;
        this._sinceFlush = 0;
        return n;
      }
      const bytes = joinBytes(this._chunks, this._pending);
      this._chunks = [];
      this._pending = 0;
      this._sinceFlush = 0;
      return this._asUint8Array ? bytes : detach(bytes);
    }

    end() {
      const bytes = joinBytes(this._chunks, this._pending);
      this._chunks = [];
      this._pending = 0;
      this._sinceFlush = 0;
      this._ended = true;
      return this._asUint8Array ? bytes : detach(bytes);
    }
  };
}

// ---- Bun.readableStreamTo* --------------------------------------------------
// Seven consumers over a ReadableStream. They also accept a plain async iterable,
// which a Node Readable is: guest code hands these `fs.createReadStream(…)` and
// `Bun.spawn().stdout` as readily as a web stream, and without it those callers
// would get "getReader is not a function". (BunFile.stream() is a real web stream
// — see bun-file.js, which builds one rather than going through the unimplemented
// Readable.toWeb.)
async function drain(stream, who) {
  if (stream && typeof stream.getReader === "function") {
    const reader = stream.getReader();
    const out = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        out.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    return out;
  }
  if (stream && typeof stream[Symbol.asyncIterator] === "function") {
    const out = [];
    for await (const chunk of stream) out.push(chunk);
    return out;
  }
  throw new TypeError(who + " expects a ReadableStream or an async iterable");
}

export function makeStreamConsumers(Buffer) {
  const toBytes = async (stream, who) => {
    const chunks = await drain(stream, who);
    let total = 0;
    const parts = chunks.map((c) => {
      const b = chunkToBytes(c, Buffer, who);
      total += b.length;
      return b;
    });
    return joinBytes(parts, total);
  };

  const readableStreamToArray = (stream) => drain(stream, "Bun.readableStreamToArray");

  const readableStreamToBytes = (stream) => toBytes(stream, "Bun.readableStreamToBytes");

  const readableStreamToArrayBuffer = async (stream) => detach(await toBytes(stream, "Bun.readableStreamToArrayBuffer"));

  const readableStreamToBlob = async (stream) => {
    const chunks = await drain(stream, "Bun.readableStreamToBlob");
    return new Blob(chunks);
  };

  const readableStreamToText = async (stream) => {
    const chunks = await drain(stream, "Bun.readableStreamToText");
    // An all-string stream joins directly. A byte stream is concatenated first and
    // decoded once, so a multi-byte character split across two chunks survives.
    if (chunks.every((c) => typeof c === "string")) return chunks.join("");
    let total = 0;
    const parts = chunks.map((c) => {
      const b = chunkToBytes(c, Buffer, "Bun.readableStreamToText");
      total += b.length;
      return b;
    });
    return new TextDecoder().decode(joinBytes(parts, total));
  };

  const readableStreamToJSON = async (stream) => JSON.parse(await readableStreamToText(stream));

  // With no boundary the body is application/x-www-form-urlencoded; with one it is
  // multipart/form-data. Both are parsed by handing the bytes to Response, which is
  // the same WHATWG implementation Bun.serve already relies on — reimplementing
  // multipart parsing here would be a second, worse copy.
  const readableStreamToFormData = async (stream, multipartFormBoundary) => {
    const bytes = await toBytes(stream, "Bun.readableStreamToFormData");
    let contentType = "application/x-www-form-urlencoded";
    if (multipartFormBoundary !== undefined && multipartFormBoundary !== null) {
      const boundary =
        typeof multipartFormBoundary === "string"
          ? multipartFormBoundary
          : new TextDecoder().decode(chunkToBytes(multipartFormBoundary, Buffer, "Bun.readableStreamToFormData"));
      contentType = "multipart/form-data; boundary=" + boundary;
    }
    return new Response(bytes, { headers: { "content-type": contentType } }).formData();
  };

  return {
    readableStreamToArray,
    readableStreamToArrayBuffer,
    readableStreamToBytes,
    readableStreamToBlob,
    readableStreamToText,
    readableStreamToJSON,
    readableStreamToFormData,
  };
}

// ---- Bun.concatArrayBuffers / Bun.allocUnsafe -------------------------------
export function makeByteHelpers(Buffer) {
  const concatArrayBuffers = (buffers, maxLength, asUint8Array) => {
    if (!Array.isArray(buffers)) {
      throw new TypeError("Bun.concatArrayBuffers expects an array of ArrayBuffers or typed arrays");
    }
    let total = 0;
    const parts = buffers.map((b) => {
      const bytes = chunkToBytes(b, Buffer, "Bun.concatArrayBuffers");
      total += bytes.length;
      return bytes;
    });
    if (typeof maxLength === "number" && Number.isFinite(maxLength) && maxLength >= 0) {
      total = Math.min(total, Math.trunc(maxLength));
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      if (at >= total) break;
      const room = total - at;
      out.set(p.length > room ? p.subarray(0, room) : p, at);
      at += p.length;
    }
    return asUint8Array ? out : out.buffer;
  };

  // Bun's allocUnsafe hands back genuinely uninitialised memory (its docs warn that
  // it can leak whatever was recently in the heap). There is no such primitive in
  // JavaScript: `new Uint8Array(n)` is specified to be zero-filled and the engine
  // does it for us. So this is SAFER than Bun's and slower — a performance-contract
  // difference, not a behavioural one, and code that reads before writing gets
  // zeroes here and garbage under real Bun. Not worth a throw; worth knowing.
  const allocUnsafe = (size) => {
    const n = Math.trunc(Number(size));
    if (!Number.isFinite(n) || n < 0) throw new RangeError("Bun.allocUnsafe: size must be a non-negative integer");
    return new Uint8Array(n);
  };

  return { concatArrayBuffers, allocUnsafe };
}

// ---- factory ----------------------------------------------------------------
export function createBunBytes({ Buffer }) {
  return {
    ArrayBufferSink: makeArrayBufferSink(Buffer),
    ...makeStreamConsumers(Buffer),
    ...makeByteHelpers(Buffer),
  };
}