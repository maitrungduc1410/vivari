// The Kernel — the "supervisor" side of the system, environment-agnostic.
//
// It owns the single shared VFS (Rust/Wasm) and a process table. Each process is
// a worker with its own SharedArrayBuffer channel; the kernel services every
// process's syscalls from its own event loop, and can spawn new processes.
//
// The elegant part (brick 4): a process that calls spawnSync/execSync parks on
// Atomics.wait via OP_SPAWN; the kernel drives the child to completion (servicing
// the child's own syscalls in the meantime) and only then wakes the parent with
// the child's exit code and captured output. That is a real waitpid, built on the
// same sync bridge as brick 1.
//
// Injected by the environment:
//   - vfs:         the Rust/Wasm VirtualFileSystem instance
//   - spawnWorker: (info) => handle   creates a worker (browser Worker or Node
//                  worker_threads), wires messages to info.on[type], posts
//                  {type:'init', sab, spec}; returns { terminate() }
//   - stdout/stderr(chunk, pid):  where non-captured process output goes

import {
  makeViews,
  encodeString,
  decodeBytes,
  decodeRequest,
  u32ToBytes,
  bytesToU32,
  bytesToF64,
  SAB_BYTES,
  I_STATE,
  I_OPCODE,
  I_REQ_LEN,
  I_RES_LEN,
  STATE_RESPONSE_OK,
  STATE_RESPONSE_ERR,
  FLAG_RECURSIVE,
  OP_READ_FILE,
  OP_WRITE_FILE,
  OP_EXISTS,
  OP_READDIR,
  OP_MKDIR,
  OP_STAT,
  OP_LSTAT,
  OP_UNLINK,
  OP_RMDIR,
  OP_RENAME,
  OP_SYMLINK,
  OP_READLINK,
  OP_OPEN,
  OP_CLOSE,
  OP_FD_READ,
  OP_FD_WRITE,
  OP_FSTAT,
  OP_FTRUNCATE,
  OP_SPAWN,
  OP_LISTEN,
  OP_ACCEPT,
  OP_RESPOND,
  OP_CLOSE_SERVER,
  OP_FETCH,
} from "../protocol/syscall.js";
import { COREUTILS } from "./coreutils.js";

const EMPTY = new Uint8Array(0);

export class Kernel {
  constructor({ vfs, spawnWorker, stdout, stderr, fetcher }) {
    this.vfs = vfs;
    this.spawnWorker = spawnWorker;
    this.stdout = stdout || (() => {});
    this.stderr = stderr || (() => {});
    this.procs = new Map(); // pid -> process record
    this.nextPid = 1;
    this.onProcExit = null; // optional observer (pid, result)

    // ---- virtual network (brick 5) ----
    this.listeners = new Map(); // port -> pid of the server process
    this.pendingHttp = new Map(); // reqId -> { resolve, pid }
    this.nextReqId = 1;
    this.onListen = null; // optional observer (port, pid) — e.g. wire a preview

    // ---- network fetch (Phase 2 #9) ----
    // Injected by the environment: (url) => Promise<{ok,status,headers,body:Uint8Array}>.
    // The browser routes this to a dedicated Fetcher Worker; tests inject a mock.
    this.fetcher = fetcher || null;
    // URL -> { path, status, ok, contentType, size } — content cache so a repeated
    // fetch (npm re-resolving the same package) skips the network entirely.
    this.fetchCache = new Map();
    this.onFetch = null; // optional observer (url, {cached,size}) — e.g. a UI log
  }

  // ---- VFS helpers ----------------------------------------------------------
  writeFile(path, contents) {
    this.vfs.write_file(path, typeof contents === "string" ? encodeString(contents) : contents);
  }
  mkdirp(path) {
    this.vfs.mkdir(path, true);
  }
  isFile(path) {
    try {
      return JSON.parse(this.vfs.stat(path)).kind === "file";
    } catch {
      return false;
    }
  }

  /** Install the built-in programs into /bin so they are available on PATH. */
  installCoreutils() {
    this.mkdirp("/bin");
    for (const [name, source] of Object.entries(COREUTILS)) {
      this.writeFile("/bin/" + name + ".js", source);
    }
  }

