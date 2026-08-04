// Bun.Archive — Bun 1.3's archive reader/writer, over a tar codec written here.
//
// This was a SHIM-tier refusal ("bytes in, bytes out, nobody has written it"),
// and the refusal was right about the capability: nothing in a page prevents any
// of it. What the refusal could not tell you is how much of the surface is NOT
// what the name suggests, and every one of the following was read off bun-1.3.6
// rather than inferred from the docs or the published types:
//
//   * READING accepts tar and gzipped tar, and NOTHING ELSE. A .zip throws
//     `Unrecognized archive format` — the same words as random bytes. So do
//     bzip2, xz, zstd and a raw zlib stream. "Archive" reads like a format-
//     agnostic container and is not one.
//   * WRITING always emits an UNCOMPRESSED TAR, whatever the path says. Handed
//     `out.zip` it writes 10240 bytes of ustar; `{ format: "zip" }` is accepted
//     and ignored. Only `{ compress: "gzip" }` changes the bytes.
//   * `files()` resolves to a `Map<string, Blob>`, not a plain object, and only
//     regular files are in it — directory, symlink and hardlink entries are
//     dropped, though `extract()` still creates the first two and counts all
//     three.
//   * `bytes()` resolves to a Node `Buffer` (not a bare Uint8Array), and it is
//     the archive bytes AS SUPPLIED: for a gzipped input it hands the gzip back,
//     and it does NOT validate anything. A three-byte garbage archive returns
//     those three bytes happily; only `files()`/`extract()` ever parse.
//   * The constructor takes an options object as its SECOND argument, which the
//     types do not mention and `Archive.length === 0` hides.
//   * A non-ASCII entry name THROWS (`Failed to create tarball:
//     ArchiveHeaderError`) — libarchive refuses to encode one in a ustar header
//     rather than reaching for the pax extension it uses for long names.
//
// Bun's error strings are reproduced verbatim, including the two unhelpful ones
// (`ReadError`, `Unrecognized archive format`), because a caller who hits them
// will search for them and because a `catch` that compares them has to keep
// working under the real binary.
//
// FOUR DELIBERATE DIVERGENCES, all refusals, because real Bun loses data here
// silently and a sandbox that reproduces silent corruption is worse than one
// that refuses (the Bun.JSONC precedent in roadmap.md: stricter, never looser):
//
//   * A `Map` — the exact shape `files()` hands back — makes real Bun write an
//     EMPTY archive and report success. `new Archive(await other.files())` is
//     therefore a total loss with no error anywhere. Refused, naming the fix.
//   * A `Set` is the same hole for the same reason (neither has own enumerable
//     properties, and the writer only ever reads those).
//   * An `Archive` passed to the CONSTRUCTOR is a third: `new Archive(other)`
//     yields an empty archive, while `Archive.write(path, other)` works. Refused
//     in the constructor only, so the call that works keeps working.
//   * A `BunFile` as an entry VALUE is stored as ZERO bytes. `new Archive({
//     "a.txt": Bun.file("a.txt") })` looks exactly like the obvious way to
//     archive a file and produces an empty entry.
//
// And one more, in the opposite direction — informative rather than strict: when
// `extract()` cannot write to its DESTINATION, real Bun reports `ReadError`,
// which names neither the path nor the reason. The underlying fs error is passed
// through instead. A corrupt ARCHIVE still throws Bun's `ReadError`, because that
// one is a fact about the input a program might branch on.
//
// The tar codec is here rather than shared with packages/kernel-host/tar.js: a
// runtime builtin cannot import from the kernel host (different side of the
// worker boundary), and that reader is read-only anyway — nothing in the repo
// wrote a tar before this. The reader below handles what `parseTar` does (the
// ustar `prefix` split, GNU `L` long names, pax `x`/`g` `path` overrides) plus
// the entry types `extract()` needs to tell apart.

