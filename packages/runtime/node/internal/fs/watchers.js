// internal/fs/watchers — OpenContainer shim (Vite dev, roadmap #19 stage A).
//
// Node's real internal/fs/watchers drives libuv fs event handles (inotify/
// kqueue/ReadDirectoryChangesW). OpenContainer's VFS has no change notifications
// yet, so this is a load-safe, *inert* implementation: `fs.watch()` /
// `fs.watchFile()` return a well-formed FSWatcher / StatWatcher that supports the
// whole public surface (EventEmitter, close/ref/unref/start), it just never emits
// a 'change' on its own. That's enough for tools that always create a watcher at
// startup — chokidar (which Vite's dev server uses) walks the tree with fs.readdir
// and calls fs.watch() per directory; with an inert watcher it still reaches its
// 'ready' state so `vite.createServer()` boots.
//
// Stage B will make this real: the File System Worker / kernel will push change
// events for watched paths, and [kFSWatchStart] will subscribe so 'change' fires
// and HMR works. The public shape here is deliberately the one Stage B needs.

export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const EventEmitter = require("events");

  // Node exposes these as internal symbols; fs.js indexes the watcher with them.
  const kFSWatchStart = Symbol("kFSWatchStart");
  const kFSStatWatcherStart = Symbol("kFSStatWatcherStart");
  const kFSStatWatcherAddOrCleanRef = Symbol("kFSStatWatcherAddOrCleanRef");

  class FSWatcher extends EventEmitter {
    constructor() {
      super();
      this._path = null;
      this._persistent = true;
      this._recursive = false;
      this._encoding = "utf8";
      this._closed = false;
    }

    // (path, persistent, recursive, encoding, ignore, throwIfNoEntry)
    [kFSWatchStart](path, persistent, recursive, encoding /*, ignore, throwIfNoEntry */) {
      this._path = path;
      if (persistent !== undefined) this._persistent = !!persistent;
      if (recursive !== undefined) this._recursive = !!recursive;
      if (encoding !== undefined) this._encoding = encoding;
      // Stage A: inert — no subscription, no events. (Stage B subscribes here.)
      return this;
    }

    // Legacy alias some callers use directly.
    start() {}

    close() {
      if (this._closed) return;
      this._closed = true;
      this.emit("close");
    }

    ref() {
      return this;
    }

    unref() {
      return this;
    }
  }

  class StatWatcher extends EventEmitter {
    constructor(bigint) {
      super();
      this._bigint = !!bigint;
      this._filename = null;
      this._interval = 5007;
      this._refs = 1;
      this._stopped = false;
    }

    [kFSStatWatcherStart](filename, persistent, interval) {
      this._filename = filename;
      if (interval !== undefined) this._interval = interval;
      // Stage A: inert — no polling. (Stage B polls / subscribes here.)
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