  normalizePath(p) {
    const abs = p.startsWith("/");
    const st = [];
    for (const c of p.split("/")) {
      if (!c || c === ".") continue;
      if (c === "..") st.pop();
      else st.push(c);
    }
    return (abs ? "/" : "") + st.join("/") || (abs ? "/" : ".");
  }
  resolvePath(cwd, p) {
    return this.normalizePath(p.startsWith("/") ? p : cwd + "/" + p);
  }

  /** Resolve a command name to a program file in the VFS (PATH = /bin). */
  resolveProgram(command, cwd) {
    const candidates = [];
    if (command.includes("/")) {
      const abs = this.resolvePath(cwd, command);
      candidates.push(abs, abs + ".js");
    } else {
      candidates.push("/bin/" + command, "/bin/" + command + ".js");
    }
    return candidates.find((c) => this.isFile(c)) || null;
  }

  // ---- process lifecycle ----------------------------------------------------
  createProcess(spec, { parentPid = null, capture = false } = {}) {
    const pid = this.nextPid++;
    const sab = new SharedArrayBuffer(SAB_BYTES);
    const { ctrl, data } = makeViews(sab);
    const proc = {
      pid,
      parentPid,
      capture,
      ctrl,
      data,
      outBuf: [],
      errBuf: [],
      onExit: null,
      finalized: false,
      handle: null,
      command: spec.command,
      serverInbox: [], // queued { reqId, port, req } drained by non-blocking accept
    };
    this.procs.set(pid, proc);
    proc.handle = this.spawnWorker({
      pid,
      sab,
      spec: { ...spec, pid, ppid: parentPid ?? 0 },
      on: {
        syscall: () => this.serviceSyscall(pid),
        stdout: (m) => this.onOutput(pid, m.chunk, false),
        stderr: (m) => this.onOutput(pid, m.chunk, true),
        exit: (m) => this.finalize(pid, m.code | 0),
      },
    });
    return pid;
  }

  onOutput(pid, chunk, isErr) {
    const proc = this.procs.get(pid);
    if (!proc) return;
    if (proc.capture) (isErr ? proc.errBuf : proc.outBuf).push(chunk);
    else (isErr ? this.stderr : this.stdout)(chunk, pid);
  }

  finalize(pid, code) {
    const proc = this.procs.get(pid);
    if (!proc || proc.finalized) return;
    proc.finalized = true;
    try {
      proc.handle && proc.handle.terminate();
    } catch {
      /* ignore */
    }
    this.procs.delete(pid);
    // Drop any ports this process was serving and fail its in-flight requests,
    // so a fetch that was waiting on a now-dead server does not hang forever.
    for (const [port, owner] of this.listeners) {
      if (owner === pid) this.listeners.delete(port);
    }
    for (const [reqId, pend] of this.pendingHttp) {
      if (pend.pid === pid) {
        pend.resolve({
          status: 502,
          headers: { "content-type": "text/plain" },
          body: "server process exited\n",
        });
        this.pendingHttp.delete(reqId);
      }
    }
    const result = {
      code,
      pid,
      stdout: proc.outBuf.join(""),
      stderr: proc.errBuf.join(""),
    };
    if (proc.onExit) proc.onExit(result);
    if (this.onProcExit) this.onProcExit(pid, result);
  }

  /** Start a top-level process; resolves with { pid, code, stdout, stderr }. */
  start(command, args = [], opts = {}) {
    const cwd = opts.cwd || "/";
    const programPath = this.resolveProgram(command, cwd);
    return new Promise((resolve) => {
      if (!programPath) {
        resolve({ pid: -1, code: 127, stdout: "", stderr: command + ": not found\n" });
        return;
      }
      const pid = this.createProcess(
        { programPath, args, cwd, env: opts.env || {} },
        { capture: !!opts.capture },
      );
      this.procs.get(pid).onExit = resolve;
    });
  }

  // ---- syscall servicing ----------------------------------------------------
  respondOk(proc, bytes) {
    proc.data.set(bytes, 0);
    Atomics.store(proc.ctrl, I_RES_LEN, bytes.length);
    Atomics.store(proc.ctrl, I_STATE, STATE_RESPONSE_OK);
    Atomics.notify(proc.ctrl, I_STATE);
  }
  respondErr(proc, code) {
    const bytes = encodeString(code);
    proc.data.set(bytes, 0);
    Atomics.store(proc.ctrl, I_RES_LEN, bytes.length);
    Atomics.store(proc.ctrl, I_STATE, STATE_RESPONSE_ERR);
    Atomics.notify(proc.ctrl, I_STATE);
  }