const TAR_BLOCK = 512;
// Tar's record size: 20 blocks. Bun pads every archive up to a multiple of it,
// which is why the smallest archive it can produce is 10240 bytes of mostly
// zeros — including for `{}`. Reproduced, since a caller measuring `.length`
// against a real Bun would otherwise disagree with us on every archive.
const TAR_RECORD = TAR_BLOCK * 20;
const NAME_MAX = 100;
const PREFIX_MAX = 155;

// ---- Bun's error strings ----------------------------------------------------
// Verbatim. `E_READ` and `E_FORMAT` are the two that say nothing useful; they are
// still what a `catch` compares against under the real binary.
const E_INPUT = "Expected an object, Blob, TypedArray, or ArrayBuffer";
const E_WRITE_FILES = "Expected an object, Blob, TypedArray, ArrayBuffer, or Archive";
const E_WRITE_PATH = "Archive.write: first argument must be a string path";
const E_EXTRACT_PATH = "Archive.extract requires a path argument";
const E_OPTIONS = "Archive: options must be an object";
const E_COMPRESS_TYPE = "Archive: compress option must be a string";
const E_COMPRESS_VALUE = 'Archive: compress option must be "gzip"';
const E_FORMAT = "Unrecognized archive format";
const E_TRUNCATED = "Truncated tar archive detected while reading data";
const E_HEADER = "Failed to create tarball: ArchiveHeaderError";
const E_READ = "ReadError";
const E_NOT_ARCHIVE = (received) =>
  "Expected this to be instanceof Archive, but received an instance of " + received;

// Bun attaches this code to every argument-validation throw here, including the
// non-ASCII-name one, which is not an argument type problem by any reading — but
// it is what the binary sets, and code that switches on `err.code` has to agree.
// A receiver that is not an Archive gets ERR_INVALID_THIS instead.
const codedTypeError = (message, code) => {
  const err = new TypeError(message);
  err.code = code;
  return err;
};
const argError = (message) => codedTypeError(message, "ERR_INVALID_ARG_TYPE");

// ---- the refusals real Bun answers with silence -----------------------------

const lossMessage = (call, what, loses, fix) =>
  "Bun.Archive: " + call + " is refused in Vivari. Real Bun accepts " + what +
  " and " + loses + ", with no error — so the sandbox refuses it rather than " +
  "reproducing data loss that only shows up in production. " + fix;

const MAP_REFUSAL = (call) =>
  lossMessage(
    call,
    "a Map",
    "writes an EMPTY archive",
    "Pass a plain object: Object.fromEntries(map). Note that archive.files() " +
      "resolves to a Map, so round-tripping its result needs the conversion."
  );

const SET_REFUSAL = (call) =>
  lossMessage(call, "a Set", "writes an EMPTY archive", "Pass a plain object of { name: contents }.");

const ARCHIVE_REFUSAL =
  lossMessage(
    "new Bun.Archive(archive)",
    "another Archive",
    "produces an EMPTY archive",
    "To copy it, use Bun.Archive.write(path, archive) — which does read its " +
      "contents — or new Bun.Archive(await archive.bytes())."
  );

const BUNFILE_REFUSAL = (name) =>
  lossMessage(
    "a Bun.file() handle as the contents of " + JSON.stringify(name),
    "a BunFile entry value",
    "stores ZERO bytes for it",
    "Read the file first: { " + JSON.stringify(name) + ": await Bun.file(path).bytes() }."
  );

// ---- shared byte helpers ----------------------------------------------------

const dec = new TextDecoder();
const enc = new TextEncoder();

const isGzip = (b) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

/** A NUL-terminated fixed-width tar header field, as a string. */
function cstr(buf, off, len) {
  let end = off;
  const max = Math.min(off + len, buf.length);
  while (end < max && buf[end] !== 0) end++;
  return dec.decode(buf.subarray(off, end));
}

function readOctal(buf, off, len) {
  const raw = cstr(buf, off, len).trim();
  if (!raw) return 0;
  const n = parseInt(raw, 8);
  return Number.isFinite(n) ? n : 0;
}

