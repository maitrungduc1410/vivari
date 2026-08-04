// BunFile — `Bun.file()`, `Bun.write()`, the `FileSink` from `.writer()`, and
// `Bun.stdout`/`Bun.stderr` as write targets.
//
// Split out of bun.js the way bun-formats/text/bytes/hash/glob were: the file
// surface is bulk, it is self-contained (everything below goes through `fs`, and
// `fs` is the only capability it needs), and it has enough behaviour worth
// pinning that inlining it would push bun.js past readable. `Bun.file` itself
// stays wired in the `Bun` object literal in bun.js.
//
// Four things here are easy to get subtly wrong, and each is the reason the
// corresponding code looks the way it does:
//
//   * `.slice()` must stay LAZY. Bun documents it as "does not copy the file,
//     open the file, or modify the file" — the whole point is to hand a 4 GB log
//     to something that will read the last 4 KB of it. A slice that materialises
//     bytes has the right type and the right contents and turns a constant-memory
//     program into an out-of-memory one. Ours carries an absolute byte window and
//     resolves it against the file only when something actually reads.
//
//   * The `FileSink` must FLUSH INCREMENTALLY. The previous implementation pushed
//     every chunk into an array and wrote the lot in `end()`, which is a
//     reasonable-looking shortcut with two bad consequences: a long-running writer
//     holds the entire file in memory (defeating the only reason to reach for an
//     incremental writer), and anything that stops the process before `end()` —
//     a crash, a `process.exit`, a killed preview — loses everything written so
//     far, silently. It now opens the fd on first write and drains whenever the
//     buffer passes the high-water mark, so bytes are on disk as you go.
//
//   * Writes must respect the syscall window. Every syscall request has to fit
//     the 1 MiB shared-data region (`DATA_BYTES` in packages/protocol/syscall.js),
//     and `fs-client.js` therefore caps each fd write at `FD_CHUNK` = 512 KiB and
//     returns a SHORT WRITE count for anything bigger. This runtime's `fs.writeSync`
//     loops on that internally, but plain Node's does not promise to, so the sink
//     loops on the returned count and never offers more than one window at a time.
//     Getting this wrong does not look like a size problem: it looks like a
//     truncated file, or a syscall that hangs and 504s much later.
//
//   * `.stream()` does not go through `Readable.toWeb`. It predates a working
//     one: `toWeb` used to be a stub that threw in the VM while still being a
//     function, so the natural `Readable.toWeb ? … : …` guard sailed right past
//     it and only the kernel tier noticed. That is fixed
//     (node/internal/webstreams/adapters.js), but `.stream()` stays hand-built,
//     because what it does is not what `toWeb(fs.createReadStream(…))` would do:
//     it opens no fd until the consumer pulls, reads the slice window directly,
//     and enqueues exactly one <= 64 KiB chunk per pull. Through a Readable the
//     chunking would follow that stream's highWaterMark and the adapter would
//     buffer ahead of the reader — and `spike-bun-offline.mjs` asserts the
//     bound. Same conclusion in bun.js's Bun.spawn().
//
// Known divergence worth naming here, because it looks like a bug: a BunFile is
// NOT a platform `Blob` instance. Bun's extends Blob, so `new Response(Bun.file(p))`
// streams the file there and stringifies here. Neither fix is portable —
// duck-typing (`Symbol.toStringTag = "Blob"` + `.stream()`) satisfies Node's
// undici and not the browser Worker's native `Response`, and `extends Blob` makes
// Node stream the file while the BROWSER serves an empty body out of the (empty)
// internal blob state. Being silently right on the tier we test and silently
// wrong on the tier that ships is the worst of the three, so the gap stays
// visible and pinned in the offline spike. `new Response(Bun.file(p).stream())`
// and `await Bun.file(p).bytes()` both work.
//
// `Bun.file(fd)` stays a throw (Phase 0). Our fd numbers are indices into the
// runtime's own VFS descriptor table, not OS file descriptors, so there is no
// file to wrap — see the message in the constructor.