  serviceSyscall(pid) {
    const proc = this.procs.get(pid);
    if (!proc) return;
    const opcode = Atomics.load(proc.ctrl, I_OPCODE);
    const { flags, fields } = decodeRequest(
      proc.data.slice(0, Atomics.load(proc.ctrl, I_REQ_LEN)),
    );
    if (opcode === OP_SPAWN) {
      this.handleSpawn(proc, JSON.parse(decodeBytes(fields[0])));
      return; // response is deferred until the child exits
    }
    if (opcode === OP_ACCEPT) {
      this.handleAccept(proc);
      return; // deferred until a request arrives for one of this proc's ports
    }
    if (opcode === OP_LISTEN || opcode === OP_RESPOND || opcode === OP_CLOSE_SERVER) {
      this.handleNet(proc, opcode, JSON.parse(decodeBytes(fields[0])));
      return;
    }
    if (opcode === OP_FETCH) {
      this.handleFetch(proc, JSON.parse(decodeBytes(fields[0])));
      return; // deferred until the network fetch resolves
    }
    try {
      this.respondOk(proc, this.fsDispatch(opcode, flags, fields));
    } catch (err) {
      this.respondErr(proc, typeof err === "string" ? err : String(err?.message || "EIO"));
    }
  }

  // ---- virtual network servicing (brick 5) ----------------------------------
  handleNet(proc, opcode, msg) {
    if (opcode === OP_LISTEN) {
      const port = msg.port | 0;
      const owner = this.listeners.get(port);
      if (owner != null && owner !== proc.pid && this.procs.has(owner)) {
        this.respondErr(proc, "EADDRINUSE");
        return;
      }
      this.listeners.set(port, proc.pid);
      this.respondOk(proc, EMPTY);
      if (this.onListen) this.onListen(port, proc.pid);
      return;
    }
    if (opcode === OP_CLOSE_SERVER) {
      const port = msg.port | 0;
      if (this.listeners.get(port) === proc.pid) this.listeners.delete(port);
      this.respondOk(proc, EMPTY);
      return;
    }
    // OP_RESPOND: the server produced an HTTP response; resolve the waiting
    // fetch and unblock the server so it can loop back to accept.
    const pend = this.pendingHttp.get(msg.reqId);
    if (pend) {
      pend.resolve({ status: msg.status, headers: msg.headers, body: msg.body });
      this.pendingHttp.delete(msg.reqId);
    }
    this.respondOk(proc, EMPTY);
  }

  // Non-blocking accept (Phase 2 #5): the process event loop calls this after a
  // `net` nudge and drains in a loop, so we never park. Empty reply = inbox drained.
  handleAccept(proc) {
    if (proc.serverInbox.length) {
      this.respondOk(proc, encodeString(JSON.stringify(proc.serverInbox.shift())));
    } else {
      this.respondOk(proc, EMPTY);
    }
  }

  /**
   * Route an inbound HTTP request to the process listening on `port`.
   * Returns a Promise<{status,headers,body}>. This is the kernel's public
   * entry point for the Service Worker (browser) or tests (node).
   */
  handleHttpRequest(port, req) {
    const pid = this.listeners.get(port | 0);
    if (pid == null || !this.procs.has(pid)) {
      return Promise.resolve({
        status: 502,
        headers: { "content-type": "text/plain" },
        body: `No server listening on port ${port}\n`,
      });
    }
    const proc = this.procs.get(pid);
    const reqId = this.nextReqId++;
    return new Promise((resolve) => {
      this.pendingHttp.set(reqId, { resolve, pid });
      proc.serverInbox.push({ reqId, port: port | 0, req });
      // Nudge the process's event loop (Phase 2 #5). It wakes, drains the inbox
      // via non-blocking accept, and replies through OP_RESPOND.
      try {
        proc.handle && proc.handle.postMessage && proc.handle.postMessage({ type: "net" });
      } catch {
        /* worker gone; finalize() will 502 the pending request */
      }
    });
  }

  handleSpawn(parent, spec) {
    const cwd = spec.cwd || "/";
    const programPath = this.resolveProgram(spec.command, cwd);
    if (!programPath) {
      this.respondErr(parent, "ENOENT");
      return;
    }
    const childPid = this.createProcess(
      { programPath, args: spec.args || [], cwd, env: spec.env || {} },
      { parentPid: parent.pid, capture: !!spec.capture },
    );
    this.procs.get(childPid).onExit = (res) => {
      this.respondOk(
        parent,
        encodeString(
          JSON.stringify({
            code: res.code,
            stdout: res.stdout,
            stderr: res.stderr,
            pid: childPid,
          }),
        ),
      );
    };
  }

