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
    return new Promise((resolve, reject) => {
      const id = seq++;
      pending.set(id, { resolve, reject });
      // Transfer the underlying buffer so a multi-MB tarball never touches the
      // 1 MiB SAB. `body` is a fresh array from the fetcher, so detaching is safe.
      fsWorker.postMessage(
        { type: "fs-write-large", id, path, buffer: body.buffer, byteOffset: body.byteOffset, byteLength: body.byteLength },
        [body.buffer],
      );
    });
  }

  function onMessage(msg) {
    if (!msg) return;
    if (msg.type === "fs-write-large-ok") {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        p.resolve();
      }
    } else if (msg.type === "fs-write-large-err") {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        p.reject(new Error(msg.error || "EIO"));
      }
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
  };

  return { fs, onMessage };
}