// Mirrors FD_CHUNK in packages/runtime/fs-client.js, which is itself half of
// DATA_BYTES (1 MiB) in packages/protocol/syscall.js. Kept as its own constant
// rather than imported because a builtin has no business depending on the wire
// protocol; if FD_CHUNK ever changes, this only has to stay <= it.
const WRITE_CHUNK = 512 * 1024;

// One `pull()` of `.stream()`. Smaller than the write window on purpose: a stream
// exists so a consumer can process a file it could not hold, so the chunk size is
// a memory budget rather than a throughput knob.
const STREAM_CHUNK = 64 * 1024;

// Bun does not document FileSink's default high-water mark, and it is not
// observable in any way that matters: it only decides HOW OFTEN bytes reach the
// disk, never which bytes or in what order. 64 KiB is small enough that a chatty
// writer makes progress and large enough that a per-line writer is not one
// syscall per line.
const DEFAULT_HIGH_WATER_MARK = 64 * 1024;

// A deliberately small extension table (the same one this shim has always had).
// Known divergence: real Bun appends `;charset=utf-8` to the textual types, so
// `Bun.file("a.json").type` is `application/json;charset=utf-8` there and
// `application/json` here. Left alone rather than guessed at — the full table is
// a MIME database, and half a database is the kind of plausible-looking answer
// this shim is not allowed to invent.
function guessMime(p) {
  const ext = (p.split(".").pop() || "").toLowerCase();
  const map = {
    html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript",
    mjs: "text/javascript", json: "application/json", txt: "text/plain",
    svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    gif: "image/gif", webp: "image/webp", wasm: "application/wasm",
  };
  return map[ext] || "application/octet-stream";
}