  // ---- network fetch servicing (Phase 2 #9) ---------------------------------
  // VFS path where a fetched body is materialized. encodeURIComponent keeps the
  // whole URL in a single flat filename (no '/'), so it is collision-free.
  _fetchCachePath(url) {
    return "/var/cache/oc-fetch/" + encodeURIComponent(url);
  }

  // Deferred like handleSpawn: the caller stays parked on Atomics.wait while we
  // fetch (off-thread, in the Fetcher Worker) and stream the body into the VFS.
  async handleFetch(proc, { url }) {
    try {
      const cached = this.fetchCache.get(url);
      if (cached) {
        if (this.onFetch) this.onFetch(url, { cached: true, size: cached.size });
        this.respondOk(proc, encodeString(JSON.stringify({ ...cached, cached: true })));
        return;
      }
      if (!this.fetcher) {
        this.respondErr(proc, "ENETUNREACH");
        return;
      }
      const res = await this.fetcher(url);
      // Process may have exited while the fetch was in flight.
      if (!this.procs.has(proc.pid)) return;
      const body = res.body instanceof Uint8Array ? res.body : new Uint8Array(res.body || 0);
      const path = this._fetchCachePath(url);
      this.mkdirp("/var/cache/oc-fetch");
      this.vfs.write_file(path, body);
      const headers = res.headers || {};
      const meta = {
        status: res.status | 0,
        ok: !!res.ok,
        contentType: headers["content-type"] || headers["Content-Type"] || "",
        size: body.byteLength,
        path,
      };
      this.fetchCache.set(url, meta);
      if (this.onFetch) this.onFetch(url, { cached: false, size: meta.size });
      this.respondOk(proc, encodeString(JSON.stringify({ ...meta, cached: false })));
    } catch (err) {
      if (!this.procs.has(proc.pid)) return;
      this.respondErr(proc, typeof err === "string" ? err : String(err?.message || "EFETCH"));
    }
  }

  fsDispatch(opcode, flags, fields) {
    const vfs = this.vfs;
    const s = (i) => decodeBytes(fields[i]);
    switch (opcode) {
      case OP_READ_FILE:
        return vfs.read_file(s(0));
      case OP_WRITE_FILE:
        return vfs.write_file(s(0), fields[1]), EMPTY;
      case OP_EXISTS:
        return new Uint8Array([vfs.exists(s(0)) ? 1 : 0]);
      case OP_READDIR:
        return encodeString(vfs.readdir(s(0)).join("\n"));
      case OP_MKDIR:
        return vfs.mkdir(s(0), (flags & FLAG_RECURSIVE) !== 0), EMPTY;
      case OP_STAT:
        return encodeString(vfs.stat(s(0)));
      case OP_LSTAT:
        return encodeString(vfs.lstat(s(0)));
      case OP_UNLINK:
        return vfs.unlink(s(0)), EMPTY;
      case OP_RMDIR:
        return vfs.rmdir(s(0)), EMPTY;
      case OP_RENAME:
        return vfs.rename(s(0), s(1)), EMPTY;
      case OP_SYMLINK:
        return vfs.symlink(s(0), s(1)), EMPTY;
      case OP_READLINK:
        return encodeString(vfs.readlink(s(0)));
      case OP_OPEN:
        return u32ToBytes(vfs.open(s(0), bytesToU32(fields[1]) | 0, bytesToU32(fields[2])));
      case OP_CLOSE:
        return vfs.close(bytesToU32(fields[0])), EMPTY;
      case OP_FD_READ:
        return vfs.fd_read(bytesToU32(fields[0]), bytesToU32(fields[1]), bytesToF64(fields[2]));
      case OP_FD_WRITE:
        return u32ToBytes(vfs.fd_write(bytesToU32(fields[0]), fields[2], bytesToF64(fields[1])));
      case OP_FSTAT:
        return encodeString(vfs.fstat(bytesToU32(fields[0])));
      case OP_FTRUNCATE:
        return vfs.ftruncate(bytesToU32(fields[0]), bytesToU32(fields[1])), EMPTY;
      default:
        throw "ENOSYS";
    }
  }
}
