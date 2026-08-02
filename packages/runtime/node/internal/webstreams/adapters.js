// internal/webstreams/adapters — WHATWG <-> Node stream interop.
//
// ADAPTED (not verbatim) from Node.js v24.18.0 lib/internal/webstreams/adapters.js
// Source: https://github.com/nodejs/node/blob/v24.18.0/lib/internal/webstreams/adapters.js
//
// This is the seam behind Readable.fromWeb/toWeb, Writable.fromWeb/toWeb and
// Duplex.fromWeb/toWeb — how in-VM Node streams meet the platform's WHATWG
// streams (fetch/Response bodies, Blob/File, the preview Service Worker path).
// The vendored stream core requires it LAZILY, from inside those six statics.
//
// Why it is not vendored verbatim like internal/streams/*:
//   * Upstream builds on Node's OWN bundled Web Streams implementation
//     (internal/webstreams/{readablestream,writablestream,queuingstrategies}).
//     Vivari bundles none: `stream/web` (see node/loader.js) re-exports whichever
//     WHATWG globals the host realm provides — the browser Worker's own classes
//     in the studio, Node's globals in the headless twin. So the classes are
//     resolved from `globalThis`.
//   * Upstream uses the `SafePromiseAll` / `SafePromisePrototypeFinally`
//     primordials, which node/primordials.js cannot resolve (they don't follow
//     the <Ns><Member> naming scheme) — reading them THROWS. This file therefore
//     uses plain intrinsics, like the other hand-written internal/* modules.
//
// Control flow otherwise mirrors upstream function-for-function. Deliberate
// behavioural divergences, all of them local and commented at the site:
//   * `isReadableStream`/`isWritableStream` come from internal/streams/utils
//     (duck-typing) rather than upstream's brand checks, because there is no
//     bundled implementation to brand-check against.
//   * `finished` is bound as `{ eos: finished }` — this tree's
//     internal/streams/end-of-stream exports a pair, not a callable module.
//     Re-vendoring upstream's import line reintroduces the bug it caused.
//   * `writev` splits its fulfilled/rejected handlers (upstream shares one and
//     then calls `.filter()` on the rejection reason, which is an Error).
//   * newWritableStreamFromStreamBase / newReadableStreamFromStreamBase are not
//     implemented and throw — see the note at their definition.
export default function (exports, require, module, process, internalBinding, primordials) {
  "use strict";

  const { Writable, Readable, Duplex, destroy } = require("stream");
  // Upstream's end-of-stream sets `module.exports = eos` and hangs `finished` off
  // it; ours exports `{ eos, finished }`, where `finished` is the promise form.
  // The adapters want the callback form that returns a cleanup function: `eos`.
  const { eos: finished } = require("internal/streams/end-of-stream");
  const {
    isDestroyed,
    isReadable,
    isWritable,
    isWritableEnded,
    isReadableStream,
    isWritableStream,
  } = require("internal/streams/utils");
  const { Buffer } = require("buffer");
  const { TextEncoder } = require("internal/encoding");
  const { kEmptyObject, normalizeEncoding } = require("internal/util");
  const { validateBoolean, validateObject } = require("internal/validators");
  const {
    AbortError,
    codes: {
      ERR_INVALID_ARG_TYPE,
      ERR_INVALID_ARG_VALUE,
      ERR_STREAM_PREMATURE_CLOSE,
    },
  } = require("internal/errors");

  const encoder = new TextEncoder();

  // The WHATWG classes live on the host realm, so resolve them per call rather
  // than at module load: a realm that lacks them then fails at the conversion
  // with an accurate message instead of a bare ReferenceError at require time.
  function webClass(name) {
    const C = globalThis[name];
    if (typeof C !== "function") {
      const err = new Error(
        `Vivari: cannot convert between Node and Web streams — this realm has no ` +
          `global ${name}. Web Streams are not bundled; \`stream/web\` re-exports ` +
          `whatever the host realm provides (see node/loader.js).`,
      );
      err.code = "ERR_METHOD_NOT_IMPLEMENTED";
      throw err;
    }
    return C;
  }

  // Queuing strategies, likewise from the host realm. The fallbacks are exactly
  // equivalent: a strategy with no `size` counts chunks (CountQueuingStrategy),
  // and byte mode sizes by byteLength (ByteLengthQueuingStrategy).
  function countStrategy(highWaterMark) {
    const C = globalThis.CountQueuingStrategy;
    return typeof C === "function" ? new C({ highWaterMark }) : { highWaterMark };
  }

  function byteLengthStrategy(highWaterMark) {
    const C = globalThis.ByteLengthQueuingStrategy;
    return typeof C === "function"
      ? new C({ highWaterMark })
      : { highWaterMark, size: (chunk) => chunk.byteLength };
  }

  function createDeferredPromise() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  // Collect all negative (error) ZLIB codes and Z_NEED_DICT.
  const ZLIB_FAILURES = new Set([
    ...Object.entries(internalBinding("constants").zlib || {})
      .filter(([, value]) => value < 0)
      .map(([code]) => code),
    "Z_NEED_DICT",
  ]);

  function handleKnownInternalErrors(cause) {
    switch (true) {
      case cause?.code === "ERR_STREAM_PREMATURE_CLOSE": {
        return new AbortError(undefined, { cause });
      }
      case ZLIB_FAILURES.has(cause?.code): {
        const error = new TypeError(undefined, { cause });
        error.code = cause.code;
        return error;
      }
      default:
        return cause;
    }
  }

  // ---------------------------------------------------------------------------
  // Writable.toWeb(streamWritable)
  // ---------------------------------------------------------------------------
  function newWritableStreamFromStreamWritable(streamWritable) {
    const WritableStream = webClass("WritableStream");

    // Not using isWritableNodeStream here because it returns false for a Duplex
    // whose writable option is false. For such a Duplex we want the check to
    // pass but to hand back a closed WritableStream. This also admits
    // http.OutgoingMessage.
    const checkIfWritableOrOutgoingMessage =
      streamWritable &&
      typeof streamWritable?.write === "function" &&
      typeof streamWritable?.on === "function";
    if (!checkIfWritableOrOutgoingMessage) {
      throw new ERR_INVALID_ARG_TYPE(
        "streamWritable",
        "stream.Writable",
        streamWritable,
      );
    }

    if (isDestroyed(streamWritable) || !isWritable(streamWritable)) {
      const writable = new WritableStream();
      writable.close();
      return writable;
    }

    const highWaterMark = streamWritable.writableHighWaterMark;
    const strategy = streamWritable.writableObjectMode
      ? countStrategy(highWaterMark)
      : { highWaterMark };

    let controller;
    let backpressurePromise;
    let closed;

    function onDrain() {
      if (backpressurePromise !== undefined) backpressurePromise.resolve();
    }

    const cleanup = finished(streamWritable, (error) => {
      error = handleKnownInternalErrors(error);

      cleanup();
      // Protection against non-standard, legacy streams that emit 'error' again
      // after finished() has fired.
      streamWritable.on("error", () => {});
      if (error != null) {
        if (backpressurePromise !== undefined) backpressurePromise.reject(error);
        // A non-undefined `closed` means the error arrived after the
        // WritableStream close already started; reject that too.
        if (closed !== undefined) {
          closed.reject(error);
          closed = undefined;
        }
        controller.error(error);
        controller = undefined;
        return;
      }

      if (closed !== undefined) {
        closed.resolve();
        closed = undefined;
        return;
      }
      controller.error(new AbortError());
      controller = undefined;
    });

    streamWritable.on("drain", onDrain);

    return new WritableStream(
      {
        start(c) {
          controller = c;
        },

        write(chunk) {
          if (streamWritable.writableNeedDrain || !streamWritable.write(chunk)) {
            backpressurePromise = createDeferredPromise();
            return backpressurePromise.promise.finally(() => {
              backpressurePromise = undefined;
            });
          }
        },

        abort(reason) {
          destroy(streamWritable, reason);
        },

        close() {
          if (closed === undefined && !isWritableEnded(streamWritable)) {
            closed = createDeferredPromise();
            streamWritable.end();
            return closed.promise;
          }

          controller = undefined;
          return Promise.resolve();
        },
      },
      strategy,
    );
  }

  // ---------------------------------------------------------------------------
  // Writable.fromWeb(writableStream[, options])
  // ---------------------------------------------------------------------------
  function newStreamWritableFromWritableStream(writableStream, options = kEmptyObject) {
    if (!isWritableStream(writableStream)) {
      throw new ERR_INVALID_ARG_TYPE(
        "writableStream",
        "WritableStream",
        writableStream,
      );
    }

    validateObject(options, "options");
    const {
      highWaterMark,
      decodeStrings = true,
      objectMode = false,
      signal,
    } = options;

    validateBoolean(objectMode, "options.objectMode");
    validateBoolean(decodeStrings, "options.decodeStrings");

    const writer = writableStream.getWriter();
    let closed = false;

    const writable = new Writable({
      highWaterMark,
      objectMode,
      decodeStrings,
      signal,

      writev(chunks, callback) {
        // Divergence from upstream: upstream installs a single `done(error)` as
        // BOTH handlers and starts it with `error.filter(...)`, which throws a
        // TypeError whenever it is reached through the rejection path (the
        // reason is an Error, not an array of them) — the write failure is then
        // lost as an unhandled rejection. Split the two handlers instead.
        function done(error) {
          try {
            callback(error);
          } catch (err) {
            // In a next tick because this is happening within a promise
            // context: a throw here would surface as an unhandled rejection.
            process.nextTick(() => destroy(writable, err));
          }
        }

        writer.ready.then(
          () =>
            Promise.all(chunks.map((data) => writer.write(data.chunk))).then(
              () => done(),
              done,
            ),
          done,
        );
      },

      write(chunk, encoding, callback) {
        if (typeof chunk === "string" && decodeStrings && !objectMode) {
          const enc = normalizeEncoding(encoding);

          if (enc === "utf8") {
            chunk = encoder.encode(chunk);
          } else {
            chunk = Buffer.from(chunk, encoding);
            chunk = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          }
        }

        function done(error) {
          try {
            callback(error);
          } catch (err) {
            destroy(writable, err);
          }
        }

        writer.ready.then(
          () => writer.write(chunk).then(() => done(), done),
          done,
        );
      },

      destroy(error, callback) {
        function done() {
          try {
            callback(error);
          } catch (err) {
            // In a next tick because this is happening within a promise
            // context: a throw here would surface as an unhandled rejection.
            process.nextTick(() => {
              throw err;
            });
          }
        }

        if (!closed) {
          if (error != null) {
            writer.abort(error).then(done, done);
          } else {
            writer.close().then(done, done);
          }
          return;
        }

        done();
      },

      final(callback) {
        function done(error) {
          try {
            callback(error);
          } catch (err) {
            process.nextTick(() => destroy(writable, err));
          }
        }

        if (!closed) {
          writer.close().then(() => done(), done);
        }
      },
    });

    writer.closed.then(
      () => {
        // If the WritableStream closes before the stream.Writable has been
        // ended, signal an error on the stream.Writable.
        closed = true;
        if (!isWritableEnded(writable))
          destroy(writable, new ERR_STREAM_PREMATURE_CLOSE());
      },
      (error) => {
        // If the WritableStream errors before the stream.Writable has been
        // destroyed, signal an error on the stream.Writable.
        closed = true;
        destroy(writable, error);
      },
    );

    return writable;
  }

  // ---------------------------------------------------------------------------
  // Readable.toWeb(streamReadable[, options])
  // ---------------------------------------------------------------------------
  function newReadableStreamFromStreamReadable(streamReadable, options = kEmptyObject) {
    const ReadableStream = webClass("ReadableStream");

    // Not using isReadableNodeStream here because it returns false for a Duplex
    // whose readable option is false. For such a Duplex we want the check to
    // pass but to hand back a closed ReadableStream.
    if (typeof streamReadable?._readableState !== "object") {
      throw new ERR_INVALID_ARG_TYPE(
        "streamReadable",
        "stream.Readable",
        streamReadable,
      );
    }

    if (isDestroyed(streamReadable) || !isReadable(streamReadable)) {
      const readable = new ReadableStream();
      readable.cancel();
      return readable;
    }

    const objectMode = streamReadable.readableObjectMode;
    const highWaterMark = streamReadable.readableHighWaterMark;

    const evaluateStrategyOrFallback = (strategy) => {
      // If there is a strategy available, use it.
      if (strategy) return strategy;

      if (objectMode) {
        // Running in objectMode with no strategy: fall back to counting chunks.
        return countStrategy(highWaterMark);
      }

      return byteLengthStrategy(highWaterMark);
    };

    const strategy = evaluateStrategyOrFallback(options?.strategy);

    let controller;
    let wasCanceled = false;

    function onData(chunk) {
      // Copy the Buffer to detach it from the pool.
      if (Buffer.isBuffer(chunk) && !objectMode) chunk = new Uint8Array(chunk);
      controller.enqueue(chunk);
      if (controller.desiredSize <= 0) streamReadable.pause();
    }

    streamReadable.pause();

    const cleanup = finished(streamReadable, (error) => {
      error = handleKnownInternalErrors(error);

      cleanup();
      // Protection against non-standard, legacy streams that emit 'error' again
      // after finished() has fired.
      streamReadable.on("error", () => {});
      if (error) return controller.error(error);
      // Was already canceled.
      if (wasCanceled) {
        return;
      }
      controller.close();
    });

    streamReadable.on("data", onData);

    return new ReadableStream(
      {
        start(c) {
          controller = c;
        },

        pull() {
          streamReadable.resume();
        },

        cancel(reason) {
          wasCanceled = true;
          destroy(streamReadable, reason);
        },
      },
      strategy,
    );
  }

  // ---------------------------------------------------------------------------
  // Readable.fromWeb(readableStream[, options])
  // ---------------------------------------------------------------------------
  function newStreamReadableFromReadableStream(readableStream, options = kEmptyObject) {
    if (!isReadableStream(readableStream)) {
      throw new ERR_INVALID_ARG_TYPE(
        "readableStream",
        "ReadableStream",
        readableStream,
      );
    }

    validateObject(options, "options");
    const { highWaterMark, encoding, objectMode = false, signal } = options;

    if (encoding !== undefined && !Buffer.isEncoding(encoding))
      throw new ERR_INVALID_ARG_VALUE(encoding, "options.encoding");
    validateBoolean(objectMode, "options.objectMode");

    const reader = readableStream.getReader();
    let closed = false;

    const readable = new Readable({
      objectMode,
      highWaterMark,
      encoding,
      signal,

      read() {
        reader.read().then(
          (chunk) => {
            if (chunk.done) {
              // Value should always be undefined here.
              readable.push(null);
            } else {
              readable.push(chunk.value);
            }
          },
          (error) => destroy(readable, error),
        );
      },

      destroy(error, callback) {
        function done() {
          try {
            callback(error);
          } catch (err) {
            // In a next tick because this is happening within a promise
            // context: a throw here would surface as an unhandled rejection.
            process.nextTick(() => {
              throw err;
            });
          }
        }

        if (!closed) {
          reader.cancel(error).then(done, done);
          return;
        }
        done();
      },
    });

    reader.closed.then(
      () => {
        closed = true;
      },
      (error) => {
        closed = true;
        destroy(readable, error);
      },
    );

    return readable;
  }

  // ---------------------------------------------------------------------------
  // Duplex.toWeb(duplex)
  // ---------------------------------------------------------------------------
  function newReadableWritablePairFromDuplex(duplex) {
    const ReadableStream = webClass("ReadableStream");
    const WritableStream = webClass("WritableStream");

    // Not using isWritableNodeStream/isReadableNodeStream here because they
    // return false when the duplex was created with writable or readable set to
    // false. Check the states below instead and hand back a closed
    // WritableStream / ReadableStream as necessary.
    if (
      typeof duplex?._writableState !== "object" ||
      typeof duplex?._readableState !== "object"
    ) {
      throw new ERR_INVALID_ARG_TYPE("duplex", "stream.Duplex", duplex);
    }

    if (isDestroyed(duplex)) {
      const writable = new WritableStream();
      const readable = new ReadableStream();
      writable.close();
      readable.cancel();
      return { readable, writable };
    }

    const writable = isWritable(duplex)
      ? newWritableStreamFromStreamWritable(duplex)
      : new WritableStream();

    if (!isWritable(duplex)) writable.close();

    const readable = isReadable(duplex)
      ? newReadableStreamFromStreamReadable(duplex)
      : new ReadableStream();

    if (!isReadable(duplex)) readable.cancel();

    return { writable, readable };
  }

  // ---------------------------------------------------------------------------
  // Duplex.fromWeb(pair[, options])
  // ---------------------------------------------------------------------------
  function newStreamDuplexFromReadableWritablePair(
    pair = kEmptyObject,
    options = kEmptyObject,
  ) {
    validateObject(pair, "pair");
    const { readable: readableStream, writable: writableStream } = pair;

    if (!isReadableStream(readableStream)) {
      throw new ERR_INVALID_ARG_TYPE(
        "pair.readable",
        "ReadableStream",
        readableStream,
      );
    }
    if (!isWritableStream(writableStream)) {
      throw new ERR_INVALID_ARG_TYPE(
        "pair.writable",
        "WritableStream",
        writableStream,
      );
    }

    validateObject(options, "options");
    const {
      allowHalfOpen = false,
      objectMode = false,
      encoding,
      decodeStrings = true,
      highWaterMark,
      signal,
    } = options;

    validateBoolean(objectMode, "options.objectMode");
    if (encoding !== undefined && !Buffer.isEncoding(encoding))
      throw new ERR_INVALID_ARG_VALUE(encoding, "options.encoding");

    const writer = writableStream.getWriter();
    const reader = readableStream.getReader();
    let writableClosed = false;
    let readableClosed = false;

    const duplex = new Duplex({
      allowHalfOpen,
      highWaterMark,
      objectMode,
      encoding,
      decodeStrings,
      signal,

      writev(chunks, callback) {
        // Same divergence as newStreamWritableFromWritableStream's writev.
        function done(error) {
          try {
            callback(error);
          } catch (err) {
            process.nextTick(() => destroy(duplex, err));
          }
        }

        writer.ready.then(
          () =>
            Promise.all(chunks.map((data) => writer.write(data.chunk))).then(
              () => done(),
              done,
            ),
          done,
        );
      },

      write(chunk, encoding, callback) {
        if (typeof chunk === "string" && decodeStrings && !objectMode) {
          const enc = normalizeEncoding(encoding);

          if (enc === "utf8") {
            chunk = encoder.encode(chunk);
          } else {
            chunk = Buffer.from(chunk, encoding);
            chunk = new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          }
        }

        function done(error) {
          try {
            callback(error);
          } catch (err) {
            destroy(duplex, err);
          }
        }

        writer.ready.then(
          () => writer.write(chunk).then(() => done(), done),
          done,
        );
      },

      final(callback) {
        function done(error) {
          try {
            callback(error);
          } catch (err) {
            process.nextTick(() => destroy(duplex, err));
          }
        }

        if (!writableClosed) {
          writer.close().then(() => done(), done);
        }
      },

      read() {
        reader.read().then(
          (chunk) => {
            if (chunk.done) {
              duplex.push(null);
            } else {
              duplex.push(chunk.value);
            }
          },
          (error) => destroy(duplex, error),
        );
      },

      destroy(error, callback) {
        function done() {
          try {
            callback(error);
          } catch (err) {
            process.nextTick(() => {
              throw err;
            });
          }
        }

        async function closeWriter() {
          if (!writableClosed) await writer.abort(error);
        }

        async function closeReader() {
          if (!readableClosed) await reader.cancel(error);
        }

        if (!writableClosed || !readableClosed) {
          Promise.all([closeWriter(), closeReader()]).then(done, done);
          return;
        }

        done();
      },
    });

    writer.closed.then(
      () => {
        writableClosed = true;
        if (!isWritableEnded(duplex))
          destroy(duplex, new ERR_STREAM_PREMATURE_CLOSE());
      },
      (error) => {
        writableClosed = true;
        readableClosed = true;
        destroy(duplex, error);
      },
    );

    reader.closed.then(
      () => {
        readableClosed = true;
      },
      (error) => {
        writableClosed = true;
        readableClosed = true;
        destroy(duplex, error);
      },
    );

    return duplex;
  }

  // ---------------------------------------------------------------------------
  // The StreamBase pair — NOT implemented, and honest about it.
  //
  // Upstream wraps a libuv StreamBase handle directly: it drives readStart /
  // readStop / onread / writeBuffer and reads the results out of the
  // internalBinding('stream_wrap') scratch array. Vivari's stream_wrap is a JS
  // shim for the in-process loopback (bindings/net.js) and does not expose that
  // contract, so a "working" version here would be a partially-correct
  // conversion that drops writes. Nothing in this runtime calls either function
  // (net/http reach Web Streams through Readable.toWeb/Writable.toWeb on the
  // socket); they are exported only so a caller that does gets this message
  // rather than "undefined is not a function".
  // ---------------------------------------------------------------------------
  const streamBaseNotImplemented = (name) => () => {
    const err = new Error(
      `Vivari: ${name}() is not implemented — it wraps a libuv StreamBase handle, ` +
        `and this runtime's internalBinding('stream_wrap') is a JS shim without the ` +
        `readStart/onread/writeBuffer contract it needs. Convert the socket with ` +
        `Readable.toWeb()/Writable.toWeb() instead.`,
    );
    err.code = "ERR_METHOD_NOT_IMPLEMENTED";
    throw err;
  };

  module.exports = {
    newWritableStreamFromStreamWritable,
    newReadableStreamFromStreamReadable,
    newStreamWritableFromWritableStream,
    newStreamReadableFromReadableStream,
    newReadableWritablePairFromDuplex,
    newStreamDuplexFromReadableWritablePair,
    newWritableStreamFromStreamBase: streamBaseNotImplemented(
      "newWritableStreamFromStreamBase",
    ),
    newReadableStreamFromStreamBase: streamBaseNotImplemented(
      "newReadableStreamFromStreamBase",
    ),
  };
}