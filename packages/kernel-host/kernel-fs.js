// The kernel's own client to the File System Worker (Phase 2 #14).
//
// After the VFS moves off the kernel thread, the kernel still needs filesystem
// access for its own housekeeping: seeding /bin coreutils and demo files at boot,
// resolving a command on PATH (isFile), and caching fetched bodies. Those calls
// were synchronous, and keeping them synchronous avoids rippling `await` through
// boot code and every test.
//
// So the kernel gets its *own* SAB channel to the FS Worker and blocks on it the
// same way a process does — Atomics.wait on the kernel thread (a Web Worker in
// the browser; Node's main thread in headless, where Atomics.wait is allowed).
// Payloads larger than the 1 MiB SAB window take one of two routes off it, and
// which one is decided by whether the caller can await, not by size. A caller
// that can (writeLarge, for fetched tarballs and editor saves) hands the bytes
// over on a transferable ArrayBuffer: one hop, no copy. A caller that cannot —
// the kernel's own synchronous tree walkers — goes through the fd layer in
// slices, which is slower but stays synchronous.

import {
  makeViews,
  encodeString,
  decodeBytes,
  encodeRequest,
  SAB_BYTES,
  I_STATE,
  I_OPCODE,
  I_REQ_LEN,
  I_RES_LEN,
  STATE_REQUEST,
  STATE_RESPONSE_ERR,
  FLAG_RECURSIVE,
  OP_READ_FILE,
  OP_WRITE_FILE,
  OP_MKDIR,
  OP_STAT,
  OP_EXISTS,
  OP_READDIR,
  OP_UNLINK,
  OP_RMDIR,
  OP_RENAME,
  OP_LSTAT,
  OP_SYMLINK,
  OP_READLINK,
  OP_OPEN,
  OP_CLOSE,
  OP_FD_READ,
  OP_FD_WRITE,
  OP_FSTAT,
  u32ToBytes,
  bytesToU32,
  f64ToBytes,
  fitsSharedWindow,
  isWindowOverflow,
} from "../protocol/syscall.js";

// Slice size for whole-file I/O that does not fit the window, matching
// runtime/fs-client.js: comfortably inside the 1 MiB window once frame headers
// are counted, and few enough round trips that an 8 MiB file costs 16.
const FD_CHUNK = 512 * 1024;
const O_RDONLY = 0;
// O_WRONLY | O_CREAT | O_TRUNC — the flags behind a whole-file overwrite.
const O_WRITE_TRUNC = 1 | 0o100 | 0o1000;

// The kernel registers as client 0; processes use their (>= 1) pid.
export const KERNEL_CLIENT = 0;

/**
 * Wire up the kernel's synchronous fs client against `fsWorker`.
 *
 * @param fsWorker  a handle with postMessage() — the environment's File System
 *                  Worker. Also used (with a transfer list) for writeLarge.
 * @returns { fs, onMessage } — `fs` is injected into the Kernel; `onMessage`
 *          must be fed the FS Worker's messages so writeLarge acks resolve.
 */