export function createBunFile({ lazy, Buffer, process }) {
  const fsmod = () => lazy("fs");

  const toBytes = (chunk) => {
    if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
    if (Buffer.isBuffer(chunk)) return chunk;
    if (chunk instanceof ArrayBuffer) return Buffer.from(new Uint8Array(chunk));
    if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    // Anything else would have to be String()-ed, and `String(someObject)` is
    // "[object Object]" — bytes nobody asked for. Bun's sinks reject it too.
    throw new TypeError(
      "FileSink.write() expects a string, ArrayBuffer or TypedArray, got " + typeof chunk,
    );
  };

  const highWaterMarkOf = (options) => {
    const hwm = options && options.highWaterMark;
    return typeof hwm === "number" && hwm > 0 ? Math.floor(hwm) : DEFAULT_HIGH_WATER_MARK;
  };

  // ---- FileSink -------------------------------------------------------------
  // Bun's incremental writer. `write()` buffers and returns the byte count,
  // `flush()` drains to disk and returns what it drained, `end()` drains and
  // closes. The fd is opened on the FIRST write (or by `end()`, see below) rather
  // than in the constructor, so a writer that is created and then abandoned
  // neither creates nor truncates the file.
  class FileSink {
    constructor(target, options) {
      this._target = target; // { path } for a file, { stream } for stdout/stderr
      this._hwm = highWaterMarkOf(options);
      this._pending = [];
      this._pendingBytes = 0;
      this._written = 0;
      this._fd = null;
      this._ended = false;
    }

    start(options) {
      // Documented as configuring the sink; the only knob is the buffer size, and
      // re-`start()`ing an already-written sink must not silently discard what is
      // buffered, so this only touches the high-water mark.
      if (options) this._hwm = highWaterMarkOf(options);
      return undefined;
    }

    write(chunk) {
      if (this._ended) {
        throw new Error("FileSink.write() called after end() — the file is closed");
      }
      const bytes = toBytes(chunk);
      this._pending.push(bytes);
      this._pendingBytes += bytes.length;
      // The auto-drain that makes this a streaming writer rather than a bucket.
      if (this._pendingBytes >= this._hwm) this.flush();
      return bytes.length;
    }

    flush() {
      if (this._pendingBytes === 0) return 0;
      const buf = this._pending.length === 1 ? this._pending[0] : Buffer.concat(this._pending, this._pendingBytes);
      this._pending = [];
      this._pendingBytes = 0;
      const n = this._drain(buf);
      this._written += n;
      return n;
    }

    end() {
      if (this._ended) return this._written;
      this.flush();
      this._ended = true;
      // `end()` MATERIALISES the file even when nothing was written. A loop that
      // produced no rows must leave an empty file behind, not a missing one —
      // "the writer ran and the file is not there" is indistinguishable from a
      // crash, and the caller would go looking for the wrong bug. Opening here
      // (rather than in the constructor) still leaves an abandoned writer inert.
      if (this._fd === null && !this._target.stream) {
        this._fd = fsmod().openSync(this._target.path, "w");
      }
      if (this._fd !== null) {
        try {
          fsmod().closeSync(this._fd);
        } finally {
          this._fd = null;
        }
      }
      // Bun types this `number | Promise<number>` and documents no meaning beyond
      // that, so return the total written over the sink's lifetime — the only
      // figure that is both useful and stable across a flush()-heavy caller.
      return this._written;
    }

    // Bun keeps the process alive until a FileSink is ended, and ref()/unref()
    // opt in and out of that. Our event loop has no such handle: a process exits
    // when its loop drains, and a sink holds nothing that would keep it turning.
    // These are therefore honest no-ops rather than a lie — the observable
    // behaviour they control does not exist here — but note that an un-ended sink
    // will NOT keep the process alive the way it does under Bun.
    ref() {}
    unref() {}

    _drain(buf) {
      const fs = fsmod();
      if (this._target.stream) {
        this._target.stream.write(buf);
        return buf.length;
      }
      if (this._fd === null) this._fd = fs.openSync(this._target.path, "w");
      let off = 0;
      while (off < buf.length) {
        // Never hand the bridge more than one syscall window, and believe the
        // returned count: a short write here is normal, not an error.
        const end = Math.min(off + WRITE_CHUNK, buf.length);
        const n = fs.writeSync(this._fd, buf, off, end - off);
        if (!(n > 0)) break;
        off += n;
      }
      return off;
    }
  }

  // ---- BunFile --------------------------------------------------------------
  class BunFile {
    constructor(pathOrFd, options, range) {
      if (typeof pathOrFd === "number") {
        throw new TypeError(
          "Bun.file(fd) is not supported in Vivari: file descriptors here are VFS " +
            "handles owned by the runtime, not OS file descriptors, so there is no " +
            "file to open. Use Bun.file(path) instead."
        );
      }
      // `Bun.file(new URL(import.meta.url))` is documented. Coercing a URL with
      // String() used to produce the literal path "file:///app/x.ts", which fails
      // as a confusing ENOENT far from the call — the same bug class as Bun.file(fd).
      this._path = toPath(pathOrFd);
      this._type = (options && options.type) || guessMime(this._path);
      // The lazy slice window, in absolute bytes. `_end === null` means EOF, so a
      // slice of a file that is still being appended to keeps following it.
      this._start = (range && range.start) || 0;
      this._end = range && range.end !== undefined ? range.end : null;
    }

    get name() {
      return this._path;
    }
    get type() {
      return this._type;
    }

    // Blob.size, clamped to the slice window. A missing file is 0 rather than a
    // throw — Bun documents `Bun.file("notreal.txt").size === 0`.
    get size() {
      return this._window().length;
    }

    get lastModified() {
      try {
        return fsmod().statSync(this._path).mtimeMs;
      } catch {
        return 0;
      }
    }

    async exists() {
      try {
        // False for a directory: Bun documents exists() as true for regular files
        // and FIFOs only. A directory used to answer `true` here, which turns
        // "is this file there?" into a read that throws EISDIR one line later.
        return !fsmod().statSync(this._path).isDirectory();
      } catch {
        return false;
      }
    }

    async stat() {
      return fsmod().statSync(this._path);
    }

    // Blob.slice — a lazy VIEW, not a copy. Nothing is read here. The three
    // documented overloads all collapse to "a string argument is the contentType":
    //   slice(begin, end, type) / slice(begin, type) / slice(type)
    slice(beginOrType, endOrType, maybeType) {
      let begin = beginOrType;
      let end = endOrType;
      let type;
      if (typeof beginOrType === "string") {
        type = beginOrType;
        begin = undefined;
        end = undefined;
      } else if (typeof endOrType === "string") {
        type = endOrType;
        end = undefined;
      } else {
        type = maybeType;
      }
      // Resolve relative to THIS file's window so slices compose. A negative
      // offset is relative to the end, which is the one case that needs to know
      // the current size, so it stats (a stat, not an open — the "does not open
      // the file" contract still holds). Positive offsets do no syscall at all.
      const base = this._start;
      const hasEnd = this._end !== null;
      const size = begin < 0 || end < 0 ? this._window().length : 0;
      let from = begin === undefined ? 0 : begin < 0 ? Math.max(0, size + begin) : begin;
      let to = end === undefined ? null : end < 0 ? Math.max(0, size + end) : end;
      let absStart = base + from;
      let absEnd = to === null ? this._end : base + to;
      if (hasEnd) {
        absStart = Math.min(absStart, this._end);
        if (absEnd !== null) absEnd = Math.min(absEnd, this._end);
      }
      if (absEnd !== null && absEnd < absStart) absEnd = absStart;
      return new BunFile(this._path, { type: type || this._type }, { start: absStart, end: absEnd });
    }

    async text() {
      return this._read().toString("utf8");
    }
    async json() {
      return JSON.parse(await this.text());
    }
    async arrayBuffer() {
      const b = this._read();
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }
    async bytes() {
      return new Uint8Array(this._read());
    }
    async blob() {
      return new Blob([this._read()], { type: this._type });
    }
    // Parses the file as a form body. The type has to come from the file — Bun
    // throws "Invalid encoding" for a Bun.file() with no content-type, because
    // there is nothing in the bytes that says whether they are urlencoded or a
    // multipart body, and guessing wrong silently returns an empty FormData.
    // Give it one with Bun.file(path, { type }).
    async formData() {
      const type = this._type;
      if (!type || !/^(multipart\/form-data|application\/x-www-form-urlencoded)\b/i.test(type)) {
        throw new TypeError("Invalid encoding");
      }
      return new Response(this._read(), { headers: { "content-type": type } }).formData();
    }

    // Bun returns a WHATWG ReadableStream. This builds one directly out of fd
    // reads rather than the obvious `Readable.toWeb(fs.createReadStream(...))`.
    // That started as a workaround — `Readable.toWeb` was an unimplemented stub
    // that threw in the VM, and being a function it sailed past every
    // `Readable.toWeb ? … : …` guard, so the failure only appeared in the kernel
    // tier. It works now (node/internal/webstreams/adapters.js), and this stays
    // hand-built on its own merits, not because toWeb is broken:
    //
    // reading per pull keeps the stream doing what a stream is for — one bounded
    // chunk in memory at a time, each comfortably inside the syscall window, over
    // however large a file, with no fd opened until the consumer actually pulls.
    // Through a Readable the chunk size would be that stream's highWaterMark and
    // the adapter would run ahead of the reader instead.
    stream() {
      if (typeof ReadableStream !== "function") {
        throw new Error(
          "Bun.file(path).stream() is not supported in this realm: it needs a global " +
            "ReadableStream and there is none here. Use .bytes() or .text() instead."
        );
      }
      const fs = fsmod();
      const self = this;
      let fd = null;
      let done = false;
      let pos = 0;
      let remaining = 0;
      const closeFd = () => {
        if (fd !== null) {
          try { fs.closeSync(fd); } catch { /* already gone */ }
          fd = null;
        }
      };
      return new ReadableStream({
        // Nothing is opened until the consumer pulls, so `.stream()` on a lazy
        // slice stays as lazy as the slice is.
        pull(controller) {
          if (done) return;
          if (fd === null) {
            const win = self._window();
            pos = win.start;
            remaining = win.length;
            fd = fs.openSync(self._path, "r");
          }
          if (remaining <= 0) {
            done = true;
            closeFd();
            controller.close();
            return;
          }
          const want = Math.min(remaining, STREAM_CHUNK);
          const buf = Buffer.alloc(want);
          const got = fs.readSync(fd, buf, 0, want, pos);
          if (!(got > 0)) {
            // Short of the window: the file shrank under us. Ending the stream is
            // the honest answer — the alternative is enqueueing zero bytes forever.
            done = true;
            closeFd();
            controller.close();
            return;
          }
          pos += got;
          remaining -= got;
          controller.enqueue(new Uint8Array(buf.buffer, buf.byteOffset, got));
        },
        cancel() {
          done = true;
          closeFd();
        },
      });
    }

    writer(options) {
      return new FileSink({ path: this._path }, options);
    }

    // Documented as "equivalent to Bun.write with a BunFile".
    async write(data) {
      return bunWrite(this, data);
    }

    // Bun exposes both spellings, with delete() documented and unlink() its
    // alias. Neither is forgiving: deleting a file that is not there rejects,
    // the same as fs.unlink would.
    async delete() {
      fsmod().unlinkSync(this._path);
    }
    async unlink() {
      return this.delete();
    }

    // Resolve the slice window against the file as it is RIGHT NOW. Every read
    // goes through here, which is what makes `Bun.file(p).slice(0, 10)` follow a
    // file that grows between the slice and the read.
    _window() {
      let size = 0;
      try {
        size = fsmod().statSync(this._path).size;
      } catch {
        size = 0;
      }
      const start = Math.min(this._start, size);
      const end = this._end === null ? size : Math.min(this._end, size);
      return { start, length: Math.max(0, end - start) };
    }

    _read() {
      const fs = fsmod();
      // Whole-file fast path: one call into the fs layer, which already loops for
      // files larger than the syscall window.
      if (this._start === 0 && this._end === null) return fs.readFileSync(this._path);
      const { start, length } = this._window();
      if (length === 0) return Buffer.alloc(0);
      const fd = fs.openSync(this._path, "r");
      try {
        const out = Buffer.alloc(length);
        let got = 0;
        while (got < length) {
          const n = fs.readSync(fd, out, got, length - got, start + got);
          if (!(n > 0)) break;
          got += n;
        }
        return got === length ? out : out.subarray(0, got);
      } finally {
        fs.closeSync(fd);
      }
    }
  }

  // ---- Bun.stdout / Bun.stderr ----------------------------------------------
  // Bun exposes stdin/stdout/stderr as BunFiles. stdout and stderr are write
  // targets: `Bun.write(Bun.stdout, Bun.file(p))` is Bun's three-line `cat`, and
  // `Bun.stdout.writer()` is how you stream output without a console call per
  // line. Reading them is not a thing you can do to a write-only stream, here or
  // anywhere, so the read half throws instead of answering "".
  class StdioFile {
    constructor(name, stream) {
      this._name = name;
      this._stream = stream;
    }
    get name() {
      return this._name;
    }
    get type() {
      return "text/plain";
    }
    get size() {
      return 0;
    }
    writer(options) {
      return new FileSink({ stream: this._stream }, options);
    }
    async write(data) {
      return bunWrite(this, data);
    }
    async exists() {
      return true;
    }
    _unreadable(method) {
      throw new Error(
        "Bun." +
          this._name +
          "." +
          method +
          "() is not supported in Vivari: " +
          this._name +
          " is a write-only sink here (the process's output is delivered to the " +
          "kernel by message, not backed by a readable file). Use Bun.write(Bun." +
          this._name +
          ", data) or Bun." +
          this._name +
          ".writer()."
      );
    }
    text() {
      return this._unreadable("text");
    }
    json() {
      return this._unreadable("json");
    }
    bytes() {
      return this._unreadable("bytes");
    }
    arrayBuffer() {
      return this._unreadable("arrayBuffer");
    }
    stream() {
      return this._unreadable("stream");
    }
    slice() {
      return this._unreadable("slice");
    }
    delete() {
      return this._unreadable("delete");
    }
  }

  const stdout = new StdioFile("stdout", process.stdout);
  const stderr = new StdioFile("stderr", process.stderr);

  function bunFile(pathOrFd, options) {
    return new BunFile(pathOrFd, options);
  }

  // ---- Bun.write ------------------------------------------------------------
  async function bunWrite(dest, input) {
    const fs = fsmod();
    if (typeof dest === "number") {
      // Same reason as Bun.file(fd), and worth its own throw because the failure
      // is worse: String(1) is the relative path "1", so this used to CREATE a
      // file called "1" in the cwd and report success.
      throw new TypeError(
        "Bun.write(fd, data) is not supported in Vivari: file descriptors here are " +
          "VFS handles owned by the runtime, not OS file descriptors. Use a path, a " +
          "Bun.file(), Bun.stdout or Bun.stderr as the destination."
      );
    }

    const bytes = await inputToBytes(input);

    if (dest instanceof StdioFile) {
      dest._stream.write(bytes);
      return bytes.length;
    }

    const destPath = dest instanceof BunFile ? dest._path : toPath(dest, "Bun.write(destination, …)");
    const slash = destPath.lastIndexOf("/");
    if (slash > 0) {
      try {
        fs.mkdirSync(destPath.slice(0, slash), { recursive: true });
      } catch {
        /* already there, or a file in the way — the write below reports it */
      }
    }
    // Chunked deliberately: writeFileSync would hand the whole buffer to the fs
    // layer in one go, and while this runtime's binding loops internally, doing
    // it here keeps a multi-megabyte Bun.write() inside the syscall window on any
    // fs implementation underneath.
    const fd = fs.openSync(destPath, "w");
    try {
      let off = 0;
      while (off < bytes.length) {
        const end = Math.min(off + WRITE_CHUNK, bytes.length);
        const n = fs.writeSync(fd, bytes, off, end - off);
        if (!(n > 0)) break;
        off += n;
      }
      return off;
    } finally {
      fs.closeSync(fd);
    }
  }

  async function inputToBytes(input) {
    if (input instanceof BunFile) return input._read();
    if (typeof input === "string") return Buffer.from(input, "utf8");
    if (input instanceof ArrayBuffer) return Buffer.from(new Uint8Array(input));
    if (ArrayBuffer.isView(input)) return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    // Blob / Response / Request — anything with the Blob read protocol.
    if (input && typeof input.arrayBuffer === "function") {
      return Buffer.from(new Uint8Array(await input.arrayBuffer()));
    }
    return Buffer.from(String(input), "utf8");
  }

  // A path is a string or a file: URL, and NOTHING else gets String()-ed. That is
  // the same trap as `Bun.file(fd)`: `Bun.file()` used to hand back a handle on the
  // relative path "undefined", which reads as a plausible BunFile right up to an
  // ENOENT somewhere else entirely.
  function toPath(pathOrUrl, api) {
    if (typeof pathOrUrl === "string") {
      return pathOrUrl.startsWith("file://") ? fileUrlToPath(pathOrUrl) : pathOrUrl;
    }
    if (pathOrUrl && typeof pathOrUrl === "object" && typeof pathOrUrl.href === "string") {
      return fileUrlToPath(pathOrUrl.href);
    }
    throw new TypeError(
      (api || "Bun.file") +
        " expects a string path or a file: URL, got " +
        (pathOrUrl === null ? "null" : typeof pathOrUrl)
    );
  }

  function fileUrlToPath(href) {
    let p = href.replace(/^file:\/\//, "");
    try {
      p = decodeURIComponent(p);
    } catch {
      /* leave the escaped form rather than losing the path */
    }
    return p || "/";
  }

  return { BunFile, FileSink, StdioFile, bunFile, bunWrite, stdout, stderr };
}