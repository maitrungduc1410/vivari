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
// The one exception is writeLarge: fetched tarballs can exceed the 1 MiB SAB
// window, so those go over a transferable ArrayBuffer message instead.

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
} from "../protocol/syscall.js";

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

  function onMessage(msg) {
    if (!msg) return;
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
    } else if (msg.type === "dep-cache-save-ok") {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.resolve(msg.result || null); }
    } else if (
      msg.type === "dep-cache-has-err" ||
      msg.type === "dep-cache-restore-err" ||
      msg.type === "dep-cache-save-err"
    ) {
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); p.reject(new Error(msg.error || "EIO")); }
    }
  }

  const enc = encodeString;
  const fs = {
    readFile(path) {
      return decodeBytes(call(OP_READ_FILE, encodeRequest([enc(path)])));
    },
    // Raw bytes — use for binary files (images) so a read→write round-trip through
    // copy doesn't corrupt them by decoding to a JS string.
    readFileBytes(path) {
      return call(OP_READ_FILE, encodeRequest([enc(path)]));
    },
    writeFile(path, contents) {
      const body = typeof contents === "string" ? enc(contents) : contents;
      call(OP_WRITE_FILE, encodeRequest([enc(path), body]));
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
  };

  return { fs, onMessage };
}