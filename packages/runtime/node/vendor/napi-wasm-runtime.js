// Vendored @napi-rs/wasm-runtime@0.2.12 (MIT) — the pure-JS host half of
// "napi-on-wasm": it bundles emnapi (@emnapi/core + @emnapi/runtime +
// @emnapi/wasi-threads), @tybys/wasm-util and tslib into one self-contained CJS
// module, wrapped as an Vivari builtin factory. This is what makes a real
// N-API native addon compiled to wasm32-wasi (napi-rs / @node-rs / @napi-rs)
// run in the browser: the addon imports `env` (the ~150 napi_* functions,
// implemented here in JS over a handle table) plus `wasi_snapshot_preview1`
// (satisfied by our own require('wasi'), which is why addons "just work").
//
// Phase 2 #16 stage 2a: sync addons only. Multi-threaded addons call
// onCreateWorker() (async-work pool / pthreads) — that needs nested workers and
// is stage 2b; the exported WASI/createOnMessage/createFsProxy already carry the
// threads plumbing for when we get there.
//
// Regenerate:
//   npm i @napi-rs/wasm-runtime@0.2 --force --cpu=wasm32 --os=any
//   npx esbuild node_modules/@napi-rs/wasm-runtime/runtime.cjs --bundle \
//     --format=cjs --platform=neutral --legal-comments=none \
//     --outfile=wasm-runtime.bundle.cjs
//   then wrap the output in this factory (exports, require, module, process).
/* eslint-disable */
export default function (exports, require, module, process) {
// Vivari patch (loop-liveness): emnapi's NodejsWaitingRequestCounter keeps
// Node's event loop alive by ref()/unref()-ing a MessagePort while async N-API
// requests are outstanding. In Vivari a native MessagePort ref/unref is a
// no-op for our cooperative loop, so an addon that unref's its worker pool (e.g.
// rolldown's wasi-worker via `t && w.unref()`) would let the parent loop go idle
// and exit mid-operation. We mirror the counter into our own loop liveness via
// process.__wtHost.retain/release so `await someNapiAsyncCall()` (rolldown.bundle,
// bcrypt.hash, ...) keeps the process alive until it settles.
var __oc_liveRetain = function () {
  try { var h = (typeof process === "object" && process && process.__wtHost); if (h && h.retain) h.retain(); } catch (e) { /* no host */ }
};
var __oc_liveRelease = function () {
  try { var h = (typeof process === "object" && process && process.__wtHost); if (h && h.release) h.release(); } catch (e) { /* no host */ }
};
var __getOwnPropNames = Object.getOwnPropertyNames;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};

// node_modules/@emnapi/wasi-threads/dist/wasi-threads.cjs.min.js
var require_wasi_threads_cjs_min = __commonJS({
  "node_modules/@emnapi/wasi-threads/dist/wasi-threads.cjs.min.js"(exports2) {
    var e = "undefined" != typeof WebAssembly ? WebAssembly : "undefined" != typeof WXWebAssembly ? WXWebAssembly : void 0;
    var t = "object" == typeof process && null !== process && "object" == typeof process.versions && null !== process.versions && "string" == typeof process.versions.node;
    function r(e2) {
      return "function" == typeof (null == e2 ? void 0 : e2.postMessage) ? e2.postMessage : "function" == typeof postMessage ? postMessage : void 0;
    }
    function s(e2) {
      return "function" == typeof SharedArrayBuffer && e2 instanceof SharedArrayBuffer || "[object SharedArrayBuffer]" === Object.prototype.toString.call(e2);
    }
    function o(t2) {
      try {
        return t2 instanceof e.RuntimeError;
      } catch (e2) {
        return false;
      }
    }
    function n(e2, t2) {
      return { __emnapi__: { type: e2, payload: t2 } };
    }
    function i(e2) {
      if (e2) {
        if (!s(e2.buffer)) throw new Error("Multithread features require shared wasm memory. Try to compile with `-matomics -mbulk-memory` and use `--import-memory --shared-memory` during linking, then create WebAssembly.Memory with `shared: true` option");
      } else if ("undefined" == typeof SharedArrayBuffer) throw new Error("Current environment does not support SharedArrayBuffer, threads are not available!");
    }
    var a = 0;
    var d = class {
      get nextWorkerID() {
        return a;
      }
      constructor(e2) {
        var t2;
        if (this.unusedWorkers = [], this.pthreads = /* @__PURE__ */ Object.create(null), this.wasmModule = null, this.wasmMemory = null, this.messageEvents = /* @__PURE__ */ new WeakMap(), !e2) throw new TypeError("ThreadManager(): options is not provided");
        this._childThread = "childThread" in e2 && Boolean(e2.childThread), this._childThread ? (this._onCreateWorker = void 0, this._reuseWorker = false, this._beforeLoad = void 0) : (this._onCreateWorker = e2.onCreateWorker, this._reuseWorker = function(e3) {
          var t3;
          if ("boolean" == typeof e3) return !!e3 && { size: 0, strict: false };
          if ("number" == typeof e3) {
            if (!(e3 >= 0)) throw new RangeError("reuseWorker: size must be a non-negative integer");
            return { size: e3, strict: false };
          }
          if (!e3) return false;
          const r2 = null !== (t3 = Number(e3.size)) && void 0 !== t3 ? t3 : 0, s2 = Boolean(e3.strict);
          if (!(r2 > 0) && s2) throw new RangeError("reuseWorker: size must be set to positive integer if strict is set to true");
          return { size: r2, strict: s2 };
        }(e2.reuseWorker), this._beforeLoad = e2.beforeLoad), this.printErr = null !== (t2 = e2.printErr) && void 0 !== t2 ? t2 : console.error.bind(console), this.threadSpawn = e2.threadSpawn;
      }
      init() {
        this._childThread || this.initMainThread();
      }
      initMainThread() {
        this.preparePool();
      }
      preparePool() {
        if (this._reuseWorker && this._reuseWorker.size) {
          let e2 = this._reuseWorker.size;
          for (; e2--; ) {
            const e3 = this.allocateUnusedWorker();
            t && (e3.once("message", () => {
            }), e3.unref());
          }
        }
      }
      shouldPreloadWorkers() {
        return !this._childThread && this._reuseWorker && this._reuseWorker.size > 0;
      }
      loadWasmModuleToAllWorkers() {
        const e2 = Array(this.unusedWorkers.length);
        for (let r2 = 0; r2 < this.unusedWorkers.length; ++r2) {
          const s2 = this.unusedWorkers[r2];
          t && s2.ref(), e2[r2] = this.loadWasmModuleToWorker(s2).then((e3) => (t && s2.unref(), e3), (e3) => {
            throw t && s2.unref(), e3;
          });
        }
        return Promise.all(e2).catch((e3) => {
          throw this.terminateAllThreads(), e3;
        });
      }
      preloadWorkers() {
        return this.shouldPreloadWorkers() ? this.loadWasmModuleToAllWorkers() : Promise.resolve([]);
      }
      setup(e2, t2) {
        this.wasmModule = e2, this.wasmMemory = t2;
      }
      markId(e2) {
        if (e2.__emnapi_tid) return e2.__emnapi_tid;
        const t2 = a + 43;
        return a = (a + 1) % 536870869, this.pthreads[t2] = e2, e2.__emnapi_tid = t2, t2;
      }
      returnWorkerToPool(e2) {
        var r2 = e2.__emnapi_tid;
        void 0 !== r2 && delete this.pthreads[r2], this.unusedWorkers.push(e2), delete e2.__emnapi_tid, t && e2.unref();
      }
      loadWasmModuleToWorker(e2, r2) {
        if (e2.whenLoaded) return e2.whenLoaded;
        const s2 = this.printErr, o2 = this._beforeLoad, a2 = this;
        return e2.whenLoaded = new Promise((d2, h2) => {
          const l2 = (r3) => {
            if (r3.__emnapi__) {
              const s3 = r3.__emnapi__.type, o3 = r3.__emnapi__.payload;
              "loaded" === s3 ? (e2.loaded = true, t && !e2.__emnapi_tid && e2.unref(), d2(e2)) : "cleanup-thread" === s3 ? o3.tid in this.pthreads && this.cleanThread(e2, o3.tid) : "spawn-thread" === s3 ? this.threadSpawn(o3.startArg, o3.errorOrTid) : "terminate-all-threads" === s3 && this.terminateAllThreads();
            }
          };
          e2.onmessage = (t2) => {
            l2(t2.data), this.fireMessageEvent(e2, t2);
          }, e2.onerror = function(t2) {
            let r3 = "worker sent an error!";
            if (void 0 !== e2.__emnapi_tid && (r3 = "worker (tid = " + e2.__emnapi_tid + ") sent an error!"), "message" in t2) {
              if (s2(r3 + " " + t2.message), -1 !== t2.message.indexOf("RuntimeError") || -1 !== t2.message.indexOf("unreachable")) try {
                a2.terminateAllThreads();
              } catch (e3) {
              }
            } else s2(r3);
            throw h2(t2), t2;
          }, t && (e2.on("message", function(t2) {
            var r3, s3;
            null === (s3 = (r3 = e2).onmessage) || void 0 === s3 || s3.call(r3, { data: t2 });
          }), e2.on("error", function(t2) {
            var r3, s3;
            null === (s3 = (r3 = e2).onerror) || void 0 === s3 || s3.call(r3, t2);
          }), e2.on("detachedExit", function() {
          })), "function" == typeof o2 && o2(e2);
          try {
            e2.postMessage(n("load", { wasmModule: this.wasmModule, wasmMemory: this.wasmMemory, sab: r2 }));
          } catch (e3) {
            throw i(this.wasmMemory), e3;
          }
        }), e2.whenLoaded;
      }
      allocateUnusedWorker() {
        const e2 = this._onCreateWorker;
        if ("function" != typeof e2) throw new TypeError("`options.onCreateWorker` is not provided");
        const t2 = e2({ type: "thread", name: "emnapi-pthread" });
        return this.unusedWorkers.push(t2), t2;
      }
      getNewWorker(e2) {
        if (this._reuseWorker) {
          if (0 === this.unusedWorkers.length) {
            if (this._reuseWorker.strict && !t) {
              return void (0, this.printErr)("Tried to spawn a new thread, but the thread pool is exhausted.\nThis might result in a deadlock unless some threads eventually exit or the code explicitly breaks out to the event loop.");
            }
            const r3 = this.allocateUnusedWorker();
            this.loadWasmModuleToWorker(r3, e2);
          }
          return this.unusedWorkers.pop();
        }
        const r2 = this.allocateUnusedWorker();
        return this.loadWasmModuleToWorker(r2, e2), this.unusedWorkers.pop();
      }
      cleanThread(e2, t2, r2) {
        !r2 && this._reuseWorker ? this.returnWorkerToPool(e2) : (delete this.pthreads[t2], this.terminateWorker(e2), delete e2.__emnapi_tid);
      }
      terminateWorker(e2) {
        var t2;
        const r2 = e2.__emnapi_tid;
        e2.terminate(), null === (t2 = this.messageEvents.get(e2)) || void 0 === t2 || t2.clear(), this.messageEvents.delete(e2), e2.onmessage = (e3) => {
          if (e3.data.__emnapi__) {
            (0, this.printErr)('received "' + e3.data.__emnapi__.type + '" command from terminated worker: ' + r2);
          }
        };
      }
      terminateAllThreads() {
        const e2 = Object.values(this.pthreads);
        for (let t2 = 0; t2 < e2.length; ++t2) this.terminateWorker(e2[t2]);
        for (let e3 = 0; e3 < this.unusedWorkers.length; ++e3) this.terminateWorker(this.unusedWorkers[e3]);
        this.unusedWorkers = [], this.pthreads = /* @__PURE__ */ Object.create(null), this.preparePool();
      }
      addMessageEventListener(e2, t2) {
        let r2 = this.messageEvents.get(e2);
        return r2 || (r2 = /* @__PURE__ */ new Set(), this.messageEvents.set(e2, r2)), r2.add(t2), () => {
          null == r2 || r2.delete(t2);
        };
      }
      fireMessageEvent(e2, t2) {
        const r2 = this.messageEvents.get(e2);
        if (!r2) return;
        const s2 = this.printErr;
        r2.forEach((e3) => {
          try {
            e3(t2);
          } catch (e4) {
            s2(e4.stack);
          }
        });
      }
    };
    var h = Symbol("kIsProxy");
    function l(e2, t2) {
      if (e2[h]) return e2;
      const r2 = e2.exports, s2 = function(e3) {
        const t3 = ["apply", "construct", "defineProperty", "deleteProperty", "get", "getOwnPropertyDescriptor", "getPrototypeOf", "has", "isExtensible", "ownKeys", "preventExtensions", "set", "setPrototypeOf"], r3 = {};
        for (let s3 = 0; s3 < t3.length; s3++) {
          const o3 = t3[s3];
          r3[o3] = function() {
            const t4 = Array.prototype.slice.call(arguments, 1);
            return t4.unshift(e3), Reflect[o3].apply(Reflect, t4);
          };
        }
        return r3;
      }(r2), o2 = () => {
      }, n2 = () => 0;
      s2.get = function(e3, s3, i3) {
        var a2;
        return "memory" === s3 ? null !== (a2 = "function" == typeof t2 ? t2() : t2) && void 0 !== a2 ? a2 : Reflect.get(r2, s3, i3) : "_initialize" === s3 ? s3 in r2 ? o2 : void 0 : "_start" === s3 ? s3 in r2 ? n2 : void 0 : Reflect.get(r2, s3, i3);
      }, s2.has = function(e3, t3) {
        return "memory" === t3 || Reflect.has(r2, t3);
      };
      const i2 = new Proxy(/* @__PURE__ */ Object.create(null), s2);
      return new Proxy(e2, { get: (e3, t3, r3) => "exports" === t3 ? i2 : t3 === h || Reflect.get(e3, t3, r3) });
    }
    var c = /* @__PURE__ */ new WeakMap();
    function u(e2, t2) {
      const r2 = Object.getOwnPropertySymbols(e2), s2 = (e3) => (t3) => t3.description ? t3.description === e3 : t3.toString() === `Symbol(${e3})`;
      return Array.isArray(t2) ? t2.map((e3) => r2.filter(s2(e3))[0]) : r2.filter(s2(t2))[0];
    }
    function f(e2, t2, r2) {
      e2 && (!function(e3, t3, r3) {
        const s2 = new Int32Array(e3);
        if (Atomics.store(s2, 0, t3), t3 > 1 && r3) {
          const t4 = r3.name, o2 = r3.message, n2 = r3.stack, i2 = new TextEncoder().encode(t4), a2 = new TextEncoder().encode(o2), d2 = new TextEncoder().encode(n2);
          Atomics.store(s2, 1, i2.length), Atomics.store(s2, 2, a2.length), Atomics.store(s2, 3, d2.length);
          const h2 = new Uint8Array(e3);
          h2.set(i2, 16), h2.set(a2, 16 + i2.length), h2.set(d2, 16 + i2.length + a2.length);
        }
      }(e2.buffer, t2, r2), Atomics.notify(e2, 0));
    }
    exports2.ThreadManager = d, exports2.ThreadMessageHandler = class {
      constructor(e2) {
        const t2 = r(e2);
        if ("function" != typeof t2) throw new TypeError("options.postMessage is not a function");
        this.postMessage = t2, this.onLoad = null == e2 ? void 0 : e2.onLoad, this.onError = "function" == typeof (null == e2 ? void 0 : e2.onError) ? e2.onError : (e3, t3) => {
          throw t3;
        }, this.instance = void 0, this.messagesBeforeLoad = [];
      }
      instantiate(e2) {
        if ("function" == typeof this.onLoad) return this.onLoad(e2);
        throw new Error("ThreadMessageHandler.prototype.instantiate is not implemented");
      }
      handle(e2) {
        var t2;
        if (null === (t2 = null == e2 ? void 0 : e2.data) || void 0 === t2 ? void 0 : t2.__emnapi__) {
          const t3 = e2.data.__emnapi__.type, r2 = e2.data.__emnapi__.payload;
          try {
            "load" === t3 ? this._load(r2) : "start" === t3 && this.handleAfterLoad(e2, () => {
              this._start(r2);
            });
          } catch (e3) {
            this.onError(e3, t3);
          }
        }
      }
      _load(e2) {
        if (void 0 !== this.instance) return;
        let t2;
        try {
          t2 = this.instantiate(e2);
        } catch (t3) {
          return void this._loaded(t3, null, e2);
        }
        const r2 = t2 && "then" in t2 ? t2.then : void 0;
        "function" == typeof r2 ? r2.call(t2, (t3) => {
          this._loaded(null, t3, e2);
        }, (t3) => {
          this._loaded(t3, null, e2);
        }) : this._loaded(null, t2, e2);
      }
      _start(e2) {
        const t2 = this.instance.exports.wasi_thread_start;
        if ("function" != typeof t2) {
          const t3 = new TypeError("wasi_thread_start is not exported");
          throw f(e2.sab, 2, t3), t3;
        }
        const r2 = this.postMessage, s2 = e2.tid, o2 = e2.arg;
        f(e2.sab, 1);
        try {
          t2(s2, o2);
        } catch (e3) {
          if ("unwind" !== e3) throw e3;
          return;
        }
        r2(n("cleanup-thread", { tid: s2 }));
      }
      _loaded(e2, t2, r2) {
        if (e2) throw f(r2.sab, 2, e2), e2;
        if (null == t2) {
          const e3 = new TypeError("onLoad should return an object");
          throw f(r2.sab, 2, e3), e3;
        }
        const s2 = t2.instance;
        if (!s2) {
          const e3 = new TypeError('onLoad should return an object which includes "instance"');
          throw f(r2.sab, 2, e3), e3;
        }
        this.instance = s2;
        (0, this.postMessage)(n("loaded", {}));
        const o2 = this.messagesBeforeLoad;
        this.messagesBeforeLoad = [];
        for (let e3 = 0; e3 < o2.length; e3++) {
          const t3 = o2[e3];
          this.handle({ data: t3 });
        }
      }
      handleAfterLoad(e2, t2) {
        void 0 !== this.instance ? t2.call(this, e2) : this.messagesBeforeLoad.push(e2.data);
      }
    }, exports2.WASIThreads = class {
      constructor(s2) {
        if (!s2) throw new TypeError("WASIThreads(): options is not provided");
        if (!s2.wasi) throw new TypeError("WASIThreads(): options.wasi is not provided");
        c.set(this, /* @__PURE__ */ new WeakSet());
        const a2 = s2.wasi;
        !function(e2, t2) {
          const r2 = c.get(e2);
          if (r2.has(t2)) return;
          const s3 = e2, n2 = t2.wasiImport;
          if (n2) {
            const e3 = n2.proc_exit;
            n2.proc_exit = function(t3) {
              return s3.terminateAllThreads(), e3.call(this, t3);
            };
          }
          if (!s3.childThread) {
            const e3 = t2.start;
            "function" == typeof e3 && (t2.start = function(t3) {
              try {
                return e3.call(this, t3);
              } catch (e4) {
                throw o(e4) && s3.terminateAllThreads(), e4;
              }
            });
          }
          r2.add(t2);
        }(this, a2), this.wasi = a2, this.childThread = "childThread" in s2 && Boolean(s2.childThread), this.PThread = void 0, "threadManager" in s2 ? "function" == typeof s2.threadManager ? this.PThread = s2.threadManager() : this.PThread = s2.threadManager : this.childThread || (this.PThread = new d(s2), this.PThread.init());
        let h2 = false;
        "waitThreadStart" in s2 && (h2 = "number" == typeof s2.waitThreadStart ? s2.waitThreadStart : Boolean(s2.waitThreadStart));
        const l2 = r(s2);
        if (this.childThread && "function" != typeof l2) throw new TypeError("options.postMessage is not a function");
        this.postMessage = l2;
        const u2 = Boolean(s2.wasm64), f2 = (r2, s3) => {
          var o2;
          const a3 = void 0 !== s3;
          try {
            i(this.wasmMemory);
          } catch (e2) {
            if (null === (o2 = this.PThread) || void 0 === o2 || o2.printErr(e2.stack), a3) {
              const e3 = new Int32Array(this.wasmMemory.buffer, s3, 2);
              return Atomics.store(e3, 0, 1), Atomics.store(e3, 1, 6), Atomics.notify(e3, 1), 1;
            }
            return -6;
          }
          if (!a3) {
            const e2 = this.wasmInstance.exports.malloc;
            if (!(s3 = u2 ? Number(e2(BigInt(8))) : e2(8) >>> 0)) return -48;
          }
          const d2 = this.wasmInstance.exports.free, c2 = u2 ? (e2) => {
            d2(BigInt(e2));
          } : d2, f3 = new Int32Array(this.wasmMemory.buffer, s3, 2);
          if (Atomics.store(f3, 0, 0), Atomics.store(f3, 1, 0), this.childThread) {
            l2(n("spawn-thread", { startArg: r2, errorOrTid: s3 })), Atomics.wait(f3, 1, 0);
            const e2 = Atomics.load(f3, 0), t2 = Atomics.load(f3, 1);
            return a3 ? e2 : (c2(s3), e2 ? -t2 : t2);
          }
          const p = h2 || 0 === h2;
          let m, w, y;
          p && (m = new Int32Array(new SharedArrayBuffer(8208)), Atomics.store(m, 0, 0));
          const _ = this.PThread;
          try {
            if (w = _.getNewWorker(m), !w) throw new Error("failed to get new worker");
            if (y = _.markId(w), t && w.unref(), w.postMessage(n("start", { tid: y, arg: r2, sab: m })), p) {
              if ("number" == typeof h2) {
                if ("timed-out" === Atomics.wait(m, 0, 0, h2)) throw new Error("Spawning thread timed out. Please check if the worker is created successfully and if message is handled properly in the worker.");
              } else Atomics.wait(m, 0, 0);
              if (Atomics.load(m, 0) > 1) throw function(t2) {
                var r3, s4;
                const o3 = new Int32Array(t2);
                if (Atomics.load(o3, 0) <= 1) return null;
                const n2 = Atomics.load(o3, 1), i2 = Atomics.load(o3, 2), a4 = Atomics.load(o3, 3), d3 = new Uint8Array(t2), h3 = d3.slice(16, 16 + n2), l3 = d3.slice(16 + n2, 16 + n2 + i2), c3 = d3.slice(16 + n2 + i2, 16 + n2 + i2 + a4), u3 = new TextDecoder().decode(h3), f4 = new TextDecoder().decode(l3), p2 = new TextDecoder().decode(c3), m2 = new (null !== (r3 = globalThis[u3]) && void 0 !== r3 ? r3 : "RuntimeError" === u3 && null !== (s4 = e.RuntimeError) && void 0 !== s4 ? s4 : Error)(f4);
                return Object.defineProperty(m2, "stack", { value: p2, writable: true, enumerable: false, configurable: true }), m2;
              }(m.buffer);
            }
          } catch (e2) {
            if (void 0 !== w && void 0 !== y) try {
              _.cleanThread(w, y, true);
            } catch (e3) {
            }
            return Atomics.store(f3, 0, 1), Atomics.store(f3, 1, 6), Atomics.notify(f3, 1), null == _ || _.printErr(e2.stack), a3 ? 1 : (c2(s3), -6);
          }
          return Atomics.store(f3, 0, 0), Atomics.store(f3, 1, y), Atomics.notify(f3, 1), p || w.whenLoaded.catch((e2) => {
            throw delete w.whenLoaded, _.cleanThread(w, y, true), e2;
          }), a3 ? 0 : (c2(s3), y);
        };
        this.threadSpawn = f2, this.PThread && (this.PThread.threadSpawn = f2);
      }
      getImportObject() {
        return { wasi: { "thread-spawn": this.threadSpawn } };
      }
      setup(e2, t2, r2) {
        null != r2 || (r2 = e2.exports.memory), this.wasmInstance = e2, this.wasmMemory = r2, this.PThread && this.PThread.setup(t2, r2);
      }
      preloadWorkers() {
        return this.PThread ? this.PThread.preloadWorkers() : Promise.resolve([]);
      }
      initialize(e2, t2, r2) {
        const s2 = e2.exports;
        null != r2 || (r2 = s2.memory), this.childThread && (e2 = l(e2, r2)), this.setup(e2, t2, r2);
        const o2 = this.wasi;
        if ("_start" in s2 && "function" == typeof s2._start) if (this.childThread) {
          o2.start(e2);
          try {
            o2[u(o2, "kStarted")] = false;
          } catch (e3) {
          }
        } else !function(e3, t3) {
          const [r3, s3] = u(e3, ["kInstance", "kSetMemory"]);
          e3[r3] = t3, e3[s3](t3.exports.memory);
        }(o2, e2);
        else o2.initialize(e2);
        return e2;
      }
      start(e2, t2, r2) {
        const s2 = e2.exports;
        null != r2 || (r2 = s2.memory), this.childThread && (e2 = l(e2, r2)), this.setup(e2, t2, r2);
        return { exitCode: this.wasi.start(e2), instance: e2 };
      }
      terminateAllThreads() {
        var e2;
        this.childThread ? this.postMessage(n("terminate-all-threads", {})) : null === (e2 = this.PThread) || void 0 === e2 || e2.terminateAllThreads();
      }
    }, exports2.createInstanceProxy = l, exports2.isSharedArrayBuffer = s, exports2.isTrapError = o;
  }
});

// node_modules/@emnapi/wasi-threads/dist/wasi-threads.cjs.js
var require_wasi_threads_cjs = __commonJS({
  "node_modules/@emnapi/wasi-threads/dist/wasi-threads.cjs.js"(exports2) {
    var _WebAssembly = typeof WebAssembly !== "undefined" ? WebAssembly : typeof WXWebAssembly !== "undefined" ? WXWebAssembly : void 0;
    var ENVIRONMENT_IS_NODE = typeof process === "object" && process !== null && typeof process.versions === "object" && process.versions !== null && typeof process.versions.node === "string";
    function getPostMessage(options) {
      return typeof (options === null || options === void 0 ? void 0 : options.postMessage) === "function" ? options.postMessage : typeof postMessage === "function" ? postMessage : void 0;
    }
    function serizeErrorToBuffer(sab, code, error) {
      const i32array = new Int32Array(sab);
      Atomics.store(i32array, 0, code);
      if (code > 1 && error) {
        const name = error.name;
        const message = error.message;
        const stack = error.stack;
        const nameBuffer = new TextEncoder().encode(name);
        const messageBuffer = new TextEncoder().encode(message);
        const stackBuffer = new TextEncoder().encode(stack);
        Atomics.store(i32array, 1, nameBuffer.length);
        Atomics.store(i32array, 2, messageBuffer.length);
        Atomics.store(i32array, 3, stackBuffer.length);
        const buffer = new Uint8Array(sab);
        buffer.set(nameBuffer, 16);
        buffer.set(messageBuffer, 16 + nameBuffer.length);
        buffer.set(stackBuffer, 16 + nameBuffer.length + messageBuffer.length);
      }
    }
    function deserizeErrorFromBuffer(sab) {
      var _a, _b;
      const i32array = new Int32Array(sab);
      const status = Atomics.load(i32array, 0);
      if (status <= 1) {
        return null;
      }
      const nameLength = Atomics.load(i32array, 1);
      const messageLength = Atomics.load(i32array, 2);
      const stackLength = Atomics.load(i32array, 3);
      const buffer = new Uint8Array(sab);
      const nameBuffer = buffer.slice(16, 16 + nameLength);
      const messageBuffer = buffer.slice(16 + nameLength, 16 + nameLength + messageLength);
      const stackBuffer = buffer.slice(16 + nameLength + messageLength, 16 + nameLength + messageLength + stackLength);
      const name = new TextDecoder().decode(nameBuffer);
      const message = new TextDecoder().decode(messageBuffer);
      const stack = new TextDecoder().decode(stackBuffer);
      const ErrorConstructor = (_a = globalThis[name]) !== null && _a !== void 0 ? _a : name === "RuntimeError" ? (_b = _WebAssembly.RuntimeError) !== null && _b !== void 0 ? _b : Error : Error;
      const error = new ErrorConstructor(message);
      Object.defineProperty(error, "stack", {
        value: stack,
        writable: true,
        enumerable: false,
        configurable: true
      });
      return error;
    }
    function isSharedArrayBuffer(value) {
      return typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer || Object.prototype.toString.call(value) === "[object SharedArrayBuffer]";
    }
    function isTrapError(e) {
      try {
        return e instanceof _WebAssembly.RuntimeError;
      } catch (_) {
        return false;
      }
    }
    function createMessage(type, payload) {
      return {
        __emnapi__: {
          type,
          payload
        }
      };
    }
    var WASI_THREADS_MAX_TID = 536870911;
    function checkSharedWasmMemory(wasmMemory) {
      if (wasmMemory) {
        if (!isSharedArrayBuffer(wasmMemory.buffer)) {
          throw new Error("Multithread features require shared wasm memory. Try to compile with `-matomics -mbulk-memory` and use `--import-memory --shared-memory` during linking, then create WebAssembly.Memory with `shared: true` option");
        }
      } else {
        if (typeof SharedArrayBuffer === "undefined") {
          throw new Error("Current environment does not support SharedArrayBuffer, threads are not available!");
        }
      }
    }
    function getReuseWorker(value) {
      var _a;
      if (typeof value === "boolean") {
        return value ? { size: 0, strict: false } : false;
      }
      if (typeof value === "number") {
        if (!(value >= 0)) {
          throw new RangeError("reuseWorker: size must be a non-negative integer");
        }
        return { size: value, strict: false };
      }
      if (!value) {
        return false;
      }
      const size = (_a = Number(value.size)) !== null && _a !== void 0 ? _a : 0;
      const strict = Boolean(value.strict);
      if (!(size > 0) && strict) {
        throw new RangeError("reuseWorker: size must be set to positive integer if strict is set to true");
      }
      return { size, strict };
    }
    var nextWorkerID = 0;
    var ThreadManager = class {
      get nextWorkerID() {
        return nextWorkerID;
      }
      constructor(options) {
        var _a;
        this.unusedWorkers = [];
        this.pthreads = /* @__PURE__ */ Object.create(null);
        this.wasmModule = null;
        this.wasmMemory = null;
        this.messageEvents = /* @__PURE__ */ new WeakMap();
        if (!options) {
          throw new TypeError("ThreadManager(): options is not provided");
        }
        if ("childThread" in options) {
          this._childThread = Boolean(options.childThread);
        } else {
          this._childThread = false;
        }
        if (this._childThread) {
          this._onCreateWorker = void 0;
          this._reuseWorker = false;
          this._beforeLoad = void 0;
        } else {
          this._onCreateWorker = options.onCreateWorker;
          this._reuseWorker = getReuseWorker(options.reuseWorker);
          this._beforeLoad = options.beforeLoad;
        }
        this.printErr = (_a = options.printErr) !== null && _a !== void 0 ? _a : console.error.bind(console);
        this.threadSpawn = options.threadSpawn;
      }
      init() {
        if (!this._childThread) {
          this.initMainThread();
        }
      }
      initMainThread() {
        this.preparePool();
      }
      preparePool() {
        if (this._reuseWorker) {
          if (this._reuseWorker.size) {
            let pthreadPoolSize = this._reuseWorker.size;
            while (pthreadPoolSize--) {
              const worker = this.allocateUnusedWorker();
              if (ENVIRONMENT_IS_NODE) {
                worker.once("message", () => {
                });
                worker.unref();
              }
            }
          }
        }
      }
      shouldPreloadWorkers() {
        return !this._childThread && this._reuseWorker && this._reuseWorker.size > 0;
      }
      loadWasmModuleToAllWorkers() {
        const promises = Array(this.unusedWorkers.length);
        for (let i = 0; i < this.unusedWorkers.length; ++i) {
          const worker = this.unusedWorkers[i];
          if (ENVIRONMENT_IS_NODE)
            worker.ref();
          promises[i] = this.loadWasmModuleToWorker(worker).then((w) => {
            if (ENVIRONMENT_IS_NODE)
              worker.unref();
            return w;
          }, (e) => {
            if (ENVIRONMENT_IS_NODE)
              worker.unref();
            throw e;
          });
        }
        return Promise.all(promises).catch((err) => {
          this.terminateAllThreads();
          throw err;
        });
      }
      preloadWorkers() {
        if (this.shouldPreloadWorkers()) {
          return this.loadWasmModuleToAllWorkers();
        }
        return Promise.resolve([]);
      }
      setup(wasmModule, wasmMemory) {
        this.wasmModule = wasmModule;
        this.wasmMemory = wasmMemory;
      }
      markId(worker) {
        if (worker.__emnapi_tid)
          return worker.__emnapi_tid;
        const tid = nextWorkerID + 43;
        nextWorkerID = (nextWorkerID + 1) % (WASI_THREADS_MAX_TID - 42);
        this.pthreads[tid] = worker;
        worker.__emnapi_tid = tid;
        return tid;
      }
      returnWorkerToPool(worker) {
        var tid = worker.__emnapi_tid;
        if (tid !== void 0) {
          delete this.pthreads[tid];
        }
        this.unusedWorkers.push(worker);
        delete worker.__emnapi_tid;
        if (ENVIRONMENT_IS_NODE) {
          worker.unref();
        }
      }
      loadWasmModuleToWorker(worker, sab) {
        if (worker.whenLoaded)
          return worker.whenLoaded;
        const err = this.printErr;
        const beforeLoad = this._beforeLoad;
        const _this = this;
        worker.whenLoaded = new Promise((resolve, reject) => {
          const handleError = function(e) {
            let message = "worker sent an error!";
            if (worker.__emnapi_tid !== void 0) {
              message = "worker (tid = " + worker.__emnapi_tid + ") sent an error!";
            }
            if ("message" in e) {
              err(message + " " + e.message);
              if (e.message.indexOf("RuntimeError") !== -1 || e.message.indexOf("unreachable") !== -1) {
                try {
                  _this.terminateAllThreads();
                } catch (_) {
                }
              }
            } else {
              err(message);
            }
            reject(e);
            throw e;
          };
          const handleMessage = (data) => {
            if (data.__emnapi__) {
              const type = data.__emnapi__.type;
              const payload = data.__emnapi__.payload;
              if (type === "loaded") {
                worker.loaded = true;
                if (ENVIRONMENT_IS_NODE && !worker.__emnapi_tid) {
                  worker.unref();
                }
                resolve(worker);
              } else if (type === "cleanup-thread") {
                if (payload.tid in this.pthreads) {
                  this.cleanThread(worker, payload.tid);
                }
              } else if (type === "spawn-thread") {
                this.threadSpawn(payload.startArg, payload.errorOrTid);
              } else if (type === "terminate-all-threads") {
                this.terminateAllThreads();
              }
            }
          };
          worker.onmessage = (e) => {
            handleMessage(e.data);
            this.fireMessageEvent(worker, e);
          };
          worker.onerror = handleError;
          if (ENVIRONMENT_IS_NODE) {
            worker.on("message", function(data) {
              var _a, _b;
              (_b = (_a = worker).onmessage) === null || _b === void 0 ? void 0 : _b.call(_a, {
                data
              });
            });
            worker.on("error", function(e) {
              var _a, _b;
              (_b = (_a = worker).onerror) === null || _b === void 0 ? void 0 : _b.call(_a, e);
            });
            worker.on("detachedExit", function() {
            });
          }
          if (typeof beforeLoad === "function") {
            beforeLoad(worker);
          }
          try {
            worker.postMessage(createMessage("load", {
              wasmModule: this.wasmModule,
              wasmMemory: this.wasmMemory,
              sab
            }));
          } catch (err2) {
            checkSharedWasmMemory(this.wasmMemory);
            throw err2;
          }
        });
        return worker.whenLoaded;
      }
      allocateUnusedWorker() {
        const _onCreateWorker = this._onCreateWorker;
        if (typeof _onCreateWorker !== "function") {
          throw new TypeError("`options.onCreateWorker` is not provided");
        }
        const worker = _onCreateWorker({ type: "thread", name: "emnapi-pthread" });
        this.unusedWorkers.push(worker);
        return worker;
      }
      getNewWorker(sab) {
        if (this._reuseWorker) {
          if (this.unusedWorkers.length === 0) {
            if (this._reuseWorker.strict) {
              if (!ENVIRONMENT_IS_NODE) {
                const err = this.printErr;
                err("Tried to spawn a new thread, but the thread pool is exhausted.\nThis might result in a deadlock unless some threads eventually exit or the code explicitly breaks out to the event loop.");
                return;
              }
            }
            const worker2 = this.allocateUnusedWorker();
            this.loadWasmModuleToWorker(worker2, sab);
          }
          return this.unusedWorkers.pop();
        }
        const worker = this.allocateUnusedWorker();
        this.loadWasmModuleToWorker(worker, sab);
        return this.unusedWorkers.pop();
      }
      cleanThread(worker, tid, force) {
        if (!force && this._reuseWorker) {
          this.returnWorkerToPool(worker);
        } else {
          delete this.pthreads[tid];
          this.terminateWorker(worker);
          delete worker.__emnapi_tid;
        }
      }
      terminateWorker(worker) {
        var _a;
        const tid = worker.__emnapi_tid;
        worker.terminate();
        (_a = this.messageEvents.get(worker)) === null || _a === void 0 ? void 0 : _a.clear();
        this.messageEvents.delete(worker);
        worker.onmessage = (e) => {
          if (e.data.__emnapi__) {
            const err = this.printErr;
            err('received "' + e.data.__emnapi__.type + '" command from terminated worker: ' + tid);
          }
        };
      }
      terminateAllThreads() {
        const runningWorkers = Object.values(this.pthreads);
        for (let i = 0; i < runningWorkers.length; ++i) {
          this.terminateWorker(runningWorkers[i]);
        }
        for (let i = 0; i < this.unusedWorkers.length; ++i) {
          this.terminateWorker(this.unusedWorkers[i]);
        }
        this.unusedWorkers = [];
        this.pthreads = /* @__PURE__ */ Object.create(null);
        this.preparePool();
      }
      addMessageEventListener(worker, onMessage) {
        let listeners = this.messageEvents.get(worker);
        if (!listeners) {
          listeners = /* @__PURE__ */ new Set();
          this.messageEvents.set(worker, listeners);
        }
        listeners.add(onMessage);
        return () => {
          listeners === null || listeners === void 0 ? void 0 : listeners.delete(onMessage);
        };
      }
      fireMessageEvent(worker, e) {
        const listeners = this.messageEvents.get(worker);
        if (!listeners)
          return;
        const err = this.printErr;
        listeners.forEach((listener) => {
          try {
            listener(e);
          } catch (e2) {
            err(e2.stack);
          }
        });
      }
    };
    var kIsProxy = Symbol("kIsProxy");
    function createInstanceProxy(instance, memory) {
      if (instance[kIsProxy])
        return instance;
      const originalExports = instance.exports;
      const createHandler = function(target) {
        const handlers = [
          "apply",
          "construct",
          "defineProperty",
          "deleteProperty",
          "get",
          "getOwnPropertyDescriptor",
          "getPrototypeOf",
          "has",
          "isExtensible",
          "ownKeys",
          "preventExtensions",
          "set",
          "setPrototypeOf"
        ];
        const handler2 = {};
        for (let i = 0; i < handlers.length; i++) {
          const name = handlers[i];
          handler2[name] = function() {
            const args = Array.prototype.slice.call(arguments, 1);
            args.unshift(target);
            return Reflect[name].apply(Reflect, args);
          };
        }
        return handler2;
      };
      const handler = createHandler(originalExports);
      const _initialize = () => {
      };
      const _start = () => 0;
      handler.get = function(_target, p, receiver) {
        var _a;
        if (p === "memory") {
          return (_a = typeof memory === "function" ? memory() : memory) !== null && _a !== void 0 ? _a : Reflect.get(originalExports, p, receiver);
        }
        if (p === "_initialize") {
          return p in originalExports ? _initialize : void 0;
        }
        if (p === "_start") {
          return p in originalExports ? _start : void 0;
        }
        return Reflect.get(originalExports, p, receiver);
      };
      handler.has = function(_target, p) {
        if (p === "memory")
          return true;
        return Reflect.has(originalExports, p);
      };
      const exportsProxy = new Proxy(/* @__PURE__ */ Object.create(null), handler);
      return new Proxy(instance, {
        get(target, p, receiver) {
          if (p === "exports") {
            return exportsProxy;
          }
          if (p === kIsProxy) {
            return true;
          }
          return Reflect.get(target, p, receiver);
        }
      });
    }
    var patchedWasiInstances = /* @__PURE__ */ new WeakMap();
    var WASIThreads = class {
      constructor(options) {
        if (!options) {
          throw new TypeError("WASIThreads(): options is not provided");
        }
        if (!options.wasi) {
          throw new TypeError("WASIThreads(): options.wasi is not provided");
        }
        patchedWasiInstances.set(this, /* @__PURE__ */ new WeakSet());
        const wasi = options.wasi;
        patchWasiInstance(this, wasi);
        this.wasi = wasi;
        if ("childThread" in options) {
          this.childThread = Boolean(options.childThread);
        } else {
          this.childThread = false;
        }
        this.PThread = void 0;
        if ("threadManager" in options) {
          if (typeof options.threadManager === "function") {
            this.PThread = options.threadManager();
          } else {
            this.PThread = options.threadManager;
          }
        } else {
          if (!this.childThread) {
            this.PThread = new ThreadManager(options);
            this.PThread.init();
          }
        }
        let waitThreadStart = false;
        if ("waitThreadStart" in options) {
          waitThreadStart = typeof options.waitThreadStart === "number" ? options.waitThreadStart : Boolean(options.waitThreadStart);
        }
        const postMessage2 = getPostMessage(options);
        if (this.childThread && typeof postMessage2 !== "function") {
          throw new TypeError("options.postMessage is not a function");
        }
        this.postMessage = postMessage2;
        const wasm64 = Boolean(options.wasm64);
        const threadSpawn = (startArg, errorOrTid) => {
          var _a;
          const EAGAIN = 6;
          const isNewABI = errorOrTid !== void 0;
          try {
            checkSharedWasmMemory(this.wasmMemory);
          } catch (err) {
            (_a = this.PThread) === null || _a === void 0 ? void 0 : _a.printErr(err.stack);
            if (isNewABI) {
              const struct2 = new Int32Array(this.wasmMemory.buffer, errorOrTid, 2);
              Atomics.store(struct2, 0, 1);
              Atomics.store(struct2, 1, EAGAIN);
              Atomics.notify(struct2, 1);
              return 1;
            } else {
              return -EAGAIN;
            }
          }
          if (!isNewABI) {
            const malloc = this.wasmInstance.exports.malloc;
            errorOrTid = wasm64 ? Number(malloc(BigInt(8))) : malloc(8) >>> 0;
            if (!errorOrTid) {
              return -48;
            }
          }
          const _free = this.wasmInstance.exports.free;
          const free = wasm64 ? (ptr) => {
            _free(BigInt(ptr));
          } : _free;
          const struct = new Int32Array(this.wasmMemory.buffer, errorOrTid, 2);
          Atomics.store(struct, 0, 0);
          Atomics.store(struct, 1, 0);
          if (this.childThread) {
            postMessage2(createMessage("spawn-thread", {
              startArg,
              errorOrTid
            }));
            Atomics.wait(struct, 1, 0);
            const isError = Atomics.load(struct, 0);
            const result = Atomics.load(struct, 1);
            if (isNewABI) {
              return isError;
            }
            free(errorOrTid);
            return isError ? -result : result;
          }
          const shouldWait = waitThreadStart || waitThreadStart === 0;
          let sab;
          if (shouldWait) {
            sab = new Int32Array(new SharedArrayBuffer(16 + 8192));
            Atomics.store(sab, 0, 0);
          }
          let worker;
          let tid;
          const PThread = this.PThread;
          try {
            worker = PThread.getNewWorker(sab);
            if (!worker) {
              throw new Error("failed to get new worker");
            }
            tid = PThread.markId(worker);
            if (ENVIRONMENT_IS_NODE) {
              worker.unref();
            }
            worker.postMessage(createMessage("start", {
              tid,
              arg: startArg,
              sab
            }));
            if (shouldWait) {
              if (typeof waitThreadStart === "number") {
                const waitResult = Atomics.wait(sab, 0, 0, waitThreadStart);
                if (waitResult === "timed-out") {
                  throw new Error("Spawning thread timed out. Please check if the worker is created successfully and if message is handled properly in the worker.");
                }
              } else {
                Atomics.wait(sab, 0, 0);
              }
              const r = Atomics.load(sab, 0);
              if (r > 1) {
                throw deserizeErrorFromBuffer(sab.buffer);
              }
            }
          } catch (e) {
            if (worker !== void 0 && tid !== void 0) {
              try {
                PThread.cleanThread(worker, tid, true);
              } catch (_) {
              }
            }
            Atomics.store(struct, 0, 1);
            Atomics.store(struct, 1, EAGAIN);
            Atomics.notify(struct, 1);
            PThread === null || PThread === void 0 ? void 0 : PThread.printErr(e.stack);
            if (isNewABI) {
              return 1;
            }
            free(errorOrTid);
            return -EAGAIN;
          }
          Atomics.store(struct, 0, 0);
          Atomics.store(struct, 1, tid);
          Atomics.notify(struct, 1);
          if (!shouldWait) {
            worker.whenLoaded.catch((err) => {
              delete worker.whenLoaded;
              PThread.cleanThread(worker, tid, true);
              throw err;
            });
          }
          if (isNewABI) {
            return 0;
          }
          free(errorOrTid);
          return tid;
        };
        this.threadSpawn = threadSpawn;
        if (this.PThread) {
          this.PThread.threadSpawn = threadSpawn;
        }
      }
      getImportObject() {
        return {
          wasi: {
            "thread-spawn": this.threadSpawn
          }
        };
      }
      setup(wasmInstance, wasmModule, wasmMemory) {
        wasmMemory !== null && wasmMemory !== void 0 ? wasmMemory : wasmMemory = wasmInstance.exports.memory;
        this.wasmInstance = wasmInstance;
        this.wasmMemory = wasmMemory;
        if (this.PThread) {
          this.PThread.setup(wasmModule, wasmMemory);
        }
      }
      preloadWorkers() {
        if (this.PThread) {
          return this.PThread.preloadWorkers();
        }
        return Promise.resolve([]);
      }
      initialize(instance, module3, memory) {
        const exports3 = instance.exports;
        memory !== null && memory !== void 0 ? memory : memory = exports3.memory;
        if (this.childThread) {
          instance = createInstanceProxy(instance, memory);
        }
        this.setup(instance, module3, memory);
        const wasi = this.wasi;
        if ("_start" in exports3 && typeof exports3._start === "function") {
          if (this.childThread) {
            wasi.start(instance);
            try {
              const kStarted = getWasiSymbol(wasi, "kStarted");
              wasi[kStarted] = false;
            } catch (_) {
            }
          } else {
            setupInstance(wasi, instance);
          }
        } else {
          wasi.initialize(instance);
        }
        return instance;
      }
      start(instance, module3, memory) {
        const exports3 = instance.exports;
        memory !== null && memory !== void 0 ? memory : memory = exports3.memory;
        if (this.childThread) {
          instance = createInstanceProxy(instance, memory);
        }
        this.setup(instance, module3, memory);
        const exitCode = this.wasi.start(instance);
        return { exitCode, instance };
      }
      terminateAllThreads() {
        var _a;
        if (!this.childThread) {
          (_a = this.PThread) === null || _a === void 0 ? void 0 : _a.terminateAllThreads();
        } else {
          this.postMessage(createMessage("terminate-all-threads", {}));
        }
      }
    };
    function patchWasiInstance(wasiThreads, wasi) {
      const patched = patchedWasiInstances.get(wasiThreads);
      if (patched.has(wasi)) {
        return;
      }
      const _this = wasiThreads;
      const wasiImport = wasi.wasiImport;
      if (wasiImport) {
        const proc_exit = wasiImport.proc_exit;
        wasiImport.proc_exit = function(code) {
          _this.terminateAllThreads();
          return proc_exit.call(this, code);
        };
      }
      if (!_this.childThread) {
        const start = wasi.start;
        if (typeof start === "function") {
          wasi.start = function(instance) {
            try {
              return start.call(this, instance);
            } catch (err) {
              if (isTrapError(err)) {
                _this.terminateAllThreads();
              }
              throw err;
            }
          };
        }
      }
      patched.add(wasi);
    }
    function getWasiSymbol(wasi, description) {
      const symbols = Object.getOwnPropertySymbols(wasi);
      const selectDescription = (description2) => (s) => {
        if (s.description) {
          return s.description === description2;
        }
        return s.toString() === `Symbol(${description2})`;
      };
      if (Array.isArray(description)) {
        return description.map((d) => symbols.filter(selectDescription(d))[0]);
      }
      return symbols.filter(selectDescription(description))[0];
    }
    function setupInstance(wasi, instance) {
      const [kInstance, kSetMemory] = getWasiSymbol(wasi, ["kInstance", "kSetMemory"]);
      wasi[kInstance] = instance;
      wasi[kSetMemory](instance.exports.memory);
    }
    var ThreadMessageHandler = class {
      constructor(options) {
        const postMsg = getPostMessage(options);
        if (typeof postMsg !== "function") {
          throw new TypeError("options.postMessage is not a function");
        }
        this.postMessage = postMsg;
        this.onLoad = options === null || options === void 0 ? void 0 : options.onLoad;
        this.onError = typeof (options === null || options === void 0 ? void 0 : options.onError) === "function" ? options.onError : (_type, err) => {
          throw err;
        };
        this.instance = void 0;
        this.messagesBeforeLoad = [];
      }
      instantiate(data) {
        if (typeof this.onLoad === "function") {
          return this.onLoad(data);
        }
        throw new Error("ThreadMessageHandler.prototype.instantiate is not implemented");
      }
      handle(e) {
        var _a;
        if ((_a = e === null || e === void 0 ? void 0 : e.data) === null || _a === void 0 ? void 0 : _a.__emnapi__) {
          const type = e.data.__emnapi__.type;
          const payload = e.data.__emnapi__.payload;
          try {
            if (type === "load") {
              this._load(payload);
            } else if (type === "start") {
              this.handleAfterLoad(e, () => {
                this._start(payload);
              });
            }
          } catch (err) {
            this.onError(err, type);
          }
        }
      }
      _load(payload) {
        if (this.instance !== void 0)
          return;
        let source;
        try {
          source = this.instantiate(payload);
        } catch (err) {
          this._loaded(err, null, payload);
          return;
        }
        const then = source && "then" in source ? source.then : void 0;
        if (typeof then === "function") {
          then.call(source, (source2) => {
            this._loaded(null, source2, payload);
          }, (err) => {
            this._loaded(err, null, payload);
          });
        } else {
          this._loaded(null, source, payload);
        }
      }
      _start(payload) {
        const wasi_thread_start = this.instance.exports.wasi_thread_start;
        if (typeof wasi_thread_start !== "function") {
          const err = new TypeError("wasi_thread_start is not exported");
          notifyPthreadCreateResult(payload.sab, 2, err);
          throw err;
        }
        const postMessage2 = this.postMessage;
        const tid = payload.tid;
        const startArg = payload.arg;
        notifyPthreadCreateResult(payload.sab, 1);
        try {
          wasi_thread_start(tid, startArg);
        } catch (err) {
          if (err !== "unwind") {
            throw err;
          } else {
            return;
          }
        }
        postMessage2(createMessage("cleanup-thread", { tid }));
      }
      _loaded(err, source, payload) {
        if (err) {
          notifyPthreadCreateResult(payload.sab, 2, err);
          throw err;
        }
        if (source == null) {
          const err2 = new TypeError("onLoad should return an object");
          notifyPthreadCreateResult(payload.sab, 2, err2);
          throw err2;
        }
        const instance = source.instance;
        if (!instance) {
          const err2 = new TypeError('onLoad should return an object which includes "instance"');
          notifyPthreadCreateResult(payload.sab, 2, err2);
          throw err2;
        }
        this.instance = instance;
        const postMessage2 = this.postMessage;
        postMessage2(createMessage("loaded", {}));
        const messages = this.messagesBeforeLoad;
        this.messagesBeforeLoad = [];
        for (let i = 0; i < messages.length; i++) {
          const data = messages[i];
          this.handle({ data });
        }
      }
      handleAfterLoad(e, f) {
        if (this.instance !== void 0) {
          f.call(this, e);
        } else {
          this.messagesBeforeLoad.push(e.data);
        }
      }
    };
    function notifyPthreadCreateResult(sab, result, error) {
      if (sab) {
        serizeErrorToBuffer(sab.buffer, result, error);
        Atomics.notify(sab, 0);
      }
    }
    exports2.ThreadManager = ThreadManager;
    exports2.ThreadMessageHandler = ThreadMessageHandler;
    exports2.WASIThreads = WASIThreads;
    exports2.createInstanceProxy = createInstanceProxy;
    exports2.isSharedArrayBuffer = isSharedArrayBuffer;
    exports2.isTrapError = isTrapError;
  }
});

// node_modules/@emnapi/wasi-threads/index.js
var require_wasi_threads = __commonJS({
  "node_modules/@emnapi/wasi-threads/index.js"(exports2, module2) {
    if (typeof process !== "undefined" && process.env.NODE_ENV === "production") {
      module2.exports = require_wasi_threads_cjs_min();
    } else {
      module2.exports = require_wasi_threads_cjs();
    }
  }
});

// node_modules/@emnapi/core/dist/emnapi-core.cjs.min.js
var require_emnapi_core_cjs_min = __commonJS({
  "node_modules/@emnapi/core/dist/emnapi-core.cjs.min.js"(exports2) {
    var e = require_wasi_threads();
    var r = "undefined" != typeof WebAssembly ? WebAssembly : "undefined" != typeof WXWebAssembly ? WXWebAssembly : void 0;
    function t(e2) {
      if (e2 && "object" != typeof e2) throw new TypeError("imports must be an object or undefined");
      return true;
    }
    function n(e2, a2) {
      if (!e2) throw new TypeError("Invalid wasm source");
      t(a2), a2 = null != a2 ? a2 : {};
      try {
        const r2 = "object" == typeof e2 && null !== e2 && "then" in e2 ? e2.then : void 0;
        if ("function" == typeof r2) return r2.call(e2, (e3) => n(e3, a2));
      } catch (e3) {
      }
      if (e2 instanceof ArrayBuffer || ArrayBuffer.isView(e2)) return r.instantiate(e2, a2);
      if (e2 instanceof r.Module) return r.instantiate(e2, a2).then((r2) => ({ instance: r2, module: e2 }));
      if ("undefined" != typeof Response && e2 instanceof Response) return e2.arrayBuffer().then((e3) => r.instantiate(e3, a2));
      const o2 = "string" == typeof e2;
      if (o2 || "undefined" != typeof URL && e2 instanceof URL) {
        if (o2 && "undefined" != typeof wx && "undefined" != typeof __wxConfig) return r.instantiate(e2, a2);
        if ("function" != typeof fetch) throw new TypeError("wasm source can not be a string or URL in this environment");
        if ("function" != typeof r.instantiateStreaming) return n(fetch(e2), a2);
        try {
          return r.instantiateStreaming(fetch(e2), a2).catch(() => n(fetch(e2), a2));
        } catch (r2) {
          return n(fetch(e2), a2);
        }
      }
      throw new TypeError("Invalid wasm source");
    }
    function a(t2) {
      var n2 = function() {
        var n3, a2, o2, s2, i2, u2 = "object" == typeof process && null !== process && "object" == typeof process.versions && null !== process.versions && "string" == typeof process.versions.node, f = Boolean(t2.childThread), c = "number" == typeof t2.waitThreadStart ? t2.waitThreadStart : Boolean(t2.waitThreadStart);
        function l(e2) {
          if ("function" == typeof r.RuntimeError) throw new r.RuntimeError(e2);
          throw Error(e2);
        }
        var d, v, p, g = { imports: { env: {}, napi: {}, emnapi: {} }, exports: {}, emnapi: {}, loaded: false, filename: "", childThread: f, initWorker: void 0, waitThreadStart: c, PThread: void 0, init: function(e2) {
          if (g.loaded) return g.exports;
          if (!e2) throw new TypeError("Invalid napi init options");
          var t3 = e2.instance;
          if (!(null == t3 ? void 0 : t3.exports)) throw new TypeError("Invalid wasm instance");
          n3 = t3;
          var u3 = t3.exports, f2 = e2.module, c2 = e2.memory || u3.memory, p2 = e2.table || u3.__indirect_function_table;
          if (!(f2 instanceof r.Module)) throw new TypeError("Invalid wasm module");
          if (!(c2 instanceof r.Memory)) throw new TypeError("Invalid wasm memory");
          if (!(p2 instanceof r.Table)) throw new TypeError("Invalid wasm table");
          if (a2 = c2, o2 = p2, "function" != typeof u3.malloc) throw new TypeError("malloc is not exported");
          if ("function" != typeof u3.free) throw new TypeError("free is not exported");
          if (s2 = u3.malloc, i2 = u3.free, !g.childThread) {
            var y2 = 8, h2 = t3.exports.node_api_module_get_api_version_v1;
            "function" == typeof h2 && (y2 = h2());
            var _2 = g.envObject || (g.envObject = d.createEnv(g.filename, y2, function(e3) {
              return o2.get(e3);
            }, function(e3) {
              return o2.get(e3);
            }, l, v)), E2 = d.openScope(_2);
            try {
              _2.callIntoModule(function(e3) {
                var r2 = g.exports, n4 = E2.add(r2), a3 = (0, t3.exports.napi_register_wasm_v1)(e3.id, n4.id);
                g.exports = a3 ? d.handleStore.get(a3).value : r2;
              });
            } catch (e3) {
              if ("unwind" !== e3) throw e3;
            } finally {
              d.closeScope(_2, E2);
            }
            return g.loaded = true, delete g.envObject, g.exports;
          }
        } }, y = void 0;
        if (f) {
          d = null == t2 ? void 0 : t2.context;
          var h = "function" == typeof t2.postMessage ? t2.postMessage : "function" == typeof postMessage ? postMessage : void 0;
          if ("function" != typeof h) throw new TypeError("No postMessage found");
          g.postMessage = h;
        } else {
          var _ = t2.context;
          if ("object" != typeof _ || null === _) throw new TypeError("Invalid `options.context`. Use `import { getDefaultContext } from '@emnapi/runtime'`");
          d = _;
        }
        if ("string" == typeof t2.filename && (g.filename = t2.filename), "function" == typeof t2.onCreateWorker && (y = t2.onCreateWorker), "function" == typeof t2.print ? t2.print : console.log.bind(console), p = "function" == typeof t2.printErr ? t2.printErr : console.warn.bind(console), "nodeBinding" in t2) {
          var E = t2.nodeBinding;
          if ("object" != typeof E || null === E) throw new TypeError("Invalid `options.nodeBinding`. Use @emnapi/node-binding package");
          v = E;
        }
        var w = 0;
        if ("asyncWorkPoolSize" in t2) {
          if ("number" != typeof t2.asyncWorkPoolSize) throw new TypeError("options.asyncWorkPoolSize must be a integer");
          (w = t2.asyncWorkPoolSize | 0) > 1024 ? w = 1024 : w < -1024 && (w = -1024);
        }
        var L = !f && w <= 0;
        function m() {
          return Math.abs(w);
        }
        function b(e2) {
          if (!e2) return false;
          if (e2._emnapiSendListener) return true;
          var r2 = function(e3) {
            var r3 = (u2 ? e3 : e3.data).__emnapi__;
            if (r3 && "async-send" === r3.type) if (f) {
              (0, g.postMessage)({ __emnapi__: r3 });
            } else {
              var t3 = r3.payload.callback;
              o2.get(t3)(r3.payload.data);
            }
          };
          return e2._emnapiSendListener = { handler: r2, dispose: function() {
            u2 ? e2.off("message", r2) : e2.removeEventListener("message", r2, false), delete e2._emnapiSendListener;
          } }, u2 ? e2.on("message", r2) : e2.addEventListener("message", r2, false), true;
        }
        g.imports.env._emnapi_async_work_pool_size = m, g.emnapi.addSendListener = b;
        var S = new e.ThreadManager(f ? { printErr: p, childThread: true } : { printErr: p, beforeLoad: function(e2) {
          b(e2);
        }, reuseWorker: t2.reuseWorker, onCreateWorker: y });
        function A(e2, r2) {
          d.feature.setImmediate(function() {
            o2.get(e2)(r2);
          });
        }
        function C(e2, r2) {
          Promise.resolve().then(function() {
            o2.get(e2)(r2);
          });
        }
        function I(e2, r2) {
          var t3, n4 = [r2 >>> 0, (t3 = r2, +Math.abs(t3) >= 1 ? t3 > 0 ? (0 | Math.min(+Math.floor(t3 / 4294967296), 4294967295)) >>> 0 : ~~+Math.ceil((t3 - +(~~t3 >>> 0)) / 4294967296) >>> 0 : 0)], o3 = new DataView(a2.buffer);
          o3.setInt32(e2, n4[0], true), o3.setInt32(e2 + 4, n4[1], true);
        }
        g.PThread = S;
        var k, U = Object.freeze({ __proto__: null, $emnapiSetValueI64: I, _emnapi_call_finalizer: function(e2, r2, t3, n4, a3) {
          t3 >>>= 0, d.envStore.get(r2).callFinalizerInternal(e2, t3, n4, a3);
        }, _emnapi_callback_into_module: function(e2, r2, t3, n4, a3) {
          var s3 = d.envStore.get(r2), i3 = d.openScope(s3);
          try {
            s3.callbackIntoModule(Boolean(e2), function() {
              o2.get(t3)(r2, n4);
            });
          } catch (e3) {
            throw d.closeScope(s3, i3), a3 && d.closeScope(s3), e3;
          }
          d.closeScope(s3, i3);
        }, _emnapi_close_handle_scope: function(e2) {
          return d.closeScope();
        }, _emnapi_ctx_decrease_waiting_request_counter: function() {
          d.decreaseWaitingRequestCounter();
        }, _emnapi_ctx_increase_waiting_request_counter: function() {
          d.increaseWaitingRequestCounter();
        }, _emnapi_get_node_version: function(e2, r2, t3) {
          e2 >>>= 0, r2 >>>= 0, t3 >>>= 0;
          var n4 = "object" == typeof process && null !== process && "object" == typeof process.versions && null !== process.versions && "string" == typeof process.versions.node ? process.versions.node.split(".").map(function(e3) {
            return Number(e3);
          }) : [0, 0, 0], o3 = new DataView(a2.buffer);
          o3.setUint32(e2, n4[0], true), o3.setUint32(r2, n4[1], true), o3.setUint32(t3, n4[2], true);
        }, _emnapi_get_now: function() {
          return performance.timeOrigin + performance.now();
        }, _emnapi_is_main_browser_thread: function() {
          return "undefined" == typeof window || "undefined" == typeof document || u2 ? 0 : 1;
        }, _emnapi_is_main_runtime_thread: function() {
          return f ? 0 : 1;
        }, _emnapi_next_tick: C, _emnapi_open_handle_scope: function() {
          return d.openScope().id;
        }, _emnapi_runtime_keepalive_pop: function() {
        }, _emnapi_runtime_keepalive_push: function() {
        }, _emnapi_set_immediate: A, _emnapi_unwind: function() {
          throw "unwind";
        }, napi_clear_last_error: function(e2) {
          return d.envStore.get(e2).clearLastError();
        }, napi_set_last_error: function(e2, r2, t3, n4) {
          return d.envStore.get(e2).setLastError(r2, t3, n4);
        } });
        function V(e2) {
          var r2 = new DataView(a2.buffer).getInt32(e2 + 20, true);
          return S.pthreads[r2];
        }
        var T = new Promise(function(e2) {
          k = function() {
            T.ready = true, e2();
          };
        });
        T.ready = false;
        var B = Object.freeze({ __proto__: null, _emnapi_after_uvthreadpool_ready: function(e2, r2, t3) {
          T.ready ? o2.get(e2)(r2, t3) : T.then(function() {
            o2.get(e2)(r2, t3);
          });
        }, _emnapi_async_send_js: function(e2, r2, t3) {
          if (f) (0, g.postMessage)({ __emnapi__: { type: "async-send", payload: { callback: r2, data: t3 } } });
          else switch (e2) {
            case 0:
              A(r2, t3);
              break;
            case 1:
              C(r2, t3);
          }
        }, _emnapi_emit_async_thread_ready: function() {
          f && (0, g.postMessage)({ __emnapi__: { type: "async-thread-ready", payload: {} } });
        }, _emnapi_tell_js_uvthreadpool: function(e2, r2) {
          for (var t3 = [], n4 = new DataView(a2.buffer), o3 = function(r3) {
            var a3 = V(n4.getUint32(e2 + 4 * r3, true));
            t3.push(new Promise(function(e3) {
              var r4 = function(t4) {
                var n5 = (u2 ? t4 : t4.data).__emnapi__;
                n5 && "async-thread-ready" === n5.type && (e3(), a3 && "function" == typeof a3.unref && a3.unref(), u2 ? a3.off("message", r4) : a3.removeEventListener("message", r4));
              };
              u2 ? a3.on("message", r4) : a3.addEventListener("message", r4);
            }));
          }, s3 = 0; s3 < r2; s3++) o3(s3);
          Promise.all(t3).then(k);
        }, _emnapi_worker_ref: function(e2) {
          if (!f) {
            var r2 = V(e2 >>>= 0);
            r2 && "function" == typeof r2.ref && r2.ref();
          }
        }, _emnapi_worker_unref: function(e2) {
          if (!f) {
            var r2 = V(e2 >>>= 0);
            r2 && "function" == typeof r2.unref && r2.unref();
          }
        } });
        var D = Object.freeze({ __proto__: null, napi_adjust_external_memory: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (!t3) return n4.setLastError(1);
          var o3 = d.adjustAmountOfExternalAllocatedMemory(r2);
          return t3 >>>= 0, d.feature.supportBigInt ? new DataView(a2.buffer).setBigInt64(t3, BigInt(o3), true) : I(t3, Number(o3)), n4.clearLastError();
        } }), x = { idGen: {}, values: [void 0], queued: /* @__PURE__ */ new Set(), pending: [], init: function() {
          var e2 = { nextId: 1, list: [], generate: function() {
            var r2;
            return e2.list.length ? r2 = e2.list.shift() : (r2 = e2.nextId, e2.nextId++), r2;
          }, reuse: function(r2) {
            e2.list.push(r2);
          } };
          x.idGen = e2, x.values = [void 0], x.queued = /* @__PURE__ */ new Set(), x.pending = [];
        }, create: function(e2, r2, t3, n4, a3, o3) {
          var s3 = 0, i3 = 0;
          if (v) {
            var u3 = v.node.emitAsyncInit(r2, t3, -1);
            s3 = u3.asyncId, i3 = u3.triggerAsyncId;
          }
          var f2 = x.idGen.generate();
          return x.values[f2] = { env: e2, id: f2, resource: r2, asyncId: s3, triggerAsyncId: i3, status: 0, execute: n4, complete: a3, data: o3 }, f2;
        }, callComplete: function(e2, r2) {
          var t3 = e2.complete, n4 = e2.env, a3 = e2.data, s3 = function() {
            if (t3) {
              var e3 = d.envStore.get(n4), s4 = d.openScope(e3);
              try {
                e3.callbackIntoModule(true, function() {
                  o2.get(t3)(n4, r2, a3);
                });
              } finally {
                d.closeScope(e3, s4);
              }
            }
          };
          v ? v.node.makeCallback(e2.resource, s3, [], { asyncId: e2.asyncId, triggerAsyncId: e2.triggerAsyncId }) : s3();
        }, queue: function(e2) {
          var r2 = x.values[e2];
          if (r2 && 0 === r2.status) {
            if (r2.status = 1, x.queued.size >= (Math.abs(w) || 4)) return void x.pending.push(e2);
            x.queued.add(e2);
            var t3 = r2.env, n4 = r2.data, a3 = r2.execute;
            r2.status = 2, d.feature.setImmediate(function() {
              if (o2.get(a3)(t3, n4), x.queued.delete(e2), r2.status = 3, d.feature.setImmediate(function() {
                x.callComplete(r2, 0);
              }), x.pending.length > 0) {
                var s3 = x.pending.shift();
                x.values[s3].status = 0, x.queue(s3);
              }
            });
          }
        }, cancel: function(e2) {
          var r2 = x.pending.indexOf(e2);
          if (-1 !== r2) {
            var t3 = x.values[e2];
            return t3 && 1 === t3.status ? (t3.status = 4, x.pending.splice(r2, 1), d.feature.setImmediate(function() {
              x.callComplete(t3, 11);
            }), 0) : 9;
          }
          return 9;
        }, remove: function(e2) {
          var r2 = x.values[e2];
          r2 && (v && v.node.emitAsyncDestroy({ asyncId: r2.asyncId, triggerAsyncId: r2.triggerAsyncId }), x.values[e2] = void 0, x.idGen.reuse(e2));
        } };
        function F(e2, r2, t3, n4) {
          if (v) {
            var o3 = d.handleStore.get(e2).value, s3 = d.handleStore.get(r2).value, i3 = v.node.emitAsyncInit(o3, s3, t3), u3 = i3.asyncId, f2 = i3.triggerAsyncId;
            if (n4) {
              n4 >>>= 0;
              var c2 = new DataView(a2.buffer);
              c2.setFloat64(n4, u3, true), c2.setFloat64(n4 + 8, f2, true);
            }
          }
        }
        function R(e2, r2) {
          v && v.node.emitAsyncDestroy({ asyncId: e2, triggerAsyncId: r2 });
        }
        var O = Object.freeze({ __proto__: null, _emnapi_async_destroy_js: function(e2) {
          if (!v) return 9;
          e2 >>>= 0;
          var r2 = new DataView(a2.buffer), t3 = r2.getInt32(e2, true), n4 = r2.getInt32(e2 + 4, true), o3 = BigInt(t3 >>> 0) | BigInt(n4) << BigInt(32), s3 = v.napi.asyncDestroy(o3);
          return 0 !== s3.status ? s3.status : 0;
        }, _emnapi_async_init_js: function(e2, r2, t3) {
          if (!v) return 9;
          var n4;
          e2 && (n4 = Object(d.handleStore.get(e2).value));
          var o3 = d.handleStore.get(r2).value, s3 = v.napi.asyncInit(n4, o3);
          if (0 !== s3.status) return s3.status;
          var i3 = s3.value;
          i3 >= BigInt(-1) * (BigInt(1) << BigInt(63)) && i3 < BigInt(1) << BigInt(63) || (i3 &= (BigInt(1) << BigInt(64)) - BigInt(1)) >= BigInt(1) << BigInt(63) && (i3 -= BigInt(1) << BigInt(64));
          var u3 = Number(i3 & BigInt(4294967295)), f2 = Number(i3 >> BigInt(32));
          t3 >>>= 0;
          var c2 = new DataView(a2.buffer);
          return c2.setInt32(t3, u3, true), c2.setInt32(t3 + 4, f2, true), 0;
        }, _emnapi_env_check_gc_access: function(e2) {
          d.envStore.get(e2).checkGCAccess();
        }, _emnapi_node_emit_async_destroy: R, _emnapi_node_emit_async_init: F, _emnapi_node_make_callback: function(e2, r2, t3, n4, o3, s3, i3, u3) {
          var f2, c2 = 0;
          if (v) {
            var l2 = d.handleStore.get(r2).value, p2 = d.handleStore.get(t3).value;
            n4 >>>= 0, o3 >>>= 0, o3 >>>= 0;
            for (var g2 = Array(o3), y2 = new DataView(a2.buffer); c2 < o3; c2++) {
              var h2 = y2.getUint32(n4 + 4 * c2, true);
              g2[c2] = d.handleStore.get(h2).value;
            }
            var _2 = v.node.makeCallback(l2, p2, g2, { asyncId: s3, triggerAsyncId: i3 });
            if (u3) u3 >>>= 0, f2 = d.envStore.get(e2).ensureHandleId(_2), y2.setUint32(u3, f2, true);
          }
        }, napi_close_callback_scope: function(e2, r2) {
          throw new Error("napi_close_callback_scope has not been implemented yet");
        }, napi_make_callback: function(e2, r2, t3, n4, o3, s3, i3) {
          var u3, f2 = 0;
          if (!e2) return 1;
          var c2 = d.envStore.get(e2);
          if (c2.checkGCAccess(), !c2.tryCatch.isEmpty()) return c2.setLastError(10);
          if (!c2.canCallIntoJs()) return c2.setLastError(c2.moduleApiVersion >= 10 ? 23 : 10);
          c2.clearLastError();
          try {
            if (!v) return c2.setLastError(9);
            if (!t3) return c2.setLastError(1);
            if (o3 > 0 && !s3) return c2.setLastError(1);
            var l2 = Object(d.handleStore.get(t3).value), p2 = d.handleStore.get(n4).value;
            if ("function" != typeof p2) return c2.setLastError(1);
            r2 >>>= 0;
            var g2 = new DataView(a2.buffer), y2 = g2.getInt32(r2, true), h2 = g2.getInt32(r2 + 4, true), _2 = BigInt(y2 >>> 0) | BigInt(h2) << BigInt(32);
            s3 >>>= 0, o3 >>>= 0, o3 >>>= 0;
            for (var E2 = Array(o3); f2 < o3; f2++) {
              var w2 = g2.getUint32(s3 + 4 * f2, true);
              E2[f2] = d.handleStore.get(w2).value;
            }
            var L2 = v.napi.makeCallback(_2, l2, p2, E2);
            if (L2.error) throw L2.error;
            return 0 !== L2.status ? c2.setLastError(L2.status) : (i3 && (i3 >>>= 0, u3 = c2.ensureHandleId(L2.value), g2.setUint32(i3, u3, true)), c2.getReturnStatus());
          } catch (e3) {
            return c2.tryCatch.setError(e3), c2.setLastError(10);
          }
        }, napi_open_callback_scope: function(e2, r2, t3, n4) {
          throw new Error("napi_open_callback_scope has not been implemented yet");
        } }), j = { _liveSet: {}, offset: { __size__: 0, resource: 0, async_id: 0, trigger_async_id: 0, queue_size: 0, is_some: 0, queue: 0, async_pending: 0, async_u_fd: 0, thread_count: 0, state: 0, dispatch_state: 0, context: 0, max_queue_size: 0, ref: 0, env: 0, finalize_data: 0, finalize_cb: 0, call_js_cb: 0, handles_closing: 0, async_ref: 0, mutex: 0, cond: 0 }, init: function() {
          if (j._liveSet = /* @__PURE__ */ new Set(), j.offset.__size__ = 184, j.offset.resource = 0, j.offset.async_id = 8, j.offset.trigger_async_id = 16, j.offset.queue_size = 60, j.offset.is_some = 24, j.offset.queue = 64, j.offset.async_pending = 132, j.offset.async_u_fd = 96, j.offset.thread_count = 136, j.offset.state = 140, j.offset.dispatch_state = 144, j.offset.context = 148, j.offset.max_queue_size = 152, j.offset.ref = 156, j.offset.env = 160, j.offset.finalize_data = 164, j.offset.finalize_cb = 168, j.offset.call_js_cb = 172, j.offset.handles_closing = 176, j.offset.async_ref = 180, j.offset.mutex = 32, j.offset.cond = 56, j.offset.mutex = j.offset.mutex + 4, void 0 !== S) {
            S.unusedWorkers.forEach(j.addListener), Object.values(S.pthreads).forEach(j.addListener);
            var e2 = S.getNewWorker;
            S.getNewWorker = function() {
              var r2 = e2.apply(this, arguments);
              return j.addListener(r2), r2;
            };
          }
        }, addListener: function(e2) {
          if (!e2) return false;
          if (e2._emnapiTSFNListener) return true;
          var r2 = function(e3) {
            var r3 = (u2 ? e3 : e3.data).__emnapi__;
            if (r3) {
              var t3 = r3.type, n4 = r3.payload;
              if ("tsfn-send" === t3) {
                var a3 = n4.tsfn + j.offset.async_pending;
                0 !== Atomics.load(new Int32Array(j.ensureBufferFor(a3 + 4)), a3 >>> 2) && j.enqueue(n4.tsfn);
              }
            }
          };
          return e2._emnapiTSFNListener = { handler: r2, dispose: function() {
            u2 ? e2.off("message", r2) : e2.removeEventListener("message", r2, false), delete e2._emnapiTSFNListener;
          } }, u2 ? e2.on("message", r2) : e2.addEventListener("message", r2, false), true;
        }, ensureBufferFor: function(e2) {
          var r2 = a2.buffer;
          return e2 > r2.byteLength && (a2.grow(0), r2 = a2.buffer), r2;
        }, initQueue: function(e2) {
          var r2 = s2(8);
          return !!r2 && (r2 >>>= 0, new Uint8Array(j.ensureBufferFor(r2 + 8), r2, 8).fill(0), j.storeSizeTypeValue(e2 + j.offset.queue, r2, false), true);
        }, destroyQueue: function(e2) {
          var r2 = j.loadSizeTypeValue(e2 + j.offset.queue, false);
          if (r2) {
            for (var t3 = j.loadSizeTypeValue(r2, false); 0 !== t3; ) {
              var n4 = j.loadSizeTypeValue(t3 + 4, false);
              i2(t3), t3 = n4;
            }
            i2(r2);
          }
        }, pushQueue: function(e2, r2) {
          var t3 = j.loadSizeTypeValue(e2 + j.offset.queue, false), n4 = j.loadSizeTypeValue(t3, false), a3 = j.loadSizeTypeValue(t3 + 4, false), o3 = s2(8);
          if (!o3) throw new Error("OOM");
          o3 >>>= 0, j.storeSizeTypeValue(o3, r2, false), j.storeSizeTypeValue(o3 + 4, 0, false), 0 === n4 && 0 === a3 ? (j.storeSizeTypeValue(t3, o3, false), j.storeSizeTypeValue(t3 + 4, o3, false)) : (j.storeSizeTypeValue(a3 + 4, o3, false), j.storeSizeTypeValue(t3 + 4, o3, false)), j.addQueueSize(e2);
        }, shiftQueue: function(e2) {
          var r2 = j.loadSizeTypeValue(e2 + j.offset.queue, false), t3 = j.loadSizeTypeValue(r2, false);
          if (0 === t3) return 0;
          var n4 = t3, a3 = j.loadSizeTypeValue(t3 + 4, false);
          j.storeSizeTypeValue(r2, a3, false), 0 === a3 && j.storeSizeTypeValue(r2 + 4, 0, false), j.storeSizeTypeValue(n4 + 4, 0, false);
          var o3 = j.loadSizeTypeValue(n4, false);
          return i2(n4), j.subQueueSize(e2), o3;
        }, push: function(e2, r2, t3) {
          var n4 = j.getMutex(e2), a3 = j.getCond(e2), o3 = function() {
            var r3 = j.getQueueSize(e2), t4 = j.getMaxQueueSize(e2);
            return r3 >= t4 && t4 > 0 && 0 === j.getState(e2);
          }, s3 = "undefined" != typeof window && "undefined" != typeof document && !u2, i3 = false, f2 = n4.execute(function() {
            for (; o3(); ) {
              if (0 === t3) return 15;
              if (s3) return 21;
              a3.wait();
            }
            return 0 === j.getState(e2) ? (j.pushQueue(e2, r2), j.send(e2), 0) : 0 === j.getThreadCount(e2) ? 1 : (j.subThreadCount(e2), 2 !== j.getState(e2) || 0 !== j.getThreadCount(e2) || (i3 = true), 16);
          });
          return i3 && j.destroy(e2), f2;
        }, getMutex: function(e2) {
          var r2 = e2 + j.offset.mutex, t3 = { lock: function() {
            var e3 = "undefined" != typeof window && "undefined" != typeof document && !u2, t4 = new Int32Array(j.ensureBufferFor(r2 + 4), r2, 1);
            if (e3) for (; ; ) {
              if (0 === Atomics.compareExchange(t4, 0, 0, 10)) return;
            }
            else for (; ; ) {
              if (0 === Atomics.compareExchange(t4, 0, 0, 10)) return;
              Atomics.wait(t4, 0, 10);
            }
          }, unlock: function() {
            var e3 = new Int32Array(j.ensureBufferFor(r2 + 4), r2, 1);
            if (10 !== Atomics.compareExchange(e3, 0, 10, 0)) throw new Error("Tried to unlock while not holding the mutex");
            Atomics.notify(e3, 0, 1);
          }, execute: function(e3) {
            t3.lock();
            try {
              return e3();
            } finally {
              t3.unlock();
            }
          } };
          return t3;
        }, getCond: function(e2) {
          var r2 = e2 + j.offset.cond, t3 = j.getMutex(e2);
          return { wait: function() {
            var e3 = new Int32Array(j.ensureBufferFor(r2 + 4), r2, 1), n4 = Atomics.load(e3, 0);
            t3.unlock(), Atomics.wait(e3, 0, n4), t3.lock();
          }, signal: function() {
            var e3 = new Int32Array(j.ensureBufferFor(r2 + 4), r2, 1);
            Atomics.add(e3, 0, 1), Atomics.notify(e3, 0, 1);
          } };
        }, getQueueSize: function(e2) {
          return j.loadSizeTypeValue(e2 + j.offset.queue_size, true);
        }, addQueueSize: function(e2) {
          var r2, t3, n4 = j.offset.queue_size;
          r2 = new Uint32Array(j.ensureBufferFor(e2 + n4 + 4)), t3 = e2 + n4 >>> 2, Atomics.add(r2, t3, 1);
        }, subQueueSize: function(e2) {
          var r2, t3, n4 = j.offset.queue_size;
          r2 = new Uint32Array(j.ensureBufferFor(e2 + n4 + 4)), t3 = e2 + n4 >>> 2, Atomics.sub(r2, t3, 1);
        }, getThreadCount: function(e2) {
          return j.loadSizeTypeValue(e2 + j.offset.thread_count, true);
        }, addThreadCount: function(e2) {
          var r2, t3, n4 = j.offset.thread_count;
          r2 = new Uint32Array(j.ensureBufferFor(e2 + n4 + 4)), t3 = e2 + n4 >>> 2, Atomics.add(r2, t3, 1);
        }, subThreadCount: function(e2) {
          var r2, t3, n4 = j.offset.thread_count;
          r2 = new Uint32Array(j.ensureBufferFor(e2 + n4 + 4)), t3 = e2 + n4 >>> 2, Atomics.sub(r2, t3, 1);
        }, getState: function(e2) {
          return Atomics.load(new Int32Array(j.ensureBufferFor(e2 + j.offset.state + 4)), e2 + j.offset.state >>> 2);
        }, setState: function(e2, r2) {
          Atomics.store(new Int32Array(j.ensureBufferFor(e2 + j.offset.state + 4)), e2 + j.offset.state >>> 2, r2);
        }, getHandlesClosing: function(e2) {
          return Atomics.load(new Int8Array(j.ensureBufferFor(e2 + j.offset.handles_closing + 1)), e2 + j.offset.handles_closing);
        }, setHandlesClosing: function(e2, r2) {
          Atomics.store(new Int8Array(j.ensureBufferFor(e2 + j.offset.handles_closing + 1)), e2 + j.offset.handles_closing, r2);
        }, getDispatchState: function(e2) {
          return Atomics.load(new Uint32Array(j.ensureBufferFor(e2 + j.offset.dispatch_state + 4)), e2 + j.offset.dispatch_state >>> 2);
        }, getContext: function(e2) {
          return j.loadSizeTypeValue(e2 + j.offset.context, false);
        }, getMaxQueueSize: function(e2) {
          return j.loadSizeTypeValue(e2 + j.offset.max_queue_size, true);
        }, getEnv: function(e2) {
          return j.loadSizeTypeValue(e2 + j.offset.env, false);
        }, getCallJSCb: function(e2) {
          return j.loadSizeTypeValue(e2 + j.offset.call_js_cb, false);
        }, getRef: function(e2) {
          return j.loadSizeTypeValue(e2 + j.offset.ref, false);
        }, getResource: function(e2) {
          return j.loadSizeTypeValue(e2 + j.offset.resource, false);
        }, getFinalizeCb: function(e2) {
          return j.loadSizeTypeValue(e2 + j.offset.finalize_cb, false);
        }, getFinalizeData: function(e2) {
          return j.loadSizeTypeValue(e2 + j.offset.finalize_data, false);
        }, loadSizeTypeValue: function(e2, r2) {
          var t3;
          return r2 ? (t3 = new Uint32Array(j.ensureBufferFor(e2 + 4)), Atomics.load(t3, e2 >>> 2)) : (t3 = new Int32Array(j.ensureBufferFor(e2 + 4)), Atomics.load(t3, e2 >>> 2));
        }, storeSizeTypeValue: function(e2, r2, t3) {
          var n4;
          return t3 ? (n4 = new Uint32Array(j.ensureBufferFor(e2 + 4)), void Atomics.store(n4, e2 >>> 2, r2)) : (n4 = new Int32Array(j.ensureBufferFor(e2 + 4)), void Atomics.store(n4, e2 >>> 2, r2 >>> 0));
        }, releaseResources: function(e2) {
          if (2 !== j.getState(e2)) {
            j.setState(e2, 2);
            var r2 = j.getEnv(e2), t3 = d.envStore.get(r2), n4 = j.getRef(e2);
            n4 && d.refStore.get(n4).dispose();
            var o3 = j.getResource(e2);
            d.refStore.get(o3).dispose(), j.ensureBufferFor(e2 + j.offset.is_some + 1), new DataView(a2.buffer).setInt8(e2 + j.offset.is_some, 0, true), d.removeCleanupHook(t3, j.cleanup, e2), t3.unref();
            var s3 = e2 + j.offset.async_ref, i3 = s3 >>> 2, u3 = new Uint32Array(j.ensureBufferFor(s3 + 4));
            if (Atomics.load(u3, i3) > 0 && (Atomics.store(u3, i3, 0), d.decreaseWaitingRequestCounter()), v) {
              var f2 = new DataView(j.ensureBufferFor(e2 + j.offset.trigger_async_id + 8));
              R(f2.getFloat64(e2 + j.offset.async_id, true), f2.getFloat64(e2 + j.offset.trigger_async_id, true));
            }
          }
        }, destroy: function(e2) {
          j._liveSet.delete(e2), j.destroyQueue(e2), j.releaseResources(e2), i2(e2);
        }, emptyQueue: function(e2) {
          var r2 = [];
          j.getMutex(e2).execute(function() {
            for (; j.getQueueSize(e2) > 0; ) r2.push(j.shiftQueue(e2));
          });
          for (var t3, n4 = j.getCallJSCb(e2), a3 = j.getContext(e2), s3 = 0; s3 < r2.length; s3++) t3 = r2[s3], n4 && o2.get(n4)(0, 0, a3, t3);
        }, maybeDelete: function(e2) {
          var r2 = false;
          j.getMutex(e2).execute(function() {
            j.getThreadCount(e2) > 0 ? j.releaseResources(e2) : r2 = true;
          }), r2 && j.destroy(e2);
        }, finalize: function(e2) {
          var r2 = j.getEnv(e2), t3 = d.envStore.get(r2);
          d.openScope(t3);
          var n4 = j.getFinalizeCb(e2), a3 = j.getFinalizeData(e2), o3 = j.getContext(e2), s3 = function() {
            t3.callFinalizerInternal(0, n4, a3, o3);
          };
          try {
            if (j.emptyQueue(e2), n4) if (v) {
              var i3 = j.getResource(e2), u3 = d.refStore.get(i3).get(), f2 = d.handleStore.get(u3).value, c2 = new DataView(j.ensureBufferFor(e2 + j.offset.trigger_async_id + 8)), l2 = c2.getFloat64(e2 + j.offset.async_id, true), p2 = c2.getFloat64(e2 + j.offset.trigger_async_id, true);
              v.node.makeCallback(f2, s3, [], { asyncId: l2, triggerAsyncId: p2 });
            } else s3();
            j.maybeDelete(e2);
          } finally {
            d.closeScope(t3);
          }
        }, cleanup: function(e2) {
          j.closeHandlesAndMaybeDelete(e2, 1);
        }, closeHandlesAndMaybeDelete: function(e2, r2) {
          var t3 = j.getEnv(e2), n4 = d.envStore.get(t3);
          d.openScope(n4);
          try {
            if (r2 && j.getMutex(e2).execute(function() {
              j.setState(e2, 1), j.getMaxQueueSize(e2) > 0 && j.getCond(e2).signal();
            }), j.getHandlesClosing(e2)) return;
            j.setHandlesClosing(e2, 1), Atomics.store(new Int32Array(j.ensureBufferFor(e2 + j.offset.async_pending + 4)), e2 + j.offset.async_pending >>> 2, 1), d.feature.setImmediate(function() {
              j.finalize(e2);
            });
          } finally {
            d.closeScope(n4);
          }
        }, dispatchOne: function(e2) {
          var r2 = 0, t3 = false, n4 = false, a3 = j.getMutex(e2), s3 = j.getCond(e2);
          if (a3.execute(function() {
            if (0 === j.getState(e2)) {
              var a4 = j.getQueueSize(e2);
              if (a4 > 0) {
                r2 = j.shiftQueue(e2), t3 = true;
                var o3 = j.getMaxQueueSize(e2);
                a4 === o3 && o3 > 0 && s3.signal(), a4--;
              }
              0 === a4 ? 0 === j.getThreadCount(e2) && (j.setState(e2, 1), j.getMaxQueueSize(e2) > 0 && s3.signal(), j.closeHandlesAndMaybeDelete(e2, 0)) : n4 = true;
            } else j.closeHandlesAndMaybeDelete(e2, 0);
          }), t3) {
            var i3 = j.getEnv(e2), u3 = d.envStore.get(i3);
            d.openScope(u3);
            var f2 = function() {
              u3.callbackIntoModule(false, function() {
                var t4 = j.getCallJSCb(e2), n5 = j.getRef(e2), a4 = n5 ? d.refStore.get(n5).get() : 0;
                if (t4) {
                  var s4 = j.getContext(e2);
                  o2.get(t4)(i3, a4, s4, r2);
                } else {
                  var u4 = a4 ? d.handleStore.get(a4).value : null;
                  "function" == typeof u4 && u4();
                }
              });
            };
            try {
              if (v) {
                var c2 = j.getResource(e2), l2 = d.refStore.get(c2).get(), p2 = d.handleStore.get(l2).value, g2 = new DataView(j.ensureBufferFor(e2 + j.offset.trigger_async_id + 8));
                v.node.makeCallback(p2, f2, [], { asyncId: g2.getFloat64(e2 + j.offset.async_id, true), triggerAsyncId: g2.getFloat64(e2 + j.offset.trigger_async_id, true) });
              } else f2();
            } finally {
              d.closeScope(u3);
            }
          }
          return n4;
        }, dispatch: function(e2) {
          for (var r2 = true, t3 = 1e3, n4 = e2 + j.offset.dispatch_state, a3 = new Uint32Array(j.ensureBufferFor(n4 + 4)), o3 = n4 >>> 2; r2 && 0 !== --t3; ) Atomics.store(a3, o3, 1), r2 = j.dispatchOne(e2), 1 !== Atomics.exchange(a3, o3, 0) && (r2 = true);
          r2 && j.send(e2);
        }, enqueue: function(e2) {
          var r2 = e2 + j.offset.async_pending, t3 = e2 + j.offset.async_u_fd, n4 = new Int32Array(j.ensureBufferFor(Math.max(r2, t3) + 4));
          0 === Atomics.exchange(n4, t3 >>> 2, 1) && d.feature.setImmediate(function() {
            j._liveSet.has(e2) && (0 !== Atomics.load(n4, r2 >>> 2) ? d.feature.setImmediate(function() {
              try {
                if (0 === Atomics.exchange(n4, r2 >>> 2, 0)) return;
                if (!j._liveSet.has(e2)) return;
                j.dispatch(e2);
              } finally {
                j._liveSet.has(e2) && (Atomics.store(n4, t3 >>> 2, 0), 0 !== Atomics.load(n4, r2 >>> 2) && j.enqueue(e2));
              }
            }) : Atomics.store(n4, t3 >>> 2, 0));
          });
        }, send: function(e2) {
          var r2 = e2 + j.offset.dispatch_state;
          if (1 & ~Atomics.or(new Uint32Array(j.ensureBufferFor(r2 + 4)), r2 >>> 2, 2)) {
            var t3 = e2 + j.offset.async_pending;
            0 === Atomics.load(new Int32Array(j.ensureBufferFor(t3 + 4)), t3 >>> 2) && 0 === Atomics.exchange(new Int32Array(j.ensureBufferFor(t3 + 4)), t3 >>> 2, 1) && (void 0 !== f && f ? postMessage({ __emnapi__: { type: "tsfn-send", payload: { tsfn: e2 } } }) : j.enqueue(e2));
          }
        } };
        var z = { pool: [], workerReady: null, globalAddress: 0, globalOffset: { idle_threads: 0, q: 4, next: 4, prev: 8, mutex: 12, cond: 16, exit_message: 20, end: 28 }, offset: { resource: 0, async_id: 8, trigger_async_id: 16, env: 24, status: 28, queue: 32, queue_next: 32, queue_prev: 36, data: 40, execute: 44, complete: 48, end: 52 }, ensureBufferFor: function(e2) {
          var r2 = a2.buffer;
          return e2 > r2.byteLength && (a2.grow(0), r2 = a2.buffer), r2;
        }, init: function() {
          if (z.pool = [], z.workerReady = null, void 0 !== S) {
            S.unusedWorkers.forEach(z.addListener), Object.values(S.pthreads).forEach(z.addListener);
            var e2 = S.getNewWorker;
            S.getNewWorker = function() {
              var r2 = e2.apply(this, arguments);
              return z.addListener(r2), r2;
            };
          }
        }, addListener: function(e2) {
          if (!e2) return false;
          if (e2._emnapiAWMTListener) return true;
          var r2 = function(e3) {
            var r3 = (u2 ? e3 : e3.data).__emnapi__;
            if (r3) {
              var t3 = r3.type, n4 = r3.payload;
              "async-work-complete" === t3 && z.callComplete(n4.work, 0);
            }
          };
          return e2._emnapiAWMTListener = { handler: r2, dispose: function() {
            u2 ? e2.off("message", r2) : e2.removeEventListener("message", r2, false), delete e2._emnapiAWMTListener;
          } }, u2 ? e2.on("message", r2) : e2.addEventListener("message", r2, false), true;
        }, initGlobal: function() {
          if (!z.globalAddress) {
            z.globalAddress = s2(z.globalOffset.end), z.globalAddress >>>= 0;
            var e2 = z.globalOffset.end, r2 = z.globalAddress;
            new Uint8Array(z.ensureBufferFor(r2 + e2), r2, e2).fill(0), z.queueInit(z.globalAddress + z.globalOffset.q), z.queueInit(z.globalAddress + z.globalOffset.exit_message);
          }
        }, terminateWorkers: function() {
          z.pool.forEach(function(e2) {
            var r2, t3;
            null === (r2 = e2._emnapiAWMTListener) || void 0 === r2 || r2.dispose(), null === (t3 = e2._emnapiTSFNListener) || void 0 === t3 || t3.dispose(), e2.terminate();
          }), z.pool.length = 0;
        }, initWorkers: function(e2) {
          if (f) return z.workerReady || (z.workerReady = Promise.resolve());
          if (z.workerReady) return z.workerReady;
          if (!("emnapi_async_worker_create" in n3.exports)) throw new TypeError("`emnapi_async_worker_create` is not exported, please try to add `--export=emnapi_async_worker_create` to linker flags");
          var r2 = n3.exports.emnapi_async_worker_create, t3 = [];
          z.initGlobal();
          for (var a3 = 0; a3 < e2; ++a3) t3.push(r2(1, z.globalAddress));
          var o3 = t3.map(function(e3) {
            if (0 === e3) return Promise.reject(new Error("Failed to create async worker"));
            var r3;
            if (e3 < 0 && (r3 = z.pool[-e3 - 1])) return r3.whenLoaded;
            e3 >>>= 0;
            var t4 = new DataView(z.ensureBufferFor(e3 + 20 + 4)).getInt32(e3 + 20, true);
            return (r3 = S.pthreads[t4]).whenLoaded;
          });
          return z.workerReady = Promise.all(o3), z.workerReady;
        }, getResource: function(e2) {
          return z.ensureBufferFor(e2 + z.offset.resource + 4), new DataView(a2.buffer).getUint32(e2 + z.offset.resource, true);
        }, getExecute: function(e2) {
          return z.ensureBufferFor(e2 + z.offset.execute + 4), new DataView(a2.buffer).getUint32(e2 + z.offset.execute, true);
        }, getComplete: function(e2) {
          return z.ensureBufferFor(e2 + z.offset.complete + 4), new DataView(a2.buffer).getUint32(e2 + z.offset.complete, true);
        }, getEnv: function(e2) {
          return z.ensureBufferFor(e2 + z.offset.env + 4), new DataView(a2.buffer).getUint32(e2 + z.offset.env, true);
        }, getData: function(e2) {
          return z.ensureBufferFor(e2 + z.offset.data + 4), new DataView(a2.buffer).getUint32(e2 + z.offset.data, true);
        }, getMutex: function() {
          var e2 = z.globalAddress + z.globalOffset.mutex, r2 = { lock: function() {
            var r3 = "undefined" != typeof window && "undefined" != typeof document && !u2, t3 = new Int32Array(z.ensureBufferFor(e2 + 4), e2, 1);
            if (r3) for (; ; ) {
              if (0 === Atomics.compareExchange(t3, 0, 0, 10)) return;
            }
            else for (; ; ) {
              if (0 === Atomics.compareExchange(t3, 0, 0, 10)) return;
              Atomics.wait(t3, 0, 10);
            }
          }, unlock: function() {
            var r3 = new Int32Array(z.ensureBufferFor(e2 + 4), e2, 1);
            if (10 !== Atomics.compareExchange(r3, 0, 10, 0)) throw new Error("Tried to unlock while not holding the mutex");
            Atomics.notify(r3, 0, 1);
          }, execute: function(e3) {
            r2.lock();
            try {
              return e3();
            } finally {
              r2.unlock();
            }
          } };
          return r2;
        }, getCond: function() {
          var e2 = z.globalAddress + z.globalOffset.cond, r2 = z.getMutex();
          return { wait: function() {
            var t3 = new Int32Array(z.ensureBufferFor(e2 + 4), e2, 1), n4 = Atomics.load(t3, 0);
            r2.unlock(), Atomics.wait(t3, 0, n4), r2.lock();
          }, signal: function() {
            var r3 = new Int32Array(z.ensureBufferFor(e2 + 4), e2, 1);
            Atomics.add(r3, 0, 1), Atomics.notify(r3, 0, 1);
          } };
        }, queueInit: function(e2) {
          z.ensureBufferFor(e2 + 4 + 4);
          var r2 = new DataView(a2.buffer);
          r2.setUint32(e2, e2, true), r2.setUint32(e2 + 4, e2, true);
        }, queueInsertTail: function(e2, r2) {
          z.ensureBufferFor(e2 + 4 + 4), z.ensureBufferFor(r2 + 4 + 4);
          var t3 = new DataView(a2.buffer);
          t3.setUint32(r2, e2, true);
          var n4 = t3.getUint32(e2 + 4, true);
          t3.setUint32(r2 + 4, n4, true);
          var o3 = t3.getUint32(r2 + 4, true);
          t3.setUint32(o3, r2, true), t3.setUint32(e2 + 4, r2, true);
        }, queueRemove: function(e2) {
          z.ensureBufferFor(e2 + 4 + 4);
          var r2 = new DataView(a2.buffer), t3 = r2.getUint32(e2 + 4, true), n4 = r2.getUint32(e2, true);
          r2.setUint32(t3, n4, true), r2.setUint32(n4 + 4, t3, true);
        }, queueEmpty: function(e2) {
          return z.ensureBufferFor(e2 + 4), e2 == new DataView(a2.buffer).getUint32(e2, true);
        }, scheduleWork: function(e2) {
          var r2;
          (null === (r2 = z.workerReady) || void 0 === r2 ? void 0 : r2.ready) || z.initWorkers(m()).then(function() {
            z.workerReady.ready = true;
          }).catch(function(e3) {
            throw z.workerReady = null, e3;
          }), d.increaseWaitingRequestCounter();
          var t3 = new Int32Array(z.ensureBufferFor(e2 + z.offset.status + 4), e2 + z.offset.status, 1);
          Atomics.store(t3, 0, 0);
          var n4 = z.getMutex(), o3 = z.getCond();
          n4.lock();
          try {
            z.queueInsertTail(z.globalAddress + z.globalOffset.q, e2 + z.offset.queue);
          } catch (e3) {
            throw d.decreaseWaitingRequestCounter(), n4.unlock(), e3;
          }
          z.ensureBufferFor(z.globalAddress + z.globalOffset.idle_threads + 4), new DataView(a2.buffer).getUint32(z.globalAddress + z.globalOffset.idle_threads, true) > 0 && o3.signal(), n4.unlock();
        }, cancelWork: function(e2) {
          var r2 = false;
          return z.getMutex().execute(function() {
            z.ensureBufferFor(e2 + z.offset.status + 4);
            var t3 = new DataView(a2.buffer);
            (r2 = !z.queueEmpty(e2 + z.offset.queue) && 2 !== t3.getInt32(e2 + z.offset.status, true)) && z.queueRemove(e2 + z.offset.queue);
          }), r2 ? 0 !== Atomics.compareExchange(new Int32Array(z.ensureBufferFor(e2 + z.offset.status + 4), e2 + z.offset.status, 1), 0, 0, 1) ? 9 : (d.feature.setImmediate(function() {
            z.callComplete(e2, 11);
          }), 0) : 9;
        }, callComplete: function(e2, r2) {
          d.decreaseWaitingRequestCounter();
          var t3 = z.getComplete(e2), n4 = z.getEnv(e2), a3 = z.getData(e2), s3 = d.envStore.get(n4), i3 = d.openScope(s3), u3 = function() {
            t3 && s3.callbackIntoModule(true, function() {
              o2.get(t3)(n4, r2, a3);
            });
          };
          try {
            if (v) {
              var f2 = z.getResource(e2), c2 = d.refStore.get(f2).get(), l2 = d.handleStore.get(c2).value, p2 = new DataView(z.ensureBufferFor(e2 + z.offset.trigger_async_id + 8)), g2 = p2.getFloat64(e2 + z.offset.async_id, true), y2 = p2.getFloat64(e2 + z.offset.trigger_async_id, true);
              v.node.makeCallback(l2, u3, [], { asyncId: g2, triggerAsyncId: y2 });
            } else u3();
          } finally {
            d.closeScope(s3, i3);
          }
        } };
        z.init();
        var G = L ? function(e2, r2, t3, n4, o3, s3, i3) {
          if (!e2) return 1;
          var u3, f2 = d.envStore.get(e2);
          if (f2.checkGCAccess(), !n4) return f2.setLastError(1);
          if (!i3) return f2.setLastError(1);
          if (u3 = r2 ? Object(d.handleStore.get(r2).value) : {}, !t3) return f2.setLastError(1);
          var c2 = String(d.handleStore.get(t3).value), l2 = x.create(e2, u3, c2, n4, o3, s3);
          return i3 >>>= 0, new DataView(a2.buffer).setUint32(i3, l2, true), f2.clearLastError();
        } : function(e2, r2, t3, n4, o3, i3, u3) {
          if (!e2) return 1;
          var f2, c2 = d.envStore.get(e2);
          if (c2.checkGCAccess(), !n4) return c2.setLastError(1);
          if (!u3) return c2.setLastError(1);
          if (f2 = r2 ? Object(d.handleStore.get(r2).value) : {}, !t3) return c2.setLastError(1);
          var l2 = z.offset.end, v2 = s2(l2);
          if (!v2) return c2.setLastError(9);
          v2 >>>= 0, new Uint8Array(z.ensureBufferFor(v2 + l2)).subarray(v2, v2 + l2).fill(0);
          var p2 = c2.ensureHandleId(f2), g2 = d.createReference(c2, p2, 1, 1).id, y2 = new DataView(a2.buffer);
          return y2.setUint32(v2, g2, true), F(p2, t3, -1, v2 + z.offset.async_id), y2.setUint32(v2 + z.offset.env, e2, true), y2.setUint32(v2 + z.offset.execute, n4, true), y2.setUint32(v2 + z.offset.complete, o3, true), y2.setUint32(v2 + z.offset.data, i3, true), z.queueInit(v2 + z.offset.queue), u3 >>>= 0, y2.setUint32(u3, v2, true), c2.clearLastError();
        }, M = L ? function(e2, r2) {
          if (!e2) return 1;
          var t3 = d.envStore.get(e2);
          return t3.checkGCAccess(), r2 ? (r2 >>>= 0, x.remove(r2), t3.clearLastError()) : t3.setLastError(1);
        } : function(e2, r2) {
          if (!e2) return 1;
          var t3 = d.envStore.get(e2);
          if (t3.checkGCAccess(), !r2) return t3.setLastError(1);
          r2 >>>= 0;
          var n4 = z.getResource(r2);
          if (d.refStore.get(n4).dispose(), v) {
            var a3 = new DataView(z.ensureBufferFor(r2 + z.offset.trigger_async_id + 8));
            R(a3.getFloat64(r2 + z.offset.async_id, true), a3.getFloat64(r2 + z.offset.trigger_async_id, true));
          }
          return i2(r2), t3.clearLastError();
        }, q = L ? function(e2, r2) {
          if (!e2) return 1;
          var t3 = d.envStore.get(e2);
          return r2 ? (r2 >>>= 0, x.queue(r2), t3.clearLastError()) : t3.setLastError(1);
        } : function(e2, r2) {
          if (!e2) return 1;
          var t3 = d.envStore.get(e2);
          return r2 ? (r2 >>>= 0, z.scheduleWork(r2), t3.clearLastError()) : t3.setLastError(1);
        }, W = L ? function(e2, r2) {
          if (!e2) return 1;
          var t3 = d.envStore.get(e2);
          if (!r2) return t3.setLastError(1);
          r2 >>>= 0;
          var n4 = x.cancel(r2);
          return 0 === n4 ? t3.clearLastError() : t3.setLastError(n4);
        } : function(e2, r2) {
          if (!e2) return 1;
          var t3 = d.envStore.get(e2);
          if (!r2) return t3.setLastError(1);
          r2 >>>= 0;
          var n4 = z.cancelWork(r2);
          return 0 === n4 ? t3.clearLastError() : t3.setLastError(n4);
        };
        g.initWorker = function(e2, r2) {
          if (!g.childThread) throw new Error("startThread is only available in child threads");
          if ("function" != typeof n3.exports.emnapi_async_worker_init) throw new TypeError("`emnapi_async_worker_init` is not exported, please try to add `--export=emnapi_async_worker_init` to linker flags");
          n3.exports.emnapi_async_worker_init(e2), o2.get(r2[0])(r2[1]);
        };
        var N = Object.freeze({ __proto__: null, _emnapi_async_worker: function(e2) {
          e2 >>>= 0, z.globalAddress = e2;
          var r2 = z.getMutex(), t3 = z.getCond();
          r2.lock();
          for (var n4 = e2 + z.globalOffset.exit_message, s3 = e2 + z.globalOffset.idle_threads, i3 = e2 + z.globalOffset.q, u3 = new DataView(a2.buffer); ; ) {
            for (z.ensureBufferFor(i3 + 4); z.queueEmpty(i3); ) Atomics.add(new Int32Array(z.ensureBufferFor(s3 + 4), s3, 1), 0, 1), t3.wait(), Atomics.sub(new Int32Array(z.ensureBufferFor(s3 + 4), s3, 1), 0, 1);
            var f2 = u3.getUint32(i3, true);
            if (f2 === n4) {
              t3.signal(), r2.unlock();
              break;
            }
            var c2 = f2 - z.offset.queue;
            z.queueRemove(f2), z.queueInit(f2), r2.unlock();
            var d2 = new Int32Array(z.ensureBufferFor(c2 + z.offset.status + 4), c2 + z.offset.status, 1);
            1 === Atomics.load(d2, 0) && l("unreachable");
            var v2 = z.getExecute(c2), p2 = z.getEnv(c2), y2 = z.getData(c2);
            o2.get(v2)(p2, y2), Atomics.store(d2, 0, 2), (0, g.postMessage)({ __emnapi__: { type: "async-work-complete", payload: { work: c2 } } }), r2.lock();
          }
          return 0;
        }, _emnapi_spawn_worker: function(e2, r2) {
          if ("function" != typeof y) throw new TypeError("`options.onCreateWorker` is not a function");
          var t3 = [];
          if (!("emnapi_async_worker_create" in n3.exports)) throw new TypeError("`emnapi_async_worker_create` is not exported, please try to add `--export=emnapi_async_worker_create` to linker flags");
          t3.push(n3.exports.emnapi_async_worker_create(0, 0));
          var a3, o3 = function(e3) {
            !("message" in e3) || -1 === e3.message.indexOf("RuntimeError") && -1 === e3.message.indexOf("unreachable") || z.terminateWorkers();
          };
          try {
            var s3 = y({ type: "async-work", name: "emnapi-async-worker" }), f2 = S.loadWasmModuleToWorker(s3);
            u2 ? s3.on("error", o3) : s3.addEventListener("error", o3, false), z.addListener(s3), j.addListener(s3), [].push(f2.then(function() {
              "function" == typeof s3.unref && s3.unref();
            })), a3 = z.pool.push(s3) - 1;
            var c2 = t3[0];
            s3.threadBlockBase = c2, s3.postMessage({ __emnapi__: { type: "async-worker-init", payload: { arg: c2, func: [e2, r2] } } });
          } catch (e3) {
            c2 = t3[0];
            throw i2(c2), e3;
          }
          return a3;
        }, napi_cancel_async_work: W, napi_create_async_work: G, napi_delete_async_work: M, napi_queue_async_work: q }), J = { registry: "function" == typeof FinalizationRegistry ? new FinalizationRegistry(function(e2) {
          i2(e2);
        }) : void 0, table: /* @__PURE__ */ new WeakMap(), wasmMemoryViewTable: /* @__PURE__ */ new WeakMap(), init: function() {
          J.registry = "function" == typeof FinalizationRegistry ? new FinalizationRegistry(function(e2) {
            i2(e2);
          }) : void 0, J.table = /* @__PURE__ */ new WeakMap(), J.wasmMemoryViewTable = /* @__PURE__ */ new WeakMap();
        }, isSharedArrayBuffer: function(e2) {
          return "function" == typeof SharedArrayBuffer && e2 instanceof SharedArrayBuffer || "[object SharedArrayBuffer]" === Object.prototype.toString.call(e2);
        }, isDetachedArrayBuffer: function(e2) {
          if (0 === e2.byteLength) try {
            new Uint8Array(e2);
          } catch (e3) {
            return true;
          }
          return false;
        }, getArrayBufferPointer: function(e2, r2) {
          var t3, n4 = { address: 0, ownership: 0, runtimeAllocated: 0 };
          if (e2 === a2.buffer) return n4;
          var o3 = J.isDetachedArrayBuffer(e2);
          if (J.table.has(e2)) {
            var i3 = J.table.get(e2);
            return o3 ? (i3.address = 0, i3) : (r2 && 0 === i3.ownership && 1 === i3.runtimeAllocated && new Uint8Array(a2.buffer).set(new Uint8Array(e2), i3.address), i3);
          }
          if (o3 || 0 === e2.byteLength) return n4;
          if (!r2) return n4;
          var u3 = s2(e2.byteLength);
          if (!u3) throw new Error("Out of memory");
          return u3 >>>= 0, new Uint8Array(a2.buffer).set(new Uint8Array(e2), u3), n4.address = u3, n4.ownership = J.registry ? 0 : 1, n4.runtimeAllocated = 1, J.table.set(e2, n4), null === (t3 = J.registry) || void 0 === t3 || t3.register(e2, u3), n4;
        }, getOrUpdateMemoryView: function(e2) {
          if (e2.buffer === a2.buffer) return J.wasmMemoryViewTable.has(e2) || J.wasmMemoryViewTable.set(e2, { Ctor: e2.constructor, address: e2.byteOffset, length: e2 instanceof DataView ? e2.byteLength : e2.length, ownership: 1, runtimeAllocated: 0 }), e2;
          if ((J.isDetachedArrayBuffer(e2.buffer) || J.isSharedArrayBuffer(e2.buffer)) && J.wasmMemoryViewTable.has(e2)) {
            var r2 = J.wasmMemoryViewTable.get(e2), t3 = r2.Ctor, n4 = void 0, o3 = d.feature.Buffer;
            return n4 = "function" == typeof o3 && t3 === o3 ? o3.from(a2.buffer, r2.address, r2.length) : new t3(a2.buffer, r2.address, r2.length), J.wasmMemoryViewTable.set(n4, r2), n4;
          }
          return e2;
        }, getViewPointer: function(e2, r2) {
          if ((e2 = J.getOrUpdateMemoryView(e2)).buffer === a2.buffer) {
            if (J.wasmMemoryViewTable.has(e2)) {
              var t3 = J.wasmMemoryViewTable.get(e2);
              return { address: t3.address, ownership: t3.ownership, runtimeAllocated: t3.runtimeAllocated, view: e2 };
            }
            return { address: e2.byteOffset, ownership: 1, runtimeAllocated: 0, view: e2 };
          }
          var n4 = J.getArrayBufferPointer(e2.buffer, r2), o3 = n4.address, s3 = n4.ownership, i3 = n4.runtimeAllocated;
          return { address: 0 === o3 ? 0 : o3 + e2.byteOffset, ownership: s3, runtimeAllocated: i3, view: e2 };
        } }, P = { registry: void 0, handleTable: /* @__PURE__ */ new WeakMap(), init: function() {
          P.handleTable = /* @__PURE__ */ new WeakMap(), P.registry = "function" == typeof FinalizationRegistry ? new FinalizationRegistry(function(e2) {
            P.release(e2);
          }) : void 0;
        }, allocMeta: function(e2, r2, t3, n4, o3) {
          var i3 = s2(24);
          if (!i3) throw new Error("Out of memory");
          i3 >>>= 0, Atomics.store(new Int32Array(a2.buffer, i3, 1), 0, 1);
          var u3 = new DataView(a2.buffer);
          return u3.setUint32(i3 + 4, e2, true), u3.setUint32(i3 + 8, r2, true), u3.setUint32(i3 + 12, t3, true), u3.setUint32(i3 + 16, n4, true), u3.setUint32(i3 + 20, o3, true), i3;
        }, readMeta: function(e2) {
          var r2 = new DataView(a2.buffer);
          return { external_data: r2.getUint32(e2 + 4, true), byte_length: r2.getUint32(e2 + 8, true), finalize_cb: r2.getUint32(e2 + 12, true), finalize_data: r2.getUint32(e2 + 16, true), finalize_hint: r2.getUint32(e2 + 20, true) };
        }, release: function(e2) {
          if (1 === Atomics.sub(new Int32Array(a2.buffer, e2, 1), 0, 1)) {
            var r2 = P.readMeta(e2), t3 = r2.finalize_cb;
            if (t3) {
              var n4 = r2.finalize_data, s3 = r2.finalize_hint;
              o2.get(t3)(n4, s3);
            }
            i2(e2);
          }
        } }, H = { utf8Decoder: void 0, utf16Decoder: void 0, init: function() {
          var e2, r2 = { decode: function(e3) {
            for (var r3 = 0, t4 = Math.min(4096, e3.length + 1), n5 = new Uint16Array(t4), a3 = [], o3 = 0; ; ) {
              var s3 = r3 < e3.length;
              if (!s3 || o3 >= t4 - 1) {
                var i3 = n5.subarray(0, o3);
                if (a3.push(String.fromCharCode.apply(null, i3)), !s3) return a3.join("");
                e3 = e3.subarray(r3), r3 = 0, o3 = 0;
              }
              var u3 = e3[r3++];
              if (128 & u3) {
                if (192 == (224 & u3)) {
                  var f2 = 63 & e3[r3++];
                  n5[o3++] = (31 & u3) << 6 | f2;
                } else if (224 == (240 & u3)) {
                  f2 = 63 & e3[r3++];
                  var c2 = 63 & e3[r3++];
                  n5[o3++] = (31 & u3) << 12 | f2 << 6 | c2;
                } else if (240 == (248 & u3)) {
                  var l2 = (7 & u3) << 18 | (f2 = 63 & e3[r3++]) << 12 | (c2 = 63 & e3[r3++]) << 6 | 63 & e3[r3++];
                  l2 > 65535 && (l2 -= 65536, n5[o3++] = l2 >>> 10 & 1023 | 55296, l2 = 56320 | 1023 & l2), n5[o3++] = l2;
                }
              } else n5[o3++] = u3;
            }
          } };
          e2 = "function" == typeof TextDecoder ? new TextDecoder() : r2, H.utf8Decoder = e2;
          var t3, n4 = { decode: function(e3) {
            var r3 = new Uint16Array(e3.buffer, e3.byteOffset, e3.byteLength / 2);
            if (r3.length <= 4096) return String.fromCharCode.apply(null, r3);
            for (var t4 = [], n5 = 0, a3 = 0; n5 < r3.length; n5 += a3) a3 = Math.min(4096, r3.length - n5), t4.push(String.fromCharCode.apply(null, r3.subarray(n5, n5 + a3)));
            return t4.join("");
          } };
          t3 = "function" == typeof TextDecoder ? new TextDecoder("utf-16le") : n4, H.utf16Decoder = t3;
        }, lengthBytesUTF8: function(e2) {
          for (var r2, t3 = 0, n4 = 0; n4 < e2.length; ++n4) (r2 = e2.charCodeAt(n4)) <= 127 ? t3++ : r2 <= 2047 ? t3 += 2 : r2 >= 55296 && r2 <= 57343 ? (t3 += 4, ++n4) : t3 += 3;
          return t3;
        }, UTF8ToString: function(e2, r2) {
          if (!e2 || !r2) return "";
          e2 >>>= 0;
          var t3 = new Uint8Array(a2.buffer), n4 = e2;
          if (-1 === r2 || 4294967295 === r2) for (; t3[n4]; ) ++n4;
          else n4 = e2 + (r2 >>> 0);
          if ((r2 = n4 - e2) <= 16) {
            for (var o3 = e2, s3 = ""; o3 < n4; ) {
              var i3 = t3[o3++];
              if (128 & i3) {
                var u3 = 63 & t3[o3++];
                if (192 != (224 & i3)) {
                  var f2 = 63 & t3[o3++];
                  if ((i3 = 224 == (240 & i3) ? (15 & i3) << 12 | u3 << 6 | f2 : (7 & i3) << 18 | u3 << 12 | f2 << 6 | 63 & t3[o3++]) < 65536) s3 += String.fromCharCode(i3);
                  else {
                    var c2 = i3 - 65536;
                    s3 += String.fromCharCode(55296 | c2 >> 10, 56320 | 1023 & c2);
                  }
                } else s3 += String.fromCharCode((31 & i3) << 6 | u3);
              } else s3 += String.fromCharCode(i3);
            }
            return s3;
          }
          return H.utf8Decoder.decode("function" == typeof SharedArrayBuffer && t3.buffer instanceof SharedArrayBuffer || "[object SharedArrayBuffer]" === Object.prototype.toString.call(t3.buffer) ? t3.slice(e2, n4) : t3.subarray(e2, n4));
        }, stringToUTF8: function(e2, r2, t3) {
          var n4 = new Uint8Array(a2.buffer), o3 = r2;
          if (!(t3 > 0)) return 0;
          for (var s3 = o3 >>>= 0, i3 = o3 + t3 - 1, u3 = 0; u3 < e2.length; ++u3) {
            var f2 = e2.charCodeAt(u3);
            if (f2 >= 55296 && f2 <= 57343) f2 = 65536 + ((1023 & f2) << 10) | 1023 & e2.charCodeAt(++u3);
            if (f2 <= 127) {
              if (o3 >= i3) break;
              n4[o3++] = f2;
            } else if (f2 <= 2047) {
              if (o3 + 1 >= i3) break;
              n4[o3++] = 192 | f2 >> 6, n4[o3++] = 128 | 63 & f2;
            } else if (f2 <= 65535) {
              if (o3 + 2 >= i3) break;
              n4[o3++] = 224 | f2 >> 12, n4[o3++] = 128 | f2 >> 6 & 63, n4[o3++] = 128 | 63 & f2;
            } else {
              if (o3 + 3 >= i3) break;
              n4[o3++] = 240 | f2 >> 18, n4[o3++] = 128 | f2 >> 12 & 63, n4[o3++] = 128 | f2 >> 6 & 63, n4[o3++] = 128 | 63 & f2;
            }
          }
          return n4[o3] = 0, o3 - s3;
        }, UTF16ToString: function(e2, r2) {
          if (!e2 || !r2) return "";
          var t3 = e2 >>>= 0;
          if (-1 === r2 || 4294967295 === r2) {
            for (var n4 = t3 >>> 1, o3 = new Uint16Array(a2.buffer); o3[n4]; ) ++n4;
            t3 = n4 << 1 >>> 0;
          } else t3 = e2 + 2 * (r2 >>> 0);
          if ((r2 = t3 - e2) <= 32) return String.fromCharCode.apply(null, new Uint16Array(a2.buffer, e2, r2 / 2));
          var s3 = new Uint8Array(a2.buffer);
          return H.utf16Decoder.decode("function" == typeof SharedArrayBuffer && s3.buffer instanceof SharedArrayBuffer || "[object SharedArrayBuffer]" === Object.prototype.toString.call(s3.buffer) ? s3.slice(e2, t3) : s3.subarray(e2, t3));
        }, stringToUTF16: function(e2, r2, t3) {
          if (void 0 === t3 && (t3 = 2147483647), t3 < 2) return 0;
          for (var n4 = r2, o3 = (t3 -= 2) < 2 * e2.length ? t3 / 2 : e2.length, s3 = new DataView(a2.buffer), i3 = 0; i3 < o3; ++i3) {
            var u3 = e2.charCodeAt(i3);
            s3.setInt16(r2, u3, true), r2 += 2;
          }
          return s3.setInt16(r2, 0, true), r2 - n4;
        }, newString: function(e2, r2, t3, n4, o3) {
          if (t3 >>>= 0, !e2) return 1;
          var s3 = d.envStore.get(e2);
          s3.checkGCAccess();
          var i3 = -1 === t3 || 4294967295 === t3, u3 = t3 >>> 0;
          if (0 !== t3 && !r2) return s3.setLastError(1);
          if (!n4) return s3.setLastError(1);
          if (!(i3 || u3 <= 2147483647)) return s3.setLastError(1);
          var f2 = o3(r2 >>>= 0, i3, u3);
          n4 >>>= 0;
          var c2 = d.addToCurrentScope(f2).id;
          return new DataView(a2.buffer).setUint32(n4, c2, true), s3.clearLastError();
        }, newExternalString: function(e2, r2, t3, n4, o3, s3, i3, u3, f2) {
          if (t3 >>>= 0, !e2) return 1;
          var c2 = d.envStore.get(e2);
          c2.checkGCAccess();
          var l2 = -1 === t3 || 4294967295 === t3, v2 = t3 >>> 0;
          if (0 !== t3 && !r2) return c2.setLastError(1);
          if (!s3) return c2.setLastError(1);
          if (!(l2 || v2 <= 2147483647)) return c2.setLastError(1);
          var p2 = u3(e2, r2, t3, s3);
          if (0 === p2) {
            if (i3) new DataView(a2.buffer).setInt8(i3, 1, true);
            n4 && c2.callFinalizer(n4, r2, o3);
          }
          return p2;
        } };
        function Q(e2, r2, t3, n4, o3, s3, i3) {
          if (!e2) return 1;
          var u3 = d.envStore.get(e2);
          if (u3.checkGCAccess(), !r2) return u3.setLastError(1);
          var f2 = d.handleStore.get(r2);
          if (!f2.isTypedArray()) return u3.setLastError(1);
          var c2 = f2.value, l2 = new DataView(a2.buffer);
          if (t3) {
            t3 >>>= 0;
            var v2 = void 0;
            if (c2 instanceof Int8Array) v2 = 0;
            else if (c2 instanceof Uint8Array) v2 = 1;
            else if (c2 instanceof Uint8ClampedArray) v2 = 2;
            else if (c2 instanceof Int16Array) v2 = 3;
            else if (c2 instanceof Uint16Array) v2 = 4;
            else if (c2 instanceof Int32Array) v2 = 5;
            else if (c2 instanceof Uint32Array) v2 = 6;
            else if ("function" == typeof Float16Array && c2 instanceof Float16Array) v2 = 11;
            else if (c2 instanceof Float32Array) v2 = 7;
            else if (c2 instanceof Float64Array) v2 = 8;
            else if (c2 instanceof BigInt64Array) v2 = 9;
            else {
              if (!(c2 instanceof BigUint64Array)) return u3.setLastError(9);
              v2 = 10;
            }
            l2.setInt32(t3, v2, true);
          }
          if (c2 = J.getOrUpdateMemoryView(c2), n4 && (n4 >>>= 0, l2.setUint32(n4, c2.length, true)), o3 || s3) {
            if (o3) {
              o3 >>>= 0;
              var p2 = J.getViewPointer(c2, true).address;
              l2.setUint32(o3, p2, true);
            }
            if (s3) {
              s3 >>>= 0;
              var g2 = u3.ensureHandleId(c2.buffer);
              l2.setUint32(s3, g2, true);
            }
          }
          return i3 && (i3 >>>= 0, l2.setUint32(i3, c2.byteOffset, true)), u3.clearLastError();
        }
        function $(e2, r2, t3, n4, o3, s3) {
          if (!e2) return 1;
          var i3 = d.envStore.get(e2);
          if (i3.checkGCAccess(), !r2) return i3.setLastError(1);
          var u3 = d.handleStore.get(r2);
          if (!u3.isDataView()) return i3.setLastError(1);
          var f2 = J.getOrUpdateMemoryView(u3.value), c2 = new DataView(a2.buffer);
          if (t3 && (t3 >>>= 0, c2.setUint32(t3, f2.byteLength, true)), n4 || o3) {
            if (n4) {
              n4 >>>= 0;
              var l2 = J.getViewPointer(f2, true).address;
              c2.setUint32(n4, l2, true);
            }
            if (o3) {
              o3 >>>= 0;
              var v2 = i3.ensureHandleId(f2.buffer);
              c2.setUint32(o3, v2, true);
            }
          }
          return s3 && (s3 >>>= 0, c2.setUint32(s3, f2.byteOffset, true)), i3.clearLastError();
        }
        var Y = Object.freeze({ __proto__: null, napi_get_array_length: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !n4.tryCatch.isEmpty()) return n4.setLastError(10);
          if (!n4.canCallIntoJs()) return n4.setLastError(n4.moduleApiVersion >= 10 ? 23 : 10);
          n4.clearLastError();
          try {
            if (!r2) return n4.setLastError(1);
            if (!t3) return n4.setLastError(1);
            var o3 = d.handleStore.get(r2);
            if (!o3.isArray()) return n4.setLastError(8);
            t3 >>>= 0;
            var s3 = o3.value.length >>> 0;
            return new DataView(a2.buffer).setUint32(t3, s3, true), n4.getReturnStatus();
          } catch (e3) {
            return n4.tryCatch.setError(e3), n4.setLastError(10);
          }
        }, napi_get_arraybuffer_info: function(e2, r2, t3, n4) {
          if (!e2) return 1;
          var o3 = d.envStore.get(e2);
          if (o3.checkGCAccess(), !r2) return o3.setLastError(1);
          var s3 = d.handleStore.get(r2);
          if (!s3.isArrayBuffer() && !J.isSharedArrayBuffer(s3.value)) return o3.setLastError(1);
          var i3 = new DataView(a2.buffer);
          if (t3) {
            t3 >>>= 0;
            var u3 = J.getArrayBufferPointer(s3.value, true).address;
            i3.setUint32(t3, u3, true);
          }
          return n4 && (n4 >>>= 0, i3.setUint32(n4, s3.value.byteLength, true)), o3.clearLastError();
        }, napi_get_buffer_info: function(e2, r2, t3, n4) {
          if (!e2) return 1;
          var a3 = d.envStore.get(e2);
          if (a3.checkGCAccess(), !r2) return a3.setLastError(1);
          var o3 = d.handleStore.get(r2);
          return o3.isBuffer(d.feature.Buffer) ? o3.isDataView() ? $(e2, r2, n4, t3, 0, 0) : Q(e2, r2, 0, n4, t3, 0, 0) : a3.setLastError(1);
        }, napi_get_dataview_info: $, napi_get_date_value: function(e2, r2, t3) {
          var n4;
          if (!e2) return 1;
          var o3 = d.envStore.get(e2);
          if (o3.checkGCAccess(), !o3.tryCatch.isEmpty()) return o3.setLastError(10);
          if (!o3.canCallIntoJs()) return o3.setLastError(o3.moduleApiVersion >= 10 ? 23 : 10);
          o3.clearLastError();
          try {
            if (!r2) return o3.setLastError(1);
            if (!t3) return o3.setLastError(1);
            var s3 = d.handleStore.get(r2);
            return s3.isDate() ? (t3 >>>= 0, n4 = s3.value.valueOf(), new DataView(a2.buffer).setFloat64(t3, n4, true), o3.getReturnStatus()) : o3.setLastError(1);
          } catch (e3) {
            return o3.tryCatch.setError(e3), o3.setLastError(10);
          }
        }, napi_get_prototype: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !n4.tryCatch.isEmpty()) return n4.setLastError(10);
          if (!n4.canCallIntoJs()) return n4.setLastError(n4.moduleApiVersion >= 10 ? 23 : 10);
          n4.clearLastError();
          try {
            if (!r2) return n4.setLastError(1);
            if (!t3) return n4.setLastError(1);
            var o3 = d.handleStore.get(r2);
            if (null == o3.value) throw new TypeError("Cannot convert undefined or null to object");
            var s3 = void 0;
            try {
              s3 = o3.isObject() || o3.isFunction() ? o3.value : Object(o3.value);
            } catch (e3) {
              return n4.setLastError(2);
            }
            t3 >>>= 0;
            var i3 = n4.ensureHandleId(Object.getPrototypeOf(s3));
            return new DataView(a2.buffer).setUint32(t3, i3, true), n4.getReturnStatus();
          } catch (e3) {
            return n4.tryCatch.setError(e3), n4.setLastError(10);
          }
        }, napi_get_typedarray_info: Q, napi_get_value_bigint_int64: function(e2, r2, t3, n4) {
          if (!e2) return 1;
          var o3 = d.envStore.get(e2);
          if (o3.checkGCAccess(), !d.feature.supportBigInt) return o3.setLastError(9);
          if (!r2) return o3.setLastError(1);
          if (!t3) return o3.setLastError(1);
          if (!n4) return o3.setLastError(1);
          var s3 = d.handleStore.get(r2).value;
          if ("bigint" != typeof s3) return o3.setLastError(6);
          n4 >>>= 0, t3 >>>= 0;
          var i3 = new DataView(a2.buffer);
          s3 >= BigInt(-1) * (BigInt(1) << BigInt(63)) && s3 < BigInt(1) << BigInt(63) ? i3.setInt8(n4, 1, true) : (i3.setInt8(n4, 0, true), (s3 &= (BigInt(1) << BigInt(64)) - BigInt(1)) >= BigInt(1) << BigInt(63) && (s3 -= BigInt(1) << BigInt(64)));
          var u3 = Number(s3 & BigInt(4294967295)), f2 = Number(s3 >> BigInt(32));
          return i3.setInt32(t3, u3, true), i3.setInt32(t3 + 4, f2, true), o3.clearLastError();
        }, napi_get_value_bigint_uint64: function(e2, r2, t3, n4) {
          if (!e2) return 1;
          var o3 = d.envStore.get(e2);
          if (o3.checkGCAccess(), !d.feature.supportBigInt) return o3.setLastError(9);
          if (!r2) return o3.setLastError(1);
          if (!t3) return o3.setLastError(1);
          if (!n4) return o3.setLastError(1);
          var s3 = d.handleStore.get(r2).value;
          if ("bigint" != typeof s3) return o3.setLastError(6);
          n4 >>>= 0, t3 >>>= 0;
          var i3 = new DataView(a2.buffer);
          s3 >= BigInt(0) && s3 < BigInt(1) << BigInt(64) ? i3.setInt8(n4, 1, true) : (i3.setInt8(n4, 0, true), s3 &= (BigInt(1) << BigInt(64)) - BigInt(1));
          var u3 = Number(s3 & BigInt(4294967295)), f2 = Number(s3 >> BigInt(32));
          return i3.setUint32(t3, u3, true), i3.setUint32(t3 + 4, f2, true), o3.clearLastError();
        }, napi_get_value_bigint_words: function(e2, r2, t3, n4, o3) {
          if (!e2) return 1;
          var s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !d.feature.supportBigInt) return s3.setLastError(9);
          if (!r2) return s3.setLastError(1);
          if (!n4) return s3.setLastError(1);
          var i3 = d.handleStore.get(r2);
          if (!i3.isBigInt()) return s3.setLastError(17);
          var u3 = i3.value < BigInt(0);
          t3 >>>= 0, o3 >>>= 0, n4 >>>= 0;
          var f2 = new DataView(a2.buffer), c2 = f2.getUint32(n4, true);
          c2 >>>= 0;
          for (var l2 = 0, v2 = u3 ? i3.value * BigInt(-1) : i3.value; v2 !== BigInt(0); ) l2++, v2 >>= BigInt(64);
          if (v2 = u3 ? i3.value * BigInt(-1) : i3.value, t3 || o3) {
            if (!t3) return s3.setLastError(1);
            if (!o3) return s3.setLastError(1);
            for (var p2 = []; v2 !== BigInt(0); ) {
              var g2 = v2 & (BigInt(1) << BigInt(64)) - BigInt(1);
              p2.push(g2), v2 >>= BigInt(64);
            }
            for (var y2 = Math.min(c2, p2.length), h2 = 0; h2 < y2; h2++) {
              var _2 = Number(p2[h2] & BigInt(4294967295)), E2 = Number(p2[h2] >> BigInt(32));
              f2.setUint32(o3 + 8 * h2, _2, true), f2.setUint32(o3 + (8 * h2 + 4), E2, true);
            }
            f2.setInt32(t3, u3 ? 1 : 0, true), f2.setUint32(n4, y2, true);
          } else c2 = l2, f2.setUint32(n4, c2, true);
          return s3.clearLastError();
        }, napi_get_value_bool: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !r2) return n4.setLastError(1);
          if (!t3) return n4.setLastError(1);
          var o3 = d.handleStore.get(r2);
          if ("boolean" != typeof o3.value) return n4.setLastError(7);
          t3 >>>= 0;
          var s3 = o3.value ? 1 : 0;
          return new DataView(a2.buffer).setInt8(t3, s3, true), n4.clearLastError();
        }, napi_get_value_double: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !r2) return n4.setLastError(1);
          if (!t3) return n4.setLastError(1);
          var o3 = d.handleStore.get(r2);
          if ("number" != typeof o3.value) return n4.setLastError(6);
          t3 >>>= 0;
          var s3 = o3.value;
          return new DataView(a2.buffer).setFloat64(t3, s3, true), n4.clearLastError();
        }, napi_get_value_external: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !r2) return n4.setLastError(1);
          if (!t3) return n4.setLastError(1);
          var o3 = d.handleStore.get(r2);
          if (!o3.isExternal()) return n4.setLastError(1);
          t3 >>>= 0;
          var s3 = o3.data();
          return new DataView(a2.buffer).setUint32(t3, s3, true), n4.clearLastError();
        }, napi_get_value_int32: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !r2) return n4.setLastError(1);
          if (!t3) return n4.setLastError(1);
          var o3 = d.handleStore.get(r2);
          if ("number" != typeof o3.value) return n4.setLastError(6);
          t3 >>>= 0;
          var s3 = new Int32Array([o3.value])[0];
          return new DataView(a2.buffer).setInt32(t3, s3, true), n4.clearLastError();
        }, napi_get_value_int64: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !r2) return n4.setLastError(1);
          if (!t3) return n4.setLastError(1);
          var o3 = d.handleStore.get(r2);
          if ("number" != typeof o3.value) return n4.setLastError(6);
          var s3 = o3.value;
          t3 >>>= 0;
          var i3 = new DataView(a2.buffer);
          return s3 === Number.POSITIVE_INFINITY || s3 === Number.NEGATIVE_INFINITY || isNaN(s3) ? (i3.setInt32(t3, 0, true), i3.setInt32(t3 + 4, 0, true)) : s3 < -9223372036854776e3 ? (i3.setInt32(t3, 0, true), i3.setInt32(t3 + 4, 2147483648, true)) : s3 >= 9223372036854776e3 ? (i3.setUint32(t3, 4294967295, true), i3.setUint32(t3 + 4, 2147483647, true)) : I(t3, Math.trunc(s3)), n4.clearLastError();
        }, napi_get_value_string_latin1: function(e2, r2, t3, n4, o3) {
          if (!e2) return 1;
          var s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !r2) return s3.setLastError(1);
          o3 >>>= 0, t3 >>>= 0, n4 >>>= 0, n4 >>>= 0;
          var i3 = d.handleStore.get(r2);
          if ("string" != typeof i3.value) return s3.setLastError(3);
          var u3 = new DataView(a2.buffer);
          if (t3) if (0 !== n4) {
            for (var f2 = 0, c2 = void 0, l2 = 0; l2 < n4 - 1; ++l2) c2 = 255 & i3.value.charCodeAt(l2), u3.setUint8(t3 + l2, c2, true), f2++;
            u3.setUint8(t3 + f2, 0, true), o3 && u3.setUint32(o3, f2, true);
          } else o3 && u3.setUint32(o3, 0, true);
          else {
            if (!o3) return s3.setLastError(1);
            u3.setUint32(o3, i3.value.length, true);
          }
          return s3.clearLastError();
        }, napi_get_value_string_utf16: function(e2, r2, t3, n4, o3) {
          if (!e2) return 1;
          var s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !r2) return s3.setLastError(1);
          o3 >>>= 0, t3 >>>= 0, n4 >>>= 0, n4 >>>= 0;
          var i3 = d.handleStore.get(r2);
          if ("string" != typeof i3.value) return s3.setLastError(3);
          var u3 = new DataView(a2.buffer);
          if (t3) if (0 !== n4) {
            var f2 = H.stringToUTF16(i3.value, t3, 2 * n4);
            o3 && u3.setUint32(o3, f2 / 2, true);
          } else o3 && u3.setUint32(o3, 0, true);
          else {
            if (!o3) return s3.setLastError(1);
            u3.setUint32(o3, i3.value.length, true);
          }
          return s3.clearLastError();
        }, napi_get_value_string_utf8: function(e2, r2, t3, n4, o3) {
          if (!e2) return 1;
          var s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !r2) return s3.setLastError(1);
          o3 >>>= 0, t3 >>>= 0, n4 >>>= 0, n4 >>>= 0;
          var i3 = d.handleStore.get(r2);
          if ("string" != typeof i3.value) return s3.setLastError(3);
          var u3 = new DataView(a2.buffer);
          if (t3) if (0 !== n4) {
            var f2 = H.stringToUTF8(i3.value, t3, n4);
            o3 && u3.setUint32(o3, f2, true);
          } else o3 && u3.setUint32(o3, 0, true);
          else {
            if (!o3) return s3.setLastError(1);
            var c2 = H.lengthBytesUTF8(i3.value);
            u3.setUint32(o3, c2, true);
          }
          return s3.clearLastError();
        }, napi_get_value_uint32: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !r2) return n4.setLastError(1);
          if (!t3) return n4.setLastError(1);
          var o3 = d.handleStore.get(r2);
          if ("number" != typeof o3.value) return n4.setLastError(6);
          t3 >>>= 0;
          var s3 = new Uint32Array([o3.value])[0];
          return new DataView(a2.buffer).setUint32(t3, s3, true), n4.clearLastError();
        }, node_api_set_prototype: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !n4.tryCatch.isEmpty()) return n4.setLastError(10);
          if (!n4.canCallIntoJs()) return n4.setLastError(n4.moduleApiVersion >= 10 ? 23 : 10);
          n4.clearLastError();
          try {
            if (!t3) return n4.setLastError(1);
            var a3 = d.handleStore.get(r2).value;
            if (null == a3) throw new TypeError("Cannot convert undefined or null to object");
            var o3 = typeof a3, s3 = void 0;
            try {
              s3 = "object" === o3 && null !== a3 || "function" === o3 ? a3 : Object(a3);
            } catch (e3) {
              return n4.setLastError(2);
            }
            var i3 = d.handleStore.get(t3).value;
            return Object.setPrototypeOf(s3, i3), n4.getReturnStatus();
          } catch (e3) {
            return n4.tryCatch.setError(e3), n4.setLastError(10);
          }
        } });
        function X(e2, r2, t3, n4) {
          return H.newString(e2, r2, t3, n4, function(e3, r3, t4) {
            var n5 = "", o3 = 0, s3 = new DataView(a2.buffer);
            if (r3) for (; ; ) {
              if (!(i3 = s3.getUint8(e3, true))) break;
              n5 += String.fromCharCode(i3), e3++;
            }
            else for (; o3 < t4; ) {
              var i3;
              if (!(i3 = s3.getUint8(e3, true))) break;
              n5 += String.fromCharCode(i3), o3++, e3++;
            }
            return n5;
          });
        }
        function Z(e2, r2, t3, n4) {
          return H.newString(e2, r2, t3, n4, function(e3) {
            return H.UTF16ToString(e3, t3);
          });
        }
        function K(e2, r2, t3, n4) {
          return H.newString(e2, r2, t3, n4, function(e3) {
            return H.UTF8ToString(e3, t3);
          });
        }
        var ee = Object.freeze({ __proto__: null, napi_create_bigint_int64: function(e2, r2, t3, n4) {
          if (!e2) return 1;
          var o3, s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !d.feature.supportBigInt) return s3.setLastError(9);
          if (!t3) return s3.setLastError(1);
          o3 = r2;
          var i3 = d.addToCurrentScope(o3).id;
          return t3 >>>= 0, new DataView(a2.buffer).setUint32(t3, i3, true), s3.clearLastError();
        }, napi_create_bigint_uint64: function(e2, r2, t3, n4) {
          if (!e2) return 1;
          var o3, s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !d.feature.supportBigInt) return s3.setLastError(9);
          if (!t3) return s3.setLastError(1);
          o3 = r2 & (BigInt(1) << BigInt(64)) - BigInt(1);
          var i3 = d.addToCurrentScope(o3).id;
          return t3 >>>= 0, new DataView(a2.buffer).setUint32(t3, i3, true), s3.clearLastError();
        }, napi_create_bigint_words: function(e2, r2, t3, n4, o3) {
          var s3, i3;
          if (!e2) return 1;
          var u3 = d.envStore.get(e2);
          if (u3.checkGCAccess(), !u3.tryCatch.isEmpty()) return u3.setLastError(10);
          if (!u3.canCallIntoJs()) return u3.setLastError(u3.moduleApiVersion >= 10 ? 23 : 10);
          u3.clearLastError();
          try {
            if (!d.feature.supportBigInt) return u3.setLastError(9);
            if (!o3) return u3.setLastError(1);
            if (n4 >>>= 0, t3 >>>= 0, (t3 >>>= 0) > 2147483647) return u3.setLastError(1);
            if (t3 > 16384) throw new RangeError("Maximum BigInt size exceeded");
            var f2 = BigInt(0), c2 = new DataView(a2.buffer);
            for (i3 = 0; i3 < t3; i3++) {
              var l2 = c2.getUint32(n4 + 8 * i3, true), v2 = c2.getUint32(n4 + (8 * i3 + 4), true);
              f2 += (BigInt(l2) | BigInt(v2) << BigInt(32)) << BigInt(64 * i3);
            }
            return f2 *= BigInt(r2) % BigInt(2) === BigInt(0) ? BigInt(1) : BigInt(-1), o3 >>>= 0, s3 = d.addToCurrentScope(f2).id, c2.setUint32(o3, s3, true), u3.getReturnStatus();
          } catch (e3) {
            return u3.tryCatch.setError(e3), u3.setLastError(10);
          }
        }, napi_create_double: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !t3) return n4.setLastError(1);
          t3 >>>= 0;
          var o3 = d.addToCurrentScope(r2).id;
          return new DataView(a2.buffer).setUint32(t3, o3, true), n4.clearLastError();
        }, napi_create_int32: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !t3) return n4.setLastError(1);
          t3 >>>= 0;
          var o3 = d.addToCurrentScope(r2).id;
          return new DataView(a2.buffer).setUint32(t3, o3, true), n4.clearLastError();
        }, napi_create_int64: function(e2, r2, t3, n4) {
          if (!e2) return 1;
          var o3, s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !t3) return s3.setLastError(1);
          o3 = Number(r2);
          var i3 = d.addToCurrentScope(o3).id;
          return t3 >>>= 0, new DataView(a2.buffer).setUint32(t3, i3, true), s3.clearLastError();
        }, napi_create_string_latin1: X, napi_create_string_utf16: Z, napi_create_string_utf8: K, napi_create_uint32: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !t3) return n4.setLastError(1);
          t3 >>>= 0;
          var o3 = d.addToCurrentScope(r2 >>> 0).id;
          return new DataView(a2.buffer).setUint32(t3, o3, true), n4.clearLastError();
        }, node_api_create_external_string_latin1: function(e2, r2, t3, n4, a3, o3, s3) {
          return H.newExternalString(e2, r2, t3, n4, a3, o3, s3, X, void 0);
        }, node_api_create_external_string_utf16: function(e2, r2, t3, n4, a3, o3, s3) {
          return H.newExternalString(e2, r2, t3, n4, a3, o3, s3, Z, void 0);
        }, node_api_create_property_key_latin1: function(e2, r2, t3, n4) {
          return X(e2, r2, t3, n4);
        }, node_api_create_property_key_utf16: function(e2, r2, t3, n4) {
          return Z(e2, r2, t3, n4);
        }, node_api_create_property_key_utf8: function(e2, r2, t3, n4) {
          return K(e2, r2, t3, n4);
        } });
        function re(e2, r2, t3, n4, a3) {
          var s3, i3 = (r2 >>>= 0) && t3 ? H.UTF8ToString(r2, t3) : "", u3 = o2.get(n4), f2 = function(e3) {
            return u3(e3.id, e3.ctx.scopeStore.currentScope.id);
          }, c2 = function(e3, r3) {
            return function() {
              var t4 = e3.ctx.openScope(e3), n5 = t4.callbackInfo;
              n5.data = a3, n5.args = arguments, n5.thiz = this, n5.fn = s3;
              try {
                var o3 = e3.callIntoModule(r3);
                return o3 ? e3.ctx.handleStore.get(o3).value : void 0;
              } finally {
                n5.data = 0, n5.args = void 0, n5.thiz = void 0, n5.fn = void 0, e3.ctx.closeScope(e3, t4);
              }
            };
          };
          if ("" === i3) return { status: 0, f: s3 = c2(e2, f2) };
          if (!/^[_$a-zA-Z][_$a-zA-Z0-9]*$/.test(i3)) return { status: 1, f: void 0 };
          if (d.feature.supportNewFunction) {
            var l2 = c2(e2, f2);
            try {
              s3 = new Function("_", "return function " + i3 + '(){"use strict";return _.apply(this,arguments);};')(l2);
            } catch (r3) {
              s3 = c2(e2, f2), d.feature.canSetFunctionName && Object.defineProperty(s3, "name", { value: i3 });
            }
          } else s3 = c2(e2, f2), d.feature.canSetFunctionName && Object.defineProperty(s3, "name", { value: i3 });
          return { status: 0, f: s3 };
        }
        function te(e2, r2, t3, n4, a3, o3, s3, i3, u3) {
          if (a3 || o3) {
            var f2 = void 0, c2 = void 0;
            a3 && (f2 = re(e2, 0, 0, a3, u3).f), o3 && (c2 = re(e2, 0, 0, o3, u3).f);
            var l2 = { configurable: !!(4 & i3), enumerable: !!(2 & i3), get: f2, set: c2 };
            Object.defineProperty(r2, t3, l2);
          } else if (n4) {
            l2 = { configurable: !!(4 & i3), enumerable: !!(2 & i3), writable: !!(1 & i3), value: re(e2, 0, 0, n4, u3).f };
            Object.defineProperty(r2, t3, l2);
          } else {
            l2 = { configurable: !!(4 & i3), enumerable: !!(2 & i3), writable: !!(1 & i3), value: d.handleStore.get(s3).value };
            Object.defineProperty(r2, t3, l2);
          }
        }
        function ne(e2) {
          var r2 = d.handleStore.get(e2);
          return r2.isObject() || r2.isFunction() ? (void 0 !== J && ArrayBuffer.isView(r2.value) && J.wasmMemoryViewTable.has(r2.value) && (r2 = d.addToCurrentScope(J.wasmMemoryViewTable.get(r2.value))), { status: 0, handle: r2 }) : { status: 1 };
        }
        function ae(e2, r2, t3, n4) {
          var o3;
          if (!e2) return 1;
          var s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !s3.tryCatch.isEmpty()) return s3.setLastError(10);
          if (!s3.canCallIntoJs()) return s3.setLastError(s3.moduleApiVersion >= 10 ? 23 : 10);
          s3.clearLastError();
          try {
            if (!r2) return s3.setLastError(1);
            if (0 === n4 && !t3) return s3.setLastError(1);
            var i3 = d.handleStore.get(r2);
            if (!i3.isObject() && !i3.isFunction()) return s3.setLastError(1);
            var u3 = s3.getObjectBinding(i3.value), f2 = u3.wrapped, c2 = d.refStore.get(f2);
            if (!c2) return s3.setLastError(1);
            if (t3) t3 >>>= 0, o3 = c2.data(), new DataView(a2.buffer).setUint32(t3, o3, true);
            return 1 === n4 && (u3.wrapped = 0, 1 === c2.ownership() ? c2.resetFinalizer() : c2.dispose()), s3.getReturnStatus();
          } catch (e3) {
            return s3.tryCatch.setError(e3), s3.setLastError(10);
          }
        }
        function oe(e2, r2, t3, n4, o3, s3) {
          if (!e2) return 1;
          var i3 = d.envStore.get(e2);
          if (i3.checkGCAccess(), !d.feature.supportFinalizer) return i3.setLastError(9);
          if (!r2) return i3.setLastError(1);
          if (!n4) return i3.setLastError(1);
          var u3 = ne(r2);
          if (0 !== u3.status) return i3.setLastError(u3.status);
          var f2 = u3.handle, c2 = s3 ? 1 : 0;
          t3 >>>= 0, n4 >>>= 0, o3 >>>= 0;
          var l2 = d.createReferenceWithFinalizer(i3, f2.id, 0, c2, n4, t3, o3);
          if (s3) {
            s3 >>>= 0;
            var v2 = l2.id;
            new DataView(a2.buffer).setUint32(s3, v2, true);
          }
          return i3.clearLastError();
        }
        var se = Object.freeze({ __proto__: null, napi_add_finalizer: oe, napi_check_object_type_tag: function(e2, r2, t3, n4) {
          var o3 = true;
          if (!e2) return 1;
          var s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !s3.tryCatch.isEmpty()) return s3.setLastError(10);
          if (!s3.canCallIntoJs()) return s3.setLastError(s3.moduleApiVersion >= 10 ? 23 : 10);
          s3.clearLastError();
          try {
            if (!r2) return s3.setLastError(s3.tryCatch.hasCaught() ? 10 : 1);
            var i3 = d.handleStore.get(r2);
            if (!i3.isObject() && !i3.isFunction()) return s3.setLastError(s3.tryCatch.hasCaught() ? 10 : 2);
            if (!t3) return s3.setLastError(s3.tryCatch.hasCaught() ? 10 : 1);
            if (!n4) return s3.setLastError(s3.tryCatch.hasCaught() ? 10 : 1);
            var u3 = s3.getObjectBinding(i3.value);
            if (null !== u3.tag) {
              t3 >>>= 0;
              var f2 = u3.tag, c2 = new Uint32Array(a2.buffer, t3, 4);
              o3 = f2[0] === c2[0] && f2[1] === c2[1] && f2[2] === c2[2] && f2[3] === c2[3];
            } else o3 = false;
            return n4 >>>= 0, new DataView(a2.buffer).setInt8(n4, o3 ? 1 : 0, true), s3.getReturnStatus();
          } catch (e3) {
            return s3.tryCatch.setError(e3), s3.setLastError(10);
          }
        }, napi_define_class: function(e2, r2, t3, n4, o3, s3, i3, u3) {
          var f2, c2, l2;
          if (!e2) return 1;
          var v2 = d.envStore.get(e2);
          if (v2.checkGCAccess(), !v2.tryCatch.isEmpty()) return v2.setLastError(10);
          if (!v2.canCallIntoJs()) return v2.setLastError(v2.moduleApiVersion >= 10 ? 23 : 10);
          v2.clearLastError();
          try {
            if (!u3) return v2.setLastError(1);
            if (!n4) return v2.setLastError(1);
            if (t3 >>>= 0, i3 >>>= 0, s3 >>>= 0, (s3 >>>= 0) > 0 && !i3) return v2.setLastError(1);
            if (!(t3 >= -1 && t3 <= 2147483647 || 4294967295 === t3) || !r2) return v2.setLastError(1);
            var p2 = re(v2, r2, t3, n4, o3);
            if (0 !== p2.status) return v2.setLastError(p2.status);
            for (var g2 = p2.f, y2 = void 0, h2 = new DataView(a2.buffer), _2 = 0; _2 < s3; _2++) {
              f2 = i3 + 32 * _2;
              var E2 = h2.getUint32(f2, true), w2 = h2.getUint32(f2 + 4, true), L2 = h2.getUint32(f2 + 8, true), m2 = h2.getUint32(f2 + 12, true), b2 = h2.getUint32(f2 + 16, true), S2 = h2.getUint32(f2 + 20, true);
              l2 = h2.getInt32(f2 + 24, true), l2 >>>= 0;
              var A2 = h2.getUint32(f2 + 28, true);
              if (E2) y2 = H.UTF8ToString(E2, -1);
              else {
                if (!w2) return v2.setLastError(4);
                if ("string" != typeof (y2 = d.handleStore.get(w2).value) && "symbol" != typeof y2) return v2.setLastError(4);
              }
              1024 & l2 ? te(v2, g2, y2, L2, m2, b2, S2, l2, A2) : te(v2, g2.prototype, y2, L2, m2, b2, S2, l2, A2);
            }
            return c2 = d.addToCurrentScope(g2).id, u3 >>>= 0, h2.setUint32(u3, c2, true), v2.getReturnStatus();
          } catch (e3) {
            return v2.tryCatch.setError(e3), v2.setLastError(10);
          }
        }, napi_remove_wrap: function(e2, r2, t3) {
          return ae(e2, r2, t3, 1);
        }, napi_type_tag_object: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !n4.tryCatch.isEmpty()) return n4.setLastError(10);
          if (!n4.canCallIntoJs()) return n4.setLastError(n4.moduleApiVersion >= 10 ? 23 : 10);
          n4.clearLastError();
          try {
            if (!r2) return n4.setLastError(n4.tryCatch.hasCaught() ? 10 : 1);
            var o3 = d.handleStore.get(r2);
            if (!o3.isObject() && !o3.isFunction()) return n4.setLastError(n4.tryCatch.hasCaught() ? 10 : 2);
            if (!(t3 >>>= 0)) return n4.setLastError(n4.tryCatch.hasCaught() ? 10 : 1);
            var s3 = n4.getObjectBinding(o3.value);
            if (null !== s3.tag) return n4.setLastError(n4.tryCatch.hasCaught() ? 10 : 1);
            var i3 = new Uint8Array(16);
            return i3.set(new Uint8Array(a2.buffer, t3, 16)), s3.tag = new Uint32Array(i3.buffer), n4.getReturnStatus();
          } catch (e3) {
            return n4.tryCatch.setError(e3), n4.setLastError(10);
          }
        }, napi_unwrap: function(e2, r2, t3) {
          return ae(e2, r2, t3, 0);
        }, napi_wrap: function(e2, r2, t3, n4, o3, s3) {
          return function(e3, r3, t4, n5, o4, s4) {
            var i3;
            if (!e3) return 1;
            var u3 = d.envStore.get(e3);
            if (u3.checkGCAccess(), !u3.tryCatch.isEmpty()) return u3.setLastError(10);
            if (!u3.canCallIntoJs()) return u3.setLastError(u3.moduleApiVersion >= 10 ? 23 : 10);
            u3.clearLastError();
            try {
              if (!d.feature.supportFinalizer) {
                if (n5) throw d.createNotSupportWeakRefError("napi_wrap", 'Parameter "finalize_cb" must be 0(NULL)');
                if (s4) throw d.createNotSupportWeakRefError("napi_wrap", 'Parameter "result" must be 0(NULL)');
              }
              if (!r3) return u3.setLastError(1);
              var f2 = ne(r3);
              if (0 !== f2.status) return u3.setLastError(f2.status);
              var c2 = f2.handle;
              if (0 !== u3.getObjectBinding(c2.value).wrapped) return u3.setLastError(1);
              var l2 = void 0;
              if (s4) {
                if (!n5) return u3.setLastError(1);
                l2 = d.createReferenceWithFinalizer(u3, c2.id, 0, 1, n5, t4, o4), s4 >>>= 0, i3 = l2.id, new DataView(a2.buffer).setUint32(s4, i3, true);
              } else l2 = n5 ? d.createReferenceWithFinalizer(u3, c2.id, 0, 0, n5, t4, o4) : d.createReferenceWithData(u3, c2.id, 0, 0, t4);
              return u3.getObjectBinding(c2.value).wrapped = l2.id, u3.getReturnStatus();
            } catch (e4) {
              return u3.tryCatch.setError(e4), u3.setLastError(10);
            }
          }(e2, r2, t3, n4, o3, s3);
        }, node_api_post_finalizer: function(e2, r2, t3, n4) {
          if (!e2) return 1;
          var a3 = d.envStore.get(e2);
          return a3.enqueueFinalizer(d.createTrackedFinalizer(a3, r2, t3, n4)), a3.clearLastError();
        } });
        function ie(e2, r2, t3, n4, o3, s3, i3) {
          var u3;
          if (!e2) return 1;
          var f2 = d.envStore.get(e2);
          if (f2.checkGCAccess(), !f2.tryCatch.isEmpty()) return f2.setLastError(10);
          if (!f2.canCallIntoJs()) return f2.setLastError(f2.moduleApiVersion >= 10 ? 23 : 10);
          f2.clearLastError();
          try {
            if (!i3) return f2.setLastError(1);
            if (n4 >>>= 0, i3 >>>= 0, n4 >>>= 0, (t3 >>>= 0) || (n4 = 0), n4 > 2147483647) throw new RangeError("Cannot create a memory view larger than 2147483647 bytes");
            if (t3 + n4 > a2.buffer.byteLength) throw new RangeError("Memory out of range");
            if (!d.feature.supportFinalizer && o3) throw d.createNotSupportWeakRefError("emnapi_create_memory_view", 'Parameter "finalize_cb" must be 0(NULL)');
            var c2 = void 0;
            switch (r2) {
              case 0:
                c2 = { Ctor: Int8Array, address: t3, length: n4, ownership: 1, runtimeAllocated: 0 };
                break;
              case 1:
                c2 = { Ctor: Uint8Array, address: t3, length: n4, ownership: 1, runtimeAllocated: 0 };
                break;
              case 2:
                c2 = { Ctor: Uint8ClampedArray, address: t3, length: n4, ownership: 1, runtimeAllocated: 0 };
                break;
              case 3:
                c2 = { Ctor: Int16Array, address: t3, length: n4 >> 1, ownership: 1, runtimeAllocated: 0 };
                break;
              case 4:
                c2 = { Ctor: Uint16Array, address: t3, length: n4 >> 1, ownership: 1, runtimeAllocated: 0 };
                break;
              case 5:
                c2 = { Ctor: Int32Array, address: t3, length: n4 >> 2, ownership: 1, runtimeAllocated: 0 };
                break;
              case 6:
                c2 = { Ctor: Uint32Array, address: t3, length: n4 >> 2, ownership: 1, runtimeAllocated: 0 };
                break;
              case 7:
                c2 = { Ctor: Float32Array, address: t3, length: n4 >> 2, ownership: 1, runtimeAllocated: 0 };
                break;
              case 8:
                c2 = { Ctor: Float64Array, address: t3, length: n4 >> 3, ownership: 1, runtimeAllocated: 0 };
                break;
              case 9:
                c2 = { Ctor: BigInt64Array, address: t3, length: n4 >> 3, ownership: 1, runtimeAllocated: 0 };
                break;
              case 10:
                c2 = { Ctor: BigUint64Array, address: t3, length: n4 >> 3, ownership: 1, runtimeAllocated: 0 };
                break;
              case -1:
                c2 = { Ctor: DataView, address: t3, length: n4, ownership: 1, runtimeAllocated: 0 };
                break;
              case 11:
                if ("function" != typeof Float16Array) return f2.setLastError(1);
                c2 = { Ctor: Float16Array, address: t3, length: n4 >> 1, ownership: 1, runtimeAllocated: 0 };
                break;
              case -2:
                if (!d.feature.Buffer) throw d.createNotSupportBufferError("emnapi_create_memory_view", "");
                c2 = { Ctor: d.feature.Buffer, address: t3, length: n4, ownership: 1, runtimeAllocated: 0 };
                break;
              default:
                return f2.setLastError(1);
            }
            var l2 = c2.Ctor, v2 = -2 === r2 ? d.feature.Buffer.from(a2.buffer, c2.address, c2.length) : new l2(a2.buffer, c2.address, c2.length), p2 = d.addToCurrentScope(v2);
            if (J.wasmMemoryViewTable.set(v2, c2), o3) {
              var g2 = oe(e2, p2.id, t3, o3, s3, 0);
              if (10 === g2) {
                var y2 = f2.tryCatch.extractException();
                throw f2.clearLastError(), y2;
              }
              if (0 !== g2) return f2.setLastError(g2);
            }
            return u3 = p2.id, new DataView(a2.buffer).setUint32(i3, u3, true), f2.getReturnStatus();
          } catch (y3) {
            return f2.tryCatch.setError(y3), f2.setLastError(10);
          }
        }
        function ue(e2, r2, t3, n4) {
          var o3;
          if (t3 = null != t3 ? t3 : 0, t3 >>>= 0, r2 instanceof ArrayBuffer || J.isSharedArrayBuffer(r2)) {
            if (!(i3 = J.getArrayBufferPointer(r2, false).address)) throw new Error("Unknown ArrayBuffer address");
            if ("number" == typeof n4 && -1 !== n4 && 4294967295 !== n4 || (n4 = r2.byteLength - t3), 0 === (n4 >>>= 0)) return r2;
            o3 = new Uint8Array(r2, t3, n4);
            var s3 = new Uint8Array(a2.buffer);
            return e2 ? s3.set(o3, i3) : o3.set(s3.subarray(i3, i3 + n4)), r2;
          }
          if (ArrayBuffer.isView(r2)) {
            var i3, u3 = J.getViewPointer(r2, false), f2 = u3.view;
            if (!(i3 = u3.address)) throw new Error("Unknown ArrayBuffer address");
            if ("number" == typeof n4 && -1 !== n4 && 4294967295 !== n4 || (n4 = f2.byteLength - t3), 0 === (n4 >>>= 0)) return f2;
            o3 = new Uint8Array(f2.buffer, f2.byteOffset + t3, n4);
            s3 = new Uint8Array(a2.buffer);
            return e2 ? s3.set(o3, i3) : o3.set(s3.subarray(i3, i3 + n4)), f2;
          }
          throw new TypeError("emnapiSyncMemory expect ArrayBuffer or ArrayBufferView as first parameter");
        }
        function fe(e2) {
          var r2, t3 = e2 instanceof ArrayBuffer, n4 = e2 instanceof DataView, a3 = ArrayBuffer.isView(e2) && !n4;
          if (!(t3 || a3 || n4 || J.isSharedArrayBuffer(e2))) throw new TypeError("emnapiGetMemoryAddress expect ArrayBuffer or ArrayBufferView as first parameter");
          return { address: (r2 = t3 ? J.getArrayBufferPointer(e2, false) : J.getViewPointer(e2, false)).address, ownership: r2.ownership, runtimeAllocated: r2.runtimeAllocated };
        }
        function ce(e2, r2) {
          if (null != r2 && !J.isSharedArrayBuffer(r2)) throw new TypeError("Expected a SharedArrayBuffer");
          if (!P.registry) throw new Error("FinalizationRegistry is not supported in this environment");
          e2 >>>= 0;
          var t3 = P.readMeta(e2), n4 = t3.external_data;
          if (n4 >>>= 0, null == r2) r2 = new SharedArrayBuffer(t3.byte_length), new Uint8Array(r2).set(new Uint8Array(a2.buffer, n4, t3.byte_length));
          else if (P.handleTable.has(r2)) return r2;
          return Atomics.add(new Int32Array(a2.buffer, e2, 1), 0, 1), J.table.has(r2) || n4 && J.table.set(r2, { address: n4, ownership: 1, runtimeAllocated: 0 }), P.handleTable.set(r2, e2), P.registry.register(r2, e2), r2;
        }
        var le = Object.freeze({ __proto__: null, $emnapiAcquireExternalSharedArrayBuffer: ce, $emnapiGetMemoryAddress: fe, $emnapiSyncMemory: ue, emnapi_acquire_external_sharedarraybuffer: function(e2) {
          e2 >>>= 0, Atomics.add(new Int32Array(a2.buffer, e2, 1), 0, 1);
        }, emnapi_create_memory_view: ie, emnapi_get_external_sharedarraybuffer_handle: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !n4.tryCatch.isEmpty()) return n4.setLastError(10);
          if (!n4.canCallIntoJs()) return n4.setLastError(n4.moduleApiVersion >= 10 ? 23 : 10);
          n4.clearLastError();
          try {
            if (!r2) return n4.setLastError(1);
            if (!t3) return n4.setLastError(1);
            t3 >>>= 0;
            var o3 = d.handleStore.get(r2).value;
            if (!J.isSharedArrayBuffer(o3)) return n4.setLastError(1);
            var s3 = P.handleTable.get(o3);
            return void 0 === s3 ? n4.setLastError(1) : (new DataView(a2.buffer).setUint32(t3, s3, true), n4.getReturnStatus());
          } catch (e3) {
            return n4.tryCatch.setError(e3), n4.setLastError(10);
          }
        }, emnapi_get_memory_address: function(e2, r2, t3, n4, o3) {
          var s3, i3, u3, f2;
          if (!e2) return 1;
          var c2 = d.envStore.get(e2);
          if (c2.checkGCAccess(), !c2.tryCatch.isEmpty()) return c2.setLastError(10);
          if (!c2.canCallIntoJs()) return c2.setLastError(c2.moduleApiVersion >= 10 ? 23 : 10);
          c2.clearLastError();
          try {
            if (!r2) return c2.setLastError(1);
            if (!t3 && !n4 && !o3) return c2.setLastError(1);
            s3 = (f2 = fe(c2.ctx.handleStore.get(r2).value)).address;
            var l2 = new DataView(a2.buffer);
            return t3 && (t3 >>>= 0, l2.setUint32(t3, s3, true)), n4 && (n4 >>>= 0, u3 = f2.ownership, l2.setInt32(n4, u3, true)), o3 && (o3 >>>= 0, i3 = f2.runtimeAllocated, l2.setInt8(o3, i3, true)), c2.getReturnStatus();
          } catch (e3) {
            return c2.tryCatch.setError(e3), c2.setLastError(10);
          }
        }, emnapi_get_runtime_version: function(e2, r2) {
          if (!e2) return 1;
          var t3, n4 = d.envStore.get(e2);
          if (!r2) return n4.setLastError(1);
          try {
            t3 = d.getRuntimeVersions().version;
          } catch (e3) {
            return n4.setLastError(9);
          }
          var o3 = t3.split(".").map(function(e3) {
            return Number(e3);
          });
          r2 >>>= 0;
          var s3 = new DataView(a2.buffer);
          return s3.setUint32(r2, o3[0], true), s3.setUint32(r2 + 4, o3[1], true), s3.setUint32(r2 + 8, o3[2], true), n4.clearLastError();
        }, emnapi_is_node_binding_available: function() {
          return v ? 1 : 0;
        }, emnapi_is_support_bigint: function() {
          return d.feature.supportBigInt ? 1 : 0;
        }, emnapi_is_support_weakref: function() {
          return d.feature.supportFinalizer ? 1 : 0;
        }, emnapi_release_external_sharedarraybuffer: function(e2) {
          e2 >>>= 0, P.release(e2);
        }, emnapi_sync_memory: function(e2, r2, t3, n4, o3) {
          var s3;
          if (!e2) return 1;
          var i3 = d.envStore.get(e2);
          if (i3.checkGCAccess(), !i3.tryCatch.isEmpty()) return i3.setLastError(10);
          if (!i3.canCallIntoJs()) return i3.setLastError(i3.moduleApiVersion >= 10 ? 23 : 10);
          i3.clearLastError();
          try {
            if (!t3) return i3.setLastError(1);
            t3 >>>= 0, n4 >>>= 0, o3 >>>= 0;
            var u3 = new DataView(a2.buffer), f2 = u3.getUint32(t3, true), c2 = i3.ctx.handleStore.get(f2);
            if (!(c2.isArrayBuffer() || c2.isTypedArray() || c2.isDataView() || J.isSharedArrayBuffer(c2.value))) return i3.setLastError(1);
            var l2 = ue(Boolean(r2), c2.value, n4, o3);
            return c2.value !== l2 && (t3 >>>= 0, s3 = i3.ensureHandleId(l2), u3.setUint32(t3, s3, true)), i3.getReturnStatus();
          } catch (e3) {
            return i3.tryCatch.setError(e3), i3.setLastError(10);
          }
        } });
        function de(e2, r2, t3) {
          e2 >>>= 0, e2 >>>= 0;
          var n4 = t3 ? new SharedArrayBuffer(e2) : new ArrayBuffer(e2);
          if (r2) {
            r2 >>>= 0;
            var o3 = J.getArrayBufferPointer(n4, true).address;
            new DataView(a2.buffer).setUint32(r2, o3, true);
          }
          return n4;
        }
        var ve = Object.freeze({ __proto__: null, napi_create_array: function(e2, r2) {
          if (!e2) return 1;
          var t3 = d.envStore.get(e2);
          if (t3.checkGCAccess(), !r2) return t3.setLastError(1);
          r2 >>>= 0;
          var n4 = d.addToCurrentScope([]).id;
          return new DataView(a2.buffer).setUint32(r2, n4, true), t3.clearLastError();
        }, napi_create_array_with_length: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !t3) return n4.setLastError(1);
          r2 >>>= 0, t3 >>>= 0, r2 >>>= 0;
          var o3 = d.addToCurrentScope(new Array(r2)).id;
          return new DataView(a2.buffer).setUint32(t3, o3, true), n4.clearLastError();
        }, napi_create_arraybuffer: function(e2, r2, t3, n4) {
          var o3;
          if (!e2) return 1;
          var s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !s3.tryCatch.isEmpty()) return s3.setLastError(10);
          if (!s3.canCallIntoJs()) return s3.setLastError(s3.moduleApiVersion >= 10 ? 23 : 10);
          s3.clearLastError();
          try {
            if (!n4) return s3.setLastError(1);
            n4 >>>= 0;
            var i3 = de(r2, t3, false);
            return o3 = d.addToCurrentScope(i3).id, new DataView(a2.buffer).setUint32(n4, o3, true), s3.getReturnStatus();
          } catch (e3) {
            return s3.tryCatch.setError(e3), s3.setLastError(10);
          }
        }, napi_create_buffer: function(e2, r2, t3, n4) {
          var o3, i3, u3;
          if (!e2) return 1;
          var f2 = d.envStore.get(e2);
          if (f2.checkGCAccess(), !f2.tryCatch.isEmpty()) return f2.setLastError(10);
          if (!f2.canCallIntoJs()) return f2.setLastError(f2.moduleApiVersion >= 10 ? 23 : 10);
          f2.clearLastError();
          try {
            if (!n4) return f2.setLastError(1);
            var c2 = d.feature.Buffer;
            if (!c2) throw d.createNotSupportBufferError("napi_create_buffer", "");
            n4 >>>= 0;
            var l2 = void 0;
            r2 >>>= 0, r2 >>>= 0;
            var v2 = new DataView(a2.buffer);
            if (t3 && 0 !== r2) {
              if (!(u3 = s2(r2))) throw new Error("Out of memory");
              u3 >>>= 0, new Uint8Array(a2.buffer).subarray(u3, u3 + r2).fill(0);
              var p2 = c2.from(a2.buffer, u3, r2), g2 = { Ctor: c2, address: u3, length: r2, ownership: J.registry ? 0 : 1, runtimeAllocated: 1 };
              J.wasmMemoryViewTable.set(p2, g2), null === (o3 = J.registry) || void 0 === o3 || o3.register(g2, u3), i3 = d.addToCurrentScope(p2).id, v2.setUint32(n4, i3, true), t3 >>>= 0, v2.setUint32(t3, u3, true);
            } else l2 = c2.alloc(r2), i3 = d.addToCurrentScope(l2).id, v2.setUint32(n4, i3, true);
            return f2.getReturnStatus();
          } catch (e3) {
            return f2.tryCatch.setError(e3), f2.setLastError(10);
          }
        }, napi_create_buffer_copy: function(e2, r2, t3, n4, o3) {
          var s3;
          if (!e2) return 1;
          var i3 = d.envStore.get(e2);
          if (i3.checkGCAccess(), !i3.tryCatch.isEmpty()) return i3.setLastError(10);
          if (!i3.canCallIntoJs()) return i3.setLastError(i3.moduleApiVersion >= 10 ? 23 : 10);
          i3.clearLastError();
          try {
            if (!o3) return i3.setLastError(1);
            var u3 = d.feature.Buffer;
            if (!u3) throw d.createNotSupportBufferError("napi_create_buffer_copy", "");
            var f2 = de(r2, n4, false), c2 = u3.from(f2);
            return t3 >>>= 0, r2 >>>= 0, c2.set(new Uint8Array(a2.buffer).subarray(t3, t3 + r2)), s3 = d.addToCurrentScope(c2).id, o3 >>>= 0, new DataView(a2.buffer).setUint32(o3, s3, true), i3.getReturnStatus();
          } catch (e3) {
            return i3.tryCatch.setError(e3), i3.setLastError(10);
          }
        }, napi_create_dataview: function(e2, r2, t3, n4, o3) {
          if (!e2) return 1;
          var s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !s3.tryCatch.isEmpty()) return s3.setLastError(10);
          if (!s3.canCallIntoJs()) return s3.setLastError(s3.moduleApiVersion >= 10 ? 23 : 10);
          s3.clearLastError();
          try {
            if (!t3) return s3.setLastError(1);
            if (!o3) return s3.setLastError(1);
            r2 >>>= 0, n4 >>>= 0, r2 >>>= 0, n4 >>>= 0;
            var i3 = d.handleStore.get(t3).value;
            return i3 instanceof ArrayBuffer || J.isSharedArrayBuffer(i3) ? function(e3) {
              if (r2 + n4 > e3.byteLength) {
                var t4 = new RangeError("byte_offset + byte_length should be less than or equal to the size in bytes of the array passed in");
                throw t4.code = "ERR_NAPI_INVALID_DATAVIEW_ARGS", t4;
              }
              var i4 = new DataView(e3, n4, r2);
              e3 === a2.buffer && (J.wasmMemoryViewTable.has(i4) || J.wasmMemoryViewTable.set(i4, { Ctor: DataView, address: n4, length: r2, ownership: 1, runtimeAllocated: 0 })), o3 >>>= 0;
              var u3 = d.addToCurrentScope(i4).id;
              return new DataView(a2.buffer).setUint32(o3, u3, true), s3.getReturnStatus();
            }(i3) : s3.setLastError(1);
          } catch (e3) {
            return s3.tryCatch.setError(e3), s3.setLastError(10);
          }
        }, napi_create_date: function(e2, r2, t3) {
          var n4;
          if (!e2) return 1;
          var o3 = d.envStore.get(e2);
          if (o3.checkGCAccess(), !o3.tryCatch.isEmpty()) return o3.setLastError(10);
          if (!o3.canCallIntoJs()) return o3.setLastError(o3.moduleApiVersion >= 10 ? 23 : 10);
          o3.clearLastError();
          try {
            return t3 ? (t3 >>>= 0, n4 = d.addToCurrentScope(new Date(r2)).id, new DataView(a2.buffer).setUint32(t3, n4, true), o3.getReturnStatus()) : o3.setLastError(1);
          } catch (e3) {
            return o3.tryCatch.setError(e3), o3.setLastError(10);
          }
        }, napi_create_external: function(e2, r2, t3, n4, o3) {
          var s3;
          if (!e2) return 1;
          var i3 = d.envStore.get(e2);
          if (i3.checkGCAccess(), !i3.tryCatch.isEmpty()) return i3.setLastError(10);
          if (!i3.canCallIntoJs()) return i3.setLastError(i3.moduleApiVersion >= 10 ? 23 : 10);
          i3.clearLastError();
          try {
            if (!o3) return i3.setLastError(1);
            if (!d.feature.supportFinalizer && t3) throw d.createNotSupportWeakRefError("napi_create_external", 'Parameter "finalize_cb" must be 0(NULL)');
            var u3 = d.getCurrentScope().addExternal(r2);
            return t3 && d.createReferenceWithFinalizer(i3, u3.id, 0, 0, t3, r2, n4), o3 >>>= 0, s3 = u3.id, new DataView(a2.buffer).setUint32(o3, s3, true), i3.clearLastError();
          } catch (e3) {
            return i3.tryCatch.setError(e3), i3.setLastError(10);
          }
        }, napi_create_external_arraybuffer: function(e2, r2, t3, n4, o3, s3) {
          var i3;
          if (!e2) return 1;
          var u3 = d.envStore.get(e2);
          if (u3.checkGCAccess(), !u3.tryCatch.isEmpty()) return u3.setLastError(10);
          if (!u3.canCallIntoJs()) return u3.setLastError(u3.moduleApiVersion >= 10 ? 23 : 10);
          u3.clearLastError();
          try {
            if (!s3) return u3.setLastError(1);
            if (t3 >>>= 0, s3 >>>= 0, t3 >>>= 0, (r2 >>>= 0) || (t3 = 0), r2 + t3 > a2.buffer.byteLength) throw new RangeError("Memory out of range");
            if (!d.feature.supportFinalizer && n4) throw d.createNotSupportWeakRefError("napi_create_external_arraybuffer", 'Parameter "finalize_cb" must be 0(NULL)');
            var f2 = new ArrayBuffer(t3);
            if (0 === t3) try {
              new (0, d.feature.MessageChannel)().port1.postMessage(f2, [f2]);
            } catch (e3) {
            }
            else new Uint8Array(f2).set(new Uint8Array(a2.buffer).subarray(r2, r2 + t3)), J.table.set(f2, { address: r2, ownership: 1, runtimeAllocated: 0 });
            var c2 = d.addToCurrentScope(f2);
            if (n4) {
              var l2 = oe(e2, c2.id, r2, n4, o3, 0);
              if (10 === l2) {
                var v2 = u3.tryCatch.extractException();
                throw u3.clearLastError(), v2;
              }
              if (0 !== l2) return u3.setLastError(l2);
            }
            return i3 = c2.id, new DataView(a2.buffer).setUint32(s3, i3, true), u3.getReturnStatus();
          } catch (v3) {
            return u3.tryCatch.setError(v3), u3.setLastError(10);
          }
        }, napi_create_external_buffer: function(e2, r2, t3, n4, a3, o3) {
          return ie(e2, -2, t3, r2, n4, a3, o3);
        }, napi_create_object: function(e2, r2) {
          if (!e2) return 1;
          var t3 = d.envStore.get(e2);
          if (t3.checkGCAccess(), !r2) return t3.setLastError(1);
          r2 >>>= 0;
          var n4 = d.addToCurrentScope({}).id;
          return new DataView(a2.buffer).setUint32(r2, n4, true), t3.clearLastError();
        }, napi_create_symbol: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !t3) return n4.setLastError(1);
          t3 >>>= 0;
          var o3 = new DataView(a2.buffer);
          if (r2) {
            var s3 = d.handleStore.get(r2).value;
            if ("string" != typeof s3) return n4.setLastError(3);
            var i3 = d.addToCurrentScope(Symbol(s3)).id;
            o3.setUint32(t3, i3, true);
          } else {
            var u3 = d.addToCurrentScope(Symbol()).id;
            o3.setUint32(t3, u3, true);
          }
          return n4.clearLastError();
        }, napi_create_typedarray: function(e2, r2, t3, n4, o3, s3) {
          var i3;
          if (!e2) return 1;
          var u3 = d.envStore.get(e2);
          if (u3.checkGCAccess(), !u3.tryCatch.isEmpty()) return u3.setLastError(10);
          if (!u3.canCallIntoJs()) return u3.setLastError(u3.moduleApiVersion >= 10 ? 23 : 10);
          u3.clearLastError();
          try {
            if (!n4) return u3.setLastError(1);
            if (!s3) return u3.setLastError(1);
            var f2 = d.handleStore.get(n4).value;
            o3 >>>= 0, t3 >>>= 0;
            var c2 = function(e3, r3, t4, n5, o4, u4) {
              var f3, c3;
              if ((o4 >>>= 0, u4 >>>= 0, t4 > 1) && o4 % t4 !== 0) return (c3 = new RangeError("start offset of ".concat(null !== (f3 = r3.name) && void 0 !== f3 ? f3 : "", " should be a multiple of ").concat(t4))).code = "ERR_NAPI_INVALID_TYPEDARRAY_ALIGNMENT", e3.tryCatch.setError(c3), e3.setLastError(9);
              if (u4 * t4 + o4 > n5.byteLength) return (c3 = new RangeError("Invalid typed array length")).code = "ERR_NAPI_INVALID_TYPEDARRAY_LENGTH", e3.tryCatch.setError(c3), e3.setLastError(9);
              var l2 = new r3(n5, o4, u4);
              return n5 === a2.buffer && (J.wasmMemoryViewTable.has(l2) || J.wasmMemoryViewTable.set(l2, { Ctor: r3, address: o4, length: u4, ownership: 1, runtimeAllocated: 0 })), s3 >>>= 0, i3 = d.addToCurrentScope(l2).id, new DataView(a2.buffer).setUint32(s3, i3, true), e3.getReturnStatus();
            };
            if (!(f2 instanceof ArrayBuffer || J.isSharedArrayBuffer(f2))) return u3.setLastError(1);
            switch (r2) {
              case 0:
                return c2(u3, Int8Array, 1, f2, o3, t3);
              case 1:
                return c2(u3, Uint8Array, 1, f2, o3, t3);
              case 2:
                return c2(u3, Uint8ClampedArray, 1, f2, o3, t3);
              case 3:
                return c2(u3, Int16Array, 2, f2, o3, t3);
              case 4:
                return c2(u3, Uint16Array, 2, f2, o3, t3);
              case 5:
                return c2(u3, Int32Array, 4, f2, o3, t3);
              case 6:
                return c2(u3, Uint32Array, 4, f2, o3, t3);
              case 7:
                return c2(u3, Float32Array, 4, f2, o3, t3);
              case 8:
                return c2(u3, Float64Array, 8, f2, o3, t3);
              case 9:
                return c2(u3, BigInt64Array, 8, f2, o3, t3);
              case 10:
                return c2(u3, BigUint64Array, 8, f2, o3, t3);
              case 11:
                return "function" != typeof Float16Array ? u3.setLastError(1) : c2(u3, Float16Array, 2, f2, o3, t3);
              default:
                return u3.setLastError(1);
            }
          } catch (e3) {
            return u3.tryCatch.setError(e3), u3.setLastError(10);
          }
        }, node_api_create_buffer_from_arraybuffer: function(e2, r2, t3, n4, o3) {
          var s3;
          if (!e2) return 1;
          var i3 = d.envStore.get(e2);
          if (i3.checkGCAccess(), !i3.tryCatch.isEmpty()) return i3.setLastError(10);
          if (!i3.canCallIntoJs()) return i3.setLastError(i3.moduleApiVersion >= 10 ? 23 : 10);
          i3.clearLastError();
          try {
            if (!r2) return i3.setLastError(1);
            if (!o3) return i3.setLastError(1);
            t3 >>>= 0, n4 >>>= 0, t3 >>>= 0, n4 >>>= 0;
            var u3 = d.handleStore.get(r2);
            if (!u3.isArrayBuffer()) return i3.setLastError(1);
            var f2 = u3.value;
            if (n4 + t3 > f2.byteLength) {
              var c2 = new RangeError("The byte offset + length is out of range");
              throw c2.code = "ERR_OUT_OF_RANGE", c2;
            }
            var l2 = d.feature.Buffer;
            if (!l2) throw d.createNotSupportBufferError("node_api_create_buffer_from_arraybuffer", "");
            var v2 = l2.from(f2, t3, n4);
            return f2 === a2.buffer && (J.wasmMemoryViewTable.has(v2) || J.wasmMemoryViewTable.set(v2, { Ctor: l2, address: t3, length: n4, ownership: 1, runtimeAllocated: 0 })), o3 >>>= 0, s3 = d.addToCurrentScope(v2).id, new DataView(a2.buffer).setUint32(o3, s3, true), i3.getReturnStatus();
          } catch (c3) {
            return i3.tryCatch.setError(c3), i3.setLastError(10);
          }
        }, node_api_create_external_sharedarraybuffer: function(e2, r2, t3, n4, o3, s3) {
          var i3;
          if (!e2) return 1;
          var u3 = d.envStore.get(e2);
          if (u3.checkGCAccess(), !u3.tryCatch.isEmpty()) return u3.setLastError(10);
          if (!u3.canCallIntoJs()) return u3.setLastError(u3.moduleApiVersion >= 10 ? 23 : 10);
          u3.clearLastError();
          try {
            if (!s3) return u3.setLastError(1);
            if (t3 >>>= 0, s3 >>>= 0, t3 >>>= 0, (r2 >>>= 0) || (t3 = 0), r2 + t3 > a2.buffer.byteLength) throw new RangeError("Memory out of range");
            if (!P.registry && n4) throw d.createNotSupportWeakRefError("node_api_create_external_sharedarraybuffer", 'Parameter "finalize_cb" must be 0(NULL)');
            var f2 = new SharedArrayBuffer(t3);
            if (0 !== t3) new Uint8Array(f2).set(new Uint8Array(a2.buffer).subarray(r2, r2 + t3)), J.table.set(f2, { address: r2, ownership: 1, runtimeAllocated: 0 });
            if (i3 = d.addToCurrentScope(f2).id, n4) {
              n4 >>>= 0, o3 >>>= 0;
              var c2 = P.allocMeta(r2, t3, n4, r2, o3);
              P.handleTable.set(f2, c2), P.registry.register(f2, c2);
            }
            return new DataView(a2.buffer).setUint32(s3, i3, true), u3.getReturnStatus();
          } catch (e3) {
            return u3.tryCatch.setError(e3), u3.setLastError(10);
          }
        }, node_api_create_object_with_properties: function(e2, r2, t3, n4, o3, s3) {
          if (!e2) return 1;
          var i3 = d.envStore.get(e2);
          if (i3.checkGCAccess(), !s3) return i3.setLastError(1);
          if (o3 >>>= 0, (o3 >>>= 0) > 0) {
            if (!t3) return i3.setLastError(1);
            if (!n4) return i3.setLastError(1);
          }
          var u3 = r2 ? d.handleStore.get(r2).value : null, f2 = {};
          t3 >>>= 0, n4 >>>= 0;
          for (var c2, l2 = new DataView(a2.buffer), v2 = 0; v2 < o3; v2++) {
            var p2 = d.handleStore.get(l2.getUint32(t3 + 4 * v2, true)).value;
            if ("string" != typeof p2 && "symbol" != typeof p2) return i3.setLastError(4);
            f2[p2] = { value: d.handleStore.get(l2.getUint32(n4 + 4 * v2, true)).value, writable: true, enumerable: true, configurable: true };
          }
          try {
            c2 = Object.defineProperties(Object.create(u3), f2);
          } catch (e3) {
            return i3.setLastError(9);
          }
          var g2 = d.addToCurrentScope(c2).id;
          return s3 >>>= 0, l2.setUint32(s3, g2, true), i3.clearLastError();
        }, node_api_create_sharedarraybuffer: function(e2, r2, t3, n4) {
          var o3;
          if (!e2) return 1;
          var s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !s3.tryCatch.isEmpty()) return s3.setLastError(10);
          if (!s3.canCallIntoJs()) return s3.setLastError(s3.moduleApiVersion >= 10 ? 23 : 10);
          s3.clearLastError();
          try {
            if (!n4) return s3.setLastError(1);
            n4 >>>= 0;
            var i3 = de(r2, t3, true);
            return o3 = d.addToCurrentScope(i3).id, new DataView(a2.buffer).setUint32(n4, o3, true), s3.getReturnStatus();
          } catch (e3) {
            return s3.tryCatch.setError(e3), s3.setLastError(10);
          }
        }, node_api_symbol_for: function(e2, r2, t3, n4) {
          if (!e2) return 1;
          var o3 = d.envStore.get(e2);
          if (o3.checkGCAccess(), !n4) return o3.setLastError(1);
          r2 >>>= 0, n4 >>>= 0;
          var s3 = -1 === (t3 >>>= 0) || 4294967295 === t3, i3 = t3 >>> 0;
          if (0 !== t3 && !r2) return o3.setLastError(1);
          if (!(s3 || i3 <= 2147483647)) return o3.setLastError(1);
          var u3 = H.UTF8ToString(r2, t3), f2 = d.addToCurrentScope(Symbol.for(u3)).id;
          return new DataView(a2.buffer).setUint32(n4, f2, true), o3.clearLastError();
        } });
        var pe = Object.freeze({ __proto__: null, napi_get_boolean: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !t3) return n4.setLastError(1);
          t3 >>>= 0;
          var o3 = 0 === r2 ? 3 : 4;
          return new DataView(a2.buffer).setUint32(t3, o3, true), n4.clearLastError();
        }, napi_get_global: function(e2, r2) {
          if (!e2) return 1;
          var t3 = d.envStore.get(e2);
          return t3.checkGCAccess(), r2 ? (r2 >>>= 0, new DataView(a2.buffer).setUint32(r2, 5, true), t3.clearLastError()) : t3.setLastError(1);
        }, napi_get_null: function(e2, r2) {
          if (!e2) return 1;
          var t3 = d.envStore.get(e2);
          return t3.checkGCAccess(), r2 ? (r2 >>>= 0, new DataView(a2.buffer).setUint32(r2, 2, true), t3.clearLastError()) : t3.setLastError(1);
        }, napi_get_undefined: function(e2, r2) {
          if (!e2) return 1;
          var t3 = d.envStore.get(e2);
          return t3.checkGCAccess(), r2 ? (r2 >>>= 0, new DataView(a2.buffer).setUint32(r2, 1, true), t3.clearLastError()) : t3.setLastError(1);
        } });
        var ge = Object.freeze({ __proto__: null, napi_get_instance_data: function(e2, r2) {
          if (!e2) return 1;
          var t3 = d.envStore.get(e2);
          if (!r2) return t3.setLastError(1);
          r2 >>>= 0;
          var n4 = t3.getInstanceData();
          return new DataView(a2.buffer).setUint32(r2, n4, true), t3.clearLastError();
        }, napi_set_instance_data: function(e2, r2, t3, n4) {
          if (!e2) return 1;
          var a3 = d.envStore.get(e2);
          return r2 >>>= 0, t3 >>>= 0, n4 >>>= 0, a3.setInstanceData(r2, t3, n4), a3.clearLastError();
        } });
        var ye = Object.freeze({ __proto__: null, _emnapi_get_last_error_info: function(e2, r2, t3, n4) {
          r2 >>>= 0, t3 >>>= 0, n4 >>>= 0;
          var o3 = d.envStore.get(e2).lastError, s3 = o3.errorCode, i3 = o3.engineErrorCode >>> 0, u3 = o3.engineReserved;
          u3 >>>= 0;
          var f2 = new DataView(a2.buffer);
          f2.setInt32(r2, s3, true), f2.setUint32(t3, i3, true), f2.setUint32(n4, u3, true);
        }, napi_create_error: function(e2, r2, t3, n4) {
          if (!e2) return 1;
          var o3 = d.envStore.get(e2);
          if (o3.checkGCAccess(), !t3) return o3.setLastError(1);
          if (!n4) return o3.setLastError(1);
          var s3 = d.handleStore.get(t3).value;
          if ("string" != typeof s3) return o3.setLastError(3);
          var i3 = new Error(s3);
          if (r2) {
            var u3 = d.handleStore.get(r2).value;
            if ("string" != typeof u3) return o3.setLastError(3);
            i3.code = u3;
          }
          n4 >>>= 0;
          var f2 = d.addToCurrentScope(i3).id;
          return new DataView(a2.buffer).setUint32(n4, f2, true), o3.clearLastError();
        }, napi_create_range_error: function(e2, r2, t3, n4) {
          if (!e2) return 1;
          var o3 = d.envStore.get(e2);
          if (o3.checkGCAccess(), !t3) return o3.setLastError(1);
          if (!n4) return o3.setLastError(1);
          var s3 = d.handleStore.get(t3).value;
          if ("string" != typeof s3) return o3.setLastError(3);
          var i3 = new RangeError(s3);
          if (r2) {
            var u3 = d.handleStore.get(r2).value;
            if ("string" != typeof u3) return o3.setLastError(3);
            i3.code = u3;
          }
          n4 >>>= 0;
          var f2 = d.addToCurrentScope(i3).id;
          return new DataView(a2.buffer).setUint32(n4, f2, true), o3.clearLastError();
        }, napi_create_type_error: function(e2, r2, t3, n4) {
          if (!e2) return 1;
          var o3 = d.envStore.get(e2);
          if (o3.checkGCAccess(), !t3) return o3.setLastError(1);
          if (!n4) return o3.setLastError(1);
          var s3 = d.handleStore.get(t3).value;
          if ("string" != typeof s3) return o3.setLastError(3);
          var i3 = new TypeError(s3);
          if (r2) {
            var u3 = d.handleStore.get(r2).value;
            if ("string" != typeof u3) return o3.setLastError(3);
            i3.code = u3;
          }
          n4 >>>= 0;
          var f2 = d.addToCurrentScope(i3).id;
          return new DataView(a2.buffer).setUint32(n4, f2, true), o3.clearLastError();
        }, napi_fatal_error: function(e2, r2, t3, n4) {
          e2 >>>= 0, r2 >>>= 0, t3 >>>= 0, n4 >>>= 0;
          var a3 = H.UTF8ToString(e2, r2), o3 = H.UTF8ToString(t3, n4);
          v ? v.napi.fatalError(a3, o3) : l("FATAL ERROR: " + a3 + " " + o3);
        }, napi_fatal_exception: function(e2, r2) {
          if (!e2) return 1;
          var t3 = d.envStore.get(e2);
          if (t3.checkGCAccess(), !t3.tryCatch.isEmpty()) return t3.setLastError(10);
          if (!t3.canCallIntoJs()) return t3.setLastError(t3.moduleApiVersion >= 10 ? 23 : 10);
          t3.clearLastError();
          try {
            if (!r2) return t3.setLastError(1);
            var n4 = t3.ctx.handleStore.get(r2);
            try {
              t3.triggerFatalException(n4.value);
            } catch (e3) {
              return t3.setLastError(9);
            }
            return t3.clearLastError();
          } catch (r3) {
            return t3.tryCatch.setError(r3), t3.setLastError(10);
          }
        }, napi_get_and_clear_last_exception: function(e2, r2) {
          if (!e2) return 1;
          var t3 = d.envStore.get(e2);
          if (t3.checkGCAccess(), !r2) return t3.setLastError(1);
          r2 >>>= 0;
          var n4 = new DataView(a2.buffer);
          if (!t3.tryCatch.hasCaught()) return n4.setUint32(r2, 1, true), t3.clearLastError();
          var o3 = t3.tryCatch.exception(), s3 = t3.ensureHandleId(o3);
          return n4.setUint32(r2, s3, true), t3.tryCatch.reset(), t3.clearLastError();
        }, napi_is_exception_pending: function(e2, r2) {
          if (!e2) return 1;
          var t3 = d.envStore.get(e2);
          if (t3.checkGCAccess(), !r2) return t3.setLastError(1);
          var n4 = t3.tryCatch.hasCaught();
          return r2 >>>= 0, new DataView(a2.buffer).setInt8(r2, n4 ? 1 : 0, true), t3.clearLastError();
        }, napi_throw: function(e2, r2) {
          if (!e2) return 1;
          var t3 = d.envStore.get(e2);
          if (t3.checkGCAccess(), !t3.tryCatch.isEmpty()) return t3.setLastError(10);
          if (!t3.canCallIntoJs()) return t3.setLastError(t3.moduleApiVersion >= 10 ? 23 : 10);
          t3.clearLastError();
          try {
            return r2 ? (t3.tryCatch.setError(d.handleStore.get(r2).value), t3.clearLastError()) : t3.setLastError(1);
          } catch (e3) {
            return t3.tryCatch.setError(e3), t3.setLastError(10);
          }
        }, napi_throw_error: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !n4.tryCatch.isEmpty()) return n4.setLastError(10);
          if (!n4.canCallIntoJs()) return n4.setLastError(n4.moduleApiVersion >= 10 ? 23 : 10);
          n4.clearLastError();
          try {
            if (!t3) return n4.setLastError(1);
            r2 >>>= 0, t3 >>>= 0;
            var a3 = new Error(H.UTF8ToString(t3, -1));
            return r2 && (a3.code = H.UTF8ToString(r2, -1)), n4.tryCatch.setError(a3), n4.clearLastError();
          } catch (e3) {
            return n4.tryCatch.setError(e3), n4.setLastError(10);
          }
        }, napi_throw_range_error: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !n4.tryCatch.isEmpty()) return n4.setLastError(10);
          if (!n4.canCallIntoJs()) return n4.setLastError(n4.moduleApiVersion >= 10 ? 23 : 10);
          n4.clearLastError();
          try {
            if (!t3) return n4.setLastError(1);
            r2 >>>= 0, t3 >>>= 0;
            var a3 = new RangeError(H.UTF8ToString(t3, -1));
            return r2 && (a3.code = H.UTF8ToString(r2, -1)), n4.tryCatch.setError(a3), n4.clearLastError();
          } catch (e3) {
            return n4.tryCatch.setError(e3), n4.setLastError(10);
          }
        }, napi_throw_type_error: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !n4.tryCatch.isEmpty()) return n4.setLastError(10);
          if (!n4.canCallIntoJs()) return n4.setLastError(n4.moduleApiVersion >= 10 ? 23 : 10);
          n4.clearLastError();
          try {
            if (!t3) return n4.setLastError(1);
            r2 >>>= 0, t3 >>>= 0;
            var a3 = new TypeError(H.UTF8ToString(t3, -1));
            return r2 && (a3.code = H.UTF8ToString(r2, -1)), n4.tryCatch.setError(a3), n4.clearLastError();
          } catch (e3) {
            return n4.tryCatch.setError(e3), n4.setLastError(10);
          }
        }, node_api_create_syntax_error: function(e2, r2, t3, n4) {
          if (!e2) return 1;
          var o3 = d.envStore.get(e2);
          if (o3.checkGCAccess(), !t3) return o3.setLastError(1);
          if (!n4) return o3.setLastError(1);
          var s3 = d.handleStore.get(t3).value;
          if ("string" != typeof s3) return o3.setLastError(3);
          var i3 = new SyntaxError(s3);
          if (r2) {
            var u3 = d.handleStore.get(r2).value;
            if ("string" != typeof u3) return o3.setLastError(3);
            i3.code = u3;
          }
          n4 >>>= 0;
          var f2 = d.addToCurrentScope(i3).id;
          return new DataView(a2.buffer).setUint32(n4, f2, true), o3.clearLastError();
        }, node_api_throw_syntax_error: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !n4.tryCatch.isEmpty()) return n4.setLastError(10);
          if (!n4.canCallIntoJs()) return n4.setLastError(n4.moduleApiVersion >= 10 ? 23 : 10);
          n4.clearLastError();
          try {
            if (!t3) return n4.setLastError(1);
            r2 >>>= 0, t3 >>>= 0;
            var a3 = new SyntaxError(H.UTF8ToString(t3, -1));
            return r2 && (a3.code = H.UTF8ToString(r2, -1)), n4.tryCatch.setError(a3), n4.clearLastError();
          } catch (e3) {
            return n4.tryCatch.setError(e3), n4.setLastError(10);
          }
        } });
        function he(e2, r2, t3, n4, o3, s3) {
          t3 >>>= 0;
          var i3 = d.envStore.get(e2), u3 = re(i3, r2, t3, n4, o3);
          if (0 !== u3.status) return i3.setLastError(u3.status);
          var f2 = u3.f;
          s3 >>>= 0;
          var c2 = d.addToCurrentScope(f2).id;
          return new DataView(a2.buffer).setUint32(s3, c2, true), i3.getReturnStatus();
        }
        var _e = Object.freeze({ __proto__: null, _emnapi_create_function: he, napi_call_function: function(e2, r2, t3, n4, o3, s3) {
          var i3, u3 = 0;
          if (!e2) return 1;
          var f2 = d.envStore.get(e2);
          if (f2.checkGCAccess(), !f2.tryCatch.isEmpty()) return f2.setLastError(10);
          if (!f2.canCallIntoJs()) return f2.setLastError(f2.moduleApiVersion >= 10 ? 23 : 10);
          f2.clearLastError();
          try {
            if (!r2) return f2.setLastError(1);
            if (n4 >>>= 0, o3 >>>= 0, s3 >>>= 0, (n4 >>>= 0) > 0 && !o3) return f2.setLastError(1);
            var c2 = d.handleStore.get(r2).value;
            if (!t3) return f2.setLastError(1);
            var l2 = d.handleStore.get(t3).value;
            if ("function" != typeof l2) return f2.setLastError(1);
            for (var v2 = [], p2 = new DataView(a2.buffer); u3 < n4; u3++) {
              var g2 = p2.getUint32(o3 + 4 * u3, true);
              v2.push(d.handleStore.get(g2).value);
            }
            var y2 = l2.apply(c2, v2);
            return s3 && (i3 = f2.ensureHandleId(y2), p2.setUint32(s3, i3, true)), f2.clearLastError();
          } catch (e3) {
            return f2.tryCatch.setError(e3), f2.setLastError(10);
          }
        }, napi_create_function: function(e2, r2, t3, n4, a3, o3) {
          if (!e2) return 1;
          var s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !s3.tryCatch.isEmpty()) return s3.setLastError(10);
          if (!s3.canCallIntoJs()) return s3.setLastError(s3.moduleApiVersion >= 10 ? 23 : 10);
          s3.clearLastError();
          try {
            return o3 && n4 ? he(e2, r2, t3, n4, a3, o3) : s3.setLastError(1);
          } catch (e3) {
            return s3.tryCatch.setError(e3), s3.setLastError(10);
          }
        }, napi_get_cb_info: function(e2, r2, t3, n4, o3, s3) {
          if (!e2) return 1;
          var i3 = d.envStore.get(e2);
          if (!r2) return i3.setLastError(1);
          var u3 = d.scopeStore.get(r2).callbackInfo;
          t3 >>>= 0, n4 >>>= 0;
          var f2 = new DataView(a2.buffer);
          if (n4) {
            if (!t3) return i3.setLastError(1);
            var c2 = f2.getUint32(t3, true);
            c2 >>>= 0;
            for (var l2 = u3.args.length, v2 = c2 < l2 ? c2 : l2, p2 = 0; p2 < v2; p2++) {
              var g2 = i3.ensureHandleId(u3.args[p2]);
              f2.setUint32(n4 + 4 * p2, g2, true);
            }
            if (p2 < c2) for (; p2 < c2; p2++) f2.setUint32(n4 + 4 * p2, 1, true);
          }
          if (t3 && f2.setUint32(t3, u3.args.length, true), o3) {
            o3 >>>= 0;
            var y2 = i3.ensureHandleId(u3.thiz);
            f2.setUint32(o3, y2, true);
          }
          return s3 && (s3 >>>= 0, f2.setUint32(s3, u3.data, true)), i3.clearLastError();
        }, napi_get_new_target: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !r2) return n4.setLastError(1);
          if (!t3) return n4.setLastError(1);
          t3 >>>= 0;
          var o3 = d.scopeStore.get(r2).callbackInfo, s3 = o3.thiz, i3 = o3.fn, u3 = null == s3 || null == s3.constructor ? 0 : s3 instanceof i3 ? n4.ensureHandleId(s3.constructor) : 0;
          return new DataView(a2.buffer).setUint32(t3, u3, true), n4.clearLastError();
        }, napi_new_instance: function(e2, r2, t3, n4, o3) {
          var s3, i3;
          if (!e2) return 1;
          var u3 = d.envStore.get(e2);
          if (u3.checkGCAccess(), !u3.tryCatch.isEmpty()) return u3.setLastError(10);
          if (!u3.canCallIntoJs()) return u3.setLastError(u3.moduleApiVersion >= 10 ? 23 : 10);
          u3.clearLastError();
          try {
            if (!r2) return u3.setLastError(1);
            if (t3 >>>= 0, n4 >>>= 0, o3 >>>= 0, (t3 >>>= 0) > 0 && !n4) return u3.setLastError(1);
            if (!o3) return u3.setLastError(1);
            var f2 = d.handleStore.get(r2).value;
            if ("function" != typeof f2) return u3.setLastError(1);
            var c2 = void 0, l2 = new DataView(a2.buffer);
            if (d.feature.supportReflect) {
              var v2 = Array(t3);
              for (s3 = 0; s3 < t3; s3++) {
                var p2 = l2.getUint32(n4 + 4 * s3, true);
                v2[s3] = d.handleStore.get(p2).value;
              }
              c2 = Reflect.construct(f2, v2, f2);
            } else {
              var g2 = Array(t3 + 1);
              for (g2[0] = void 0, s3 = 0; s3 < t3; s3++) {
                p2 = l2.getUint32(n4 + 4 * s3, true);
                g2[s3 + 1] = d.handleStore.get(p2).value;
              }
              c2 = new (f2.bind.apply(f2, g2))();
            }
            return o3 && (i3 = u3.ensureHandleId(c2), l2.setUint32(o3, i3, true)), u3.getReturnStatus();
          } catch (e3) {
            return u3.tryCatch.setError(e3), u3.setLastError(10);
          }
        } });
        var Ee = Object.freeze({ __proto__: null, _emnapi_env_ref: function(e2) {
          d.envStore.get(e2).ref();
        }, _emnapi_env_unref: function(e2) {
          d.envStore.get(e2).unref();
        }, napi_add_env_cleanup_hook: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          return r2 ? (r2 >>>= 0, t3 >>>= 0, d.addCleanupHook(n4, r2, t3), 0) : n4.setLastError(1);
        }, napi_close_escapable_handle_scope: function(e2, r2) {
          if (!e2) return 1;
          var t3 = d.envStore.get(e2);
          return t3.checkGCAccess(), r2 ? 0 === t3.openHandleScopes ? 13 : (d.closeScope(t3), t3.clearLastError()) : t3.setLastError(1);
        }, napi_close_handle_scope: function(e2, r2) {
          if (!e2) return 1;
          var t3 = d.envStore.get(e2);
          return t3.checkGCAccess(), r2 ? 0 === t3.openHandleScopes ? 13 : (d.closeScope(t3), t3.clearLastError()) : t3.setLastError(1);
        }, napi_create_reference: function(e2, r2, t3, n4) {
          if (!e2) return 1;
          var o3 = d.envStore.get(e2);
          if (o3.checkGCAccess(), !r2) return o3.setLastError(1);
          if (!n4) return o3.setLastError(1);
          var s3 = d.handleStore.get(r2);
          if (o3.moduleApiVersion < 10 && !(s3.isObject() || s3.isFunction() || s3.isSymbol())) return o3.setLastError(1);
          var i3 = d.createReference(o3, s3.id, t3 >>> 0, 1);
          return n4 >>>= 0, new DataView(a2.buffer).setUint32(n4, i3.id, true), o3.clearLastError();
        }, napi_delete_reference: function(e2, r2) {
          if (!e2) return 1;
          var t3 = d.envStore.get(e2);
          return r2 ? (d.refStore.get(r2).dispose(), t3.clearLastError()) : t3.setLastError(1);
        }, napi_escape_handle: function(e2, r2, t3, n4) {
          if (!e2) return 1;
          var o3 = d.envStore.get(e2);
          if (o3.checkGCAccess(), !r2) return o3.setLastError(1);
          if (!t3) return o3.setLastError(1);
          if (!n4) return o3.setLastError(1);
          var s3 = d.scopeStore.get(r2);
          if (!s3.escapeCalled()) {
            t3 >>>= 0, n4 >>>= 0;
            var i3 = s3.escape(t3), u3 = i3 ? i3.id : 0;
            return new DataView(a2.buffer).setUint32(n4, u3, true), o3.clearLastError();
          }
          return o3.setLastError(12);
        }, napi_get_reference_value: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !r2) return n4.setLastError(1);
          if (!t3) return n4.setLastError(1);
          var o3 = d.refStore.get(r2).get(n4);
          return t3 >>>= 0, new DataView(a2.buffer).setUint32(t3, o3, true), n4.clearLastError();
        }, napi_open_escapable_handle_scope: function(e2, r2) {
          if (!e2) return 1;
          var t3 = d.envStore.get(e2);
          if (t3.checkGCAccess(), !r2) return t3.setLastError(1);
          var n4 = d.openScope(t3);
          return r2 >>>= 0, new DataView(a2.buffer).setUint32(r2, n4.id, true), t3.clearLastError();
        }, napi_open_handle_scope: function(e2, r2) {
          if (!e2) return 1;
          var t3 = d.envStore.get(e2);
          if (t3.checkGCAccess(), !r2) return t3.setLastError(1);
          var n4 = d.openScope(t3);
          return r2 >>>= 0, new DataView(a2.buffer).setUint32(r2, n4.id, true), t3.clearLastError();
        }, napi_reference_ref: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !r2) return n4.setLastError(1);
          var o3 = d.refStore.get(r2).ref();
          return t3 && (t3 >>>= 0, new DataView(a2.buffer).setUint32(t3, o3, true)), n4.clearLastError();
        }, napi_reference_unref: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !r2) return n4.setLastError(1);
          var o3 = d.refStore.get(r2);
          if (0 === o3.refcount()) return n4.setLastError(9);
          var s3 = o3.unref();
          return t3 && (t3 >>>= 0, new DataView(a2.buffer).setUint32(t3, s3, true)), n4.clearLastError();
        }, napi_remove_env_cleanup_hook: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          return r2 ? (r2 >>>= 0, t3 >>>= 0, d.removeCleanupHook(n4, r2, t3), 0) : n4.setLastError(1);
        } });
        var we = Object.freeze({ __proto__: null, _emnapi_get_filename: function(e2, r2, t3) {
          var n4 = d.envStore.get(e2).filename;
          return r2 ? H.stringToUTF8(n4, r2, t3) : H.lengthBytesUTF8(n4);
        } });
        var Le = Object.freeze({ __proto__: null, napi_create_promise: function(e2, r2, t3) {
          var n4, o3;
          if (!e2) return 1;
          var s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !s3.tryCatch.isEmpty()) return s3.setLastError(10);
          if (!s3.canCallIntoJs()) return s3.setLastError(s3.moduleApiVersion >= 10 ? 23 : 10);
          s3.clearLastError();
          try {
            if (!r2) return s3.setLastError(1);
            if (!t3) return s3.setLastError(1);
            var i3 = new DataView(a2.buffer), u3 = new Promise(function(e3, t4) {
              var a3 = d.createDeferred({ resolve: e3, reject: t4 });
              n4 = a3.id, r2 >>>= 0, i3.setUint32(r2, n4, true);
            });
            return t3 >>>= 0, o3 = d.addToCurrentScope(u3).id, i3.setUint32(t3, o3, true), s3.getReturnStatus();
          } catch (e3) {
            return s3.tryCatch.setError(e3), s3.setLastError(10);
          }
        }, napi_is_promise: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !r2) return n4.setLastError(1);
          if (!t3) return n4.setLastError(1);
          t3 >>>= 0;
          var o3 = d.handleStore.get(r2).isPromise() ? 1 : 0;
          return new DataView(a2.buffer).setInt8(t3, o3, true), n4.clearLastError();
        }, napi_reject_deferred: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !n4.tryCatch.isEmpty()) return n4.setLastError(10);
          if (!n4.canCallIntoJs()) return n4.setLastError(n4.moduleApiVersion >= 10 ? 23 : 10);
          n4.clearLastError();
          try {
            return r2 && t3 ? (d.deferredStore.get(r2).reject(d.handleStore.get(t3).value), n4.getReturnStatus()) : n4.setLastError(1);
          } catch (e3) {
            return n4.tryCatch.setError(e3), n4.setLastError(10);
          }
        }, napi_resolve_deferred: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !n4.tryCatch.isEmpty()) return n4.setLastError(10);
          if (!n4.canCallIntoJs()) return n4.setLastError(n4.moduleApiVersion >= 10 ? 23 : 10);
          n4.clearLastError();
          try {
            return r2 && t3 ? (d.deferredStore.get(r2).resolve(d.handleStore.get(t3).value), n4.getReturnStatus()) : n4.setLastError(1);
          } catch (e3) {
            return n4.tryCatch.setError(e3), n4.setLastError(10);
          }
        } });
        function me(e2, r2, t3, n4, o3, s3) {
          var i3;
          if (!e2) return 1;
          var u3 = d.envStore.get(e2);
          if (u3.checkGCAccess(), !u3.tryCatch.isEmpty()) return u3.setLastError(10);
          if (!u3.canCallIntoJs()) return u3.setLastError(u3.moduleApiVersion >= 10 ? 23 : 10);
          u3.clearLastError();
          try {
            if (!s3) return u3.setLastError(1);
            if (!r2) return u3.setLastError(1);
            var f2 = d.handleStore.get(r2);
            if (null == f2.value) throw new TypeError("Cannot convert undefined or null to object");
            var c2 = void 0;
            try {
              c2 = f2.isObject() || f2.isFunction() ? f2.value : Object(f2.value);
            } catch (e3) {
              return u3.setLastError(2);
            }
            if (0 !== t3 && 1 !== t3) return u3.setLastError(1);
            if (0 !== o3 && 1 !== o3) return u3.setLastError(1);
            var l2 = [], v2 = void 0, p2 = void 0, g2 = void 0, y2 = true, h2 = /^(0|[1-9][0-9]*)$/;
            do {
              for (v2 = Object.getOwnPropertyNames(c2), p2 = Object.getOwnPropertySymbols(c2), g2 = 0; g2 < v2.length; g2++) l2.push({ name: h2.test(v2[g2]) ? Number(v2[g2]) : v2[g2], desc: Object.getOwnPropertyDescriptor(c2, v2[g2]), own: y2 });
              for (g2 = 0; g2 < p2.length; g2++) l2.push({ name: p2[g2], desc: Object.getOwnPropertyDescriptor(c2, p2[g2]), own: y2 });
              if (1 === t3) break;
              c2 = Object.getPrototypeOf(c2), y2 = false;
            } while (c2);
            var _2 = [], E2 = function(e3, r3, t4, n5) {
              if (-1 === e3.indexOf(r3)) {
                if (0 === n5) e3.push(r3);
                else if (1 === n5) {
                  var a3 = "number" == typeof r3 ? String(r3) : r3;
                  "string" == typeof a3 && 8 & t4 || e3.push(a3);
                }
              }
            };
            for (g2 = 0; g2 < l2.length; g2++) {
              var w2 = l2[g2], L2 = w2.name, m2 = w2.desc;
              if (0 === n4) E2(_2, L2, n4, o3);
              else {
                if (8 & n4 && "string" == typeof L2) continue;
                if (16 & n4 && "symbol" == typeof L2) continue;
                var b2 = true;
                switch (7 & n4) {
                  case 1:
                    b2 = Boolean(m2.writable);
                    break;
                  case 2:
                    b2 = Boolean(m2.enumerable);
                    break;
                  case 3:
                    b2 = Boolean(m2.writable && m2.enumerable);
                    break;
                  case 4:
                    b2 = Boolean(m2.configurable);
                    break;
                  case 5:
                    b2 = Boolean(m2.configurable && m2.writable);
                    break;
                  case 6:
                    b2 = Boolean(m2.configurable && m2.enumerable);
                    break;
                  case 7:
                    b2 = Boolean(m2.configurable && m2.enumerable && m2.writable);
                }
                b2 && E2(_2, L2, n4, o3);
              }
            }
            return s3 >>>= 0, i3 = d.addToCurrentScope(_2).id, new DataView(a2.buffer).setUint32(s3, i3, true), u3.getReturnStatus();
          } catch (e3) {
            return u3.tryCatch.setError(e3), u3.setLastError(10);
          }
        }
        var be = Object.freeze({ __proto__: null, napi_define_properties: function(e2, r2, t3, n4) {
          var o3, s3;
          if (!e2) return 1;
          var i3 = d.envStore.get(e2);
          if (i3.checkGCAccess(), !i3.tryCatch.isEmpty()) return i3.setLastError(10);
          if (!i3.canCallIntoJs()) return i3.setLastError(i3.moduleApiVersion >= 10 ? 23 : 10);
          i3.clearLastError();
          try {
            if (n4 >>>= 0, t3 >>>= 0, (t3 >>>= 0) > 0 && !n4) return i3.setLastError(1);
            if (!r2) return i3.setLastError(1);
            var u3 = d.handleStore.get(r2), f2 = u3.value;
            if (!u3.isObject() && !u3.isFunction()) return i3.setLastError(2);
            for (var c2 = void 0, l2 = new DataView(a2.buffer), v2 = 0; v2 < t3; v2++) {
              o3 = n4 + 32 * v2;
              var p2 = l2.getUint32(o3, true), g2 = l2.getUint32(o3 + 4, true), y2 = l2.getUint32(o3 + 8, true), h2 = l2.getUint32(o3 + 12, true), _2 = l2.getUint32(o3 + 16, true), E2 = l2.getUint32(o3 + 20, true);
              s3 = l2.getInt32(o3 + 24, true), s3 >>>= 0;
              var w2 = l2.getUint32(o3 + 28, true);
              if (p2) c2 = H.UTF8ToString(p2, -1);
              else {
                if (!g2) return i3.setLastError(4);
                if ("string" != typeof (c2 = d.handleStore.get(g2).value) && "symbol" != typeof c2) return i3.setLastError(4);
              }
              te(i3, f2, c2, y2, h2, _2, E2, s3, w2);
            }
            return i3.getReturnStatus();
          } catch (e3) {
            return i3.tryCatch.setError(e3), i3.setLastError(10);
          }
        }, napi_delete_element: function(e2, r2, t3, n4) {
          var o3;
          if (!e2) return 1;
          var s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !s3.tryCatch.isEmpty()) return s3.setLastError(10);
          if (!s3.canCallIntoJs()) return s3.setLastError(s3.moduleApiVersion >= 10 ? 23 : 10);
          s3.clearLastError();
          try {
            if (!r2) return s3.setLastError(1);
            var i3 = d.handleStore.get(r2);
            if (!i3.isObject() && !i3.isFunction()) return s3.setLastError(2);
            if (d.feature.supportReflect) o3 = Reflect.deleteProperty(i3.value, t3 >>> 0);
            else try {
              o3 = delete i3.value[t3 >>> 0];
            } catch (e3) {
              o3 = false;
            }
            if (n4) n4 >>>= 0, new DataView(a2.buffer).setInt8(n4, o3 ? 1 : 0, true);
            return s3.getReturnStatus();
          } catch (e3) {
            return s3.tryCatch.setError(e3), s3.setLastError(10);
          }
        }, napi_delete_property: function(e2, r2, t3, n4) {
          var o3;
          if (!e2) return 1;
          var s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !s3.tryCatch.isEmpty()) return s3.setLastError(10);
          if (!s3.canCallIntoJs()) return s3.setLastError(s3.moduleApiVersion >= 10 ? 23 : 10);
          s3.clearLastError();
          try {
            if (!t3) return s3.setLastError(1);
            if (!r2) return s3.setLastError(1);
            var i3 = d.handleStore.get(r2);
            if (!i3.isObject() && !i3.isFunction()) return s3.setLastError(2);
            var u3 = d.handleStore.get(t3).value;
            if (d.feature.supportReflect) o3 = Reflect.deleteProperty(i3.value, u3);
            else try {
              o3 = delete i3.value[u3];
            } catch (e3) {
              o3 = false;
            }
            if (n4) n4 >>>= 0, new DataView(a2.buffer).setInt8(n4, o3 ? 1 : 0, true);
            return s3.getReturnStatus();
          } catch (e3) {
            return s3.tryCatch.setError(e3), s3.setLastError(10);
          }
        }, napi_get_all_property_names: me, napi_get_element: function(e2, r2, t3, n4) {
          var o3;
          if (!e2) return 1;
          var s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !s3.tryCatch.isEmpty()) return s3.setLastError(10);
          if (!s3.canCallIntoJs()) return s3.setLastError(s3.moduleApiVersion >= 10 ? 23 : 10);
          s3.clearLastError();
          try {
            if (!n4) return s3.setLastError(1);
            if (!r2) return s3.setLastError(1);
            var i3 = d.handleStore.get(r2);
            if (null == i3.value) throw new TypeError("Cannot convert undefined or null to object");
            var u3 = void 0;
            try {
              u3 = i3.isObject() || i3.isFunction() ? i3.value : Object(i3.value);
            } catch (e3) {
              return s3.setLastError(2);
            }
            return n4 >>>= 0, o3 = s3.ensureHandleId(u3[t3 >>> 0]), new DataView(a2.buffer).setUint32(n4, o3, true), s3.getReturnStatus();
          } catch (e3) {
            return s3.tryCatch.setError(e3), s3.setLastError(10);
          }
        }, napi_get_named_property: function(e2, r2, t3, n4) {
          var o3;
          if (!e2) return 1;
          var s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !s3.tryCatch.isEmpty()) return s3.setLastError(10);
          if (!s3.canCallIntoJs()) return s3.setLastError(s3.moduleApiVersion >= 10 ? 23 : 10);
          s3.clearLastError();
          try {
            if (!n4) return s3.setLastError(1);
            if (!r2) return s3.setLastError(1);
            if (!t3) return s3.setLastError(1);
            var i3 = d.handleStore.get(r2);
            if (null == i3.value) throw new TypeError("Cannot convert undefined or null to object");
            var u3 = void 0;
            try {
              u3 = i3.isObject() || i3.isFunction() ? i3.value : Object(i3.value);
            } catch (e3) {
              return s3.setLastError(2);
            }
            return t3 >>>= 0, n4 >>>= 0, o3 = s3.ensureHandleId(u3[H.UTF8ToString(t3, -1)]), new DataView(a2.buffer).setUint32(n4, o3, true), s3.getReturnStatus();
          } catch (e3) {
            return s3.tryCatch.setError(e3), s3.setLastError(10);
          }
        }, napi_get_property: function(e2, r2, t3, n4) {
          var o3;
          if (!e2) return 1;
          var s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !s3.tryCatch.isEmpty()) return s3.setLastError(10);
          if (!s3.canCallIntoJs()) return s3.setLastError(s3.moduleApiVersion >= 10 ? 23 : 10);
          s3.clearLastError();
          try {
            if (!t3) return s3.setLastError(1);
            if (!n4) return s3.setLastError(1);
            if (!r2) return s3.setLastError(1);
            var i3 = d.handleStore.get(r2);
            if (null == i3.value) throw new TypeError("Cannot convert undefined or null to object");
            var u3 = void 0;
            try {
              u3 = i3.isObject() || i3.isFunction() ? i3.value : Object(i3.value);
            } catch (e3) {
              return s3.setLastError(2);
            }
            return n4 >>>= 0, o3 = s3.ensureHandleId(u3[d.handleStore.get(t3).value]), new DataView(a2.buffer).setUint32(n4, o3, true), s3.getReturnStatus();
          } catch (e3) {
            return s3.tryCatch.setError(e3), s3.setLastError(10);
          }
        }, napi_get_property_names: function(e2, r2, t3) {
          return me(e2, r2, 0, 18, 1, t3);
        }, napi_has_element: function(e2, r2, t3, n4) {
          var o3;
          if (!e2) return 1;
          var s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !s3.tryCatch.isEmpty()) return s3.setLastError(10);
          if (!s3.canCallIntoJs()) return s3.setLastError(s3.moduleApiVersion >= 10 ? 23 : 10);
          s3.clearLastError();
          try {
            if (!n4) return s3.setLastError(1);
            if (!r2) return s3.setLastError(1);
            var i3 = d.handleStore.get(r2);
            if (null == i3.value) throw new TypeError("Cannot convert undefined or null to object");
            var u3 = void 0;
            try {
              u3 = i3.isObject() || i3.isFunction() ? i3.value : Object(i3.value);
            } catch (e3) {
              return s3.setLastError(2);
            }
            return n4 >>>= 0, o3 = t3 >>> 0 in u3 ? 1 : 0, new DataView(a2.buffer).setInt8(n4, o3, true), s3.getReturnStatus();
          } catch (e3) {
            return s3.tryCatch.setError(e3), s3.setLastError(10);
          }
        }, napi_has_named_property: function(e2, r2, t3, n4) {
          var o3;
          if (!e2) return 1;
          var s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !s3.tryCatch.isEmpty()) return s3.setLastError(10);
          if (!s3.canCallIntoJs()) return s3.setLastError(s3.moduleApiVersion >= 10 ? 23 : 10);
          s3.clearLastError();
          try {
            if (!n4) return s3.setLastError(1);
            if (!r2) return s3.setLastError(1);
            if (!t3) return s3.setLastError(1);
            var i3 = d.handleStore.get(r2);
            if (null == i3.value) throw new TypeError("Cannot convert undefined or null to object");
            var u3 = void 0;
            try {
              u3 = i3.isObject() || i3.isFunction() ? i3.value : Object(i3.value);
            } catch (e3) {
              return s3.setLastError(2);
            }
            return t3 >>>= 0, n4 >>>= 0, o3 = H.UTF8ToString(t3, -1) in u3, new DataView(a2.buffer).setInt8(n4, o3 ? 1 : 0, true), s3.getReturnStatus();
          } catch (e3) {
            return s3.tryCatch.setError(e3), s3.setLastError(10);
          }
        }, napi_has_own_property: function(e2, r2, t3, n4) {
          var o3;
          if (!e2) return 1;
          var s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !s3.tryCatch.isEmpty()) return s3.setLastError(10);
          if (!s3.canCallIntoJs()) return s3.setLastError(s3.moduleApiVersion >= 10 ? 23 : 10);
          s3.clearLastError();
          try {
            if (!t3) return s3.setLastError(1);
            if (!n4) return s3.setLastError(1);
            if (!r2) return s3.setLastError(1);
            var i3 = d.handleStore.get(r2);
            if (null == i3.value) throw new TypeError("Cannot convert undefined or null to object");
            var u3 = void 0;
            try {
              u3 = i3.isObject() || i3.isFunction() ? i3.value : Object(i3.value);
            } catch (e3) {
              return s3.setLastError(2);
            }
            var f2 = d.handleStore.get(t3).value;
            return "string" != typeof f2 && "symbol" != typeof f2 ? s3.setLastError(4) : (o3 = Object.prototype.hasOwnProperty.call(u3, d.handleStore.get(t3).value), n4 >>>= 0, new DataView(a2.buffer).setInt8(n4, o3 ? 1 : 0, true), s3.getReturnStatus());
          } catch (e3) {
            return s3.tryCatch.setError(e3), s3.setLastError(10);
          }
        }, napi_has_property: function(e2, r2, t3, n4) {
          var o3;
          if (!e2) return 1;
          var s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !s3.tryCatch.isEmpty()) return s3.setLastError(10);
          if (!s3.canCallIntoJs()) return s3.setLastError(s3.moduleApiVersion >= 10 ? 23 : 10);
          s3.clearLastError();
          try {
            if (!t3) return s3.setLastError(1);
            if (!n4) return s3.setLastError(1);
            if (!r2) return s3.setLastError(1);
            var i3 = d.handleStore.get(r2);
            if (null == i3.value) throw new TypeError("Cannot convert undefined or null to object");
            var u3 = void 0;
            try {
              u3 = i3.isObject() || i3.isFunction() ? i3.value : Object(i3.value);
            } catch (e3) {
              return s3.setLastError(2);
            }
            return n4 >>>= 0, o3 = d.handleStore.get(t3).value in u3 ? 1 : 0, new DataView(a2.buffer).setInt8(n4, o3, true), s3.getReturnStatus();
          } catch (e3) {
            return s3.tryCatch.setError(e3), s3.setLastError(10);
          }
        }, napi_object_freeze: function(e2, r2) {
          if (!e2) return 1;
          var t3 = d.envStore.get(e2);
          if (t3.checkGCAccess(), !t3.tryCatch.isEmpty()) return t3.setLastError(10);
          if (!t3.canCallIntoJs()) return t3.setLastError(t3.moduleApiVersion >= 10 ? 23 : 10);
          t3.clearLastError();
          try {
            if (!r2) return t3.setLastError(1);
            var n4 = d.handleStore.get(r2), a3 = n4.value;
            return n4.isObject() || n4.isFunction() ? (Object.freeze(a3), t3.getReturnStatus()) : t3.setLastError(2);
          } catch (e3) {
            return t3.tryCatch.setError(e3), t3.setLastError(10);
          }
        }, napi_object_seal: function(e2, r2) {
          if (!e2) return 1;
          var t3 = d.envStore.get(e2);
          if (t3.checkGCAccess(), !t3.tryCatch.isEmpty()) return t3.setLastError(10);
          if (!t3.canCallIntoJs()) return t3.setLastError(t3.moduleApiVersion >= 10 ? 23 : 10);
          t3.clearLastError();
          try {
            if (!r2) return t3.setLastError(1);
            var n4 = d.handleStore.get(r2), a3 = n4.value;
            return n4.isObject() || n4.isFunction() ? (Object.seal(a3), t3.getReturnStatus()) : t3.setLastError(2);
          } catch (e3) {
            return t3.tryCatch.setError(e3), t3.setLastError(10);
          }
        }, napi_set_element: function(e2, r2, t3, n4) {
          if (!e2) return 1;
          var a3 = d.envStore.get(e2);
          if (a3.checkGCAccess(), !a3.tryCatch.isEmpty()) return a3.setLastError(10);
          if (!a3.canCallIntoJs()) return a3.setLastError(a3.moduleApiVersion >= 10 ? 23 : 10);
          a3.clearLastError();
          try {
            if (!n4) return a3.setLastError(1);
            if (!r2) return a3.setLastError(1);
            var o3 = d.handleStore.get(r2);
            return o3.isObject() || o3.isFunction() ? (o3.value[t3 >>> 0] = d.handleStore.get(n4).value, a3.getReturnStatus()) : a3.setLastError(2);
          } catch (e3) {
            return a3.tryCatch.setError(e3), a3.setLastError(10);
          }
        }, napi_set_named_property: function(e2, r2, t3, n4) {
          if (!e2) return 1;
          var a3 = d.envStore.get(e2);
          if (a3.checkGCAccess(), !a3.tryCatch.isEmpty()) return a3.setLastError(10);
          if (!a3.canCallIntoJs()) return a3.setLastError(a3.moduleApiVersion >= 10 ? 23 : 10);
          a3.clearLastError();
          try {
            if (!n4) return a3.setLastError(1);
            if (!r2) return a3.setLastError(1);
            var o3 = d.handleStore.get(r2);
            return o3.isObject() || o3.isFunction() ? t3 ? (t3 >>>= 0, d.handleStore.get(r2).value[H.UTF8ToString(t3, -1)] = d.handleStore.get(n4).value, a3.getReturnStatus()) : a3.setLastError(1) : a3.setLastError(2);
          } catch (e3) {
            return a3.tryCatch.setError(e3), a3.setLastError(10);
          }
        }, napi_set_property: function(e2, r2, t3, n4) {
          if (!e2) return 1;
          var a3 = d.envStore.get(e2);
          if (a3.checkGCAccess(), !a3.tryCatch.isEmpty()) return a3.setLastError(10);
          if (!a3.canCallIntoJs()) return a3.setLastError(a3.moduleApiVersion >= 10 ? 23 : 10);
          a3.clearLastError();
          try {
            if (!t3) return a3.setLastError(1);
            if (!n4) return a3.setLastError(1);
            if (!r2) return a3.setLastError(1);
            var o3 = d.handleStore.get(r2);
            return o3.isObject() || o3.isFunction() ? (o3.value[d.handleStore.get(t3).value] = d.handleStore.get(n4).value, a3.getReturnStatus()) : a3.setLastError(2);
          } catch (e3) {
            return a3.tryCatch.setError(e3), a3.setLastError(10);
          }
        } });
        var Se = Object.freeze({ __proto__: null, napi_run_script: function(e2, r2, t3) {
          var n4, o3;
          if (!e2) return 1;
          var s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !s3.tryCatch.isEmpty()) return s3.setLastError(10);
          if (!s3.canCallIntoJs()) return s3.setLastError(s3.moduleApiVersion >= 10 ? 23 : 10);
          s3.clearLastError();
          try {
            if (!r2) return s3.setLastError(1);
            if (!t3) return s3.setLastError(1);
            var i3 = d.handleStore.get(r2);
            if (!i3.isString()) return s3.setLastError(3);
            var u3 = d.handleStore.get(5).value.eval(i3.value);
            t3 >>>= 0, o3 = s3.ensureHandleId(u3), new DataView(a2.buffer).setUint32(t3, o3, true), n4 = s3.getReturnStatus();
          } catch (e3) {
            return s3.tryCatch.setError(e3), s3.setLastError(10);
          }
          return n4;
        } });
        var Ae = Object.freeze({ __proto__: null, napi_coerce_to_bool: function(e2, r2, t3) {
          var n4;
          if (!e2) return 1;
          var o3 = d.envStore.get(e2);
          if (o3.checkGCAccess(), !o3.tryCatch.isEmpty()) return o3.setLastError(10);
          if (!o3.canCallIntoJs()) return o3.setLastError(o3.moduleApiVersion >= 10 ? 23 : 10);
          o3.clearLastError();
          try {
            if (!r2) return o3.setLastError(1);
            if (!t3) return o3.setLastError(1);
            var s3 = d.handleStore.get(r2);
            return t3 >>>= 0, n4 = s3.value ? 4 : 3, new DataView(a2.buffer).setUint32(t3, n4, true), o3.getReturnStatus();
          } catch (e3) {
            return o3.tryCatch.setError(e3), o3.setLastError(10);
          }
        }, napi_coerce_to_number: function(e2, r2, t3) {
          var n4;
          if (!e2) return 1;
          var o3 = d.envStore.get(e2);
          if (o3.checkGCAccess(), !o3.tryCatch.isEmpty()) return o3.setLastError(10);
          if (!o3.canCallIntoJs()) return o3.setLastError(o3.moduleApiVersion >= 10 ? 23 : 10);
          o3.clearLastError();
          try {
            if (!r2) return o3.setLastError(1);
            if (!t3) return o3.setLastError(1);
            var s3 = d.handleStore.get(r2);
            if (s3.isBigInt()) throw new TypeError("Cannot convert a BigInt value to a number");
            return t3 >>>= 0, n4 = d.addToCurrentScope(Number(s3.value)).id, new DataView(a2.buffer).setUint32(t3, n4, true), o3.getReturnStatus();
          } catch (e3) {
            return o3.tryCatch.setError(e3), o3.setLastError(10);
          }
        }, napi_coerce_to_object: function(e2, r2, t3) {
          var n4;
          if (!e2) return 1;
          var o3 = d.envStore.get(e2);
          if (o3.checkGCAccess(), !o3.tryCatch.isEmpty()) return o3.setLastError(10);
          if (!o3.canCallIntoJs()) return o3.setLastError(o3.moduleApiVersion >= 10 ? 23 : 10);
          o3.clearLastError();
          try {
            if (!r2) return o3.setLastError(1);
            if (!t3) return o3.setLastError(1);
            var s3 = d.handleStore.get(r2);
            if (null == s3.value) throw new TypeError("Cannot convert undefined or null to object");
            return t3 >>>= 0, n4 = o3.ensureHandleId(Object(s3.value)), new DataView(a2.buffer).setUint32(t3, n4, true), o3.getReturnStatus();
          } catch (e3) {
            return o3.tryCatch.setError(e3), o3.setLastError(10);
          }
        }, napi_coerce_to_string: function(e2, r2, t3) {
          var n4;
          if (!e2) return 1;
          var o3 = d.envStore.get(e2);
          if (o3.checkGCAccess(), !o3.tryCatch.isEmpty()) return o3.setLastError(10);
          if (!o3.canCallIntoJs()) return o3.setLastError(o3.moduleApiVersion >= 10 ? 23 : 10);
          o3.clearLastError();
          try {
            if (!r2) return o3.setLastError(1);
            if (!t3) return o3.setLastError(1);
            var s3 = d.handleStore.get(r2);
            if (s3.isSymbol()) throw new TypeError("Cannot convert a Symbol value to a string");
            return t3 >>>= 0, n4 = d.addToCurrentScope(String(s3.value)).id, new DataView(a2.buffer).setUint32(t3, n4, true), o3.getReturnStatus();
          } catch (e3) {
            return o3.tryCatch.setError(e3), o3.setLastError(10);
          }
        }, napi_detach_arraybuffer: function(e2, r2) {
          if (!e2) return 1;
          var t3 = d.envStore.get(e2);
          if (t3.checkGCAccess(), !r2) return t3.setLastError(1);
          var n4 = d.handleStore.get(r2).value;
          if (!(n4 instanceof ArrayBuffer)) return "function" == typeof SharedArrayBuffer && n4 instanceof SharedArrayBuffer ? t3.setLastError(20) : t3.setLastError(19);
          try {
            new (0, d.feature.MessageChannel)().port1.postMessage(n4, [n4]);
          } catch (e3) {
            return t3.setLastError(9);
          }
          return t3.clearLastError();
        }, napi_instanceof: function(e2, r2, t3, n4) {
          var o3;
          if (!e2) return 1;
          var s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !s3.tryCatch.isEmpty()) return s3.setLastError(10);
          if (!s3.canCallIntoJs()) return s3.setLastError(s3.moduleApiVersion >= 10 ? 23 : 10);
          s3.clearLastError();
          try {
            if (!r2) return s3.setLastError(1);
            if (!n4) return s3.setLastError(1);
            if (!t3) return s3.setLastError(1);
            n4 >>>= 0;
            var i3 = new DataView(a2.buffer);
            i3.setInt8(n4, 0, true);
            var u3 = d.handleStore.get(t3);
            return u3.isFunction() ? (o3 = d.handleStore.get(r2).value instanceof u3.value ? 1 : 0, i3.setInt8(n4, o3, true), s3.getReturnStatus()) : s3.setLastError(5);
          } catch (e3) {
            return s3.tryCatch.setError(e3), s3.setLastError(10);
          }
        }, napi_is_array: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !r2) return n4.setLastError(1);
          if (!t3) return n4.setLastError(1);
          t3 >>>= 0;
          var o3 = d.handleStore.get(r2).isArray() ? 1 : 0;
          return new DataView(a2.buffer).setInt8(t3, o3, true), n4.clearLastError();
        }, napi_is_arraybuffer: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !r2) return n4.setLastError(1);
          if (!t3) return n4.setLastError(1);
          t3 >>>= 0;
          var o3 = d.handleStore.get(r2).isArrayBuffer() ? 1 : 0;
          return new DataView(a2.buffer).setInt8(t3, o3, true), n4.clearLastError();
        }, napi_is_buffer: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !r2) return n4.setLastError(1);
          if (!t3) return n4.setLastError(1);
          t3 >>>= 0;
          var o3 = d.handleStore.get(r2).isBuffer(d.feature.Buffer) ? 1 : 0;
          return new DataView(a2.buffer).setInt8(t3, o3, true), n4.clearLastError();
        }, napi_is_dataview: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !r2) return n4.setLastError(1);
          if (!t3) return n4.setLastError(1);
          t3 >>>= 0;
          var o3 = d.handleStore.get(r2).isDataView() ? 1 : 0;
          return new DataView(a2.buffer).setInt8(t3, o3, true), n4.clearLastError();
        }, napi_is_date: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !r2) return n4.setLastError(1);
          if (!t3) return n4.setLastError(1);
          t3 >>>= 0;
          var o3 = d.handleStore.get(r2).isDate() ? 1 : 0;
          return new DataView(a2.buffer).setInt8(t3, o3, true), n4.clearLastError();
        }, napi_is_detached_arraybuffer: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !n4.tryCatch.isEmpty()) return n4.setLastError(10);
          if (!n4.canCallIntoJs()) return n4.setLastError(n4.moduleApiVersion >= 10 ? 23 : 10);
          n4.clearLastError();
          try {
            if (!r2) return n4.setLastError(1);
            if (!t3) return n4.setLastError(1);
            var o3 = d.handleStore.get(r2);
            t3 >>>= 0;
            var s3 = new DataView(a2.buffer);
            if (o3.isArrayBuffer() && 0 === o3.value.byteLength) try {
              new Uint8Array(o3.value);
            } catch (e3) {
              return s3.setInt8(t3, 1, true), n4.getReturnStatus();
            }
            return s3.setInt8(t3, 0, true), n4.getReturnStatus();
          } catch (e3) {
            return n4.tryCatch.setError(e3), n4.setLastError(10);
          }
        }, napi_is_error: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !r2) return n4.setLastError(1);
          if (!t3) return n4.setLastError(1);
          t3 >>>= 0;
          var o3 = d.handleStore.get(r2).value instanceof Error ? 1 : 0;
          return new DataView(a2.buffer).setInt8(t3, o3, true), n4.clearLastError();
        }, napi_is_typedarray: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !r2) return n4.setLastError(1);
          if (!t3) return n4.setLastError(1);
          t3 >>>= 0;
          var o3 = d.handleStore.get(r2).isTypedArray() ? 1 : 0;
          return new DataView(a2.buffer).setInt8(t3, o3, true), n4.clearLastError();
        }, napi_strict_equals: function(e2, r2, t3, n4) {
          var o3;
          if (!e2) return 1;
          var s3 = d.envStore.get(e2);
          if (s3.checkGCAccess(), !s3.tryCatch.isEmpty()) return s3.setLastError(10);
          if (!s3.canCallIntoJs()) return s3.setLastError(s3.moduleApiVersion >= 10 ? 23 : 10);
          s3.clearLastError();
          try {
            if (!r2) return s3.setLastError(1);
            if (!t3) return s3.setLastError(1);
            if (!n4) return s3.setLastError(1);
            var i3 = d.handleStore.get(r2).value, u3 = d.handleStore.get(t3).value;
            return n4 >>>= 0, o3 = i3 === u3 ? 1 : 0, new DataView(a2.buffer).setInt8(n4, o3, true), s3.getReturnStatus();
          } catch (e3) {
            return s3.tryCatch.setError(e3), s3.setLastError(10);
          }
        }, napi_typeof: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !r2) return n4.setLastError(1);
          if (!t3) return n4.setLastError(1);
          var o3, s3 = d.handleStore.get(r2);
          if (t3 >>>= 0, s3.isNumber()) o3 = 3;
          else if (s3.isBigInt()) o3 = 9;
          else if (s3.isString()) o3 = 4;
          else if (s3.isFunction()) o3 = 7;
          else if (s3.isExternal()) o3 = 8;
          else if (s3.isObject()) o3 = 6;
          else if (s3.isBoolean()) o3 = 2;
          else if (s3.isUndefined()) o3 = 0;
          else if (s3.isSymbol()) o3 = 5;
          else {
            if (!s3.isNull()) return n4.setLastError(1);
            o3 = 1;
          }
          return new DataView(a2.buffer).setInt32(t3, o3, true), n4.clearLastError();
        }, node_api_is_sharedarraybuffer: function(e2, r2, t3) {
          if (!e2) return 1;
          var n4 = d.envStore.get(e2);
          if (n4.checkGCAccess(), !r2) return n4.setLastError(1);
          if (!t3) return n4.setLastError(1);
          var o3 = d.handleStore.get(r2);
          t3 >>>= 0;
          var s3 = "function" == typeof SharedArrayBuffer && o3.value instanceof SharedArrayBuffer || "[object SharedArrayBuffer]" === Object.prototype.toString.call(o3.value) ? 1 : 0;
          return new DataView(a2.buffer).setInt8(t3, s3, true), n4.clearLastError();
        } });
        var Ce = Object.freeze({ __proto__: null, napi_get_version: function(e2, r2) {
          if (!e2) return 1;
          var t3 = d.envStore.get(e2);
          return r2 ? (new DataView(a2.buffer).setUint32(r2, 10, true), t3.clearLastError()) : t3.setLastError(1);
        } });
        function Ie(e2) {
          for (var r2 = Object.keys(e2), t3 = 0; t3 < r2.length; ++t3) {
            var n4 = r2[t3];
            0 !== n4.indexOf("$") && (0 === n4.indexOf("emnapi_") ? g.imports.emnapi[n4] = e2[n4] : 0 === n4.indexOf("_emnapi_") || "napi_set_last_error" === n4 || "napi_clear_last_error" === n4 ? g.imports.env[n4] = e2[n4] : g.imports.napi[n4] = e2[n4]);
          }
        }
        return x.init(), J.init(), P.init(), H.init(), j.init(), S.init(), g.emnapi.syncMemory = ue, g.emnapi.getMemoryAddress = fe, g.emnapi.acquireExternalSharedArrayBuffer = ce, Ie(B), Ie(D), Ie(N), Ie(U), Ie(Y), Ie(ee), Ie(ve), Ie(pe), Ie(se), Ie(ge), Ie(le), Ie(ye), Ie(_e), Ie(Ee), Ie(we), Ie(O), Ie(Le), Ie(be), Ie(Se), Ie(Ae), Ie(Ce), g.imports.napi.napi_create_threadsafe_function = function(e2, r2, t3, n4, o3, u3, f2, c2, l2, v2, p2) {
          if (!e2) return 1;
          var g2 = d.envStore.get(e2);
          if (g2.checkGCAccess(), !n4) return g2.setLastError(1);
          if (o3 >>>= 0, u3 >>>= 0, e2 >>>= 0, f2 >>>= 0, c2 >>>= 0, l2 >>>= 0, v2 >>>= 0, o3 >>>= 0, 0 === (u3 >>>= 0)) return g2.setLastError(1);
          if (!p2) return g2.setLastError(1);
          var y2, h2 = 0;
          if (r2 >>>= 0) {
            if ("function" != typeof d.handleStore.get(r2).value) return g2.setLastError(1);
            h2 = d.createReference(g2, r2, 1, 1).id;
          } else if (!v2) return g2.setLastError(1);
          if (t3) {
            if (null == (y2 = d.handleStore.get(t3).value)) return g2.setLastError(2);
            y2 = Object(y2);
          } else y2 = {};
          var _2 = g2.ensureHandleId(y2), E2 = d.handleStore.get(n4).value;
          if ("symbol" == typeof E2) return g2.setLastError(3);
          E2 = String(E2);
          var w2 = g2.ensureHandleId(E2), L2 = j.offset.__size__, m2 = s2(L2);
          if (!m2) return g2.setLastError(9);
          m2 >>>= 0, new Uint8Array(j.ensureBufferFor(m2 + L2)).subarray(m2, m2 + L2).fill(0);
          var b2 = d.createReference(g2, _2, 1, 1), S2 = b2.id, A2 = new DataView(a2.buffer);
          return A2.setUint32(m2 + j.offset.resource, S2, true), j.initQueue(m2) ? (F(_2, w2, -1, m2 + j.offset.async_id), A2.setInt8(m2 + j.offset.is_some, 1, true), A2.setUint32(m2 + j.offset.thread_count, u3, true), A2.setUint32(m2 + j.offset.context, l2, true), A2.setUint32(m2 + j.offset.max_queue_size, o3, true), A2.setUint32(m2 + j.offset.ref, h2, true), A2.setUint32(m2 + j.offset.env, e2, true), A2.setUint32(m2 + j.offset.finalize_data, f2, true), A2.setUint32(m2 + j.offset.finalize_cb, c2, true), A2.setUint32(m2 + j.offset.call_js_cb, v2, true), d.addCleanupHook(g2, j.cleanup, m2), j._liveSet.add(m2), g2.ref(), d.increaseWaitingRequestCounter(), A2.setUint32(m2 + j.offset.async_ref, 1, true), p2 >>>= 0, A2.setUint32(p2, m2, true), g2.clearLastError()) : (i2(m2), b2.dispose(), g2.setLastError(9));
        }, g.imports.napi.napi_get_threadsafe_function_context = function(e2, r2) {
          if (!e2 || !r2) return l(), 1;
          e2 >>>= 0, r2 >>>= 0;
          var t3 = j.getContext(e2);
          return new DataView(a2.buffer).setUint32(r2, t3, true), 0;
        }, g.imports.napi.napi_call_threadsafe_function = function(e2, r2, t3) {
          return e2 ? (e2 >>>= 0, r2 >>>= 0, j.push(e2, r2, t3)) : (l(), 1);
        }, g.imports.napi.napi_acquire_threadsafe_function = function(e2) {
          return e2 ? (e2 >>>= 0, j.getMutex(e2).execute(function() {
            return 0 === j.getState(e2) ? (j.addThreadCount(e2), 0) : 16;
          })) : (l(), 1);
        }, g.imports.napi.napi_release_threadsafe_function = function(e2, r2) {
          if (!e2) return l(), 1;
          e2 >>>= 0;
          var t3 = j.getMutex(e2), n4 = j.getCond(e2), a3 = false, o3 = t3.execute(function() {
            return 0 === j.getThreadCount(e2) ? 1 : (j.subThreadCount(e2), 0 !== j.getThreadCount(e2) && 1 !== r2 || 0 === j.getState(e2) && (1 === r2 && j.setState(e2, 1), 1 === j.getState(e2) && j.getMaxQueueSize(e2) > 0 && n4.signal(), j.send(e2)), 2 !== j.getState(e2) || 0 !== j.getThreadCount(e2) || (a3 = true), 0);
          });
          return a3 && j.destroy(e2), o3;
        }, g.imports.napi.napi_unref_threadsafe_function = function(e2, r2) {
          if (!r2) return l(), 1;
          var t3 = (r2 >>>= 0) + j.offset.async_ref, n4 = t3 >>> 2, a3 = new Uint32Array(j.ensureBufferFor(t3 + 4)), o3 = Atomics.load(a3, n4);
          return o3 > 0 && (Atomics.store(a3, n4, o3 - 1), 1 === o3 && d.decreaseWaitingRequestCounter()), 0;
        }, g.imports.napi.napi_ref_threadsafe_function = function(e2, r2) {
          if (!r2) return l(), 1;
          var t3 = (r2 >>>= 0) + j.offset.async_ref, n4 = t3 >>> 2, a3 = new Uint32Array(j.ensureBufferFor(t3 + 4)), o3 = Atomics.load(a3, n4);
          return o3 || d.increaseWaitingRequestCounter(), Atomics.store(a3, n4, o3 + 1), 0;
        }, g;
      }();
      return n2;
    }
    function o(r2, t2, n2, o2) {
      const i2 = (o2 = null != o2 ? o2 : {}).getMemory, u2 = o2.getTable, f = o2.beforeInit;
      if (null != i2 && "function" != typeof i2) throw new TypeError("options.getMemory is not a function");
      if (null != u2 && "function" != typeof u2) throw new TypeError("options.getTable is not a function");
      if (null != f && "function" != typeof f) throw new TypeError("options.beforeInit is not a function");
      let c;
      const l = "object" == typeof t2 && null !== t2;
      if (l) {
        if (t2.loaded) throw new Error("napiModule has already loaded");
        c = t2;
      } else c = a(o2);
      const d = o2.wasi;
      let v, p = { env: c.imports.env, napi: c.imports.napi, emnapi: c.imports.emnapi };
      d && (v = new e.WASIThreads(c.childThread ? { wasi: d, childThread: true, postMessage: c.postMessage } : { wasi: d, threadManager: c.PThread, waitThreadStart: c.waitThreadStart }), Object.assign(p, "function" == typeof d.getImportObject ? d.getImportObject() : { wasi_snapshot_preview1: d.wasiImport }), Object.assign(p, v.getImportObject()));
      const g = o2.overwriteImports;
      if ("function" == typeof g) {
        const e2 = g(p);
        "object" == typeof e2 && null !== e2 && (p = e2);
      }
      return r2(n2, p, (e2, t3) => {
        if (e2) throw e2;
        const n3 = t3.instance;
        let a2 = n3;
        const o3 = n3.exports, g2 = "memory" in o3, y = "memory" in p.env, h = i2 ? i2(o3) : g2 ? o3.memory : y ? p.env.memory : void 0;
        if (!h) throw new Error("memory is neither exported nor imported");
        const _ = u2 ? u2(o3) : o3.__indirect_function_table;
        if (d && !g2) {
          const e3 = /* @__PURE__ */ Object.create(null);
          Object.assign(e3, o3, { memory: h }), a2 = { exports: e3 };
        }
        const E = t3.module;
        d ? a2 = v.initialize(a2, E, h) : c.PThread.setup(E, h);
        const w = () => {
          f && f({ instance: n3, module: E }), c.init({ instance: a2, module: E, memory: h, table: _ });
          const e3 = { instance: n3, module: E, usedInstance: a2 };
          return l || (e3.napiModule = c), e3;
        };
        if (c.PThread.shouldPreloadWorkers()) {
          const e3 = c.PThread.loadWasmModuleToAllWorkers();
          if (r2 === s) return e3.then(w);
          throw new Error("Synchronous loading is not supported with worker pool (reuseWorker.size > 0)");
        }
        return w();
      });
    }
    function s(e2, r2, t2) {
      return n(e2, r2).then((e3) => t2(null, e3), (e3) => t2(e3));
    }
    function i(e2, n2, a2) {
      let o2;
      try {
        o2 = function(e3, n3) {
          if (!e3) throw new TypeError("Invalid wasm source");
          let a3;
          if (t(n3), n3 = null != n3 ? n3 : {}, e3 instanceof ArrayBuffer || ArrayBuffer.isView(e3)) a3 = new r.Module(e3);
          else {
            if (!(e3 instanceof WebAssembly.Module)) throw new TypeError("Invalid wasm source");
            a3 = e3;
          }
          return { instance: new r.Instance(a3, n3), module: a3 };
        }(e2, n2);
      } catch (e3) {
        return a2(e3);
      }
      return a2(null, o2);
    }
    var u = class extends e.ThreadMessageHandler {
      constructor(e2) {
        if ("function" != typeof e2.onLoad) throw new TypeError("options.onLoad is not a function");
        const r2 = e2.onError;
        super({ ...e2, onError: (e3, t2) => {
          var n2;
          const a2 = null === (n2 = this.instance) || void 0 === n2 ? void 0 : n2.exports.emnapi_thread_crashed;
          if ("function" == typeof a2 && a2(), "function" != typeof r2) throw e3;
          r2(e3, t2);
        } }), this.napiModule = void 0;
      }
      instantiate(e2) {
        const r2 = this.onLoad(e2);
        return "function" == typeof r2.then ? r2.then((e3) => (this.napiModule = e3.napiModule, e3)) : (this.napiModule = r2.napiModule, r2);
      }
      handle(e2) {
        var r2;
        if (super.handle(e2), null === (r2 = null == e2 ? void 0 : e2.data) || void 0 === r2 ? void 0 : r2.__emnapi__) {
          const r3 = e2.data.__emnapi__.type, t2 = e2.data.__emnapi__.payload;
          try {
            "async-worker-init" === r3 && this.handleAfterLoad(e2, () => {
              this.napiModule.initWorker(t2.arg, t2.func);
            });
          } catch (e3) {
            this.onError(e3, r3);
          }
        }
      }
    };
    exports2.MessageHandler = u, exports2.createNapiModule = a, exports2.instantiateNapiModule = function(e2, r2) {
      return o(s, void 0, e2, r2);
    }, exports2.instantiateNapiModuleSync = function(e2, r2) {
      return o(i, void 0, e2, r2);
    }, exports2.loadNapiModule = function(e2, r2, t2) {
      if ("object" != typeof e2 || null === e2) throw new TypeError("Invalid napiModule");
      return o(s, e2, r2, t2);
    }, exports2.loadNapiModuleSync = function(e2, r2, t2) {
      if ("object" != typeof e2 || null === e2) throw new TypeError("Invalid napiModule");
      return o(i, e2, r2, t2);
    }, exports2.version = "1.11.2", Object.keys(e).forEach(function(r2) {
      "default" === r2 || Object.prototype.hasOwnProperty.call(exports2, r2) || Object.defineProperty(exports2, r2, { enumerable: true, get: function() {
        return e[r2];
      } });
    });
  }
});

// node_modules/@emnapi/core/dist/emnapi-core.cjs.js
var require_emnapi_core_cjs = __commonJS({
  "node_modules/@emnapi/core/dist/emnapi-core.cjs.js"(exports2) {
    var wasiThreads = require_wasi_threads();
    var _WebAssembly = typeof WebAssembly !== "undefined" ? WebAssembly : typeof WXWebAssembly !== "undefined" ? WXWebAssembly : void 0;
    function validateImports(imports) {
      if (imports && typeof imports !== "object") {
        throw new TypeError("imports must be an object or undefined");
      }
      return true;
    }
    function load(wasmInput, imports) {
      if (!wasmInput)
        throw new TypeError("Invalid wasm source");
      validateImports(imports);
      imports = imports !== null && imports !== void 0 ? imports : {};
      try {
        const then = typeof wasmInput === "object" && wasmInput !== null && "then" in wasmInput ? wasmInput.then : void 0;
        if (typeof then === "function") {
          return then.call(wasmInput, (input) => load(input, imports));
        }
      } catch (_) {
      }
      if (wasmInput instanceof ArrayBuffer || ArrayBuffer.isView(wasmInput)) {
        return _WebAssembly.instantiate(wasmInput, imports);
      }
      if (wasmInput instanceof _WebAssembly.Module) {
        return _WebAssembly.instantiate(wasmInput, imports).then((instance) => {
          return { instance, module: wasmInput };
        });
      }
      if (typeof Response !== "undefined" && wasmInput instanceof Response) {
        return wasmInput.arrayBuffer().then((buffer) => {
          return _WebAssembly.instantiate(buffer, imports);
        });
      }
      const inputIsString = typeof wasmInput === "string";
      if (inputIsString || typeof URL !== "undefined" && wasmInput instanceof URL) {
        if (inputIsString && typeof wx !== "undefined" && typeof __wxConfig !== "undefined") {
          return _WebAssembly.instantiate(wasmInput, imports);
        }
        if (typeof fetch !== "function") {
          throw new TypeError("wasm source can not be a string or URL in this environment");
        }
        if (typeof _WebAssembly.instantiateStreaming === "function") {
          try {
            return _WebAssembly.instantiateStreaming(fetch(wasmInput), imports).catch(() => {
              return load(fetch(wasmInput), imports);
            });
          } catch (_) {
            return load(fetch(wasmInput), imports);
          }
        } else {
          return load(fetch(wasmInput), imports);
        }
      }
      throw new TypeError("Invalid wasm source");
    }
    function loadSync(wasmInput, imports) {
      if (!wasmInput)
        throw new TypeError("Invalid wasm source");
      validateImports(imports);
      imports = imports !== null && imports !== void 0 ? imports : {};
      let module3;
      if (wasmInput instanceof ArrayBuffer || ArrayBuffer.isView(wasmInput)) {
        module3 = new _WebAssembly.Module(wasmInput);
      } else if (wasmInput instanceof WebAssembly.Module) {
        module3 = wasmInput;
      } else {
        throw new TypeError("Invalid wasm source");
      }
      const instance = new _WebAssembly.Instance(module3, imports);
      const source = { instance, module: module3 };
      return source;
    }
    function createNapiModule(options) {
      var napiModule = function() {
        var ENVIRONMENT_IS_NODE = typeof process === "object" && process !== null && typeof process.versions === "object" && process.versions !== null && typeof process.versions.node === "string";
        var ENVIRONMENT_IS_PTHREAD = Boolean(options.childThread);
        var waitThreadStart = typeof options.waitThreadStart === "number" ? options.waitThreadStart : Boolean(options.waitThreadStart);
        var wasmInstance;
        var wasmMemory;
        var wasmTable;
        var _malloc;
        var _free;
        function abort(msg) {
          if (typeof _WebAssembly.RuntimeError === "function") {
            throw new _WebAssembly.RuntimeError(msg);
          }
          throw Error(msg);
        }
        var napiModule2 = {
          imports: {
            env: {},
            napi: {},
            emnapi: {}
          },
          exports: {},
          emnapi: {},
          loaded: false,
          filename: "",
          childThread: ENVIRONMENT_IS_PTHREAD,
          initWorker: void 0,
          waitThreadStart,
          PThread: void 0,
          init: function(options2) {
            if (napiModule2.loaded)
              return napiModule2.exports;
            if (!options2)
              throw new TypeError("Invalid napi init options");
            var instance = options2.instance;
            if (!(instance === null || instance === void 0 ? void 0 : instance.exports))
              throw new TypeError("Invalid wasm instance");
            wasmInstance = instance;
            var exports3 = instance.exports;
            var module3 = options2.module;
            var memory = options2.memory || exports3.memory;
            var table = options2.table || exports3.__indirect_function_table;
            if (!(module3 instanceof _WebAssembly.Module))
              throw new TypeError("Invalid wasm module");
            if (!(memory instanceof _WebAssembly.Memory))
              throw new TypeError("Invalid wasm memory");
            if (!(table instanceof _WebAssembly.Table))
              throw new TypeError("Invalid wasm table");
            wasmMemory = memory;
            wasmTable = table;
            if (typeof exports3.malloc !== "function")
              throw new TypeError("malloc is not exported");
            if (typeof exports3.free !== "function")
              throw new TypeError("free is not exported");
            _malloc = exports3.malloc;
            _free = exports3.free;
            if (!napiModule2.childThread) {
              var moduleApiVersion = 8;
              var node_api_module_get_api_version_v1 = instance.exports.node_api_module_get_api_version_v1;
              if (typeof node_api_module_get_api_version_v1 === "function") {
                moduleApiVersion = node_api_module_get_api_version_v1();
              }
              var envObject = napiModule2.envObject || (napiModule2.envObject = emnapiCtx.createEnv(napiModule2.filename, moduleApiVersion, function(cb) {
                return wasmTable.get(cb);
              }, function(cb) {
                return wasmTable.get(cb);
              }, abort, emnapiNodeBinding));
              var scope_1 = emnapiCtx.openScope(envObject);
              try {
                envObject.callIntoModule(function(_envObject) {
                  var exports4 = napiModule2.exports;
                  var exportsHandle = scope_1.add(exports4);
                  var napi_register_wasm_v1 = instance.exports.napi_register_wasm_v1;
                  var napiValue = napi_register_wasm_v1(_envObject.id, exportsHandle.id);
                  napiModule2.exports = !napiValue ? exports4 : emnapiCtx.handleStore.get(napiValue).value;
                });
              } catch (e) {
                if (e !== "unwind") {
                  throw e;
                }
              } finally {
                emnapiCtx.closeScope(envObject, scope_1);
              }
              napiModule2.loaded = true;
              delete napiModule2.envObject;
              return napiModule2.exports;
            }
          }
        };
        var emnapiCtx;
        var emnapiNodeBinding;
        var onCreateWorker = void 0;
        var err;
        if (!ENVIRONMENT_IS_PTHREAD) {
          var context = options.context;
          if (typeof context !== "object" || context === null) {
            throw new TypeError("Invalid `options.context`. Use `import { getDefaultContext } from '@emnapi/runtime'`");
          }
          emnapiCtx = context;
        } else {
          emnapiCtx = options === null || options === void 0 ? void 0 : options.context;
          var postMsg = typeof options.postMessage === "function" ? options.postMessage : typeof postMessage === "function" ? postMessage : void 0;
          if (typeof postMsg !== "function") {
            throw new TypeError("No postMessage found");
          }
          napiModule2.postMessage = postMsg;
        }
        if (typeof options.filename === "string") {
          napiModule2.filename = options.filename;
        }
        if (typeof options.onCreateWorker === "function") {
          onCreateWorker = options.onCreateWorker;
        }
        if (typeof options.print === "function") {
          options.print;
        } else {
          console.log.bind(console);
        }
        if (typeof options.printErr === "function") {
          err = options.printErr;
        } else {
          err = console.warn.bind(console);
        }
        if ("nodeBinding" in options) {
          var nodeBinding = options.nodeBinding;
          if (typeof nodeBinding !== "object" || nodeBinding === null) {
            throw new TypeError("Invalid `options.nodeBinding`. Use @emnapi/node-binding package");
          }
          emnapiNodeBinding = nodeBinding;
        }
        var emnapiAsyncWorkPoolSize = 0;
        if ("asyncWorkPoolSize" in options) {
          if (typeof options.asyncWorkPoolSize !== "number") {
            throw new TypeError("options.asyncWorkPoolSize must be a integer");
          }
          emnapiAsyncWorkPoolSize = options.asyncWorkPoolSize >> 0;
          if (emnapiAsyncWorkPoolSize > 1024) {
            emnapiAsyncWorkPoolSize = 1024;
          } else if (emnapiAsyncWorkPoolSize < -1024) {
            emnapiAsyncWorkPoolSize = -1024;
          }
        }
        var singleThreadAsyncWork = ENVIRONMENT_IS_PTHREAD ? false : emnapiAsyncWorkPoolSize <= 0;
        function _emnapi_async_work_pool_size() {
          return Math.abs(emnapiAsyncWorkPoolSize);
        }
        napiModule2.imports.env._emnapi_async_work_pool_size = _emnapi_async_work_pool_size;
        function emnapiAddSendListener(worker) {
          if (!worker)
            return false;
          if (worker._emnapiSendListener)
            return true;
          var handler = function(e) {
            var data = ENVIRONMENT_IS_NODE ? e : e.data;
            var __emnapi__ = data.__emnapi__;
            if (__emnapi__ && __emnapi__.type === "async-send") {
              if (ENVIRONMENT_IS_PTHREAD) {
                var postMessage_1 = napiModule2.postMessage;
                postMessage_1({ __emnapi__ });
              } else {
                var callback = __emnapi__.payload.callback;
                wasmTable.get(callback)(__emnapi__.payload.data);
              }
            }
          };
          var dispose = function() {
            if (ENVIRONMENT_IS_NODE) {
              worker.off("message", handler);
            } else {
              worker.removeEventListener("message", handler, false);
            }
            delete worker._emnapiSendListener;
          };
          worker._emnapiSendListener = { handler, dispose };
          if (ENVIRONMENT_IS_NODE) {
            worker.on("message", handler);
          } else {
            worker.addEventListener("message", handler, false);
          }
          return true;
        }
        napiModule2.emnapi.addSendListener = emnapiAddSendListener;
        var PThread = new wasiThreads.ThreadManager(ENVIRONMENT_IS_PTHREAD ? {
          printErr: err,
          childThread: true
        } : {
          printErr: err,
          beforeLoad: function(worker) {
            emnapiAddSendListener(worker);
          },
          reuseWorker: options.reuseWorker,
          onCreateWorker
        });
        napiModule2.PThread = PThread;
        function napi_set_last_error(env, error_code, engine_error_code, engine_reserved) {
          var envObject = emnapiCtx.envStore.get(env);
          return envObject.setLastError(error_code, engine_error_code, engine_reserved);
        }
        function napi_clear_last_error(env) {
          var envObject = emnapiCtx.envStore.get(env);
          return envObject.clearLastError();
        }
        function _emnapi_get_node_version(major, minor, patch) {
          major >>>= 0;
          minor >>>= 0;
          patch >>>= 0;
          var versions = typeof process === "object" && process !== null && typeof process.versions === "object" && process.versions !== null && typeof process.versions.node === "string" ? process.versions.node.split(".").map(function(n) {
            return Number(n);
          }) : [0, 0, 0];
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(major, versions[0], true);
          HEAP_DATA_VIEW.setUint32(minor, versions[1], true);
          HEAP_DATA_VIEW.setUint32(patch, versions[2], true);
        }
        function _emnapi_runtime_keepalive_push() {
        }
        function _emnapi_runtime_keepalive_pop() {
        }
        function _emnapi_set_immediate(callback, data) {
          emnapiCtx.feature.setImmediate(function() {
            wasmTable.get(callback)(data);
          });
        }
        function _emnapi_next_tick(callback, data) {
          Promise.resolve().then(function() {
            wasmTable.get(callback)(data);
          });
        }
        function _emnapi_callback_into_module(forceUncaught, env, callback, data, close_scope_if_throw) {
          var envObject = emnapiCtx.envStore.get(env);
          var scope = emnapiCtx.openScope(envObject);
          try {
            envObject.callbackIntoModule(Boolean(forceUncaught), function() {
              wasmTable.get(callback)(env, data);
            });
          } catch (err2) {
            emnapiCtx.closeScope(envObject, scope);
            if (close_scope_if_throw) {
              emnapiCtx.closeScope(envObject);
            }
            throw err2;
          }
          emnapiCtx.closeScope(envObject, scope);
        }
        function _emnapi_call_finalizer(forceUncaught, env, callback, data, hint) {
          var envObject = emnapiCtx.envStore.get(env);
          callback >>>= 0;
          envObject.callFinalizerInternal(forceUncaught, callback, data, hint);
        }
        function _emnapi_ctx_increase_waiting_request_counter() {
          emnapiCtx.increaseWaitingRequestCounter();
        }
        function _emnapi_ctx_decrease_waiting_request_counter() {
          emnapiCtx.decreaseWaitingRequestCounter();
        }
        function _emnapi_is_main_runtime_thread() {
          return ENVIRONMENT_IS_PTHREAD ? 0 : 1;
        }
        function _emnapi_is_main_browser_thread() {
          return typeof window !== "undefined" && typeof document !== "undefined" && !ENVIRONMENT_IS_NODE ? 1 : 0;
        }
        function _emnapi_unwind() {
          throw "unwind";
        }
        function _emnapi_get_now() {
          return performance.timeOrigin + performance.now();
        }
        function $emnapiSetValueI64(result, numberValue) {
          var tempDouble;
          var tempI64 = [
            numberValue >>> 0,
            (tempDouble = numberValue, +Math.abs(tempDouble) >= 1 ? tempDouble > 0 ? (Math.min(+Math.floor(tempDouble / 4294967296), 4294967295) | 0) >>> 0 : ~~+Math.ceil((tempDouble - +(~~tempDouble >>> 0)) / 4294967296) >>> 0 : 0)
          ];
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setInt32(result, tempI64[0], true);
          HEAP_DATA_VIEW.setInt32(result + 4, tempI64[1], true);
        }
        function _emnapi_open_handle_scope() {
          return emnapiCtx.openScope().id;
        }
        function _emnapi_close_handle_scope(_scope) {
          return emnapiCtx.closeScope();
        }
        var utilMod = Object.freeze({
          __proto__: null,
          $emnapiSetValueI64,
          _emnapi_call_finalizer,
          _emnapi_callback_into_module,
          _emnapi_close_handle_scope,
          _emnapi_ctx_decrease_waiting_request_counter,
          _emnapi_ctx_increase_waiting_request_counter,
          _emnapi_get_node_version,
          _emnapi_get_now,
          _emnapi_is_main_browser_thread,
          _emnapi_is_main_runtime_thread,
          _emnapi_next_tick,
          _emnapi_open_handle_scope,
          _emnapi_runtime_keepalive_pop,
          _emnapi_runtime_keepalive_push,
          _emnapi_set_immediate,
          _emnapi_unwind,
          napi_clear_last_error,
          napi_set_last_error
        });
        function emnapiGetWorkerByPthreadPtr(pthreadPtr) {
          var view = new DataView(wasmMemory.buffer);
          var tidOffset = 20;
          var tid = view.getInt32(pthreadPtr + tidOffset, true);
          var worker = PThread.pthreads[tid];
          return worker;
        }
        function _emnapi_worker_ref(pthreadPtr) {
          if (ENVIRONMENT_IS_PTHREAD)
            return;
          pthreadPtr >>>= 0;
          var worker = emnapiGetWorkerByPthreadPtr(pthreadPtr);
          if (worker && typeof worker.ref === "function") {
            worker.ref();
          }
        }
        function _emnapi_worker_unref(pthreadPtr) {
          if (ENVIRONMENT_IS_PTHREAD)
            return;
          pthreadPtr >>>= 0;
          var worker = emnapiGetWorkerByPthreadPtr(pthreadPtr);
          if (worker && typeof worker.unref === "function") {
            worker.unref();
          }
        }
        function _emnapi_async_send_js(type, callback, data) {
          if (ENVIRONMENT_IS_PTHREAD) {
            var postMessage_1 = napiModule2.postMessage;
            postMessage_1({
              __emnapi__: {
                type: "async-send",
                payload: {
                  callback,
                  data
                }
              }
            });
          } else {
            switch (type) {
              case 0:
                _emnapi_set_immediate(callback, data);
                break;
              case 1:
                _emnapi_next_tick(callback, data);
                break;
            }
          }
        }
        var uvThreadpoolReadyResolve;
        var uvThreadpoolReady = new Promise(function(resolve) {
          uvThreadpoolReadyResolve = function() {
            uvThreadpoolReady.ready = true;
            resolve();
          };
        });
        uvThreadpoolReady.ready = false;
        function _emnapi_after_uvthreadpool_ready(callback, q, type) {
          if (uvThreadpoolReady.ready) {
            wasmTable.get(callback)(q, type);
          } else {
            uvThreadpoolReady.then(function() {
              wasmTable.get(callback)(q, type);
            });
          }
        }
        function _emnapi_tell_js_uvthreadpool(threads, size) {
          var p = [];
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          var _loop_1 = function(i2) {
            var pthreadPtr = HEAP_DATA_VIEW.getUint32(threads + i2 * 4, true);
            var worker = emnapiGetWorkerByPthreadPtr(pthreadPtr);
            p.push(new Promise(function(resolve) {
              var handler = function(e) {
                var data = ENVIRONMENT_IS_NODE ? e : e.data;
                var __emnapi__ = data.__emnapi__;
                if (__emnapi__ && __emnapi__.type === "async-thread-ready") {
                  resolve();
                  if (worker && typeof worker.unref === "function") {
                    worker.unref();
                  }
                  if (ENVIRONMENT_IS_NODE) {
                    worker.off("message", handler);
                  } else {
                    worker.removeEventListener("message", handler);
                  }
                }
              };
              if (ENVIRONMENT_IS_NODE) {
                worker.on("message", handler);
              } else {
                worker.addEventListener("message", handler);
              }
            }));
          };
          for (var i = 0; i < size; i++) {
            _loop_1(i);
          }
          Promise.all(p).then(uvThreadpoolReadyResolve);
        }
        function _emnapi_emit_async_thread_ready() {
          if (!ENVIRONMENT_IS_PTHREAD)
            return;
          var postMessage2 = napiModule2.postMessage;
          postMessage2({
            __emnapi__: {
              type: "async-thread-ready",
              payload: {}
            }
          });
        }
        var asyncMod = Object.freeze({
          __proto__: null,
          _emnapi_after_uvthreadpool_ready,
          _emnapi_async_send_js,
          _emnapi_emit_async_thread_ready,
          _emnapi_tell_js_uvthreadpool,
          _emnapi_worker_ref,
          _emnapi_worker_unref
        });
        function napi_adjust_external_memory(env, change_in_bytes, adjusted_value) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          if (!adjusted_value)
            return envObject.setLastError(1);
          var adjusted_memory = emnapiCtx.adjustAmountOfExternalAllocatedMemory(change_in_bytes);
          adjusted_value >>>= 0;
          if (emnapiCtx.feature.supportBigInt) {
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setBigInt64(adjusted_value, BigInt(adjusted_memory), true);
          } else {
            $emnapiSetValueI64(adjusted_value, Number(adjusted_memory));
          }
          return envObject.clearLastError();
        }
        var memoryMod = Object.freeze({
          __proto__: null,
          napi_adjust_external_memory
        });
        var emnapiAWST = {
          idGen: {},
          values: [void 0],
          queued: /* @__PURE__ */ new Set(),
          pending: [],
          init: function() {
            var idGen = {
              nextId: 1,
              list: [],
              generate: function() {
                var id;
                if (idGen.list.length) {
                  id = idGen.list.shift();
                } else {
                  id = idGen.nextId;
                  idGen.nextId++;
                }
                return id;
              },
              reuse: function(id) {
                idGen.list.push(id);
              }
            };
            emnapiAWST.idGen = idGen;
            emnapiAWST.values = [void 0];
            emnapiAWST.queued = /* @__PURE__ */ new Set();
            emnapiAWST.pending = [];
          },
          create: function(env, resource, resourceName, execute, complete, data) {
            var asyncId = 0;
            var triggerAsyncId = 0;
            if (emnapiNodeBinding) {
              var asyncContext = emnapiNodeBinding.node.emitAsyncInit(resource, resourceName, -1);
              asyncId = asyncContext.asyncId;
              triggerAsyncId = asyncContext.triggerAsyncId;
            }
            var id = emnapiAWST.idGen.generate();
            emnapiAWST.values[id] = {
              env,
              id,
              resource,
              asyncId,
              triggerAsyncId,
              status: 0,
              execute,
              complete,
              data
            };
            return id;
          },
          callComplete: function(work, status) {
            var complete = work.complete;
            var env = work.env;
            var data = work.data;
            var callback = function() {
              if (!complete)
                return;
              var envObject = emnapiCtx.envStore.get(env);
              var scope = emnapiCtx.openScope(envObject);
              try {
                envObject.callbackIntoModule(true, function() {
                  wasmTable.get(complete)(env, status, data);
                });
              } finally {
                emnapiCtx.closeScope(envObject, scope);
              }
            };
            if (emnapiNodeBinding) {
              emnapiNodeBinding.node.makeCallback(work.resource, callback, [], {
                asyncId: work.asyncId,
                triggerAsyncId: work.triggerAsyncId
              });
            } else {
              callback();
            }
          },
          queue: function(id) {
            var work = emnapiAWST.values[id];
            if (!work)
              return;
            if (work.status === 0) {
              work.status = 1;
              if (emnapiAWST.queued.size >= (Math.abs(emnapiAsyncWorkPoolSize) || 4)) {
                emnapiAWST.pending.push(id);
                return;
              }
              emnapiAWST.queued.add(id);
              var env_1 = work.env;
              var data_1 = work.data;
              var execute = work.execute;
              work.status = 2;
              emnapiCtx.feature.setImmediate(function() {
                wasmTable.get(execute)(env_1, data_1);
                emnapiAWST.queued.delete(id);
                work.status = 3;
                emnapiCtx.feature.setImmediate(function() {
                  emnapiAWST.callComplete(work, 0);
                });
                if (emnapiAWST.pending.length > 0) {
                  var nextWorkId = emnapiAWST.pending.shift();
                  emnapiAWST.values[nextWorkId].status = 0;
                  emnapiAWST.queue(nextWorkId);
                }
              });
            }
          },
          cancel: function(id) {
            var index = emnapiAWST.pending.indexOf(id);
            if (index !== -1) {
              var work_1 = emnapiAWST.values[id];
              if (work_1 && work_1.status === 1) {
                work_1.status = 4;
                emnapiAWST.pending.splice(index, 1);
                emnapiCtx.feature.setImmediate(function() {
                  emnapiAWST.callComplete(work_1, 11);
                });
                return 0;
              } else {
                return 9;
              }
            }
            return 9;
          },
          remove: function(id) {
            var work = emnapiAWST.values[id];
            if (!work)
              return;
            if (emnapiNodeBinding) {
              emnapiNodeBinding.node.emitAsyncDestroy({
                asyncId: work.asyncId,
                triggerAsyncId: work.triggerAsyncId
              });
            }
            emnapiAWST.values[id] = void 0;
            emnapiAWST.idGen.reuse(id);
          }
        };
        function _emnapi_node_emit_async_init(async_resource, async_resource_name, trigger_async_id, result) {
          if (!emnapiNodeBinding)
            return;
          var resource = emnapiCtx.handleStore.get(async_resource).value;
          var resource_name = emnapiCtx.handleStore.get(async_resource_name).value;
          var asyncContext = emnapiNodeBinding.node.emitAsyncInit(resource, resource_name, trigger_async_id);
          var asyncId = asyncContext.asyncId;
          var triggerAsyncId = asyncContext.triggerAsyncId;
          if (result) {
            result >>>= 0;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setFloat64(result, asyncId, true);
            HEAP_DATA_VIEW.setFloat64(result + 8, triggerAsyncId, true);
          }
        }
        function _emnapi_node_emit_async_destroy(async_id, trigger_async_id) {
          if (!emnapiNodeBinding)
            return;
          emnapiNodeBinding.node.emitAsyncDestroy({
            asyncId: async_id,
            triggerAsyncId: trigger_async_id
          });
        }
        function _emnapi_node_make_callback(env, async_resource, cb, argv, size, async_id, trigger_async_id, result) {
          var i = 0;
          var v;
          if (!emnapiNodeBinding)
            return;
          var resource = emnapiCtx.handleStore.get(async_resource).value;
          var callback = emnapiCtx.handleStore.get(cb).value;
          argv >>>= 0;
          size >>>= 0;
          size = size >>> 0;
          var arr = Array(size);
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          for (; i < size; i++) {
            var argVal = HEAP_DATA_VIEW.getUint32(argv + i * 4, true);
            arr[i] = emnapiCtx.handleStore.get(argVal).value;
          }
          var ret = emnapiNodeBinding.node.makeCallback(resource, callback, arr, {
            asyncId: async_id,
            triggerAsyncId: trigger_async_id
          });
          if (result) {
            result >>>= 0;
            var envObject = emnapiCtx.envStore.get(env);
            v = envObject.ensureHandleId(ret);
            HEAP_DATA_VIEW.setUint32(result, v, true);
          }
        }
        function _emnapi_async_init_js(async_resource, async_resource_name, result) {
          if (!emnapiNodeBinding) {
            return 9;
          }
          var resource;
          if (async_resource) {
            resource = Object(emnapiCtx.handleStore.get(async_resource).value);
          }
          var name = emnapiCtx.handleStore.get(async_resource_name).value;
          var ret = emnapiNodeBinding.napi.asyncInit(resource, name);
          if (ret.status !== 0)
            return ret.status;
          var numberValue = ret.value;
          if (!(numberValue >= BigInt(-1) * (BigInt(1) << BigInt(63)) && numberValue < BigInt(1) << BigInt(63))) {
            numberValue = numberValue & (BigInt(1) << BigInt(64)) - BigInt(1);
            if (numberValue >= BigInt(1) << BigInt(63)) {
              numberValue = numberValue - (BigInt(1) << BigInt(64));
            }
          }
          var low = Number(numberValue & BigInt(4294967295));
          var high = Number(numberValue >> BigInt(32));
          result >>>= 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setInt32(result, low, true);
          HEAP_DATA_VIEW.setInt32(result + 4, high, true);
          return 0;
        }
        function _emnapi_async_destroy_js(async_context) {
          if (!emnapiNodeBinding) {
            return 9;
          }
          async_context >>>= 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          var low = HEAP_DATA_VIEW.getInt32(async_context, true);
          var high = HEAP_DATA_VIEW.getInt32(async_context + 4, true);
          var pointer = BigInt(low >>> 0) | BigInt(high) << BigInt(32);
          var ret = emnapiNodeBinding.napi.asyncDestroy(pointer);
          if (ret.status !== 0)
            return ret.status;
          return 0;
        }
        function napi_open_callback_scope(env, ignored, async_context_handle, result) {
          throw new Error("napi_open_callback_scope has not been implemented yet");
        }
        function napi_close_callback_scope(env, scope) {
          throw new Error("napi_close_callback_scope has not been implemented yet");
        }
        function napi_make_callback(env, async_context, recv, func, argc, argv, result) {
          var i = 0;
          var v;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!emnapiNodeBinding) {
              return envObject.setLastError(9);
            }
            if (!recv)
              return envObject.setLastError(1);
            if (argc > 0) {
              if (!argv)
                return envObject.setLastError(1);
            }
            var v8recv = Object(emnapiCtx.handleStore.get(recv).value);
            var v8func = emnapiCtx.handleStore.get(func).value;
            if (typeof v8func !== "function") {
              return envObject.setLastError(1);
            }
            async_context >>>= 0;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            var low = HEAP_DATA_VIEW.getInt32(async_context, true);
            var high = HEAP_DATA_VIEW.getInt32(async_context + 4, true);
            var ctx = BigInt(low >>> 0) | BigInt(high) << BigInt(32);
            argv >>>= 0;
            argc >>>= 0;
            argc = argc >>> 0;
            var arr = Array(argc);
            for (; i < argc; i++) {
              var argVal = HEAP_DATA_VIEW.getUint32(argv + i * 4, true);
              arr[i] = emnapiCtx.handleStore.get(argVal).value;
            }
            var ret = emnapiNodeBinding.napi.makeCallback(ctx, v8recv, v8func, arr);
            if (ret.error) {
              throw ret.error;
            }
            if (ret.status !== 0)
              return envObject.setLastError(ret.status);
            if (result) {
              result >>>= 0;
              v = envObject.ensureHandleId(ret.value);
              HEAP_DATA_VIEW.setUint32(result, v, true);
            }
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function _emnapi_env_check_gc_access(env) {
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
        }
        var nodeMod = Object.freeze({
          __proto__: null,
          _emnapi_async_destroy_js,
          _emnapi_async_init_js,
          _emnapi_env_check_gc_access,
          _emnapi_node_emit_async_destroy,
          _emnapi_node_emit_async_init,
          _emnapi_node_make_callback,
          napi_close_callback_scope,
          napi_make_callback,
          napi_open_callback_scope
        });
        var emnapiTSFN = {
          _liveSet: {},
          offset: {
            __size__: 0,
            resource: 0,
            async_id: 0,
            trigger_async_id: 0,
            queue_size: 0,
            is_some: 0,
            queue: 0,
            async_pending: 0,
            async_u_fd: 0,
            thread_count: 0,
            state: 0,
            dispatch_state: 0,
            context: 0,
            max_queue_size: 0,
            ref: 0,
            env: 0,
            finalize_data: 0,
            finalize_cb: 0,
            call_js_cb: 0,
            handles_closing: 0,
            async_ref: 0,
            mutex: 0,
            cond: 0
          },
          init: function() {
            emnapiTSFN._liveSet = /* @__PURE__ */ new Set();
            emnapiTSFN.offset.__size__ = 184;
            emnapiTSFN.offset.resource = 0;
            emnapiTSFN.offset.async_id = 8;
            emnapiTSFN.offset.trigger_async_id = 16;
            emnapiTSFN.offset.queue_size = 60;
            emnapiTSFN.offset.is_some = 24;
            emnapiTSFN.offset.queue = 64;
            emnapiTSFN.offset.async_pending = 132;
            emnapiTSFN.offset.async_u_fd = 96;
            emnapiTSFN.offset.thread_count = 136;
            emnapiTSFN.offset.state = 140;
            emnapiTSFN.offset.dispatch_state = 144;
            emnapiTSFN.offset.context = 148;
            emnapiTSFN.offset.max_queue_size = 152;
            emnapiTSFN.offset.ref = 156;
            emnapiTSFN.offset.env = 160;
            emnapiTSFN.offset.finalize_data = 164;
            emnapiTSFN.offset.finalize_cb = 168;
            emnapiTSFN.offset.call_js_cb = 172;
            emnapiTSFN.offset.handles_closing = 176;
            emnapiTSFN.offset.async_ref = 180;
            emnapiTSFN.offset.mutex = 32;
            emnapiTSFN.offset.cond = 56;
            emnapiTSFN.offset.mutex = emnapiTSFN.offset.mutex + 4;
            if (typeof PThread !== "undefined") {
              PThread.unusedWorkers.forEach(emnapiTSFN.addListener);
              Object.values(PThread.pthreads).forEach(emnapiTSFN.addListener);
              var __original_getNewWorker_1 = PThread.getNewWorker;
              PThread.getNewWorker = function() {
                var r = __original_getNewWorker_1.apply(this, arguments);
                emnapiTSFN.addListener(r);
                return r;
              };
            }
          },
          addListener: function(worker) {
            if (!worker)
              return false;
            if (worker._emnapiTSFNListener)
              return true;
            var handler = function(e) {
              var data = ENVIRONMENT_IS_NODE ? e : e.data;
              var __emnapi__ = data.__emnapi__;
              if (__emnapi__) {
                var type = __emnapi__.type;
                var payload = __emnapi__.payload;
                if (type === "tsfn-send") {
                  var pendng = payload.tsfn + emnapiTSFN.offset.async_pending;
                  if (Atomics.load(new Int32Array(emnapiTSFN.ensureBufferFor(pendng + 4)), pendng >>> 2) !== 0) {
                    emnapiTSFN.enqueue(payload.tsfn);
                  }
                }
              }
            };
            var dispose = function() {
              if (ENVIRONMENT_IS_NODE) {
                worker.off("message", handler);
              } else {
                worker.removeEventListener("message", handler, false);
              }
              delete worker._emnapiTSFNListener;
            };
            worker._emnapiTSFNListener = { handler, dispose };
            if (ENVIRONMENT_IS_NODE) {
              worker.on("message", handler);
            } else {
              worker.addEventListener("message", handler, false);
            }
            return true;
          },
          ensureBufferFor: function(end) {
            var buffer = wasmMemory.buffer;
            if (end > buffer.byteLength) {
              wasmMemory.grow(0);
              buffer = wasmMemory.buffer;
            }
            return buffer;
          },
          initQueue: function(func) {
            var size = 2 * 4;
            var queue = _malloc(size);
            if (!queue)
              return false;
            queue >>>= 0;
            new Uint8Array(emnapiTSFN.ensureBufferFor(queue + size), queue, size).fill(0);
            emnapiTSFN.storeSizeTypeValue(func + emnapiTSFN.offset.queue, queue, false);
            return true;
          },
          destroyQueue: function(func) {
            var queue = emnapiTSFN.loadSizeTypeValue(func + emnapiTSFN.offset.queue, false);
            if (queue) {
              var node = emnapiTSFN.loadSizeTypeValue(queue, false);
              while (node !== 0) {
                var next = emnapiTSFN.loadSizeTypeValue(node + 4, false);
                _free(node);
                node = next;
              }
              _free(queue);
            }
          },
          pushQueue: function(func, data) {
            var queue = emnapiTSFN.loadSizeTypeValue(func + emnapiTSFN.offset.queue, false);
            var head = emnapiTSFN.loadSizeTypeValue(queue, false);
            var tail = emnapiTSFN.loadSizeTypeValue(queue + 4, false);
            var size = 2 * 4;
            var node = _malloc(size);
            if (!node)
              throw new Error("OOM");
            node >>>= 0;
            emnapiTSFN.storeSizeTypeValue(node, data, false);
            emnapiTSFN.storeSizeTypeValue(node + 4, 0, false);
            if (head === 0 && tail === 0) {
              emnapiTSFN.storeSizeTypeValue(queue, node, false);
              emnapiTSFN.storeSizeTypeValue(queue + 4, node, false);
            } else {
              emnapiTSFN.storeSizeTypeValue(tail + 4, node, false);
              emnapiTSFN.storeSizeTypeValue(queue + 4, node, false);
            }
            emnapiTSFN.addQueueSize(func);
          },
          shiftQueue: function(func) {
            var queue = emnapiTSFN.loadSizeTypeValue(func + emnapiTSFN.offset.queue, false);
            var head = emnapiTSFN.loadSizeTypeValue(queue, false);
            if (head === 0)
              return 0;
            var node = head;
            var next = emnapiTSFN.loadSizeTypeValue(head + 4, false);
            emnapiTSFN.storeSizeTypeValue(queue, next, false);
            if (next === 0) {
              emnapiTSFN.storeSizeTypeValue(queue + 4, 0, false);
            }
            emnapiTSFN.storeSizeTypeValue(node + 4, 0, false);
            var value = emnapiTSFN.loadSizeTypeValue(node, false);
            _free(node);
            emnapiTSFN.subQueueSize(func);
            return value;
          },
          push: function(func, data, mode) {
            var mutex = emnapiTSFN.getMutex(func);
            var cond = emnapiTSFN.getCond(func);
            var waitCondition = function() {
              var queueSize = emnapiTSFN.getQueueSize(func);
              var maxSize = emnapiTSFN.getMaxQueueSize(func);
              return queueSize >= maxSize && maxSize > 0 && emnapiTSFN.getState(func) === 0;
            };
            var isBrowserMain = typeof window !== "undefined" && typeof document !== "undefined" && !ENVIRONMENT_IS_NODE;
            var shouldDelete = false;
            var ret = mutex.execute(function() {
              while (waitCondition()) {
                if (mode === 0) {
                  return 15;
                }
                if (isBrowserMain) {
                  return 21;
                }
                cond.wait();
              }
              if (emnapiTSFN.getState(func) === 0) {
                emnapiTSFN.pushQueue(func, data);
                emnapiTSFN.send(func);
                return 0;
              }
              if (emnapiTSFN.getThreadCount(func) === 0) {
                return 1;
              }
              emnapiTSFN.subThreadCount(func);
              if (!(emnapiTSFN.getState(func) === 2 && emnapiTSFN.getThreadCount(func) === 0)) {
                return 16;
              }
              shouldDelete = true;
              return 16;
            });
            if (shouldDelete) {
              emnapiTSFN.destroy(func);
            }
            return ret;
          },
          getMutex: function(func) {
            var index = func + emnapiTSFN.offset.mutex;
            var mutex = {
              lock: function() {
                var isBrowserMain = typeof window !== "undefined" && typeof document !== "undefined" && !ENVIRONMENT_IS_NODE;
                var i32a = new Int32Array(emnapiTSFN.ensureBufferFor(index + 4), index, 1);
                if (isBrowserMain) {
                  while (true) {
                    var oldValue = Atomics.compareExchange(i32a, 0, 0, 10);
                    if (oldValue === 0) {
                      return;
                    }
                  }
                } else {
                  while (true) {
                    var oldValue = Atomics.compareExchange(i32a, 0, 0, 10);
                    if (oldValue === 0) {
                      return;
                    }
                    Atomics.wait(i32a, 0, 10);
                  }
                }
              },
              unlock: function() {
                var i32a = new Int32Array(emnapiTSFN.ensureBufferFor(index + 4), index, 1);
                var oldValue = Atomics.compareExchange(i32a, 0, 10, 0);
                if (oldValue !== 10) {
                  throw new Error("Tried to unlock while not holding the mutex");
                }
                Atomics.notify(i32a, 0, 1);
              },
              execute: function(fn) {
                mutex.lock();
                try {
                  return fn();
                } finally {
                  mutex.unlock();
                }
              }
            };
            return mutex;
          },
          getCond: function(func) {
            var index = func + emnapiTSFN.offset.cond;
            var mutex = emnapiTSFN.getMutex(func);
            var cond = {
              wait: function() {
                var i32a = new Int32Array(emnapiTSFN.ensureBufferFor(index + 4), index, 1);
                var value = Atomics.load(i32a, 0);
                mutex.unlock();
                Atomics.wait(i32a, 0, value);
                mutex.lock();
              },
              signal: function() {
                var i32a = new Int32Array(emnapiTSFN.ensureBufferFor(index + 4), index, 1);
                Atomics.add(i32a, 0, 1);
                Atomics.notify(i32a, 0, 1);
              }
            };
            return cond;
          },
          getQueueSize: function(func) {
            return emnapiTSFN.loadSizeTypeValue(func + emnapiTSFN.offset.queue_size, true);
          },
          addQueueSize: function(func) {
            var offset = emnapiTSFN.offset.queue_size;
            var arr, index;
            arr = new Uint32Array(emnapiTSFN.ensureBufferFor(func + offset + 4));
            index = func + offset >>> 2;
            Atomics.add(arr, index, 1);
          },
          subQueueSize: function(func) {
            var offset = emnapiTSFN.offset.queue_size;
            var arr, index;
            arr = new Uint32Array(emnapiTSFN.ensureBufferFor(func + offset + 4));
            index = func + offset >>> 2;
            Atomics.sub(arr, index, 1);
          },
          getThreadCount: function(func) {
            return emnapiTSFN.loadSizeTypeValue(func + emnapiTSFN.offset.thread_count, true);
          },
          addThreadCount: function(func) {
            var offset = emnapiTSFN.offset.thread_count;
            var arr, index;
            arr = new Uint32Array(emnapiTSFN.ensureBufferFor(func + offset + 4));
            index = func + offset >>> 2;
            Atomics.add(arr, index, 1);
          },
          subThreadCount: function(func) {
            var offset = emnapiTSFN.offset.thread_count;
            var arr, index;
            arr = new Uint32Array(emnapiTSFN.ensureBufferFor(func + offset + 4));
            index = func + offset >>> 2;
            Atomics.sub(arr, index, 1);
          },
          getState: function(func) {
            return Atomics.load(new Int32Array(emnapiTSFN.ensureBufferFor(func + emnapiTSFN.offset.state + 4)), func + emnapiTSFN.offset.state >>> 2);
          },
          setState: function(func, value) {
            Atomics.store(new Int32Array(emnapiTSFN.ensureBufferFor(func + emnapiTSFN.offset.state + 4)), func + emnapiTSFN.offset.state >>> 2, value);
          },
          getHandlesClosing: function(func) {
            return Atomics.load(new Int8Array(emnapiTSFN.ensureBufferFor(func + emnapiTSFN.offset.handles_closing + 1)), func + emnapiTSFN.offset.handles_closing);
          },
          setHandlesClosing: function(func, value) {
            Atomics.store(new Int8Array(emnapiTSFN.ensureBufferFor(func + emnapiTSFN.offset.handles_closing + 1)), func + emnapiTSFN.offset.handles_closing, value);
          },
          getDispatchState: function(func) {
            return Atomics.load(new Uint32Array(emnapiTSFN.ensureBufferFor(func + emnapiTSFN.offset.dispatch_state + 4)), func + emnapiTSFN.offset.dispatch_state >>> 2);
          },
          getContext: function(func) {
            return emnapiTSFN.loadSizeTypeValue(func + emnapiTSFN.offset.context, false);
          },
          getMaxQueueSize: function(func) {
            return emnapiTSFN.loadSizeTypeValue(func + emnapiTSFN.offset.max_queue_size, true);
          },
          getEnv: function(func) {
            return emnapiTSFN.loadSizeTypeValue(func + emnapiTSFN.offset.env, false);
          },
          getCallJSCb: function(func) {
            return emnapiTSFN.loadSizeTypeValue(func + emnapiTSFN.offset.call_js_cb, false);
          },
          getRef: function(func) {
            return emnapiTSFN.loadSizeTypeValue(func + emnapiTSFN.offset.ref, false);
          },
          getResource: function(func) {
            return emnapiTSFN.loadSizeTypeValue(func + emnapiTSFN.offset.resource, false);
          },
          getFinalizeCb: function(func) {
            return emnapiTSFN.loadSizeTypeValue(func + emnapiTSFN.offset.finalize_cb, false);
          },
          getFinalizeData: function(func) {
            return emnapiTSFN.loadSizeTypeValue(func + emnapiTSFN.offset.finalize_data, false);
          },
          loadSizeTypeValue: function(offset, unsigned) {
            var ret;
            var arr;
            if (unsigned) {
              arr = new Uint32Array(emnapiTSFN.ensureBufferFor(offset + 4));
              ret = Atomics.load(arr, offset >>> 2);
              return ret;
            } else {
              arr = new Int32Array(emnapiTSFN.ensureBufferFor(offset + 4));
              ret = Atomics.load(arr, offset >>> 2);
              return ret;
            }
          },
          storeSizeTypeValue: function(offset, value, unsigned) {
            var arr;
            if (unsigned) {
              arr = new Uint32Array(emnapiTSFN.ensureBufferFor(offset + 4));
              Atomics.store(arr, offset >>> 2, value);
              return void 0;
            } else {
              arr = new Int32Array(emnapiTSFN.ensureBufferFor(offset + 4));
              Atomics.store(arr, offset >>> 2, value >>> 0);
              return void 0;
            }
          },
          releaseResources: function(func) {
            if (emnapiTSFN.getState(func) !== 2) {
              emnapiTSFN.setState(func, 2);
              var env = emnapiTSFN.getEnv(func);
              var envObject = emnapiCtx.envStore.get(env);
              var ref = emnapiTSFN.getRef(func);
              if (ref) {
                emnapiCtx.refStore.get(ref).dispose();
              }
              var resource = emnapiTSFN.getResource(func);
              emnapiCtx.refStore.get(resource).dispose();
              emnapiTSFN.ensureBufferFor(func + emnapiTSFN.offset.is_some + 1);
              var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
              HEAP_DATA_VIEW.setInt8(func + emnapiTSFN.offset.is_some, 0, true);
              emnapiCtx.removeCleanupHook(envObject, emnapiTSFN.cleanup, func);
              envObject.unref();
              var asyncRefAddress = func + emnapiTSFN.offset.async_ref;
              var asyncRefOffset = asyncRefAddress >>> 2;
              var arr = new Uint32Array(emnapiTSFN.ensureBufferFor(asyncRefAddress + 4));
              if (Atomics.load(arr, asyncRefOffset) > 0) {
                Atomics.store(arr, asyncRefOffset, 0);
                emnapiCtx.decreaseWaitingRequestCounter();
              }
              if (emnapiNodeBinding) {
                var view = new DataView(emnapiTSFN.ensureBufferFor(func + emnapiTSFN.offset.trigger_async_id + 8));
                var asyncId = view.getFloat64(func + emnapiTSFN.offset.async_id, true);
                var triggerAsyncId = view.getFloat64(func + emnapiTSFN.offset.trigger_async_id, true);
                _emnapi_node_emit_async_destroy(asyncId, triggerAsyncId);
              }
            }
          },
          destroy: function(func) {
            emnapiTSFN._liveSet.delete(func);
            emnapiTSFN.destroyQueue(func);
            emnapiTSFN.releaseResources(func);
            _free(func);
          },
          emptyQueue: function(func) {
            var drainQueue = [];
            emnapiTSFN.getMutex(func).execute(function() {
              while (emnapiTSFN.getQueueSize(func) > 0) {
                drainQueue.push(emnapiTSFN.shiftQueue(func));
              }
            });
            var callJsCb = emnapiTSFN.getCallJSCb(func);
            var context2 = emnapiTSFN.getContext(func);
            var data;
            for (var i = 0; i < drainQueue.length; i++) {
              data = drainQueue[i];
              if (callJsCb) {
                wasmTable.get(callJsCb)(0, 0, context2, data);
              }
            }
          },
          maybeDelete: function(func) {
            var shouldDelete = false;
            emnapiTSFN.getMutex(func).execute(function() {
              if (emnapiTSFN.getThreadCount(func) > 0) {
                emnapiTSFN.releaseResources(func);
              } else {
                shouldDelete = true;
              }
            });
            if (shouldDelete) {
              emnapiTSFN.destroy(func);
            }
          },
          finalize: function(func) {
            var env = emnapiTSFN.getEnv(func);
            var envObject = emnapiCtx.envStore.get(env);
            emnapiCtx.openScope(envObject);
            var finalize = emnapiTSFN.getFinalizeCb(func);
            var data = emnapiTSFN.getFinalizeData(func);
            var context2 = emnapiTSFN.getContext(func);
            var f = function() {
              envObject.callFinalizerInternal(0, finalize, data, context2);
            };
            try {
              emnapiTSFN.emptyQueue(func);
              if (finalize) {
                if (emnapiNodeBinding) {
                  var resource = emnapiTSFN.getResource(func);
                  var resource_value = emnapiCtx.refStore.get(resource).get();
                  var resourceObject = emnapiCtx.handleStore.get(resource_value).value;
                  var view = new DataView(emnapiTSFN.ensureBufferFor(func + emnapiTSFN.offset.trigger_async_id + 8));
                  var asyncId = view.getFloat64(func + emnapiTSFN.offset.async_id, true);
                  var triggerAsyncId = view.getFloat64(func + emnapiTSFN.offset.trigger_async_id, true);
                  emnapiNodeBinding.node.makeCallback(resourceObject, f, [], {
                    asyncId,
                    triggerAsyncId
                  });
                } else {
                  f();
                }
              }
              emnapiTSFN.maybeDelete(func);
            } finally {
              emnapiCtx.closeScope(envObject);
            }
          },
          cleanup: function(func) {
            emnapiTSFN.closeHandlesAndMaybeDelete(func, 1);
          },
          closeHandlesAndMaybeDelete: function(func, set_closing) {
            var env = emnapiTSFN.getEnv(func);
            var envObject = emnapiCtx.envStore.get(env);
            emnapiCtx.openScope(envObject);
            try {
              if (set_closing) {
                emnapiTSFN.getMutex(func).execute(function() {
                  emnapiTSFN.setState(func, 1);
                  if (emnapiTSFN.getMaxQueueSize(func) > 0) {
                    emnapiTSFN.getCond(func).signal();
                  }
                });
              }
              if (emnapiTSFN.getHandlesClosing(func)) {
                return;
              }
              emnapiTSFN.setHandlesClosing(func, 1);
              Atomics.store(new Int32Array(emnapiTSFN.ensureBufferFor(func + emnapiTSFN.offset.async_pending + 4)), func + emnapiTSFN.offset.async_pending >>> 2, 1);
              emnapiCtx.feature.setImmediate(function() {
                emnapiTSFN.finalize(func);
              });
            } finally {
              emnapiCtx.closeScope(envObject);
            }
          },
          dispatchOne: function(func) {
            var data = 0;
            var popped_value = false;
            var has_more = false;
            var mutex = emnapiTSFN.getMutex(func);
            var cond = emnapiTSFN.getCond(func);
            mutex.execute(function() {
              if (emnapiTSFN.getState(func) === 0) {
                var size = emnapiTSFN.getQueueSize(func);
                if (size > 0) {
                  data = emnapiTSFN.shiftQueue(func);
                  popped_value = true;
                  var maxQueueSize = emnapiTSFN.getMaxQueueSize(func);
                  if (size === maxQueueSize && maxQueueSize > 0) {
                    cond.signal();
                  }
                  size--;
                }
                if (size === 0) {
                  if (emnapiTSFN.getThreadCount(func) === 0) {
                    emnapiTSFN.setState(func, 1);
                    if (emnapiTSFN.getMaxQueueSize(func) > 0) {
                      cond.signal();
                    }
                    emnapiTSFN.closeHandlesAndMaybeDelete(func, 0);
                  }
                } else {
                  has_more = true;
                }
              } else {
                emnapiTSFN.closeHandlesAndMaybeDelete(func, 0);
              }
            });
            if (popped_value) {
              var env = emnapiTSFN.getEnv(func);
              var envObject_1 = emnapiCtx.envStore.get(env);
              emnapiCtx.openScope(envObject_1);
              var f = function() {
                envObject_1.callbackIntoModule(false, function() {
                  var callJsCb = emnapiTSFN.getCallJSCb(func);
                  var ref = emnapiTSFN.getRef(func);
                  var js_callback = ref ? emnapiCtx.refStore.get(ref).get() : 0;
                  if (callJsCb) {
                    var context2 = emnapiTSFN.getContext(func);
                    wasmTable.get(callJsCb)(env, js_callback, context2, data);
                  } else {
                    var jsCallback = js_callback ? emnapiCtx.handleStore.get(js_callback).value : null;
                    if (typeof jsCallback === "function") {
                      jsCallback();
                    }
                  }
                });
              };
              try {
                if (emnapiNodeBinding) {
                  var resource = emnapiTSFN.getResource(func);
                  var resource_value = emnapiCtx.refStore.get(resource).get();
                  var resourceObject = emnapiCtx.handleStore.get(resource_value).value;
                  var view = new DataView(emnapiTSFN.ensureBufferFor(func + emnapiTSFN.offset.trigger_async_id + 8));
                  emnapiNodeBinding.node.makeCallback(resourceObject, f, [], {
                    asyncId: view.getFloat64(func + emnapiTSFN.offset.async_id, true),
                    triggerAsyncId: view.getFloat64(func + emnapiTSFN.offset.trigger_async_id, true)
                  });
                } else {
                  f();
                }
              } finally {
                emnapiCtx.closeScope(envObject_1);
              }
            }
            return has_more;
          },
          dispatch: function(func) {
            var has_more = true;
            var iterations_left = 1e3;
            var dispatchStateAddress = func + emnapiTSFN.offset.dispatch_state;
            var ui32a = new Uint32Array(emnapiTSFN.ensureBufferFor(dispatchStateAddress + 4));
            var index = dispatchStateAddress >>> 2;
            while (has_more && --iterations_left !== 0) {
              Atomics.store(ui32a, index, 1);
              has_more = emnapiTSFN.dispatchOne(func);
              if (Atomics.exchange(ui32a, index, 0) !== 1) {
                has_more = true;
              }
            }
            if (has_more) {
              emnapiTSFN.send(func);
            }
          },
          enqueue: function(func) {
            var pending = func + emnapiTSFN.offset.async_pending;
            var scheduled = func + emnapiTSFN.offset.async_u_fd;
            var i32a = new Int32Array(emnapiTSFN.ensureBufferFor(Math.max(pending, scheduled) + 4));
            if (Atomics.exchange(i32a, scheduled >>> 2, 1) !== 0) {
              return;
            }
            emnapiCtx.feature.setImmediate(function() {
              if (!emnapiTSFN._liveSet.has(func)) {
                return;
              }
              if (Atomics.load(i32a, pending >>> 2) === 0) {
                Atomics.store(i32a, scheduled >>> 2, 0);
                return;
              }
              emnapiCtx.feature.setImmediate(function() {
                try {
                  if (Atomics.exchange(i32a, pending >>> 2, 0) === 0) {
                    return;
                  }
                  if (!emnapiTSFN._liveSet.has(func)) {
                    return;
                  }
                  emnapiTSFN.dispatch(func);
                } finally {
                  if (emnapiTSFN._liveSet.has(func)) {
                    Atomics.store(i32a, scheduled >>> 2, 0);
                    if (Atomics.load(i32a, pending >>> 2) !== 0) {
                      emnapiTSFN.enqueue(func);
                    }
                  }
                }
              });
            });
          },
          send: function(func) {
            var dispatchStateAddress = func + emnapiTSFN.offset.dispatch_state;
            var current_state = Atomics.or(new Uint32Array(emnapiTSFN.ensureBufferFor(dispatchStateAddress + 4)), dispatchStateAddress >>> 2, 1 << 1);
            if ((current_state & 1) === 1) {
              return;
            }
            var pendng = func + emnapiTSFN.offset.async_pending;
            if (Atomics.load(new Int32Array(emnapiTSFN.ensureBufferFor(pendng + 4)), pendng >>> 2) !== 0) {
              return;
            }
            if (Atomics.exchange(new Int32Array(emnapiTSFN.ensureBufferFor(pendng + 4)), pendng >>> 2, 1) === 0) {
              if (typeof ENVIRONMENT_IS_PTHREAD !== "undefined" && ENVIRONMENT_IS_PTHREAD) {
                postMessage({
                  __emnapi__: {
                    type: "tsfn-send",
                    payload: {
                      tsfn: func
                    }
                  }
                });
              } else {
                emnapiTSFN.enqueue(func);
              }
            }
          }
        };
        function napi_create_threadsafe_function(env, func, async_resource, async_resource_name, max_queue_size, initial_thread_count, thread_finalize_data, thread_finalize_cb, context2, call_js_cb, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!async_resource_name)
            return envObject.setLastError(1);
          max_queue_size >>>= 0;
          initial_thread_count >>>= 0;
          env >>>= 0;
          thread_finalize_data >>>= 0;
          thread_finalize_cb >>>= 0;
          context2 >>>= 0;
          call_js_cb >>>= 0;
          max_queue_size = max_queue_size >>> 0;
          initial_thread_count = initial_thread_count >>> 0;
          if (initial_thread_count === 0) {
            return envObject.setLastError(1);
          }
          if (!result)
            return envObject.setLastError(1);
          var ref = 0;
          func >>>= 0;
          if (!func) {
            if (!call_js_cb)
              return envObject.setLastError(1);
          } else {
            var funcValue = emnapiCtx.handleStore.get(func).value;
            if (typeof funcValue !== "function") {
              return envObject.setLastError(1);
            }
            ref = emnapiCtx.createReference(envObject, func, 1, 1).id;
          }
          var asyncResourceObject;
          if (async_resource) {
            asyncResourceObject = emnapiCtx.handleStore.get(async_resource).value;
            if (asyncResourceObject == null) {
              return envObject.setLastError(2);
            }
            asyncResourceObject = Object(asyncResourceObject);
          } else {
            asyncResourceObject = {};
          }
          var resource = envObject.ensureHandleId(asyncResourceObject);
          var asyncResourceName = emnapiCtx.handleStore.get(async_resource_name).value;
          if (typeof asyncResourceName === "symbol") {
            return envObject.setLastError(3);
          }
          asyncResourceName = String(asyncResourceName);
          var resource_name = envObject.ensureHandleId(asyncResourceName);
          var sizeofTSFN = emnapiTSFN.offset.__size__;
          var tsfn = _malloc(sizeofTSFN);
          if (!tsfn)
            return envObject.setLastError(9);
          tsfn >>>= 0;
          new Uint8Array(emnapiTSFN.ensureBufferFor(tsfn + sizeofTSFN)).subarray(tsfn, tsfn + sizeofTSFN).fill(0);
          var resourceRef = emnapiCtx.createReference(envObject, resource, 1, 1);
          var resource_ = resourceRef.id;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(tsfn + emnapiTSFN.offset.resource, resource_, true);
          if (!emnapiTSFN.initQueue(tsfn)) {
            _free(tsfn);
            resourceRef.dispose();
            return envObject.setLastError(9);
          }
          _emnapi_node_emit_async_init(resource, resource_name, -1, tsfn + emnapiTSFN.offset.async_id);
          HEAP_DATA_VIEW.setInt8(tsfn + emnapiTSFN.offset.is_some, 1, true);
          HEAP_DATA_VIEW.setUint32(tsfn + emnapiTSFN.offset.thread_count, initial_thread_count, true);
          HEAP_DATA_VIEW.setUint32(tsfn + emnapiTSFN.offset.context, context2, true);
          HEAP_DATA_VIEW.setUint32(tsfn + emnapiTSFN.offset.max_queue_size, max_queue_size, true);
          HEAP_DATA_VIEW.setUint32(tsfn + emnapiTSFN.offset.ref, ref, true);
          HEAP_DATA_VIEW.setUint32(tsfn + emnapiTSFN.offset.env, env, true);
          HEAP_DATA_VIEW.setUint32(tsfn + emnapiTSFN.offset.finalize_data, thread_finalize_data, true);
          HEAP_DATA_VIEW.setUint32(tsfn + emnapiTSFN.offset.finalize_cb, thread_finalize_cb, true);
          HEAP_DATA_VIEW.setUint32(tsfn + emnapiTSFN.offset.call_js_cb, call_js_cb, true);
          emnapiCtx.addCleanupHook(envObject, emnapiTSFN.cleanup, tsfn);
          emnapiTSFN._liveSet.add(tsfn);
          envObject.ref();
          emnapiCtx.increaseWaitingRequestCounter();
          HEAP_DATA_VIEW.setUint32(tsfn + emnapiTSFN.offset.async_ref, 1, true);
          result >>>= 0;
          HEAP_DATA_VIEW.setUint32(result, tsfn, true);
          return envObject.clearLastError();
        }
        function napi_get_threadsafe_function_context(func, result) {
          if (!func || !result) {
            abort();
            return 1;
          }
          func >>>= 0;
          result >>>= 0;
          var context2 = emnapiTSFN.getContext(func);
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, context2, true);
          return 0;
        }
        function napi_call_threadsafe_function(func, data, mode) {
          if (!func) {
            abort();
            return 1;
          }
          func >>>= 0;
          data >>>= 0;
          return emnapiTSFN.push(func, data, mode);
        }
        function napi_acquire_threadsafe_function(func) {
          if (!func) {
            abort();
            return 1;
          }
          func >>>= 0;
          var mutex = emnapiTSFN.getMutex(func);
          return mutex.execute(function() {
            if (emnapiTSFN.getState(func) === 0) {
              emnapiTSFN.addThreadCount(func);
              return 0;
            }
            return 16;
          });
        }
        function napi_release_threadsafe_function(func, mode) {
          if (!func) {
            abort();
            return 1;
          }
          func >>>= 0;
          var mutex = emnapiTSFN.getMutex(func);
          var cond = emnapiTSFN.getCond(func);
          var shouldDelete = false;
          var ret = mutex.execute(function() {
            if (emnapiTSFN.getThreadCount(func) === 0) {
              return 1;
            }
            emnapiTSFN.subThreadCount(func);
            if (emnapiTSFN.getThreadCount(func) === 0 || mode === 1) {
              if (emnapiTSFN.getState(func) === 0) {
                if (mode === 1) {
                  emnapiTSFN.setState(func, 1);
                }
                if (emnapiTSFN.getState(func) === 1 && emnapiTSFN.getMaxQueueSize(func) > 0) {
                  cond.signal();
                }
                emnapiTSFN.send(func);
              }
            }
            if (!(emnapiTSFN.getState(func) === 2 && emnapiTSFN.getThreadCount(func) === 0)) {
              return 0;
            }
            shouldDelete = true;
            return 0;
          });
          if (shouldDelete) {
            emnapiTSFN.destroy(func);
          }
          return ret;
        }
        function napi_unref_threadsafe_function(env, func) {
          if (!func) {
            abort();
            return 1;
          }
          func >>>= 0;
          var asyncRefAddress = func + emnapiTSFN.offset.async_ref;
          var asyncRefOffset = asyncRefAddress >>> 2;
          var arr = new Uint32Array(emnapiTSFN.ensureBufferFor(asyncRefAddress + 4));
          var currentValue = Atomics.load(arr, asyncRefOffset);
          if (currentValue > 0) {
            Atomics.store(arr, asyncRefOffset, currentValue - 1);
            if (currentValue === 1) {
              emnapiCtx.decreaseWaitingRequestCounter();
            }
          }
          return 0;
        }
        function napi_ref_threadsafe_function(env, func) {
          if (!func) {
            abort();
            return 1;
          }
          func >>>= 0;
          var asyncRefAddress = func + emnapiTSFN.offset.async_ref;
          var asyncRefOffset = asyncRefAddress >>> 2;
          var arr = new Uint32Array(emnapiTSFN.ensureBufferFor(asyncRefAddress + 4));
          var currentValue = Atomics.load(arr, asyncRefOffset);
          if (!currentValue) {
            emnapiCtx.increaseWaitingRequestCounter();
          }
          Atomics.store(arr, asyncRefOffset, currentValue + 1);
          return 0;
        }
        var emnapiAWMT = {
          pool: [],
          workerReady: null,
          globalAddress: 0,
          globalOffset: {
            idle_threads: 0,
            q: 1 * 4,
            next: 1 * 4,
            prev: 2 * 4,
            mutex: 3 * 4,
            cond: 4 * 4,
            exit_message: 5 * 4,
            end: 7 * 4
          },
          offset: {
            resource: 0,
            async_id: 8,
            trigger_async_id: 16,
            env: 24,
            status: 1 * 4 + 24,
            queue: 2 * 4 + 24,
            queue_next: 2 * 4 + 24,
            queue_prev: 3 * 4 + 24,
            data: 4 * 4 + 24,
            execute: 5 * 4 + 24,
            complete: 6 * 4 + 24,
            end: 7 * 4 + 24
          },
          ensureBufferFor: function(end) {
            var buffer = wasmMemory.buffer;
            if (end > buffer.byteLength) {
              wasmMemory.grow(0);
              buffer = wasmMemory.buffer;
            }
            return buffer;
          },
          init: function() {
            emnapiAWMT.pool = [];
            emnapiAWMT.workerReady = null;
            if (typeof PThread !== "undefined") {
              PThread.unusedWorkers.forEach(emnapiAWMT.addListener);
              Object.values(PThread.pthreads).forEach(emnapiAWMT.addListener);
              var __original_getNewWorker_1 = PThread.getNewWorker;
              PThread.getNewWorker = function() {
                var r = __original_getNewWorker_1.apply(this, arguments);
                emnapiAWMT.addListener(r);
                return r;
              };
            }
          },
          addListener: function(worker) {
            if (!worker)
              return false;
            if (worker._emnapiAWMTListener)
              return true;
            var handler = function(e) {
              var data = ENVIRONMENT_IS_NODE ? e : e.data;
              var __emnapi__ = data.__emnapi__;
              if (__emnapi__) {
                var type = __emnapi__.type;
                var payload = __emnapi__.payload;
                if (type === "async-work-complete") {
                  emnapiAWMT.callComplete(payload.work, 0);
                }
              }
            };
            var dispose = function() {
              if (ENVIRONMENT_IS_NODE) {
                worker.off("message", handler);
              } else {
                worker.removeEventListener("message", handler, false);
              }
              delete worker._emnapiAWMTListener;
            };
            worker._emnapiAWMTListener = { handler, dispose };
            if (ENVIRONMENT_IS_NODE) {
              worker.on("message", handler);
            } else {
              worker.addEventListener("message", handler, false);
            }
            return true;
          },
          initGlobal: function() {
            if (!emnapiAWMT.globalAddress) {
              emnapiAWMT.globalAddress = _malloc(emnapiAWMT.globalOffset.end);
              emnapiAWMT.globalAddress >>>= 0;
              var size = emnapiAWMT.globalOffset.end;
              var addr = emnapiAWMT.globalAddress;
              new Uint8Array(emnapiAWMT.ensureBufferFor(addr + size), addr, size).fill(0);
              emnapiAWMT.queueInit(emnapiAWMT.globalAddress + emnapiAWMT.globalOffset.q);
              emnapiAWMT.queueInit(emnapiAWMT.globalAddress + emnapiAWMT.globalOffset.exit_message);
            }
          },
          terminateWorkers: function() {
            emnapiAWMT.pool.forEach(function(w) {
              var _a, _b;
              (_a = w._emnapiAWMTListener) === null || _a === void 0 ? void 0 : _a.dispose();
              (_b = w._emnapiTSFNListener) === null || _b === void 0 ? void 0 : _b.dispose();
              w.terminate();
            });
            emnapiAWMT.pool.length = 0;
          },
          initWorkers: function(n) {
            if (ENVIRONMENT_IS_PTHREAD) {
              return emnapiAWMT.workerReady || (emnapiAWMT.workerReady = Promise.resolve());
            }
            if (emnapiAWMT.workerReady)
              return emnapiAWMT.workerReady;
            if (!("emnapi_async_worker_create" in wasmInstance.exports)) {
              throw new TypeError("`emnapi_async_worker_create` is not exported, please try to add `--export=emnapi_async_worker_create` to linker flags");
            }
            var emnapi_async_worker_create = wasmInstance.exports.emnapi_async_worker_create;
            var args = [];
            emnapiAWMT.initGlobal();
            for (var i = 0; i < n; ++i) {
              args.push(emnapi_async_worker_create(1, emnapiAWMT.globalAddress));
            }
            var promises = args.map(function(index) {
              if (index === 0) {
                return Promise.reject(new Error("Failed to create async worker"));
              }
              var worker;
              if (index < 0) {
                worker = emnapiAWMT.pool[-index - 1];
                if (worker)
                  return worker.whenLoaded;
              }
              index >>>= 0;
              var tidOffset = 20;
              var view = new DataView(emnapiAWMT.ensureBufferFor(index + tidOffset + 4));
              var tid = view.getInt32(index + tidOffset, true);
              worker = PThread.pthreads[tid];
              return worker.whenLoaded;
            });
            emnapiAWMT.workerReady = Promise.all(promises);
            return emnapiAWMT.workerReady;
          },
          getResource: function(work) {
            emnapiAWMT.ensureBufferFor(work + emnapiAWMT.offset.resource + 4);
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            return HEAP_DATA_VIEW.getUint32(work + emnapiAWMT.offset.resource, true);
          },
          getExecute: function(work) {
            emnapiAWMT.ensureBufferFor(work + emnapiAWMT.offset.execute + 4);
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            return HEAP_DATA_VIEW.getUint32(work + emnapiAWMT.offset.execute, true);
          },
          getComplete: function(work) {
            emnapiAWMT.ensureBufferFor(work + emnapiAWMT.offset.complete + 4);
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            return HEAP_DATA_VIEW.getUint32(work + emnapiAWMT.offset.complete, true);
          },
          getEnv: function(work) {
            emnapiAWMT.ensureBufferFor(work + emnapiAWMT.offset.env + 4);
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            return HEAP_DATA_VIEW.getUint32(work + emnapiAWMT.offset.env, true);
          },
          getData: function(work) {
            emnapiAWMT.ensureBufferFor(work + emnapiAWMT.offset.data + 4);
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            return HEAP_DATA_VIEW.getUint32(work + emnapiAWMT.offset.data, true);
          },
          getMutex: function() {
            var index = emnapiAWMT.globalAddress + emnapiAWMT.globalOffset.mutex;
            var mutex = {
              lock: function() {
                var isBrowserMain = typeof window !== "undefined" && typeof document !== "undefined" && !ENVIRONMENT_IS_NODE;
                var i32a = new Int32Array(emnapiAWMT.ensureBufferFor(index + 4), index, 1);
                if (isBrowserMain) {
                  while (true) {
                    var oldValue = Atomics.compareExchange(i32a, 0, 0, 10);
                    if (oldValue === 0) {
                      return;
                    }
                  }
                } else {
                  while (true) {
                    var oldValue = Atomics.compareExchange(i32a, 0, 0, 10);
                    if (oldValue === 0) {
                      return;
                    }
                    Atomics.wait(i32a, 0, 10);
                  }
                }
              },
              unlock: function() {
                var i32a = new Int32Array(emnapiAWMT.ensureBufferFor(index + 4), index, 1);
                var oldValue = Atomics.compareExchange(i32a, 0, 10, 0);
                if (oldValue !== 10) {
                  throw new Error("Tried to unlock while not holding the mutex");
                }
                Atomics.notify(i32a, 0, 1);
              },
              execute: function(fn) {
                mutex.lock();
                try {
                  return fn();
                } finally {
                  mutex.unlock();
                }
              }
            };
            return mutex;
          },
          getCond: function() {
            var index = emnapiAWMT.globalAddress + emnapiAWMT.globalOffset.cond;
            var mutex = emnapiAWMT.getMutex();
            var cond = {
              wait: function() {
                var i32a = new Int32Array(emnapiAWMT.ensureBufferFor(index + 4), index, 1);
                var value = Atomics.load(i32a, 0);
                mutex.unlock();
                Atomics.wait(i32a, 0, value);
                mutex.lock();
              },
              signal: function() {
                var i32a = new Int32Array(emnapiAWMT.ensureBufferFor(index + 4), index, 1);
                Atomics.add(i32a, 0, 1);
                Atomics.notify(i32a, 0, 1);
              }
            };
            return cond;
          },
          queueInit: function(q) {
            emnapiAWMT.ensureBufferFor(q + 4 + 4);
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(q, q, true);
            HEAP_DATA_VIEW.setUint32(q + 4, q, true);
          },
          queueInsertTail: function(h, q) {
            emnapiAWMT.ensureBufferFor(h + 4 + 4);
            emnapiAWMT.ensureBufferFor(q + 4 + 4);
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(q, h, true);
            var tempValue = HEAP_DATA_VIEW.getUint32(h + 4, true);
            HEAP_DATA_VIEW.setUint32(q + 4, tempValue, true);
            var qprev = HEAP_DATA_VIEW.getUint32(q + 4, true);
            HEAP_DATA_VIEW.setUint32(qprev, q, true);
            HEAP_DATA_VIEW.setUint32(h + 4, q, true);
          },
          queueRemove: function(q) {
            emnapiAWMT.ensureBufferFor(q + 4 + 4);
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            var qprev = HEAP_DATA_VIEW.getUint32(q + 4, true);
            var qnext = HEAP_DATA_VIEW.getUint32(q, true);
            HEAP_DATA_VIEW.setUint32(qprev, qnext, true);
            HEAP_DATA_VIEW.setUint32(qnext + 4, qprev, true);
          },
          queueEmpty: function(q) {
            emnapiAWMT.ensureBufferFor(q + 4);
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            return q == HEAP_DATA_VIEW.getUint32(q, true);
          },
          scheduleWork: function(work) {
            var _a;
            if (!((_a = emnapiAWMT.workerReady) === null || _a === void 0 ? void 0 : _a.ready)) {
              emnapiAWMT.initWorkers(_emnapi_async_work_pool_size()).then(function() {
                emnapiAWMT.workerReady.ready = true;
              }).catch(function(err2) {
                emnapiAWMT.workerReady = null;
                throw err2;
              });
            }
            emnapiCtx.increaseWaitingRequestCounter();
            var statusBuffer = new Int32Array(emnapiAWMT.ensureBufferFor(work + emnapiAWMT.offset.status + 4), work + emnapiAWMT.offset.status, 1);
            Atomics.store(statusBuffer, 0, 0);
            var mutex = emnapiAWMT.getMutex();
            var cond = emnapiAWMT.getCond();
            mutex.lock();
            try {
              emnapiAWMT.queueInsertTail(emnapiAWMT.globalAddress + emnapiAWMT.globalOffset.q, work + emnapiAWMT.offset.queue);
            } catch (err2) {
              emnapiCtx.decreaseWaitingRequestCounter();
              mutex.unlock();
              throw err2;
            }
            emnapiAWMT.ensureBufferFor(emnapiAWMT.globalAddress + emnapiAWMT.globalOffset.idle_threads + 4);
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            if (HEAP_DATA_VIEW.getUint32(emnapiAWMT.globalAddress + emnapiAWMT.globalOffset.idle_threads, true) > 0) {
              cond.signal();
            }
            mutex.unlock();
          },
          cancelWork: function(work) {
            var cancelled = false;
            emnapiAWMT.getMutex().execute(function() {
              emnapiAWMT.ensureBufferFor(work + emnapiAWMT.offset.status + 4);
              var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
              cancelled = !emnapiAWMT.queueEmpty(work + emnapiAWMT.offset.queue) && HEAP_DATA_VIEW.getInt32(work + emnapiAWMT.offset.status, true) !== 2;
              if (cancelled) {
                emnapiAWMT.queueRemove(work + emnapiAWMT.offset.queue);
              }
            });
            if (!cancelled) {
              return 9;
            }
            if (Atomics.compareExchange(new Int32Array(emnapiAWMT.ensureBufferFor(work + emnapiAWMT.offset.status + 4), work + emnapiAWMT.offset.status, 1), 0, 0, 1) !== 0) {
              return 9;
            }
            emnapiCtx.feature.setImmediate(function() {
              emnapiAWMT.callComplete(work, 11);
            });
            return 0;
          },
          callComplete: function(work, status) {
            emnapiCtx.decreaseWaitingRequestCounter();
            var complete = emnapiAWMT.getComplete(work);
            var env = emnapiAWMT.getEnv(work);
            var data = emnapiAWMT.getData(work);
            var envObject = emnapiCtx.envStore.get(env);
            var scope = emnapiCtx.openScope(envObject);
            var callback = function() {
              if (!complete)
                return;
              envObject.callbackIntoModule(true, function() {
                wasmTable.get(complete)(env, status, data);
              });
            };
            try {
              if (emnapiNodeBinding) {
                var resource = emnapiAWMT.getResource(work);
                var resource_value = emnapiCtx.refStore.get(resource).get();
                var resourceObject = emnapiCtx.handleStore.get(resource_value).value;
                var view = new DataView(emnapiAWMT.ensureBufferFor(work + emnapiAWMT.offset.trigger_async_id + 8));
                var asyncId = view.getFloat64(work + emnapiAWMT.offset.async_id, true);
                var triggerAsyncId = view.getFloat64(work + emnapiAWMT.offset.trigger_async_id, true);
                emnapiNodeBinding.node.makeCallback(resourceObject, callback, [], {
                  asyncId,
                  triggerAsyncId
                });
              } else {
                callback();
              }
            } finally {
              emnapiCtx.closeScope(envObject, scope);
            }
          }
        };
        emnapiAWMT.init();
        var napi_create_async_work = singleThreadAsyncWork ? function(env, resource, resource_name, execute, complete, data, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!execute)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          var resourceObject;
          if (resource) {
            resourceObject = Object(emnapiCtx.handleStore.get(resource).value);
          } else {
            resourceObject = {};
          }
          if (!resource_name)
            return envObject.setLastError(1);
          var resourceName = String(emnapiCtx.handleStore.get(resource_name).value);
          var id = emnapiAWST.create(env, resourceObject, resourceName, execute, complete, data);
          result >>>= 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, id, true);
          return envObject.clearLastError();
        } : function(env, resource, resource_name, execute, complete, data, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!execute)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          var resourceObject;
          if (resource) {
            resourceObject = Object(emnapiCtx.handleStore.get(resource).value);
          } else {
            resourceObject = {};
          }
          if (!resource_name)
            return envObject.setLastError(1);
          var sizeofAW = emnapiAWMT.offset.end;
          var aw = _malloc(sizeofAW);
          if (!aw)
            return envObject.setLastError(9);
          aw >>>= 0;
          new Uint8Array(emnapiAWMT.ensureBufferFor(aw + sizeofAW)).subarray(aw, aw + sizeofAW).fill(0);
          var s = envObject.ensureHandleId(resourceObject);
          var resourceRef = emnapiCtx.createReference(envObject, s, 1, 1);
          var resource_ = resourceRef.id;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(aw, resource_, true);
          _emnapi_node_emit_async_init(s, resource_name, -1, aw + emnapiAWMT.offset.async_id);
          HEAP_DATA_VIEW.setUint32(aw + emnapiAWMT.offset.env, env, true);
          HEAP_DATA_VIEW.setUint32(aw + emnapiAWMT.offset.execute, execute, true);
          HEAP_DATA_VIEW.setUint32(aw + emnapiAWMT.offset.complete, complete, true);
          HEAP_DATA_VIEW.setUint32(aw + emnapiAWMT.offset.data, data, true);
          emnapiAWMT.queueInit(aw + emnapiAWMT.offset.queue);
          result >>>= 0;
          HEAP_DATA_VIEW.setUint32(result, aw, true);
          return envObject.clearLastError();
        };
        var napi_delete_async_work = singleThreadAsyncWork ? function(env, work) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!work)
            return envObject.setLastError(1);
          work >>>= 0;
          emnapiAWST.remove(work);
          return envObject.clearLastError();
        } : function(env, work) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!work)
            return envObject.setLastError(1);
          work >>>= 0;
          var resource = emnapiAWMT.getResource(work);
          emnapiCtx.refStore.get(resource).dispose();
          if (emnapiNodeBinding) {
            var view = new DataView(emnapiAWMT.ensureBufferFor(work + emnapiAWMT.offset.trigger_async_id + 8));
            var asyncId = view.getFloat64(work + emnapiAWMT.offset.async_id, true);
            var triggerAsyncId = view.getFloat64(work + emnapiAWMT.offset.trigger_async_id, true);
            _emnapi_node_emit_async_destroy(asyncId, triggerAsyncId);
          }
          _free(work);
          return envObject.clearLastError();
        };
        var napi_queue_async_work = singleThreadAsyncWork ? function(env, work) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          if (!work)
            return envObject.setLastError(1);
          work >>>= 0;
          emnapiAWST.queue(work);
          return envObject.clearLastError();
        } : function(env, work) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          if (!work)
            return envObject.setLastError(1);
          work >>>= 0;
          emnapiAWMT.scheduleWork(work);
          return envObject.clearLastError();
        };
        var napi_cancel_async_work = singleThreadAsyncWork ? function(env, work) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          if (!work)
            return envObject.setLastError(1);
          work >>>= 0;
          var status = emnapiAWST.cancel(work);
          if (status === 0)
            return envObject.clearLastError();
          return envObject.setLastError(status);
        } : function(env, work) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          if (!work)
            return envObject.setLastError(1);
          work >>>= 0;
          var status = emnapiAWMT.cancelWork(work);
          if (status === 0)
            return envObject.clearLastError();
          return envObject.setLastError(status);
        };
        function _emnapi_async_worker(globalAddress) {
          globalAddress >>>= 0;
          emnapiAWMT.globalAddress = globalAddress;
          var mutex = emnapiAWMT.getMutex();
          var cond = emnapiAWMT.getCond();
          mutex.lock();
          var exitMessageAddr = globalAddress + emnapiAWMT.globalOffset.exit_message;
          var idleThreadsAddr = globalAddress + emnapiAWMT.globalOffset.idle_threads;
          var workerQueueAddr = globalAddress + emnapiAWMT.globalOffset.q;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          for (; ; ) {
            emnapiAWMT.ensureBufferFor(workerQueueAddr + 4);
            while (emnapiAWMT.queueEmpty(workerQueueAddr)) {
              Atomics.add(new Int32Array(emnapiAWMT.ensureBufferFor(idleThreadsAddr + 4), idleThreadsAddr, 1), 0, 1);
              cond.wait();
              Atomics.sub(new Int32Array(emnapiAWMT.ensureBufferFor(idleThreadsAddr + 4), idleThreadsAddr, 1), 0, 1);
            }
            var q = HEAP_DATA_VIEW.getUint32(workerQueueAddr, true);
            if (q === exitMessageAddr) {
              cond.signal();
              mutex.unlock();
              break;
            }
            var work = q - emnapiAWMT.offset.queue;
            emnapiAWMT.queueRemove(q);
            emnapiAWMT.queueInit(q);
            mutex.unlock();
            var statusBuffer = new Int32Array(emnapiAWMT.ensureBufferFor(work + emnapiAWMT.offset.status + 4), work + emnapiAWMT.offset.status, 1);
            if (Atomics.load(statusBuffer, 0) === 1) {
              abort("unreachable");
            }
            var execute = emnapiAWMT.getExecute(work);
            var env = emnapiAWMT.getEnv(work);
            var data = emnapiAWMT.getData(work);
            wasmTable.get(execute)(env, data);
            Atomics.store(statusBuffer, 0, 2);
            var postMessage_1 = napiModule2.postMessage;
            postMessage_1({
              __emnapi__: {
                type: "async-work-complete",
                payload: { work }
              }
            });
            mutex.lock();
          }
          return 0;
        }
        function _emnapi_spawn_worker(f, globalAddress) {
          if (typeof onCreateWorker !== "function") {
            throw new TypeError("`options.onCreateWorker` is not a function");
          }
          var promises = [];
          var args = [];
          if (!("emnapi_async_worker_create" in wasmInstance.exports)) {
            throw new TypeError("`emnapi_async_worker_create` is not exported, please try to add `--export=emnapi_async_worker_create` to linker flags");
          }
          args.push(wasmInstance.exports.emnapi_async_worker_create(0, 0));
          var handleError = function(e) {
            if ("message" in e && (e.message.indexOf("RuntimeError") !== -1 || e.message.indexOf("unreachable") !== -1)) {
              emnapiAWMT.terminateWorkers();
            }
          };
          var ret;
          try {
            var worker_1 = onCreateWorker({ type: "async-work", name: "emnapi-async-worker" });
            var p = PThread.loadWasmModuleToWorker(worker_1);
            if (ENVIRONMENT_IS_NODE) {
              worker_1.on("error", handleError);
            } else {
              worker_1.addEventListener("error", handleError, false);
            }
            emnapiAWMT.addListener(worker_1);
            emnapiTSFN.addListener(worker_1);
            promises.push(p.then(function() {
              if (typeof worker_1.unref === "function") {
                worker_1.unref();
              }
            }));
            ret = emnapiAWMT.pool.push(worker_1) - 1;
            var arg = args[0];
            worker_1.threadBlockBase = arg;
            worker_1.postMessage({
              __emnapi__: {
                type: "async-worker-init",
                payload: { arg, func: [f, globalAddress] }
              }
            });
          } catch (err2) {
            var arg = args[0];
            _free(arg);
            throw err2;
          }
          return ret;
        }
        function initWorker(startArg, func) {
          if (napiModule2.childThread) {
            if (typeof wasmInstance.exports.emnapi_async_worker_init !== "function") {
              throw new TypeError("`emnapi_async_worker_init` is not exported, please try to add `--export=emnapi_async_worker_init` to linker flags");
            }
            wasmInstance.exports.emnapi_async_worker_init(startArg);
            wasmTable.get(func[0])(func[1]);
          } else {
            throw new Error("startThread is only available in child threads");
          }
        }
        napiModule2.initWorker = initWorker;
        var asyncWorkMod = Object.freeze({
          __proto__: null,
          _emnapi_async_worker,
          _emnapi_spawn_worker,
          napi_cancel_async_work,
          napi_create_async_work,
          napi_delete_async_work,
          napi_queue_async_work
        });
        var emnapiExternalMemory = {
          registry: typeof FinalizationRegistry === "function" ? new FinalizationRegistry(function(_pointer) {
            _free(_pointer);
          }) : void 0,
          table: /* @__PURE__ */ new WeakMap(),
          wasmMemoryViewTable: /* @__PURE__ */ new WeakMap(),
          init: function() {
            emnapiExternalMemory.registry = typeof FinalizationRegistry === "function" ? new FinalizationRegistry(function(_pointer) {
              _free(_pointer);
            }) : void 0;
            emnapiExternalMemory.table = /* @__PURE__ */ new WeakMap();
            emnapiExternalMemory.wasmMemoryViewTable = /* @__PURE__ */ new WeakMap();
          },
          isSharedArrayBuffer: function(value) {
            return typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer || Object.prototype.toString.call(value) === "[object SharedArrayBuffer]";
          },
          isDetachedArrayBuffer: function(arrayBuffer) {
            if (arrayBuffer.byteLength === 0) {
              try {
                new Uint8Array(arrayBuffer);
              } catch (_) {
                return true;
              }
            }
            return false;
          },
          getArrayBufferPointer: function(arrayBuffer, shouldCopy) {
            var _a;
            var info = {
              address: 0,
              ownership: 0,
              runtimeAllocated: 0
            };
            if (arrayBuffer === wasmMemory.buffer) {
              return info;
            }
            var isDetached = emnapiExternalMemory.isDetachedArrayBuffer(arrayBuffer);
            if (emnapiExternalMemory.table.has(arrayBuffer)) {
              var cachedInfo = emnapiExternalMemory.table.get(arrayBuffer);
              if (isDetached) {
                cachedInfo.address = 0;
                return cachedInfo;
              }
              if (shouldCopy && cachedInfo.ownership === 0 && cachedInfo.runtimeAllocated === 1) {
                new Uint8Array(wasmMemory.buffer).set(new Uint8Array(arrayBuffer), cachedInfo.address);
              }
              return cachedInfo;
            }
            if (isDetached || arrayBuffer.byteLength === 0) {
              return info;
            }
            if (!shouldCopy) {
              return info;
            }
            var pointer = _malloc(arrayBuffer.byteLength);
            if (!pointer)
              throw new Error("Out of memory");
            pointer >>>= 0;
            new Uint8Array(wasmMemory.buffer).set(new Uint8Array(arrayBuffer), pointer);
            info.address = pointer;
            info.ownership = emnapiExternalMemory.registry ? 0 : 1;
            info.runtimeAllocated = 1;
            emnapiExternalMemory.table.set(arrayBuffer, info);
            (_a = emnapiExternalMemory.registry) === null || _a === void 0 ? void 0 : _a.register(arrayBuffer, pointer);
            return info;
          },
          getOrUpdateMemoryView: function(view) {
            if (view.buffer === wasmMemory.buffer) {
              if (!emnapiExternalMemory.wasmMemoryViewTable.has(view)) {
                emnapiExternalMemory.wasmMemoryViewTable.set(view, {
                  Ctor: view.constructor,
                  address: view.byteOffset,
                  length: view instanceof DataView ? view.byteLength : view.length,
                  ownership: 1,
                  runtimeAllocated: 0
                });
              }
              return view;
            }
            var maybeOldWasmMemory = emnapiExternalMemory.isDetachedArrayBuffer(view.buffer) || emnapiExternalMemory.isSharedArrayBuffer(view.buffer);
            if (maybeOldWasmMemory && emnapiExternalMemory.wasmMemoryViewTable.has(view)) {
              var info = emnapiExternalMemory.wasmMemoryViewTable.get(view);
              var Ctor = info.Ctor;
              var newView = void 0;
              var Buffer_1 = emnapiCtx.feature.Buffer;
              if (typeof Buffer_1 === "function" && Ctor === Buffer_1) {
                newView = Buffer_1.from(wasmMemory.buffer, info.address, info.length);
              } else {
                newView = new Ctor(wasmMemory.buffer, info.address, info.length);
              }
              emnapiExternalMemory.wasmMemoryViewTable.set(newView, info);
              return newView;
            }
            return view;
          },
          getViewPointer: function(view, shouldCopy) {
            view = emnapiExternalMemory.getOrUpdateMemoryView(view);
            if (view.buffer === wasmMemory.buffer) {
              if (emnapiExternalMemory.wasmMemoryViewTable.has(view)) {
                var _a = emnapiExternalMemory.wasmMemoryViewTable.get(view), address_1 = _a.address, ownership_1 = _a.ownership, runtimeAllocated_1 = _a.runtimeAllocated;
                return { address: address_1, ownership: ownership_1, runtimeAllocated: runtimeAllocated_1, view };
              }
              return { address: view.byteOffset, ownership: 1, runtimeAllocated: 0, view };
            }
            var _b = emnapiExternalMemory.getArrayBufferPointer(view.buffer, shouldCopy), address = _b.address, ownership = _b.ownership, runtimeAllocated = _b.runtimeAllocated;
            return { address: address === 0 ? 0 : address + view.byteOffset, ownership, runtimeAllocated, view };
          }
        };
        var emnapiExternalSAB = {
          registry: void 0,
          handleTable: /* @__PURE__ */ new WeakMap(),
          init: function() {
            emnapiExternalSAB.handleTable = /* @__PURE__ */ new WeakMap();
            emnapiExternalSAB.registry = typeof FinalizationRegistry === "function" ? new FinalizationRegistry(function(metaPtr) {
              emnapiExternalSAB.release(metaPtr);
            }) : void 0;
          },
          allocMeta: function(external_data, byte_length, finalize_cb, finalize_data, finalize_hint) {
            var size = 4 * 6;
            var metaPtr = _malloc(size);
            if (!metaPtr)
              throw new Error("Out of memory");
            metaPtr >>>= 0;
            Atomics.store(new Int32Array(wasmMemory.buffer, metaPtr, 1), 0, 1);
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(metaPtr + 4, external_data, true);
            HEAP_DATA_VIEW.setUint32(metaPtr + 8, byte_length, true);
            HEAP_DATA_VIEW.setUint32(metaPtr + 12, finalize_cb, true);
            HEAP_DATA_VIEW.setUint32(metaPtr + 16, finalize_data, true);
            HEAP_DATA_VIEW.setUint32(metaPtr + 20, finalize_hint, true);
            return metaPtr;
          },
          readMeta: function(metaPtr) {
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            var external_data = HEAP_DATA_VIEW.getUint32(metaPtr + 4, true);
            var byte_length = HEAP_DATA_VIEW.getUint32(metaPtr + 8, true);
            var finalize_cb = HEAP_DATA_VIEW.getUint32(metaPtr + 12, true);
            var finalize_data = HEAP_DATA_VIEW.getUint32(metaPtr + 16, true);
            var finalize_hint = HEAP_DATA_VIEW.getUint32(metaPtr + 20, true);
            return { external_data, byte_length, finalize_cb, finalize_data, finalize_hint };
          },
          release: function(metaPtr) {
            var oldRefcount = Atomics.sub(new Int32Array(wasmMemory.buffer, metaPtr, 1), 0, 1);
            if (oldRefcount === 1) {
              var info = emnapiExternalSAB.readMeta(metaPtr);
              var finalize_cb = info.finalize_cb;
              if (finalize_cb) {
                var finalize_data = info.finalize_data;
                var finalize_hint = info.finalize_hint;
                wasmTable.get(finalize_cb)(finalize_data, finalize_hint);
              }
              _free(metaPtr);
            }
          }
        };
        var emnapiString = {
          utf8Decoder: void 0,
          utf16Decoder: void 0,
          init: function() {
            var fallbackDecoder = {
              decode: function(bytes) {
                var inputIndex = 0;
                var pendingSize = Math.min(4096, bytes.length + 1);
                var pending = new Uint16Array(pendingSize);
                var chunks = [];
                var pendingIndex = 0;
                for (; ; ) {
                  var more = inputIndex < bytes.length;
                  if (!more || pendingIndex >= pendingSize - 1) {
                    var subarray = pending.subarray(0, pendingIndex);
                    var arraylike = subarray;
                    chunks.push(String.fromCharCode.apply(null, arraylike));
                    if (!more) {
                      return chunks.join("");
                    }
                    bytes = bytes.subarray(inputIndex);
                    inputIndex = 0;
                    pendingIndex = 0;
                  }
                  var byte1 = bytes[inputIndex++];
                  if ((byte1 & 128) === 0) {
                    pending[pendingIndex++] = byte1;
                  } else if ((byte1 & 224) === 192) {
                    var byte2 = bytes[inputIndex++] & 63;
                    pending[pendingIndex++] = (byte1 & 31) << 6 | byte2;
                  } else if ((byte1 & 240) === 224) {
                    var byte2 = bytes[inputIndex++] & 63;
                    var byte3 = bytes[inputIndex++] & 63;
                    pending[pendingIndex++] = (byte1 & 31) << 12 | byte2 << 6 | byte3;
                  } else if ((byte1 & 248) === 240) {
                    var byte2 = bytes[inputIndex++] & 63;
                    var byte3 = bytes[inputIndex++] & 63;
                    var byte4 = bytes[inputIndex++] & 63;
                    var codepoint = (byte1 & 7) << 18 | byte2 << 12 | byte3 << 6 | byte4;
                    if (codepoint > 65535) {
                      codepoint -= 65536;
                      pending[pendingIndex++] = codepoint >>> 10 & 1023 | 55296;
                      codepoint = 56320 | codepoint & 1023;
                    }
                    pending[pendingIndex++] = codepoint;
                  } else ;
                }
              }
            };
            var utf8Decoder;
            utf8Decoder = typeof TextDecoder === "function" ? new TextDecoder() : fallbackDecoder;
            emnapiString.utf8Decoder = utf8Decoder;
            var fallbackDecoder2 = {
              decode: function(input) {
                var bytes = new Uint16Array(input.buffer, input.byteOffset, input.byteLength / 2);
                if (bytes.length <= 4096) {
                  return String.fromCharCode.apply(null, bytes);
                }
                var chunks = [];
                var i = 0;
                var len = 0;
                for (; i < bytes.length; i += len) {
                  len = Math.min(4096, bytes.length - i);
                  chunks.push(String.fromCharCode.apply(null, bytes.subarray(i, i + len)));
                }
                return chunks.join("");
              }
            };
            var utf16Decoder;
            utf16Decoder = typeof TextDecoder === "function" ? new TextDecoder("utf-16le") : fallbackDecoder2;
            emnapiString.utf16Decoder = utf16Decoder;
          },
          lengthBytesUTF8: function(str) {
            var c;
            var len = 0;
            for (var i = 0; i < str.length; ++i) {
              c = str.charCodeAt(i);
              if (c <= 127) {
                len++;
              } else if (c <= 2047) {
                len += 2;
              } else if (c >= 55296 && c <= 57343) {
                len += 4;
                ++i;
              } else {
                len += 3;
              }
            }
            return len;
          },
          UTF8ToString: function(ptr, length) {
            if (!ptr || !length)
              return "";
            ptr >>>= 0;
            var HEAPU8 = new Uint8Array(wasmMemory.buffer);
            var end = ptr;
            if (length === -1 || length === 4294967295) {
              for (; HEAPU8[end]; )
                ++end;
            } else {
              end = ptr + (length >>> 0);
            }
            length = end - ptr;
            if (length <= 16) {
              var idx = ptr;
              var str = "";
              while (idx < end) {
                var u0 = HEAPU8[idx++];
                if (!(u0 & 128)) {
                  str += String.fromCharCode(u0);
                  continue;
                }
                var u1 = HEAPU8[idx++] & 63;
                if ((u0 & 224) === 192) {
                  str += String.fromCharCode((u0 & 31) << 6 | u1);
                  continue;
                }
                var u2 = HEAPU8[idx++] & 63;
                if ((u0 & 240) === 224) {
                  u0 = (u0 & 15) << 12 | u1 << 6 | u2;
                } else {
                  u0 = (u0 & 7) << 18 | u1 << 12 | u2 << 6 | HEAPU8[idx++] & 63;
                }
                if (u0 < 65536) {
                  str += String.fromCharCode(u0);
                } else {
                  var ch = u0 - 65536;
                  str += String.fromCharCode(55296 | ch >> 10, 56320 | ch & 1023);
                }
              }
              return str;
            }
            return emnapiString.utf8Decoder.decode(typeof SharedArrayBuffer === "function" && HEAPU8.buffer instanceof SharedArrayBuffer || Object.prototype.toString.call(HEAPU8.buffer) === "[object SharedArrayBuffer]" ? HEAPU8.slice(ptr, end) : HEAPU8.subarray(ptr, end));
          },
          stringToUTF8: function(str, outPtr, maxBytesToWrite) {
            var HEAPU8 = new Uint8Array(wasmMemory.buffer);
            var outIdx = outPtr;
            outIdx >>>= 0;
            if (!(maxBytesToWrite > 0)) {
              return 0;
            }
            var startIdx = outIdx;
            var endIdx = outIdx + maxBytesToWrite - 1;
            for (var i = 0; i < str.length; ++i) {
              var u = str.charCodeAt(i);
              if (u >= 55296 && u <= 57343) {
                var u1 = str.charCodeAt(++i);
                u = 65536 + ((u & 1023) << 10) | u1 & 1023;
              }
              if (u <= 127) {
                if (outIdx >= endIdx)
                  break;
                HEAPU8[outIdx++] = u;
              } else if (u <= 2047) {
                if (outIdx + 1 >= endIdx)
                  break;
                HEAPU8[outIdx++] = 192 | u >> 6;
                HEAPU8[outIdx++] = 128 | u & 63;
              } else if (u <= 65535) {
                if (outIdx + 2 >= endIdx)
                  break;
                HEAPU8[outIdx++] = 224 | u >> 12;
                HEAPU8[outIdx++] = 128 | u >> 6 & 63;
                HEAPU8[outIdx++] = 128 | u & 63;
              } else {
                if (outIdx + 3 >= endIdx)
                  break;
                HEAPU8[outIdx++] = 240 | u >> 18;
                HEAPU8[outIdx++] = 128 | u >> 12 & 63;
                HEAPU8[outIdx++] = 128 | u >> 6 & 63;
                HEAPU8[outIdx++] = 128 | u & 63;
              }
            }
            HEAPU8[outIdx] = 0;
            return outIdx - startIdx;
          },
          UTF16ToString: function(ptr, length) {
            if (!ptr || !length)
              return "";
            ptr >>>= 0;
            var end = ptr;
            if (length === -1 || length === 4294967295) {
              var idx = end >>> 1;
              var HEAPU16 = new Uint16Array(wasmMemory.buffer);
              while (HEAPU16[idx])
                ++idx;
              end = idx << 1 >>> 0;
            } else {
              end = ptr + (length >>> 0) * 2;
            }
            length = end - ptr;
            if (length <= 32) {
              return String.fromCharCode.apply(null, new Uint16Array(wasmMemory.buffer, ptr, length / 2));
            }
            var HEAPU8 = new Uint8Array(wasmMemory.buffer);
            return emnapiString.utf16Decoder.decode(typeof SharedArrayBuffer === "function" && HEAPU8.buffer instanceof SharedArrayBuffer || Object.prototype.toString.call(HEAPU8.buffer) === "[object SharedArrayBuffer]" ? HEAPU8.slice(ptr, end) : HEAPU8.subarray(ptr, end));
          },
          stringToUTF16: function(str, outPtr, maxBytesToWrite) {
            if (maxBytesToWrite === void 0) {
              maxBytesToWrite = 2147483647;
            }
            if (maxBytesToWrite < 2)
              return 0;
            maxBytesToWrite -= 2;
            var startPtr = outPtr;
            var numCharsToWrite = maxBytesToWrite < str.length * 2 ? maxBytesToWrite / 2 : str.length;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            for (var i = 0; i < numCharsToWrite; ++i) {
              var codeUnit = str.charCodeAt(i);
              HEAP_DATA_VIEW.setInt16(outPtr, codeUnit, true);
              outPtr += 2;
            }
            HEAP_DATA_VIEW.setInt16(outPtr, 0, true);
            return outPtr - startPtr;
          },
          newString: function(env, str, length, result, stringMaker) {
            length >>>= 0;
            if (!env)
              return 1;
            var envObject = emnapiCtx.envStore.get(env);
            envObject.checkGCAccess();
            var autoLength = length === -1 || length === 4294967295;
            var sizelength = length >>> 0;
            if (length !== 0) {
              if (!str)
                return envObject.setLastError(1);
            }
            if (!result)
              return envObject.setLastError(1);
            if (!(autoLength || sizelength <= 2147483647))
              return envObject.setLastError(1);
            str >>>= 0;
            var strValue = stringMaker(str, autoLength, sizelength);
            result >>>= 0;
            var value = emnapiCtx.addToCurrentScope(strValue).id;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(result, value, true);
            return envObject.clearLastError();
          },
          newExternalString: function(env, str, length, finalize_callback, finalize_hint, result, copied, createApi, stringMaker) {
            length >>>= 0;
            if (!env)
              return 1;
            var envObject = emnapiCtx.envStore.get(env);
            envObject.checkGCAccess();
            var autoLength = length === -1 || length === 4294967295;
            var sizelength = length >>> 0;
            if (length !== 0) {
              if (!str)
                return envObject.setLastError(1);
            }
            if (!result)
              return envObject.setLastError(1);
            if (!(autoLength || sizelength <= 2147483647))
              return envObject.setLastError(1);
            var status = createApi(env, str, length, result);
            if (status === 0) {
              if (copied) {
                var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
                HEAP_DATA_VIEW.setInt8(copied, 1, true);
              }
              if (finalize_callback) {
                envObject.callFinalizer(finalize_callback, str, finalize_hint);
              }
            }
            return status;
          }
        };
        function napi_get_array_length(env, value, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!value)
              return envObject.setLastError(1);
            if (!result)
              return envObject.setLastError(1);
            var handle = emnapiCtx.handleStore.get(value);
            if (!handle.isArray()) {
              return envObject.setLastError(8);
            }
            result >>>= 0;
            var v = handle.value.length >>> 0;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(result, v, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_get_arraybuffer_info(env, arraybuffer, data, byte_length) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!arraybuffer)
            return envObject.setLastError(1);
          var handle = emnapiCtx.handleStore.get(arraybuffer);
          if (!handle.isArrayBuffer() && !emnapiExternalMemory.isSharedArrayBuffer(handle.value)) {
            return envObject.setLastError(1);
          }
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          if (data) {
            data >>>= 0;
            var p = emnapiExternalMemory.getArrayBufferPointer(handle.value, true).address;
            HEAP_DATA_VIEW.setUint32(data, p, true);
          }
          if (byte_length) {
            byte_length >>>= 0;
            HEAP_DATA_VIEW.setUint32(byte_length, handle.value.byteLength, true);
          }
          return envObject.clearLastError();
        }
        function node_api_set_prototype(env, object, value) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!value)
              return envObject.setLastError(1);
            var obj = emnapiCtx.handleStore.get(object).value;
            if (obj == null) {
              throw new TypeError("Cannot convert undefined or null to object");
            }
            var type = typeof obj;
            var v = void 0;
            try {
              v = type === "object" && obj !== null || type === "function" ? obj : Object(obj);
            } catch (_) {
              return envObject.setLastError(2);
            }
            var val = emnapiCtx.handleStore.get(value).value;
            Object.setPrototypeOf(v, val);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_get_prototype(env, value, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!value)
              return envObject.setLastError(1);
            if (!result)
              return envObject.setLastError(1);
            var handle = emnapiCtx.handleStore.get(value);
            if (handle.value == null) {
              throw new TypeError("Cannot convert undefined or null to object");
            }
            var v = void 0;
            try {
              v = handle.isObject() || handle.isFunction() ? handle.value : Object(handle.value);
            } catch (_) {
              return envObject.setLastError(2);
            }
            result >>>= 0;
            var p = envObject.ensureHandleId(Object.getPrototypeOf(v));
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(result, p, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_get_typedarray_info(env, typedarray, type, length, data, arraybuffer, byte_offset) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!typedarray)
            return envObject.setLastError(1);
          var handle = emnapiCtx.handleStore.get(typedarray);
          if (!handle.isTypedArray()) {
            return envObject.setLastError(1);
          }
          var v = handle.value;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          if (type) {
            type >>>= 0;
            var t = void 0;
            if (v instanceof Int8Array) {
              t = 0;
            } else if (v instanceof Uint8Array) {
              t = 1;
            } else if (v instanceof Uint8ClampedArray) {
              t = 2;
            } else if (v instanceof Int16Array) {
              t = 3;
            } else if (v instanceof Uint16Array) {
              t = 4;
            } else if (v instanceof Int32Array) {
              t = 5;
            } else if (v instanceof Uint32Array) {
              t = 6;
            } else if (typeof Float16Array === "function" && v instanceof Float16Array) {
              t = 11;
            } else if (v instanceof Float32Array) {
              t = 7;
            } else if (v instanceof Float64Array) {
              t = 8;
            } else if (v instanceof BigInt64Array) {
              t = 9;
            } else if (v instanceof BigUint64Array) {
              t = 10;
            } else {
              return envObject.setLastError(9);
            }
            HEAP_DATA_VIEW.setInt32(type, t, true);
          }
          v = emnapiExternalMemory.getOrUpdateMemoryView(v);
          if (length) {
            length >>>= 0;
            HEAP_DATA_VIEW.setUint32(length, v.length, true);
          }
          if (data || arraybuffer) {
            if (data) {
              data >>>= 0;
              var p = emnapiExternalMemory.getViewPointer(v, true).address;
              HEAP_DATA_VIEW.setUint32(data, p, true);
            }
            if (arraybuffer) {
              arraybuffer >>>= 0;
              var ab = envObject.ensureHandleId(v.buffer);
              HEAP_DATA_VIEW.setUint32(arraybuffer, ab, true);
            }
          }
          if (byte_offset) {
            byte_offset >>>= 0;
            HEAP_DATA_VIEW.setUint32(byte_offset, v.byteOffset, true);
          }
          return envObject.clearLastError();
        }
        function napi_get_buffer_info(env, buffer, data, length) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!buffer)
            return envObject.setLastError(1);
          var handle = emnapiCtx.handleStore.get(buffer);
          if (!handle.isBuffer(emnapiCtx.feature.Buffer))
            return envObject.setLastError(1);
          if (handle.isDataView()) {
            return napi_get_dataview_info(env, buffer, length, data, 0, 0);
          }
          return napi_get_typedarray_info(env, buffer, 0, length, data, 0, 0);
        }
        function napi_get_dataview_info(env, dataview, byte_length, data, arraybuffer, byte_offset) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!dataview)
            return envObject.setLastError(1);
          var handle = emnapiCtx.handleStore.get(dataview);
          if (!handle.isDataView()) {
            return envObject.setLastError(1);
          }
          var v = emnapiExternalMemory.getOrUpdateMemoryView(handle.value);
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          if (byte_length) {
            byte_length >>>= 0;
            HEAP_DATA_VIEW.setUint32(byte_length, v.byteLength, true);
          }
          if (data || arraybuffer) {
            if (data) {
              data >>>= 0;
              var p = emnapiExternalMemory.getViewPointer(v, true).address;
              HEAP_DATA_VIEW.setUint32(data, p, true);
            }
            if (arraybuffer) {
              arraybuffer >>>= 0;
              var ab = envObject.ensureHandleId(v.buffer);
              HEAP_DATA_VIEW.setUint32(arraybuffer, ab, true);
            }
          }
          if (byte_offset) {
            byte_offset >>>= 0;
            HEAP_DATA_VIEW.setUint32(byte_offset, v.byteOffset, true);
          }
          return envObject.clearLastError();
        }
        function napi_get_date_value(env, value, result) {
          var v;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!value)
              return envObject.setLastError(1);
            if (!result)
              return envObject.setLastError(1);
            var handle = emnapiCtx.handleStore.get(value);
            if (!handle.isDate()) {
              return envObject.setLastError(1);
            }
            result >>>= 0;
            v = handle.value.valueOf();
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setFloat64(result, v, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_get_value_bool(env, value, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!value)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          var handle = emnapiCtx.handleStore.get(value);
          if (typeof handle.value !== "boolean") {
            return envObject.setLastError(7);
          }
          result >>>= 0;
          var r = handle.value ? 1 : 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setInt8(result, r, true);
          return envObject.clearLastError();
        }
        function napi_get_value_double(env, value, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!value)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          var handle = emnapiCtx.handleStore.get(value);
          if (typeof handle.value !== "number") {
            return envObject.setLastError(6);
          }
          result >>>= 0;
          var r = handle.value;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setFloat64(result, r, true);
          return envObject.clearLastError();
        }
        function napi_get_value_bigint_int64(env, value, result, lossless) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!emnapiCtx.feature.supportBigInt) {
            return envObject.setLastError(9);
          }
          if (!value)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          if (!lossless)
            return envObject.setLastError(1);
          var handle = emnapiCtx.handleStore.get(value);
          var numberValue = handle.value;
          if (typeof numberValue !== "bigint") {
            return envObject.setLastError(6);
          }
          lossless >>>= 0;
          result >>>= 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          if (numberValue >= BigInt(-1) * (BigInt(1) << BigInt(63)) && numberValue < BigInt(1) << BigInt(63)) {
            HEAP_DATA_VIEW.setInt8(lossless, 1, true);
          } else {
            HEAP_DATA_VIEW.setInt8(lossless, 0, true);
            numberValue = numberValue & (BigInt(1) << BigInt(64)) - BigInt(1);
            if (numberValue >= BigInt(1) << BigInt(63)) {
              numberValue = numberValue - (BigInt(1) << BigInt(64));
            }
          }
          var low = Number(numberValue & BigInt(4294967295));
          var high = Number(numberValue >> BigInt(32));
          HEAP_DATA_VIEW.setInt32(result, low, true);
          HEAP_DATA_VIEW.setInt32(result + 4, high, true);
          return envObject.clearLastError();
        }
        function napi_get_value_bigint_uint64(env, value, result, lossless) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!emnapiCtx.feature.supportBigInt) {
            return envObject.setLastError(9);
          }
          if (!value)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          if (!lossless)
            return envObject.setLastError(1);
          var handle = emnapiCtx.handleStore.get(value);
          var numberValue = handle.value;
          if (typeof numberValue !== "bigint") {
            return envObject.setLastError(6);
          }
          lossless >>>= 0;
          result >>>= 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          if (numberValue >= BigInt(0) && numberValue < BigInt(1) << BigInt(64)) {
            HEAP_DATA_VIEW.setInt8(lossless, 1, true);
          } else {
            HEAP_DATA_VIEW.setInt8(lossless, 0, true);
            numberValue = numberValue & (BigInt(1) << BigInt(64)) - BigInt(1);
          }
          var low = Number(numberValue & BigInt(4294967295));
          var high = Number(numberValue >> BigInt(32));
          HEAP_DATA_VIEW.setUint32(result, low, true);
          HEAP_DATA_VIEW.setUint32(result + 4, high, true);
          return envObject.clearLastError();
        }
        function napi_get_value_bigint_words(env, value, sign_bit, word_count, words) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!emnapiCtx.feature.supportBigInt) {
            return envObject.setLastError(9);
          }
          if (!value)
            return envObject.setLastError(1);
          if (!word_count)
            return envObject.setLastError(1);
          var handle = emnapiCtx.handleStore.get(value);
          if (!handle.isBigInt()) {
            return envObject.setLastError(17);
          }
          var isMinus = handle.value < BigInt(0);
          sign_bit >>>= 0;
          words >>>= 0;
          word_count >>>= 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          var word_count_int = HEAP_DATA_VIEW.getUint32(word_count, true);
          word_count_int >>>= 0;
          var wordCount = 0;
          var bigintValue = isMinus ? handle.value * BigInt(-1) : handle.value;
          while (bigintValue !== BigInt(0)) {
            wordCount++;
            bigintValue = bigintValue >> BigInt(64);
          }
          bigintValue = isMinus ? handle.value * BigInt(-1) : handle.value;
          if (!sign_bit && !words) {
            word_count_int = wordCount;
            HEAP_DATA_VIEW.setUint32(word_count, word_count_int, true);
          } else {
            if (!sign_bit)
              return envObject.setLastError(1);
            if (!words)
              return envObject.setLastError(1);
            var wordsArr = [];
            while (bigintValue !== BigInt(0)) {
              var uint64 = bigintValue & (BigInt(1) << BigInt(64)) - BigInt(1);
              wordsArr.push(uint64);
              bigintValue = bigintValue >> BigInt(64);
            }
            var len = Math.min(word_count_int, wordsArr.length);
            for (var i = 0; i < len; i++) {
              var low = Number(wordsArr[i] & BigInt(4294967295));
              var high = Number(wordsArr[i] >> BigInt(32));
              HEAP_DATA_VIEW.setUint32(words + i * 8, low, true);
              HEAP_DATA_VIEW.setUint32(words + (i * 8 + 4), high, true);
            }
            HEAP_DATA_VIEW.setInt32(sign_bit, isMinus ? 1 : 0, true);
            HEAP_DATA_VIEW.setUint32(word_count, len, true);
          }
          return envObject.clearLastError();
        }
        function napi_get_value_external(env, value, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!value)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          var handle = emnapiCtx.handleStore.get(value);
          if (!handle.isExternal()) {
            return envObject.setLastError(1);
          }
          result >>>= 0;
          var p = handle.data();
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, p, true);
          return envObject.clearLastError();
        }
        function napi_get_value_int32(env, value, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!value)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          var handle = emnapiCtx.handleStore.get(value);
          if (typeof handle.value !== "number") {
            return envObject.setLastError(6);
          }
          result >>>= 0;
          var v = new Int32Array([handle.value])[0];
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setInt32(result, v, true);
          return envObject.clearLastError();
        }
        function napi_get_value_int64(env, value, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!value)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          var handle = emnapiCtx.handleStore.get(value);
          if (typeof handle.value !== "number") {
            return envObject.setLastError(6);
          }
          var numberValue = handle.value;
          result >>>= 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          if (numberValue === Number.POSITIVE_INFINITY || numberValue === Number.NEGATIVE_INFINITY || isNaN(numberValue)) {
            HEAP_DATA_VIEW.setInt32(result, 0, true);
            HEAP_DATA_VIEW.setInt32(result + 4, 0, true);
          } else if (numberValue < -9223372036854776e3) {
            HEAP_DATA_VIEW.setInt32(result, 0, true);
            HEAP_DATA_VIEW.setInt32(result + 4, 2147483648, true);
          } else if (numberValue >= 9223372036854776e3) {
            HEAP_DATA_VIEW.setUint32(result, 4294967295, true);
            HEAP_DATA_VIEW.setUint32(result + 4, 2147483647, true);
          } else {
            $emnapiSetValueI64(result, Math.trunc(numberValue));
          }
          return envObject.clearLastError();
        }
        function napi_get_value_string_latin1(env, value, buf, buf_size, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!value)
            return envObject.setLastError(1);
          result >>>= 0;
          buf >>>= 0;
          buf_size >>>= 0;
          buf_size = buf_size >>> 0;
          var handle = emnapiCtx.handleStore.get(value);
          if (typeof handle.value !== "string") {
            return envObject.setLastError(3);
          }
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          if (!buf) {
            if (!result)
              return envObject.setLastError(1);
            HEAP_DATA_VIEW.setUint32(result, handle.value.length, true);
          } else if (buf_size !== 0) {
            var copied = 0;
            var v = void 0;
            for (var i = 0; i < buf_size - 1; ++i) {
              v = handle.value.charCodeAt(i) & 255;
              HEAP_DATA_VIEW.setUint8(buf + i, v, true);
              copied++;
            }
            HEAP_DATA_VIEW.setUint8(buf + copied, 0, true);
            if (result) {
              HEAP_DATA_VIEW.setUint32(result, copied, true);
            }
          } else if (result) {
            HEAP_DATA_VIEW.setUint32(result, 0, true);
          }
          return envObject.clearLastError();
        }
        function napi_get_value_string_utf8(env, value, buf, buf_size, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!value)
            return envObject.setLastError(1);
          result >>>= 0;
          buf >>>= 0;
          buf_size >>>= 0;
          buf_size = buf_size >>> 0;
          var handle = emnapiCtx.handleStore.get(value);
          if (typeof handle.value !== "string") {
            return envObject.setLastError(3);
          }
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          if (!buf) {
            if (!result)
              return envObject.setLastError(1);
            var strLength = emnapiString.lengthBytesUTF8(handle.value);
            HEAP_DATA_VIEW.setUint32(result, strLength, true);
          } else if (buf_size !== 0) {
            var copied = emnapiString.stringToUTF8(handle.value, buf, buf_size);
            if (result) {
              HEAP_DATA_VIEW.setUint32(result, copied, true);
            }
          } else if (result) {
            HEAP_DATA_VIEW.setUint32(result, 0, true);
          }
          return envObject.clearLastError();
        }
        function napi_get_value_string_utf16(env, value, buf, buf_size, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!value)
            return envObject.setLastError(1);
          result >>>= 0;
          buf >>>= 0;
          buf_size >>>= 0;
          buf_size = buf_size >>> 0;
          var handle = emnapiCtx.handleStore.get(value);
          if (typeof handle.value !== "string") {
            return envObject.setLastError(3);
          }
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          if (!buf) {
            if (!result)
              return envObject.setLastError(1);
            HEAP_DATA_VIEW.setUint32(result, handle.value.length, true);
          } else if (buf_size !== 0) {
            var copied = emnapiString.stringToUTF16(handle.value, buf, buf_size * 2);
            if (result) {
              HEAP_DATA_VIEW.setUint32(result, copied / 2, true);
            }
          } else if (result) {
            HEAP_DATA_VIEW.setUint32(result, 0, true);
          }
          return envObject.clearLastError();
        }
        function napi_get_value_uint32(env, value, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!value)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          var handle = emnapiCtx.handleStore.get(value);
          if (typeof handle.value !== "number") {
            return envObject.setLastError(6);
          }
          result >>>= 0;
          var v = new Uint32Array([handle.value])[0];
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, v, true);
          return envObject.clearLastError();
        }
        var convert2cMod = Object.freeze({
          __proto__: null,
          napi_get_array_length,
          napi_get_arraybuffer_info,
          napi_get_buffer_info,
          napi_get_dataview_info,
          napi_get_date_value,
          napi_get_prototype,
          napi_get_typedarray_info,
          napi_get_value_bigint_int64,
          napi_get_value_bigint_uint64,
          napi_get_value_bigint_words,
          napi_get_value_bool,
          napi_get_value_double,
          napi_get_value_external,
          napi_get_value_int32,
          napi_get_value_int64,
          napi_get_value_string_latin1,
          napi_get_value_string_utf16,
          napi_get_value_string_utf8,
          napi_get_value_uint32,
          node_api_set_prototype
        });
        function napi_create_int32(env, value, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!result)
            return envObject.setLastError(1);
          result >>>= 0;
          var v = emnapiCtx.addToCurrentScope(value).id;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, v, true);
          return envObject.clearLastError();
        }
        function napi_create_uint32(env, value, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!result)
            return envObject.setLastError(1);
          result >>>= 0;
          var v = emnapiCtx.addToCurrentScope(value >>> 0).id;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, v, true);
          return envObject.clearLastError();
        }
        function napi_create_int64(env, low, high, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          var value;
          if (!high)
            return envObject.setLastError(1);
          value = Number(low);
          var v1 = emnapiCtx.addToCurrentScope(value).id;
          high >>>= 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(high, v1, true);
          return envObject.clearLastError();
        }
        function napi_create_double(env, value, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!result)
            return envObject.setLastError(1);
          result >>>= 0;
          var v = emnapiCtx.addToCurrentScope(value).id;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, v, true);
          return envObject.clearLastError();
        }
        function napi_create_string_latin1(env, str, length, result) {
          return emnapiString.newString(env, str, length, result, function(str2, autoLength, sizeLength) {
            var latin1String = "";
            var len = 0;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            if (autoLength) {
              while (true) {
                var ch = HEAP_DATA_VIEW.getUint8(str2, true);
                if (!ch)
                  break;
                latin1String += String.fromCharCode(ch);
                str2++;
              }
            } else {
              while (len < sizeLength) {
                var ch = HEAP_DATA_VIEW.getUint8(str2, true);
                if (!ch)
                  break;
                latin1String += String.fromCharCode(ch);
                len++;
                str2++;
              }
            }
            return latin1String;
          });
        }
        function napi_create_string_utf16(env, str, length, result) {
          return emnapiString.newString(env, str, length, result, function(str2) {
            return emnapiString.UTF16ToString(str2, length);
          });
        }
        function napi_create_string_utf8(env, str, length, result) {
          return emnapiString.newString(env, str, length, result, function(str2) {
            return emnapiString.UTF8ToString(str2, length);
          });
        }
        function node_api_create_external_string_latin1(env, str, length, finalize_callback, finalize_hint, result, copied) {
          return emnapiString.newExternalString(env, str, length, finalize_callback, finalize_hint, result, copied, napi_create_string_latin1, void 0);
        }
        function node_api_create_external_string_utf16(env, str, length, finalize_callback, finalize_hint, result, copied) {
          return emnapiString.newExternalString(env, str, length, finalize_callback, finalize_hint, result, copied, napi_create_string_utf16, void 0);
        }
        function node_api_create_property_key_latin1(env, str, length, result) {
          return napi_create_string_latin1(env, str, length, result);
        }
        function node_api_create_property_key_utf8(env, str, length, result) {
          return napi_create_string_utf8(env, str, length, result);
        }
        function node_api_create_property_key_utf16(env, str, length, result) {
          return napi_create_string_utf16(env, str, length, result);
        }
        function napi_create_bigint_int64(env, low, high, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!emnapiCtx.feature.supportBigInt) {
            return envObject.setLastError(9);
          }
          var value;
          if (!high)
            return envObject.setLastError(1);
          value = low;
          var v1 = emnapiCtx.addToCurrentScope(value).id;
          high >>>= 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(high, v1, true);
          return envObject.clearLastError();
        }
        function napi_create_bigint_uint64(env, low, high, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!emnapiCtx.feature.supportBigInt) {
            return envObject.setLastError(9);
          }
          var value;
          if (!high)
            return envObject.setLastError(1);
          value = low & (BigInt(1) << BigInt(64)) - BigInt(1);
          var v1 = emnapiCtx.addToCurrentScope(value).id;
          high >>>= 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(high, v1, true);
          return envObject.clearLastError();
        }
        function napi_create_bigint_words(env, sign_bit, word_count, words, result) {
          var v, i;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!emnapiCtx.feature.supportBigInt) {
              return envObject.setLastError(9);
            }
            if (!result)
              return envObject.setLastError(1);
            words >>>= 0;
            word_count >>>= 0;
            word_count = word_count >>> 0;
            if (word_count > 2147483647) {
              return envObject.setLastError(1);
            }
            if (word_count > 1024 * 1024 / (4 * 8) / 2) {
              throw new RangeError("Maximum BigInt size exceeded");
            }
            var value = BigInt(0);
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            for (i = 0; i < word_count; i++) {
              var low = HEAP_DATA_VIEW.getUint32(words + i * 8, true);
              var high = HEAP_DATA_VIEW.getUint32(words + (i * 8 + 4), true);
              var wordi = BigInt(low) | BigInt(high) << BigInt(32);
              value += wordi << BigInt(64 * i);
            }
            value *= BigInt(sign_bit) % BigInt(2) === BigInt(0) ? BigInt(1) : BigInt(-1);
            result >>>= 0;
            v = emnapiCtx.addToCurrentScope(value).id;
            HEAP_DATA_VIEW.setUint32(result, v, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        var convert2napiMod = Object.freeze({
          __proto__: null,
          napi_create_bigint_int64,
          napi_create_bigint_uint64,
          napi_create_bigint_words,
          napi_create_double,
          napi_create_int32,
          napi_create_int64,
          napi_create_string_latin1,
          napi_create_string_utf16,
          napi_create_string_utf8,
          napi_create_uint32,
          node_api_create_external_string_latin1,
          node_api_create_external_string_utf16,
          node_api_create_property_key_latin1,
          node_api_create_property_key_utf16,
          node_api_create_property_key_utf8
        });
        function emnapiCreateFunction(envObject, utf8name, length, cb, data) {
          utf8name >>>= 0;
          var functionName = !utf8name || !length ? "" : emnapiString.UTF8ToString(utf8name, length);
          var f;
          var napiCallback = wasmTable.get(cb);
          var callback = function(envObject2) {
            return napiCallback(envObject2.id, envObject2.ctx.scopeStore.currentScope.id);
          };
          var makeFunction = function(envObject2, callback2) {
            return function() {
              var scope = envObject2.ctx.openScope(envObject2);
              var callbackInfo = scope.callbackInfo;
              callbackInfo.data = data;
              callbackInfo.args = arguments;
              callbackInfo.thiz = this;
              callbackInfo.fn = f;
              try {
                var napiValue = envObject2.callIntoModule(callback2);
                return !napiValue ? void 0 : envObject2.ctx.handleStore.get(napiValue).value;
              } finally {
                callbackInfo.data = 0;
                callbackInfo.args = void 0;
                callbackInfo.thiz = void 0;
                callbackInfo.fn = void 0;
                envObject2.ctx.closeScope(envObject2, scope);
              }
            };
          };
          if (functionName === "") {
            f = makeFunction(envObject, callback);
            return { status: 0, f };
          }
          if (!/^[_$a-zA-Z][_$a-zA-Z0-9]*$/.test(functionName)) {
            return { status: 1, f: void 0 };
          }
          if (emnapiCtx.feature.supportNewFunction) {
            var _ = makeFunction(envObject, callback);
            try {
              f = new Function("_", "return function " + functionName + '(){"use strict";return _.apply(this,arguments);};')(_);
            } catch (_err) {
              f = makeFunction(envObject, callback);
              if (emnapiCtx.feature.canSetFunctionName)
                Object.defineProperty(f, "name", { value: functionName });
            }
          } else {
            f = makeFunction(envObject, callback);
            if (emnapiCtx.feature.canSetFunctionName)
              Object.defineProperty(f, "name", { value: functionName });
          }
          return { status: 0, f };
        }
        function emnapiDefineProperty(envObject, obj, propertyName, method, getter, setter, value, attributes, data) {
          if (getter || setter) {
            var localGetter = void 0;
            var localSetter = void 0;
            if (getter) {
              localGetter = emnapiCreateFunction(envObject, 0, 0, getter, data).f;
            }
            if (setter) {
              localSetter = emnapiCreateFunction(envObject, 0, 0, setter, data).f;
            }
            var desc = {
              configurable: (attributes & 4) !== 0,
              enumerable: (attributes & 2) !== 0,
              get: localGetter,
              set: localSetter
            };
            Object.defineProperty(obj, propertyName, desc);
          } else if (method) {
            var localMethod = emnapiCreateFunction(envObject, 0, 0, method, data).f;
            var desc = {
              configurable: (attributes & 4) !== 0,
              enumerable: (attributes & 2) !== 0,
              writable: (attributes & 1) !== 0,
              value: localMethod
            };
            Object.defineProperty(obj, propertyName, desc);
          } else {
            var desc = {
              configurable: (attributes & 4) !== 0,
              enumerable: (attributes & 2) !== 0,
              writable: (attributes & 1) !== 0,
              value: emnapiCtx.handleStore.get(value).value
            };
            Object.defineProperty(obj, propertyName, desc);
          }
        }
        function emnapiGetHandle(js_object) {
          var handle = emnapiCtx.handleStore.get(js_object);
          if (!(handle.isObject() || handle.isFunction())) {
            return { status: 1 };
          }
          if (typeof emnapiExternalMemory !== "undefined" && ArrayBuffer.isView(handle.value)) {
            if (emnapiExternalMemory.wasmMemoryViewTable.has(handle.value)) {
              handle = emnapiCtx.addToCurrentScope(emnapiExternalMemory.wasmMemoryViewTable.get(handle.value));
            }
          }
          return { status: 0, handle };
        }
        function emnapiWrap(env, js_object, native_object, finalize_cb, finalize_hint, result) {
          var referenceId;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!emnapiCtx.feature.supportFinalizer) {
              if (finalize_cb) {
                throw emnapiCtx.createNotSupportWeakRefError("napi_wrap", 'Parameter "finalize_cb" must be 0(NULL)');
              }
              if (result) {
                throw emnapiCtx.createNotSupportWeakRefError("napi_wrap", 'Parameter "result" must be 0(NULL)');
              }
            }
            if (!js_object)
              return envObject.setLastError(1);
            var handleResult = emnapiGetHandle(js_object);
            if (handleResult.status !== 0) {
              return envObject.setLastError(handleResult.status);
            }
            var handle = handleResult.handle;
            if (envObject.getObjectBinding(handle.value).wrapped !== 0) {
              return envObject.setLastError(1);
            }
            var reference = void 0;
            if (result) {
              if (!finalize_cb)
                return envObject.setLastError(1);
              reference = emnapiCtx.createReferenceWithFinalizer(envObject, handle.id, 0, 1, finalize_cb, native_object, finalize_hint);
              result >>>= 0;
              referenceId = reference.id;
              var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
              HEAP_DATA_VIEW.setUint32(result, referenceId, true);
            } else {
              if (finalize_cb) {
                reference = emnapiCtx.createReferenceWithFinalizer(envObject, handle.id, 0, 0, finalize_cb, native_object, finalize_hint);
              } else {
                reference = emnapiCtx.createReferenceWithData(envObject, handle.id, 0, 0, native_object);
              }
            }
            envObject.getObjectBinding(handle.value).wrapped = reference.id;
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function emnapiUnwrap(env, js_object, result, action) {
          var data;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!js_object)
              return envObject.setLastError(1);
            if (action === 0) {
              if (!result)
                return envObject.setLastError(1);
            }
            var value = emnapiCtx.handleStore.get(js_object);
            if (!(value.isObject() || value.isFunction())) {
              return envObject.setLastError(1);
            }
            var binding = envObject.getObjectBinding(value.value);
            var referenceId = binding.wrapped;
            var ref = emnapiCtx.refStore.get(referenceId);
            if (!ref)
              return envObject.setLastError(1);
            if (result) {
              result >>>= 0;
              data = ref.data();
              var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
              HEAP_DATA_VIEW.setUint32(result, data, true);
            }
            if (action === 1) {
              binding.wrapped = 0;
              if (ref.ownership() === 1) {
                ref.resetFinalizer();
              } else {
                ref.dispose();
              }
            }
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_define_class(env, utf8name, length, constructor, callback_data, property_count, properties, result) {
          var propPtr, valueHandleId, attributes;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!result)
              return envObject.setLastError(1);
            if (!constructor)
              return envObject.setLastError(1);
            length >>>= 0;
            properties >>>= 0;
            property_count >>>= 0;
            property_count = property_count >>> 0;
            if (property_count > 0) {
              if (!properties)
                return envObject.setLastError(1);
            }
            if (!(length >= -1 && length <= 2147483647 || length === 4294967295) || !utf8name) {
              return envObject.setLastError(1);
            }
            var fresult = emnapiCreateFunction(envObject, utf8name, length, constructor, callback_data);
            if (fresult.status !== 0)
              return envObject.setLastError(fresult.status);
            var F = fresult.f;
            var propertyName = void 0;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            for (var i = 0; i < property_count; i++) {
              propPtr = properties + i * (4 * 8);
              var utf8Name = HEAP_DATA_VIEW.getUint32(propPtr, true);
              var name_1 = HEAP_DATA_VIEW.getUint32(propPtr + 4, true);
              var method = HEAP_DATA_VIEW.getUint32(propPtr + 8, true);
              var getter = HEAP_DATA_VIEW.getUint32(propPtr + 12, true);
              var setter = HEAP_DATA_VIEW.getUint32(propPtr + 16, true);
              var value = HEAP_DATA_VIEW.getUint32(propPtr + 20, true);
              attributes = HEAP_DATA_VIEW.getInt32(propPtr + 24, true);
              attributes >>>= 0;
              var data = HEAP_DATA_VIEW.getUint32(propPtr + 28, true);
              if (utf8Name) {
                propertyName = emnapiString.UTF8ToString(utf8Name, -1);
              } else {
                if (!name_1) {
                  return envObject.setLastError(4);
                }
                propertyName = emnapiCtx.handleStore.get(name_1).value;
                if (typeof propertyName !== "string" && typeof propertyName !== "symbol") {
                  return envObject.setLastError(4);
                }
              }
              if ((attributes & 1024) !== 0) {
                emnapiDefineProperty(envObject, F, propertyName, method, getter, setter, value, attributes, data);
                continue;
              }
              emnapiDefineProperty(envObject, F.prototype, propertyName, method, getter, setter, value, attributes, data);
            }
            var valueHandle = emnapiCtx.addToCurrentScope(F);
            valueHandleId = valueHandle.id;
            result >>>= 0;
            HEAP_DATA_VIEW.setUint32(result, valueHandleId, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_wrap(env, js_object, native_object, finalize_cb, finalize_hint, result) {
          return emnapiWrap(env, js_object, native_object, finalize_cb, finalize_hint, result);
        }
        function napi_unwrap(env, js_object, result) {
          return emnapiUnwrap(env, js_object, result, 0);
        }
        function napi_remove_wrap(env, js_object, result) {
          return emnapiUnwrap(env, js_object, result, 1);
        }
        function napi_type_tag_object(env, object, type_tag) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!object) {
              return envObject.setLastError(envObject.tryCatch.hasCaught() ? 10 : 1);
            }
            var value = emnapiCtx.handleStore.get(object);
            if (!(value.isObject() || value.isFunction())) {
              return envObject.setLastError(envObject.tryCatch.hasCaught() ? 10 : 2);
            }
            type_tag >>>= 0;
            if (!type_tag) {
              return envObject.setLastError(envObject.tryCatch.hasCaught() ? 10 : 1);
            }
            var binding = envObject.getObjectBinding(value.value);
            if (binding.tag !== null) {
              return envObject.setLastError(envObject.tryCatch.hasCaught() ? 10 : 1);
            }
            var tag = new Uint8Array(16);
            tag.set(new Uint8Array(wasmMemory.buffer, type_tag, 16));
            binding.tag = new Uint32Array(tag.buffer);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_check_object_type_tag(env, object, type_tag, result) {
          var ret = true;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!object) {
              return envObject.setLastError(envObject.tryCatch.hasCaught() ? 10 : 1);
            }
            var value = emnapiCtx.handleStore.get(object);
            if (!(value.isObject() || value.isFunction())) {
              return envObject.setLastError(envObject.tryCatch.hasCaught() ? 10 : 2);
            }
            if (!type_tag) {
              return envObject.setLastError(envObject.tryCatch.hasCaught() ? 10 : 1);
            }
            if (!result) {
              return envObject.setLastError(envObject.tryCatch.hasCaught() ? 10 : 1);
            }
            var binding = envObject.getObjectBinding(value.value);
            if (binding.tag !== null) {
              type_tag >>>= 0;
              var tag = binding.tag;
              var typeTag = new Uint32Array(wasmMemory.buffer, type_tag, 4);
              ret = tag[0] === typeTag[0] && tag[1] === typeTag[1] && tag[2] === typeTag[2] && tag[3] === typeTag[3];
            } else {
              ret = false;
            }
            result >>>= 0;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setInt8(result, ret ? 1 : 0, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_add_finalizer(env, js_object, finalize_data, finalize_cb, finalize_hint, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!emnapiCtx.feature.supportFinalizer) {
            return envObject.setLastError(9);
          }
          if (!js_object)
            return envObject.setLastError(1);
          if (!finalize_cb)
            return envObject.setLastError(1);
          var handleResult = emnapiGetHandle(js_object);
          if (handleResult.status !== 0) {
            return envObject.setLastError(handleResult.status);
          }
          var handle = handleResult.handle;
          var ownership = !result ? 0 : 1;
          finalize_data >>>= 0;
          finalize_cb >>>= 0;
          finalize_hint >>>= 0;
          var reference = emnapiCtx.createReferenceWithFinalizer(envObject, handle.id, 0, ownership, finalize_cb, finalize_data, finalize_hint);
          if (result) {
            result >>>= 0;
            var referenceId = reference.id;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(result, referenceId, true);
          }
          return envObject.clearLastError();
        }
        function node_api_post_finalizer(env, finalize_cb, finalize_data, finalize_hint) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.enqueueFinalizer(emnapiCtx.createTrackedFinalizer(envObject, finalize_cb, finalize_data, finalize_hint));
          return envObject.clearLastError();
        }
        var wrapMod = Object.freeze({
          __proto__: null,
          napi_add_finalizer,
          napi_check_object_type_tag,
          napi_define_class,
          napi_remove_wrap,
          napi_type_tag_object,
          napi_unwrap,
          napi_wrap,
          node_api_post_finalizer
        });
        function emnapi_create_memory_view(env, typedarray_type, external_data, byte_length, finalize_cb, finalize_hint, result) {
          var value;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!result)
              return envObject.setLastError(1);
            byte_length >>>= 0;
            external_data >>>= 0;
            result >>>= 0;
            byte_length = byte_length >>> 0;
            if (!external_data) {
              byte_length = 0;
            }
            if (byte_length > 2147483647) {
              throw new RangeError("Cannot create a memory view larger than 2147483647 bytes");
            }
            if (external_data + byte_length > wasmMemory.buffer.byteLength) {
              throw new RangeError("Memory out of range");
            }
            if (!emnapiCtx.feature.supportFinalizer && finalize_cb) {
              throw emnapiCtx.createNotSupportWeakRefError("emnapi_create_memory_view", 'Parameter "finalize_cb" must be 0(NULL)');
            }
            var viewDescriptor = void 0;
            switch (typedarray_type) {
              case 0:
                viewDescriptor = { Ctor: Int8Array, address: external_data, length: byte_length, ownership: 1, runtimeAllocated: 0 };
                break;
              case 1:
                viewDescriptor = { Ctor: Uint8Array, address: external_data, length: byte_length, ownership: 1, runtimeAllocated: 0 };
                break;
              case 2:
                viewDescriptor = { Ctor: Uint8ClampedArray, address: external_data, length: byte_length, ownership: 1, runtimeAllocated: 0 };
                break;
              case 3:
                viewDescriptor = { Ctor: Int16Array, address: external_data, length: byte_length >> 1, ownership: 1, runtimeAllocated: 0 };
                break;
              case 4:
                viewDescriptor = { Ctor: Uint16Array, address: external_data, length: byte_length >> 1, ownership: 1, runtimeAllocated: 0 };
                break;
              case 5:
                viewDescriptor = { Ctor: Int32Array, address: external_data, length: byte_length >> 2, ownership: 1, runtimeAllocated: 0 };
                break;
              case 6:
                viewDescriptor = { Ctor: Uint32Array, address: external_data, length: byte_length >> 2, ownership: 1, runtimeAllocated: 0 };
                break;
              case 7:
                viewDescriptor = { Ctor: Float32Array, address: external_data, length: byte_length >> 2, ownership: 1, runtimeAllocated: 0 };
                break;
              case 8:
                viewDescriptor = { Ctor: Float64Array, address: external_data, length: byte_length >> 3, ownership: 1, runtimeAllocated: 0 };
                break;
              case 9:
                viewDescriptor = { Ctor: BigInt64Array, address: external_data, length: byte_length >> 3, ownership: 1, runtimeAllocated: 0 };
                break;
              case 10:
                viewDescriptor = { Ctor: BigUint64Array, address: external_data, length: byte_length >> 3, ownership: 1, runtimeAllocated: 0 };
                break;
              case -1:
                viewDescriptor = { Ctor: DataView, address: external_data, length: byte_length, ownership: 1, runtimeAllocated: 0 };
                break;
              case 11:
                if (typeof Float16Array !== "function") {
                  return envObject.setLastError(1);
                }
                viewDescriptor = { Ctor: Float16Array, address: external_data, length: byte_length >> 1, ownership: 1, runtimeAllocated: 0 };
                break;
              case -2: {
                if (!emnapiCtx.feature.Buffer) {
                  throw emnapiCtx.createNotSupportBufferError("emnapi_create_memory_view", "");
                }
                viewDescriptor = { Ctor: emnapiCtx.feature.Buffer, address: external_data, length: byte_length, ownership: 1, runtimeAllocated: 0 };
                break;
              }
              default:
                return envObject.setLastError(1);
            }
            var Ctor = viewDescriptor.Ctor;
            var typedArray = typedarray_type === -2 ? emnapiCtx.feature.Buffer.from(wasmMemory.buffer, viewDescriptor.address, viewDescriptor.length) : new Ctor(wasmMemory.buffer, viewDescriptor.address, viewDescriptor.length);
            var handle = emnapiCtx.addToCurrentScope(typedArray);
            emnapiExternalMemory.wasmMemoryViewTable.set(typedArray, viewDescriptor);
            if (finalize_cb) {
              var status_1 = napi_add_finalizer(env, handle.id, external_data, finalize_cb, finalize_hint, 0);
              if (status_1 === 10) {
                var err2 = envObject.tryCatch.extractException();
                envObject.clearLastError();
                throw err2;
              } else if (status_1 !== 0) {
                return envObject.setLastError(status_1);
              }
            }
            value = handle.id;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(result, value, true);
            return envObject.getReturnStatus();
          } catch (err3) {
            envObject.tryCatch.setError(err3);
            return envObject.setLastError(10);
          }
        }
        function emnapi_is_support_weakref() {
          return emnapiCtx.feature.supportFinalizer ? 1 : 0;
        }
        function emnapi_is_support_bigint() {
          return emnapiCtx.feature.supportBigInt ? 1 : 0;
        }
        function emnapi_is_node_binding_available() {
          return emnapiNodeBinding ? 1 : 0;
        }
        function $emnapiSyncMemory(js_to_wasm, arrayBufferOrView, offset, len) {
          offset = offset !== null && offset !== void 0 ? offset : 0;
          offset = offset >>> 0;
          var view;
          if (arrayBufferOrView instanceof ArrayBuffer || emnapiExternalMemory.isSharedArrayBuffer(arrayBufferOrView)) {
            var pointer = emnapiExternalMemory.getArrayBufferPointer(arrayBufferOrView, false).address;
            if (!pointer)
              throw new Error("Unknown ArrayBuffer address");
            if (typeof len !== "number" || len === -1 || len === 4294967295) {
              len = arrayBufferOrView.byteLength - offset;
            }
            len = len >>> 0;
            if (len === 0)
              return arrayBufferOrView;
            view = new Uint8Array(arrayBufferOrView, offset, len);
            var wasmMemoryU8 = new Uint8Array(wasmMemory.buffer);
            if (!js_to_wasm) {
              view.set(wasmMemoryU8.subarray(pointer, pointer + len));
            } else {
              wasmMemoryU8.set(view, pointer);
            }
            return arrayBufferOrView;
          }
          if (ArrayBuffer.isView(arrayBufferOrView)) {
            var viewPointerInfo = emnapiExternalMemory.getViewPointer(arrayBufferOrView, false);
            var latestView = viewPointerInfo.view;
            var pointer = viewPointerInfo.address;
            if (!pointer)
              throw new Error("Unknown ArrayBuffer address");
            if (typeof len !== "number" || len === -1 || len === 4294967295) {
              len = latestView.byteLength - offset;
            }
            len = len >>> 0;
            if (len === 0)
              return latestView;
            view = new Uint8Array(latestView.buffer, latestView.byteOffset + offset, len);
            var wasmMemoryU8 = new Uint8Array(wasmMemory.buffer);
            if (!js_to_wasm) {
              view.set(wasmMemoryU8.subarray(pointer, pointer + len));
            } else {
              wasmMemoryU8.set(view, pointer);
            }
            return latestView;
          }
          throw new TypeError("emnapiSyncMemory expect ArrayBuffer or ArrayBufferView as first parameter");
        }
        function emnapi_sync_memory(env, js_to_wasm, arraybuffer_or_view, offset, len) {
          var v;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!arraybuffer_or_view)
              return envObject.setLastError(1);
            arraybuffer_or_view >>>= 0;
            offset >>>= 0;
            len >>>= 0;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            var handleId = HEAP_DATA_VIEW.getUint32(arraybuffer_or_view, true);
            var handle = envObject.ctx.handleStore.get(handleId);
            if (!handle.isArrayBuffer() && !handle.isTypedArray() && !handle.isDataView() && !emnapiExternalMemory.isSharedArrayBuffer(handle.value)) {
              return envObject.setLastError(1);
            }
            var ret = $emnapiSyncMemory(Boolean(js_to_wasm), handle.value, offset, len);
            if (handle.value !== ret) {
              arraybuffer_or_view >>>= 0;
              v = envObject.ensureHandleId(ret);
              HEAP_DATA_VIEW.setUint32(arraybuffer_or_view, v, true);
            }
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function $emnapiGetMemoryAddress(arrayBufferOrView) {
          var isArrayBuffer = arrayBufferOrView instanceof ArrayBuffer;
          var isDataView = arrayBufferOrView instanceof DataView;
          var isTypedArray = ArrayBuffer.isView(arrayBufferOrView) && !isDataView;
          if (!isArrayBuffer && !isTypedArray && !isDataView && !emnapiExternalMemory.isSharedArrayBuffer(arrayBufferOrView)) {
            throw new TypeError("emnapiGetMemoryAddress expect ArrayBuffer or ArrayBufferView as first parameter");
          }
          var info;
          if (isArrayBuffer) {
            info = emnapiExternalMemory.getArrayBufferPointer(arrayBufferOrView, false);
          } else {
            info = emnapiExternalMemory.getViewPointer(arrayBufferOrView, false);
          }
          return {
            address: info.address,
            ownership: info.ownership,
            runtimeAllocated: info.runtimeAllocated
          };
        }
        function emnapi_get_memory_address(env, arraybuffer_or_view, address, ownership, runtime_allocated) {
          var p, runtimeAllocated, ownershipOut;
          var info;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!arraybuffer_or_view)
              return envObject.setLastError(1);
            if (!address && !ownership && !runtime_allocated) {
              return envObject.setLastError(1);
            }
            var handle = envObject.ctx.handleStore.get(arraybuffer_or_view);
            info = $emnapiGetMemoryAddress(handle.value);
            p = info.address;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            if (address) {
              address >>>= 0;
              HEAP_DATA_VIEW.setUint32(address, p, true);
            }
            if (ownership) {
              ownership >>>= 0;
              ownershipOut = info.ownership;
              HEAP_DATA_VIEW.setInt32(ownership, ownershipOut, true);
            }
            if (runtime_allocated) {
              runtime_allocated >>>= 0;
              runtimeAllocated = info.runtimeAllocated;
              HEAP_DATA_VIEW.setInt8(runtime_allocated, runtimeAllocated, true);
            }
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function emnapi_get_runtime_version(env, version2) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          if (!version2)
            return envObject.setLastError(1);
          var runtimeVersion;
          try {
            runtimeVersion = emnapiCtx.getRuntimeVersions().version;
          } catch (_) {
            return envObject.setLastError(9);
          }
          var versions = runtimeVersion.split(".").map(function(n) {
            return Number(n);
          });
          version2 >>>= 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(version2, versions[0], true);
          HEAP_DATA_VIEW.setUint32(version2 + 4, versions[1], true);
          HEAP_DATA_VIEW.setUint32(version2 + 8, versions[2], true);
          return envObject.clearLastError();
        }
        function emnapi_get_external_sharedarraybuffer_handle(env, sharedarraybuffer, handle) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!sharedarraybuffer)
              return envObject.setLastError(1);
            if (!handle)
              return envObject.setLastError(1);
            handle >>>= 0;
            var jsValue = emnapiCtx.handleStore.get(sharedarraybuffer).value;
            if (!emnapiExternalMemory.isSharedArrayBuffer(jsValue)) {
              return envObject.setLastError(1);
            }
            var metaPtr = emnapiExternalSAB.handleTable.get(jsValue);
            if (metaPtr === void 0) {
              return envObject.setLastError(1);
            }
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(handle, metaPtr, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function emnapi_acquire_external_sharedarraybuffer(handle) {
          handle >>>= 0;
          Atomics.add(new Int32Array(wasmMemory.buffer, handle, 1), 0, 1);
        }
        function emnapi_release_external_sharedarraybuffer(handle) {
          handle >>>= 0;
          emnapiExternalSAB.release(handle);
        }
        function $emnapiAcquireExternalSharedArrayBuffer(handle, sab) {
          if (sab != null && !emnapiExternalMemory.isSharedArrayBuffer(sab)) {
            throw new TypeError("Expected a SharedArrayBuffer");
          }
          if (!emnapiExternalSAB.registry) {
            throw new Error("FinalizationRegistry is not supported in this environment");
          }
          handle >>>= 0;
          var meta = emnapiExternalSAB.readMeta(handle);
          var external_data = meta.external_data;
          external_data >>>= 0;
          if (sab == null) {
            sab = new SharedArrayBuffer(meta.byte_length);
            new Uint8Array(sab).set(new Uint8Array(wasmMemory.buffer, external_data, meta.byte_length));
          } else {
            if (emnapiExternalSAB.handleTable.has(sab)) {
              return sab;
            }
          }
          Atomics.add(new Int32Array(wasmMemory.buffer, handle, 1), 0, 1);
          if (!emnapiExternalMemory.table.has(sab)) {
            if (external_data) {
              emnapiExternalMemory.table.set(sab, {
                address: external_data,
                ownership: 1,
                runtimeAllocated: 0
              });
            }
          }
          emnapiExternalSAB.handleTable.set(sab, handle);
          emnapiExternalSAB.registry.register(sab, handle);
          return sab;
        }
        var emnapiMod = Object.freeze({
          __proto__: null,
          $emnapiAcquireExternalSharedArrayBuffer,
          $emnapiGetMemoryAddress,
          $emnapiSyncMemory,
          emnapi_acquire_external_sharedarraybuffer,
          emnapi_create_memory_view,
          emnapi_get_external_sharedarraybuffer_handle,
          emnapi_get_memory_address,
          emnapi_get_runtime_version,
          emnapi_is_node_binding_available,
          emnapi_is_support_bigint,
          emnapi_is_support_weakref,
          emnapi_release_external_sharedarraybuffer,
          emnapi_sync_memory
        });
        function napi_create_array(env, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!result)
            return envObject.setLastError(1);
          result >>>= 0;
          var value = emnapiCtx.addToCurrentScope([]).id;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, value, true);
          return envObject.clearLastError();
        }
        function napi_create_array_with_length(env, length, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!result)
            return envObject.setLastError(1);
          length >>>= 0;
          result >>>= 0;
          length = length >>> 0;
          var value = emnapiCtx.addToCurrentScope(new Array(length)).id;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, value, true);
          return envObject.clearLastError();
        }
        function emnapiCreateArrayBuffer(byte_length, data, shared) {
          byte_length >>>= 0;
          byte_length = byte_length >>> 0;
          var arrayBuffer = shared ? new SharedArrayBuffer(byte_length) : new ArrayBuffer(byte_length);
          if (data) {
            data >>>= 0;
            var p = emnapiExternalMemory.getArrayBufferPointer(arrayBuffer, true).address;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(data, p, true);
          }
          return arrayBuffer;
        }
        function napi_create_arraybuffer(env, byte_length, data, result) {
          var value;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!result)
              return envObject.setLastError(1);
            result >>>= 0;
            var arrayBuffer = emnapiCreateArrayBuffer(byte_length, data, false);
            value = emnapiCtx.addToCurrentScope(arrayBuffer).id;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(result, value, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function node_api_create_sharedarraybuffer(env, byte_length, data, result) {
          var value;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!result)
              return envObject.setLastError(1);
            result >>>= 0;
            var arrayBuffer = emnapiCreateArrayBuffer(byte_length, data, true);
            value = emnapiCtx.addToCurrentScope(arrayBuffer).id;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(result, value, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_create_date(env, time, result) {
          var value;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!result)
              return envObject.setLastError(1);
            result >>>= 0;
            value = emnapiCtx.addToCurrentScope(new Date(time)).id;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(result, value, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_create_external(env, data, finalize_cb, finalize_hint, result) {
          var value;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!result)
              return envObject.setLastError(1);
            if (!emnapiCtx.feature.supportFinalizer && finalize_cb) {
              throw emnapiCtx.createNotSupportWeakRefError("napi_create_external", 'Parameter "finalize_cb" must be 0(NULL)');
            }
            var externalHandle = emnapiCtx.getCurrentScope().addExternal(data);
            if (finalize_cb) {
              emnapiCtx.createReferenceWithFinalizer(envObject, externalHandle.id, 0, 0, finalize_cb, data, finalize_hint);
            }
            result >>>= 0;
            value = externalHandle.id;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(result, value, true);
            return envObject.clearLastError();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_create_external_arraybuffer(env, external_data, byte_length, finalize_cb, finalize_hint, result) {
          var value;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!result)
              return envObject.setLastError(1);
            byte_length >>>= 0;
            external_data >>>= 0;
            result >>>= 0;
            byte_length = byte_length >>> 0;
            if (!external_data) {
              byte_length = 0;
            }
            if (external_data + byte_length > wasmMemory.buffer.byteLength) {
              throw new RangeError("Memory out of range");
            }
            if (!emnapiCtx.feature.supportFinalizer && finalize_cb) {
              throw emnapiCtx.createNotSupportWeakRefError("napi_create_external_arraybuffer", 'Parameter "finalize_cb" must be 0(NULL)');
            }
            var arrayBuffer = new ArrayBuffer(byte_length);
            if (byte_length === 0) {
              try {
                var MessageChannel_1 = emnapiCtx.feature.MessageChannel;
                var messageChannel = new MessageChannel_1();
                messageChannel.port1.postMessage(arrayBuffer, [arrayBuffer]);
              } catch (_) {
              }
            } else {
              var u8arr = new Uint8Array(arrayBuffer);
              u8arr.set(new Uint8Array(wasmMemory.buffer).subarray(external_data, external_data + byte_length));
              emnapiExternalMemory.table.set(arrayBuffer, {
                address: external_data,
                ownership: 1,
                runtimeAllocated: 0
              });
            }
            var handle = emnapiCtx.addToCurrentScope(arrayBuffer);
            if (finalize_cb) {
              var status_1 = napi_add_finalizer(env, handle.id, external_data, finalize_cb, finalize_hint, 0);
              if (status_1 === 10) {
                var err2 = envObject.tryCatch.extractException();
                envObject.clearLastError();
                throw err2;
              } else if (status_1 !== 0) {
                return envObject.setLastError(status_1);
              }
            }
            value = handle.id;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(result, value, true);
            return envObject.getReturnStatus();
          } catch (err3) {
            envObject.tryCatch.setError(err3);
            return envObject.setLastError(10);
          }
        }
        function node_api_create_external_sharedarraybuffer(env, external_data, byte_length, finalize_cb, finalize_hint, result) {
          var value;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!result)
              return envObject.setLastError(1);
            byte_length >>>= 0;
            external_data >>>= 0;
            result >>>= 0;
            byte_length = byte_length >>> 0;
            if (!external_data) {
              byte_length = 0;
            }
            if (external_data + byte_length > wasmMemory.buffer.byteLength) {
              throw new RangeError("Memory out of range");
            }
            if (!emnapiExternalSAB.registry && finalize_cb) {
              throw emnapiCtx.createNotSupportWeakRefError("node_api_create_external_sharedarraybuffer", 'Parameter "finalize_cb" must be 0(NULL)');
            }
            var sharedArrayBuffer = new SharedArrayBuffer(byte_length);
            if (byte_length !== 0) {
              var u8arr = new Uint8Array(sharedArrayBuffer);
              u8arr.set(new Uint8Array(wasmMemory.buffer).subarray(external_data, external_data + byte_length));
              emnapiExternalMemory.table.set(sharedArrayBuffer, {
                address: external_data,
                ownership: 1,
                runtimeAllocated: 0
              });
            }
            value = emnapiCtx.addToCurrentScope(sharedArrayBuffer).id;
            if (finalize_cb) {
              finalize_cb >>>= 0;
              finalize_hint >>>= 0;
              var metaPtr = emnapiExternalSAB.allocMeta(external_data, byte_length, finalize_cb, external_data, finalize_hint);
              emnapiExternalSAB.handleTable.set(sharedArrayBuffer, metaPtr);
              emnapiExternalSAB.registry.register(sharedArrayBuffer, metaPtr);
            }
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(result, value, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_create_object(env, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!result)
            return envObject.setLastError(1);
          result >>>= 0;
          var value = emnapiCtx.addToCurrentScope({}).id;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, value, true);
          return envObject.clearLastError();
        }
        function node_api_create_object_with_properties(env, prototype_or_null, property_names, property_values, property_count, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!result)
            return envObject.setLastError(1);
          property_count >>>= 0;
          property_count = property_count >>> 0;
          if (property_count > 0) {
            if (!property_names)
              return envObject.setLastError(1);
            if (!property_values)
              return envObject.setLastError(1);
          }
          var v8_prototype_or_null = prototype_or_null ? emnapiCtx.handleStore.get(prototype_or_null).value : null;
          var properties = {};
          property_names >>>= 0;
          property_values >>>= 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          for (var i = 0; i < property_count; i++) {
            var name_value = emnapiCtx.handleStore.get(HEAP_DATA_VIEW.getUint32(property_names + i * 4, true)).value;
            if (!(typeof name_value === "string" || typeof name_value === "symbol"))
              return envObject.setLastError(4);
            properties[name_value] = {
              value: emnapiCtx.handleStore.get(HEAP_DATA_VIEW.getUint32(property_values + i * 4, true)).value,
              writable: true,
              enumerable: true,
              configurable: true
            };
          }
          var obj;
          try {
            obj = Object.defineProperties(Object.create(v8_prototype_or_null), properties);
          } catch (_) {
            return envObject.setLastError(9);
          }
          var value = emnapiCtx.addToCurrentScope(obj).id;
          result >>>= 0;
          HEAP_DATA_VIEW.setUint32(result, value, true);
          return envObject.clearLastError();
        }
        function napi_create_symbol(env, description, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!result)
            return envObject.setLastError(1);
          result >>>= 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          if (!description) {
            var value = emnapiCtx.addToCurrentScope(Symbol()).id;
            HEAP_DATA_VIEW.setUint32(result, value, true);
          } else {
            var handle = emnapiCtx.handleStore.get(description);
            var desc = handle.value;
            if (typeof desc !== "string") {
              return envObject.setLastError(3);
            }
            var v = emnapiCtx.addToCurrentScope(Symbol(desc)).id;
            HEAP_DATA_VIEW.setUint32(result, v, true);
          }
          return envObject.clearLastError();
        }
        function napi_create_typedarray(env, type, length, arraybuffer, byte_offset, result) {
          var value;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!arraybuffer)
              return envObject.setLastError(1);
            if (!result)
              return envObject.setLastError(1);
            var handle = emnapiCtx.handleStore.get(arraybuffer);
            var buffer = handle.value;
            byte_offset >>>= 0;
            length >>>= 0;
            var createTypedArray = function(envObject2, Type, size_of_element, buffer2, byte_offset2, length2) {
              var _a;
              byte_offset2 = byte_offset2 >>> 0;
              length2 = length2 >>> 0;
              if (size_of_element > 1) {
                if (byte_offset2 % size_of_element !== 0) {
                  var err2 = new RangeError("start offset of ".concat((_a = Type.name) !== null && _a !== void 0 ? _a : "", " should be a multiple of ").concat(size_of_element));
                  err2.code = "ERR_NAPI_INVALID_TYPEDARRAY_ALIGNMENT";
                  envObject2.tryCatch.setError(err2);
                  return envObject2.setLastError(9);
                }
              }
              if (length2 * size_of_element + byte_offset2 > buffer2.byteLength) {
                var err2 = new RangeError("Invalid typed array length");
                err2.code = "ERR_NAPI_INVALID_TYPEDARRAY_LENGTH";
                envObject2.tryCatch.setError(err2);
                return envObject2.setLastError(9);
              }
              var out = new Type(buffer2, byte_offset2, length2);
              if (buffer2 === wasmMemory.buffer) {
                if (!emnapiExternalMemory.wasmMemoryViewTable.has(out)) {
                  emnapiExternalMemory.wasmMemoryViewTable.set(out, {
                    Ctor: Type,
                    address: byte_offset2,
                    length: length2,
                    ownership: 1,
                    runtimeAllocated: 0
                  });
                }
              }
              result >>>= 0;
              value = emnapiCtx.addToCurrentScope(out).id;
              var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
              HEAP_DATA_VIEW.setUint32(result, value, true);
              return envObject2.getReturnStatus();
            };
            if (buffer instanceof ArrayBuffer || emnapiExternalMemory.isSharedArrayBuffer(buffer)) {
              switch (type) {
                case 0:
                  return createTypedArray(envObject, Int8Array, 1, buffer, byte_offset, length);
                case 1:
                  return createTypedArray(envObject, Uint8Array, 1, buffer, byte_offset, length);
                case 2:
                  return createTypedArray(envObject, Uint8ClampedArray, 1, buffer, byte_offset, length);
                case 3:
                  return createTypedArray(envObject, Int16Array, 2, buffer, byte_offset, length);
                case 4:
                  return createTypedArray(envObject, Uint16Array, 2, buffer, byte_offset, length);
                case 5:
                  return createTypedArray(envObject, Int32Array, 4, buffer, byte_offset, length);
                case 6:
                  return createTypedArray(envObject, Uint32Array, 4, buffer, byte_offset, length);
                case 7:
                  return createTypedArray(envObject, Float32Array, 4, buffer, byte_offset, length);
                case 8:
                  return createTypedArray(envObject, Float64Array, 8, buffer, byte_offset, length);
                case 9:
                  return createTypedArray(envObject, BigInt64Array, 8, buffer, byte_offset, length);
                case 10:
                  return createTypedArray(envObject, BigUint64Array, 8, buffer, byte_offset, length);
                case 11:
                  if (typeof Float16Array !== "function") {
                    return envObject.setLastError(1);
                  }
                  return createTypedArray(envObject, Float16Array, 2, buffer, byte_offset, length);
                default:
                  return envObject.setLastError(1);
              }
            } else {
              return envObject.setLastError(1);
            }
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_create_buffer(env, size, data, result) {
          var _a;
          var value, pointer;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!result)
              return envObject.setLastError(1);
            var Buffer2 = emnapiCtx.feature.Buffer;
            if (!Buffer2) {
              throw emnapiCtx.createNotSupportBufferError("napi_create_buffer", "");
            }
            result >>>= 0;
            var buffer = void 0;
            size >>>= 0;
            size = size >>> 0;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            if (!data || size === 0) {
              buffer = Buffer2.alloc(size);
              value = emnapiCtx.addToCurrentScope(buffer).id;
              HEAP_DATA_VIEW.setUint32(result, value, true);
            } else {
              pointer = _malloc(size);
              if (!pointer)
                throw new Error("Out of memory");
              pointer >>>= 0;
              new Uint8Array(wasmMemory.buffer).subarray(pointer, pointer + size).fill(0);
              var buffer_1 = Buffer2.from(wasmMemory.buffer, pointer, size);
              var viewDescriptor = {
                Ctor: Buffer2,
                address: pointer,
                length: size,
                ownership: emnapiExternalMemory.registry ? 0 : 1,
                runtimeAllocated: 1
              };
              emnapiExternalMemory.wasmMemoryViewTable.set(buffer_1, viewDescriptor);
              (_a = emnapiExternalMemory.registry) === null || _a === void 0 ? void 0 : _a.register(viewDescriptor, pointer);
              value = emnapiCtx.addToCurrentScope(buffer_1).id;
              HEAP_DATA_VIEW.setUint32(result, value, true);
              data >>>= 0;
              HEAP_DATA_VIEW.setUint32(data, pointer, true);
            }
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_create_buffer_copy(env, length, data, result_data, result) {
          var value;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!result)
              return envObject.setLastError(1);
            var Buffer2 = emnapiCtx.feature.Buffer;
            if (!Buffer2) {
              throw emnapiCtx.createNotSupportBufferError("napi_create_buffer_copy", "");
            }
            var arrayBuffer = emnapiCreateArrayBuffer(length, result_data, false);
            var buffer = Buffer2.from(arrayBuffer);
            data >>>= 0;
            length >>>= 0;
            buffer.set(new Uint8Array(wasmMemory.buffer).subarray(data, data + length));
            value = emnapiCtx.addToCurrentScope(buffer).id;
            result >>>= 0;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(result, value, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_create_external_buffer(env, length, data, finalize_cb, finalize_hint, result) {
          return emnapi_create_memory_view(env, -2, data, length, finalize_cb, finalize_hint, result);
        }
        function node_api_create_buffer_from_arraybuffer(env, arraybuffer, byte_offset, byte_length, result) {
          var value;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!arraybuffer)
              return envObject.setLastError(1);
            if (!result)
              return envObject.setLastError(1);
            byte_offset >>>= 0;
            byte_length >>>= 0;
            byte_offset = byte_offset >>> 0;
            byte_length = byte_length >>> 0;
            var handle = emnapiCtx.handleStore.get(arraybuffer);
            if (!handle.isArrayBuffer()) {
              return envObject.setLastError(1);
            }
            var buffer = handle.value;
            if (byte_length + byte_offset > buffer.byteLength) {
              var err2 = new RangeError("The byte offset + length is out of range");
              err2.code = "ERR_OUT_OF_RANGE";
              throw err2;
            }
            var Buffer2 = emnapiCtx.feature.Buffer;
            if (!Buffer2) {
              throw emnapiCtx.createNotSupportBufferError("node_api_create_buffer_from_arraybuffer", "");
            }
            var out = Buffer2.from(buffer, byte_offset, byte_length);
            if (buffer === wasmMemory.buffer) {
              if (!emnapiExternalMemory.wasmMemoryViewTable.has(out)) {
                emnapiExternalMemory.wasmMemoryViewTable.set(out, {
                  Ctor: Buffer2,
                  address: byte_offset,
                  length: byte_length,
                  ownership: 1,
                  runtimeAllocated: 0
                });
              }
            }
            result >>>= 0;
            value = emnapiCtx.addToCurrentScope(out).id;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(result, value, true);
            return envObject.getReturnStatus();
          } catch (err3) {
            envObject.tryCatch.setError(err3);
            return envObject.setLastError(10);
          }
        }
        function napi_create_dataview(env, byte_length, arraybuffer, byte_offset, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!arraybuffer)
              return envObject.setLastError(1);
            if (!result)
              return envObject.setLastError(1);
            byte_length >>>= 0;
            byte_offset >>>= 0;
            byte_length = byte_length >>> 0;
            byte_offset = byte_offset >>> 0;
            var value = emnapiCtx.handleStore.get(arraybuffer).value;
            var createDataview = function(buffer) {
              if (byte_length + byte_offset > buffer.byteLength) {
                var err2 = new RangeError("byte_offset + byte_length should be less than or equal to the size in bytes of the array passed in");
                err2.code = "ERR_NAPI_INVALID_DATAVIEW_ARGS";
                throw err2;
              }
              var dataview = new DataView(buffer, byte_offset, byte_length);
              if (buffer === wasmMemory.buffer) {
                if (!emnapiExternalMemory.wasmMemoryViewTable.has(dataview)) {
                  emnapiExternalMemory.wasmMemoryViewTable.set(dataview, {
                    Ctor: DataView,
                    address: byte_offset,
                    length: byte_length,
                    ownership: 1,
                    runtimeAllocated: 0
                  });
                }
              }
              result >>>= 0;
              var v = emnapiCtx.addToCurrentScope(dataview).id;
              var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
              HEAP_DATA_VIEW.setUint32(result, v, true);
              return envObject.getReturnStatus();
            };
            if (value instanceof ArrayBuffer || emnapiExternalMemory.isSharedArrayBuffer(value)) {
              return createDataview(value);
            } else {
              return envObject.setLastError(1);
            }
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function node_api_symbol_for(env, utf8description, length, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!result)
            return envObject.setLastError(1);
          length >>>= 0;
          utf8description >>>= 0;
          result >>>= 0;
          var autoLength = length === -1 || length === 4294967295;
          var sizelength = length >>> 0;
          if (length !== 0) {
            if (!utf8description)
              return envObject.setLastError(1);
          }
          if (!(autoLength || sizelength <= 2147483647)) {
            return envObject.setLastError(1);
          }
          var descriptionString = emnapiString.UTF8ToString(utf8description, length);
          var value = emnapiCtx.addToCurrentScope(Symbol.for(descriptionString)).id;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, value, true);
          return envObject.clearLastError();
        }
        var createMod = Object.freeze({
          __proto__: null,
          napi_create_array,
          napi_create_array_with_length,
          napi_create_arraybuffer,
          napi_create_buffer,
          napi_create_buffer_copy,
          napi_create_dataview,
          napi_create_date,
          napi_create_external,
          napi_create_external_arraybuffer,
          napi_create_external_buffer,
          napi_create_object,
          napi_create_symbol,
          napi_create_typedarray,
          node_api_create_buffer_from_arraybuffer,
          node_api_create_external_sharedarraybuffer,
          node_api_create_object_with_properties,
          node_api_create_sharedarraybuffer,
          node_api_symbol_for
        });
        function napi_get_boolean(env, value, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!result)
            return envObject.setLastError(1);
          result >>>= 0;
          var v = value === 0 ? 3 : 4;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, v, true);
          return envObject.clearLastError();
        }
        function napi_get_global(env, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!result)
            return envObject.setLastError(1);
          result >>>= 0;
          var value = 5;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, value, true);
          return envObject.clearLastError();
        }
        function napi_get_null(env, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!result)
            return envObject.setLastError(1);
          result >>>= 0;
          var value = 2;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, value, true);
          return envObject.clearLastError();
        }
        function napi_get_undefined(env, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!result)
            return envObject.setLastError(1);
          result >>>= 0;
          var value = 1;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, value, true);
          return envObject.clearLastError();
        }
        var globalMod = Object.freeze({
          __proto__: null,
          napi_get_boolean,
          napi_get_global,
          napi_get_null,
          napi_get_undefined
        });
        function napi_set_instance_data(env, data, finalize_cb, finalize_hint) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          data >>>= 0;
          finalize_cb >>>= 0;
          finalize_hint >>>= 0;
          envObject.setInstanceData(data, finalize_cb, finalize_hint);
          return envObject.clearLastError();
        }
        function napi_get_instance_data(env, data) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          if (!data)
            return envObject.setLastError(1);
          data >>>= 0;
          var value = envObject.getInstanceData();
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(data, value, true);
          return envObject.clearLastError();
        }
        var envMod = Object.freeze({
          __proto__: null,
          napi_get_instance_data,
          napi_set_instance_data
        });
        function _emnapi_get_last_error_info(env, error_code, engine_error_code, engine_reserved) {
          error_code >>>= 0;
          engine_error_code >>>= 0;
          engine_reserved >>>= 0;
          var envObject = emnapiCtx.envStore.get(env);
          var lastError = envObject.lastError;
          var errorCode = lastError.errorCode;
          var engineErrorCode = lastError.engineErrorCode >>> 0;
          var engineReserved = lastError.engineReserved;
          engineReserved >>>= 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setInt32(error_code, errorCode, true);
          HEAP_DATA_VIEW.setUint32(engine_error_code, engineErrorCode, true);
          HEAP_DATA_VIEW.setUint32(engine_reserved, engineReserved, true);
        }
        function napi_throw(env, error) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!error)
              return envObject.setLastError(1);
            envObject.tryCatch.setError(emnapiCtx.handleStore.get(error).value);
            return envObject.clearLastError();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_throw_error(env, code, msg) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!msg)
              return envObject.setLastError(1);
            code >>>= 0;
            msg >>>= 0;
            var error = new Error(emnapiString.UTF8ToString(msg, -1));
            if (code)
              error.code = emnapiString.UTF8ToString(code, -1);
            envObject.tryCatch.setError(error);
            return envObject.clearLastError();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_throw_type_error(env, code, msg) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!msg)
              return envObject.setLastError(1);
            code >>>= 0;
            msg >>>= 0;
            var error = new TypeError(emnapiString.UTF8ToString(msg, -1));
            if (code)
              error.code = emnapiString.UTF8ToString(code, -1);
            envObject.tryCatch.setError(error);
            return envObject.clearLastError();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_throw_range_error(env, code, msg) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!msg)
              return envObject.setLastError(1);
            code >>>= 0;
            msg >>>= 0;
            var error = new RangeError(emnapiString.UTF8ToString(msg, -1));
            if (code)
              error.code = emnapiString.UTF8ToString(code, -1);
            envObject.tryCatch.setError(error);
            return envObject.clearLastError();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function node_api_throw_syntax_error(env, code, msg) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!msg)
              return envObject.setLastError(1);
            code >>>= 0;
            msg >>>= 0;
            var error = new SyntaxError(emnapiString.UTF8ToString(msg, -1));
            if (code)
              error.code = emnapiString.UTF8ToString(code, -1);
            envObject.tryCatch.setError(error);
            return envObject.clearLastError();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_is_exception_pending(env, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!result)
            return envObject.setLastError(1);
          var r = envObject.tryCatch.hasCaught();
          result >>>= 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setInt8(result, r ? 1 : 0, true);
          return envObject.clearLastError();
        }
        function napi_create_error(env, code, msg, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!msg)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          var msgValue = emnapiCtx.handleStore.get(msg).value;
          if (typeof msgValue !== "string") {
            return envObject.setLastError(3);
          }
          var error = new Error(msgValue);
          if (code) {
            var codeValue = emnapiCtx.handleStore.get(code).value;
            if (typeof codeValue !== "string") {
              return envObject.setLastError(3);
            }
            error.code = codeValue;
          }
          result >>>= 0;
          var value = emnapiCtx.addToCurrentScope(error).id;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, value, true);
          return envObject.clearLastError();
        }
        function napi_create_type_error(env, code, msg, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!msg)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          var msgValue = emnapiCtx.handleStore.get(msg).value;
          if (typeof msgValue !== "string") {
            return envObject.setLastError(3);
          }
          var error = new TypeError(msgValue);
          if (code) {
            var codeValue = emnapiCtx.handleStore.get(code).value;
            if (typeof codeValue !== "string") {
              return envObject.setLastError(3);
            }
            error.code = codeValue;
          }
          result >>>= 0;
          var value = emnapiCtx.addToCurrentScope(error).id;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, value, true);
          return envObject.clearLastError();
        }
        function napi_create_range_error(env, code, msg, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!msg)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          var msgValue = emnapiCtx.handleStore.get(msg).value;
          if (typeof msgValue !== "string") {
            return envObject.setLastError(3);
          }
          var error = new RangeError(msgValue);
          if (code) {
            var codeValue = emnapiCtx.handleStore.get(code).value;
            if (typeof codeValue !== "string") {
              return envObject.setLastError(3);
            }
            error.code = codeValue;
          }
          result >>>= 0;
          var value = emnapiCtx.addToCurrentScope(error).id;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, value, true);
          return envObject.clearLastError();
        }
        function node_api_create_syntax_error(env, code, msg, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!msg)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          var msgValue = emnapiCtx.handleStore.get(msg).value;
          if (typeof msgValue !== "string") {
            return envObject.setLastError(3);
          }
          var error = new SyntaxError(msgValue);
          if (code) {
            var codeValue = emnapiCtx.handleStore.get(code).value;
            if (typeof codeValue !== "string") {
              return envObject.setLastError(3);
            }
            error.code = codeValue;
          }
          result >>>= 0;
          var value = emnapiCtx.addToCurrentScope(error).id;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, value, true);
          return envObject.clearLastError();
        }
        function napi_get_and_clear_last_exception(env, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!result)
            return envObject.setLastError(1);
          result >>>= 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          if (!envObject.tryCatch.hasCaught()) {
            HEAP_DATA_VIEW.setUint32(result, 1, true);
            return envObject.clearLastError();
          } else {
            var err2 = envObject.tryCatch.exception();
            var value = envObject.ensureHandleId(err2);
            HEAP_DATA_VIEW.setUint32(result, value, true);
            envObject.tryCatch.reset();
          }
          return envObject.clearLastError();
        }
        function napi_fatal_error(location, location_len, message, message_len) {
          location >>>= 0;
          location_len >>>= 0;
          message >>>= 0;
          message_len >>>= 0;
          var locationStr = emnapiString.UTF8ToString(location, location_len);
          var messageStr = emnapiString.UTF8ToString(message, message_len);
          if (emnapiNodeBinding) {
            emnapiNodeBinding.napi.fatalError(locationStr, messageStr);
          } else {
            abort("FATAL ERROR: " + locationStr + " " + messageStr);
          }
        }
        function napi_fatal_exception(env, err2) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!err2)
              return envObject.setLastError(1);
            var error = envObject.ctx.handleStore.get(err2);
            try {
              envObject.triggerFatalException(error.value);
            } catch (_) {
              return envObject.setLastError(9);
            }
            return envObject.clearLastError();
          } catch (err3) {
            envObject.tryCatch.setError(err3);
            return envObject.setLastError(10);
          }
        }
        var errorMod = Object.freeze({
          __proto__: null,
          _emnapi_get_last_error_info,
          napi_create_error,
          napi_create_range_error,
          napi_create_type_error,
          napi_fatal_error,
          napi_fatal_exception,
          napi_get_and_clear_last_exception,
          napi_is_exception_pending,
          napi_throw,
          napi_throw_error,
          napi_throw_range_error,
          napi_throw_type_error,
          node_api_create_syntax_error,
          node_api_throw_syntax_error
        });
        function _emnapi_create_function(env, utf8name, length, cb, data, result) {
          length >>>= 0;
          var envObject = emnapiCtx.envStore.get(env);
          var fresult = emnapiCreateFunction(envObject, utf8name, length, cb, data);
          if (fresult.status !== 0)
            return envObject.setLastError(fresult.status);
          var f = fresult.f;
          var valueHandle = emnapiCtx.addToCurrentScope(f);
          result >>>= 0;
          var value = valueHandle.id;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, value, true);
          return envObject.getReturnStatus();
        }
        function napi_create_function(env, utf8name, length, cb, data, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!result)
              return envObject.setLastError(1);
            if (!cb)
              return envObject.setLastError(1);
            return _emnapi_create_function(env, utf8name, length, cb, data, result);
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_get_cb_info(env, cbinfo, argc, argv, this_arg, data) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          if (!cbinfo)
            return envObject.setLastError(1);
          var cbinfoValue = emnapiCtx.scopeStore.get(cbinfo).callbackInfo;
          argc >>>= 0;
          argv >>>= 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          if (argv) {
            if (!argc)
              return envObject.setLastError(1);
            var argcValue = HEAP_DATA_VIEW.getUint32(argc, true);
            argcValue >>>= 0;
            var len = cbinfoValue.args.length;
            var arrlen = argcValue < len ? argcValue : len;
            var i = 0;
            for (; i < arrlen; i++) {
              var argVal = envObject.ensureHandleId(cbinfoValue.args[i]);
              HEAP_DATA_VIEW.setUint32(argv + i * 4, argVal, true);
            }
            if (i < argcValue) {
              for (; i < argcValue; i++) {
                HEAP_DATA_VIEW.setUint32(argv + i * 4, 1, true);
              }
            }
          }
          if (argc) {
            HEAP_DATA_VIEW.setUint32(argc, cbinfoValue.args.length, true);
          }
          if (this_arg) {
            this_arg >>>= 0;
            var v = envObject.ensureHandleId(cbinfoValue.thiz);
            HEAP_DATA_VIEW.setUint32(this_arg, v, true);
          }
          if (data) {
            data >>>= 0;
            HEAP_DATA_VIEW.setUint32(data, cbinfoValue.data, true);
          }
          return envObject.clearLastError();
        }
        function napi_call_function(env, recv, func, argc, argv, result) {
          var i = 0;
          var v;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!recv)
              return envObject.setLastError(1);
            argc >>>= 0;
            argv >>>= 0;
            result >>>= 0;
            argc = argc >>> 0;
            if (argc > 0) {
              if (!argv)
                return envObject.setLastError(1);
            }
            var v8recv = emnapiCtx.handleStore.get(recv).value;
            if (!func)
              return envObject.setLastError(1);
            var v8func = emnapiCtx.handleStore.get(func).value;
            if (typeof v8func !== "function")
              return envObject.setLastError(1);
            var args = [];
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            for (; i < argc; i++) {
              var argVal = HEAP_DATA_VIEW.getUint32(argv + i * 4, true);
              args.push(emnapiCtx.handleStore.get(argVal).value);
            }
            var ret = v8func.apply(v8recv, args);
            if (result) {
              v = envObject.ensureHandleId(ret);
              HEAP_DATA_VIEW.setUint32(result, v, true);
            }
            return envObject.clearLastError();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_new_instance(env, constructor, argc, argv, result) {
          var i;
          var v;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!constructor)
              return envObject.setLastError(1);
            argc >>>= 0;
            argv >>>= 0;
            result >>>= 0;
            argc = argc >>> 0;
            if (argc > 0) {
              if (!argv)
                return envObject.setLastError(1);
            }
            if (!result)
              return envObject.setLastError(1);
            var Ctor = emnapiCtx.handleStore.get(constructor).value;
            if (typeof Ctor !== "function")
              return envObject.setLastError(1);
            var ret = void 0;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            if (emnapiCtx.feature.supportReflect) {
              var argList = Array(argc);
              for (i = 0; i < argc; i++) {
                var argVal = HEAP_DATA_VIEW.getUint32(argv + i * 4, true);
                argList[i] = emnapiCtx.handleStore.get(argVal).value;
              }
              ret = Reflect.construct(Ctor, argList, Ctor);
            } else {
              var args = Array(argc + 1);
              args[0] = void 0;
              for (i = 0; i < argc; i++) {
                var argVal = HEAP_DATA_VIEW.getUint32(argv + i * 4, true);
                args[i + 1] = emnapiCtx.handleStore.get(argVal).value;
              }
              var BoundCtor = Ctor.bind.apply(Ctor, args);
              ret = new BoundCtor();
            }
            if (result) {
              v = envObject.ensureHandleId(ret);
              HEAP_DATA_VIEW.setUint32(result, v, true);
            }
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_get_new_target(env, cbinfo, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!cbinfo)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          result >>>= 0;
          var cbinfoValue = emnapiCtx.scopeStore.get(cbinfo).callbackInfo;
          var thiz = cbinfoValue.thiz, fn = cbinfoValue.fn;
          var value = thiz == null || thiz.constructor == null ? 0 : thiz instanceof fn ? envObject.ensureHandleId(thiz.constructor) : 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, value, true);
          return envObject.clearLastError();
        }
        var functionMod = Object.freeze({
          __proto__: null,
          _emnapi_create_function,
          napi_call_function,
          napi_create_function,
          napi_get_cb_info,
          napi_get_new_target,
          napi_new_instance
        });
        function napi_open_handle_scope(env, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!result)
            return envObject.setLastError(1);
          var scope = emnapiCtx.openScope(envObject);
          result >>>= 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, scope.id, true);
          return envObject.clearLastError();
        }
        function napi_close_handle_scope(env, scope) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!scope)
            return envObject.setLastError(1);
          if (envObject.openHandleScopes === 0) {
            return 13;
          }
          emnapiCtx.closeScope(envObject);
          return envObject.clearLastError();
        }
        function napi_open_escapable_handle_scope(env, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!result)
            return envObject.setLastError(1);
          var scope = emnapiCtx.openScope(envObject);
          result >>>= 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, scope.id, true);
          return envObject.clearLastError();
        }
        function napi_close_escapable_handle_scope(env, scope) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!scope)
            return envObject.setLastError(1);
          if (envObject.openHandleScopes === 0) {
            return 13;
          }
          emnapiCtx.closeScope(envObject);
          return envObject.clearLastError();
        }
        function napi_escape_handle(env, scope, escapee, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!scope)
            return envObject.setLastError(1);
          if (!escapee)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          var scopeObject = emnapiCtx.scopeStore.get(scope);
          if (!scopeObject.escapeCalled()) {
            escapee >>>= 0;
            result >>>= 0;
            var newHandle = scopeObject.escape(escapee);
            var value = newHandle ? newHandle.id : 0;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(result, value, true);
            return envObject.clearLastError();
          }
          return envObject.setLastError(12);
        }
        function napi_create_reference(env, value, initial_refcount, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!value)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          var handle = emnapiCtx.handleStore.get(value);
          if (envObject.moduleApiVersion < 10) {
            if (!(handle.isObject() || handle.isFunction() || handle.isSymbol())) {
              return envObject.setLastError(1);
            }
          }
          var ref = emnapiCtx.createReference(envObject, handle.id, initial_refcount >>> 0, 1);
          result >>>= 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, ref.id, true);
          return envObject.clearLastError();
        }
        function napi_delete_reference(env, ref) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          if (!ref)
            return envObject.setLastError(1);
          emnapiCtx.refStore.get(ref).dispose();
          return envObject.clearLastError();
        }
        function napi_reference_ref(env, ref, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!ref)
            return envObject.setLastError(1);
          var count = emnapiCtx.refStore.get(ref).ref();
          if (result) {
            result >>>= 0;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(result, count, true);
          }
          return envObject.clearLastError();
        }
        function napi_reference_unref(env, ref, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!ref)
            return envObject.setLastError(1);
          var reference = emnapiCtx.refStore.get(ref);
          var refcount = reference.refcount();
          if (refcount === 0) {
            return envObject.setLastError(9);
          }
          var count = reference.unref();
          if (result) {
            result >>>= 0;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(result, count, true);
          }
          return envObject.clearLastError();
        }
        function napi_get_reference_value(env, ref, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!ref)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          var reference = emnapiCtx.refStore.get(ref);
          var handleId = reference.get(envObject);
          result >>>= 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, handleId, true);
          return envObject.clearLastError();
        }
        function napi_add_env_cleanup_hook(env, fun, arg) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          if (!fun)
            return envObject.setLastError(1);
          fun >>>= 0;
          arg >>>= 0;
          emnapiCtx.addCleanupHook(envObject, fun, arg);
          return 0;
        }
        function napi_remove_env_cleanup_hook(env, fun, arg) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          if (!fun)
            return envObject.setLastError(1);
          fun >>>= 0;
          arg >>>= 0;
          emnapiCtx.removeCleanupHook(envObject, fun, arg);
          return 0;
        }
        function _emnapi_env_ref(env) {
          var envObject = emnapiCtx.envStore.get(env);
          envObject.ref();
        }
        function _emnapi_env_unref(env) {
          var envObject = emnapiCtx.envStore.get(env);
          envObject.unref();
        }
        var lifeMod = Object.freeze({
          __proto__: null,
          _emnapi_env_ref,
          _emnapi_env_unref,
          napi_add_env_cleanup_hook,
          napi_close_escapable_handle_scope,
          napi_close_handle_scope,
          napi_create_reference,
          napi_delete_reference,
          napi_escape_handle,
          napi_get_reference_value,
          napi_open_escapable_handle_scope,
          napi_open_handle_scope,
          napi_reference_ref,
          napi_reference_unref,
          napi_remove_env_cleanup_hook
        });
        function _emnapi_get_filename(env, buf, len) {
          var envObject = emnapiCtx.envStore.get(env);
          var filename = envObject.filename;
          if (!buf) {
            return emnapiString.lengthBytesUTF8(filename);
          }
          return emnapiString.stringToUTF8(filename, buf, len);
        }
        var miscellaneousMod = Object.freeze({
          __proto__: null,
          _emnapi_get_filename
        });
        function napi_create_promise(env, deferred, promise) {
          var deferredObjectId, value;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!deferred)
              return envObject.setLastError(1);
            if (!promise)
              return envObject.setLastError(1);
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            var p = new Promise(function(resolve, reject) {
              var deferredObject = emnapiCtx.createDeferred({ resolve, reject });
              deferredObjectId = deferredObject.id;
              deferred >>>= 0;
              HEAP_DATA_VIEW.setUint32(deferred, deferredObjectId, true);
            });
            promise >>>= 0;
            value = emnapiCtx.addToCurrentScope(p).id;
            HEAP_DATA_VIEW.setUint32(promise, value, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_resolve_deferred(env, deferred, resolution) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!deferred)
              return envObject.setLastError(1);
            if (!resolution)
              return envObject.setLastError(1);
            var deferredObject = emnapiCtx.deferredStore.get(deferred);
            deferredObject.resolve(emnapiCtx.handleStore.get(resolution).value);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_reject_deferred(env, deferred, resolution) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!deferred)
              return envObject.setLastError(1);
            if (!resolution)
              return envObject.setLastError(1);
            var deferredObject = emnapiCtx.deferredStore.get(deferred);
            deferredObject.reject(emnapiCtx.handleStore.get(resolution).value);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_is_promise(env, value, is_promise) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!value)
            return envObject.setLastError(1);
          if (!is_promise)
            return envObject.setLastError(1);
          var h = emnapiCtx.handleStore.get(value);
          is_promise >>>= 0;
          var r = h.isPromise() ? 1 : 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setInt8(is_promise, r, true);
          return envObject.clearLastError();
        }
        var promiseMod = Object.freeze({
          __proto__: null,
          napi_create_promise,
          napi_is_promise,
          napi_reject_deferred,
          napi_resolve_deferred
        });
        function napi_get_all_property_names(env, object, key_mode, key_filter, key_conversion, result) {
          var value;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!result)
              return envObject.setLastError(1);
            if (!object)
              return envObject.setLastError(1);
            var h = emnapiCtx.handleStore.get(object);
            if (h.value == null) {
              throw new TypeError("Cannot convert undefined or null to object");
            }
            var obj = void 0;
            try {
              obj = h.isObject() || h.isFunction() ? h.value : Object(h.value);
            } catch (_) {
              return envObject.setLastError(2);
            }
            if (key_mode !== 0 && key_mode !== 1) {
              return envObject.setLastError(1);
            }
            if (key_conversion !== 0 && key_conversion !== 1) {
              return envObject.setLastError(1);
            }
            var props = [];
            var names = void 0;
            var symbols = void 0;
            var i = void 0;
            var own = true;
            var integerIndiceRegex = /^(0|[1-9][0-9]*)$/;
            do {
              names = Object.getOwnPropertyNames(obj);
              symbols = Object.getOwnPropertySymbols(obj);
              for (i = 0; i < names.length; i++) {
                props.push({
                  name: integerIndiceRegex.test(names[i]) ? Number(names[i]) : names[i],
                  desc: Object.getOwnPropertyDescriptor(obj, names[i]),
                  own
                });
              }
              for (i = 0; i < symbols.length; i++) {
                props.push({
                  name: symbols[i],
                  desc: Object.getOwnPropertyDescriptor(obj, symbols[i]),
                  own
                });
              }
              if (key_mode === 1) {
                break;
              }
              obj = Object.getPrototypeOf(obj);
              own = false;
            } while (obj);
            var ret = [];
            var addName = function(ret2, name, key_filter2, conversion_mode) {
              if (ret2.indexOf(name) !== -1)
                return;
              if (conversion_mode === 0) {
                ret2.push(name);
              } else if (conversion_mode === 1) {
                var realName = typeof name === "number" ? String(name) : name;
                if (typeof realName === "string") {
                  if (!(key_filter2 & 8)) {
                    ret2.push(realName);
                  }
                } else {
                  ret2.push(realName);
                }
              }
            };
            for (i = 0; i < props.length; i++) {
              var prop = props[i];
              var name_1 = prop.name;
              var desc = prop.desc;
              if (key_filter === 0) {
                addName(ret, name_1, key_filter, key_conversion);
              } else {
                if (key_filter & 8 && typeof name_1 === "string") {
                  continue;
                }
                if (key_filter & 16 && typeof name_1 === "symbol") {
                  continue;
                }
                var shouldAdd = true;
                switch (key_filter & 7) {
                  case 1: {
                    shouldAdd = Boolean(desc.writable);
                    break;
                  }
                  case 2: {
                    shouldAdd = Boolean(desc.enumerable);
                    break;
                  }
                  case 1 | 2: {
                    shouldAdd = Boolean(desc.writable && desc.enumerable);
                    break;
                  }
                  case 4: {
                    shouldAdd = Boolean(desc.configurable);
                    break;
                  }
                  case 4 | 1: {
                    shouldAdd = Boolean(desc.configurable && desc.writable);
                    break;
                  }
                  case 4 | 2: {
                    shouldAdd = Boolean(desc.configurable && desc.enumerable);
                    break;
                  }
                  case 4 | 2 | 1: {
                    shouldAdd = Boolean(desc.configurable && desc.enumerable && desc.writable);
                    break;
                  }
                }
                if (shouldAdd) {
                  addName(ret, name_1, key_filter, key_conversion);
                }
              }
            }
            result >>>= 0;
            value = emnapiCtx.addToCurrentScope(ret).id;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(result, value, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_get_property_names(env, object, result) {
          return napi_get_all_property_names(env, object, 0, 2 | 16, 1, result);
        }
        function napi_set_property(env, object, key, value) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!key)
              return envObject.setLastError(1);
            if (!value)
              return envObject.setLastError(1);
            if (!object)
              return envObject.setLastError(1);
            var h = emnapiCtx.handleStore.get(object);
            if (!(h.isObject() || h.isFunction())) {
              return envObject.setLastError(2);
            }
            h.value[emnapiCtx.handleStore.get(key).value] = emnapiCtx.handleStore.get(value).value;
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_has_property(env, object, key, result) {
          var r;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!key)
              return envObject.setLastError(1);
            if (!result)
              return envObject.setLastError(1);
            if (!object)
              return envObject.setLastError(1);
            var h = emnapiCtx.handleStore.get(object);
            if (h.value == null) {
              throw new TypeError("Cannot convert undefined or null to object");
            }
            var v = void 0;
            try {
              v = h.isObject() || h.isFunction() ? h.value : Object(h.value);
            } catch (_) {
              return envObject.setLastError(2);
            }
            result >>>= 0;
            r = emnapiCtx.handleStore.get(key).value in v ? 1 : 0;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setInt8(result, r, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_get_property(env, object, key, result) {
          var value;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!key)
              return envObject.setLastError(1);
            if (!result)
              return envObject.setLastError(1);
            if (!object)
              return envObject.setLastError(1);
            var h = emnapiCtx.handleStore.get(object);
            if (h.value == null) {
              throw new TypeError("Cannot convert undefined or null to object");
            }
            var v = void 0;
            try {
              v = h.isObject() || h.isFunction() ? h.value : Object(h.value);
            } catch (_) {
              return envObject.setLastError(2);
            }
            result >>>= 0;
            value = envObject.ensureHandleId(v[emnapiCtx.handleStore.get(key).value]);
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(result, value, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_delete_property(env, object, key, result) {
          var r;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!key)
              return envObject.setLastError(1);
            if (!object)
              return envObject.setLastError(1);
            var h = emnapiCtx.handleStore.get(object);
            if (!(h.isObject() || h.isFunction())) {
              return envObject.setLastError(2);
            }
            var propertyKey = emnapiCtx.handleStore.get(key).value;
            if (emnapiCtx.feature.supportReflect) {
              r = Reflect.deleteProperty(h.value, propertyKey);
            } else {
              try {
                r = delete h.value[propertyKey];
              } catch (_) {
                r = false;
              }
            }
            if (result) {
              result >>>= 0;
              var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
              HEAP_DATA_VIEW.setInt8(result, r ? 1 : 0, true);
            }
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_has_own_property(env, object, key, result) {
          var r;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!key)
              return envObject.setLastError(1);
            if (!result)
              return envObject.setLastError(1);
            if (!object)
              return envObject.setLastError(1);
            var h = emnapiCtx.handleStore.get(object);
            if (h.value == null) {
              throw new TypeError("Cannot convert undefined or null to object");
            }
            var v = void 0;
            try {
              v = h.isObject() || h.isFunction() ? h.value : Object(h.value);
            } catch (_) {
              return envObject.setLastError(2);
            }
            var prop = emnapiCtx.handleStore.get(key).value;
            if (typeof prop !== "string" && typeof prop !== "symbol") {
              return envObject.setLastError(4);
            }
            r = Object.prototype.hasOwnProperty.call(v, emnapiCtx.handleStore.get(key).value);
            result >>>= 0;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setInt8(result, r ? 1 : 0, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_set_named_property(env, object, cname, value) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!value)
              return envObject.setLastError(1);
            if (!object)
              return envObject.setLastError(1);
            var h = emnapiCtx.handleStore.get(object);
            if (!(h.isObject() || h.isFunction())) {
              return envObject.setLastError(2);
            }
            if (!cname) {
              return envObject.setLastError(1);
            }
            cname >>>= 0;
            emnapiCtx.handleStore.get(object).value[emnapiString.UTF8ToString(cname, -1)] = emnapiCtx.handleStore.get(value).value;
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_has_named_property(env, object, utf8name, result) {
          var r;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!result)
              return envObject.setLastError(1);
            if (!object)
              return envObject.setLastError(1);
            if (!utf8name) {
              return envObject.setLastError(1);
            }
            var h = emnapiCtx.handleStore.get(object);
            if (h.value == null) {
              throw new TypeError("Cannot convert undefined or null to object");
            }
            var v = void 0;
            try {
              v = h.isObject() || h.isFunction() ? h.value : Object(h.value);
            } catch (_) {
              return envObject.setLastError(2);
            }
            utf8name >>>= 0;
            result >>>= 0;
            r = emnapiString.UTF8ToString(utf8name, -1) in v;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setInt8(result, r ? 1 : 0, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_get_named_property(env, object, utf8name, result) {
          var value;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!result)
              return envObject.setLastError(1);
            if (!object)
              return envObject.setLastError(1);
            if (!utf8name) {
              return envObject.setLastError(1);
            }
            var h = emnapiCtx.handleStore.get(object);
            if (h.value == null) {
              throw new TypeError("Cannot convert undefined or null to object");
            }
            var v = void 0;
            try {
              v = h.isObject() || h.isFunction() ? h.value : Object(h.value);
            } catch (_) {
              return envObject.setLastError(2);
            }
            utf8name >>>= 0;
            result >>>= 0;
            value = envObject.ensureHandleId(v[emnapiString.UTF8ToString(utf8name, -1)]);
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(result, value, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_set_element(env, object, index, value) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!value)
              return envObject.setLastError(1);
            if (!object)
              return envObject.setLastError(1);
            var h = emnapiCtx.handleStore.get(object);
            if (!(h.isObject() || h.isFunction())) {
              return envObject.setLastError(2);
            }
            h.value[index >>> 0] = emnapiCtx.handleStore.get(value).value;
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_has_element(env, object, index, result) {
          var r;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!result)
              return envObject.setLastError(1);
            if (!object)
              return envObject.setLastError(1);
            var h = emnapiCtx.handleStore.get(object);
            if (h.value == null) {
              throw new TypeError("Cannot convert undefined or null to object");
            }
            var v = void 0;
            try {
              v = h.isObject() || h.isFunction() ? h.value : Object(h.value);
            } catch (_) {
              return envObject.setLastError(2);
            }
            result >>>= 0;
            r = index >>> 0 in v ? 1 : 0;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setInt8(result, r, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_get_element(env, object, index, result) {
          var value;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!result)
              return envObject.setLastError(1);
            if (!object)
              return envObject.setLastError(1);
            var h = emnapiCtx.handleStore.get(object);
            if (h.value == null) {
              throw new TypeError("Cannot convert undefined or null to object");
            }
            var v = void 0;
            try {
              v = h.isObject() || h.isFunction() ? h.value : Object(h.value);
            } catch (_) {
              return envObject.setLastError(2);
            }
            result >>>= 0;
            value = envObject.ensureHandleId(v[index >>> 0]);
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(result, value, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_delete_element(env, object, index, result) {
          var r;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!object)
              return envObject.setLastError(1);
            var h = emnapiCtx.handleStore.get(object);
            if (!(h.isObject() || h.isFunction())) {
              return envObject.setLastError(2);
            }
            if (emnapiCtx.feature.supportReflect) {
              r = Reflect.deleteProperty(h.value, index >>> 0);
            } else {
              try {
                r = delete h.value[index >>> 0];
              } catch (_) {
                r = false;
              }
            }
            if (result) {
              result >>>= 0;
              var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
              HEAP_DATA_VIEW.setInt8(result, r ? 1 : 0, true);
            }
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_define_properties(env, object, property_count, properties) {
          var propPtr, attributes;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            properties >>>= 0;
            property_count >>>= 0;
            property_count = property_count >>> 0;
            if (property_count > 0) {
              if (!properties)
                return envObject.setLastError(1);
            }
            if (!object)
              return envObject.setLastError(1);
            var h = emnapiCtx.handleStore.get(object);
            var maybeObject = h.value;
            if (!(h.isObject() || h.isFunction())) {
              return envObject.setLastError(2);
            }
            var propertyName = void 0;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            for (var i = 0; i < property_count; i++) {
              propPtr = properties + i * (4 * 8);
              var utf8Name = HEAP_DATA_VIEW.getUint32(propPtr, true);
              var name_2 = HEAP_DATA_VIEW.getUint32(propPtr + 4, true);
              var method = HEAP_DATA_VIEW.getUint32(propPtr + 8, true);
              var getter = HEAP_DATA_VIEW.getUint32(propPtr + 12, true);
              var setter = HEAP_DATA_VIEW.getUint32(propPtr + 16, true);
              var value = HEAP_DATA_VIEW.getUint32(propPtr + 20, true);
              attributes = HEAP_DATA_VIEW.getInt32(propPtr + 24, true);
              attributes >>>= 0;
              var data = HEAP_DATA_VIEW.getUint32(propPtr + 28, true);
              if (utf8Name) {
                propertyName = emnapiString.UTF8ToString(utf8Name, -1);
              } else {
                if (!name_2) {
                  return envObject.setLastError(4);
                }
                propertyName = emnapiCtx.handleStore.get(name_2).value;
                if (typeof propertyName !== "string" && typeof propertyName !== "symbol") {
                  return envObject.setLastError(4);
                }
              }
              emnapiDefineProperty(envObject, maybeObject, propertyName, method, getter, setter, value, attributes, data);
            }
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_object_freeze(env, object) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!object)
              return envObject.setLastError(1);
            var h = emnapiCtx.handleStore.get(object);
            var maybeObject = h.value;
            if (!(h.isObject() || h.isFunction())) {
              return envObject.setLastError(2);
            }
            Object.freeze(maybeObject);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_object_seal(env, object) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!object)
              return envObject.setLastError(1);
            var h = emnapiCtx.handleStore.get(object);
            var maybeObject = h.value;
            if (!(h.isObject() || h.isFunction())) {
              return envObject.setLastError(2);
            }
            Object.seal(maybeObject);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        var propertyMod = Object.freeze({
          __proto__: null,
          napi_define_properties,
          napi_delete_element,
          napi_delete_property,
          napi_get_all_property_names,
          napi_get_element,
          napi_get_named_property,
          napi_get_property,
          napi_get_property_names,
          napi_has_element,
          napi_has_named_property,
          napi_has_own_property,
          napi_has_property,
          napi_object_freeze,
          napi_object_seal,
          napi_set_element,
          napi_set_named_property,
          napi_set_property
        });
        function napi_run_script(env, script, result) {
          var status;
          var value;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!script)
              return envObject.setLastError(1);
            if (!result)
              return envObject.setLastError(1);
            var v8Script = emnapiCtx.handleStore.get(script);
            if (!v8Script.isString()) {
              return envObject.setLastError(3);
            }
            var g = emnapiCtx.handleStore.get(5).value;
            var ret = g.eval(v8Script.value);
            result >>>= 0;
            value = envObject.ensureHandleId(ret);
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(result, value, true);
            status = envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
          return status;
        }
        var scriptMod = Object.freeze({
          __proto__: null,
          napi_run_script
        });
        function napi_typeof(env, value, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!value)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          var v = emnapiCtx.handleStore.get(value);
          result >>>= 0;
          var r;
          if (v.isNumber()) {
            r = 3;
          } else if (v.isBigInt()) {
            r = 9;
          } else if (v.isString()) {
            r = 4;
          } else if (v.isFunction()) {
            r = 7;
          } else if (v.isExternal()) {
            r = 8;
          } else if (v.isObject()) {
            r = 6;
          } else if (v.isBoolean()) {
            r = 2;
          } else if (v.isUndefined()) {
            r = 0;
          } else if (v.isSymbol()) {
            r = 5;
          } else if (v.isNull()) {
            r = 1;
          } else {
            return envObject.setLastError(1);
          }
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setInt32(result, r, true);
          return envObject.clearLastError();
        }
        function napi_coerce_to_bool(env, value, result) {
          var v;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!value)
              return envObject.setLastError(1);
            if (!result)
              return envObject.setLastError(1);
            var handle = emnapiCtx.handleStore.get(value);
            result >>>= 0;
            v = handle.value ? 4 : 3;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(result, v, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_coerce_to_number(env, value, result) {
          var v;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!value)
              return envObject.setLastError(1);
            if (!result)
              return envObject.setLastError(1);
            var handle = emnapiCtx.handleStore.get(value);
            if (handle.isBigInt()) {
              throw new TypeError("Cannot convert a BigInt value to a number");
            }
            result >>>= 0;
            v = emnapiCtx.addToCurrentScope(Number(handle.value)).id;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(result, v, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_coerce_to_object(env, value, result) {
          var v;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!value)
              return envObject.setLastError(1);
            if (!result)
              return envObject.setLastError(1);
            var handle = emnapiCtx.handleStore.get(value);
            if (handle.value == null) {
              throw new TypeError("Cannot convert undefined or null to object");
            }
            result >>>= 0;
            v = envObject.ensureHandleId(Object(handle.value));
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(result, v, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_coerce_to_string(env, value, result) {
          var v;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!value)
              return envObject.setLastError(1);
            if (!result)
              return envObject.setLastError(1);
            var handle = emnapiCtx.handleStore.get(value);
            if (handle.isSymbol()) {
              throw new TypeError("Cannot convert a Symbol value to a string");
            }
            result >>>= 0;
            v = emnapiCtx.addToCurrentScope(String(handle.value)).id;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setUint32(result, v, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_instanceof(env, object, constructor, result) {
          var r;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!object)
              return envObject.setLastError(1);
            if (!result)
              return envObject.setLastError(1);
            if (!constructor)
              return envObject.setLastError(1);
            result >>>= 0;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setInt8(result, 0, true);
            var ctor = emnapiCtx.handleStore.get(constructor);
            if (!ctor.isFunction()) {
              return envObject.setLastError(5);
            }
            var val = emnapiCtx.handleStore.get(object).value;
            var ret = val instanceof ctor.value;
            r = ret ? 1 : 0;
            HEAP_DATA_VIEW.setInt8(result, r, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_is_array(env, value, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!value)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          var h = emnapiCtx.handleStore.get(value);
          result >>>= 0;
          var r = h.isArray() ? 1 : 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setInt8(result, r, true);
          return envObject.clearLastError();
        }
        function napi_is_arraybuffer(env, value, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!value)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          var h = emnapiCtx.handleStore.get(value);
          result >>>= 0;
          var r = h.isArrayBuffer() ? 1 : 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setInt8(result, r, true);
          return envObject.clearLastError();
        }
        function node_api_is_sharedarraybuffer(env, value, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!value)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          var h = emnapiCtx.handleStore.get(value);
          result >>>= 0;
          var r = typeof SharedArrayBuffer === "function" && h.value instanceof SharedArrayBuffer || Object.prototype.toString.call(h.value) === "[object SharedArrayBuffer]" ? 1 : 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setInt8(result, r, true);
          return envObject.clearLastError();
        }
        function napi_is_date(env, value, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!value)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          var h = emnapiCtx.handleStore.get(value);
          result >>>= 0;
          var r = h.isDate() ? 1 : 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setInt8(result, r, true);
          return envObject.clearLastError();
        }
        function napi_is_error(env, value, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!value)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          var val = emnapiCtx.handleStore.get(value).value;
          result >>>= 0;
          var r = val instanceof Error ? 1 : 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setInt8(result, r, true);
          return envObject.clearLastError();
        }
        function napi_is_typedarray(env, value, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!value)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          var h = emnapiCtx.handleStore.get(value);
          result >>>= 0;
          var r = h.isTypedArray() ? 1 : 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setInt8(result, r, true);
          return envObject.clearLastError();
        }
        function napi_is_buffer(env, value, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!value)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          var h = emnapiCtx.handleStore.get(value);
          result >>>= 0;
          var r = h.isBuffer(emnapiCtx.feature.Buffer) ? 1 : 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setInt8(result, r, true);
          return envObject.clearLastError();
        }
        function napi_is_dataview(env, value, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!value)
            return envObject.setLastError(1);
          if (!result)
            return envObject.setLastError(1);
          var h = emnapiCtx.handleStore.get(value);
          result >>>= 0;
          var r = h.isDataView() ? 1 : 0;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setInt8(result, r, true);
          return envObject.clearLastError();
        }
        function napi_strict_equals(env, lhs, rhs, result) {
          var r;
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!lhs)
              return envObject.setLastError(1);
            if (!rhs)
              return envObject.setLastError(1);
            if (!result)
              return envObject.setLastError(1);
            var lv = emnapiCtx.handleStore.get(lhs).value;
            var rv = emnapiCtx.handleStore.get(rhs).value;
            result >>>= 0;
            r = lv === rv ? 1 : 0;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            HEAP_DATA_VIEW.setInt8(result, r, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        function napi_detach_arraybuffer(env, arraybuffer) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!arraybuffer)
            return envObject.setLastError(1);
          var value = emnapiCtx.handleStore.get(arraybuffer).value;
          if (!(value instanceof ArrayBuffer)) {
            if (typeof SharedArrayBuffer === "function" && value instanceof SharedArrayBuffer) {
              return envObject.setLastError(20);
            }
            return envObject.setLastError(19);
          }
          try {
            var MessageChannel_1 = emnapiCtx.feature.MessageChannel;
            var messageChannel = new MessageChannel_1();
            messageChannel.port1.postMessage(value, [value]);
          } catch (_) {
            return envObject.setLastError(9);
          }
          return envObject.clearLastError();
        }
        function napi_is_detached_arraybuffer(env, arraybuffer, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          envObject.checkGCAccess();
          if (!envObject.tryCatch.isEmpty())
            return envObject.setLastError(10);
          if (!envObject.canCallIntoJs())
            return envObject.setLastError(envObject.moduleApiVersion >= 10 ? 23 : 10);
          envObject.clearLastError();
          try {
            if (!arraybuffer)
              return envObject.setLastError(1);
            if (!result)
              return envObject.setLastError(1);
            var h = emnapiCtx.handleStore.get(arraybuffer);
            result >>>= 0;
            var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
            if (h.isArrayBuffer() && h.value.byteLength === 0) {
              try {
                new Uint8Array(h.value);
              } catch (_) {
                HEAP_DATA_VIEW.setInt8(result, 1, true);
                return envObject.getReturnStatus();
              }
            }
            HEAP_DATA_VIEW.setInt8(result, 0, true);
            return envObject.getReturnStatus();
          } catch (err2) {
            envObject.tryCatch.setError(err2);
            return envObject.setLastError(10);
          }
        }
        var valueOperationMod = Object.freeze({
          __proto__: null,
          napi_coerce_to_bool,
          napi_coerce_to_number,
          napi_coerce_to_object,
          napi_coerce_to_string,
          napi_detach_arraybuffer,
          napi_instanceof,
          napi_is_array,
          napi_is_arraybuffer,
          napi_is_buffer,
          napi_is_dataview,
          napi_is_date,
          napi_is_detached_arraybuffer,
          napi_is_error,
          napi_is_typedarray,
          napi_strict_equals,
          napi_typeof,
          node_api_is_sharedarraybuffer
        });
        function napi_get_version(env, result) {
          if (!env)
            return 1;
          var envObject = emnapiCtx.envStore.get(env);
          if (!result)
            return envObject.setLastError(1);
          var NODE_API_SUPPORTED_VERSION_MAX = 10;
          var HEAP_DATA_VIEW = new DataView(wasmMemory.buffer);
          HEAP_DATA_VIEW.setUint32(result, NODE_API_SUPPORTED_VERSION_MAX, true);
          return envObject.clearLastError();
        }
        var versionMod = Object.freeze({
          __proto__: null,
          napi_get_version
        });
        emnapiAWST.init();
        emnapiExternalMemory.init();
        emnapiExternalSAB.init();
        emnapiString.init();
        emnapiTSFN.init();
        PThread.init();
        napiModule2.emnapi.syncMemory = $emnapiSyncMemory;
        napiModule2.emnapi.getMemoryAddress = $emnapiGetMemoryAddress;
        napiModule2.emnapi.acquireExternalSharedArrayBuffer = $emnapiAcquireExternalSharedArrayBuffer;
        function addImports(mod) {
          var keys = Object.keys(mod);
          for (var i = 0; i < keys.length; ++i) {
            var k = keys[i];
            if (k.indexOf("$") === 0)
              continue;
            if (k.indexOf("emnapi_") === 0) {
              napiModule2.imports.emnapi[k] = mod[k];
            } else if (k.indexOf("_emnapi_") === 0 || k === "napi_set_last_error" || k === "napi_clear_last_error") {
              napiModule2.imports.env[k] = mod[k];
            } else {
              napiModule2.imports.napi[k] = mod[k];
            }
          }
        }
        addImports(asyncMod);
        addImports(memoryMod);
        addImports(asyncWorkMod);
        addImports(utilMod);
        addImports(convert2cMod);
        addImports(convert2napiMod);
        addImports(createMod);
        addImports(globalMod);
        addImports(wrapMod);
        addImports(envMod);
        addImports(emnapiMod);
        addImports(errorMod);
        addImports(functionMod);
        addImports(lifeMod);
        addImports(miscellaneousMod);
        addImports(nodeMod);
        addImports(promiseMod);
        addImports(propertyMod);
        addImports(scriptMod);
        addImports(valueOperationMod);
        addImports(versionMod);
        napiModule2.imports.napi.napi_create_threadsafe_function = napi_create_threadsafe_function;
        napiModule2.imports.napi.napi_get_threadsafe_function_context = napi_get_threadsafe_function_context;
        napiModule2.imports.napi.napi_call_threadsafe_function = napi_call_threadsafe_function;
        napiModule2.imports.napi.napi_acquire_threadsafe_function = napi_acquire_threadsafe_function;
        napiModule2.imports.napi.napi_release_threadsafe_function = napi_release_threadsafe_function;
        napiModule2.imports.napi.napi_unref_threadsafe_function = napi_unref_threadsafe_function;
        napiModule2.imports.napi.napi_ref_threadsafe_function = napi_ref_threadsafe_function;
        return napiModule2;
      }();
      return napiModule;
    }
    function loadNapiModuleImpl(loadFn, userNapiModule, wasmInput, options) {
      options = options !== null && options !== void 0 ? options : {};
      const getMemory = options.getMemory;
      const getTable = options.getTable;
      const beforeInit = options.beforeInit;
      if (getMemory != null && typeof getMemory !== "function") {
        throw new TypeError("options.getMemory is not a function");
      }
      if (getTable != null && typeof getTable !== "function") {
        throw new TypeError("options.getTable is not a function");
      }
      if (beforeInit != null && typeof beforeInit !== "function") {
        throw new TypeError("options.beforeInit is not a function");
      }
      let napiModule;
      const isLoad = typeof userNapiModule === "object" && userNapiModule !== null;
      if (isLoad) {
        if (userNapiModule.loaded) {
          throw new Error("napiModule has already loaded");
        }
        napiModule = userNapiModule;
      } else {
        napiModule = createNapiModule(options);
      }
      const wasi = options.wasi;
      let wasiThreads$1;
      let importObject = {
        env: napiModule.imports.env,
        napi: napiModule.imports.napi,
        emnapi: napiModule.imports.emnapi
      };
      if (wasi) {
        wasiThreads$1 = new wasiThreads.WASIThreads(napiModule.childThread ? {
          wasi,
          childThread: true,
          postMessage: napiModule.postMessage
        } : {
          wasi,
          threadManager: napiModule.PThread,
          waitThreadStart: napiModule.waitThreadStart
        });
        Object.assign(importObject, typeof wasi.getImportObject === "function" ? wasi.getImportObject() : { wasi_snapshot_preview1: wasi.wasiImport });
        Object.assign(importObject, wasiThreads$1.getImportObject());
      }
      const overwriteImports = options.overwriteImports;
      if (typeof overwriteImports === "function") {
        const newImportObject = overwriteImports(importObject);
        if (typeof newImportObject === "object" && newImportObject !== null) {
          importObject = newImportObject;
        }
      }
      return loadFn(wasmInput, importObject, (err, source) => {
        if (err) {
          throw err;
        }
        const originalInstance = source.instance;
        let instance = originalInstance;
        const originalExports = originalInstance.exports;
        const exportMemory = "memory" in originalExports;
        const importMemory = "memory" in importObject.env;
        const memory = getMemory ? getMemory(originalExports) : exportMemory ? originalExports.memory : importMemory ? importObject.env.memory : void 0;
        if (!memory) {
          throw new Error("memory is neither exported nor imported");
        }
        const table = getTable ? getTable(originalExports) : originalExports.__indirect_function_table;
        if (wasi && !exportMemory) {
          const exports3 = /* @__PURE__ */ Object.create(null);
          Object.assign(exports3, originalExports, { memory });
          instance = { exports: exports3 };
        }
        const module3 = source.module;
        if (wasi) {
          instance = wasiThreads$1.initialize(instance, module3, memory);
        } else {
          napiModule.PThread.setup(module3, memory);
        }
        const emnapiInit = () => {
          if (beforeInit) {
            beforeInit({
              instance: originalInstance,
              module: module3
            });
          }
          napiModule.init({
            instance,
            module: module3,
            memory,
            table
          });
          const ret = {
            instance: originalInstance,
            module: module3,
            usedInstance: instance
          };
          if (!isLoad) {
            ret.napiModule = napiModule;
          }
          return ret;
        };
        if (napiModule.PThread.shouldPreloadWorkers()) {
          const poolReady = napiModule.PThread.loadWasmModuleToAllWorkers();
          if (loadFn === loadCallback) {
            return poolReady.then(emnapiInit);
          } else {
            throw new Error("Synchronous loading is not supported with worker pool (reuseWorker.size > 0)");
          }
        }
        return emnapiInit();
      });
    }
    function loadCallback(wasmInput, importObject, callback) {
      return load(wasmInput, importObject).then((source) => {
        return callback(null, source);
      }, (err) => {
        return callback(err);
      });
    }
    function loadSyncCallback(wasmInput, importObject, callback) {
      let source;
      try {
        source = loadSync(wasmInput, importObject);
      } catch (err) {
        return callback(err);
      }
      return callback(null, source);
    }
    function loadNapiModule(napiModule, wasmInput, options) {
      if (typeof napiModule !== "object" || napiModule === null) {
        throw new TypeError("Invalid napiModule");
      }
      return loadNapiModuleImpl(loadCallback, napiModule, wasmInput, options);
    }
    function loadNapiModuleSync(napiModule, wasmInput, options) {
      if (typeof napiModule !== "object" || napiModule === null) {
        throw new TypeError("Invalid napiModule");
      }
      return loadNapiModuleImpl(loadSyncCallback, napiModule, wasmInput, options);
    }
    function instantiateNapiModule2(wasmInput, options) {
      return loadNapiModuleImpl(loadCallback, void 0, wasmInput, options);
    }
    function instantiateNapiModuleSync2(wasmInput, options) {
      return loadNapiModuleImpl(loadSyncCallback, void 0, wasmInput, options);
    }
    var MessageHandler2 = class extends wasiThreads.ThreadMessageHandler {
      constructor(options) {
        if (typeof options.onLoad !== "function") {
          throw new TypeError("options.onLoad is not a function");
        }
        const userOnError = options.onError;
        super({
          ...options,
          onError: (err, type) => {
            var _a;
            const emnapi_thread_crashed = (_a = this.instance) === null || _a === void 0 ? void 0 : _a.exports.emnapi_thread_crashed;
            if (typeof emnapi_thread_crashed === "function") {
              emnapi_thread_crashed();
            }
            if (typeof userOnError === "function") {
              userOnError(err, type);
            } else {
              throw err;
            }
          }
        });
        this.napiModule = void 0;
      }
      instantiate(data) {
        const source = this.onLoad(data);
        const then = source.then;
        if (typeof then === "function") {
          return source.then((result) => {
            this.napiModule = result.napiModule;
            return result;
          });
        }
        this.napiModule = source.napiModule;
        return source;
      }
      handle(e) {
        var _a;
        super.handle(e);
        if ((_a = e === null || e === void 0 ? void 0 : e.data) === null || _a === void 0 ? void 0 : _a.__emnapi__) {
          const type = e.data.__emnapi__.type;
          const payload = e.data.__emnapi__.payload;
          try {
            if (type === "async-worker-init") {
              this.handleAfterLoad(e, () => {
                this.napiModule.initWorker(payload.arg, payload.func);
              });
            }
          } catch (err) {
            this.onError(err, type);
          }
        }
      }
    };
    var version = "1.11.2";
    exports2.MessageHandler = MessageHandler2;
    exports2.createNapiModule = createNapiModule;
    exports2.instantiateNapiModule = instantiateNapiModule2;
    exports2.instantiateNapiModuleSync = instantiateNapiModuleSync2;
    exports2.loadNapiModule = loadNapiModule;
    exports2.loadNapiModuleSync = loadNapiModuleSync;
    exports2.version = version;
    Object.keys(wasiThreads).forEach(function(k) {
      if (k !== "default" && !Object.prototype.hasOwnProperty.call(exports2, k)) Object.defineProperty(exports2, k, {
        enumerable: true,
        get: function() {
          return wasiThreads[k];
        }
      });
    });
  }
});

// node_modules/@emnapi/core/index.js
var require_core = __commonJS({
  "node_modules/@emnapi/core/index.js"(exports2, module2) {
    if (typeof process !== "undefined" && process.env.NODE_ENV === "production") {
      module2.exports = require_emnapi_core_cjs_min();
    } else {
      module2.exports = require_emnapi_core_cjs();
    }
  }
});

// node_modules/@emnapi/runtime/dist/emnapi.cjs.min.js
var require_emnapi_cjs_min = __commonJS({
  "node_modules/@emnapi/runtime/dist/emnapi.cjs.min.js"(exports2) {
    var e = /* @__PURE__ */ new WeakMap();
    function t(t2) {
      return e.has(t2);
    }
    var i = (() => {
      function t2(t3) {
        Object.setPrototypeOf(this, null), e.set(this, t3);
      }
      return t2.prototype = null, t2;
    })();
    function s(i2) {
      if (!t(i2)) throw new TypeError("not external");
      return e.get(i2);
    }
    var n = function() {
      let e2;
      try {
        e2 = new Function();
      } catch (e3) {
        return false;
      }
      return "function" == typeof e2;
    }();
    var r = function() {
      if ("undefined" != typeof globalThis) return globalThis;
      let e2 = /* @__PURE__ */ function() {
        return this;
      }();
      if (!e2 && n) try {
        e2 = new Function("return this")();
      } catch (e3) {
      }
      if (!e2) {
        if ("undefined" == typeof __webpack_public_path__ && "undefined" != typeof global) return global;
        if ("undefined" != typeof window) return window;
        if ("undefined" != typeof self) return self;
      }
      return e2;
    }();
    var o = class {
      constructor() {
        this._exception = void 0, this._caught = false;
      }
      isEmpty() {
        return !this._caught;
      }
      hasCaught() {
        return this._caught;
      }
      exception() {
        return this._exception;
      }
      setError(e2) {
        this._caught = true, this._exception = e2;
      }
      reset() {
        this._caught = false, this._exception = void 0;
      }
      extractException() {
        const e2 = this._exception;
        return this.reset(), e2;
      }
    };
    var a = function() {
      var e2;
      try {
        return Boolean(null === (e2 = Object.getOwnPropertyDescriptor(Function.prototype, "name")) || void 0 === e2 ? void 0 : e2.configurable);
      } catch (e3) {
        return false;
      }
    }();
    var l = "object" == typeof Reflect;
    var c = "undefined" != typeof FinalizationRegistry && "undefined" != typeof WeakRef;
    var h = function() {
      try {
        const e2 = Symbol();
        new WeakRef(e2), (/* @__PURE__ */ new WeakMap()).set(e2, void 0);
      } catch (e2) {
        return false;
      }
      return true;
    }();
    var u = "undefined" != typeof BigInt;
    var p = function() {
      let e2;
      return e2 = "undefined" != typeof __webpack_public_path__ || "undefined" != typeof __webpack_public_path__ ? "undefined" != typeof __non_webpack_require__ ? __non_webpack_require__ : void 0 : "undefined" != typeof require ? require : void 0, e2;
    }();
    var f = "function" == typeof MessageChannel ? MessageChannel : function() {
      try {
        return p("worker_threads").MessageChannel;
      } catch (e2) {
      }
    }();
    var d = "function" == typeof setImmediate ? setImmediate.bind(r) : function(e2) {
      if ("function" != typeof e2) throw new TypeError('The "callback" argument must be of type function');
      if (f) {
        let t2 = new f();
        t2.port1.onmessage = function() {
          t2.port1.onmessage = null, t2 = void 0, e2();
        }, t2.port2.postMessage(null);
      } else setTimeout(e2, 0);
    };
    var _ = "function" == typeof Buffer ? Buffer : function() {
      try {
        return p("buffer").Buffer;
      } catch (e2) {
      }
    }();
    var v = "1.11.2";
    var g = 2147483647;
    var y = class {
      constructor(e2, t2) {
        this.id = e2, this.value = t2;
      }
      data() {
        return s(this.value);
      }
      isNumber() {
        return "number" == typeof this.value;
      }
      isBigInt() {
        return "bigint" == typeof this.value;
      }
      isString() {
        return "string" == typeof this.value;
      }
      isFunction() {
        return "function" == typeof this.value;
      }
      isExternal() {
        return t(this.value);
      }
      isObject() {
        return "object" == typeof this.value && null !== this.value;
      }
      isArray() {
        return Array.isArray(this.value);
      }
      isArrayBuffer() {
        return this.value instanceof ArrayBuffer;
      }
      isTypedArray() {
        return ArrayBuffer.isView(this.value) && !(this.value instanceof DataView);
      }
      isBuffer(e2) {
        return !!ArrayBuffer.isView(this.value) || (null != e2 || (e2 = _), "function" == typeof e2 && e2.isBuffer(this.value));
      }
      isDataView() {
        return this.value instanceof DataView;
      }
      isDate() {
        return this.value instanceof Date;
      }
      isPromise() {
        return this.value instanceof Promise;
      }
      isBoolean() {
        return "boolean" == typeof this.value;
      }
      isUndefined() {
        return void 0 === this.value;
      }
      isSymbol() {
        return "symbol" == typeof this.value;
      }
      isNull() {
        return null === this.value;
      }
      dispose() {
        this.value = void 0;
      }
    };
    var x = class extends y {
      constructor(e2, t2) {
        super(e2, t2);
      }
      dispose() {
      }
    };
    var z = class _z {
      constructor() {
        this._values = [void 0, _z.UNDEFINED, _z.NULL, _z.FALSE, _z.TRUE, _z.GLOBAL], this._next = _z.MIN_ID;
      }
      push(e2) {
        let t2;
        const i2 = this._next, s2 = this._values;
        return i2 < s2.length ? (t2 = s2[i2], t2.value = e2) : (t2 = new y(i2, e2), s2[i2] = t2), this._next++, t2;
      }
      erase(e2, t2) {
        this._next = e2;
        const i2 = this._values;
        for (let s2 = e2; s2 < t2; ++s2) i2[s2].dispose();
      }
      get(e2) {
        return this._values[e2];
      }
      swap(e2, t2) {
        const i2 = this._values, s2 = i2[e2];
        i2[e2] = i2[t2], i2[e2].id = Number(e2), i2[t2] = s2, s2.id = Number(t2);
      }
      dispose() {
        this._values.length = _z.MIN_ID, this._next = _z.MIN_ID;
      }
    };
    z.UNDEFINED = new x(1, void 0), z.NULL = new x(2, null), z.FALSE = new x(3, false), z.TRUE = new x(4, true), z.GLOBAL = new x(5, r), z.MIN_ID = 6;
    var b = class {
      constructor(e2, t2, i2, s2, n2 = s2) {
        this.handleStore = e2, this.id = t2, this.parent = i2, this.child = null, null !== i2 && (i2.child = this), this.start = s2, this.end = n2, this._escapeCalled = false, this.callbackInfo = { thiz: void 0, data: 0, args: void 0, fn: void 0 };
      }
      add(e2) {
        const t2 = this.handleStore.push(e2);
        return this.end++, t2;
      }
      addExternal(e2) {
        return this.add(new i(e2));
      }
      dispose() {
        this._escapeCalled && (this._escapeCalled = false), this.start !== this.end && this.handleStore.erase(this.start, this.end);
      }
      escape(e2) {
        if (this._escapeCalled) return null;
        if (this._escapeCalled = true, e2 < this.start || e2 >= this.end) return null;
        this.handleStore.swap(e2, this.start);
        const t2 = this.handleStore.get(this.start);
        return this.start++, this.parent.end++, t2;
      }
      escapeCalled() {
        return this._escapeCalled;
      }
    };
    var k = class {
      constructor() {
        this._rootScope = new b(null, 0, null, 1, z.MIN_ID), this.currentScope = this._rootScope, this._values = [void 0];
      }
      get(e2) {
        return this._values[e2];
      }
      openScope(e2) {
        const t2 = this.currentScope;
        let i2 = t2.child;
        if (null !== i2) i2.start = i2.end = t2.end;
        else {
          const s2 = t2.id + 1;
          i2 = new b(e2, s2, t2, t2.end), this._values[s2] = i2;
        }
        return this.currentScope = i2, i2;
      }
      closeScope() {
        const e2 = this.currentScope;
        this.currentScope = e2.parent, e2.dispose();
      }
      dispose() {
        this.currentScope = this._rootScope, this._values.length = 1;
      }
    };
    var w = class {
      constructor() {
        this._next = null, this._prev = null;
      }
      dispose() {
      }
      finalize() {
      }
      link(e2) {
        this._prev = e2, this._next = e2._next, null !== this._next && (this._next._prev = this), e2._next = this;
      }
      unlink() {
        null !== this._prev && (this._prev._next = this._next), null !== this._next && (this._next._prev = this._prev), this._prev = null, this._next = null;
      }
      static finalizeAll(e2) {
        for (; null !== e2._next; ) e2._next.finalize();
      }
    };
    var m = class {
      constructor(e2, t2 = 0, i2 = 0, s2 = 0) {
        this.envObject = e2, this._finalizeCallback = t2, this._finalizeData = i2, this._finalizeHint = s2, this._makeDynCall_vppp = e2.makeDynCall_vppp;
      }
      callback() {
        return this._finalizeCallback;
      }
      data() {
        return this._finalizeData;
      }
      hint() {
        return this._finalizeHint;
      }
      resetEnv() {
        this.envObject = void 0;
      }
      resetFinalizer() {
        this._finalizeCallback = 0, this._finalizeData = 0, this._finalizeHint = 0;
      }
      callFinalizer() {
        const e2 = this._finalizeCallback, t2 = this._finalizeData, i2 = this._finalizeHint;
        if (this.resetFinalizer(), !e2) return;
        const s2 = Number(e2);
        this.envObject ? this.envObject.callFinalizer(s2, t2, i2) : this._makeDynCall_vppp(s2)(0, t2, i2);
      }
      dispose() {
        this.envObject = void 0, this._makeDynCall_vppp = void 0;
      }
    };
    var E = class _E extends w {
      static create(e2, t2, i2, s2) {
        const n2 = new _E(e2, t2, i2, s2);
        return n2.link(e2.finalizing_reflist), n2;
      }
      constructor(e2, t2, i2, s2) {
        super(), this._finalizer = new m(e2, t2, i2, s2);
      }
      data() {
        return this._finalizer.data();
      }
      dispose() {
        this._finalizer && (this.unlink(), this._finalizer.envObject.dequeueFinalizer(this), this._finalizer.dispose(), this._finalizer = void 0, super.dispose());
      }
      finalize() {
        let e2;
        this.unlink();
        let t2 = false;
        try {
          this._finalizer.callFinalizer();
        } catch (i2) {
          t2 = true, e2 = i2;
        }
        if (this.dispose(), t2) throw e2;
      }
    };
    function S(e2, t2) {
      if (!e2.terminatedOrTerminating()) throw t2;
    }
    var C = class {
      constructor(e2, t2, i2, s2, n2) {
        this.ctx = e2, this.moduleApiVersion = t2, this.makeDynCall_vppp = i2, this.makeDynCall_vp = s2, this.abort = n2, this.openHandleScopes = 0, this.instanceData = null, this.tryCatch = new o(), this.refs = 1, this.reflist = new w(), this.finalizing_reflist = new w(), this.pendingFinalizers = [], this.lastError = { errorCode: 0, engineErrorCode: 0, engineReserved: 0 }, this.inGcFinalizer = false, this._bindingMap = /* @__PURE__ */ new WeakMap(), this.id = 0;
      }
      canCallIntoJs() {
        return true;
      }
      terminatedOrTerminating() {
        return !this.canCallIntoJs();
      }
      ref() {
        this.refs++;
      }
      unref() {
        this.refs--, 0 === this.refs && this.dispose();
      }
      ensureHandle(e2) {
        return this.ctx.ensureHandle(e2);
      }
      ensureHandleId(e2) {
        return this.ensureHandle(e2).id;
      }
      clearLastError() {
        const e2 = this.lastError;
        return 0 !== e2.errorCode && (e2.errorCode = 0), 0 !== e2.engineErrorCode && (e2.engineErrorCode = 0), 0 !== e2.engineReserved && (e2.engineReserved = 0), 0;
      }
      setLastError(e2, t2 = 0, i2 = 0) {
        const s2 = this.lastError;
        return s2.errorCode !== e2 && (s2.errorCode = e2), s2.engineErrorCode !== t2 && (s2.engineErrorCode = t2), s2.engineReserved !== i2 && (s2.engineReserved = i2), e2;
      }
      getReturnStatus() {
        return this.tryCatch.hasCaught() ? this.setLastError(10) : 0;
      }
      callIntoModule(e2, t2 = S) {
        const i2 = this.openHandleScopes;
        this.clearLastError();
        const s2 = e2(this);
        if (i2 !== this.openHandleScopes && this.abort("open_handle_scopes != open_handle_scopes_before"), this.tryCatch.hasCaught()) {
          t2(this, this.tryCatch.extractException());
        }
        return s2;
      }
      invokeFinalizerFromGC(e2) {
        if (this.moduleApiVersion !== g) this.enqueueFinalizer(e2);
        else {
          const t2 = this.inGcFinalizer;
          this.inGcFinalizer = true;
          try {
            e2.finalize();
          } finally {
            this.inGcFinalizer = t2;
          }
        }
      }
      checkGCAccess() {
        this.moduleApiVersion === g && this.inGcFinalizer && this.abort("Finalizer is calling a function that may affect GC state.\nThe finalizers are run directly from GC and must not affect GC state.\nUse `node_api_post_finalizer` from inside of the finalizer to work around this issue.\nIt schedules the call as a new task in the event loop.");
      }
      enqueueFinalizer(e2) {
        -1 === this.pendingFinalizers.indexOf(e2) && this.pendingFinalizers.push(e2);
      }
      dequeueFinalizer(e2) {
        const t2 = this.pendingFinalizers.indexOf(e2);
        -1 !== t2 && this.pendingFinalizers.splice(t2, 1);
      }
      deleteMe() {
        w.finalizeAll(this.finalizing_reflist), w.finalizeAll(this.reflist), this.tryCatch.extractException(), this.ctx.envStore.remove(this.id);
      }
      dispose() {
        0 !== this.id && (this.deleteMe(), this.finalizing_reflist.dispose(), this.reflist.dispose(), this.id = 0);
      }
      initObjectBinding(e2) {
        const t2 = { wrapped: 0, tag: null };
        return this._bindingMap.set(e2, t2), t2;
      }
      getObjectBinding(e2) {
        return this._bindingMap.has(e2) ? this._bindingMap.get(e2) : this.initObjectBinding(e2);
      }
      setInstanceData(e2, t2, i2) {
        this.instanceData && this.instanceData.dispose(), this.instanceData = E.create(this, t2, e2, i2);
      }
      getInstanceData() {
        return this.instanceData ? this.instanceData.data() : 0;
      }
    };
    var F = class extends C {
      constructor(e2, t2, i2, s2, n2, r2, o2) {
        super(e2, i2, s2, n2, r2), this.filename = t2, this.nodeBinding = o2, this.destructing = false, this.finalizationScheduled = false;
      }
      deleteMe() {
        this.destructing = true, this.drainFinalizerQueue(), super.deleteMe();
      }
      canCallIntoJs() {
        return super.canCallIntoJs() && this.ctx.canCallIntoJs();
      }
      triggerFatalException(e2) {
        if (this.nodeBinding) this.nodeBinding.napi.fatalException(e2);
        else {
          if ("object" != typeof process || null === process || "function" != typeof process._fatalException) throw e2;
          process._fatalException(e2) || (console.error(e2), process.exit(1));
        }
      }
      callbackIntoModule(e2, t2) {
        return this.callIntoModule(t2, (t3, i2) => {
          if (t3.terminatedOrTerminating()) return;
          const s2 = "object" == typeof process && null !== process, n2 = !!s2 && Boolean(process.execArgv && -1 !== process.execArgv.indexOf("--force-node-api-uncaught-exceptions-policy"));
          if (t3.moduleApiVersion < 10 && !n2 && !e2) {
            return void (s2 && "function" == typeof process.emitWarning ? process.emitWarning : function(e3, t4, i3) {
              if (e3 instanceof Error) console.warn(e3.toString());
              else {
                const s3 = i3 ? `[${i3}] ` : "";
                console.warn(`${s3}${t4 || "Warning"}: ${e3}`);
              }
            })("Uncaught Node-API callback exception detected, please run node with option --force-node-api-uncaught-exceptions-policy=true to handle those exceptions properly.", "DeprecationWarning", "DEP0168");
          }
          t3.triggerFatalException(i2);
        });
      }
      callFinalizer(e2, t2, i2) {
        this.callFinalizerInternal(1, e2, t2, i2);
      }
      callFinalizerInternal(e2, t2, i2, s2) {
        const n2 = this.makeDynCall_vppp(t2), r2 = this.id, o2 = this.ctx.openScope(this);
        try {
          this.callbackIntoModule(Boolean(e2), () => {
            n2(r2, i2, s2);
          });
        } finally {
          this.ctx.closeScope(this, o2);
        }
      }
      enqueueFinalizer(e2) {
        super.enqueueFinalizer(e2), this.finalizationScheduled || this.destructing || (this.finalizationScheduled = true, this.ref(), d(() => {
          this.finalizationScheduled = false, this.unref(), this.drainFinalizerQueue();
        }));
      }
      drainFinalizerQueue() {
        for (; this.pendingFinalizers.length > 0; ) {
          this.pendingFinalizers.shift().finalize();
        }
      }
    };
    function I(e2, t2, i2, s2, n2, r2, o2) {
      (i2 = "number" != typeof i2 ? 8 : i2) < 8 ? i2 = 8 : i2 > 10 && i2 !== g && function(e3, t3) {
        throw new Error(`${e3} requires Node-API version ${t3}, but this version of Node.js only supports version 10 add-ons.`);
      }(t2, i2);
      const a2 = new F(e2, t2, i2, s2, n2, r2, o2);
      return e2.envStore.add(a2), e2.addCleanupHook(a2, () => {
        a2.unref();
      }, 0), a2;
    }
    var O = class _O extends Error {
      constructor(e2) {
        super(e2);
        const t2 = new.target, i2 = t2.prototype;
        if (!(this instanceof _O)) {
          const e3 = Object.setPrototypeOf;
          "function" == typeof e3 ? e3.call(Object, this, i2) : this.__proto__ = i2, "function" == typeof Error.captureStackTrace && Error.captureStackTrace(this, t2);
        }
      }
    };
    Object.defineProperty(O.prototype, "name", { configurable: true, writable: true, value: "EmnapiError" });
    var D = class extends O {
      constructor(e2, t2) {
        super(`${e2}: The current runtime does not support "FinalizationRegistry" and "WeakRef".${t2 ? ` ${t2}` : ""}`);
      }
    };
    Object.defineProperty(D.prototype, "name", { configurable: true, writable: true, value: "NotSupportWeakRefError" });
    var R = class extends O {
      constructor(e2, t2) {
        super(`${e2}: The current runtime does not support "Buffer". Consider using buffer polyfill to make sure \`globalThis.Buffer\` is defined.${t2 ? ` ${t2}` : ""}`);
      }
    };
    Object.defineProperty(R.prototype, "name", { configurable: true, writable: true, value: "NotSupportBufferError" });
    var N = class {
      constructor(e2) {
        this._value = e2;
      }
      deref() {
        return this._value;
      }
      dispose() {
        this._value = void 0;
      }
    };
    var A = class _A {
      constructor(e2) {
        this._ref = new N(e2);
      }
      setWeak(e2, t2) {
        if (!c || void 0 === this._ref || this._ref instanceof WeakRef) return;
        const i2 = this._ref.deref();
        try {
          _A._registry.register(i2, this, this);
          const s2 = new WeakRef(i2);
          this._ref.dispose(), this._ref = s2, this._param = e2, this._callback = t2;
        } catch (e3) {
          if ("symbol" != typeof i2) throw e3;
        }
      }
      clearWeak() {
        if (c && void 0 !== this._ref && this._ref instanceof WeakRef) {
          try {
            _A._registry.unregister(this);
          } catch (e3) {
          }
          this._param = void 0, this._callback = void 0;
          const e2 = this._ref.deref();
          this._ref = void 0 === e2 ? e2 : new N(e2);
        }
      }
      reset() {
        if (c) try {
          _A._registry.unregister(this);
        } catch (e2) {
        }
        this._param = void 0, this._callback = void 0, this._ref instanceof N && this._ref.dispose(), this._ref = void 0;
      }
      isEmpty() {
        return void 0 === this._ref;
      }
      deref() {
        if (void 0 !== this._ref) return this._ref.deref();
      }
    };
    var H;
    A._registry = c ? new FinalizationRegistry((e2) => {
      e2._ref = void 0;
      const t2 = e2._callback, i2 = e2._param;
      e2._callback = void 0, e2._param = void 0, "function" == typeof t2 && t2(i2);
    }) : void 0, exports2.ReferenceOwnership = void 0, (H = exports2.ReferenceOwnership || (exports2.ReferenceOwnership = {}))[H.kRuntime = 0] = "kRuntime", H[H.kUserland = 1] = "kUserland";
    var j = class _j extends w {
      static weakCallback(e2) {
        e2.persistent.reset(), e2.invokeFinalizerFromGC();
      }
      static create(e2, t2, i2, s2, n2, r2, o2) {
        const a2 = new _j(e2, t2, i2, s2);
        return e2.ctx.refStore.add(a2), a2.link(e2.reflist), a2;
      }
      constructor(e2, t2, i2, s2) {
        super(), this.envObject = e2, this._refcount = i2, this._ownership = s2;
        const n2 = e2.ctx.handleStore.get(t2);
        var r2;
        this.canBeWeak = (r2 = n2).isObject() || r2.isFunction() || r2.isSymbol(), this.persistent = new A(n2.value), this.id = 0, 0 === i2 && this._setWeak();
      }
      ref() {
        return this.persistent.isEmpty() ? 0 : (1 === ++this._refcount && this.canBeWeak && this.persistent.clearWeak(), this._refcount);
      }
      unref() {
        return this.persistent.isEmpty() || 0 === this._refcount ? 0 : (0 === --this._refcount && this._setWeak(), this._refcount);
      }
      get(e2 = this.envObject) {
        if (this.persistent.isEmpty()) return 0;
        const t2 = this.persistent.deref();
        return e2.ensureHandle(t2).id;
      }
      resetFinalizer() {
      }
      data() {
        return 0;
      }
      refcount() {
        return this._refcount;
      }
      ownership() {
        return this._ownership;
      }
      callUserFinalizer() {
      }
      invokeFinalizerFromGC() {
        this.finalize();
      }
      _setWeak() {
        this.canBeWeak ? this.persistent.setWeak(this, _j.weakCallback) : this.persistent.reset();
      }
      finalize() {
        this.persistent.reset();
        const e2 = this._ownership === exports2.ReferenceOwnership.kRuntime;
        this.unlink(), this.callUserFinalizer(), e2 && this.dispose();
      }
      dispose() {
        0 !== this.id && (this.unlink(), this.persistent.reset(), this.envObject.ctx.refStore.remove(this.id), super.dispose(), this.envObject = void 0, this.id = 0);
      }
    };
    var B = class _B extends j {
      static create(e2, t2, i2, s2, n2) {
        const r2 = new _B(e2, t2, i2, s2, n2);
        return e2.ctx.refStore.add(r2), r2.link(e2.reflist), r2;
      }
      constructor(e2, t2, i2, s2, n2) {
        super(e2, t2, i2, s2), this._data = n2;
      }
      data() {
        return this._data;
      }
    };
    var M = class _M extends j {
      static create(e2, t2, i2, s2, n2, r2, o2) {
        const a2 = new _M(e2, t2, i2, s2, n2, r2, o2);
        return e2.ctx.refStore.add(a2), a2.link(e2.finalizing_reflist), a2;
      }
      constructor(e2, t2, i2, s2, n2, r2, o2) {
        super(e2, t2, i2, s2), this._finalizer = new m(e2, n2, r2, o2);
      }
      resetFinalizer() {
        this._finalizer.resetFinalizer();
      }
      data() {
        return this._finalizer.data();
      }
      callUserFinalizer() {
        this._finalizer.callFinalizer();
      }
      invokeFinalizerFromGC() {
        this._finalizer.envObject.invokeFinalizerFromGC(this);
      }
      dispose() {
        this._finalizer && (this._finalizer.envObject.dequeueFinalizer(this), this._finalizer.dispose(), super.dispose(), this._finalizer = void 0);
      }
    };
    var T = class _T {
      static create(e2, t2) {
        const i2 = new _T(e2, t2);
        return e2.deferredStore.add(i2), i2;
      }
      constructor(e2, t2) {
        this.id = 0, this.ctx = e2, this.value = t2;
      }
      resolve(e2) {
        this.value.resolve(e2), this.dispose();
      }
      reject(e2) {
        this.value.reject(e2), this.dispose();
      }
      dispose() {
        this.ctx.deferredStore.remove(this.id), this.id = 0, this.value = null, this.ctx = null;
      }
    };
    var W = class {
      constructor() {
        this._values = [void 0], this._values.length = 4, this._size = 1, this._freeList = [];
      }
      add(e2) {
        let t2;
        if (this._freeList.length) t2 = this._freeList.shift();
        else {
          t2 = this._size, this._size++;
          const e3 = this._values.length;
          t2 >= e3 && (this._values.length = e3 + (e3 >> 1) + 16);
        }
        e2.id = t2, this._values[t2] = e2;
      }
      get(e2) {
        return this._values[e2];
      }
      has(e2) {
        return void 0 !== this._values[e2];
      }
      remove(e2) {
        const t2 = this._values[e2];
        t2 && (t2.id = 0, this._values[e2] = void 0, this._freeList.push(Number(e2)));
      }
      dispose() {
        for (let e2 = 1; e2 < this._size; ++e2) {
          const t2 = this._values[e2];
          null == t2 || t2.dispose();
        }
        this._values = [void 0], this._size = 1, this._freeList = [];
      }
    };
    var L = BigInt(1) << BigInt(60);
    var P = -L;
    var U = class {
      constructor(e2) {
        this.total = BigInt(0), this.onChange = null != e2 ? e2 : null;
      }
      adjust(e2) {
        if (e2 = BigInt(e2), !(P <= e2 && e2 < L)) throw new RangeError(`changeInBytes ${e2} is out of reasonable range`);
        const t2 = this.total;
        this.total += e2;
        const i2 = this.total, s2 = this.onChange;
        return e2 && (null == s2 || s2(i2, t2, e2)), i2;
      }
    };
    var V = class {
      constructor(e2, t2, i2, s2) {
        this.envObject = e2, this.fn = t2, this.arg = i2, this.order = s2;
      }
    };
    var G = class {
      constructor() {
        this._cleanupHooks = [], this._cleanupHookCounter = 0;
      }
      empty() {
        return 0 === this._cleanupHooks.length;
      }
      add(e2, t2, i2) {
        if (this._cleanupHooks.filter((s2) => s2.envObject === e2 && s2.fn === t2 && s2.arg === i2).length > 0) throw new Error("Can not add same fn and arg twice");
        this._cleanupHooks.push(new V(e2, t2, i2, this._cleanupHookCounter++));
      }
      remove(e2, t2, i2) {
        for (let s2 = 0; s2 < this._cleanupHooks.length; ++s2) {
          const n2 = this._cleanupHooks[s2];
          if (n2.envObject === e2 && n2.fn === t2 && n2.arg === i2) return void this._cleanupHooks.splice(s2, 1);
        }
      }
      drain() {
        const e2 = this._cleanupHooks.slice();
        e2.sort((e3, t2) => t2.order - e3.order);
        for (let t2 = 0; t2 < e2.length; ++t2) {
          const i2 = e2[t2];
          "number" == typeof i2.fn ? i2.envObject.makeDynCall_vp(i2.fn)(i2.arg) : i2.fn(i2.arg), this._cleanupHooks.splice(this._cleanupHooks.indexOf(i2), 1);
        }
      }
      dispose() {
        this._cleanupHooks.length = 0, this._cleanupHookCounter = 0;
      }
    };
    var q = class {
      constructor() {
        this.refHandle = new f().port1, this.count = 0;
      }
      increase() {
        0 === this.count && (this.refHandle.ref && this.refHandle.ref(), __oc_liveRetain()), this.count++;
      }
      decrease() {
        0 !== this.count && (1 === this.count && (this.refHandle.unref && this.refHandle.unref(), __oc_liveRelease()), this.count--);
      }
    };
    var $ = class {
      constructor(e2) {
        this._isStopping = false, this._canCallIntoJs = true, this._suppressDestroy = false, this.envStore = new W(), this.scopeStore = new k(), this.refStore = new W(), this.deferredStore = new W(), this.handleStore = new z(), this.feature = { supportReflect: l, supportFinalizer: c, supportWeakSymbol: h, supportBigInt: u, supportNewFunction: n, canSetFunctionName: a, setImmediate: d, Buffer: _, MessageChannel: f }, this.cleanupQueue = new G(), this._externalMemory = new U(null == e2 ? void 0 : e2.onExternalMemoryChange), "object" == typeof process && null !== process && "function" == typeof process.once && (this.refCounter = new q(), process.once("beforeExit", () => {
          this._suppressDestroy || this.destroy();
        }));
      }
      suppressDestroy() {
        this._suppressDestroy = true;
      }
      getRuntimeVersions() {
        return { version: v, NODE_API_SUPPORTED_VERSION_MAX: 10, NAPI_VERSION_EXPERIMENTAL: g, NODE_API_DEFAULT_MODULE_API_VERSION: 8 };
      }
      createNotSupportWeakRefError(e2, t2) {
        return new D(e2, t2);
      }
      createNotSupportBufferError(e2, t2) {
        return new R(e2, t2);
      }
      createReference(e2, t2, i2, s2) {
        return j.create(e2, t2, i2, s2);
      }
      createReferenceWithData(e2, t2, i2, s2, n2) {
        return B.create(e2, t2, i2, s2, n2);
      }
      createReferenceWithFinalizer(e2, t2, i2, s2, n2 = 0, r2 = 0, o2 = 0) {
        return M.create(e2, t2, i2, s2, n2, r2, o2);
      }
      createDeferred(e2) {
        return T.create(this, e2);
      }
      adjustAmountOfExternalAllocatedMemory(e2) {
        return this._externalMemory.adjust(e2);
      }
      createEnv(e2, t2, i2, s2, n2, r2) {
        return I(this, e2, t2, i2, s2, n2, r2);
      }
      createTrackedFinalizer(e2, t2, i2, s2) {
        return E.create(e2, t2, i2, s2);
      }
      getCurrentScope() {
        return this.scopeStore.currentScope;
      }
      addToCurrentScope(e2) {
        return this.scopeStore.currentScope.add(e2);
      }
      openScope(e2) {
        const t2 = this.scopeStore.openScope(this.handleStore);
        return e2 && e2.openHandleScopes++, t2;
      }
      closeScope(e2, t2) {
        e2 && 0 === e2.openHandleScopes || (this.scopeStore.closeScope(), e2 && e2.openHandleScopes--);
      }
      ensureHandle(e2) {
        switch (e2) {
          case void 0:
            return z.UNDEFINED;
          case null:
            return z.NULL;
          case true:
            return z.TRUE;
          case false:
            return z.FALSE;
          case r:
            return z.GLOBAL;
        }
        return this.addToCurrentScope(e2);
      }
      addCleanupHook(e2, t2, i2) {
        this.cleanupQueue.add(e2, t2, i2);
      }
      removeCleanupHook(e2, t2, i2) {
        this.cleanupQueue.remove(e2, t2, i2);
      }
      runCleanup() {
        for (; !this.cleanupQueue.empty(); ) this.cleanupQueue.drain();
      }
      increaseWaitingRequestCounter() {
        var e2;
        null === (e2 = this.refCounter) || void 0 === e2 || e2.increase();
      }
      decreaseWaitingRequestCounter() {
        var e2;
        null === (e2 = this.refCounter) || void 0 === e2 || e2.decrease();
      }
      setCanCallIntoJs(e2) {
        this._canCallIntoJs = e2;
      }
      setStopping(e2) {
        this._isStopping = e2;
      }
      canCallIntoJs() {
        return this._canCallIntoJs && !this._isStopping;
      }
      destroy() {
        this.setStopping(true), this.setCanCallIntoJs(false), this.runCleanup();
      }
    };
    var J;
    function Q(e2) {
      return new $(e2);
    }
    exports2.ConstHandle = x, exports2.Context = $, exports2.Deferred = T, exports2.EmnapiError = O, exports2.Env = C, exports2.External = i, exports2.Finalizer = m, exports2.Handle = y, exports2.HandleScope = b, exports2.HandleStore = z, exports2.NAPI_VERSION_EXPERIMENTAL = g, exports2.NODE_API_DEFAULT_MODULE_API_VERSION = 8, exports2.NODE_API_SUPPORTED_VERSION_MAX = 10, exports2.NODE_API_SUPPORTED_VERSION_MIN = 1, exports2.NodeEnv = F, exports2.NotSupportBufferError = R, exports2.NotSupportWeakRefError = D, exports2.Persistent = A, exports2.RefTracker = w, exports2.Reference = j, exports2.ReferenceWithData = B, exports2.ReferenceWithFinalizer = M, exports2.ScopeStore = k, exports2.Store = W, exports2.TrackedFinalizer = E, exports2.TryCatch = o, exports2.createContext = Q, exports2.getDefaultContext = function() {
      return J || (J = Q()), J;
    }, exports2.getExternalValue = s, exports2.isExternal = t, exports2.isReferenceType = function(e2) {
      return "object" == typeof e2 && null !== e2 || "function" == typeof e2;
    }, exports2.version = v;
  }
});

// node_modules/@emnapi/runtime/dist/emnapi.cjs.js
var require_emnapi_cjs = __commonJS({
  "node_modules/@emnapi/runtime/dist/emnapi.cjs.js"(exports2) {
    var externalValue = /* @__PURE__ */ new WeakMap();
    function isExternal(object) {
      return externalValue.has(object);
    }
    var External = (() => {
      function External2(value) {
        Object.setPrototypeOf(this, null);
        externalValue.set(this, value);
      }
      External2.prototype = null;
      return External2;
    })();
    function getExternalValue(external) {
      if (!isExternal(external)) {
        throw new TypeError("not external");
      }
      return externalValue.get(external);
    }
    var supportNewFunction = function() {
      let f;
      try {
        f = new Function();
      } catch (_) {
        return false;
      }
      return typeof f === "function";
    }();
    var _global = function() {
      if (typeof globalThis !== "undefined")
        return globalThis;
      let g = /* @__PURE__ */ function() {
        return this;
      }();
      if (!g && supportNewFunction) {
        try {
          g = new Function("return this")();
        } catch (_) {
        }
      }
      if (!g) {
        if (typeof __webpack_public_path__ === "undefined") {
          if (typeof global !== "undefined")
            return global;
        }
        if (typeof window !== "undefined")
          return window;
        if (typeof self !== "undefined")
          return self;
      }
      return g;
    }();
    var TryCatch = class {
      constructor() {
        this._exception = void 0;
        this._caught = false;
      }
      isEmpty() {
        return !this._caught;
      }
      hasCaught() {
        return this._caught;
      }
      exception() {
        return this._exception;
      }
      setError(err) {
        this._caught = true;
        this._exception = err;
      }
      reset() {
        this._caught = false;
        this._exception = void 0;
      }
      extractException() {
        const e = this._exception;
        this.reset();
        return e;
      }
    };
    var canSetFunctionName = function() {
      var _a;
      try {
        return Boolean((_a = Object.getOwnPropertyDescriptor(Function.prototype, "name")) === null || _a === void 0 ? void 0 : _a.configurable);
      } catch (_) {
        return false;
      }
    }();
    var supportReflect = typeof Reflect === "object";
    var supportFinalizer = typeof FinalizationRegistry !== "undefined" && typeof WeakRef !== "undefined";
    var supportWeakSymbol = function() {
      try {
        const sym = Symbol();
        new WeakRef(sym);
        (/* @__PURE__ */ new WeakMap()).set(sym, void 0);
      } catch (_) {
        return false;
      }
      return true;
    }();
    var supportBigInt = typeof BigInt !== "undefined";
    function isReferenceType(v) {
      return typeof v === "object" && v !== null || typeof v === "function";
    }
    var _require = function() {
      let nativeRequire;
      if (typeof __webpack_public_path__ !== "undefined") {
        nativeRequire = /* @__PURE__ */ function() {
          return typeof __non_webpack_require__ !== "undefined" ? __non_webpack_require__ : void 0;
        }();
      } else {
        nativeRequire = /* @__PURE__ */ function() {
          return typeof __webpack_public_path__ !== "undefined" ? typeof __non_webpack_require__ !== "undefined" ? __non_webpack_require__ : void 0 : typeof require !== "undefined" ? require : void 0;
        }();
      }
      return nativeRequire;
    }();
    var _MessageChannel = typeof MessageChannel === "function" ? MessageChannel : function() {
      try {
        return _require("worker_threads").MessageChannel;
      } catch (_) {
      }
      return void 0;
    }();
    var _setImmediate = typeof setImmediate === "function" ? setImmediate.bind(_global) : function(callback) {
      if (typeof callback !== "function") {
        throw new TypeError('The "callback" argument must be of type function');
      }
      if (_MessageChannel) {
        let channel = new _MessageChannel();
        channel.port1.onmessage = function() {
          channel.port1.onmessage = null;
          channel = void 0;
          callback();
        };
        channel.port2.postMessage(null);
      } else {
        setTimeout(callback, 0);
      }
    };
    var _Buffer = typeof Buffer === "function" ? Buffer : function() {
      try {
        return _require("buffer").Buffer;
      } catch (_) {
      }
      return void 0;
    }();
    var version = "1.11.2";
    var NODE_API_SUPPORTED_VERSION_MIN = 1;
    var NODE_API_SUPPORTED_VERSION_MAX = 10;
    var NAPI_VERSION_EXPERIMENTAL = 2147483647;
    var NODE_API_DEFAULT_MODULE_API_VERSION = 8;
    var Handle = class {
      constructor(id, value) {
        this.id = id;
        this.value = value;
      }
      data() {
        return getExternalValue(this.value);
      }
      isNumber() {
        return typeof this.value === "number";
      }
      isBigInt() {
        return typeof this.value === "bigint";
      }
      isString() {
        return typeof this.value === "string";
      }
      isFunction() {
        return typeof this.value === "function";
      }
      isExternal() {
        return isExternal(this.value);
      }
      isObject() {
        return typeof this.value === "object" && this.value !== null;
      }
      isArray() {
        return Array.isArray(this.value);
      }
      isArrayBuffer() {
        return this.value instanceof ArrayBuffer;
      }
      isTypedArray() {
        return ArrayBuffer.isView(this.value) && !(this.value instanceof DataView);
      }
      isBuffer(BufferConstructor) {
        if (ArrayBuffer.isView(this.value))
          return true;
        BufferConstructor !== null && BufferConstructor !== void 0 ? BufferConstructor : BufferConstructor = _Buffer;
        return typeof BufferConstructor === "function" && BufferConstructor.isBuffer(this.value);
      }
      isDataView() {
        return this.value instanceof DataView;
      }
      isDate() {
        return this.value instanceof Date;
      }
      isPromise() {
        return this.value instanceof Promise;
      }
      isBoolean() {
        return typeof this.value === "boolean";
      }
      isUndefined() {
        return this.value === void 0;
      }
      isSymbol() {
        return typeof this.value === "symbol";
      }
      isNull() {
        return this.value === null;
      }
      dispose() {
        this.value = void 0;
      }
    };
    var ConstHandle = class extends Handle {
      constructor(id, value) {
        super(id, value);
      }
      dispose() {
      }
    };
    var HandleStore = class _HandleStore {
      constructor() {
        this._values = [
          void 0,
          _HandleStore.UNDEFINED,
          _HandleStore.NULL,
          _HandleStore.FALSE,
          _HandleStore.TRUE,
          _HandleStore.GLOBAL
        ];
        this._next = _HandleStore.MIN_ID;
      }
      push(value) {
        let h;
        const next = this._next;
        const values = this._values;
        if (next < values.length) {
          h = values[next];
          h.value = value;
        } else {
          h = new Handle(next, value);
          values[next] = h;
        }
        this._next++;
        return h;
      }
      erase(start, end) {
        this._next = start;
        const values = this._values;
        for (let i = start; i < end; ++i) {
          values[i].dispose();
        }
      }
      get(id) {
        return this._values[id];
      }
      swap(a, b) {
        const values = this._values;
        const h = values[a];
        values[a] = values[b];
        values[a].id = Number(a);
        values[b] = h;
        h.id = Number(b);
      }
      dispose() {
        this._values.length = _HandleStore.MIN_ID;
        this._next = _HandleStore.MIN_ID;
      }
    };
    HandleStore.UNDEFINED = new ConstHandle(1, void 0);
    HandleStore.NULL = new ConstHandle(2, null);
    HandleStore.FALSE = new ConstHandle(3, false);
    HandleStore.TRUE = new ConstHandle(4, true);
    HandleStore.GLOBAL = new ConstHandle(5, _global);
    HandleStore.MIN_ID = 6;
    var HandleScope = class {
      constructor(handleStore, id, parentScope, start, end = start) {
        this.handleStore = handleStore;
        this.id = id;
        this.parent = parentScope;
        this.child = null;
        if (parentScope !== null)
          parentScope.child = this;
        this.start = start;
        this.end = end;
        this._escapeCalled = false;
        this.callbackInfo = {
          thiz: void 0,
          data: 0,
          args: void 0,
          fn: void 0
        };
      }
      add(value) {
        const h = this.handleStore.push(value);
        this.end++;
        return h;
      }
      addExternal(data) {
        return this.add(new External(data));
      }
      dispose() {
        if (this._escapeCalled)
          this._escapeCalled = false;
        if (this.start === this.end)
          return;
        this.handleStore.erase(this.start, this.end);
      }
      escape(handle) {
        if (this._escapeCalled)
          return null;
        this._escapeCalled = true;
        if (handle < this.start || handle >= this.end) {
          return null;
        }
        this.handleStore.swap(handle, this.start);
        const h = this.handleStore.get(this.start);
        this.start++;
        this.parent.end++;
        return h;
      }
      escapeCalled() {
        return this._escapeCalled;
      }
    };
    var ScopeStore = class {
      constructor() {
        this._rootScope = new HandleScope(null, 0, null, 1, HandleStore.MIN_ID);
        this.currentScope = this._rootScope;
        this._values = [void 0];
      }
      get(id) {
        return this._values[id];
      }
      openScope(handleStore) {
        const currentScope = this.currentScope;
        let scope = currentScope.child;
        if (scope !== null) {
          scope.start = scope.end = currentScope.end;
        } else {
          const id = currentScope.id + 1;
          scope = new HandleScope(handleStore, id, currentScope, currentScope.end);
          this._values[id] = scope;
        }
        this.currentScope = scope;
        return scope;
      }
      closeScope() {
        const scope = this.currentScope;
        this.currentScope = scope.parent;
        scope.dispose();
      }
      dispose() {
        this.currentScope = this._rootScope;
        this._values.length = 1;
      }
    };
    var RefTracker = class {
      constructor() {
        this._next = null;
        this._prev = null;
      }
      dispose() {
      }
      finalize() {
      }
      link(list) {
        this._prev = list;
        this._next = list._next;
        if (this._next !== null) {
          this._next._prev = this;
        }
        list._next = this;
      }
      unlink() {
        if (this._prev !== null) {
          this._prev._next = this._next;
        }
        if (this._next !== null) {
          this._next._prev = this._prev;
        }
        this._prev = null;
        this._next = null;
      }
      static finalizeAll(list) {
        while (list._next !== null) {
          list._next.finalize();
        }
      }
    };
    var Finalizer = class {
      constructor(envObject, _finalizeCallback = 0, _finalizeData = 0, _finalizeHint = 0) {
        this.envObject = envObject;
        this._finalizeCallback = _finalizeCallback;
        this._finalizeData = _finalizeData;
        this._finalizeHint = _finalizeHint;
        this._makeDynCall_vppp = envObject.makeDynCall_vppp;
      }
      callback() {
        return this._finalizeCallback;
      }
      data() {
        return this._finalizeData;
      }
      hint() {
        return this._finalizeHint;
      }
      resetEnv() {
        this.envObject = void 0;
      }
      resetFinalizer() {
        this._finalizeCallback = 0;
        this._finalizeData = 0;
        this._finalizeHint = 0;
      }
      callFinalizer() {
        const finalize_callback = this._finalizeCallback;
        const finalize_data = this._finalizeData;
        const finalize_hint = this._finalizeHint;
        this.resetFinalizer();
        if (!finalize_callback)
          return;
        const fini = Number(finalize_callback);
        if (!this.envObject) {
          this._makeDynCall_vppp(fini)(0, finalize_data, finalize_hint);
        } else {
          this.envObject.callFinalizer(fini, finalize_data, finalize_hint);
        }
      }
      dispose() {
        this.envObject = void 0;
        this._makeDynCall_vppp = void 0;
      }
    };
    var TrackedFinalizer = class _TrackedFinalizer extends RefTracker {
      static create(envObject, finalize_callback, finalize_data, finalize_hint) {
        const finalizer = new _TrackedFinalizer(envObject, finalize_callback, finalize_data, finalize_hint);
        finalizer.link(envObject.finalizing_reflist);
        return finalizer;
      }
      constructor(envObject, finalize_callback, finalize_data, finalize_hint) {
        super();
        this._finalizer = new Finalizer(envObject, finalize_callback, finalize_data, finalize_hint);
      }
      data() {
        return this._finalizer.data();
      }
      dispose() {
        if (!this._finalizer)
          return;
        this.unlink();
        this._finalizer.envObject.dequeueFinalizer(this);
        this._finalizer.dispose();
        this._finalizer = void 0;
        super.dispose();
      }
      finalize() {
        this.unlink();
        let error;
        let caught = false;
        try {
          this._finalizer.callFinalizer();
        } catch (err) {
          caught = true;
          error = err;
        }
        this.dispose();
        if (caught) {
          throw error;
        }
      }
    };
    function throwNodeApiVersionError(moduleName, moduleApiVersion) {
      const errorMessage = `${moduleName} requires Node-API version ${moduleApiVersion}, but this version of Node.js only supports version ${NODE_API_SUPPORTED_VERSION_MAX} add-ons.`;
      throw new Error(errorMessage);
    }
    function handleThrow(envObject, value) {
      if (envObject.terminatedOrTerminating()) {
        return;
      }
      throw value;
    }
    var Env = class {
      constructor(ctx, moduleApiVersion, makeDynCall_vppp, makeDynCall_vp, abort) {
        this.ctx = ctx;
        this.moduleApiVersion = moduleApiVersion;
        this.makeDynCall_vppp = makeDynCall_vppp;
        this.makeDynCall_vp = makeDynCall_vp;
        this.abort = abort;
        this.openHandleScopes = 0;
        this.instanceData = null;
        this.tryCatch = new TryCatch();
        this.refs = 1;
        this.reflist = new RefTracker();
        this.finalizing_reflist = new RefTracker();
        this.pendingFinalizers = [];
        this.lastError = {
          errorCode: 0,
          engineErrorCode: 0,
          engineReserved: 0
        };
        this.inGcFinalizer = false;
        this._bindingMap = /* @__PURE__ */ new WeakMap();
        this.id = 0;
      }
      canCallIntoJs() {
        return true;
      }
      terminatedOrTerminating() {
        return !this.canCallIntoJs();
      }
      ref() {
        this.refs++;
      }
      unref() {
        this.refs--;
        if (this.refs === 0) {
          this.dispose();
        }
      }
      ensureHandle(value) {
        return this.ctx.ensureHandle(value);
      }
      ensureHandleId(value) {
        return this.ensureHandle(value).id;
      }
      clearLastError() {
        const lastError = this.lastError;
        if (lastError.errorCode !== 0)
          lastError.errorCode = 0;
        if (lastError.engineErrorCode !== 0)
          lastError.engineErrorCode = 0;
        if (lastError.engineReserved !== 0)
          lastError.engineReserved = 0;
        return 0;
      }
      setLastError(error_code, engine_error_code = 0, engine_reserved = 0) {
        const lastError = this.lastError;
        if (lastError.errorCode !== error_code)
          lastError.errorCode = error_code;
        if (lastError.engineErrorCode !== engine_error_code)
          lastError.engineErrorCode = engine_error_code;
        if (lastError.engineReserved !== engine_reserved)
          lastError.engineReserved = engine_reserved;
        return error_code;
      }
      getReturnStatus() {
        return !this.tryCatch.hasCaught() ? 0 : this.setLastError(10);
      }
      callIntoModule(fn, handleException = handleThrow) {
        const openHandleScopesBefore = this.openHandleScopes;
        this.clearLastError();
        const r = fn(this);
        if (openHandleScopesBefore !== this.openHandleScopes) {
          this.abort("open_handle_scopes != open_handle_scopes_before");
        }
        if (this.tryCatch.hasCaught()) {
          const err = this.tryCatch.extractException();
          handleException(this, err);
        }
        return r;
      }
      invokeFinalizerFromGC(finalizer) {
        if (this.moduleApiVersion !== NAPI_VERSION_EXPERIMENTAL) {
          this.enqueueFinalizer(finalizer);
        } else {
          const saved = this.inGcFinalizer;
          this.inGcFinalizer = true;
          try {
            finalizer.finalize();
          } finally {
            this.inGcFinalizer = saved;
          }
        }
      }
      checkGCAccess() {
        if (this.moduleApiVersion === NAPI_VERSION_EXPERIMENTAL && this.inGcFinalizer) {
          this.abort("Finalizer is calling a function that may affect GC state.\nThe finalizers are run directly from GC and must not affect GC state.\nUse `node_api_post_finalizer` from inside of the finalizer to work around this issue.\nIt schedules the call as a new task in the event loop.");
        }
      }
      enqueueFinalizer(finalizer) {
        if (this.pendingFinalizers.indexOf(finalizer) === -1) {
          this.pendingFinalizers.push(finalizer);
        }
      }
      dequeueFinalizer(finalizer) {
        const index = this.pendingFinalizers.indexOf(finalizer);
        if (index !== -1) {
          this.pendingFinalizers.splice(index, 1);
        }
      }
      deleteMe() {
        RefTracker.finalizeAll(this.finalizing_reflist);
        RefTracker.finalizeAll(this.reflist);
        this.tryCatch.extractException();
        this.ctx.envStore.remove(this.id);
      }
      dispose() {
        if (this.id === 0)
          return;
        this.deleteMe();
        this.finalizing_reflist.dispose();
        this.reflist.dispose();
        this.id = 0;
      }
      initObjectBinding(value) {
        const binding = {
          wrapped: 0,
          tag: null
        };
        this._bindingMap.set(value, binding);
        return binding;
      }
      getObjectBinding(value) {
        if (this._bindingMap.has(value)) {
          return this._bindingMap.get(value);
        }
        return this.initObjectBinding(value);
      }
      setInstanceData(data, finalize_cb, finalize_hint) {
        if (this.instanceData) {
          this.instanceData.dispose();
        }
        this.instanceData = TrackedFinalizer.create(this, finalize_cb, data, finalize_hint);
      }
      getInstanceData() {
        return this.instanceData ? this.instanceData.data() : 0;
      }
    };
    var NodeEnv = class extends Env {
      constructor(ctx, filename, moduleApiVersion, makeDynCall_vppp, makeDynCall_vp, abort, nodeBinding) {
        super(ctx, moduleApiVersion, makeDynCall_vppp, makeDynCall_vp, abort);
        this.filename = filename;
        this.nodeBinding = nodeBinding;
        this.destructing = false;
        this.finalizationScheduled = false;
      }
      deleteMe() {
        this.destructing = true;
        this.drainFinalizerQueue();
        super.deleteMe();
      }
      canCallIntoJs() {
        return super.canCallIntoJs() && this.ctx.canCallIntoJs();
      }
      triggerFatalException(err) {
        if (this.nodeBinding) {
          this.nodeBinding.napi.fatalException(err);
        } else {
          if (typeof process === "object" && process !== null && typeof process._fatalException === "function") {
            const handled = process._fatalException(err);
            if (!handled) {
              console.error(err);
              process.exit(1);
            }
          } else {
            throw err;
          }
        }
      }
      callbackIntoModule(enforceUncaughtExceptionPolicy, fn) {
        return this.callIntoModule(fn, (envObject, err) => {
          if (envObject.terminatedOrTerminating()) {
            return;
          }
          const hasProcess = typeof process === "object" && process !== null;
          const hasForceFlag = hasProcess ? Boolean(process.execArgv && process.execArgv.indexOf("--force-node-api-uncaught-exceptions-policy") !== -1) : false;
          if (envObject.moduleApiVersion < 10 && !hasForceFlag && !enforceUncaughtExceptionPolicy) {
            const warn = hasProcess && typeof process.emitWarning === "function" ? process.emitWarning : function(warning, type, code) {
              if (warning instanceof Error) {
                console.warn(warning.toString());
              } else {
                const prefix = code ? `[${code}] ` : "";
                console.warn(`${prefix}${type || "Warning"}: ${warning}`);
              }
            };
            warn("Uncaught Node-API callback exception detected, please run node with option --force-node-api-uncaught-exceptions-policy=true to handle those exceptions properly.", "DeprecationWarning", "DEP0168");
            return;
          }
          envObject.triggerFatalException(err);
        });
      }
      callFinalizer(cb, data, hint) {
        this.callFinalizerInternal(1, cb, data, hint);
      }
      callFinalizerInternal(forceUncaught, cb, data, hint) {
        const f = this.makeDynCall_vppp(cb);
        const env = this.id;
        const scope = this.ctx.openScope(this);
        try {
          this.callbackIntoModule(Boolean(forceUncaught), () => {
            f(env, data, hint);
          });
        } finally {
          this.ctx.closeScope(this, scope);
        }
      }
      enqueueFinalizer(finalizer) {
        super.enqueueFinalizer(finalizer);
        if (!this.finalizationScheduled && !this.destructing) {
          this.finalizationScheduled = true;
          this.ref();
          _setImmediate(() => {
            this.finalizationScheduled = false;
            this.unref();
            this.drainFinalizerQueue();
          });
        }
      }
      drainFinalizerQueue() {
        while (this.pendingFinalizers.length > 0) {
          const refTracker = this.pendingFinalizers.shift();
          refTracker.finalize();
        }
      }
    };
    function newEnv(ctx, filename, moduleApiVersion, makeDynCall_vppp, makeDynCall_vp, abort, nodeBinding) {
      moduleApiVersion = typeof moduleApiVersion !== "number" ? NODE_API_DEFAULT_MODULE_API_VERSION : moduleApiVersion;
      if (moduleApiVersion < NODE_API_DEFAULT_MODULE_API_VERSION) {
        moduleApiVersion = NODE_API_DEFAULT_MODULE_API_VERSION;
      } else if (moduleApiVersion > NODE_API_SUPPORTED_VERSION_MAX && moduleApiVersion !== NAPI_VERSION_EXPERIMENTAL) {
        throwNodeApiVersionError(filename, moduleApiVersion);
      }
      const env = new NodeEnv(ctx, filename, moduleApiVersion, makeDynCall_vppp, makeDynCall_vp, abort, nodeBinding);
      ctx.envStore.add(env);
      ctx.addCleanupHook(env, () => {
        env.unref();
      }, 0);
      return env;
    }
    var EmnapiError = class _EmnapiError extends Error {
      constructor(message) {
        super(message);
        const ErrorConstructor = new.target;
        const proto = ErrorConstructor.prototype;
        if (!(this instanceof _EmnapiError)) {
          const setPrototypeOf = Object.setPrototypeOf;
          if (typeof setPrototypeOf === "function") {
            setPrototypeOf.call(Object, this, proto);
          } else {
            this.__proto__ = proto;
          }
          if (typeof Error.captureStackTrace === "function") {
            Error.captureStackTrace(this, ErrorConstructor);
          }
        }
      }
    };
    Object.defineProperty(EmnapiError.prototype, "name", {
      configurable: true,
      writable: true,
      value: "EmnapiError"
    });
    var NotSupportWeakRefError = class extends EmnapiError {
      constructor(api, message) {
        super(`${api}: The current runtime does not support "FinalizationRegistry" and "WeakRef".${message ? ` ${message}` : ""}`);
      }
    };
    Object.defineProperty(NotSupportWeakRefError.prototype, "name", {
      configurable: true,
      writable: true,
      value: "NotSupportWeakRefError"
    });
    var NotSupportBufferError = class extends EmnapiError {
      constructor(api, message) {
        super(`${api}: The current runtime does not support "Buffer". Consider using buffer polyfill to make sure \`globalThis.Buffer\` is defined.${message ? ` ${message}` : ""}`);
      }
    };
    Object.defineProperty(NotSupportBufferError.prototype, "name", {
      configurable: true,
      writable: true,
      value: "NotSupportBufferError"
    });
    var StrongRef = class {
      constructor(value) {
        this._value = value;
      }
      deref() {
        return this._value;
      }
      dispose() {
        this._value = void 0;
      }
    };
    var Persistent = class _Persistent {
      constructor(value) {
        this._ref = new StrongRef(value);
      }
      setWeak(param, callback) {
        if (!supportFinalizer || this._ref === void 0 || this._ref instanceof WeakRef)
          return;
        const value = this._ref.deref();
        try {
          _Persistent._registry.register(value, this, this);
          const weakRef = new WeakRef(value);
          this._ref.dispose();
          this._ref = weakRef;
          this._param = param;
          this._callback = callback;
        } catch (err) {
          if (typeof value === "symbol") ;
          else {
            throw err;
          }
        }
      }
      clearWeak() {
        if (!supportFinalizer || this._ref === void 0)
          return;
        if (this._ref instanceof WeakRef) {
          try {
            _Persistent._registry.unregister(this);
          } catch (_) {
          }
          this._param = void 0;
          this._callback = void 0;
          const value = this._ref.deref();
          if (value === void 0) {
            this._ref = value;
          } else {
            this._ref = new StrongRef(value);
          }
        }
      }
      reset() {
        if (supportFinalizer) {
          try {
            _Persistent._registry.unregister(this);
          } catch (_) {
          }
        }
        this._param = void 0;
        this._callback = void 0;
        if (this._ref instanceof StrongRef) {
          this._ref.dispose();
        }
        this._ref = void 0;
      }
      isEmpty() {
        return this._ref === void 0;
      }
      deref() {
        if (this._ref === void 0)
          return void 0;
        return this._ref.deref();
      }
    };
    Persistent._registry = supportFinalizer ? new FinalizationRegistry((value) => {
      value._ref = void 0;
      const callback = value._callback;
      const param = value._param;
      value._callback = void 0;
      value._param = void 0;
      if (typeof callback === "function") {
        callback(param);
      }
    }) : void 0;
    exports2.ReferenceOwnership = void 0;
    (function(ReferenceOwnership) {
      ReferenceOwnership[ReferenceOwnership["kRuntime"] = 0] = "kRuntime";
      ReferenceOwnership[ReferenceOwnership["kUserland"] = 1] = "kUserland";
    })(exports2.ReferenceOwnership || (exports2.ReferenceOwnership = {}));
    function canBeHeldWeakly(value) {
      return value.isObject() || value.isFunction() || value.isSymbol();
    }
    var Reference = class _Reference extends RefTracker {
      static weakCallback(ref) {
        ref.persistent.reset();
        ref.invokeFinalizerFromGC();
      }
      static create(envObject, handle_id, initialRefcount, ownership, _unused1, _unused2, _unused3) {
        const ref = new _Reference(envObject, handle_id, initialRefcount, ownership);
        envObject.ctx.refStore.add(ref);
        ref.link(envObject.reflist);
        return ref;
      }
      constructor(envObject, handle_id, initialRefcount, ownership) {
        super();
        this.envObject = envObject;
        this._refcount = initialRefcount;
        this._ownership = ownership;
        const handle = envObject.ctx.handleStore.get(handle_id);
        this.canBeWeak = canBeHeldWeakly(handle);
        this.persistent = new Persistent(handle.value);
        this.id = 0;
        if (initialRefcount === 0) {
          this._setWeak();
        }
      }
      ref() {
        if (this.persistent.isEmpty()) {
          return 0;
        }
        if (++this._refcount === 1 && this.canBeWeak) {
          this.persistent.clearWeak();
        }
        return this._refcount;
      }
      unref() {
        if (this.persistent.isEmpty() || this._refcount === 0) {
          return 0;
        }
        if (--this._refcount === 0) {
          this._setWeak();
        }
        return this._refcount;
      }
      get(envObject = this.envObject) {
        if (this.persistent.isEmpty()) {
          return 0;
        }
        const obj = this.persistent.deref();
        const handle = envObject.ensureHandle(obj);
        return handle.id;
      }
      resetFinalizer() {
      }
      data() {
        return 0;
      }
      refcount() {
        return this._refcount;
      }
      ownership() {
        return this._ownership;
      }
      callUserFinalizer() {
      }
      invokeFinalizerFromGC() {
        this.finalize();
      }
      _setWeak() {
        if (this.canBeWeak) {
          this.persistent.setWeak(this, _Reference.weakCallback);
        } else {
          this.persistent.reset();
        }
      }
      finalize() {
        this.persistent.reset();
        const deleteMe = this._ownership === exports2.ReferenceOwnership.kRuntime;
        this.unlink();
        this.callUserFinalizer();
        if (deleteMe) {
          this.dispose();
        }
      }
      dispose() {
        if (this.id === 0)
          return;
        this.unlink();
        this.persistent.reset();
        this.envObject.ctx.refStore.remove(this.id);
        super.dispose();
        this.envObject = void 0;
        this.id = 0;
      }
    };
    var ReferenceWithData = class _ReferenceWithData extends Reference {
      static create(envObject, value, initialRefcount, ownership, data) {
        const reference = new _ReferenceWithData(envObject, value, initialRefcount, ownership, data);
        envObject.ctx.refStore.add(reference);
        reference.link(envObject.reflist);
        return reference;
      }
      constructor(envObject, value, initialRefcount, ownership, _data) {
        super(envObject, value, initialRefcount, ownership);
        this._data = _data;
      }
      data() {
        return this._data;
      }
    };
    var ReferenceWithFinalizer = class _ReferenceWithFinalizer extends Reference {
      static create(envObject, value, initialRefcount, ownership, finalize_callback, finalize_data, finalize_hint) {
        const reference = new _ReferenceWithFinalizer(envObject, value, initialRefcount, ownership, finalize_callback, finalize_data, finalize_hint);
        envObject.ctx.refStore.add(reference);
        reference.link(envObject.finalizing_reflist);
        return reference;
      }
      constructor(envObject, value, initialRefcount, ownership, finalize_callback, finalize_data, finalize_hint) {
        super(envObject, value, initialRefcount, ownership);
        this._finalizer = new Finalizer(envObject, finalize_callback, finalize_data, finalize_hint);
      }
      resetFinalizer() {
        this._finalizer.resetFinalizer();
      }
      data() {
        return this._finalizer.data();
      }
      callUserFinalizer() {
        this._finalizer.callFinalizer();
      }
      invokeFinalizerFromGC() {
        this._finalizer.envObject.invokeFinalizerFromGC(this);
      }
      dispose() {
        if (!this._finalizer)
          return;
        this._finalizer.envObject.dequeueFinalizer(this);
        this._finalizer.dispose();
        super.dispose();
        this._finalizer = void 0;
      }
    };
    var Deferred = class _Deferred {
      static create(ctx, value) {
        const deferred = new _Deferred(ctx, value);
        ctx.deferredStore.add(deferred);
        return deferred;
      }
      constructor(ctx, value) {
        this.id = 0;
        this.ctx = ctx;
        this.value = value;
      }
      resolve(value) {
        this.value.resolve(value);
        this.dispose();
      }
      reject(reason) {
        this.value.reject(reason);
        this.dispose();
      }
      dispose() {
        this.ctx.deferredStore.remove(this.id);
        this.id = 0;
        this.value = null;
        this.ctx = null;
      }
    };
    var Store = class {
      constructor() {
        this._values = [void 0];
        this._values.length = 4;
        this._size = 1;
        this._freeList = [];
      }
      add(value) {
        let id;
        if (this._freeList.length) {
          id = this._freeList.shift();
        } else {
          id = this._size;
          this._size++;
          const capacity = this._values.length;
          if (id >= capacity) {
            this._values.length = capacity + (capacity >> 1) + 16;
          }
        }
        value.id = id;
        this._values[id] = value;
      }
      get(id) {
        return this._values[id];
      }
      has(id) {
        return this._values[id] !== void 0;
      }
      remove(id) {
        const value = this._values[id];
        if (value) {
          value.id = 0;
          this._values[id] = void 0;
          this._freeList.push(Number(id));
        }
      }
      dispose() {
        for (let i = 1; i < this._size; ++i) {
          const value = this._values[i];
          value === null || value === void 0 ? void 0 : value.dispose();
        }
        this._values = [void 0];
        this._size = 1;
        this._freeList = [];
      }
    };
    var kMaxReasonableBytes = BigInt(1) << BigInt(60);
    var kMinReasonableBytes = -kMaxReasonableBytes;
    var ExternalMemory = class {
      constructor(onChange) {
        this.total = BigInt(0);
        this.onChange = onChange !== null && onChange !== void 0 ? onChange : null;
      }
      adjust(changeInBytes) {
        changeInBytes = BigInt(changeInBytes);
        if (!(kMinReasonableBytes <= changeInBytes && changeInBytes < kMaxReasonableBytes)) {
          throw new RangeError(`changeInBytes ${changeInBytes} is out of reasonable range`);
        }
        const old = this.total;
        this.total += changeInBytes;
        const amount = this.total;
        const onChange = this.onChange;
        if (changeInBytes) {
          onChange === null || onChange === void 0 ? void 0 : onChange(amount, old, changeInBytes);
        }
        return amount;
      }
    };
    var CleanupHookCallback = class {
      constructor(envObject, fn, arg, order) {
        this.envObject = envObject;
        this.fn = fn;
        this.arg = arg;
        this.order = order;
      }
    };
    var CleanupQueue = class {
      constructor() {
        this._cleanupHooks = [];
        this._cleanupHookCounter = 0;
      }
      empty() {
        return this._cleanupHooks.length === 0;
      }
      add(envObject, fn, arg) {
        if (this._cleanupHooks.filter((hook) => hook.envObject === envObject && hook.fn === fn && hook.arg === arg).length > 0) {
          throw new Error("Can not add same fn and arg twice");
        }
        this._cleanupHooks.push(new CleanupHookCallback(envObject, fn, arg, this._cleanupHookCounter++));
      }
      remove(envObject, fn, arg) {
        for (let i = 0; i < this._cleanupHooks.length; ++i) {
          const hook = this._cleanupHooks[i];
          if (hook.envObject === envObject && hook.fn === fn && hook.arg === arg) {
            this._cleanupHooks.splice(i, 1);
            return;
          }
        }
      }
      drain() {
        const hooks = this._cleanupHooks.slice();
        hooks.sort((a, b) => b.order - a.order);
        for (let i = 0; i < hooks.length; ++i) {
          const cb = hooks[i];
          if (typeof cb.fn === "number") {
            cb.envObject.makeDynCall_vp(cb.fn)(cb.arg);
          } else {
            cb.fn(cb.arg);
          }
          this._cleanupHooks.splice(this._cleanupHooks.indexOf(cb), 1);
        }
      }
      dispose() {
        this._cleanupHooks.length = 0;
        this._cleanupHookCounter = 0;
      }
    };
    var NodejsWaitingRequestCounter = class {
      constructor() {
        this.refHandle = new _MessageChannel().port1;
        this.count = 0;
      }
      increase() {
        if (this.count === 0) {
          if (this.refHandle.ref) {
            this.refHandle.ref();
          }
          __oc_liveRetain();
        }
        this.count++;
      }
      decrease() {
        if (this.count === 0)
          return;
        if (this.count === 1) {
          if (this.refHandle.unref) {
            this.refHandle.unref();
          }
          __oc_liveRelease();
        }
        this.count--;
      }
    };
    var Context = class {
      constructor(options) {
        this._isStopping = false;
        this._canCallIntoJs = true;
        this._suppressDestroy = false;
        this.envStore = new Store();
        this.scopeStore = new ScopeStore();
        this.refStore = new Store();
        this.deferredStore = new Store();
        this.handleStore = new HandleStore();
        this.feature = {
          supportReflect,
          supportFinalizer,
          supportWeakSymbol,
          supportBigInt,
          supportNewFunction,
          canSetFunctionName,
          setImmediate: _setImmediate,
          Buffer: _Buffer,
          MessageChannel: _MessageChannel
        };
        this.cleanupQueue = new CleanupQueue();
        this._externalMemory = new ExternalMemory(options === null || options === void 0 ? void 0 : options.onExternalMemoryChange);
        if (typeof process === "object" && process !== null && typeof process.once === "function") {
          this.refCounter = new NodejsWaitingRequestCounter();
          process.once("beforeExit", () => {
            if (!this._suppressDestroy) {
              this.destroy();
            }
          });
        }
      }
      suppressDestroy() {
        this._suppressDestroy = true;
      }
      getRuntimeVersions() {
        return {
          version,
          NODE_API_SUPPORTED_VERSION_MAX,
          NAPI_VERSION_EXPERIMENTAL,
          NODE_API_DEFAULT_MODULE_API_VERSION
        };
      }
      createNotSupportWeakRefError(api, message) {
        return new NotSupportWeakRefError(api, message);
      }
      createNotSupportBufferError(api, message) {
        return new NotSupportBufferError(api, message);
      }
      createReference(envObject, handle_id, initialRefcount, ownership) {
        return Reference.create(envObject, handle_id, initialRefcount, ownership);
      }
      createReferenceWithData(envObject, handle_id, initialRefcount, ownership, data) {
        return ReferenceWithData.create(envObject, handle_id, initialRefcount, ownership, data);
      }
      createReferenceWithFinalizer(envObject, handle_id, initialRefcount, ownership, finalize_callback = 0, finalize_data = 0, finalize_hint = 0) {
        return ReferenceWithFinalizer.create(envObject, handle_id, initialRefcount, ownership, finalize_callback, finalize_data, finalize_hint);
      }
      createDeferred(value) {
        return Deferred.create(this, value);
      }
      adjustAmountOfExternalAllocatedMemory(changeInBytes) {
        return this._externalMemory.adjust(changeInBytes);
      }
      createEnv(filename, moduleApiVersion, makeDynCall_vppp, makeDynCall_vp, abort, nodeBinding) {
        return newEnv(this, filename, moduleApiVersion, makeDynCall_vppp, makeDynCall_vp, abort, nodeBinding);
      }
      createTrackedFinalizer(envObject, finalize_callback, finalize_data, finalize_hint) {
        return TrackedFinalizer.create(envObject, finalize_callback, finalize_data, finalize_hint);
      }
      getCurrentScope() {
        return this.scopeStore.currentScope;
      }
      addToCurrentScope(value) {
        return this.scopeStore.currentScope.add(value);
      }
      openScope(envObject) {
        const scope = this.scopeStore.openScope(this.handleStore);
        if (envObject)
          envObject.openHandleScopes++;
        return scope;
      }
      closeScope(envObject, _scope) {
        if (envObject && envObject.openHandleScopes === 0)
          return;
        this.scopeStore.closeScope();
        if (envObject)
          envObject.openHandleScopes--;
      }
      ensureHandle(value) {
        switch (value) {
          case void 0:
            return HandleStore.UNDEFINED;
          case null:
            return HandleStore.NULL;
          case true:
            return HandleStore.TRUE;
          case false:
            return HandleStore.FALSE;
          case _global:
            return HandleStore.GLOBAL;
        }
        return this.addToCurrentScope(value);
      }
      addCleanupHook(envObject, fn, arg) {
        this.cleanupQueue.add(envObject, fn, arg);
      }
      removeCleanupHook(envObject, fn, arg) {
        this.cleanupQueue.remove(envObject, fn, arg);
      }
      runCleanup() {
        while (!this.cleanupQueue.empty()) {
          this.cleanupQueue.drain();
        }
      }
      increaseWaitingRequestCounter() {
        var _a;
        (_a = this.refCounter) === null || _a === void 0 ? void 0 : _a.increase();
      }
      decreaseWaitingRequestCounter() {
        var _a;
        (_a = this.refCounter) === null || _a === void 0 ? void 0 : _a.decrease();
      }
      setCanCallIntoJs(value) {
        this._canCallIntoJs = value;
      }
      setStopping(value) {
        this._isStopping = value;
      }
      canCallIntoJs() {
        return this._canCallIntoJs && !this._isStopping;
      }
      destroy() {
        this.setStopping(true);
        this.setCanCallIntoJs(false);
        this.runCleanup();
      }
    };
    var defaultContext;
    function createContext(options) {
      return new Context(options);
    }
    function getDefaultContext2() {
      if (!defaultContext) {
        defaultContext = createContext();
      }
      return defaultContext;
    }
    exports2.ConstHandle = ConstHandle;
    exports2.Context = Context;
    exports2.Deferred = Deferred;
    exports2.EmnapiError = EmnapiError;
    exports2.Env = Env;
    exports2.External = External;
    exports2.Finalizer = Finalizer;
    exports2.Handle = Handle;
    exports2.HandleScope = HandleScope;
    exports2.HandleStore = HandleStore;
    exports2.NAPI_VERSION_EXPERIMENTAL = NAPI_VERSION_EXPERIMENTAL;
    exports2.NODE_API_DEFAULT_MODULE_API_VERSION = NODE_API_DEFAULT_MODULE_API_VERSION;
    exports2.NODE_API_SUPPORTED_VERSION_MAX = NODE_API_SUPPORTED_VERSION_MAX;
    exports2.NODE_API_SUPPORTED_VERSION_MIN = NODE_API_SUPPORTED_VERSION_MIN;
    exports2.NodeEnv = NodeEnv;
    exports2.NotSupportBufferError = NotSupportBufferError;
    exports2.NotSupportWeakRefError = NotSupportWeakRefError;
    exports2.Persistent = Persistent;
    exports2.RefTracker = RefTracker;
    exports2.Reference = Reference;
    exports2.ReferenceWithData = ReferenceWithData;
    exports2.ReferenceWithFinalizer = ReferenceWithFinalizer;
    exports2.ScopeStore = ScopeStore;
    exports2.Store = Store;
    exports2.TrackedFinalizer = TrackedFinalizer;
    exports2.TryCatch = TryCatch;
    exports2.createContext = createContext;
    exports2.getDefaultContext = getDefaultContext2;
    exports2.getExternalValue = getExternalValue;
    exports2.isExternal = isExternal;
    exports2.isReferenceType = isReferenceType;
    exports2.version = version;
  }
});

// node_modules/@emnapi/runtime/index.js
var require_runtime = __commonJS({
  "node_modules/@emnapi/runtime/index.js"(exports2, module2) {
    if (typeof process !== "undefined" && process.env.NODE_ENV === "production") {
      module2.exports = require_emnapi_cjs_min();
    } else {
      module2.exports = require_emnapi_cjs();
    }
  }
});

// node_modules/tslib/tslib.js
var require_tslib = __commonJS({
  "node_modules/tslib/tslib.js"(exports2, module2) {
    var __extends;
    var __assign;
    var __rest;
    var __decorate;
    var __param;
    var __esDecorate;
    var __runInitializers;
    var __propKey;
    var __setFunctionName;
    var __metadata;
    var __awaiter;
    var __generator;
    var __exportStar;
    var __values;
    var __read;
    var __spread;
    var __spreadArrays;
    var __spreadArray;
    var __await;
    var __asyncGenerator;
    var __asyncDelegator;
    var __asyncValues;
    var __makeTemplateObject;
    var __importStar;
    var __importDefault;
    var __classPrivateFieldGet;
    var __classPrivateFieldSet;
    var __classPrivateFieldIn;
    var __createBinding;
    var __addDisposableResource;
    var __disposeResources;
    var __rewriteRelativeImportExtension;
    (function(factory) {
      var root = typeof global === "object" ? global : typeof self === "object" ? self : typeof this === "object" ? this : {};
      if (typeof define === "function" && define.amd) {
        define("tslib", ["exports"], function(exports3) {
          factory(createExporter(root, createExporter(exports3)));
        });
      } else if (typeof module2 === "object" && typeof module2.exports === "object") {
        factory(createExporter(root, createExporter(module2.exports)));
      } else {
        factory(createExporter(root));
      }
      function createExporter(exports3, previous) {
        if (exports3 !== root) {
          if (typeof Object.create === "function") {
            Object.defineProperty(exports3, "__esModule", { value: true });
          } else {
            exports3.__esModule = true;
          }
        }
        return function(id, v) {
          return exports3[id] = previous ? previous(id, v) : v;
        };
      }
    })(function(exporter) {
      var extendStatics = Object.setPrototypeOf || { __proto__: [] } instanceof Array && function(d, b) {
        d.__proto__ = b;
      } || function(d, b) {
        for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p];
      };
      __extends = function(d, b) {
        if (typeof b !== "function" && b !== null)
          throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() {
          this.constructor = d;
        }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
      };
      __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
          s = arguments[i];
          for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p)) t[p] = s[p];
        }
        return t;
      };
      __rest = function(s, e) {
        var t = {};
        for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
          t[p] = s[p];
        if (s != null && typeof Object.getOwnPropertySymbols === "function")
          for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
              t[p[i]] = s[p[i]];
          }
        return t;
      };
      __decorate = function(decorators, target, key, desc) {
        var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
        if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
        else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
        return c > 3 && r && Object.defineProperty(target, key, r), r;
      };
      __param = function(paramIndex, decorator) {
        return function(target, key) {
          decorator(target, key, paramIndex);
        };
      };
      __esDecorate = function(ctor, descriptorIn, decorators, contextIn, initializers, extraInitializers) {
        function accept(f) {
          if (f !== void 0 && typeof f !== "function") throw new TypeError("Function expected");
          return f;
        }
        var kind = contextIn.kind, key = kind === "getter" ? "get" : kind === "setter" ? "set" : "value";
        var target = !descriptorIn && ctor ? contextIn["static"] ? ctor : ctor.prototype : null;
        var descriptor = descriptorIn || (target ? Object.getOwnPropertyDescriptor(target, contextIn.name) : {});
        var _, done = false;
        for (var i = decorators.length - 1; i >= 0; i--) {
          var context = {};
          for (var p in contextIn) context[p] = p === "access" ? {} : contextIn[p];
          for (var p in contextIn.access) context.access[p] = contextIn.access[p];
          context.addInitializer = function(f) {
            if (done) throw new TypeError("Cannot add initializers after decoration has completed");
            extraInitializers.push(accept(f || null));
          };
          var result = (0, decorators[i])(kind === "accessor" ? { get: descriptor.get, set: descriptor.set } : descriptor[key], context);
          if (kind === "accessor") {
            if (result === void 0) continue;
            if (result === null || typeof result !== "object") throw new TypeError("Object expected");
            if (_ = accept(result.get)) descriptor.get = _;
            if (_ = accept(result.set)) descriptor.set = _;
            if (_ = accept(result.init)) initializers.unshift(_);
          } else if (_ = accept(result)) {
            if (kind === "field") initializers.unshift(_);
            else descriptor[key] = _;
          }
        }
        if (target) Object.defineProperty(target, contextIn.name, descriptor);
        done = true;
      };
      __runInitializers = function(thisArg, initializers, value) {
        var useValue = arguments.length > 2;
        for (var i = 0; i < initializers.length; i++) {
          value = useValue ? initializers[i].call(thisArg, value) : initializers[i].call(thisArg);
        }
        return useValue ? value : void 0;
      };
      __propKey = function(x) {
        return typeof x === "symbol" ? x : "".concat(x);
      };
      __setFunctionName = function(f, name, prefix) {
        if (typeof name === "symbol") name = name.description ? "[".concat(name.description, "]") : "";
        return Object.defineProperty(f, "name", { configurable: true, value: prefix ? "".concat(prefix, " ", name) : name });
      };
      __metadata = function(metadataKey, metadataValue) {
        if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(metadataKey, metadataValue);
      };
      __awaiter = function(thisArg, _arguments, P, generator) {
        function adopt(value) {
          return value instanceof P ? value : new P(function(resolve) {
            resolve(value);
          });
        }
        return new (P || (P = Promise))(function(resolve, reject) {
          function fulfilled(value) {
            try {
              step(generator.next(value));
            } catch (e) {
              reject(e);
            }
          }
          function rejected(value) {
            try {
              step(generator["throw"](value));
            } catch (e) {
              reject(e);
            }
          }
          function step(result) {
            result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected);
          }
          step((generator = generator.apply(thisArg, _arguments || [])).next());
        });
      };
      __generator = function(thisArg, body) {
        var _ = { label: 0, sent: function() {
          if (t[0] & 1) throw t[1];
          return t[1];
        }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
        return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() {
          return this;
        }), g;
        function verb(n) {
          return function(v) {
            return step([n, v]);
          };
        }
        function step(op) {
          if (f) throw new TypeError("Generator is already executing.");
          while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
              case 0:
              case 1:
                t = op;
                break;
              case 4:
                _.label++;
                return { value: op[1], done: false };
              case 5:
                _.label++;
                y = op[1];
                op = [0];
                continue;
              case 7:
                op = _.ops.pop();
                _.trys.pop();
                continue;
              default:
                if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) {
                  _ = 0;
                  continue;
                }
                if (op[0] === 3 && (!t || op[1] > t[0] && op[1] < t[3])) {
                  _.label = op[1];
                  break;
                }
                if (op[0] === 6 && _.label < t[1]) {
                  _.label = t[1];
                  t = op;
                  break;
                }
                if (t && _.label < t[2]) {
                  _.label = t[2];
                  _.ops.push(op);
                  break;
                }
                if (t[2]) _.ops.pop();
                _.trys.pop();
                continue;
            }
            op = body.call(thisArg, _);
          } catch (e) {
            op = [6, e];
            y = 0;
          } finally {
            f = t = 0;
          }
          if (op[0] & 5) throw op[1];
          return { value: op[0] ? op[1] : void 0, done: true };
        }
      };
      __exportStar = function(m, o) {
        for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(o, p)) __createBinding(o, m, p);
      };
      __createBinding = Object.create ? function(o, m, k, k2) {
        if (k2 === void 0) k2 = k;
        var desc = Object.getOwnPropertyDescriptor(m, k);
        if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
          desc = { enumerable: true, get: function() {
            return m[k];
          } };
        }
        Object.defineProperty(o, k2, desc);
      } : function(o, m, k, k2) {
        if (k2 === void 0) k2 = k;
        o[k2] = m[k];
      };
      __values = function(o) {
        var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
        if (m) return m.call(o);
        if (o && typeof o.length === "number") return {
          next: function() {
            if (o && i >= o.length) o = void 0;
            return { value: o && o[i++], done: !o };
          }
        };
        throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
      };
      __read = function(o, n) {
        var m = typeof Symbol === "function" && o[Symbol.iterator];
        if (!m) return o;
        var i = m.call(o), r, ar = [], e;
        try {
          while ((n === void 0 || n-- > 0) && !(r = i.next()).done) ar.push(r.value);
        } catch (error) {
          e = { error };
        } finally {
          try {
            if (r && !r.done && (m = i["return"])) m.call(i);
          } finally {
            if (e) throw e.error;
          }
        }
        return ar;
      };
      __spread = function() {
        for (var ar = [], i = 0; i < arguments.length; i++)
          ar = ar.concat(__read(arguments[i]));
        return ar;
      };
      __spreadArrays = function() {
        for (var s = 0, i = 0, il = arguments.length; i < il; i++) s += arguments[i].length;
        for (var r = Array(s), k = 0, i = 0; i < il; i++)
          for (var a = arguments[i], j = 0, jl = a.length; j < jl; j++, k++)
            r[k] = a[j];
        return r;
      };
      __spreadArray = function(to, from, pack) {
        if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
          if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
          }
        }
        return to.concat(ar || Array.prototype.slice.call(from));
      };
      __await = function(v) {
        return this instanceof __await ? (this.v = v, this) : new __await(v);
      };
      __asyncGenerator = function(thisArg, _arguments, generator) {
        if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
        var g = generator.apply(thisArg, _arguments || []), i, q = [];
        return i = Object.create((typeof AsyncIterator === "function" ? AsyncIterator : Object).prototype), verb("next"), verb("throw"), verb("return", awaitReturn), i[Symbol.asyncIterator] = function() {
          return this;
        }, i;
        function awaitReturn(f) {
          return function(v) {
            return Promise.resolve(v).then(f, reject);
          };
        }
        function verb(n, f) {
          if (g[n]) {
            i[n] = function(v) {
              return new Promise(function(a, b) {
                q.push([n, v, a, b]) > 1 || resume(n, v);
              });
            };
            if (f) i[n] = f(i[n]);
          }
        }
        function resume(n, v) {
          try {
            step(g[n](v));
          } catch (e) {
            settle(q[0][3], e);
          }
        }
        function step(r) {
          r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r);
        }
        function fulfill(value) {
          resume("next", value);
        }
        function reject(value) {
          resume("throw", value);
        }
        function settle(f, v) {
          if (f(v), q.shift(), q.length) resume(q[0][0], q[0][1]);
        }
      };
      __asyncDelegator = function(o) {
        var i, p;
        return i = {}, verb("next"), verb("throw", function(e) {
          throw e;
        }), verb("return"), i[Symbol.iterator] = function() {
          return this;
        }, i;
        function verb(n, f) {
          i[n] = o[n] ? function(v) {
            return (p = !p) ? { value: __await(o[n](v)), done: false } : f ? f(v) : v;
          } : f;
        }
      };
      __asyncValues = function(o) {
        if (!Symbol.asyncIterator) throw new TypeError("Symbol.asyncIterator is not defined.");
        var m = o[Symbol.asyncIterator], i;
        return m ? m.call(o) : (o = typeof __values === "function" ? __values(o) : o[Symbol.iterator](), i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function() {
          return this;
        }, i);
        function verb(n) {
          i[n] = o[n] && function(v) {
            return new Promise(function(resolve, reject) {
              v = o[n](v), settle(resolve, reject, v.done, v.value);
            });
          };
        }
        function settle(resolve, reject, d, v) {
          Promise.resolve(v).then(function(v2) {
            resolve({ value: v2, done: d });
          }, reject);
        }
      };
      __makeTemplateObject = function(cooked, raw) {
        if (Object.defineProperty) {
          Object.defineProperty(cooked, "raw", { value: raw });
        } else {
          cooked.raw = raw;
        }
        return cooked;
      };
      var __setModuleDefault = Object.create ? function(o, v) {
        Object.defineProperty(o, "default", { enumerable: true, value: v });
      } : function(o, v) {
        o["default"] = v;
      };
      var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function(o2) {
          var ar = [];
          for (var k in o2) if (Object.prototype.hasOwnProperty.call(o2, k)) ar[ar.length] = k;
          return ar;
        };
        return ownKeys(o);
      };
      __importStar = function(mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) {
          for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        }
        __setModuleDefault(result, mod);
        return result;
      };
      __importDefault = function(mod) {
        return mod && mod.__esModule ? mod : { "default": mod };
      };
      __classPrivateFieldGet = function(receiver, state, kind, f) {
        if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
        if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
        return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
      };
      __classPrivateFieldSet = function(receiver, state, value, kind, f) {
        if (kind === "m") throw new TypeError("Private method is not writable");
        if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a setter");
        if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
        return kind === "a" ? f.call(receiver, value) : f ? f.value = value : state.set(receiver, value), value;
      };
      __classPrivateFieldIn = function(state, receiver) {
        if (receiver === null || typeof receiver !== "object" && typeof receiver !== "function") throw new TypeError("Cannot use 'in' operator on non-object");
        return typeof state === "function" ? receiver === state : state.has(receiver);
      };
      __addDisposableResource = function(env, value, async) {
        if (value !== null && value !== void 0) {
          if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
          var dispose, inner;
          if (async) {
            if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
            dispose = value[Symbol.asyncDispose];
          }
          if (dispose === void 0) {
            if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
            dispose = value[Symbol.dispose];
            if (async) inner = dispose;
          }
          if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
          if (inner) dispose = function() {
            try {
              inner.call(this);
            } catch (e) {
              return Promise.reject(e);
            }
          };
          env.stack.push({ value, dispose, async });
        } else if (async) {
          env.stack.push({ async: true });
        }
        return value;
      };
      var _SuppressedError = typeof SuppressedError === "function" ? SuppressedError : function(error, suppressed, message) {
        var e = new Error(message);
        return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
      };
      __disposeResources = function(env) {
        function fail(e) {
          env.error = env.hasError ? new _SuppressedError(e, env.error, "An error was suppressed during disposal.") : e;
          env.hasError = true;
        }
        var r, s = 0;
        function next() {
          while (r = env.stack.pop()) {
            try {
              if (!r.async && s === 1) return s = 0, env.stack.push(r), Promise.resolve().then(next);
              if (r.dispose) {
                var result = r.dispose.call(r.value);
                if (r.async) return s |= 2, Promise.resolve(result).then(next, function(e) {
                  fail(e);
                  return next();
                });
              } else s |= 1;
            } catch (e) {
              fail(e);
            }
          }
          if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
          if (env.hasError) throw env.error;
        }
        return next();
      };
      __rewriteRelativeImportExtension = function(path, preserveJsx) {
        if (typeof path === "string" && /^\.\.?\//.test(path)) {
          return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function(m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : d + ext + "." + cm.toLowerCase() + "js";
          });
        }
        return path;
      };
      exporter("__extends", __extends);
      exporter("__assign", __assign);
      exporter("__rest", __rest);
      exporter("__decorate", __decorate);
      exporter("__param", __param);
      exporter("__esDecorate", __esDecorate);
      exporter("__runInitializers", __runInitializers);
      exporter("__propKey", __propKey);
      exporter("__setFunctionName", __setFunctionName);
      exporter("__metadata", __metadata);
      exporter("__awaiter", __awaiter);
      exporter("__generator", __generator);
      exporter("__exportStar", __exportStar);
      exporter("__createBinding", __createBinding);
      exporter("__values", __values);
      exporter("__read", __read);
      exporter("__spread", __spread);
      exporter("__spreadArrays", __spreadArrays);
      exporter("__spreadArray", __spreadArray);
      exporter("__await", __await);
      exporter("__asyncGenerator", __asyncGenerator);
      exporter("__asyncDelegator", __asyncDelegator);
      exporter("__asyncValues", __asyncValues);
      exporter("__makeTemplateObject", __makeTemplateObject);
      exporter("__importStar", __importStar);
      exporter("__importDefault", __importDefault);
      exporter("__classPrivateFieldGet", __classPrivateFieldGet);
      exporter("__classPrivateFieldSet", __classPrivateFieldSet);
      exporter("__classPrivateFieldIn", __classPrivateFieldIn);
      exporter("__addDisposableResource", __addDisposableResource);
      exporter("__disposeResources", __disposeResources);
      exporter("__rewriteRelativeImportExtension", __rewriteRelativeImportExtension);
    });
  }
});

// node_modules/@tybys/wasm-util/lib/cjs/webassembly.js
var require_webassembly = __commonJS({
  "node_modules/@tybys/wasm-util/lib/cjs/webassembly.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2._WebAssembly = void 0;
    var _WebAssembly = typeof WebAssembly !== "undefined" ? WebAssembly : typeof WXWebAssembly !== "undefined" ? WXWebAssembly : void 0;
    exports2._WebAssembly = _WebAssembly;
    if (!_WebAssembly) {
      throw new Error("WebAssembly is not supported in this environment");
    }
  }
});

// node_modules/@tybys/wasm-util/lib/cjs/wasi/util.js
var require_util = __commonJS({
  "node_modules/@tybys/wasm-util/lib/cjs/wasi/util.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.unsharedSlice = exports2.sleepBreakIf = exports2.postMsg = exports2.isMainThread = exports2.wrapInstanceExports = exports2.isPromiseLike = exports2.validateInt32 = exports2.validateUndefined = exports2.validateFunction = exports2.validateString = exports2.validateBoolean = exports2.validateArray = exports2.validateObject = void 0;
    function validateObject(value, name) {
      if (value === null || typeof value !== "object") {
        throw new TypeError(`${name} must be an object. Received ${value === null ? "null" : typeof value}`);
      }
    }
    exports2.validateObject = validateObject;
    function validateArray(value, name) {
      if (!Array.isArray(value)) {
        throw new TypeError(`${name} must be an array. Received ${value === null ? "null" : typeof value}`);
      }
    }
    exports2.validateArray = validateArray;
    function validateBoolean(value, name) {
      if (typeof value !== "boolean") {
        throw new TypeError(`${name} must be a boolean. Received ${value === null ? "null" : typeof value}`);
      }
    }
    exports2.validateBoolean = validateBoolean;
    function validateString(value, name) {
      if (typeof value !== "string") {
        throw new TypeError(`${name} must be a string. Received ${value === null ? "null" : typeof value}`);
      }
    }
    exports2.validateString = validateString;
    function validateFunction(value, name) {
      if (typeof value !== "function") {
        throw new TypeError(`${name} must be a function. Received ${value === null ? "null" : typeof value}`);
      }
    }
    exports2.validateFunction = validateFunction;
    function validateUndefined(value, name) {
      if (value !== void 0) {
        throw new TypeError(`${name} must be undefined. Received ${value === null ? "null" : typeof value}`);
      }
    }
    exports2.validateUndefined = validateUndefined;
    function validateInt32(value, name, min = -2147483648, max = 2147483647) {
      if (typeof value !== "number") {
        throw new TypeError(`${name} must be a number. Received ${value === null ? "null" : typeof value}`);
      }
      if (!Number.isInteger(value)) {
        throw new RangeError(`${name} must be a integer.`);
      }
      if (value < min || value > max) {
        throw new RangeError(`${name} must be >= ${min} && <= ${max}. Received ${value}`);
      }
    }
    exports2.validateInt32 = validateInt32;
    function isPromiseLike(obj) {
      return !!(obj && (typeof obj === "object" || typeof obj === "function") && typeof obj.then === "function");
    }
    exports2.isPromiseLike = isPromiseLike;
    function wrapInstanceExports(exports3, mapFn) {
      const newExports = /* @__PURE__ */ Object.create(null);
      Object.keys(exports3).forEach((name) => {
        const exportValue = exports3[name];
        Object.defineProperty(newExports, name, {
          enumerable: true,
          value: mapFn(exportValue, name)
        });
      });
      return newExports;
    }
    exports2.wrapInstanceExports = wrapInstanceExports;
    var _require = /* @__PURE__ */ function() {
      let nativeRequire;
      if (typeof __webpack_public_path__ !== "undefined") {
        nativeRequire = /* @__PURE__ */ function() {
          return typeof __non_webpack_require__ !== "undefined" ? __non_webpack_require__ : void 0;
        }();
      } else {
        nativeRequire = /* @__PURE__ */ function() {
          return typeof __webpack_public_path__ !== "undefined" ? typeof __non_webpack_require__ !== "undefined" ? __non_webpack_require__ : void 0 : typeof require !== "undefined" ? require : void 0;
        }();
      }
      return nativeRequire;
    }();
    exports2.isMainThread = function() {
      let worker_threads;
      try {
        worker_threads = _require("worker_threads");
      } catch (_) {
      }
      if (!worker_threads) {
        return typeof importScripts === "undefined";
      }
      return worker_threads.isMainThread;
    }();
    exports2.postMsg = exports2.isMainThread ? () => {
    } : /* @__PURE__ */ function() {
      let worker_threads;
      try {
        worker_threads = _require("worker_threads");
      } catch (_) {
      }
      if (!worker_threads) {
        return postMessage;
      }
      return function postMessage2(data) {
        worker_threads.parentPort.postMessage({ data });
      };
    }();
    function sleepBreakIf(delay, breakIf) {
      const start = Date.now();
      const end = start + delay;
      let ret = false;
      while (Date.now() < end) {
        if (breakIf()) {
          ret = true;
          break;
        }
      }
      return ret;
    }
    exports2.sleepBreakIf = sleepBreakIf;
    function unsharedSlice(view, start, end) {
      return typeof SharedArrayBuffer === "function" && view.buffer instanceof SharedArrayBuffer || Object.prototype.toString.call(view.buffer.constructor) === "[object SharedArrayBuffer]" ? view.slice(start, end) : view.subarray(start, end);
    }
    exports2.unsharedSlice = unsharedSlice;
  }
});

// node_modules/@tybys/wasm-util/lib/cjs/asyncify.js
var require_asyncify = __commonJS({
  "node_modules/@tybys/wasm-util/lib/cjs/asyncify.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.Asyncify = void 0;
    var webassembly_1 = require_webassembly();
    var util_1 = require_util();
    var ignoreNames = [
      "asyncify_get_state",
      "asyncify_start_rewind",
      "asyncify_start_unwind",
      "asyncify_stop_rewind",
      "asyncify_stop_unwind"
    ];
    var AsyncifyState;
    (function(AsyncifyState2) {
      AsyncifyState2[AsyncifyState2["NONE"] = 0] = "NONE";
      AsyncifyState2[AsyncifyState2["UNWINDING"] = 1] = "UNWINDING";
      AsyncifyState2[AsyncifyState2["REWINDING"] = 2] = "REWINDING";
    })(AsyncifyState || (AsyncifyState = {}));
    function tryAllocate(instance, wasm64, size, mallocName) {
      if (typeof instance.exports[mallocName] !== "function" || size <= 0) {
        return {
          wasm64,
          dataPtr: 16,
          start: wasm64 ? 32 : 24,
          end: 1024
        };
      }
      const malloc = instance.exports[mallocName];
      const dataPtr = wasm64 ? Number(malloc(BigInt(16) + BigInt(size))) : malloc(8 + size);
      if (dataPtr === 0) {
        throw new Error("Allocate asyncify data failed");
      }
      return wasm64 ? { wasm64, dataPtr, start: dataPtr + 16, end: dataPtr + 16 + size } : { wasm64, dataPtr, start: dataPtr + 8, end: dataPtr + 8 + size };
    }
    var Asyncify = class {
      constructor() {
        this.value = void 0;
        this.exports = void 0;
        this.dataPtr = 0;
      }
      init(memory, instance, options) {
        var _a, _b;
        if (this.exports) {
          throw new Error("Asyncify has been initialized");
        }
        if (!(memory instanceof webassembly_1._WebAssembly.Memory)) {
          throw new TypeError("Require WebAssembly.Memory object");
        }
        const exports3 = instance.exports;
        for (let i = 0; i < ignoreNames.length; ++i) {
          if (typeof exports3[ignoreNames[i]] !== "function") {
            throw new TypeError("Invalid asyncify wasm");
          }
        }
        let address;
        const wasm64 = Boolean(options.wasm64);
        if (!options.tryAllocate) {
          address = {
            wasm64,
            dataPtr: 16,
            start: wasm64 ? 32 : 24,
            end: 1024
          };
        } else {
          if (options.tryAllocate === true) {
            address = tryAllocate(instance, wasm64, 4096, "malloc");
          } else {
            address = tryAllocate(instance, wasm64, (_a = options.tryAllocate.size) !== null && _a !== void 0 ? _a : 4096, (_b = options.tryAllocate.name) !== null && _b !== void 0 ? _b : "malloc");
          }
        }
        this.dataPtr = address.dataPtr;
        if (wasm64) {
          new BigInt64Array(memory.buffer, this.dataPtr).set([BigInt(address.start), BigInt(address.end)]);
        } else {
          new Int32Array(memory.buffer, this.dataPtr).set([address.start, address.end]);
        }
        this.exports = this.wrapExports(exports3, options.wrapExports);
        const asyncifiedInstance = Object.create(webassembly_1._WebAssembly.Instance.prototype);
        Object.defineProperty(asyncifiedInstance, "exports", { value: this.exports });
        return asyncifiedInstance;
      }
      assertState() {
        if (this.exports.asyncify_get_state() !== AsyncifyState.NONE) {
          throw new Error("Asyncify state error");
        }
      }
      wrapImportFunction(f) {
        const _this = this;
        return function() {
          while (_this.exports.asyncify_get_state() === AsyncifyState.REWINDING) {
            _this.exports.asyncify_stop_rewind();
            return _this.value;
          }
          _this.assertState();
          const v = f.apply(this, arguments);
          if (!(0, util_1.isPromiseLike)(v))
            return v;
          _this.exports.asyncify_start_unwind(_this.dataPtr);
          _this.value = v;
        };
      }
      wrapImports(imports) {
        const importObject = {};
        Object.keys(imports).forEach((k) => {
          const mod = imports[k];
          const newModule = {};
          Object.keys(mod).forEach((name) => {
            const importValue = mod[name];
            if (typeof importValue === "function") {
              newModule[name] = this.wrapImportFunction(importValue);
            } else {
              newModule[name] = importValue;
            }
          });
          importObject[k] = newModule;
        });
        return importObject;
      }
      wrapExportFunction(f) {
        const _this = this;
        return async function() {
          _this.assertState();
          let ret = f.apply(this, arguments);
          while (_this.exports.asyncify_get_state() === AsyncifyState.UNWINDING) {
            _this.exports.asyncify_stop_unwind();
            _this.value = await _this.value;
            _this.assertState();
            _this.exports.asyncify_start_rewind(_this.dataPtr);
            ret = f.call(this);
          }
          _this.assertState();
          return ret;
        };
      }
      wrapExports(exports3, needWrap) {
        return (0, util_1.wrapInstanceExports)(exports3, (exportValue, name) => {
          let ignore = ignoreNames.indexOf(name) !== -1 || typeof exportValue !== "function";
          if (Array.isArray(needWrap)) {
            ignore = ignore || needWrap.indexOf(name) === -1;
          }
          return ignore ? exportValue : this.wrapExportFunction(exportValue);
        });
      }
    };
    exports2.Asyncify = Asyncify;
  }
});

// node_modules/@tybys/wasm-util/lib/cjs/load.js
var require_load = __commonJS({
  "node_modules/@tybys/wasm-util/lib/cjs/load.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.asyncifyLoadSync = exports2.loadSync = exports2.asyncifyLoad = exports2.load = void 0;
    var webassembly_1 = require_webassembly();
    var asyncify_1 = require_asyncify();
    function validateImports(imports) {
      if (imports && typeof imports !== "object") {
        throw new TypeError("imports must be an object or undefined");
      }
    }
    function fetchWasm(urlOrBuffer, imports) {
      if (typeof wx !== "undefined" && typeof __wxConfig !== "undefined") {
        return webassembly_1._WebAssembly.instantiate(urlOrBuffer, imports);
      }
      return fetch(urlOrBuffer).then((response) => response.arrayBuffer()).then((buffer) => webassembly_1._WebAssembly.instantiate(buffer, imports));
    }
    function load(wasmInput, imports) {
      validateImports(imports);
      imports = imports !== null && imports !== void 0 ? imports : {};
      let source;
      if (wasmInput instanceof ArrayBuffer || ArrayBuffer.isView(wasmInput)) {
        return webassembly_1._WebAssembly.instantiate(wasmInput, imports);
      }
      if (wasmInput instanceof webassembly_1._WebAssembly.Module) {
        return webassembly_1._WebAssembly.instantiate(wasmInput, imports).then((instance) => {
          return { instance, module: wasmInput };
        });
      }
      if (typeof wasmInput !== "string" && !(wasmInput instanceof URL)) {
        throw new TypeError("Invalid source");
      }
      if (typeof webassembly_1._WebAssembly.instantiateStreaming === "function") {
        let responsePromise;
        try {
          responsePromise = fetch(wasmInput);
          source = webassembly_1._WebAssembly.instantiateStreaming(responsePromise, imports).catch(() => {
            return fetchWasm(wasmInput, imports);
          });
        } catch (_) {
          source = fetchWasm(wasmInput, imports);
        }
      } else {
        source = fetchWasm(wasmInput, imports);
      }
      return source;
    }
    exports2.load = load;
    function asyncifyLoad(asyncify, urlOrBuffer, imports) {
      validateImports(imports);
      imports = imports !== null && imports !== void 0 ? imports : {};
      const asyncifyHelper = new asyncify_1.Asyncify();
      imports = asyncifyHelper.wrapImports(imports);
      return load(urlOrBuffer, imports).then((source) => {
        var _a;
        const memory = source.instance.exports.memory || ((_a = imports.env) === null || _a === void 0 ? void 0 : _a.memory);
        return { module: source.module, instance: asyncifyHelper.init(memory, source.instance, asyncify) };
      });
    }
    exports2.asyncifyLoad = asyncifyLoad;
    function loadSync(wasmInput, imports) {
      validateImports(imports);
      imports = imports !== null && imports !== void 0 ? imports : {};
      let module3;
      if (wasmInput instanceof ArrayBuffer || ArrayBuffer.isView(wasmInput)) {
        module3 = new webassembly_1._WebAssembly.Module(wasmInput);
      } else if (wasmInput instanceof WebAssembly.Module) {
        module3 = wasmInput;
      } else {
        throw new TypeError("Invalid source");
      }
      const instance = new webassembly_1._WebAssembly.Instance(module3, imports);
      const source = { instance, module: module3 };
      return source;
    }
    exports2.loadSync = loadSync;
    function asyncifyLoadSync(asyncify, buffer, imports) {
      var _a;
      validateImports(imports);
      imports = imports !== null && imports !== void 0 ? imports : {};
      const asyncifyHelper = new asyncify_1.Asyncify();
      imports = asyncifyHelper.wrapImports(imports);
      const source = loadSync(buffer, imports);
      const memory = source.instance.exports.memory || ((_a = imports.env) === null || _a === void 0 ? void 0 : _a.memory);
      return { module: source.module, instance: asyncifyHelper.init(memory, source.instance, asyncify) };
    }
    exports2.asyncifyLoadSync = asyncifyLoadSync;
  }
});

// node_modules/@tybys/wasm-util/lib/cjs/wasi/path.js
var require_path = __commonJS({
  "node_modules/@tybys/wasm-util/lib/cjs/wasi/path.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.relative = exports2.resolve = void 0;
    var util_1 = require_util();
    var CHAR_DOT = 46;
    var CHAR_FORWARD_SLASH = 47;
    var CHAR_BACKWARD_SLASH = 92;
    var CHAR_COLON = 58;
    var CHAR_UPPERCASE_A = 65;
    var CHAR_UPPERCASE_Z = 90;
    var CHAR_LOWERCASE_A = 97;
    var CHAR_LOWERCASE_Z = 122;
    function isPathSeparatorWin(code) {
      return code === CHAR_FORWARD_SLASH || code === CHAR_BACKWARD_SLASH;
    }
    function isWindowsDeviceRoot(code) {
      return code >= CHAR_UPPERCASE_A && code <= CHAR_UPPERCASE_Z || code >= CHAR_LOWERCASE_A && code <= CHAR_LOWERCASE_Z;
    }
    var _isWin32 = typeof process !== "undefined" && process.platform === "win32";
    function resolveWin32(args) {
      let resolvedDevice = "";
      let resolvedTail = "";
      let resolvedAbsolute = false;
      for (let i = args.length - 1; i >= -1; i--) {
        let path;
        if (i >= 0) {
          path = args[i];
          (0, util_1.validateString)(path, "path");
          if (path.length === 0)
            continue;
        } else if (resolvedDevice.length === 0) {
          path = typeof process !== "undefined" && typeof process.cwd === "function" ? process.cwd() : "";
        } else {
          const envKey = `=${resolvedDevice}`;
          const env = typeof process !== "undefined" ? process.env : void 0;
          path = env && typeof env[envKey] === "string" ? env[envKey] : typeof process !== "undefined" && typeof process.cwd === "function" ? process.cwd() : "";
          if (path === void 0 || path.slice(0, 2).toLowerCase() !== resolvedDevice.toLowerCase() && path.charCodeAt(2) === CHAR_BACKWARD_SLASH) {
            path = `${resolvedDevice}\\`;
          }
        }
        const len = path.length;
        let rootEnd = 0;
        let device = "";
        let isAbsolute = false;
        const code = path.charCodeAt(0);
        if (len === 1) {
          if (isPathSeparatorWin(code)) {
            rootEnd = 1;
            isAbsolute = true;
          }
        } else if (isPathSeparatorWin(code)) {
          isAbsolute = true;
          if (isPathSeparatorWin(path.charCodeAt(1))) {
            let j = 2;
            let last = j;
            while (j < len && !isPathSeparatorWin(path.charCodeAt(j)))
              j++;
            if (j < len && j !== last) {
              const firstPart = path.slice(last, j);
              last = j;
              while (j < len && isPathSeparatorWin(path.charCodeAt(j)))
                j++;
              if (j < len && j !== last) {
                last = j;
                while (j < len && !isPathSeparatorWin(path.charCodeAt(j)))
                  j++;
                if (j === len || j !== last) {
                  device = `\\\\${firstPart}\\${path.slice(last, j)}`;
                  rootEnd = j;
                }
              }
            }
          } else {
            rootEnd = 1;
          }
        } else if (isWindowsDeviceRoot(code) && path.charCodeAt(1) === CHAR_COLON) {
          device = path.slice(0, 2);
          rootEnd = 2;
          if (len > 2 && isPathSeparatorWin(path.charCodeAt(2))) {
            isAbsolute = true;
            rootEnd = 3;
          }
        }
        if (device.length > 0) {
          if (resolvedDevice.length > 0) {
            if (device.toLowerCase() !== resolvedDevice.toLowerCase())
              continue;
          } else {
            resolvedDevice = device;
          }
        }
        if (resolvedAbsolute) {
          if (resolvedDevice.length > 0)
            break;
        } else {
          resolvedTail = `${path.slice(rootEnd)}\\${resolvedTail}`;
          resolvedAbsolute = isAbsolute;
          if (isAbsolute && resolvedDevice.length > 0)
            break;
        }
      }
      resolvedTail = normalizeString(resolvedTail, !resolvedAbsolute, "\\", isPathSeparatorWin);
      return resolvedDevice + (resolvedAbsolute ? "\\" : "") + resolvedTail || ".";
    }
    function isPosixPathSeparator(code) {
      return code === CHAR_FORWARD_SLASH;
    }
    function normalizeString(path, allowAboveRoot, separator, isPathSeparator) {
      let res = "";
      let lastSegmentLength = 0;
      let lastSlash = -1;
      let dots = 0;
      let code = 0;
      for (let i = 0; i <= path.length; ++i) {
        if (i < path.length) {
          code = path.charCodeAt(i);
        } else if (isPathSeparator(code)) {
          break;
        } else {
          code = CHAR_FORWARD_SLASH;
        }
        if (isPathSeparator(code)) {
          if (lastSlash === i - 1 || dots === 1) {
          } else if (dots === 2) {
            if (res.length < 2 || lastSegmentLength !== 2 || res.charCodeAt(res.length - 1) !== CHAR_DOT || res.charCodeAt(res.length - 2) !== CHAR_DOT) {
              if (res.length > 2) {
                const lastSlashIndex = res.indexOf(separator);
                if (lastSlashIndex === -1) {
                  res = "";
                  lastSegmentLength = 0;
                } else {
                  res = res.slice(0, lastSlashIndex);
                  lastSegmentLength = res.length - 1 - res.indexOf(separator);
                }
                lastSlash = i;
                dots = 0;
                continue;
              } else if (res.length !== 0) {
                res = "";
                lastSegmentLength = 0;
                lastSlash = i;
                dots = 0;
                continue;
              }
            }
            if (allowAboveRoot) {
              res += res.length > 0 ? `${separator}..` : "..";
              lastSegmentLength = 2;
            }
          } else {
            if (res.length > 0) {
              res += `${separator}${path.slice(lastSlash + 1, i)}`;
            } else {
              res = path.slice(lastSlash + 1, i);
            }
            lastSegmentLength = i - lastSlash - 1;
          }
          lastSlash = i;
          dots = 0;
        } else if (code === CHAR_DOT && dots !== -1) {
          ++dots;
        } else {
          dots = -1;
        }
      }
      return res;
    }
    function resolve(...args) {
      if (_isWin32)
        return resolveWin32(args);
      let resolvedPath = "";
      let resolvedAbsolute = false;
      for (let i = args.length - 1; i >= -1 && !resolvedAbsolute; i--) {
        const path = i >= 0 ? args[i] : "/";
        (0, util_1.validateString)(path, "path");
        if (path.length === 0) {
          continue;
        }
        resolvedPath = `${path}/${resolvedPath}`;
        resolvedAbsolute = path.charCodeAt(0) === CHAR_FORWARD_SLASH;
      }
      resolvedPath = normalizeString(resolvedPath, !resolvedAbsolute, "/", isPosixPathSeparator);
      if (resolvedAbsolute) {
        return `/${resolvedPath}`;
      }
      return resolvedPath.length > 0 ? resolvedPath : ".";
    }
    exports2.resolve = resolve;
    function relative(from, to) {
      (0, util_1.validateString)(from, "from");
      (0, util_1.validateString)(to, "to");
      if (from === to)
        return "";
      from = resolve(from);
      to = resolve(to);
      if (from === to)
        return "";
      const fromStart = 1;
      const fromEnd = from.length;
      const fromLen = fromEnd - fromStart;
      const toStart = 1;
      const toLen = to.length - toStart;
      const length = fromLen < toLen ? fromLen : toLen;
      let lastCommonSep = -1;
      let i = 0;
      for (; i < length; i++) {
        const fromCode = from.charCodeAt(fromStart + i);
        if (fromCode !== to.charCodeAt(toStart + i)) {
          break;
        } else if (fromCode === CHAR_FORWARD_SLASH) {
          lastCommonSep = i;
        }
      }
      if (i === length) {
        if (toLen > length) {
          if (to.charCodeAt(toStart + i) === CHAR_FORWARD_SLASH) {
            return to.slice(toStart + i + 1);
          }
          if (i === 0) {
            return to.slice(toStart + i);
          }
        } else if (fromLen > length) {
          if (from.charCodeAt(fromStart + i) === CHAR_FORWARD_SLASH) {
            lastCommonSep = i;
          } else if (i === 0) {
            lastCommonSep = 0;
          }
        }
      }
      let out = "";
      for (i = fromStart + lastCommonSep + 1; i <= fromEnd; ++i) {
        if (i === fromEnd || from.charCodeAt(i) === CHAR_FORWARD_SLASH) {
          out += out.length === 0 ? ".." : "/..";
        }
      }
      return `${out}${to.slice(toStart + lastCommonSep)}`;
    }
    exports2.relative = relative;
  }
});

// node_modules/@tybys/wasm-util/lib/cjs/wasi/types.js
var require_types = __commonJS({
  "node_modules/@tybys/wasm-util/lib/cjs/wasi/types.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.WasiSubclockflags = exports2.WasiEventType = exports2.WasiFstFlag = exports2.WasiClockid = exports2.WasiFdFlag = exports2.WasiFileControlFlag = exports2.FileControlFlag = exports2.WasiWhence = exports2.WasiRights = exports2.WasiFileType = exports2.WasiErrno = void 0;
    var WasiErrno;
    (function(WasiErrno2) {
      WasiErrno2[WasiErrno2["ESUCCESS"] = 0] = "ESUCCESS";
      WasiErrno2[WasiErrno2["E2BIG"] = 1] = "E2BIG";
      WasiErrno2[WasiErrno2["EACCES"] = 2] = "EACCES";
      WasiErrno2[WasiErrno2["EADDRINUSE"] = 3] = "EADDRINUSE";
      WasiErrno2[WasiErrno2["EADDRNOTAVAIL"] = 4] = "EADDRNOTAVAIL";
      WasiErrno2[WasiErrno2["EAFNOSUPPORT"] = 5] = "EAFNOSUPPORT";
      WasiErrno2[WasiErrno2["EAGAIN"] = 6] = "EAGAIN";
      WasiErrno2[WasiErrno2["EALREADY"] = 7] = "EALREADY";
      WasiErrno2[WasiErrno2["EBADF"] = 8] = "EBADF";
      WasiErrno2[WasiErrno2["EBADMSG"] = 9] = "EBADMSG";
      WasiErrno2[WasiErrno2["EBUSY"] = 10] = "EBUSY";
      WasiErrno2[WasiErrno2["ECANCELED"] = 11] = "ECANCELED";
      WasiErrno2[WasiErrno2["ECHILD"] = 12] = "ECHILD";
      WasiErrno2[WasiErrno2["ECONNABORTED"] = 13] = "ECONNABORTED";
      WasiErrno2[WasiErrno2["ECONNREFUSED"] = 14] = "ECONNREFUSED";
      WasiErrno2[WasiErrno2["ECONNRESET"] = 15] = "ECONNRESET";
      WasiErrno2[WasiErrno2["EDEADLK"] = 16] = "EDEADLK";
      WasiErrno2[WasiErrno2["EDESTADDRREQ"] = 17] = "EDESTADDRREQ";
      WasiErrno2[WasiErrno2["EDOM"] = 18] = "EDOM";
      WasiErrno2[WasiErrno2["EDQUOT"] = 19] = "EDQUOT";
      WasiErrno2[WasiErrno2["EEXIST"] = 20] = "EEXIST";
      WasiErrno2[WasiErrno2["EFAULT"] = 21] = "EFAULT";
      WasiErrno2[WasiErrno2["EFBIG"] = 22] = "EFBIG";
      WasiErrno2[WasiErrno2["EHOSTUNREACH"] = 23] = "EHOSTUNREACH";
      WasiErrno2[WasiErrno2["EIDRM"] = 24] = "EIDRM";
      WasiErrno2[WasiErrno2["EILSEQ"] = 25] = "EILSEQ";
      WasiErrno2[WasiErrno2["EINPROGRESS"] = 26] = "EINPROGRESS";
      WasiErrno2[WasiErrno2["EINTR"] = 27] = "EINTR";
      WasiErrno2[WasiErrno2["EINVAL"] = 28] = "EINVAL";
      WasiErrno2[WasiErrno2["EIO"] = 29] = "EIO";
      WasiErrno2[WasiErrno2["EISCONN"] = 30] = "EISCONN";
      WasiErrno2[WasiErrno2["EISDIR"] = 31] = "EISDIR";
      WasiErrno2[WasiErrno2["ELOOP"] = 32] = "ELOOP";
      WasiErrno2[WasiErrno2["EMFILE"] = 33] = "EMFILE";
      WasiErrno2[WasiErrno2["EMLINK"] = 34] = "EMLINK";
      WasiErrno2[WasiErrno2["EMSGSIZE"] = 35] = "EMSGSIZE";
      WasiErrno2[WasiErrno2["EMULTIHOP"] = 36] = "EMULTIHOP";
      WasiErrno2[WasiErrno2["ENAMETOOLONG"] = 37] = "ENAMETOOLONG";
      WasiErrno2[WasiErrno2["ENETDOWN"] = 38] = "ENETDOWN";
      WasiErrno2[WasiErrno2["ENETRESET"] = 39] = "ENETRESET";
      WasiErrno2[WasiErrno2["ENETUNREACH"] = 40] = "ENETUNREACH";
      WasiErrno2[WasiErrno2["ENFILE"] = 41] = "ENFILE";
      WasiErrno2[WasiErrno2["ENOBUFS"] = 42] = "ENOBUFS";
      WasiErrno2[WasiErrno2["ENODEV"] = 43] = "ENODEV";
      WasiErrno2[WasiErrno2["ENOENT"] = 44] = "ENOENT";
      WasiErrno2[WasiErrno2["ENOEXEC"] = 45] = "ENOEXEC";
      WasiErrno2[WasiErrno2["ENOLCK"] = 46] = "ENOLCK";
      WasiErrno2[WasiErrno2["ENOLINK"] = 47] = "ENOLINK";
      WasiErrno2[WasiErrno2["ENOMEM"] = 48] = "ENOMEM";
      WasiErrno2[WasiErrno2["ENOMSG"] = 49] = "ENOMSG";
      WasiErrno2[WasiErrno2["ENOPROTOOPT"] = 50] = "ENOPROTOOPT";
      WasiErrno2[WasiErrno2["ENOSPC"] = 51] = "ENOSPC";
      WasiErrno2[WasiErrno2["ENOSYS"] = 52] = "ENOSYS";
      WasiErrno2[WasiErrno2["ENOTCONN"] = 53] = "ENOTCONN";
      WasiErrno2[WasiErrno2["ENOTDIR"] = 54] = "ENOTDIR";
      WasiErrno2[WasiErrno2["ENOTEMPTY"] = 55] = "ENOTEMPTY";
      WasiErrno2[WasiErrno2["ENOTRECOVERABLE"] = 56] = "ENOTRECOVERABLE";
      WasiErrno2[WasiErrno2["ENOTSOCK"] = 57] = "ENOTSOCK";
      WasiErrno2[WasiErrno2["ENOTSUP"] = 58] = "ENOTSUP";
      WasiErrno2[WasiErrno2["ENOTTY"] = 59] = "ENOTTY";
      WasiErrno2[WasiErrno2["ENXIO"] = 60] = "ENXIO";
      WasiErrno2[WasiErrno2["EOVERFLOW"] = 61] = "EOVERFLOW";
      WasiErrno2[WasiErrno2["EOWNERDEAD"] = 62] = "EOWNERDEAD";
      WasiErrno2[WasiErrno2["EPERM"] = 63] = "EPERM";
      WasiErrno2[WasiErrno2["EPIPE"] = 64] = "EPIPE";
      WasiErrno2[WasiErrno2["EPROTO"] = 65] = "EPROTO";
      WasiErrno2[WasiErrno2["EPROTONOSUPPORT"] = 66] = "EPROTONOSUPPORT";
      WasiErrno2[WasiErrno2["EPROTOTYPE"] = 67] = "EPROTOTYPE";
      WasiErrno2[WasiErrno2["ERANGE"] = 68] = "ERANGE";
      WasiErrno2[WasiErrno2["EROFS"] = 69] = "EROFS";
      WasiErrno2[WasiErrno2["ESPIPE"] = 70] = "ESPIPE";
      WasiErrno2[WasiErrno2["ESRCH"] = 71] = "ESRCH";
      WasiErrno2[WasiErrno2["ESTALE"] = 72] = "ESTALE";
      WasiErrno2[WasiErrno2["ETIMEDOUT"] = 73] = "ETIMEDOUT";
      WasiErrno2[WasiErrno2["ETXTBSY"] = 74] = "ETXTBSY";
      WasiErrno2[WasiErrno2["EXDEV"] = 75] = "EXDEV";
      WasiErrno2[WasiErrno2["ENOTCAPABLE"] = 76] = "ENOTCAPABLE";
    })(WasiErrno = exports2.WasiErrno || (exports2.WasiErrno = {}));
    var WasiFileType;
    (function(WasiFileType2) {
      WasiFileType2[WasiFileType2["UNKNOWN"] = 0] = "UNKNOWN";
      WasiFileType2[WasiFileType2["BLOCK_DEVICE"] = 1] = "BLOCK_DEVICE";
      WasiFileType2[WasiFileType2["CHARACTER_DEVICE"] = 2] = "CHARACTER_DEVICE";
      WasiFileType2[WasiFileType2["DIRECTORY"] = 3] = "DIRECTORY";
      WasiFileType2[WasiFileType2["REGULAR_FILE"] = 4] = "REGULAR_FILE";
      WasiFileType2[WasiFileType2["SOCKET_DGRAM"] = 5] = "SOCKET_DGRAM";
      WasiFileType2[WasiFileType2["SOCKET_STREAM"] = 6] = "SOCKET_STREAM";
      WasiFileType2[WasiFileType2["SYMBOLIC_LINK"] = 7] = "SYMBOLIC_LINK";
    })(WasiFileType = exports2.WasiFileType || (exports2.WasiFileType = {}));
    var FD_DATASYNC = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(0);
    var FD_READ = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(1);
    var FD_SEEK = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(2);
    var FD_FDSTAT_SET_FLAGS = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(3);
    var FD_SYNC = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(4);
    var FD_TELL = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(5);
    var FD_WRITE = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(6);
    var FD_ADVISE = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(7);
    var FD_ALLOCATE = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(8);
    var PATH_CREATE_DIRECTORY = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(9);
    var PATH_CREATE_FILE = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(10);
    var PATH_LINK_SOURCE = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(11);
    var PATH_LINK_TARGET = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(12);
    var PATH_OPEN = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(13);
    var FD_READDIR = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(14);
    var PATH_READLINK = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(15);
    var PATH_RENAME_SOURCE = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(16);
    var PATH_RENAME_TARGET = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(17);
    var PATH_FILESTAT_GET = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(18);
    var PATH_FILESTAT_SET_SIZE = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(19);
    var PATH_FILESTAT_SET_TIMES = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(20);
    var FD_FILESTAT_GET = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(21);
    var FD_FILESTAT_SET_SIZE = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(22);
    var FD_FILESTAT_SET_TIMES = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(23);
    var PATH_SYMLINK = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(24);
    var PATH_REMOVE_DIRECTORY = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(25);
    var PATH_UNLINK_FILE = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(26);
    var POLL_FD_READWRITE = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(27);
    var SOCK_SHUTDOWN = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(28);
    var SOCK_ACCEPT = /* @__PURE__ */ BigInt(1) << /* @__PURE__ */ BigInt(29);
    exports2.WasiRights = {
      FD_DATASYNC,
      FD_READ,
      FD_SEEK,
      FD_FDSTAT_SET_FLAGS,
      FD_SYNC,
      FD_TELL,
      FD_WRITE,
      FD_ADVISE,
      FD_ALLOCATE,
      PATH_CREATE_DIRECTORY,
      PATH_CREATE_FILE,
      PATH_LINK_SOURCE,
      PATH_LINK_TARGET,
      PATH_OPEN,
      FD_READDIR,
      PATH_READLINK,
      PATH_RENAME_SOURCE,
      PATH_RENAME_TARGET,
      PATH_FILESTAT_GET,
      PATH_FILESTAT_SET_SIZE,
      PATH_FILESTAT_SET_TIMES,
      FD_FILESTAT_GET,
      FD_FILESTAT_SET_SIZE,
      FD_FILESTAT_SET_TIMES,
      PATH_SYMLINK,
      PATH_REMOVE_DIRECTORY,
      PATH_UNLINK_FILE,
      POLL_FD_READWRITE,
      SOCK_SHUTDOWN,
      SOCK_ACCEPT
    };
    var WasiWhence;
    (function(WasiWhence2) {
      WasiWhence2[WasiWhence2["SET"] = 0] = "SET";
      WasiWhence2[WasiWhence2["CUR"] = 1] = "CUR";
      WasiWhence2[WasiWhence2["END"] = 2] = "END";
    })(WasiWhence = exports2.WasiWhence || (exports2.WasiWhence = {}));
    var FileControlFlag;
    (function(FileControlFlag2) {
      FileControlFlag2[FileControlFlag2["O_RDONLY"] = 0] = "O_RDONLY";
      FileControlFlag2[FileControlFlag2["O_WRONLY"] = 1] = "O_WRONLY";
      FileControlFlag2[FileControlFlag2["O_RDWR"] = 2] = "O_RDWR";
      FileControlFlag2[FileControlFlag2["O_CREAT"] = 64] = "O_CREAT";
      FileControlFlag2[FileControlFlag2["O_EXCL"] = 128] = "O_EXCL";
      FileControlFlag2[FileControlFlag2["O_NOCTTY"] = 256] = "O_NOCTTY";
      FileControlFlag2[FileControlFlag2["O_TRUNC"] = 512] = "O_TRUNC";
      FileControlFlag2[FileControlFlag2["O_APPEND"] = 1024] = "O_APPEND";
      FileControlFlag2[FileControlFlag2["O_DIRECTORY"] = 65536] = "O_DIRECTORY";
      FileControlFlag2[FileControlFlag2["O_NOATIME"] = 262144] = "O_NOATIME";
      FileControlFlag2[FileControlFlag2["O_NOFOLLOW"] = 131072] = "O_NOFOLLOW";
      FileControlFlag2[FileControlFlag2["O_SYNC"] = 1052672] = "O_SYNC";
      FileControlFlag2[FileControlFlag2["O_DIRECT"] = 16384] = "O_DIRECT";
      FileControlFlag2[FileControlFlag2["O_NONBLOCK"] = 2048] = "O_NONBLOCK";
    })(FileControlFlag = exports2.FileControlFlag || (exports2.FileControlFlag = {}));
    var WasiFileControlFlag;
    (function(WasiFileControlFlag2) {
      WasiFileControlFlag2[WasiFileControlFlag2["O_CREAT"] = 1] = "O_CREAT";
      WasiFileControlFlag2[WasiFileControlFlag2["O_DIRECTORY"] = 2] = "O_DIRECTORY";
      WasiFileControlFlag2[WasiFileControlFlag2["O_EXCL"] = 4] = "O_EXCL";
      WasiFileControlFlag2[WasiFileControlFlag2["O_TRUNC"] = 8] = "O_TRUNC";
    })(WasiFileControlFlag = exports2.WasiFileControlFlag || (exports2.WasiFileControlFlag = {}));
    var WasiFdFlag;
    (function(WasiFdFlag2) {
      WasiFdFlag2[WasiFdFlag2["APPEND"] = 1] = "APPEND";
      WasiFdFlag2[WasiFdFlag2["DSYNC"] = 2] = "DSYNC";
      WasiFdFlag2[WasiFdFlag2["NONBLOCK"] = 4] = "NONBLOCK";
      WasiFdFlag2[WasiFdFlag2["RSYNC"] = 8] = "RSYNC";
      WasiFdFlag2[WasiFdFlag2["SYNC"] = 16] = "SYNC";
    })(WasiFdFlag = exports2.WasiFdFlag || (exports2.WasiFdFlag = {}));
    var WasiClockid;
    (function(WasiClockid2) {
      WasiClockid2[WasiClockid2["REALTIME"] = 0] = "REALTIME";
      WasiClockid2[WasiClockid2["MONOTONIC"] = 1] = "MONOTONIC";
      WasiClockid2[WasiClockid2["PROCESS_CPUTIME_ID"] = 2] = "PROCESS_CPUTIME_ID";
      WasiClockid2[WasiClockid2["THREAD_CPUTIME_ID"] = 3] = "THREAD_CPUTIME_ID";
    })(WasiClockid = exports2.WasiClockid || (exports2.WasiClockid = {}));
    var WasiFstFlag;
    (function(WasiFstFlag2) {
      WasiFstFlag2[WasiFstFlag2["SET_ATIM"] = 1] = "SET_ATIM";
      WasiFstFlag2[WasiFstFlag2["SET_ATIM_NOW"] = 2] = "SET_ATIM_NOW";
      WasiFstFlag2[WasiFstFlag2["SET_MTIM"] = 4] = "SET_MTIM";
      WasiFstFlag2[WasiFstFlag2["SET_MTIM_NOW"] = 8] = "SET_MTIM_NOW";
    })(WasiFstFlag = exports2.WasiFstFlag || (exports2.WasiFstFlag = {}));
    var WasiEventType;
    (function(WasiEventType2) {
      WasiEventType2[WasiEventType2["CLOCK"] = 0] = "CLOCK";
      WasiEventType2[WasiEventType2["FD_READ"] = 1] = "FD_READ";
      WasiEventType2[WasiEventType2["FD_WRITE"] = 2] = "FD_WRITE";
    })(WasiEventType = exports2.WasiEventType || (exports2.WasiEventType = {}));
    var WasiSubclockflags;
    (function(WasiSubclockflags2) {
      WasiSubclockflags2[WasiSubclockflags2["ABSTIME"] = 1] = "ABSTIME";
    })(WasiSubclockflags = exports2.WasiSubclockflags || (exports2.WasiSubclockflags = {}));
  }
});

// node_modules/@tybys/wasm-util/lib/cjs/wasi/error.js
var require_error = __commonJS({
  "node_modules/@tybys/wasm-util/lib/cjs/wasi/error.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.WasiError = exports2.strerror = void 0;
    var types_1 = require_types();
    function strerror(errno) {
      switch (errno) {
        case types_1.WasiErrno.ESUCCESS:
          return "Success";
        case types_1.WasiErrno.E2BIG:
          return "Argument list too long";
        case types_1.WasiErrno.EACCES:
          return "Permission denied";
        case types_1.WasiErrno.EADDRINUSE:
          return "Address in use";
        case types_1.WasiErrno.EADDRNOTAVAIL:
          return "Address not available";
        case types_1.WasiErrno.EAFNOSUPPORT:
          return "Address family not supported by protocol";
        case types_1.WasiErrno.EAGAIN:
          return "Resource temporarily unavailable";
        case types_1.WasiErrno.EALREADY:
          return "Operation already in progress";
        case types_1.WasiErrno.EBADF:
          return "Bad file descriptor";
        case types_1.WasiErrno.EBADMSG:
          return "Bad message";
        case types_1.WasiErrno.EBUSY:
          return "Resource busy";
        case types_1.WasiErrno.ECANCELED:
          return "Operation canceled";
        case types_1.WasiErrno.ECHILD:
          return "No child process";
        case types_1.WasiErrno.ECONNABORTED:
          return "Connection aborted";
        case types_1.WasiErrno.ECONNREFUSED:
          return "Connection refused";
        case types_1.WasiErrno.ECONNRESET:
          return "Connection reset by peer";
        case types_1.WasiErrno.EDEADLK:
          return "Resource deadlock would occur";
        case types_1.WasiErrno.EDESTADDRREQ:
          return "Destination address required";
        case types_1.WasiErrno.EDOM:
          return "Domain error";
        case types_1.WasiErrno.EDQUOT:
          return "Quota exceeded";
        case types_1.WasiErrno.EEXIST:
          return "File exists";
        case types_1.WasiErrno.EFAULT:
          return "Bad address";
        case types_1.WasiErrno.EFBIG:
          return "File too large";
        case types_1.WasiErrno.EHOSTUNREACH:
          return "Host is unreachable";
        case types_1.WasiErrno.EIDRM:
          return "Identifier removed";
        case types_1.WasiErrno.EILSEQ:
          return "Illegal byte sequence";
        case types_1.WasiErrno.EINPROGRESS:
          return "Operation in progress";
        case types_1.WasiErrno.EINTR:
          return "Interrupted system call";
        case types_1.WasiErrno.EINVAL:
          return "Invalid argument";
        case types_1.WasiErrno.EIO:
          return "I/O error";
        case types_1.WasiErrno.EISCONN:
          return "Socket is connected";
        case types_1.WasiErrno.EISDIR:
          return "Is a directory";
        case types_1.WasiErrno.ELOOP:
          return "Symbolic link loop";
        case types_1.WasiErrno.EMFILE:
          return "No file descriptors available";
        case types_1.WasiErrno.EMLINK:
          return "Too many links";
        case types_1.WasiErrno.EMSGSIZE:
          return "Message too large";
        case types_1.WasiErrno.EMULTIHOP:
          return "Multihop attempted";
        case types_1.WasiErrno.ENAMETOOLONG:
          return "Filename too long";
        case types_1.WasiErrno.ENETDOWN:
          return "Network is down";
        case types_1.WasiErrno.ENETRESET:
          return "Connection reset by network";
        case types_1.WasiErrno.ENETUNREACH:
          return "Network unreachable";
        case types_1.WasiErrno.ENFILE:
          return "Too many files open in system";
        case types_1.WasiErrno.ENOBUFS:
          return "No buffer space available";
        case types_1.WasiErrno.ENODEV:
          return "No such device";
        case types_1.WasiErrno.ENOENT:
          return "No such file or directory";
        case types_1.WasiErrno.ENOEXEC:
          return "Exec format error";
        case types_1.WasiErrno.ENOLCK:
          return "No locks available";
        case types_1.WasiErrno.ENOLINK:
          return "Link has been severed";
        case types_1.WasiErrno.ENOMEM:
          return "Out of memory";
        case types_1.WasiErrno.ENOMSG:
          return "No message of the desired type";
        case types_1.WasiErrno.ENOPROTOOPT:
          return "Protocol not available";
        case types_1.WasiErrno.ENOSPC:
          return "No space left on device";
        case types_1.WasiErrno.ENOSYS:
          return "Function not implemented";
        case types_1.WasiErrno.ENOTCONN:
          return "Socket not connected";
        case types_1.WasiErrno.ENOTDIR:
          return "Not a directory";
        case types_1.WasiErrno.ENOTEMPTY:
          return "Directory not empty";
        case types_1.WasiErrno.ENOTRECOVERABLE:
          return "State not recoverable";
        case types_1.WasiErrno.ENOTSOCK:
          return "Not a socket";
        case types_1.WasiErrno.ENOTSUP:
          return "Not supported";
        case types_1.WasiErrno.ENOTTY:
          return "Not a tty";
        case types_1.WasiErrno.ENXIO:
          return "No such device or address";
        case types_1.WasiErrno.EOVERFLOW:
          return "Value too large for data type";
        case types_1.WasiErrno.EOWNERDEAD:
          return "Previous owner died";
        case types_1.WasiErrno.EPERM:
          return "Operation not permitted";
        case types_1.WasiErrno.EPIPE:
          return "Broken pipe";
        case types_1.WasiErrno.EPROTO:
          return "Protocol error";
        case types_1.WasiErrno.EPROTONOSUPPORT:
          return "Protocol not supported";
        case types_1.WasiErrno.EPROTOTYPE:
          return "Protocol wrong type for socket";
        case types_1.WasiErrno.ERANGE:
          return "Result not representable";
        case types_1.WasiErrno.EROFS:
          return "Read-only file system";
        case types_1.WasiErrno.ESPIPE:
          return "Invalid seek";
        case types_1.WasiErrno.ESRCH:
          return "No such process";
        case types_1.WasiErrno.ESTALE:
          return "Stale file handle";
        case types_1.WasiErrno.ETIMEDOUT:
          return "Operation timed out";
        case types_1.WasiErrno.ETXTBSY:
          return "Text file busy";
        case types_1.WasiErrno.EXDEV:
          return "Cross-device link";
        case types_1.WasiErrno.ENOTCAPABLE:
          return "Capabilities insufficient";
        default:
          return "Unknown error";
      }
    }
    exports2.strerror = strerror;
    var WasiError = class extends Error {
      constructor(message, errno) {
        super(message);
        this.errno = errno;
      }
      getErrorMessage() {
        return strerror(this.errno);
      }
    };
    exports2.WasiError = WasiError;
    Object.defineProperty(WasiError.prototype, "name", {
      configurable: true,
      writable: true,
      value: "WasiError"
    });
  }
});

// node_modules/@tybys/wasm-util/lib/cjs/wasi/rights.js
var require_rights = __commonJS({
  "node_modules/@tybys/wasm-util/lib/cjs/wasi/rights.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.getRights = exports2.TTY_INHERITING = exports2.TTY_BASE = exports2.SOCKET_INHERITING = exports2.SOCKET_BASE = exports2.DIRECTORY_INHERITING = exports2.DIRECTORY_BASE = exports2.REGULAR_FILE_INHERITING = exports2.REGULAR_FILE_BASE = exports2.CHARACTER_DEVICE_INHERITING = exports2.CHARACTER_DEVICE_BASE = exports2.BLOCK_DEVICE_INHERITING = exports2.BLOCK_DEVICE_BASE = exports2.RIGHTS_ALL = void 0;
    var error_1 = require_error();
    var types_1 = require_types();
    exports2.RIGHTS_ALL = types_1.WasiRights.FD_DATASYNC | types_1.WasiRights.FD_READ | types_1.WasiRights.FD_SEEK | types_1.WasiRights.FD_FDSTAT_SET_FLAGS | types_1.WasiRights.FD_SYNC | types_1.WasiRights.FD_TELL | types_1.WasiRights.FD_WRITE | types_1.WasiRights.FD_ADVISE | types_1.WasiRights.FD_ALLOCATE | types_1.WasiRights.PATH_CREATE_DIRECTORY | types_1.WasiRights.PATH_CREATE_FILE | types_1.WasiRights.PATH_LINK_SOURCE | types_1.WasiRights.PATH_LINK_TARGET | types_1.WasiRights.PATH_OPEN | types_1.WasiRights.FD_READDIR | types_1.WasiRights.PATH_READLINK | types_1.WasiRights.PATH_RENAME_SOURCE | types_1.WasiRights.PATH_RENAME_TARGET | types_1.WasiRights.PATH_FILESTAT_GET | types_1.WasiRights.PATH_FILESTAT_SET_SIZE | types_1.WasiRights.PATH_FILESTAT_SET_TIMES | types_1.WasiRights.FD_FILESTAT_GET | types_1.WasiRights.FD_FILESTAT_SET_TIMES | types_1.WasiRights.FD_FILESTAT_SET_SIZE | types_1.WasiRights.PATH_SYMLINK | types_1.WasiRights.PATH_UNLINK_FILE | types_1.WasiRights.PATH_REMOVE_DIRECTORY | types_1.WasiRights.POLL_FD_READWRITE | types_1.WasiRights.SOCK_SHUTDOWN | types_1.WasiRights.SOCK_ACCEPT;
    exports2.BLOCK_DEVICE_BASE = exports2.RIGHTS_ALL;
    exports2.BLOCK_DEVICE_INHERITING = exports2.RIGHTS_ALL;
    exports2.CHARACTER_DEVICE_BASE = exports2.RIGHTS_ALL;
    exports2.CHARACTER_DEVICE_INHERITING = exports2.RIGHTS_ALL;
    exports2.REGULAR_FILE_BASE = types_1.WasiRights.FD_DATASYNC | types_1.WasiRights.FD_READ | types_1.WasiRights.FD_SEEK | types_1.WasiRights.FD_FDSTAT_SET_FLAGS | types_1.WasiRights.FD_SYNC | types_1.WasiRights.FD_TELL | types_1.WasiRights.FD_WRITE | types_1.WasiRights.FD_ADVISE | types_1.WasiRights.FD_ALLOCATE | types_1.WasiRights.FD_FILESTAT_GET | types_1.WasiRights.FD_FILESTAT_SET_SIZE | types_1.WasiRights.FD_FILESTAT_SET_TIMES | types_1.WasiRights.POLL_FD_READWRITE;
    exports2.REGULAR_FILE_INHERITING = BigInt(0);
    exports2.DIRECTORY_BASE = types_1.WasiRights.FD_FDSTAT_SET_FLAGS | types_1.WasiRights.FD_SYNC | types_1.WasiRights.FD_ADVISE | types_1.WasiRights.PATH_CREATE_DIRECTORY | types_1.WasiRights.PATH_CREATE_FILE | types_1.WasiRights.PATH_LINK_SOURCE | types_1.WasiRights.PATH_LINK_TARGET | types_1.WasiRights.PATH_OPEN | types_1.WasiRights.FD_READDIR | types_1.WasiRights.PATH_READLINK | types_1.WasiRights.PATH_RENAME_SOURCE | types_1.WasiRights.PATH_RENAME_TARGET | types_1.WasiRights.PATH_FILESTAT_GET | types_1.WasiRights.PATH_FILESTAT_SET_SIZE | types_1.WasiRights.PATH_FILESTAT_SET_TIMES | types_1.WasiRights.FD_FILESTAT_GET | types_1.WasiRights.FD_FILESTAT_SET_TIMES | types_1.WasiRights.PATH_SYMLINK | types_1.WasiRights.PATH_UNLINK_FILE | types_1.WasiRights.PATH_REMOVE_DIRECTORY | types_1.WasiRights.POLL_FD_READWRITE;
    exports2.DIRECTORY_INHERITING = exports2.DIRECTORY_BASE | exports2.REGULAR_FILE_BASE;
    exports2.SOCKET_BASE = types_1.WasiRights.FD_READ | types_1.WasiRights.FD_FDSTAT_SET_FLAGS | types_1.WasiRights.FD_WRITE | types_1.WasiRights.FD_FILESTAT_GET | types_1.WasiRights.POLL_FD_READWRITE | types_1.WasiRights.SOCK_SHUTDOWN;
    exports2.SOCKET_INHERITING = exports2.RIGHTS_ALL;
    exports2.TTY_BASE = types_1.WasiRights.FD_READ | types_1.WasiRights.FD_FDSTAT_SET_FLAGS | types_1.WasiRights.FD_WRITE | types_1.WasiRights.FD_FILESTAT_GET | types_1.WasiRights.POLL_FD_READWRITE;
    exports2.TTY_INHERITING = BigInt(0);
    function getRights(stdio, fd, flags, type) {
      const ret = {
        base: BigInt(0),
        inheriting: BigInt(0)
      };
      if (type === types_1.WasiFileType.UNKNOWN) {
        throw new error_1.WasiError("Unknown file type", types_1.WasiErrno.EINVAL);
      }
      switch (type) {
        case types_1.WasiFileType.REGULAR_FILE:
          ret.base = exports2.REGULAR_FILE_BASE;
          ret.inheriting = exports2.REGULAR_FILE_INHERITING;
          break;
        case types_1.WasiFileType.DIRECTORY:
          ret.base = exports2.DIRECTORY_BASE;
          ret.inheriting = exports2.DIRECTORY_INHERITING;
          break;
        case types_1.WasiFileType.SOCKET_STREAM:
        case types_1.WasiFileType.SOCKET_DGRAM:
          ret.base = exports2.SOCKET_BASE;
          ret.inheriting = exports2.SOCKET_INHERITING;
          break;
        case types_1.WasiFileType.CHARACTER_DEVICE:
          if (stdio.indexOf(fd) !== -1) {
            ret.base = exports2.TTY_BASE;
            ret.inheriting = exports2.TTY_INHERITING;
          } else {
            ret.base = exports2.CHARACTER_DEVICE_BASE;
            ret.inheriting = exports2.CHARACTER_DEVICE_INHERITING;
          }
          break;
        case types_1.WasiFileType.BLOCK_DEVICE:
          ret.base = exports2.BLOCK_DEVICE_BASE;
          ret.inheriting = exports2.BLOCK_DEVICE_INHERITING;
          break;
        default:
          ret.base = BigInt(0);
          ret.inheriting = BigInt(0);
      }
      const read_or_write_only = flags & (0 | 1 | 2);
      if (read_or_write_only === 0) {
        ret.base &= ~types_1.WasiRights.FD_WRITE;
      } else if (read_or_write_only === 1) {
        ret.base &= ~types_1.WasiRights.FD_READ;
      }
      return ret;
    }
    exports2.getRights = getRights;
  }
});

// node_modules/@tybys/wasm-util/lib/cjs/wasi/fd.js
var require_fd = __commonJS({
  "node_modules/@tybys/wasm-util/lib/cjs/wasi/fd.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.AsyncTable = exports2.SyncTable = exports2.FileDescriptorTable = exports2.toFileStat = exports2.toFileType = exports2.StandardOutput = exports2.FileDescriptor = exports2.concatBuffer = void 0;
    var types_1 = require_types();
    var rights_1 = require_rights();
    var error_1 = require_error();
    function concatBuffer(buffers, size) {
      let total = 0;
      if (typeof size === "number" && size >= 0) {
        total = size;
      } else {
        for (let i = 0; i < buffers.length; i++) {
          const buffer = buffers[i];
          total += buffer.length;
        }
      }
      let pos = 0;
      const ret = new Uint8Array(total);
      for (let i = 0; i < buffers.length; i++) {
        const buffer = buffers[i];
        ret.set(buffer, pos);
        pos += buffer.length;
      }
      return ret;
    }
    exports2.concatBuffer = concatBuffer;
    var FileDescriptor = class {
      constructor(id, fd, path, realPath, type, rightsBase, rightsInheriting, preopen) {
        this.id = id;
        this.fd = fd;
        this.path = path;
        this.realPath = realPath;
        this.type = type;
        this.rightsBase = rightsBase;
        this.rightsInheriting = rightsInheriting;
        this.preopen = preopen;
        this.pos = BigInt(0);
        this.size = BigInt(0);
      }
      seek(offset, whence) {
        if (whence === types_1.WasiWhence.SET) {
          this.pos = BigInt(offset);
        } else if (whence === types_1.WasiWhence.CUR) {
          this.pos += BigInt(offset);
        } else if (whence === types_1.WasiWhence.END) {
          this.pos = BigInt(this.size) - BigInt(offset);
        } else {
          throw new error_1.WasiError("Unknown whence", types_1.WasiErrno.EIO);
        }
        return this.pos;
      }
    };
    exports2.FileDescriptor = FileDescriptor;
    var StandardOutput = class extends FileDescriptor {
      constructor(log, id, fd, path, realPath, type, rightsBase, rightsInheriting, preopen) {
        super(id, fd, path, realPath, type, rightsBase, rightsInheriting, preopen);
        this._log = log;
        this._buf = null;
      }
      write(buffer) {
        const originalBuffer = buffer;
        if (this._buf) {
          buffer = concatBuffer([this._buf, buffer]);
          this._buf = null;
        }
        if (buffer.indexOf(10) === -1) {
          this._buf = buffer;
          return originalBuffer.byteLength;
        }
        let written = 0;
        let lastBegin = 0;
        let index;
        while ((index = buffer.indexOf(10, written)) !== -1) {
          const str = new TextDecoder().decode(buffer.subarray(lastBegin, index));
          this._log(str);
          written += index - lastBegin + 1;
          lastBegin = index + 1;
        }
        if (written < buffer.length) {
          this._buf = buffer.slice(written);
        }
        return originalBuffer.byteLength;
      }
    };
    exports2.StandardOutput = StandardOutput;
    function toFileType(stat) {
      if (stat.isBlockDevice())
        return types_1.WasiFileType.BLOCK_DEVICE;
      if (stat.isCharacterDevice())
        return types_1.WasiFileType.CHARACTER_DEVICE;
      if (stat.isDirectory())
        return types_1.WasiFileType.DIRECTORY;
      if (stat.isSocket())
        return types_1.WasiFileType.SOCKET_STREAM;
      if (stat.isFile())
        return types_1.WasiFileType.REGULAR_FILE;
      if (stat.isSymbolicLink())
        return types_1.WasiFileType.SYMBOLIC_LINK;
      return types_1.WasiFileType.UNKNOWN;
    }
    exports2.toFileType = toFileType;
    function toFileStat(view, buf, stat) {
      view.setBigUint64(buf, stat.dev, true);
      view.setBigUint64(buf + 8, stat.ino, true);
      view.setBigUint64(buf + 16, BigInt(toFileType(stat)), true);
      view.setBigUint64(buf + 24, stat.nlink, true);
      view.setBigUint64(buf + 32, stat.size, true);
      view.setBigUint64(buf + 40, stat.atimeMs * BigInt(1e6), true);
      view.setBigUint64(buf + 48, stat.mtimeMs * BigInt(1e6), true);
      view.setBigUint64(buf + 56, stat.ctimeMs * BigInt(1e6), true);
    }
    exports2.toFileStat = toFileStat;
    var FileDescriptorTable = class {
      constructor(options) {
        this.used = 0;
        this.size = options.size;
        this.fds = Array(options.size);
        this.stdio = [options.in, options.out, options.err];
        this.print = options.print;
        this.printErr = options.printErr;
        this.insertStdio(options.in, 0, "<stdin>");
        this.insertStdio(options.out, 1, "<stdout>");
        this.insertStdio(options.err, 2, "<stderr>");
      }
      insertStdio(fd, expected, name) {
        const type = types_1.WasiFileType.CHARACTER_DEVICE;
        const { base, inheriting } = (0, rights_1.getRights)(this.stdio, fd, types_1.FileControlFlag.O_RDWR, type);
        const wrap = this.insert(fd, name, name, type, base, inheriting, 0);
        if (wrap.id !== expected) {
          throw new error_1.WasiError(`id: ${wrap.id} !== expected: ${expected}`, types_1.WasiErrno.EBADF);
        }
        return wrap;
      }
      insert(fd, mappedPath, realPath, type, rightsBase, rightsInheriting, preopen) {
        var _a, _b;
        let index = -1;
        if (this.used >= this.size) {
          const newSize = this.size * 2;
          this.fds.length = newSize;
          index = this.size;
          this.size = newSize;
        } else {
          for (let i = 0; i < this.size; ++i) {
            if (this.fds[i] == null) {
              index = i;
              break;
            }
          }
        }
        let entry;
        if (mappedPath === "<stdout>") {
          entry = new StandardOutput((_a = this.print) !== null && _a !== void 0 ? _a : console.log, index, fd, mappedPath, realPath, type, rightsBase, rightsInheriting, preopen);
        } else if (mappedPath === "<stderr>") {
          entry = new StandardOutput((_b = this.printErr) !== null && _b !== void 0 ? _b : console.error, index, fd, mappedPath, realPath, type, rightsBase, rightsInheriting, preopen);
        } else {
          entry = new FileDescriptor(index, fd, mappedPath, realPath, type, rightsBase, rightsInheriting, preopen);
        }
        this.fds[index] = entry;
        this.used++;
        return entry;
      }
      get(id, base, inheriting) {
        if (id >= this.size) {
          throw new error_1.WasiError("Invalid fd", types_1.WasiErrno.EBADF);
        }
        const entry = this.fds[id];
        if (!entry || entry.id !== id) {
          throw new error_1.WasiError("Bad file descriptor", types_1.WasiErrno.EBADF);
        }
        if ((~entry.rightsBase & base) !== BigInt(0) || (~entry.rightsInheriting & inheriting) !== BigInt(0)) {
          throw new error_1.WasiError("Capabilities insufficient", types_1.WasiErrno.ENOTCAPABLE);
        }
        return entry;
      }
      remove(id) {
        if (id >= this.size) {
          throw new error_1.WasiError("Invalid fd", types_1.WasiErrno.EBADF);
        }
        const entry = this.fds[id];
        if (!entry || entry.id !== id) {
          throw new error_1.WasiError("Bad file descriptor", types_1.WasiErrno.EBADF);
        }
        this.fds[id] = void 0;
        this.used--;
      }
    };
    exports2.FileDescriptorTable = FileDescriptorTable;
    var SyncTable = class extends FileDescriptorTable {
      constructor(options) {
        super(options);
        this.fs = options.fs;
      }
      getFileTypeByFd(fd) {
        const stats = this.fs.fstatSync(fd, { bigint: true });
        return toFileType(stats);
      }
      insertPreopen(fd, mappedPath, realPath) {
        const type = this.getFileTypeByFd(fd);
        if (type !== types_1.WasiFileType.DIRECTORY) {
          throw new error_1.WasiError(`Preopen not dir: ["${mappedPath}", "${realPath}"]`, types_1.WasiErrno.ENOTDIR);
        }
        const result = (0, rights_1.getRights)(this.stdio, fd, 0, type);
        return this.insert(fd, mappedPath, realPath, type, result.base, result.inheriting, 1);
      }
      renumber(dst, src) {
        if (dst === src)
          return;
        if (dst >= this.size || src >= this.size) {
          throw new error_1.WasiError("Invalid fd", types_1.WasiErrno.EBADF);
        }
        const dstEntry = this.fds[dst];
        const srcEntry = this.fds[src];
        if (!dstEntry || !srcEntry || dstEntry.id !== dst || srcEntry.id !== src) {
          throw new error_1.WasiError("Invalid fd", types_1.WasiErrno.EBADF);
        }
        this.fs.closeSync(dstEntry.fd);
        this.fds[dst] = this.fds[src];
        this.fds[dst].id = dst;
        this.fds[src] = void 0;
        this.used--;
      }
    };
    exports2.SyncTable = SyncTable;
    var AsyncTable = class extends FileDescriptorTable {
      // eslint-disable-next-line @typescript-eslint/no-useless-constructor
      constructor(options) {
        super(options);
      }
      async getFileTypeByFd(fd) {
        const stats = await fd.stat({ bigint: true });
        return toFileType(stats);
      }
      async insertPreopen(fd, mappedPath, realPath) {
        const type = await this.getFileTypeByFd(fd);
        if (type !== types_1.WasiFileType.DIRECTORY) {
          throw new error_1.WasiError(`Preopen not dir: ["${mappedPath}", "${realPath}"]`, types_1.WasiErrno.ENOTDIR);
        }
        const result = (0, rights_1.getRights)(this.stdio, fd.fd, 0, type);
        return this.insert(fd, mappedPath, realPath, type, result.base, result.inheriting, 1);
      }
      async renumber(dst, src) {
        if (dst === src)
          return;
        if (dst >= this.size || src >= this.size) {
          throw new error_1.WasiError("Invalid fd", types_1.WasiErrno.EBADF);
        }
        const dstEntry = this.fds[dst];
        const srcEntry = this.fds[src];
        if (!dstEntry || !srcEntry || dstEntry.id !== dst || srcEntry.id !== src) {
          throw new error_1.WasiError("Invalid fd", types_1.WasiErrno.EBADF);
        }
        await dstEntry.fd.close();
        this.fds[dst] = this.fds[src];
        this.fds[dst].id = dst;
        this.fds[src] = void 0;
        this.used--;
      }
    };
    exports2.AsyncTable = AsyncTable;
  }
});

// node_modules/@tybys/wasm-util/lib/cjs/memory.js
var require_memory = __commonJS({
  "node_modules/@tybys/wasm-util/lib/cjs/memory.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.extendMemory = exports2.Memory = exports2.WebAssemblyMemory = void 0;
    var webassembly_1 = require_webassembly();
    exports2.WebAssemblyMemory = function() {
      return webassembly_1._WebAssembly.Memory;
    }();
    var Memory = class extends exports2.WebAssemblyMemory {
      // eslint-disable-next-line @typescript-eslint/no-useless-constructor
      constructor(descriptor) {
        super(descriptor);
      }
      get HEAP8() {
        return new Int8Array(super.buffer);
      }
      get HEAPU8() {
        return new Uint8Array(super.buffer);
      }
      get HEAP16() {
        return new Int16Array(super.buffer);
      }
      get HEAPU16() {
        return new Uint16Array(super.buffer);
      }
      get HEAP32() {
        return new Int32Array(super.buffer);
      }
      get HEAPU32() {
        return new Uint32Array(super.buffer);
      }
      get HEAP64() {
        return new BigInt64Array(super.buffer);
      }
      get HEAPU64() {
        return new BigUint64Array(super.buffer);
      }
      get HEAPF32() {
        return new Float32Array(super.buffer);
      }
      get HEAPF64() {
        return new Float64Array(super.buffer);
      }
      get view() {
        return new DataView(super.buffer);
      }
    };
    exports2.Memory = Memory;
    function extendMemory(memory) {
      if (Object.getPrototypeOf(memory) === webassembly_1._WebAssembly.Memory.prototype) {
        Object.setPrototypeOf(memory, Memory.prototype);
      }
      return memory;
    }
    exports2.extendMemory = extendMemory;
  }
});

// node_modules/@tybys/wasm-util/lib/cjs/jspi.js
var require_jspi = __commonJS({
  "node_modules/@tybys/wasm-util/lib/cjs/jspi.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.wrapExports = exports2.wrapAsyncExport = exports2.wrapAsyncImport = void 0;
    var util_1 = require_util();
    var webassembly_1 = require_webassembly();
    function checkWebAssemblyFunction() {
      const WebAssemblyFunction = webassembly_1._WebAssembly.Function;
      if (typeof WebAssemblyFunction !== "function") {
        throw new Error('WebAssembly.Function is not supported in this environment. If you are using V8 based browser like Chrome, try to specify --js-flags="--wasm-staging --experimental-wasm-stack-switching"');
      }
      return WebAssemblyFunction;
    }
    function wrapAsyncImport(f, parameterType, returnType) {
      const WebAssemblyFunction = checkWebAssemblyFunction();
      if (typeof f !== "function") {
        throw new TypeError("Function required");
      }
      const parameters = parameterType.slice(0);
      parameters.unshift("externref");
      return new WebAssemblyFunction({ parameters, results: returnType }, f, { suspending: "first" });
    }
    exports2.wrapAsyncImport = wrapAsyncImport;
    function wrapAsyncExport(f) {
      const WebAssemblyFunction = checkWebAssemblyFunction();
      if (typeof f !== "function") {
        throw new TypeError("Function required");
      }
      return new WebAssemblyFunction({ parameters: [...WebAssemblyFunction.type(f).parameters.slice(1)], results: ["externref"] }, f, { promising: "first" });
    }
    exports2.wrapAsyncExport = wrapAsyncExport;
    function wrapExports(exports3, needWrap) {
      return (0, util_1.wrapInstanceExports)(exports3, (exportValue, name) => {
        let ignore = typeof exportValue !== "function";
        if (Array.isArray(needWrap)) {
          ignore = ignore || needWrap.indexOf(name) === -1;
        }
        return ignore ? exportValue : wrapAsyncExport(exportValue);
      });
    }
    exports2.wrapExports = wrapExports;
  }
});

// node_modules/@tybys/wasm-util/lib/cjs/wasi/preview1.js
var require_preview1 = __commonJS({
  "node_modules/@tybys/wasm-util/lib/cjs/wasi/preview1.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.WASI = exports2.ensureMemoryFor = void 0;
    var webassembly_1 = require_webassembly();
    var path_1 = require_path();
    var _isWin32Flags = typeof process !== "undefined" && process.platform === "win32";
    function _toWinOpenFlags(f) {
      let r = f & 3;
      if ((f & 64) !== 0)
        r |= 256;
      if ((f & 128) !== 0)
        r |= 1024;
      if ((f & 512) !== 0)
        r |= 512;
      if ((f & 1024) !== 0)
        r |= 8;
      return r;
    }
    var types_1 = require_types();
    var fd_1 = require_fd();
    var error_1 = require_error();
    var util_1 = require_util();
    var rights_1 = require_rights();
    var memory_1 = require_memory();
    var jspi_1 = require_jspi();
    function copyMemory(targets, src) {
      if (targets.length === 0 || src.length === 0)
        return 0;
      let copied = 0;
      let left = src.length - copied;
      for (let i = 0; i < targets.length; ++i) {
        const target = targets[i];
        if (left < target.length) {
          target.set(src.subarray(copied, copied + left), 0);
          copied += left;
          left = 0;
          return copied;
        }
        target.set(src.subarray(copied, copied + target.length), 0);
        copied += target.length;
        left -= target.length;
      }
      return copied;
    }
    var _memory = /* @__PURE__ */ new WeakMap();
    var _wasi = /* @__PURE__ */ new WeakMap();
    var _fs = /* @__PURE__ */ new WeakMap();
    function ensureMemoryFor(memory, end) {
      let buffer = memory.buffer;
      if (end > buffer.byteLength) {
        memory.grow(0);
        buffer = memory.buffer;
      }
      return buffer;
    }
    exports2.ensureMemoryFor = ensureMemoryFor;
    function getMemory(wasi, end = 0) {
      const memory = _memory.get(wasi);
      ensureMemoryFor(memory, end);
      return memory;
    }
    function getFs(wasi) {
      const fs = _fs.get(wasi);
      if (!fs)
        throw new Error("filesystem is unavailable");
      return fs;
    }
    function handleError(err) {
      if (err instanceof error_1.WasiError) {
        if (process.env.NODE_ENV !== "production") {
          console.warn(err);
        }
        return err.errno;
      }
      switch (err.code) {
        case "ENOENT":
          return types_1.WasiErrno.ENOENT;
        case "EBADF":
          return types_1.WasiErrno.EBADF;
        case "EINVAL":
          return types_1.WasiErrno.EINVAL;
        case "EPERM":
          return types_1.WasiErrno.EPERM;
        case "EPROTO":
          return types_1.WasiErrno.EPROTO;
        case "EEXIST":
          return types_1.WasiErrno.EEXIST;
        case "ENOTDIR":
          return types_1.WasiErrno.ENOTDIR;
        case "EMFILE":
          return types_1.WasiErrno.EMFILE;
        case "EACCES":
          return types_1.WasiErrno.EACCES;
        case "EISDIR":
          return types_1.WasiErrno.EISDIR;
        case "ENOTEMPTY":
          return types_1.WasiErrno.ENOTEMPTY;
        case "ENOSYS":
          return types_1.WasiErrno.ENOSYS;
      }
      throw err;
    }
    function defineName(name, f) {
      Object.defineProperty(f, "name", { value: name });
      return f;
    }
    function tryCall(f, wasi, args) {
      let r;
      try {
        r = f.apply(wasi, args);
      } catch (err) {
        return handleError(err);
      }
      if ((0, util_1.isPromiseLike)(r)) {
        return r.then((_) => _, handleError);
      }
      return r;
    }
    function syscallWrap(self2, name, f) {
      let debug = false;
      const NODE_DEBUG_NATIVE = (() => {
        try {
          return process.env.NODE_DEBUG_NATIVE;
        } catch (_) {
          return void 0;
        }
      })();
      if (typeof NODE_DEBUG_NATIVE === "string" && NODE_DEBUG_NATIVE.split(",").includes("wasi")) {
        debug = true;
      }
      return debug ? defineName(name, function() {
        const args = Array.prototype.slice.call(arguments);
        let debugArgs = [`${name}(${Array.from({ length: arguments.length }).map(() => "%d").join(", ")})`];
        debugArgs = debugArgs.concat(args);
        console.debug.apply(console, debugArgs);
        return tryCall(f, self2, args);
      }) : defineName(name, function() {
        return tryCall(f, self2, arguments);
      });
    }
    function resolvePathSync(fs, fileDescriptor, path, flags) {
      let resolvedPath = (0, path_1.resolve)(fileDescriptor.realPath, path);
      if ((flags & 1) === 1) {
        try {
          resolvedPath = fs.readlinkSync(resolvedPath);
        } catch (err) {
          if (err.code !== "EINVAL" && err.code !== "ENOENT") {
            throw err;
          }
        }
      }
      return resolvedPath;
    }
    async function resolvePathAsync(fs, fileDescriptor, path, flags) {
      let resolvedPath = (0, path_1.resolve)(fileDescriptor.realPath, path);
      if ((flags & 1) === 1) {
        try {
          resolvedPath = await fs.promises.readlink(resolvedPath);
        } catch (err) {
          if (err.code !== "EINVAL" && err.code !== "ENOENT") {
            throw err;
          }
        }
      }
      return resolvedPath;
    }
    var encoder = /* @__PURE__ */ new TextEncoder();
    var decoder = /* @__PURE__ */ new TextDecoder();
    var INT64_MAX = (BigInt(1) << BigInt(63)) - BigInt(1);
    function readStdin() {
      const value = window.prompt();
      if (value === null)
        return new Uint8Array();
      const buffer = new TextEncoder().encode(value + "\n");
      return buffer;
    }
    function validateFstFlagsOrReturn(flags) {
      return Boolean(flags & ~(types_1.WasiFstFlag.SET_ATIM | types_1.WasiFstFlag.SET_ATIM_NOW | types_1.WasiFstFlag.SET_MTIM | types_1.WasiFstFlag.SET_MTIM_NOW)) || (flags & (types_1.WasiFstFlag.SET_ATIM | types_1.WasiFstFlag.SET_ATIM_NOW)) === (types_1.WasiFstFlag.SET_ATIM | types_1.WasiFstFlag.SET_ATIM_NOW) || (flags & (types_1.WasiFstFlag.SET_MTIM | types_1.WasiFstFlag.SET_MTIM_NOW)) === (types_1.WasiFstFlag.SET_MTIM | types_1.WasiFstFlag.SET_MTIM_NOW);
    }
    var WASI2 = class _WASI {
      constructor(args, env, fds, asyncFs, fs, asyncify) {
        this.args_get = syscallWrap(this, "args_get", function(argv, argv_buf) {
          argv = Number(argv);
          argv_buf = Number(argv_buf);
          if (argv === 0 || argv_buf === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const wasi = _wasi.get(this);
          const args2 = wasi.args;
          const argsSize = encoder.encode(args2.join("\0") + "\0").length;
          const { HEAPU8, view } = getMemory(this, Math.max(argv + args2.length * 4, argv_buf + argsSize));
          for (let i = 0; i < args2.length; ++i) {
            const arg = args2[i];
            view.setInt32(argv, argv_buf, true);
            argv += 4;
            const data = encoder.encode(arg + "\0");
            HEAPU8.set(data, argv_buf);
            argv_buf += data.length;
          }
          return types_1.WasiErrno.ESUCCESS;
        });
        this.args_sizes_get = syscallWrap(this, "args_sizes_get", function(argc, argv_buf_size) {
          argc = Number(argc);
          argv_buf_size = Number(argv_buf_size);
          if (argc === 0 || argv_buf_size === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const { view } = getMemory(this, Math.max(argc + 4, argv_buf_size + 4));
          const wasi = _wasi.get(this);
          const args2 = wasi.args;
          view.setUint32(argc, args2.length, true);
          view.setUint32(argv_buf_size, encoder.encode(args2.join("\0") + "\0").length, true);
          return types_1.WasiErrno.ESUCCESS;
        });
        this.environ_get = syscallWrap(this, "environ_get", function(environ, environ_buf) {
          environ = Number(environ);
          environ_buf = Number(environ_buf);
          if (environ === 0 || environ_buf === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const wasi = _wasi.get(this);
          const env2 = wasi.env;
          const envSize = encoder.encode(env2.join("\0") + "\0").length;
          const { HEAPU8, view } = getMemory(this, Math.max(environ + env2.length * 4, environ_buf + envSize));
          for (let i = 0; i < env2.length; ++i) {
            const pair = env2[i];
            view.setInt32(environ, environ_buf, true);
            environ += 4;
            const data = encoder.encode(pair + "\0");
            HEAPU8.set(data, environ_buf);
            environ_buf += data.length;
          }
          return types_1.WasiErrno.ESUCCESS;
        });
        this.environ_sizes_get = syscallWrap(this, "environ_sizes_get", function(len, buflen) {
          len = Number(len);
          buflen = Number(buflen);
          if (len === 0 || buflen === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const { view } = getMemory(this, Math.max(len + 4, buflen + 4));
          const wasi = _wasi.get(this);
          view.setUint32(len, wasi.env.length, true);
          view.setUint32(buflen, encoder.encode(wasi.env.join("\0") + "\0").length, true);
          return types_1.WasiErrno.ESUCCESS;
        });
        this.clock_res_get = syscallWrap(this, "clock_res_get", function(id, resolution) {
          resolution = Number(resolution);
          if (resolution === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const { view } = getMemory(this, resolution + 8);
          switch (id) {
            case types_1.WasiClockid.REALTIME:
              view.setBigUint64(resolution, BigInt(1e6), true);
              return types_1.WasiErrno.ESUCCESS;
            case types_1.WasiClockid.MONOTONIC:
            case types_1.WasiClockid.PROCESS_CPUTIME_ID:
            case types_1.WasiClockid.THREAD_CPUTIME_ID:
              view.setBigUint64(resolution, BigInt(1e3), true);
              return types_1.WasiErrno.ESUCCESS;
            default:
              return types_1.WasiErrno.EINVAL;
          }
        });
        this.clock_time_get = syscallWrap(this, "clock_time_get", function(id, _percision, time) {
          time = Number(time);
          if (time === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const { view } = getMemory(this, time + 8);
          switch (id) {
            case types_1.WasiClockid.REALTIME:
              view.setBigUint64(time, BigInt(Date.now()) * BigInt(1e6), true);
              return types_1.WasiErrno.ESUCCESS;
            case types_1.WasiClockid.MONOTONIC:
            case types_1.WasiClockid.PROCESS_CPUTIME_ID:
            case types_1.WasiClockid.THREAD_CPUTIME_ID: {
              const t = performance.now() / 1e3;
              const s = Math.trunc(t);
              const ms = Math.floor((t - s) * 1e3);
              const result = BigInt(s) * BigInt(1e9) + BigInt(ms) * BigInt(1e6);
              view.setBigUint64(time, result, true);
              return types_1.WasiErrno.ESUCCESS;
            }
            default:
              return types_1.WasiErrno.EINVAL;
          }
        });
        this.fd_advise = syscallWrap(this, "fd_advise", function(_fd, _offset, _len, _advice) {
          return types_1.WasiErrno.ENOSYS;
        });
        this.fd_fdstat_get = syscallWrap(this, "fd_fdstat_get", function(fd, fdstat) {
          fdstat = Number(fdstat);
          if (fdstat === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, BigInt(0), BigInt(0));
          const { view } = getMemory(this, fdstat + 24);
          view.setUint16(fdstat, fileDescriptor.type, true);
          view.setUint16(fdstat + 2, 0, true);
          view.setBigUint64(fdstat + 8, fileDescriptor.rightsBase, true);
          view.setBigUint64(fdstat + 16, fileDescriptor.rightsInheriting, true);
          return types_1.WasiErrno.ESUCCESS;
        });
        this.fd_fdstat_set_flags = syscallWrap(this, "fd_fdstat_set_flags", function(_fd, _flags) {
          return types_1.WasiErrno.ENOSYS;
        });
        this.fd_fdstat_set_rights = syscallWrap(this, "fd_fdstat_set_rights", function(fd, rightsBase, rightsInheriting) {
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, BigInt(0), BigInt(0));
          if ((rightsBase | fileDescriptor.rightsBase) > fileDescriptor.rightsBase) {
            return types_1.WasiErrno.ENOTCAPABLE;
          }
          if ((rightsInheriting | fileDescriptor.rightsInheriting) > fileDescriptor.rightsInheriting) {
            return types_1.WasiErrno.ENOTCAPABLE;
          }
          fileDescriptor.rightsBase = rightsBase;
          fileDescriptor.rightsInheriting = rightsInheriting;
          return types_1.WasiErrno.ESUCCESS;
        });
        this.fd_prestat_get = syscallWrap(this, "fd_prestat_get", function(fd, prestat) {
          prestat = Number(prestat);
          if (prestat === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const wasi = _wasi.get(this);
          let fileDescriptor;
          try {
            fileDescriptor = wasi.fds.get(fd, BigInt(0), BigInt(0));
          } catch (err) {
            if (err instanceof error_1.WasiError)
              return err.errno;
            throw err;
          }
          if (fileDescriptor.preopen !== 1)
            return types_1.WasiErrno.EINVAL;
          const { view } = getMemory(this, prestat + 8);
          view.setUint32(prestat, 0, true);
          view.setUint32(prestat + 4, encoder.encode(fileDescriptor.path).length, true);
          return types_1.WasiErrno.ESUCCESS;
        });
        this.fd_prestat_dir_name = syscallWrap(this, "fd_prestat_dir_name", function(fd, path, path_len) {
          path = Number(path);
          path_len = Number(path_len);
          if (path === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, BigInt(0), BigInt(0));
          if (fileDescriptor.preopen !== 1)
            return types_1.WasiErrno.EBADF;
          const buffer = encoder.encode(fileDescriptor.path);
          const size = buffer.length;
          if (size > path_len)
            return types_1.WasiErrno.ENOBUFS;
          const { HEAPU8 } = getMemory(this, path + size);
          HEAPU8.set(buffer, path);
          return types_1.WasiErrno.ESUCCESS;
        });
        this.fd_seek = syscallWrap(this, "fd_seek", function(fd, offset, whence, newOffset) {
          newOffset = Number(newOffset);
          if (newOffset === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          if (fd === 0 || fd === 1 || fd === 2)
            return types_1.WasiErrno.ESUCCESS;
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.FD_SEEK, BigInt(0));
          const r = fileDescriptor.seek(offset, whence);
          const { view } = getMemory(this, newOffset + 8);
          view.setBigUint64(newOffset, r, true);
          return types_1.WasiErrno.ESUCCESS;
        });
        this.fd_tell = syscallWrap(this, "fd_tell", function(fd, offset) {
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.FD_TELL, BigInt(0));
          const pos = BigInt(fileDescriptor.pos);
          const { view } = getMemory(this, Number(offset) + 8);
          view.setBigUint64(Number(offset), pos, true);
          return types_1.WasiErrno.ESUCCESS;
        });
        this.poll_oneoff = syscallWrap(this, "poll_oneoff", function(in_ptr, out_ptr, nsubscriptions, nevents) {
          in_ptr = Number(in_ptr);
          out_ptr = Number(out_ptr);
          nevents = Number(nevents);
          nsubscriptions = Number(nsubscriptions);
          nsubscriptions = nsubscriptions >>> 0;
          if (in_ptr === 0 || out_ptr === 0 || nsubscriptions === 0 || nevents === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const { view } = getMemory(this, Math.max(in_ptr + nsubscriptions * 48, out_ptr + nsubscriptions * 32, nevents + 4));
          view.setUint32(nevents, 0, true);
          let i = 0;
          let timer_userdata = BigInt(0);
          let cur_timeout = BigInt(0);
          let has_timeout = 0;
          let min_timeout = BigInt(0);
          let sub;
          const subscriptions = Array(nsubscriptions);
          for (i = 0; i < nsubscriptions; i++) {
            sub = in_ptr + i * 48;
            const userdata = view.getBigUint64(sub, true);
            const type = view.getUint8(sub + 8);
            const clockIdOrFd = view.getUint32(sub + 16, true);
            const timeout = view.getBigUint64(sub + 24, true);
            const precision = view.getBigUint64(sub + 32, true);
            const flags = view.getUint16(sub + 40, true);
            subscriptions[i] = {
              userdata,
              type,
              u: {
                clock: {
                  clock_id: clockIdOrFd,
                  timeout,
                  precision,
                  flags
                },
                fd_readwrite: {
                  fd: clockIdOrFd
                }
              }
            };
          }
          const fdevents = [];
          for (i = 0; i < nsubscriptions; i++) {
            sub = subscriptions[i];
            switch (sub.type) {
              case types_1.WasiEventType.CLOCK: {
                if (sub.u.clock.flags === types_1.WasiSubclockflags.ABSTIME) {
                  const now = BigInt(Date.now()) * BigInt(1e6);
                  cur_timeout = sub.u.clock.timeout - now;
                } else {
                  cur_timeout = sub.u.clock.timeout;
                }
                if (has_timeout === 0 || cur_timeout < min_timeout) {
                  min_timeout = cur_timeout;
                  timer_userdata = sub.userdata;
                  has_timeout = 1;
                }
                break;
              }
              case types_1.WasiEventType.FD_READ:
              case types_1.WasiEventType.FD_WRITE:
                fdevents.push(sub);
                break;
              default:
                return types_1.WasiErrno.EINVAL;
            }
          }
          if (fdevents.length > 0) {
            for (i = 0; i < fdevents.length; i++) {
              const fdevent = fdevents[i];
              const event = out_ptr + 32 * i;
              view.setBigUint64(event, fdevent.userdata, true);
              view.setUint32(event + 8, types_1.WasiErrno.ENOSYS, true);
              view.setUint32(event + 12, fdevent.type, true);
              view.setBigUint64(event + 16, BigInt(0), true);
              view.setUint16(event + 24, 0, true);
              view.setUint32(nevents, 1, true);
            }
            view.setUint32(nevents, fdevents.length, true);
            return types_1.WasiErrno.ESUCCESS;
          }
          if (has_timeout) {
            const delay = Number(min_timeout / BigInt(1e6));
            (0, util_1.sleepBreakIf)(delay, () => false);
            const event = out_ptr;
            view.setBigUint64(event, timer_userdata, true);
            view.setUint32(event + 8, types_1.WasiErrno.ESUCCESS, true);
            view.setUint32(event + 12, types_1.WasiEventType.CLOCK, true);
            view.setUint32(nevents, 1, true);
          }
          return types_1.WasiErrno.ESUCCESS;
        });
        this.proc_exit = syscallWrap(this, "proc_exit", function(rval) {
          if (typeof process === "object" && process !== null && typeof process.exit === "function") {
            process.exit(rval);
          }
          return types_1.WasiErrno.ESUCCESS;
        });
        this.proc_raise = syscallWrap(this, "proc_raise", function(_sig) {
          return types_1.WasiErrno.ENOSYS;
        });
        this.sched_yield = syscallWrap(this, "sched_yield", function() {
          return types_1.WasiErrno.ESUCCESS;
        });
        this.random_get = typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function" ? syscallWrap(this, "random_get", function(buf, buf_len) {
          buf = Number(buf);
          if (buf === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          buf_len = Number(buf_len);
          const { HEAPU8, view } = getMemory(this, buf + buf_len);
          if (typeof SharedArrayBuffer === "function" && HEAPU8.buffer instanceof SharedArrayBuffer || Object.prototype.toString.call(HEAPU8.buffer) === "[object SharedArrayBuffer]") {
            for (let i = buf; i < buf + buf_len; ++i) {
              view.setUint8(i, Math.floor(Math.random() * 256));
            }
            return types_1.WasiErrno.ESUCCESS;
          }
          let pos;
          const stride = 65536;
          for (pos = 0; pos + stride < buf_len; pos += stride) {
            crypto.getRandomValues(HEAPU8.subarray(buf + pos, buf + pos + stride));
          }
          crypto.getRandomValues(HEAPU8.subarray(buf + pos, buf + buf_len));
          return types_1.WasiErrno.ESUCCESS;
        }) : syscallWrap(this, "random_get", function(buf, buf_len) {
          buf = Number(buf);
          if (buf === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          buf_len = Number(buf_len);
          const { view } = getMemory(this, buf + buf_len);
          for (let i = buf; i < buf + buf_len; ++i) {
            view.setUint8(i, Math.floor(Math.random() * 256));
          }
          return types_1.WasiErrno.ESUCCESS;
        });
        this.sock_recv = syscallWrap(this, "sock_recv", function() {
          return types_1.WasiErrno.ENOTSUP;
        });
        this.sock_send = syscallWrap(this, "sock_send", function() {
          return types_1.WasiErrno.ENOTSUP;
        });
        this.sock_shutdown = syscallWrap(this, "sock_shutdown", function() {
          return types_1.WasiErrno.ENOTSUP;
        });
        this.sock_accept = syscallWrap(this, "sock_accept", function() {
          return types_1.WasiErrno.ENOTSUP;
        });
        _wasi.set(this, {
          fds,
          args,
          env
        });
        if (fs)
          _fs.set(this, fs);
        const _this = this;
        function defineImport(name, syncVersion, asyncVersion, parameterType, returnType) {
          if (asyncFs) {
            if (asyncify) {
              _this[name] = asyncify.wrapImportFunction(syscallWrap(_this, name, asyncVersion));
            } else {
              _this[name] = (0, jspi_1.wrapAsyncImport)(syscallWrap(_this, name, asyncVersion), parameterType, returnType);
            }
          } else {
            _this[name] = syscallWrap(_this, name, syncVersion);
          }
        }
        defineImport("fd_allocate", function fd_allocate(fd, offset, len) {
          const wasi = _wasi.get(this);
          const fs2 = getFs(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.FD_ALLOCATE, BigInt(0));
          const stat = fs2.fstatSync(fileDescriptor.fd, { bigint: true });
          if (stat.size < offset + len) {
            fs2.ftruncateSync(fileDescriptor.fd, Number(offset + len));
          }
          return types_1.WasiErrno.ESUCCESS;
        }, async function fd_allocate(fd, offset, len) {
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.FD_ALLOCATE, BigInt(0));
          const h = fileDescriptor.fd;
          const stat = await h.stat({ bigint: true });
          if (stat.size < offset + len) {
            await h.truncate(Number(offset + len));
          }
          return types_1.WasiErrno.ESUCCESS;
        }, ["i32", "i64", "f64"], ["i32"]);
        defineImport("fd_close", function fd_close(fd) {
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, BigInt(0), BigInt(0));
          const fs2 = getFs(this);
          fs2.closeSync(fileDescriptor.fd);
          wasi.fds.remove(fd);
          return types_1.WasiErrno.ESUCCESS;
        }, async function fd_close(fd) {
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, BigInt(0), BigInt(0));
          await fileDescriptor.fd.close();
          wasi.fds.remove(fd);
          return types_1.WasiErrno.ESUCCESS;
        }, ["i32"], ["i32"]);
        defineImport("fd_datasync", function fd_datasync(fd) {
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.FD_DATASYNC, BigInt(0));
          const fs2 = getFs(this);
          fs2.fdatasyncSync(fileDescriptor.fd);
          return types_1.WasiErrno.ESUCCESS;
        }, async function fd_datasync(fd) {
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.FD_DATASYNC, BigInt(0));
          await fileDescriptor.fd.datasync();
          return types_1.WasiErrno.ESUCCESS;
        }, ["i32"], ["i32"]);
        defineImport("fd_filestat_get", function fd_filestat_get(fd, buf) {
          buf = Number(buf);
          if (buf === 0)
            return types_1.WasiErrno.EINVAL;
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.FD_FILESTAT_GET, BigInt(0));
          const fs2 = getFs(this);
          const stat = fs2.fstatSync(fileDescriptor.fd, { bigint: true });
          const { view } = getMemory(this, buf + 64);
          (0, fd_1.toFileStat)(view, buf, stat);
          return types_1.WasiErrno.ESUCCESS;
        }, async function fd_filestat_get(fd, buf) {
          buf = Number(buf);
          if (buf === 0)
            return types_1.WasiErrno.EINVAL;
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.FD_FILESTAT_GET, BigInt(0));
          const h = fileDescriptor.fd;
          const stat = await h.stat({ bigint: true });
          const { view } = getMemory(this, buf + 64);
          (0, fd_1.toFileStat)(view, buf, stat);
          return types_1.WasiErrno.ESUCCESS;
        }, ["i32", "i32"], ["i32"]);
        defineImport("fd_filestat_set_size", function fd_filestat_set_size(fd, size) {
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.FD_FILESTAT_SET_SIZE, BigInt(0));
          const fs2 = getFs(this);
          fs2.ftruncateSync(fileDescriptor.fd, Number(size));
          return types_1.WasiErrno.ESUCCESS;
        }, async function fd_filestat_set_size(fd, size) {
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.FD_FILESTAT_SET_SIZE, BigInt(0));
          const h = fileDescriptor.fd;
          await h.truncate(Number(size));
          return types_1.WasiErrno.ESUCCESS;
        }, ["i32", "i64"], ["i32"]);
        function fdFilestatGetTimes(fd, atim, mtim, flags) {
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.FD_FILESTAT_SET_TIMES, BigInt(0));
          if ((flags & types_1.WasiFstFlag.SET_ATIM_NOW) === types_1.WasiFstFlag.SET_ATIM_NOW) {
            atim = BigInt(Date.now() * 1e6);
          }
          if ((flags & types_1.WasiFstFlag.SET_MTIM_NOW) === types_1.WasiFstFlag.SET_MTIM_NOW) {
            mtim = BigInt(Date.now() * 1e6);
          }
          return { fileDescriptor, atim, mtim };
        }
        defineImport("fd_filestat_set_times", function fd_filestat_set_times(fd, atim, mtim, flags) {
          if (validateFstFlagsOrReturn(flags)) {
            return types_1.WasiErrno.EINVAL;
          }
          const { fileDescriptor, atim: atimRes, mtim: mtimRes } = fdFilestatGetTimes.call(this, fd, atim, mtim, flags);
          const fs2 = getFs(this);
          fs2.futimesSync(fileDescriptor.fd, Number(atimRes), Number(mtimRes));
          return types_1.WasiErrno.ESUCCESS;
        }, async function fd_filestat_set_times(fd, atim, mtim, flags) {
          if (validateFstFlagsOrReturn(flags)) {
            return types_1.WasiErrno.EINVAL;
          }
          const { fileDescriptor, atim: atimRes, mtim: mtimRes } = fdFilestatGetTimes.call(this, fd, atim, mtim, flags);
          const h = fileDescriptor.fd;
          await h.utimes(Number(atimRes), Number(mtimRes));
          return types_1.WasiErrno.ESUCCESS;
        }, ["i32", "i64", "i64", "i32"], ["i32"]);
        defineImport("fd_pread", function fd_pread(fd, iovs, iovslen, offset, size) {
          iovs = Number(iovs);
          size = Number(size);
          if (iovs === 0 && iovslen || size === 0 || offset > INT64_MAX) {
            return types_1.WasiErrno.EINVAL;
          }
          const { HEAPU8, view } = getMemory(this, Math.max(iovs + Number(iovslen) * 8, size + 4));
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.FD_READ | types_1.WasiRights.FD_SEEK, BigInt(0));
          if (!iovslen) {
            view.setUint32(size, 0, true);
            return types_1.WasiErrno.ESUCCESS;
          }
          let totalSize = 0;
          const ioVecs = Array.from({ length: Number(iovslen) }, (_, i) => {
            const offset2 = iovs + i * 8;
            const buf = view.getInt32(offset2, true);
            const bufLen = view.getUint32(offset2 + 4, true);
            totalSize += bufLen;
            return HEAPU8.subarray(buf, buf + bufLen);
          });
          let nread = 0;
          const buffer = (() => {
            try {
              return new Uint8Array(new SharedArrayBuffer(totalSize));
            } catch (_) {
              return new Uint8Array(totalSize);
            }
          })();
          buffer._isBuffer = true;
          const fs2 = getFs(this);
          const bytesRead = fs2.readSync(fileDescriptor.fd, buffer, 0, buffer.length, Number(offset));
          nread = buffer ? copyMemory(ioVecs, buffer.subarray(0, bytesRead)) : 0;
          view.setUint32(size, nread, true);
          return types_1.WasiErrno.ESUCCESS;
        }, async function(fd, iovs, iovslen, offset, size) {
          iovs = Number(iovs);
          size = Number(size);
          if (iovs === 0 && iovslen || size === 0 || offset > INT64_MAX) {
            return types_1.WasiErrno.EINVAL;
          }
          const { HEAPU8, view } = getMemory(this, Math.max(iovs + Number(iovslen) * 8, size + 4));
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.FD_READ | types_1.WasiRights.FD_SEEK, BigInt(0));
          if (!iovslen) {
            view.setUint32(size, 0, true);
            return types_1.WasiErrno.ESUCCESS;
          }
          let totalSize = 0;
          const ioVecs = Array.from({ length: Number(iovslen) }, (_, i) => {
            const offset2 = iovs + i * 8;
            const buf = view.getInt32(offset2, true);
            const bufLen = view.getUint32(offset2 + 4, true);
            totalSize += bufLen;
            return HEAPU8.subarray(buf, buf + bufLen);
          });
          let nread = 0;
          const buffer = new Uint8Array(totalSize);
          buffer._isBuffer = true;
          const { bytesRead } = await fileDescriptor.fd.read(buffer, 0, buffer.length, Number(offset));
          nread = buffer ? copyMemory(ioVecs, buffer.subarray(0, bytesRead)) : 0;
          view.setUint32(size, nread, true);
          return types_1.WasiErrno.ESUCCESS;
        }, ["i32", "i32", "i32", "i64", "i32"], ["i32"]);
        defineImport("fd_pwrite", function fd_pwrite(fd, iovs, iovslen, offset, size) {
          iovs = Number(iovs);
          size = Number(size);
          if (iovs === 0 && iovslen || size === 0 || offset > INT64_MAX) {
            return types_1.WasiErrno.EINVAL;
          }
          const { HEAPU8, view } = getMemory(this, Math.max(iovs + Number(iovslen) * 8, size + 4));
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.FD_WRITE | types_1.WasiRights.FD_SEEK, BigInt(0));
          if (!iovslen) {
            view.setUint32(size, 0, true);
            return types_1.WasiErrno.ESUCCESS;
          }
          const buffer = (0, fd_1.concatBuffer)(Array.from({ length: Number(iovslen) }, (_, i) => {
            const offset2 = iovs + i * 8;
            const buf = view.getInt32(offset2, true);
            const bufLen = view.getUint32(offset2 + 4, true);
            return HEAPU8.subarray(buf, buf + bufLen);
          }));
          const fs2 = getFs(this);
          const nwritten = fs2.writeSync(fileDescriptor.fd, buffer, 0, buffer.length, Number(offset));
          view.setUint32(size, nwritten, true);
          return types_1.WasiErrno.ESUCCESS;
        }, async function fd_pwrite(fd, iovs, iovslen, offset, size) {
          iovs = Number(iovs);
          size = Number(size);
          if (iovs === 0 && iovslen || size === 0 || offset > INT64_MAX) {
            return types_1.WasiErrno.EINVAL;
          }
          const { HEAPU8, view } = getMemory(this, Math.max(iovs + Number(iovslen) * 8, size + 4));
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.FD_WRITE | types_1.WasiRights.FD_SEEK, BigInt(0));
          if (!iovslen) {
            view.setUint32(size, 0, true);
            return types_1.WasiErrno.ESUCCESS;
          }
          const buffer = (0, fd_1.concatBuffer)(Array.from({ length: Number(iovslen) }, (_, i) => {
            const offset2 = iovs + i * 8;
            const buf = view.getInt32(offset2, true);
            const bufLen = view.getUint32(offset2 + 4, true);
            return HEAPU8.subarray(buf, buf + bufLen);
          }));
          const { bytesWritten } = await fileDescriptor.fd.write(buffer, 0, buffer.length, Number(offset));
          view.setUint32(size, bytesWritten, true);
          return types_1.WasiErrno.ESUCCESS;
        }, ["i32", "i32", "i32", "i64", "i32"], ["i32"]);
        defineImport("fd_read", function fd_read(fd, iovs, iovslen, size) {
          iovs = Number(iovs);
          size = Number(size);
          if (iovs === 0 && iovslen || size === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const { HEAPU8, view } = getMemory(this, Math.max(iovs + Number(iovslen) * 8, size + 4));
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.FD_READ, BigInt(0));
          if (!iovslen) {
            view.setUint32(size, 0, true);
            return types_1.WasiErrno.ESUCCESS;
          }
          let totalSize = 0;
          const ioVecs = Array.from({ length: Number(iovslen) }, (_, i) => {
            const offset = iovs + i * 8;
            const buf = view.getInt32(offset, true);
            const bufLen = view.getUint32(offset + 4, true);
            totalSize += bufLen;
            return HEAPU8.subarray(buf, buf + bufLen);
          });
          let buffer;
          let nread = 0;
          if (fd === 0) {
            if (typeof window === "undefined" || typeof window.prompt !== "function") {
              return types_1.WasiErrno.ENOTSUP;
            }
            buffer = readStdin();
            nread = buffer ? copyMemory(ioVecs, buffer) : 0;
          } else {
            buffer = (() => {
              try {
                return new Uint8Array(new SharedArrayBuffer(totalSize));
              } catch (_) {
                return new Uint8Array(totalSize);
              }
            })();
            buffer._isBuffer = true;
            const fs2 = getFs(this);
            const bytesRead = fs2.readSync(fileDescriptor.fd, buffer, 0, buffer.length, Number(fileDescriptor.pos));
            nread = buffer ? copyMemory(ioVecs, buffer.subarray(0, bytesRead)) : 0;
            fileDescriptor.pos += BigInt(nread);
          }
          view.setUint32(size, nread, true);
          return types_1.WasiErrno.ESUCCESS;
        }, async function fd_read(fd, iovs, iovslen, size) {
          iovs = Number(iovs);
          size = Number(size);
          if (iovs === 0 && iovslen || size === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const { HEAPU8, view } = getMemory(this, Math.max(iovs + Number(iovslen) * 8, size + 4));
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.FD_READ, BigInt(0));
          if (!iovslen) {
            view.setUint32(size, 0, true);
            return types_1.WasiErrno.ESUCCESS;
          }
          let totalSize = 0;
          const ioVecs = Array.from({ length: Number(iovslen) }, (_, i) => {
            const offset = iovs + i * 8;
            const buf = view.getInt32(offset, true);
            const bufLen = view.getUint32(offset + 4, true);
            totalSize += bufLen;
            return HEAPU8.subarray(buf, buf + bufLen);
          });
          let buffer;
          let nread = 0;
          if (fd === 0) {
            if (typeof window === "undefined" || typeof window.prompt !== "function") {
              return types_1.WasiErrno.ENOTSUP;
            }
            buffer = readStdin();
            nread = buffer ? copyMemory(ioVecs, buffer) : 0;
          } else {
            buffer = new Uint8Array(totalSize);
            buffer._isBuffer = true;
            const { bytesRead } = await fileDescriptor.fd.read(buffer, 0, buffer.length, Number(fileDescriptor.pos));
            nread = buffer ? copyMemory(ioVecs, buffer.subarray(0, bytesRead)) : 0;
            fileDescriptor.pos += BigInt(nread);
          }
          view.setUint32(size, nread, true);
          return types_1.WasiErrno.ESUCCESS;
        }, ["i32", "i32", "i32", "i32"], ["i32"]);
        defineImport("fd_readdir", function fd_readdir(fd, buf, buf_len, cookie, bufused) {
          buf = Number(buf);
          buf_len = Number(buf_len);
          bufused = Number(bufused);
          if (buf === 0 || bufused === 0)
            return types_1.WasiErrno.ESUCCESS;
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.FD_READDIR, BigInt(0));
          const fs2 = getFs(this);
          const entries = fs2.readdirSync(fileDescriptor.realPath, { withFileTypes: true });
          const { HEAPU8, view } = getMemory(this, Math.max(buf + buf_len, bufused + 4));
          let bufferUsed = 0;
          for (let i = Number(cookie); i < entries.length; i++) {
            const nameData = encoder.encode(entries[i].name);
            const entryInfo = fs2.statSync((0, path_1.resolve)(fileDescriptor.realPath, entries[i].name), { bigint: true });
            const entryData = new Uint8Array(24 + nameData.byteLength);
            const entryView = new DataView(entryData.buffer);
            entryView.setBigUint64(0, BigInt(i + 1), true);
            entryView.setBigUint64(8, BigInt(entryInfo.ino ? entryInfo.ino : 0), true);
            entryView.setUint32(16, nameData.byteLength, true);
            let type;
            if (entries[i].isFile()) {
              type = types_1.WasiFileType.REGULAR_FILE;
            } else if (entries[i].isDirectory()) {
              type = types_1.WasiFileType.DIRECTORY;
            } else if (entries[i].isSymbolicLink()) {
              type = types_1.WasiFileType.SYMBOLIC_LINK;
            } else if (entries[i].isCharacterDevice()) {
              type = types_1.WasiFileType.CHARACTER_DEVICE;
            } else if (entries[i].isBlockDevice()) {
              type = types_1.WasiFileType.BLOCK_DEVICE;
            } else if (entries[i].isSocket()) {
              type = types_1.WasiFileType.SOCKET_STREAM;
            } else {
              type = types_1.WasiFileType.UNKNOWN;
            }
            entryView.setUint8(20, type);
            entryData.set(nameData, 24);
            const data = entryData.slice(0, Math.min(entryData.length, buf_len - bufferUsed));
            HEAPU8.set(data, buf + bufferUsed);
            bufferUsed += data.byteLength;
          }
          view.setUint32(bufused, bufferUsed, true);
          return types_1.WasiErrno.ESUCCESS;
        }, async function fd_readdir(fd, buf, buf_len, cookie, bufused) {
          buf = Number(buf);
          buf_len = Number(buf_len);
          bufused = Number(bufused);
          if (buf === 0 || bufused === 0)
            return types_1.WasiErrno.ESUCCESS;
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.FD_READDIR, BigInt(0));
          const fs2 = getFs(this);
          const entries = await fs2.promises.readdir(fileDescriptor.realPath, { withFileTypes: true });
          const { HEAPU8, view } = getMemory(this, Math.max(buf + buf_len, bufused + 4));
          let bufferUsed = 0;
          for (let i = Number(cookie); i < entries.length; i++) {
            const nameData = encoder.encode(entries[i].name);
            const entryInfo = await fs2.promises.stat((0, path_1.resolve)(fileDescriptor.realPath, entries[i].name), { bigint: true });
            const entryData = new Uint8Array(24 + nameData.byteLength);
            const entryView = new DataView(entryData.buffer);
            entryView.setBigUint64(0, BigInt(i + 1), true);
            entryView.setBigUint64(8, BigInt(entryInfo.ino ? entryInfo.ino : 0), true);
            entryView.setUint32(16, nameData.byteLength, true);
            let type;
            if (entries[i].isFile()) {
              type = types_1.WasiFileType.REGULAR_FILE;
            } else if (entries[i].isDirectory()) {
              type = types_1.WasiFileType.DIRECTORY;
            } else if (entries[i].isSymbolicLink()) {
              type = types_1.WasiFileType.SYMBOLIC_LINK;
            } else if (entries[i].isCharacterDevice()) {
              type = types_1.WasiFileType.CHARACTER_DEVICE;
            } else if (entries[i].isBlockDevice()) {
              type = types_1.WasiFileType.BLOCK_DEVICE;
            } else if (entries[i].isSocket()) {
              type = types_1.WasiFileType.SOCKET_STREAM;
            } else {
              type = types_1.WasiFileType.UNKNOWN;
            }
            entryView.setUint8(20, type);
            entryData.set(nameData, 24);
            const data = entryData.slice(0, Math.min(entryData.length, buf_len - bufferUsed));
            HEAPU8.set(data, buf + bufferUsed);
            bufferUsed += data.byteLength;
          }
          view.setUint32(bufused, bufferUsed, true);
          return types_1.WasiErrno.ESUCCESS;
        }, ["i32", "i32", "i32", "i64", "i32"], ["i32"]);
        defineImport("fd_renumber", function fd_renumber(from, to) {
          const wasi = _wasi.get(this);
          wasi.fds.renumber(to, from);
          return types_1.WasiErrno.ESUCCESS;
        }, async function fd_renumber(from, to) {
          const wasi = _wasi.get(this);
          await wasi.fds.renumber(to, from);
          return types_1.WasiErrno.ESUCCESS;
        }, ["i32", "i32"], ["i32"]);
        defineImport("fd_sync", function fd_sync(fd) {
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.FD_SYNC, BigInt(0));
          const fs2 = getFs(this);
          fs2.fsyncSync(fileDescriptor.fd);
          return types_1.WasiErrno.ESUCCESS;
        }, async function fd_sync(fd) {
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.FD_SYNC, BigInt(0));
          await fileDescriptor.fd.sync();
          return types_1.WasiErrno.ESUCCESS;
        }, ["i32"], ["i32"]);
        defineImport("fd_write", function fd_write(fd, iovs, iovslen, size) {
          iovs = Number(iovs);
          size = Number(size);
          if (iovs === 0 && iovslen || size === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const { HEAPU8, view } = getMemory(this, Math.max(iovs + Number(iovslen) * 8, size + 4));
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.FD_WRITE, BigInt(0));
          if (!iovslen) {
            view.setUint32(size, 0, true);
            return types_1.WasiErrno.ESUCCESS;
          }
          const buffer = (0, fd_1.concatBuffer)(Array.from({ length: Number(iovslen) }, (_, i) => {
            const offset = iovs + i * 8;
            const buf = view.getInt32(offset, true);
            const bufLen = view.getUint32(offset + 4, true);
            return HEAPU8.subarray(buf, buf + bufLen);
          }));
          let nwritten;
          if (fd === 1 || fd === 2) {
            nwritten = fileDescriptor.write(buffer);
          } else {
            const fs2 = getFs(this);
            nwritten = fs2.writeSync(fileDescriptor.fd, buffer, 0, buffer.length, Number(fileDescriptor.pos));
            fileDescriptor.pos += BigInt(nwritten);
          }
          view.setUint32(size, nwritten, true);
          return types_1.WasiErrno.ESUCCESS;
        }, async function fd_write(fd, iovs, iovslen, size) {
          iovs = Number(iovs);
          size = Number(size);
          if (iovs === 0 && iovslen || size === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const { HEAPU8, view } = getMemory(this, Math.max(iovs + Number(iovslen) * 8, size + 4));
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.FD_WRITE, BigInt(0));
          if (!iovslen) {
            view.setUint32(size, 0, true);
            return types_1.WasiErrno.ESUCCESS;
          }
          const buffer = (0, fd_1.concatBuffer)(Array.from({ length: Number(iovslen) }, (_, i) => {
            const offset = iovs + i * 8;
            const buf = view.getInt32(offset, true);
            const bufLen = view.getUint32(offset + 4, true);
            return HEAPU8.subarray(buf, buf + bufLen);
          }));
          let nwritten;
          if (fd === 1 || fd === 2) {
            nwritten = fileDescriptor.write(buffer);
          } else {
            nwritten = await (await fileDescriptor.fd.write(buffer, 0, buffer.length, Number(fileDescriptor.pos))).bytesWritten;
            fileDescriptor.pos += BigInt(nwritten);
          }
          view.setUint32(size, nwritten, true);
          return types_1.WasiErrno.ESUCCESS;
        }, ["i32", "i32", "i32", "i32"], ["i32"]);
        defineImport("path_create_directory", function path_create_directory(fd, path, path_len) {
          path = Number(path);
          path_len = Number(path_len);
          if (path === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const { HEAPU8 } = getMemory(this, path + path_len);
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.PATH_CREATE_DIRECTORY, BigInt(0));
          let pathString = decoder.decode((0, util_1.unsharedSlice)(HEAPU8, path, path + path_len));
          pathString = (0, path_1.resolve)(fileDescriptor.realPath, pathString);
          const fs2 = getFs(this);
          fs2.mkdirSync(pathString);
          return types_1.WasiErrno.ESUCCESS;
        }, async function path_create_directory(fd, path, path_len) {
          path = Number(path);
          path_len = Number(path_len);
          if (path === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const { HEAPU8 } = getMemory(this, path + path_len);
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.PATH_CREATE_DIRECTORY, BigInt(0));
          let pathString = decoder.decode((0, util_1.unsharedSlice)(HEAPU8, path, path + path_len));
          pathString = (0, path_1.resolve)(fileDescriptor.realPath, pathString);
          const fs2 = getFs(this);
          await fs2.promises.mkdir(pathString);
          return types_1.WasiErrno.ESUCCESS;
        }, ["i32", "i32", "i32"], ["i32"]);
        defineImport("path_filestat_get", function path_filestat_get(fd, flags, path, path_len, filestat) {
          path = Number(path);
          path_len = Number(path_len);
          filestat = Number(filestat);
          if (path === 0 || filestat === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const { HEAPU8, view } = getMemory(this, Math.max(path + path_len, filestat + 64));
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.PATH_FILESTAT_GET, BigInt(0));
          let pathString = decoder.decode((0, util_1.unsharedSlice)(HEAPU8, path, path + path_len));
          const fs2 = getFs(this);
          pathString = (0, path_1.resolve)(fileDescriptor.realPath, pathString);
          let stat;
          if ((flags & 1) === 1) {
            stat = fs2.statSync(pathString, { bigint: true });
          } else {
            stat = fs2.lstatSync(pathString, { bigint: true });
          }
          (0, fd_1.toFileStat)(view, filestat, stat);
          return types_1.WasiErrno.ESUCCESS;
        }, async function path_filestat_get(fd, flags, path, path_len, filestat) {
          path = Number(path);
          path_len = Number(path_len);
          filestat = Number(filestat);
          if (path === 0 || filestat === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const { HEAPU8, view } = getMemory(this, Math.max(path + path_len, filestat + 64));
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.PATH_FILESTAT_GET, BigInt(0));
          let pathString = decoder.decode((0, util_1.unsharedSlice)(HEAPU8, path, path + path_len));
          const fs2 = getFs(this);
          pathString = (0, path_1.resolve)(fileDescriptor.realPath, pathString);
          let stat;
          if ((flags & 1) === 1) {
            stat = await fs2.promises.stat(pathString, { bigint: true });
          } else {
            stat = await fs2.promises.lstat(pathString, { bigint: true });
          }
          (0, fd_1.toFileStat)(view, filestat, stat);
          return types_1.WasiErrno.ESUCCESS;
        }, ["i32", "i32", "i32", "i32", "i32"], ["i32"]);
        defineImport("path_filestat_set_times", function path_filestat_set_times(fd, flags, path, path_len, atim, mtim, fst_flags) {
          path = Number(path);
          path_len = Number(path_len);
          if (path === 0)
            return types_1.WasiErrno.EINVAL;
          const { HEAPU8 } = getMemory(this, path + path_len);
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.PATH_FILESTAT_SET_TIMES, BigInt(0));
          if (validateFstFlagsOrReturn(fst_flags)) {
            return types_1.WasiErrno.EINVAL;
          }
          const fs2 = getFs(this);
          const resolvedPath = resolvePathSync(fs2, fileDescriptor, decoder.decode((0, util_1.unsharedSlice)(HEAPU8, path, path + path_len)), flags);
          if ((fst_flags & types_1.WasiFstFlag.SET_ATIM_NOW) === types_1.WasiFstFlag.SET_ATIM_NOW) {
            atim = BigInt(Date.now() * 1e6);
          }
          if ((fst_flags & types_1.WasiFstFlag.SET_MTIM_NOW) === types_1.WasiFstFlag.SET_MTIM_NOW) {
            mtim = BigInt(Date.now() * 1e6);
          }
          fs2.utimesSync(resolvedPath, Number(atim), Number(mtim));
          return types_1.WasiErrno.ESUCCESS;
        }, async function path_filestat_set_times(fd, flags, path, path_len, atim, mtim, fst_flags) {
          path = Number(path);
          path_len = Number(path_len);
          if (path === 0)
            return types_1.WasiErrno.EINVAL;
          const { HEAPU8 } = getMemory(this, path + path_len);
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.PATH_FILESTAT_SET_TIMES, BigInt(0));
          if (validateFstFlagsOrReturn(fst_flags)) {
            return types_1.WasiErrno.EINVAL;
          }
          const fs2 = getFs(this);
          const resolvedPath = await resolvePathAsync(fs2, fileDescriptor, decoder.decode((0, util_1.unsharedSlice)(HEAPU8, path, path + path_len)), flags);
          if ((fst_flags & types_1.WasiFstFlag.SET_ATIM_NOW) === types_1.WasiFstFlag.SET_ATIM_NOW) {
            atim = BigInt(Date.now() * 1e6);
          }
          if ((fst_flags & types_1.WasiFstFlag.SET_MTIM_NOW) === types_1.WasiFstFlag.SET_MTIM_NOW) {
            mtim = BigInt(Date.now() * 1e6);
          }
          await fs2.promises.utimes(resolvedPath, Number(atim), Number(mtim));
          return types_1.WasiErrno.ESUCCESS;
        }, ["i32", "i32", "i32", "i32", "i64", "i64", "i32"], ["i32"]);
        defineImport("path_link", function path_link(old_fd, old_flags, old_path, old_path_len, new_fd, new_path, new_path_len) {
          old_path = Number(old_path);
          old_path_len = Number(old_path_len);
          new_path = Number(new_path);
          new_path_len = Number(new_path_len);
          if (old_path === 0 || new_path === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const wasi = _wasi.get(this);
          let oldWrap;
          let newWrap;
          if (old_fd === new_fd) {
            oldWrap = newWrap = wasi.fds.get(old_fd, types_1.WasiRights.PATH_LINK_SOURCE | types_1.WasiRights.PATH_LINK_TARGET, BigInt(0));
          } else {
            oldWrap = wasi.fds.get(old_fd, types_1.WasiRights.PATH_LINK_SOURCE, BigInt(0));
            newWrap = wasi.fds.get(new_fd, types_1.WasiRights.PATH_LINK_TARGET, BigInt(0));
          }
          const { HEAPU8 } = getMemory(this, Math.max(old_path + old_path_len, new_path + new_path_len));
          const fs2 = getFs(this);
          const resolvedOldPath = resolvePathSync(fs2, oldWrap, decoder.decode((0, util_1.unsharedSlice)(HEAPU8, old_path, old_path + old_path_len)), old_flags);
          const resolvedNewPath = (0, path_1.resolve)(newWrap.realPath, decoder.decode((0, util_1.unsharedSlice)(HEAPU8, new_path, new_path + new_path_len)));
          fs2.linkSync(resolvedOldPath, resolvedNewPath);
          return types_1.WasiErrno.ESUCCESS;
        }, async function path_link(old_fd, old_flags, old_path, old_path_len, new_fd, new_path, new_path_len) {
          old_path = Number(old_path);
          old_path_len = Number(old_path_len);
          new_path = Number(new_path);
          new_path_len = Number(new_path_len);
          if (old_path === 0 || new_path === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const wasi = _wasi.get(this);
          let oldWrap;
          let newWrap;
          if (old_fd === new_fd) {
            oldWrap = newWrap = wasi.fds.get(old_fd, types_1.WasiRights.PATH_LINK_SOURCE | types_1.WasiRights.PATH_LINK_TARGET, BigInt(0));
          } else {
            oldWrap = wasi.fds.get(old_fd, types_1.WasiRights.PATH_LINK_SOURCE, BigInt(0));
            newWrap = wasi.fds.get(new_fd, types_1.WasiRights.PATH_LINK_TARGET, BigInt(0));
          }
          const { HEAPU8 } = getMemory(this, Math.max(old_path + old_path_len, new_path + new_path_len));
          const fs2 = getFs(this);
          const resolvedOldPath = await resolvePathAsync(fs2, oldWrap, decoder.decode((0, util_1.unsharedSlice)(HEAPU8, old_path, old_path + old_path_len)), old_flags);
          const resolvedNewPath = (0, path_1.resolve)(newWrap.realPath, decoder.decode((0, util_1.unsharedSlice)(HEAPU8, new_path, new_path + new_path_len)));
          await fs2.promises.link(resolvedOldPath, resolvedNewPath);
          return types_1.WasiErrno.ESUCCESS;
        }, ["i32", "i32", "i32", "i32", "i32", "i32", "i32"], ["i32"]);
        function pathOpen(o_flags, fs_rights_base, fs_rights_inheriting, fs_flags) {
          const read = (fs_rights_base & (types_1.WasiRights.FD_READ | types_1.WasiRights.FD_READDIR)) !== BigInt(0);
          const write = (fs_rights_base & (types_1.WasiRights.FD_DATASYNC | types_1.WasiRights.FD_WRITE | types_1.WasiRights.FD_ALLOCATE | types_1.WasiRights.FD_FILESTAT_SET_SIZE)) !== BigInt(0);
          let flags = write ? read ? types_1.FileControlFlag.O_RDWR : types_1.FileControlFlag.O_WRONLY : types_1.FileControlFlag.O_RDONLY;
          let needed_base = types_1.WasiRights.PATH_OPEN;
          let needed_inheriting = fs_rights_base | fs_rights_inheriting;
          if ((o_flags & types_1.WasiFileControlFlag.O_CREAT) !== 0) {
            flags |= types_1.FileControlFlag.O_CREAT;
            needed_base |= types_1.WasiRights.PATH_CREATE_FILE;
          }
          if ((o_flags & types_1.WasiFileControlFlag.O_DIRECTORY) !== 0) {
            flags |= types_1.FileControlFlag.O_DIRECTORY;
          }
          if ((o_flags & types_1.WasiFileControlFlag.O_EXCL) !== 0) {
            flags |= types_1.FileControlFlag.O_EXCL;
          }
          if ((o_flags & types_1.WasiFileControlFlag.O_TRUNC) !== 0) {
            flags |= types_1.FileControlFlag.O_TRUNC;
            needed_base |= types_1.WasiRights.PATH_FILESTAT_SET_SIZE;
          }
          if ((fs_flags & types_1.WasiFdFlag.APPEND) !== 0) {
            flags |= types_1.FileControlFlag.O_APPEND;
          }
          if ((fs_flags & types_1.WasiFdFlag.DSYNC) !== 0) {
            needed_inheriting |= types_1.WasiRights.FD_DATASYNC;
          }
          if ((fs_flags & types_1.WasiFdFlag.NONBLOCK) !== 0) {
            flags |= types_1.FileControlFlag.O_NONBLOCK;
          }
          if ((fs_flags & types_1.WasiFdFlag.RSYNC) !== 0) {
            flags |= types_1.FileControlFlag.O_SYNC;
            needed_inheriting |= types_1.WasiRights.FD_SYNC;
          }
          if ((fs_flags & types_1.WasiFdFlag.SYNC) !== 0) {
            flags |= types_1.FileControlFlag.O_SYNC;
            needed_inheriting |= types_1.WasiRights.FD_SYNC;
          }
          if (write && (flags & (types_1.FileControlFlag.O_APPEND | types_1.FileControlFlag.O_TRUNC)) === 0) {
            needed_inheriting |= types_1.WasiRights.FD_SEEK;
          }
          return { flags, needed_base, needed_inheriting };
        }
        defineImport("path_open", function path_open(dirfd, dirflags, path, path_len, o_flags, fs_rights_base, fs_rights_inheriting, fs_flags, fd) {
          path = Number(path);
          fd = Number(fd);
          if (path === 0 || fd === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          path_len = Number(path_len);
          fs_rights_base = BigInt(fs_rights_base);
          fs_rights_inheriting = BigInt(fs_rights_inheriting);
          const { flags: flagsRes, needed_base: neededBase, needed_inheriting: neededInheriting } = pathOpen(o_flags, fs_rights_base, fs_rights_inheriting, fs_flags);
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(dirfd, neededBase, neededInheriting);
          const memory = getMemory(this, Math.max(path + path_len, fd + 4));
          const HEAPU8 = memory.HEAPU8;
          const pathString = decoder.decode((0, util_1.unsharedSlice)(HEAPU8, path, path + path_len));
          const fs2 = getFs(this);
          const resolved_path = resolvePathSync(fs2, fileDescriptor, pathString, dirflags);
          const r = fs2.openSync(resolved_path, _isWin32Flags ? _toWinOpenFlags(flagsRes) : flagsRes, 438);
          const filetype = wasi.fds.getFileTypeByFd(r);
          if (filetype !== types_1.WasiFileType.DIRECTORY && ((o_flags & types_1.WasiFileControlFlag.O_DIRECTORY) !== 0 || resolved_path.endsWith("/"))) {
            return types_1.WasiErrno.ENOTDIR;
          }
          const { base: max_base, inheriting: max_inheriting } = (0, rights_1.getRights)(wasi.fds.stdio, r, flagsRes, filetype);
          const wrap = wasi.fds.insert(r, resolved_path, resolved_path, filetype, fs_rights_base & max_base, fs_rights_inheriting & max_inheriting, 0);
          const stat = fs2.fstatSync(r, { bigint: true });
          if (stat.isFile()) {
            wrap.size = stat.size;
            if ((flagsRes & types_1.FileControlFlag.O_APPEND) !== 0) {
              wrap.pos = stat.size;
            }
          }
          const view = memory.view;
          view.setInt32(fd, wrap.id, true);
          return types_1.WasiErrno.ESUCCESS;
        }, async function path_open(dirfd, dirflags, path, path_len, o_flags, fs_rights_base, fs_rights_inheriting, fs_flags, fd) {
          path = Number(path);
          fd = Number(fd);
          if (path === 0 || fd === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          path_len = Number(path_len);
          fs_rights_base = BigInt(fs_rights_base);
          fs_rights_inheriting = BigInt(fs_rights_inheriting);
          const { flags: flagsRes, needed_base: neededBase, needed_inheriting: neededInheriting } = pathOpen(o_flags, fs_rights_base, fs_rights_inheriting, fs_flags);
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(dirfd, neededBase, neededInheriting);
          const memory = getMemory(this, Math.max(path + path_len, fd + 4));
          const HEAPU8 = memory.HEAPU8;
          const pathString = decoder.decode((0, util_1.unsharedSlice)(HEAPU8, path, path + path_len));
          const fs2 = getFs(this);
          const resolved_path = await resolvePathAsync(fs2, fileDescriptor, pathString, dirflags);
          const r = await fs2.promises.open(resolved_path, _isWin32Flags ? _toWinOpenFlags(flagsRes) : flagsRes, 438);
          const filetype = await wasi.fds.getFileTypeByFd(r);
          if ((o_flags & types_1.WasiFileControlFlag.O_DIRECTORY) !== 0 && filetype !== types_1.WasiFileType.DIRECTORY) {
            return types_1.WasiErrno.ENOTDIR;
          }
          const { base: max_base, inheriting: max_inheriting } = (0, rights_1.getRights)(wasi.fds.stdio, r.fd, flagsRes, filetype);
          const wrap = wasi.fds.insert(r, resolved_path, resolved_path, filetype, fs_rights_base & max_base, fs_rights_inheriting & max_inheriting, 0);
          const stat = await r.stat({ bigint: true });
          if (stat.isFile()) {
            wrap.size = stat.size;
            if ((flagsRes & types_1.FileControlFlag.O_APPEND) !== 0) {
              wrap.pos = stat.size;
            }
          }
          const view = memory.view;
          view.setInt32(fd, wrap.id, true);
          return types_1.WasiErrno.ESUCCESS;
        }, ["i32", "i32", "i32", "i32", "i32", "i64", "i64", "i32", "i32"], ["i32"]);
        defineImport("path_readlink", function path_readlink(fd, path, path_len, buf, buf_len, bufused) {
          path = Number(path);
          path_len = Number(path_len);
          buf = Number(buf);
          buf_len = Number(buf_len);
          bufused = Number(bufused);
          if (path === 0 || buf === 0 || bufused === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const { HEAPU8, view } = getMemory(this, Math.max(path + path_len, buf + buf_len, bufused + 4));
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.PATH_READLINK, BigInt(0));
          let pathString = decoder.decode((0, util_1.unsharedSlice)(HEAPU8, path, path + path_len));
          pathString = (0, path_1.resolve)(fileDescriptor.realPath, pathString);
          const fs2 = getFs(this);
          const link = fs2.readlinkSync(pathString);
          const linkData = encoder.encode(link);
          const len = Math.min(linkData.length, buf_len);
          if (len >= buf_len)
            return types_1.WasiErrno.ENOBUFS;
          HEAPU8.set(linkData.subarray(0, len), buf);
          HEAPU8[buf + len] = 0;
          view.setUint32(bufused, len, true);
          return types_1.WasiErrno.ESUCCESS;
        }, async function path_readlink(fd, path, path_len, buf, buf_len, bufused) {
          path = Number(path);
          path_len = Number(path_len);
          buf = Number(buf);
          buf_len = Number(buf_len);
          bufused = Number(bufused);
          if (path === 0 || buf === 0 || bufused === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const { HEAPU8, view } = getMemory(this, Math.max(path + path_len, buf + buf_len, bufused + 4));
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.PATH_READLINK, BigInt(0));
          let pathString = decoder.decode((0, util_1.unsharedSlice)(HEAPU8, path, path + path_len));
          pathString = (0, path_1.resolve)(fileDescriptor.realPath, pathString);
          const fs2 = getFs(this);
          const link = await fs2.promises.readlink(pathString);
          const linkData = encoder.encode(link);
          const len = Math.min(linkData.length, buf_len);
          if (len >= buf_len)
            return types_1.WasiErrno.ENOBUFS;
          HEAPU8.set(linkData.subarray(0, len), buf);
          HEAPU8[buf + len] = 0;
          view.setUint32(bufused, len, true);
          return types_1.WasiErrno.ESUCCESS;
        }, ["i32", "i32", "i32", "i32", "i32", "i32"], ["i32"]);
        defineImport("path_remove_directory", function path_remove_directory(fd, path, path_len) {
          path = Number(path);
          path_len = Number(path_len);
          if (path === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const { HEAPU8 } = getMemory(this, path + path_len);
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.PATH_REMOVE_DIRECTORY, BigInt(0));
          let pathString = decoder.decode((0, util_1.unsharedSlice)(HEAPU8, path, path + path_len));
          pathString = (0, path_1.resolve)(fileDescriptor.realPath, pathString);
          const fs2 = getFs(this);
          fs2.rmdirSync(pathString);
          return types_1.WasiErrno.ESUCCESS;
        }, async function path_remove_directory(fd, path, path_len) {
          path = Number(path);
          path_len = Number(path_len);
          if (path === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const { HEAPU8 } = getMemory(this, path + path_len);
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.PATH_REMOVE_DIRECTORY, BigInt(0));
          let pathString = decoder.decode((0, util_1.unsharedSlice)(HEAPU8, path, path + path_len));
          pathString = (0, path_1.resolve)(fileDescriptor.realPath, pathString);
          const fs2 = getFs(this);
          await fs2.promises.rmdir(pathString);
          return types_1.WasiErrno.ESUCCESS;
        }, ["i32", "i32", "i32"], ["i32"]);
        defineImport("path_rename", function path_rename(old_fd, old_path, old_path_len, new_fd, new_path, new_path_len) {
          old_path = Number(old_path);
          old_path_len = Number(old_path_len);
          new_path = Number(new_path);
          new_path_len = Number(new_path_len);
          if (old_path === 0 || new_path === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const wasi = _wasi.get(this);
          let oldWrap;
          let newWrap;
          if (old_fd === new_fd) {
            oldWrap = newWrap = wasi.fds.get(old_fd, types_1.WasiRights.PATH_RENAME_SOURCE | types_1.WasiRights.PATH_RENAME_TARGET, BigInt(0));
          } else {
            oldWrap = wasi.fds.get(old_fd, types_1.WasiRights.PATH_RENAME_SOURCE, BigInt(0));
            newWrap = wasi.fds.get(new_fd, types_1.WasiRights.PATH_RENAME_TARGET, BigInt(0));
          }
          const { HEAPU8 } = getMemory(this, Math.max(old_path + old_path_len, new_path + new_path_len));
          const resolvedOldPath = (0, path_1.resolve)(oldWrap.realPath, decoder.decode((0, util_1.unsharedSlice)(HEAPU8, old_path, old_path + old_path_len)));
          const resolvedNewPath = (0, path_1.resolve)(newWrap.realPath, decoder.decode((0, util_1.unsharedSlice)(HEAPU8, new_path, new_path + new_path_len)));
          const fs2 = getFs(this);
          fs2.renameSync(resolvedOldPath, resolvedNewPath);
          return types_1.WasiErrno.ESUCCESS;
        }, async function path_rename(old_fd, old_path, old_path_len, new_fd, new_path, new_path_len) {
          old_path = Number(old_path);
          old_path_len = Number(old_path_len);
          new_path = Number(new_path);
          new_path_len = Number(new_path_len);
          if (old_path === 0 || new_path === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const wasi = _wasi.get(this);
          let oldWrap;
          let newWrap;
          if (old_fd === new_fd) {
            oldWrap = newWrap = wasi.fds.get(old_fd, types_1.WasiRights.PATH_RENAME_SOURCE | types_1.WasiRights.PATH_RENAME_TARGET, BigInt(0));
          } else {
            oldWrap = wasi.fds.get(old_fd, types_1.WasiRights.PATH_RENAME_SOURCE, BigInt(0));
            newWrap = wasi.fds.get(new_fd, types_1.WasiRights.PATH_RENAME_TARGET, BigInt(0));
          }
          const { HEAPU8 } = getMemory(this, Math.max(old_path + old_path_len, new_path + new_path_len));
          const resolvedOldPath = (0, path_1.resolve)(oldWrap.realPath, decoder.decode((0, util_1.unsharedSlice)(HEAPU8, old_path, old_path + old_path_len)));
          const resolvedNewPath = (0, path_1.resolve)(newWrap.realPath, decoder.decode((0, util_1.unsharedSlice)(HEAPU8, new_path, new_path + new_path_len)));
          const fs2 = getFs(this);
          await fs2.promises.rename(resolvedOldPath, resolvedNewPath);
          return types_1.WasiErrno.ESUCCESS;
        }, ["i32", "i32", "i32", "i32", "i32", "i32"], ["i32"]);
        defineImport("path_symlink", function path_symlink(old_path, old_path_len, fd, new_path, new_path_len) {
          old_path = Number(old_path);
          old_path_len = Number(old_path_len);
          new_path = Number(new_path);
          new_path_len = Number(new_path_len);
          if (old_path === 0 || new_path === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const { HEAPU8 } = getMemory(this, Math.max(old_path + old_path_len, new_path + new_path_len));
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.PATH_SYMLINK, BigInt(0));
          const oldPath = decoder.decode((0, util_1.unsharedSlice)(HEAPU8, old_path, old_path + old_path_len));
          if (oldPath.length > 0 && oldPath[0] === "/") {
            return types_1.WasiErrno.EPERM;
          }
          let newPath = decoder.decode((0, util_1.unsharedSlice)(HEAPU8, new_path, new_path + new_path_len));
          newPath = (0, path_1.resolve)(fileDescriptor.realPath, newPath);
          const fs2 = getFs(this);
          fs2.symlinkSync(oldPath, newPath);
          return types_1.WasiErrno.ESUCCESS;
        }, async function path_symlink(old_path, old_path_len, fd, new_path, new_path_len) {
          old_path = Number(old_path);
          old_path_len = Number(old_path_len);
          new_path = Number(new_path);
          new_path_len = Number(new_path_len);
          if (old_path === 0 || new_path === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const { HEAPU8 } = getMemory(this, Math.max(old_path + old_path_len, new_path + new_path_len));
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.PATH_SYMLINK, BigInt(0));
          const oldPath = decoder.decode((0, util_1.unsharedSlice)(HEAPU8, old_path, old_path + old_path_len));
          let newPath = decoder.decode((0, util_1.unsharedSlice)(HEAPU8, new_path, new_path + new_path_len));
          newPath = (0, path_1.resolve)(fileDescriptor.realPath, newPath);
          const fs2 = getFs(this);
          await fs2.promises.symlink(oldPath, newPath);
          return types_1.WasiErrno.ESUCCESS;
        }, ["i32", "i32", "i32", "i32", "i32"], ["i32"]);
        defineImport("path_unlink_file", function path_unlink_file(fd, path, path_len) {
          path = Number(path);
          path_len = Number(path_len);
          if (path === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const { HEAPU8 } = getMemory(this, path + path_len);
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.PATH_UNLINK_FILE, BigInt(0));
          let pathString = decoder.decode((0, util_1.unsharedSlice)(HEAPU8, path, path + path_len));
          pathString = (0, path_1.resolve)(fileDescriptor.realPath, pathString);
          const fs2 = getFs(this);
          fs2.unlinkSync(pathString);
          return types_1.WasiErrno.ESUCCESS;
        }, async function path_unlink_file(fd, path, path_len) {
          path = Number(path);
          path_len = Number(path_len);
          if (path === 0) {
            return types_1.WasiErrno.EINVAL;
          }
          const { HEAPU8 } = getMemory(this, path + path_len);
          const wasi = _wasi.get(this);
          const fileDescriptor = wasi.fds.get(fd, types_1.WasiRights.PATH_UNLINK_FILE, BigInt(0));
          let pathString = decoder.decode((0, util_1.unsharedSlice)(HEAPU8, path, path + path_len));
          pathString = (0, path_1.resolve)(fileDescriptor.realPath, pathString);
          const fs2 = getFs(this);
          await fs2.promises.unlink(pathString);
          return types_1.WasiErrno.ESUCCESS;
        }, ["i32", "i32", "i32"], ["i32"]);
        this._setMemory = function setMemory(m) {
          if (!(m instanceof webassembly_1._WebAssembly.Memory)) {
            throw new TypeError('"instance.exports.memory" property must be a WebAssembly.Memory');
          }
          _memory.set(_this, (0, memory_1.extendMemory)(m));
        };
      }
      static createSync(args, env, preopens, stdio, fs, print, printErr) {
        const fds = new fd_1.SyncTable({
          size: 3,
          in: stdio[0],
          out: stdio[1],
          err: stdio[2],
          fs,
          print,
          printErr
        });
        const _this = new _WASI(args, env, fds, false, fs);
        if (preopens.length > 0) {
          for (let i = 0; i < preopens.length; ++i) {
            const realPath = fs.realpathSync(preopens[i].realPath, "utf8");
            const fd = fs.openSync(realPath, "r", 438);
            fds.insertPreopen(fd, preopens[i].mappedPath, realPath);
          }
        }
        return _this;
      }
      static async createAsync(args, env, preopens, stdio, fs, print, printErr, asyncify) {
        const fds = new fd_1.AsyncTable({
          size: 3,
          in: stdio[0],
          out: stdio[1],
          err: stdio[2],
          print,
          printErr
        });
        const _this = new _WASI(args, env, fds, true, fs, asyncify);
        if (preopens.length > 0) {
          for (let i = 0; i < preopens.length; ++i) {
            const entry = preopens[i];
            const realPath = await fs.promises.realpath(entry.realPath);
            const fd = await fs.promises.open(realPath, "r", 438);
            await fds.insertPreopen(fd, entry.mappedPath, realPath);
          }
        }
        return _this;
      }
    };
    exports2.WASI = WASI2;
  }
});

// node_modules/@tybys/wasm-util/lib/cjs/wasi/index.js
var require_wasi = __commonJS({
  "node_modules/@tybys/wasm-util/lib/cjs/wasi/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    exports2.createAsyncWASI = exports2.WASI = void 0;
    var preview1_1 = require_preview1();
    var util_1 = require_util();
    var kEmptyObject = /* @__PURE__ */ Object.freeze(/* @__PURE__ */ Object.create(null));
    var kExitCode = Symbol("kExitCode");
    var kSetMemory = Symbol("kSetMemory");
    var kStarted = Symbol("kStarted");
    var kInstance = Symbol("kInstance");
    var kBindingName = Symbol("kBindingName");
    function validateOptions(options) {
      var _a;
      (0, util_1.validateObject)(options, "options");
      let _WASI;
      if (options.version !== void 0) {
        (0, util_1.validateString)(options.version, "options.version");
        switch (options.version) {
          case "unstable":
            _WASI = preview1_1.WASI;
            this[kBindingName] = "wasi_unstable";
            break;
          case "preview1":
            _WASI = preview1_1.WASI;
            this[kBindingName] = "wasi_snapshot_preview1";
            break;
          default:
            throw new TypeError(`unsupported WASI version "${options.version}"`);
        }
      } else {
        _WASI = preview1_1.WASI;
        this[kBindingName] = "wasi_snapshot_preview1";
      }
      if (options.args !== void 0) {
        (0, util_1.validateArray)(options.args, "options.args");
      }
      const args = ((_a = options.args) !== null && _a !== void 0 ? _a : []).map(String);
      const env = [];
      if (options.env !== void 0) {
        (0, util_1.validateObject)(options.env, "options.env");
        Object.entries(options.env).forEach(({ 0: key, 1: value }) => {
          if (value !== void 0) {
            env.push(`${key}=${value}`);
          }
        });
      }
      const preopens = [];
      if (options.preopens !== void 0) {
        (0, util_1.validateObject)(options.preopens, "options.preopens");
        Object.entries(options.preopens).forEach(({ 0: key, 1: value }) => preopens.push({ mappedPath: String(key), realPath: String(value) }));
      }
      if (preopens.length > 0) {
        if (options.fs === void 0) {
          throw new Error("filesystem is disabled, can not preopen directory");
        }
        try {
          (0, util_1.validateObject)(options.fs, "options.fs");
        } catch (_) {
          throw new TypeError("Node.js fs like implementation is not provided");
        }
      }
      if (options.print !== void 0)
        (0, util_1.validateFunction)(options.print, "options.print");
      if (options.printErr !== void 0)
        (0, util_1.validateFunction)(options.printErr, "options.printErr");
      if (options.returnOnExit !== void 0) {
        (0, util_1.validateBoolean)(options.returnOnExit, "options.returnOnExit");
      }
      const stdio = [0, 1, 2];
      return {
        args,
        env,
        preopens,
        stdio,
        _WASI
      };
    }
    function initWASI(setMemory, wrap) {
      this[kSetMemory] = setMemory;
      this.wasiImport = wrap;
      this[kStarted] = false;
      this[kExitCode] = 0;
      this[kInstance] = void 0;
    }
    var WASI2 = class {
      constructor(options = kEmptyObject) {
        const { args, env, preopens, stdio, _WASI: _WASI2 } = validateOptions.call(this, options);
        const wrap = _WASI2.createSync(args, env, preopens, stdio, options.fs, options.print, options.printErr);
        const setMemory = wrap._setMemory;
        delete wrap._setMemory;
        initWASI.call(this, setMemory, wrap);
        if (options.returnOnExit) {
          wrap.proc_exit = wasiReturnOnProcExit.bind(this);
        }
      }
      finalizeBindings(instance, _a) {
        var _b;
        var { memory = (_b = instance === null || instance === void 0 ? void 0 : instance.exports) === null || _b === void 0 ? void 0 : _b.memory } = _a === void 0 ? {} : _a;
        if (this[kStarted]) {
          throw new Error("WASI instance has already started");
        }
        (0, util_1.validateObject)(instance, "instance");
        (0, util_1.validateObject)(instance.exports, "instance.exports");
        this[kSetMemory](memory);
        this[kInstance] = instance;
        this[kStarted] = true;
      }
      // Must not export _initialize, must export _start
      start(instance) {
        this.finalizeBindings(instance);
        const { _start, _initialize } = this[kInstance].exports;
        (0, util_1.validateFunction)(_start, "instance.exports._start");
        (0, util_1.validateUndefined)(_initialize, "instance.exports._initialize");
        let ret;
        try {
          ret = _start();
        } catch (err) {
          if (err !== kExitCode) {
            throw err;
          }
        }
        if (ret instanceof Promise) {
          return ret.then(() => this[kExitCode], (err) => {
            if (err !== kExitCode) {
              throw err;
            }
            return this[kExitCode];
          });
        }
        return this[kExitCode];
      }
      // Must not export _start, may optionally export _initialize
      initialize(instance) {
        this.finalizeBindings(instance);
        const { _start, _initialize } = this[kInstance].exports;
        (0, util_1.validateUndefined)(_start, "instance.exports._start");
        if (_initialize !== void 0) {
          (0, util_1.validateFunction)(_initialize, "instance.exports._initialize");
          return _initialize();
        }
      }
      getImportObject() {
        return { [this[kBindingName]]: this.wasiImport };
      }
    };
    exports2.WASI = WASI2;
    function wasiReturnOnProcExit(rval) {
      this[kExitCode] = rval;
      throw kExitCode;
    }
    async function createAsyncWASI(options = kEmptyObject) {
      const _this = Object.create(WASI2.prototype);
      const { args, env, preopens, stdio, _WASI } = validateOptions.call(_this, options);
      if (options.asyncify !== void 0) {
        (0, util_1.validateObject)(options.asyncify, "options.asyncify");
        (0, util_1.validateFunction)(options.asyncify.wrapImportFunction, "options.asyncify.wrapImportFunction");
      }
      const wrap = await _WASI.createAsync(args, env, preopens, stdio, options.fs, options.print, options.printErr, options.asyncify);
      const setMemory = wrap._setMemory;
      delete wrap._setMemory;
      initWASI.call(_this, setMemory, wrap);
      if (options.returnOnExit) {
        wrap.proc_exit = wasiReturnOnProcExit.bind(_this);
      }
      return _this;
    }
    exports2.createAsyncWASI = createAsyncWASI;
  }
});

// node_modules/@tybys/wasm-util/lib/cjs/wasi/fs.js
var require_fs = __commonJS({
  "node_modules/@tybys/wasm-util/lib/cjs/wasi/fs.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
  }
});

// node_modules/@tybys/wasm-util/lib/cjs/index.js
var require_cjs = __commonJS({
  "node_modules/@tybys/wasm-util/lib/cjs/index.js"(exports2) {
    "use strict";
    Object.defineProperty(exports2, "__esModule", { value: true });
    var tslib_1 = require_tslib();
    tslib_1.__exportStar(require_asyncify(), exports2);
    tslib_1.__exportStar(require_load(), exports2);
    tslib_1.__exportStar(require_wasi(), exports2);
    tslib_1.__exportStar(require_memory(), exports2);
    tslib_1.__exportStar(require_jspi(), exports2);
    tslib_1.__exportStar(require_fs(), exports2);
  }
});

// node_modules/@napi-rs/wasm-runtime/fs-proxy.cjs
var require_fs_proxy = __commonJS({
  "node_modules/@napi-rs/wasm-runtime/fs-proxy.cjs"(exports2, module2) {
    var getType = (value) => {
      if (value === void 0) return 0;
      if (value === null) return 1;
      const t = typeof value;
      if (t === "boolean") return 2;
      if (t === "number") return 3;
      if (t === "string") return 4;
      if (t === "object") return 6;
      if (t === "bigint") return 9;
      return -1;
    };
    var encodeValue = (memfs, value, type) => {
      switch (type) {
        case 0:
        case 1:
          return new Uint8Array(0);
        case 2: {
          const view = new Int32Array(1);
          view[0] = value ? 1 : 0;
          return new Uint8Array(view.buffer);
        }
        case 3: {
          const view = new Float64Array(1);
          view[0] = value;
          return new Uint8Array(view.buffer);
        }
        case 4: {
          const view = new TextEncoder().encode(value);
          return view;
        }
        case 6: {
          const [entry] = Object.entries(memfs).filter(([_, v]) => v === value.constructor)[0] ?? [];
          if (entry) {
            Object.defineProperty(value, "__constructor__", {
              configurable: true,
              writable: true,
              enumerable: true,
              value: entry
            });
          }
          const json = JSON.stringify(value, (_, value2) => {
            if (typeof value2 === "bigint") {
              return `BigInt(${String(value2)})`;
            }
            if (value2 instanceof Error) {
              return {
                ...value2,
                message: value2.message,
                stack: value2.stack,
                __error__: value2.constructor.name
              };
            }
            return value2;
          });
          const view = new TextEncoder().encode(json);
          return view;
        }
        case 9: {
          const view = new BigInt64Array(1);
          view[0] = value;
          return new Uint8Array(view.buffer);
        }
        case -1:
        default:
          throw new Error("unsupported data");
      }
    };
    var decodeValue = (memfs, payload, type) => {
      if (type === 0) return void 0;
      if (type === 1) return null;
      if (type === 2) return Boolean(new Int32Array(payload.buffer, payload.byteOffset, 1)[0]);
      if (type === 3) return new Float64Array(payload.buffer, payload.byteOffset, 1)[0];
      if (type === 4) return new TextDecoder().decode(payload.slice());
      if (type === 6) {
        const obj = JSON.parse(new TextDecoder().decode(payload.slice()), (_key, value) => {
          if (typeof value === "string") {
            const matched = value.match(/^BigInt\((-?\d+)\)$/);
            if (matched && matched[1]) {
              return BigInt(matched[1]);
            }
          }
          return value;
        });
        if (obj.__constructor__) {
          const ctor = obj.__constructor__;
          delete obj.__constructor__;
          Object.setPrototypeOf(obj, memfs[ctor].prototype);
        }
        if (obj.__error__) {
          const name = obj.__error__;
          const ErrorConstructor = globalThis[name] || Error;
          delete obj.__error__;
          const err = new ErrorConstructor(obj.message);
          Object.defineProperty(err, "stack", {
            configurable: true,
            enumerable: false,
            writable: true,
            value: err.stack
          });
          Object.defineProperty(err, Symbol.toStringTag, {
            configurable: true,
            enumerable: false,
            writable: true,
            value: name
          });
          for (const [k, v] of Object.entries(obj)) {
            if (k === "message" || k === "stack") continue;
            err[k] = v;
          }
          return err;
        }
        return obj;
      }
      if (type === 9) return new BigInt64Array(payload.buffer, payload.byteOffset, 1)[0];
      throw new Error("unsupported data");
    };
    module2.exports.createOnMessage = (fs) => function onMessage(e) {
      if (e.data.__fs__) {
        const { sab, type, payload } = e.data.__fs__;
        const fn = fs[type];
        try {
          const ret = fn.apply(fs, payload);
          const t = getType(ret);
          Atomics.store(sab, 1, t);
          const v = encodeValue(fs, ret, t);
          Atomics.store(sab, 2, v.length);
          new Uint8Array(sab.buffer).set(v, 16);
          Atomics.store(sab, 0, 0);
        } catch (err) {
          const t = getType(err);
          Atomics.store(sab, 1, t);
          const v = encodeValue(fs, err, t);
          Atomics.store(sab, 2, v.length);
          new Uint8Array(sab.buffer).set(v, 16);
          Atomics.store(sab, 0, 1);
        } finally {
          Atomics.notify(sab, 0);
        }
      }
    };
    module2.exports.createFsProxy = (memfs) => new Proxy({}, {
      get(_target, p, _receiver) {
        return function(...args) {
          const sab = new SharedArrayBuffer(16 + 10240);
          const i32arr = new Int32Array(sab);
          Atomics.store(i32arr, 0, 21);
          postMessage({
            __fs__: {
              sab: i32arr,
              type: p,
              payload: args
            }
          });
          Atomics.wait(i32arr, 0, 21);
          const status = Atomics.load(i32arr, 0);
          const type = Atomics.load(i32arr, 1);
          const size = Atomics.load(i32arr, 2);
          const content = new Uint8Array(sab, 16, size);
          const value = decodeValue(memfs, content, type);
          if (status === 1) {
            throw value;
          }
          return value;
        };
      }
    });
  }
});

// node_modules/@napi-rs/wasm-runtime/runtime.cjs
var { MessageHandler, instantiateNapiModuleSync, instantiateNapiModule } = require_core();
var { getDefaultContext } = require_runtime();
var { WASI } = require_cjs();
var { createFsProxy, createOnMessage } = require_fs_proxy();
module.exports = {
  MessageHandler,
  instantiateNapiModule,
  instantiateNapiModuleSync,
  getDefaultContext,
  WASI,
  createFsProxy,
  createOnMessage
};

}