export function createKernelFs(fsWorker) {
  const sab = new SharedArrayBuffer(SAB_BYTES);
  const { ctrl, data } = makeViews(sab);
  fsWorker.postMessage({ type: "fs-register", client: KERNEL_CLIENT, sab });
  // Set by the Kernel via fs.setBodyConsumedHandler; see onMessage.
  let onBodyConsumed = null;

  function call(opcode, request) {
    if (request.length > data.length) {
      throw new Error("kernel fs request too large for the shared data region");
    }
    data.set(request, 0);
    Atomics.store(ctrl, I_OPCODE, opcode);
    Atomics.store(ctrl, I_REQ_LEN, request.length);
    Atomics.store(ctrl, I_STATE, STATE_REQUEST);
    fsWorker.postMessage({ type: "fs", client: KERNEL_CLIENT }); // ring the doorbell
    Atomics.wait(ctrl, I_STATE, STATE_REQUEST);
    const state = Atomics.load(ctrl, I_STATE);
    const payload = data.slice(0, Atomics.load(ctrl, I_RES_LEN));
    if (state === STATE_RESPONSE_ERR) {
      const err = new Error(decodeBytes(payload));
      err.code = decodeBytes(payload);
      throw err;
    }
    return payload;
  }

  let seq = 1;
  const pending = new Map();

  function writeLarge(path, bytes) {
    const body = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
    // The transfer list needs a standalone, transferable ArrayBuffer. A
    // Uint8Array can be a VIEW into a larger buffer — a subarray, or (the common
    // trap) a Node `Buffer` carved out of the shared Buffer pool, whose backing
    // ArrayBuffer is oversized and shared with other Buffers. Transferring that
    // either clobbers unrelated data or, for a pooled Buffer, throws "Cannot
    // transfer object of unsupported type". Detach only when the view owns its
    // whole buffer; otherwise copy the exact bytes into a fresh ArrayBuffer.
    const ownsWhole = body.byteOffset === 0 && body.byteLength === body.buffer.byteLength && body.buffer instanceof ArrayBuffer;
    const ab = ownsWhole ? body.buffer : body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    return new Promise((resolve, reject) => {
      const id = seq++;
      pending.set(id, { resolve, reject });
      // Transfer the standalone buffer so a multi-MB tarball never touches the
      // 1 MiB SAB. `ab` is either the body's own buffer or a fresh copy, so
      // detaching it is always safe.
      fsWorker.postMessage(
        { type: "fs-write-large", id, path, buffer: ab, byteOffset: 0, byteLength: body.byteLength },
        [ab],
      );
    });
  }

  // Whole-file I/O for a file too big for the shared window, over the fd layer.
  //
  // writeLarge's trick — hand the bytes over on a transfer — needs a Promise, and
  // most of the kernel's own file access cannot await: the bulk tree walkers
  // (export, recursive copy, search, the .d.ts and Python harvests) are
  // synchronous several frames deep, and each one of them reads whole files. The
  // fd opcodes carry an explicit (len, pos), so they are not bounded by the
  // window and they stay synchronous. It is also the route the protocol already
  // prescribes: an oversized read is answered with EFBIG precisely so the client
  // retries here, which is what every process inside the VM already does for
  // fs.readFileSync (runtime/node/bindings/fs.js). The kernel just never did.
  function withFd(path, oflags, mode, body) {
    const fd = bytesToU32(
      call(OP_OPEN, encodeRequest([encodeString(path), u32ToBytes(oflags), u32ToBytes(mode)])),
    );
    try {
      return body(fd);
    } finally {
      // Not conditional on success: the FS Worker's fd table is process-global,
      // so an fd leaked by a failed read stays open for the life of the session.
      // Nor allowed to throw — a close failure would replace whatever the body
      // threw, which is the error worth seeing.
      try {
        call(OP_CLOSE, encodeRequest([u32ToBytes(fd)]));
      } catch {
        /* the fd is unusable either way */
      }
    }
  }

  function readChunked(path) {
    return withFd(path, O_RDONLY, 0, (fd) => {
      const size = JSON.parse(decodeBytes(call(OP_FSTAT, encodeRequest([u32ToBytes(fd)])))).size | 0;
      const out = new Uint8Array(size);
      let at = 0;
      while (at < size) {
        const chunk = call(
          OP_FD_READ,
          encodeRequest([u32ToBytes(fd), u32ToBytes(Math.min(FD_CHUNK, size - at)), f64ToBytes(at)]),
        );
        if (!chunk.length) break; // EOF early: the file shrank since fstat
        out.set(chunk, at);
        at += chunk.length;
      }
      return at === size ? out : out.subarray(0, at);
    });
  }

  function writeChunked(path, body) {
    withFd(path, O_WRITE_TRUNC, 0o666, (fd) => {
      let at = 0;
      while (at < body.length) {
        const slice = body.subarray(at, Math.min(at + FD_CHUNK, body.length));
        const n = bytesToU32(
          call(OP_FD_WRITE, encodeRequest([u32ToBytes(fd), f64ToBytes(at), slice])),
        );
        // A zero-length write is not a short write to retry, it is no progress:
        // looping on it would hang the kernel thread inside Atomics.wait forever.
        if (!n) throw new Error(`fs: stalled writing ${path} at ${at} of ${body.length}`);
        at += n;
      }
    });
  }

  function readWhole(path) {
    try {
      return call(OP_READ_FILE, encodeRequest([encodeString(path)]));
    } catch (err) {
      if (!isWindowOverflow(err)) throw err;
      return readChunked(path);
    }
  }

  // Write many files in ONE transfer instead of one SAB round-trip each. Used to
  // deliver a package manager's tree at boot (npm ~2400 files): all bodies are
  // concatenated into a single fresh ArrayBuffer, transferred once, and written
  // by the FS Worker's writeBatch() (which also mkdirp's parents). `files` is
  // `[{ path, bytes }]` (bytes: Uint8Array|Buffer|string). Returns a Promise.
  function writeFilesBatch(files) {
    let total = 0;
    const norm = files.map((f) => {
      const bytes = typeof f.contents === "string" || typeof f.bytes === "string"
        ? enc(f.contents ?? f.bytes)
        : (f.bytes ?? f.contents);
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
      total += u8.byteLength;
      return { path: f.path, u8 };
    });
    const buffer = new ArrayBuffer(total);
    const out = new Uint8Array(buffer);
    const entries = new Array(norm.length);
    let offset = 0;
    for (let i = 0; i < norm.length; i++) {
      const { path, u8 } = norm[i];
      out.set(u8, offset);
      entries[i] = { path, byteOffset: offset, byteLength: u8.byteLength };
      offset += u8.byteLength;
    }
    return new Promise((resolve, reject) => {
      const id = seq++;
      pending.set(id, { resolve, reject });
      fsWorker.postMessage({ type: "fs-write-batch", id, entries, buffer }, [buffer]);
    });
  }

  // ---- persistent dependency cache round-trips (P1) -------------------------
  // node_modules snapshot save/restore/has run in the FS Worker (it holds the
  // VFS + OPFS), so they answer asynchronously over postMessage — same shape as
  // writeLarge/writeFilesBatch. Each resolves the pending entry keyed by id.
  function depCacheCall(type, payload) {
    return new Promise((resolve, reject) => {
      const id = seq++;
      pending.set(id, { resolve, reject });
      fsWorker.postMessage({ type, id, ...payload });
    });
  }
  function depCacheHas(key) {
    return depCacheCall("dep-cache-has", { key });
  }
  function depCacheSave(key, dir, aliases = []) {
    return depCacheCall("dep-cache-save", { key, dir, aliases });
  }
  function depCacheRestore(key, dir) {
    return depCacheCall("dep-cache-restore", { key, dir });
  }
  // Hand a shipped snapshot's bytes to the store. The buffer is TRANSFERRED, not
  // copied — these archives are ~100 MB and a structured clone would briefly double
  // that on a machine where memory is the scarce thing. Consequence for callers:
  // `archive` is detached once this returns, so do not read it afterwards.
  function depCacheImport(key, archive, aliases = []) {
    return new Promise((resolve, reject) => {
      const id = seq++;
      pending.set(id, { resolve, reject });
      fsWorker.postMessage({ type: "dep-cache-import", id, key, archive, aliases }, [archive.buffer]);
    });
  }

  function onMessage(msg) {
    if (!msg) return;
    if (msg.type === "fetch-body-consumed") {
      // The FS worker saw a process finish reading a fetched body. Routed here
      // rather than in each embedder's message handler so the browser and headless
      // twins cannot drift; the Kernel installs the handler on construction.
      if (onBodyConsumed) onBodyConsumed(msg.path);
      return;
    }
    if (msg.type === "fs-write-large-ok" || msg.type === "fs-write-batch-ok") {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        p.resolve(msg.count);
      }
    } else if (msg.type === "fs-write-large-err" || msg.type === "fs-write-batch-err") {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        p.reject(new Error(msg.error || "EIO"));
      }
    } else if (msg.type === "dep-cache-has-ok") {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.resolve(!!msg.has); }
    } else if (msg.type === "dep-cache-restore-ok") {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.resolve(msg.count | 0); }
    } else if (msg.type === "dep-cache-save-ok" || msg.type === "dep-cache-import-ok") {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.resolve(msg.result || null); }
    } else if (
      msg.type === "dep-cache-has-err" ||
      msg.type === "dep-cache-restore-err" ||
      msg.type === "dep-cache-save-err" ||
      msg.type === "dep-cache-import-err"
    ) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.reject(new Error(msg.error || "EIO")); }
    }
  }

  const enc = encodeString;
  const fs = {
    readFile(path) {
      return decodeBytes(readWhole(path));
    },
    // Raw bytes — use for binary files (images) so a read→write round-trip through
    // copy doesn't corrupt them by decoding to a JS string.
    //
    // Size is not the caller's problem. The one-shot read is a single syscall and
    // stays the path for the overwhelming majority of files; the chunk loop costs
    // one cheap failed syscall to discover, and only for files that could not be
    // read at all before. Making the DEFAULT safe is the point: every silent
    // truncation this replaced came from a caller that had no idea there was a
    // ceiling, and a second opt-in method would just wait for the next one.
    readFileBytes(path) {
      return readWhole(path);
    },
    // The write side can be measured before it is sent, so it is decided rather
    // than discovered.
    writeFile(path, contents) {
      const body = typeof contents === "string" ? enc(contents) : contents;
      if (fitsSharedWindow([enc(path).length, body.length])) {
        call(OP_WRITE_FILE, encodeRequest([enc(path), body]));
      } else {
        writeChunked(path, body);
      }
    },
    mkdirp(path) {
      call(OP_MKDIR, encodeRequest([enc(path)], FLAG_RECURSIVE));
    },
    readdir(path) {
      const s = decodeBytes(call(OP_READDIR, encodeRequest([enc(path)])));
      return s ? s.split("\n").filter(Boolean) : [];
    },
    stat(path) {
      return JSON.parse(decodeBytes(call(OP_STAT, encodeRequest([enc(path)]))));
    },
    // lstat/symlink/readlink mirror the process syscall client (runtime/fs-client.js).
    // The kernel gained them so main-thread git (isomorphic-git via the vv-git-fs
    // RPC) has the full POSIX metadata surface it needs — symlink-typed blobs,
    // lstat to tell a link from a file, etc.
    lstat(path) {
      return JSON.parse(decodeBytes(call(OP_LSTAT, encodeRequest([enc(path)]))));
    },
    symlink(target, linkpath) {
      call(OP_SYMLINK, encodeRequest([enc(target), enc(linkpath)]));
    },
    readlink(path) {
      return decodeBytes(call(OP_READLINK, encodeRequest([enc(path)])));
    },
    isFile(path) {
      try {
        return this.stat(path).kind === "file";
      } catch {
        return false;
      }
    },
    exists(path) {
      return call(OP_EXISTS, encodeRequest([enc(path)]))[0] === 1;
    },
    unlink(path) {
      call(OP_UNLINK, encodeRequest([enc(path)]));
    },
    rmdir(path) {
      call(OP_RMDIR, encodeRequest([enc(path)]));
    },
    rename(from, to) {
      call(OP_RENAME, encodeRequest([enc(from), enc(to)]));
    },
    writeLarge,
    writeFilesBatch,
    depCacheHas,
    depCacheSave,
    depCacheRestore,
    depCacheImport,
    // Called by the Kernel constructor to receive fetched-body read completions.
    setBodyConsumedHandler(fn) {
      onBodyConsumed = fn;
    },
  };

  return { fs, onMessage };
}