/** Any ArrayBuffer, any view over one, as a Uint8Array with no copy. */
function viewBytes(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (typeof SharedArrayBuffer !== "undefined" && input instanceof SharedArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}

const isBytes = (v) =>
  v instanceof ArrayBuffer ||
  ArrayBuffer.isView(v) ||
  (typeof SharedArrayBuffer !== "undefined" && v instanceof SharedArrayBuffer);

// A BunFile is not a platform Blob instance in this runtime (see the divergence
// note in bun-file.js), which is exactly what makes it separable from a real
// Blob or a `File` — both of which ARE Blob instances and carry their bytes.
const isBunFileLike = (v) =>
  !!v &&
  typeof v === "object" &&
  !(v instanceof Blob) &&
  typeof v.arrayBuffer === "function" &&
  typeof v.name === "string";

// ---- reading ---------------------------------------------------------------

/**
 * libarchive's tar "bid", which is what decides between a readable archive and
 * `Unrecognized archive format`. A first block that is all zeros is a valid
 * EMPTY archive (real Bun reads 512 zero bytes as `Map {}`); anything else has
 * to carry a header whose octal checksum agrees with its own bytes. That single
 * check is what rejects a zip, a text file and eight bytes of garbage — none of
 * which this code should ever start accepting, since real Bun cannot read them.
 */
function looksLikeTar(buf) {
  if (buf.length < TAR_BLOCK) return false;
  if (allZero(buf, 0)) return true;
  const want = readOctal(buf, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let i = 0; i < TAR_BLOCK; i++) {
    // The checksum field itself counts as eight spaces, by definition.
    const b = i >= 148 && i < 156 ? 32 : buf[i];
    unsigned += b;
    signed += b > 127 ? b - 256 : b;
  }
  // Both, because pre-POSIX writers signed the bytes. A v7 tar has no `ustar`
  // magic at all, so the checksum is the only evidence available for one.
  return want === unsigned || want === signed;
}

function allZero(buf, off) {
  const end = Math.min(off + TAR_BLOCK, buf.length);
  for (let i = off; i < end; i++) if (buf[i] !== 0) return false;
  return true;
}

/**
 * Parse a tar into entries, keeping what `extract()` needs to tell a file from a
 * directory from a symlink. Long names arrive three ways and all three are
 * handled, because all three are in the wild: the ustar `prefix` field (GNU tar
 * uses it when the name splits at a `/`), a GNU `L` entry carrying the name as
 * its payload, and a pax `x`/`g` header carrying a `path=` record — which is
 * what Bun's OWN writer emits for a name over 100 bytes that will not split.
 */
function parseTar(buf) {
  const entries = [];
  let pathOverride = null;
  let linkOverride = null;
  let off = 0;
  while (off + TAR_BLOCK <= buf.length) {
    if (allZero(buf, off)) break;
    const size = readOctal(buf, off + 124, 12);
    const typeByte = buf[off + 156];
    // A NUL typeflag is a v7 regular file, and '7' is POSIX's "contiguous file",
    // which every reader including Bun's treats as an ordinary one. Normalizing
    // both to '0' here is what stops files() from silently dropping them.
    const raw = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
    const type = raw === "7" ? "0" : raw;
    const dataStart = off + TAR_BLOCK;
    // Bun reports a missing PAYLOAD, not a missing final block: a tar trimmed to
    // 600 bytes reads fine when the 5-byte body is inside it, and one trimmed to
    // 512 does not. So the bound is the data, not the padding.
    if (dataStart + size > buf.length) throw new Error(E_TRUNCATED);
    const next = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;

    if (type === "L" || type === "K") {
      const value = cstr(buf, dataStart, size);
      if (type === "L") pathOverride = value;
      else linkOverride = value;
      off = next;
      continue;
    }
    if (type === "x" || type === "g") {
      for (const [key, value] of parsePaxRecords(buf.subarray(dataStart, dataStart + size))) {
        if (key === "path") pathOverride = value;
        else if (key === "linkpath") linkOverride = value;
      }
      off = next;
      continue;
    }

    const name = cstr(buf, off, NAME_MAX);
    const prefix = cstr(buf, off + 345, PREFIX_MAX);
    const full = pathOverride || (prefix ? prefix + "/" + name : name);
    const linkname = linkOverride || cstr(buf, off + 157, NAME_MAX);
    pathOverride = null;
    linkOverride = null;
    entries.push({
      name: full,
      type,
      mode: readOctal(buf, off + 100, 8) & 0o777,
      linkname,
      bytes: buf.slice(dataStart, dataStart + size),
    });
    off = next;
  }
  return entries;
}

/** pax records are `"<byteLength> <key>=<value>\n"`, concatenated. */
function parsePaxRecords(block) {
  const out = [];
  const text = dec.decode(block);
  let i = 0;
  while (i < text.length) {
    const space = text.indexOf(" ", i);
    if (space < 0) break;
    const len = parseInt(text.slice(i, space), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(space + 1, i + len).replace(/\n$/, "");
    const eq = record.indexOf("=");
    if (eq > 0) out.push([record.slice(0, eq), record.slice(eq + 1)]);
    i += len;
  }
  return out;
}

// ---- writing ---------------------------------------------------------------

// Every numeric header field is octal ASCII, and the padding differs per field.
// These three shapes are what bun-1.3.6 emits, byte for byte: GNU tar accepts
// them, and so does Bun's own reader.
function putOctal(block, off, digits, value, suffix) {
  const text = value.toString(8).padStart(digits, "0").slice(-digits) + suffix;
  for (let i = 0; i < text.length; i++) block[off + i] = text.charCodeAt(i);
}
const putMode = (block, off, value) => putOctal(block, off, 6, value, " \0");
const putSize = (block, off, value) => putOctal(block, off, 11, value, " ");

function putAscii(block, off, text, max) {
  for (let i = 0; i < text.length && i < max; i++) block[off + i] = text.charCodeAt(i);
}

/**
 * One 512-byte ustar header. `name`/`prefix` are already split and already known
 * to be ASCII — see splitName and assertAscii.
 */
function tarHeader({ name, prefix, size, mode, typeflag, mtime }) {
  const block = new Uint8Array(TAR_BLOCK);
  putAscii(block, 0, name, NAME_MAX);
  putMode(block, 100, mode);
  putMode(block, 108, 0); // uid — Bun writes 0/0 with empty uname/gname
  putMode(block, 116, 0); // gid
  putSize(block, 124, size);
  putSize(block, 136, mtime);
  block[156] = typeflag.charCodeAt(0);
  putAscii(block, 257, "ustar", 6);
  block[263] = 0x30; // version "00"
  block[264] = 0x30;
  putMode(block, 329, 0); // devmajor
  putMode(block, 337, 0); // devminor
  putAscii(block, 345, prefix, PREFIX_MAX);
  // The checksum covers the whole block with its own field read as spaces.
  let sum = 0;
  for (let i = 0; i < TAR_BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : block[i];
  putOctal(block, 148, 6, sum, "\0 ");
  return block;
}

/**
 * Where to break a name over 100 bytes across the ustar `name`/`prefix` pair.
 * Bun takes the LAST `/` that leaves both halves in range and falls back to a
 * pax header when none does — checked against the binary across six shapes,
 * because the plausible alternative (the first fitting slash) picks a different
 * split for `a*100/b*60/c*5` and would put different bytes on disk.
 */
function splitName(name) {
  if (name.length <= NAME_MAX) return { name, prefix: "" };
  for (let i = name.lastIndexOf("/"); i > 0; i = name.lastIndexOf("/", i - 1)) {
    if (i <= PREFIX_MAX && name.length - i - 1 <= NAME_MAX) {
      return { name: name.slice(i + 1), prefix: name.slice(0, i) };
    }
  }
  return null;
}

/**
 * The name/prefix fields for the two blocks of a PAX entry — libarchive's
 * build_ustar_entry_name, whose numbers look arbitrary and are not: the basename
 * is truncated to 87 bytes in the `PaxHeader/` label and to 98 in the real entry
 * header, and the directory part rides in the name field when both fit in 100,
 * moves to `prefix` when they do not, and is dropped entirely when it exceeds
 * 155. Truncating is safe here and only here, because the whole path travels in
 * the pax `path=` record and no reader takes it from these fields.
 *
 * Derived from twelve shapes measured against the binary rather than from the
 * spec, and it is the difference between an archive that is byte-identical to
 * Bun's and one that merely reads the same.
 */
function paxNameFields(full, label) {
  const slash = full.lastIndexOf("/");
  const dir = slash < 0 ? "" : full.slice(0, slash);
  const base = (slash < 0 ? full : full.slice(slash + 1)).slice(0, label ? 87 : 98);
  const name = label ? label + "/" + base : base;
  if (dir && dir.length + 1 + name.length <= NAME_MAX) return { name: dir + "/" + name, prefix: "" };
  if (dir && dir.length <= PREFIX_MAX) return { name, prefix: dir };
  return { name, prefix: "" };
}

// libarchive will not put a byte above 0x7f in a ustar header and does not fall
// back to pax's hdrcharset for it, so `{ "ü.txt": "x" }` is a hard error in real
// Bun. Reproduced: a shim that quietly wrote the UTF-8 bytes would build
// archives that throw the moment the same code runs under the real binary.
function assertAscii(name) {
  for (let i = 0; i < name.length; i++) if (name.charCodeAt(i) > 0x7f) throw argError(E_HEADER);
}

/** `"<len> path=<value>\n"`, where len counts its own digits. */
function paxRecord(key, value) {
  const tail = " " + key + "=" + value + "\n";
  let len = tail.length + 1;
  while (String(len).length + tail.length !== len) len = String(len).length + tail.length;
  return enc.encode(String(len) + tail);
}

/**
 * Serialize entries as an uncompressed ustar archive — the only thing Bun's
 * writer ever produces, whatever the file extension says.
 */
function writeTar(entries) {
  const mtime = Math.floor(Date.now() / 1000);
  const blocks = [];
  for (const entry of entries) {
    // Bun drops an empty name silently. That one is not data loss worth
    // refusing: there is no path to lose the bytes AT.
    if (!entry.name) continue;
    assertAscii(entry.name);
    const split = splitName(entry.name);
    const size = entry.bytes.length;
    if (!split) {
      // No `/` splits it, so the real path travels in a pax record and both
      // header name fields are decoration — see paxNameFields.
      const record = paxRecord("path", entry.name);
      const label = paxNameFields(entry.name, "PaxHeader");
      blocks.push(tarHeader({ ...label, size: record.length, mode: 0o644, typeflag: "x", mtime }));
      blocks.push(pad(record));
    }
    blocks.push(
      tarHeader({
        ...(split || paxNameFields(entry.name, null)),
        size,
        mode: 0o644,
        typeflag: "0",
        mtime,
      })
    );
    if (size) blocks.push(pad(entry.bytes));
  }
  // Two zero blocks end the archive, then the whole thing is padded out to a
  // record boundary.
  const body = blocks.reduce((n, b) => n + b.length, 0) + TAR_BLOCK * 2;
  const out = new Uint8Array(Math.ceil(body / TAR_RECORD) * TAR_RECORD);
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

/** Copy into a whole number of 512-byte blocks. */
function pad(bytes) {
  const out = new Uint8Array(Math.ceil(bytes.length / TAR_BLOCK) * TAR_BLOCK);
  out.set(bytes, 0);
  return out;
}

// ---- options ---------------------------------------------------------------

/**
 * `{ compress }` is the only option that does anything: `format` is accepted and
 * ignored (`{ format: "zip" }` still writes tar), and so is anything else. The
 * two type errors are separate strings in Bun and both are reproduced, since
 * `compress: true` and `compress: "gz"` are different mistakes.
 */
function normalizeOptions(options) {
  if (options === undefined || options === null) return { gzip: false };
  if (typeof options !== "object" && typeof options !== "function") throw argError(E_OPTIONS);
  const compress = options.compress;
  if (compress === undefined || compress === null) return { gzip: false };
  if (typeof compress !== "string") throw argError(E_COMPRESS_TYPE);
  if (compress !== "gzip") throw argError(E_COMPRESS_VALUE);
  return { gzip: true };
}

// ---- the class -------------------------------------------------------------

export function createBunArchive({ lazy, Buffer }) {
  // zlib is only touched by `{ compress: "gzip" }` and by reading a gzipped
  // archive, so it stays behind `lazy` — a guest that never opens an Archive, or
  // opens only plain tars, must not pull the codec in. Same reason Bun.gzipSync
  // does it this way in bun.js.
  const zlib = () => lazy("zlib");
  const fsmod = () => lazy("fs");
  const pathmod = () => lazy("path");

  // The instance state lives out here so every method can brand-check its
  // receiver and answer with Bun's own wording, which a private field would
  // replace with the engine's.
  const state = new WeakMap();
  const stateOf = (self) => {
    const found = state.get(self);
    if (found) return found;
    const received = (self && self.constructor && self.constructor.name) || "Object";
    throw codedTypeError(E_NOT_ARCHIVE(received), "ERR_INVALID_THIS");
  };

  /** An entry value → bytes. Bun `String()`s anything that is not binary. */
  function toBytes(name, value) {
    if (typeof value === "string") return enc.encode(value);
    if (isBytes(value)) return new Uint8Array(viewBytes(value)); // copy: the caller may reuse it
    if (isBunFileLike(value)) throw new TypeError(BUNFILE_REFUSAL(name));
    if (value instanceof Blob) return value.arrayBuffer().then((ab) => new Uint8Array(ab));
    // `null`, `undefined`, numbers, arrays and plain objects all become their
    // String() form in real Bun — "null", "undefined", "42", "1,2",
    // "[object Object]". Odd, but it is what the binary stores.
    return enc.encode(String(value));
  }

  /**
   * The `{ name: contents }` spec → entries. Returns them synchronously unless a
   * Blob value forces an await, which is what lets `Archive.write` finish before
   * it hands back its promise the way Bun's does.
   */
  function toEntries(spec) {
    const names = Object.keys(spec);
    const values = names.map((name) => toBytes(name, spec[name]));
    if (!values.some((v) => v && typeof v.then === "function")) {
      return names.map((name, i) => ({ name, bytes: values[i] }));
    }
    return Promise.all(values.map((v) => Promise.resolve(v))).then((resolved) =>
      names.map((name, i) => ({ name, bytes: resolved[i] }))
    );
  }

  const thenable = (v) => !!v && typeof v.then === "function";

  /**
   * Refuse the shapes real Bun answers with an empty archive. `call` builds the
   * call form to quote, so the message names the door the caller actually used
   * and the shape they actually passed.
   */
  function assertNotLossy(value, call) {
    if (value instanceof Map) throw new TypeError(MAP_REFUSAL(call("map")));
    if (value instanceof Set) throw new TypeError(SET_REFUSAL(call("set")));
  }
  const CTOR_CALL = (shape) => "new Bun.Archive(" + shape + ")";
  const WRITE_CALL = (shape) => "Bun.Archive.write(path, " + shape + ")";

  class Archive {
    constructor(input, options) {
      // Bun validates the options before it looks at the input, and so does
      // Archive.write — order matters when both are wrong.
      const { gzip } = normalizeOptions(options);
      if (input === null || typeof input === "undefined") throw argError(E_INPUT);
      if (input instanceof Archive) throw new TypeError(ARCHIVE_REFUSAL);
      assertNotLossy(input, CTOR_CALL);
      if (input instanceof Blob) {
        state.set(this, { gzip, blob: input });
        return;
      }
      if (isBytes(input)) {
        state.set(this, { gzip, source: new Uint8Array(viewBytes(input)) });
        return;
      }
      // A BunFile reaches here as a plain object and would be archived as its own
      // property names, which is nonsense rather than data loss — but the caller
      // clearly meant the file.
      if (isBunFileLike(input)) throw new TypeError(BUNFILE_REFUSAL(input.name));
      // A function passes here, as it does in Bun — which archives its own
      // enumerable properties, i.e. usually nothing. Same for a Date or a RegExp.
      if (typeof input !== "object" && typeof input !== "function") throw argError(E_INPUT);
      // An array is an object, and Bun archives it under the keys "0", "1", …
      state.set(this, { gzip, spec: input });
    }

    /** The archive bytes, compressed if the options asked for it. */
    bytes() {
      const self = stateOf(this);
      return promise(sourceBytes(self)).then((src) => Buffer.from(self.gzip ? gzipBytes(src) : src));
    }

    blob() {
      // Bun's Blob carries no type, so neither does this one.
      return this.bytes().then((bytes) => new Blob([bytes]));
    }

    /**
     * `Map<string, Blob>` of the REGULAR FILES only. A create-mode archive is
     * serialized and parsed back rather than answered from the spec directly:
     * that is what makes Bun's own quirks fall out instead of being special-cased
     * here — a name ending in `/` is read back as a directory and disappears, an
     * empty name disappears, and a non-ASCII name throws from `files()` exactly
     * as it does from `bytes()`.
     */
    files() {
      return promise(tarBytes(stateOf(this))).then((tar) => {
        const map = new Map();
        for (const entry of parseTar(tar)) {
          if (entry.type !== "0" || entry.name.endsWith("/")) continue;
          map.set(entry.name, new Blob([entry.bytes]));
        }
        return map;
      });
    }

    /**
     * Unpack into `dest`, answering the number of entries extracted —
     * directories, symlinks and hardlinks included, though a hardlink creates
     * nothing (see below).
     */
    extract(dest) {
      // Bun refuses a non-string here with its own message. "" is refused too,
      // where Bun says `ReadError`: `path.resolve("")` is the process's cwd, so
      // accepting it would unpack the archive over the working directory.
      if (typeof dest !== "string" || dest === "") throw argError(E_EXTRACT_PATH);
      const self = stateOf(this);
      // Bun reports every unreadable archive as `ReadError` from extract(), even
      // the ones files() describes precisely — both the format bid and the
      // truncation check. Kept, because it is a fact about the INPUT that a
      // program might branch on. A failure to write the DESTINATION is the one
      // case where the fs error goes through instead; see this file's header.
      const readable = promise(tarBytes(self))
        .then((tar) => parseTar(tar))
        .catch(() => {
          throw new Error(E_READ);
        });
      return readable.then((entries) => {
        const fs = fsmod();
        const path = pathmod();
        const root = path.resolve(dest);
        let count = 0;
        for (const entry of entries) {
          const rel = safeEntryPath(entry.name);
          if (!rel) continue; // "..", "/" and friends resolve to nothing
          count++;
          const target = path.join(root, rel);
          if (entry.type === "5" || entry.name.endsWith("/")) {
            fs.mkdirSync(target, { recursive: true });
            continue;
          }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          if (entry.type === "2") {
            try {
              fs.unlinkSync(target);
            } catch {}
            fs.symlinkSync(entry.linkname, target);
            continue;
          }
          // A hardlink ('1') is counted and NOT created, which is what real Bun
          // does. Writing a copy instead would put a file on disk that the real
          // binary does not, and this shim's rule is to be stricter than Bun,
          // never looser.
          if (entry.type !== "0") continue;
          fs.writeFileSync(target, entry.bytes, { mode: entry.mode || 0o644 });
        }
        return count;
      });
    }

    /**
     * Write an archive to `path`. Real Bun IGNORES the extension and the `format`
     * option: this always emits tar, gzipped only when asked.
     */
    static write(path, files, options) {
      if (typeof path !== "string") throw argError(E_WRITE_PATH);
      const { gzip } = normalizeOptions(options);
      if (files === null || typeof files === "undefined") throw argError(E_WRITE_FILES);
      assertNotLossy(files, WRITE_CALL);
      const finish = (bytes) => {
        fsmod().writeFileSync(path, gzip ? gzipBytes(bytes) : bytes);
      };
      // An Archive, or raw bytes, is written as-is — Bun does not re-tar either,
      // so `write(path, threeGarbageBytes)` really does produce a 3-byte file.
      if (files instanceof Archive) {
        return files.bytes().then(finish);
      }
      if (files instanceof Blob) {
        return files.arrayBuffer().then((ab) => finish(new Uint8Array(ab)));
      }
      if (isBytes(files)) {
        finish(viewBytes(files));
        return Promise.resolve();
      }
      if (isBunFileLike(files)) throw new TypeError(BUNFILE_REFUSAL(files.name));
      if (typeof files !== "object" && typeof files !== "function") throw argError(E_WRITE_FILES);
      const entries = toEntries(files);
      if (thenable(entries)) return entries.then((e) => finish(writeTar(e)));
      // Synchronously, so a caller that ignores the promise still finds the file
      // — which is how the real one behaves.
      finish(writeTar(entries));
      return Promise.resolve();
    }
  }

  // `Object.prototype.toString.call(archive)` is "[object Archive]" in Bun.
  Object.defineProperty(Archive.prototype, Symbol.toStringTag, { value: "Archive", configurable: true });
  // Bun reports 2 even though write() takes an options argument as well.
  Object.defineProperty(Archive.write, "length", { value: 2, configurable: true });

  const promise = (v) => (thenable(v) ? v : Promise.resolve(v));

  /** The archive bytes as supplied (read mode) or as serialized (create mode). */
  function sourceBytes(self) {
    if (self.source) return self.source;
    if (self.blob) return self.blob.arrayBuffer().then((ab) => (self.source = new Uint8Array(ab)));
    const entries = toEntries(self.spec);
    return thenable(entries) ? entries.then(writeTar) : writeTar(entries);
  }

  /** The bytes to PARSE: the source, gunzipped when it is a gzip. */
  function tarBytes(self) {
    return promise(sourceBytes(self)).then((src) => {
      const tar = isGzip(src) ? new Uint8Array(zlib().gunzipSync(src)) : src;
      // The bid runs after decompression, so a gzip of something that is not a
      // tar gets the same `Unrecognized archive format` as a bare zip.
      if (!looksLikeTar(tar)) throw new Error(E_FORMAT);
      return tar;
    });
  }

  const gzipBytes = (bytes) => new Uint8Array(zlib().gzipSync(bytes));

  return { Archive };
}

/**
 * An archive entry name → a path guaranteed to stay under the destination.
 * libarchive already does this and it is not optional: `../../etc/passwd` is the
 * classic tar attack, and real Bun drops the `..` segments and the leading `/`
 * rather than escaping (verified — `../escaped.txt` lands INSIDE the target).
 * Returns "" for an entry that sanitizes away to nothing, which the caller skips
 * and does not count.
 *
 * `..` POPS the segment before it rather than simply being dropped, which is the
 * difference between Bun's answer and a plausible wrong one: `a/../../b.txt`
 * extracts to `b.txt` there, not to `a/b.txt`. A pop that runs out of segments
 * stops at the root, so no sequence of `..` can climb above the destination.
 */
export function safeEntryPath(name) {
  const out = [];
  for (const segment of String(name).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.join("/");
}

// Exported for scripts/spike-bun-offline.mjs: the codec is a pure function of
// bytes, so the offline tier can drive the real reader and the real writer with
// no kernel and pin them against archives the host `tar` produced.
export { parseTar, writeTar, looksLikeTar, splitName, isGzip };
