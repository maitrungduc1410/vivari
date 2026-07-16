// internal/fs/watchers — Vivari fs.watch / fs.watchFile (roadmap #19 B).
//
// Node's real internal/fs/watchers drives libuv fs_event / stat-poll handles
// through internalBinding. Vivari's VFS lives in the File System Worker,
// which is the one place that sees *every* client's mutation (a host editor, this
// process, or any other process). So watching is push-based: [kFSWatchStart]
// registers the path with that worker (via process.__fsWatch -> an fs syscall),
// and the worker posts change events back over the fs doorbell port; the runtime
// routes them here by watchId and we emit them as Node's ('change', eventType,
// filename). This is what makes chokidar — and therefore Vite's dev server — see
// edits and rebuild.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const EventEmitter = require("events");
  const { Buffer } = require("buffer");

  // Node exposes these as internal symbols; fs.js indexes the watcher with them.
  const kFSWatchStart = Symbol("kFSWatchStart");
  const kFSStatWatcherStart = Symbol("kFSStatWatcherStart");
  const kFSStatWatcherAddOrCleanRef = Symbol("kFSStatWatcherAddOrCleanRef");

  // Per-process unique id space for watch registrations.
  let nextWatchId = 1;
  const host = () => process.__fsWatch || null;

  class FSWatcher extends EventEmitter {
    constructor() {
      super();
      this._watchId = 0;
      this._persistent = true;
      this._recursive = false;
      this._encoding = "utf8";
      this._closed = false;
    }

    // (path, persistent, recursive, encoding, ignore, throwIfNoEntry)
    [kFSWatchStart](path, persistent, recursive, encoding /*, ignore, throwIfNoEntry */) {
      this._persistent = persistent !== false;
      this._recursive = !!recursive;
      if (encoding !== undefined && encoding !== null) this._encoding = encoding;
      const h = host();
      if (h) {
        this._watchId = nextWatchId++;
        h.register(this._watchId, (event, filename) => this._deliver(event, filename));
        h.add(this._watchId, path, this._recursive, this._persistent);
      }
      return this;
    }

    _deliver(event, filename) {
      if (this._closed) return;
      let name = filename;
      if (this._encoding === "buffer" && typeof filename === "string") name = Buffer.from(filename);
      // Node's FSWatcher emits 'change' with (eventType, filename).
      this.emit("change", event, name);
    }

    // Legacy alias some callers use directly.
    start() {}

    close() {
      if (this._closed) return;
      this._closed = true;
      const h = host();
      if (h && this._watchId) {
        h.unregister(this._watchId);
        h.remove(this._watchId, this._persistent);
      }
      this.emit("close");
    }

    ref() {
      return this;
    }

    unref() {
      return this;
    }
  }

  // StatWatcher (fs.watchFile) — modelled on the same push channel: we register
  // the file, and on every change event re-stat it and emit ('change', curr,
  // prev). Node polls on an interval; we get notified directly instead. If the
  // stat fails (file gone) we surface zeroed-ish stats so listeners still fire.
  class StatWatcher extends EventEmitter {
    constructor(bigint) {
      super();
      this._bigint = !!bigint;
      this._watchId = 0;
      this._filename = null;
      this._prev = null;
      this._persistent = true;
      this._refs = 1;
      this._stopped = false;
    }

    _stat() {
      const fs = require("fs");
      try {
        return fs.statSync(this._filename, { bigint: this._bigint });
      } catch {
        return null;
      }
    }

    [kFSStatWatcherStart](filename, persistent, interval) {
      this._filename = filename;
      this._persistent = persistent !== false;
      this._prev = this._stat();
      const h = host();
      if (h) {
        this._watchId = nextWatchId++;
        h.register(this._watchId, () => this._onChange());
        h.add(this._watchId, filename, false, this._persistent);
      }
    }

    _onChange() {
      if (this._stopped) return;
      const curr = this._stat();
      const prev = this._prev;
      this._prev = curr;
      if (curr) this.emit("change", curr, prev || curr);
    }

    // op: 'add' | 'clean' | 'cleanAll'
    [kFSStatWatcherAddOrCleanRef](op) {
      if (op === "add") this._refs++;
      else if (op === "clean") this._refs = Math.max(0, this._refs - 1);
      else if (op === "cleanAll") this._refs = 0;
    }

    stop() {
      if (this._stopped) return;
      this._stopped = true;
      const h = host();
      if (h && this._watchId) {
        h.unregister(this._watchId);
        h.remove(this._watchId, this._persistent);
      }
      this.emit("stop");
    }

    ref() {
      return this;
    }

    unref() {
      return this;
    }
  }

  module.exports = {
    FSWatcher,
    StatWatcher,
    kFSWatchStart,
    kFSStatWatcherStart,
    kFSStatWatcherAddOrCleanRef,
  };
}
