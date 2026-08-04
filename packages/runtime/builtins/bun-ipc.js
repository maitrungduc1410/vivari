// The channel behind `Bun.spawn({ ipc })`: both ends of one byte stream, plus the
// framing and the serialization that let a stream carry discrete messages.
//
// It needed no new kernel opcode. The kernel already relays a cross-process UNIX
// socket — OP_PIPE_LISTEN / OP_PIPE_CONNECT to open one, then `pipe-data` /
// `pipe-shutdown` / `pipe-close` forwarded verbatim by connId — which is the same
// transport `node:net`'s Pipe class and `Bun.listen({ unix })` already run on. So
// an IPC channel is a socket on a generated path: the parent listens before it
// spawns, the child dials on the way up, and each message is one length-prefixed
// frame.
//
// What the channel IS was measured against bun 1.3.6, not guessed, and three of
// the answers are not what the docs imply:
//
//   The child gets NODE's fork surface, not a Bun-specific one: `process.send`,
//   `process.on("message")`, `process.connected`, `process.channel`,
//   `process.disconnect()`. There is no `Bun.ipc` and nothing on the Bun global.
//   The parent passes `NODE_CHANNEL_FD=3` (an AF_UNIX socket, not a FIFO) and
//   `NODE_CHANNEL_SERIALIZATION_MODE`, and BOTH are already gone from
//   `process.env` when the child's first line runs.
//   The default mode is "advanced", which is a structured clone: a Map, a Set, a
//   Date, a RegExp, a BigInt, a TypedArray and a cycle all survive it. "json" is
//   JSON and quietly loses every one of them.
//   A function is refused with `DataCloneError: The object can not be cloned.`,
//   and `send(undefined)` with `TypeError: The "message" argument must be
//   specified`.
//
// A Worker cannot inherit a file descriptor, so the socket PATH is what we pass
// instead of an fd. Everything else about the shape is Bun's.

import { serialize, deserialize } from "./bun-serialize.js";

// Where the child finds its channel. The name is ours on purpose:
// `NODE_CHANNEL_FD` holds an integer file descriptor everywhere else in the
// world, and putting a path in it would be a lie that some library eventually
// reads as a number. Which name we choose is unobservable to guest code anyway —
// both bun and node delete theirs before the child's first line, and so do we.
export const IPC_PATH_ENV = "VV_IPC_CHANNEL";

// This one keeps Bun's name, because it holds exactly what Bun's holds.
export const IPC_MODE_ENV = "NODE_CHANNEL_SERIALIZATION_MODE";

export const ADVANCED = "advanced";
export const JSON_MODE = "json";

// A length prefix a corrupt or hostile peer controls is an invitation to buffer
// until the tab dies, so frames are capped. The limit is far above any plausible
// message and far below "allocate whatever the wire said".
export const MAX_FRAME_BYTES = 128 * 1024 * 1024;

const LENGTH_BYTES = 4;

/** Bun's sentence, and it is thrown before anything is serialized. */
export function requireMessage(value) {
  if (value === undefined) {
    throw new TypeError('The "message" argument must be specified');
  }
  return value;
}

export function normalizeMode(mode) {
  return mode === JSON_MODE ? JSON_MODE : ADVANCED;
}

function jsonBytes(value) {
  const text = JSON.stringify(value);
  // JSON.stringify answers `undefined` for a function or a symbol. That is not a
  // frame, so it would desynchronize the stream — and JSON mode's whole contract
  // is "JSON semantics", where an unrepresentable value in an array is already
  // null. Bare `undefined` never reaches here; requireMessage refused it.
  return new TextEncoder().encode(text === undefined ? "null" : text);
}

/**
 * One message, framed: a little-endian u32 byte length followed by the payload.
 * The length is what makes the stream parseable — two sends in one tick arrive
 * coalesced into a single `data` event, and one send larger than the relay's
 * chunking arrives split across several. Both are the same bug without it.
 */
export function encodeMessage(value, mode) {
  const body = normalizeMode(mode) === JSON_MODE ? jsonBytes(value) : new Uint8Array(serialize(value));
  const frame = new Uint8Array(LENGTH_BYTES + body.length);
  new DataView(frame.buffer).setUint32(0, body.length, true);
  frame.set(body, LENGTH_BYTES);
  return frame;
}

export function decodeMessage(body, mode) {
  if (normalizeMode(mode) === JSON_MODE) {
    return JSON.parse(new TextDecoder().decode(body));
  }
  return deserialize(body);
}

/**
 * Reassembles frames from however the bytes happen to arrive. Kept as a plain
 * class over Uint8Array — no sockets, no Node builtins — so the offline tier can
 * drive the split/coalesce cases directly, which is where a naive reader loses
 * data and a spike over a real socket may never happen to reproduce the split.
 */
export class FrameReader {
  constructor(maxFrameBytes = MAX_FRAME_BYTES) {
    this.buffered = new Uint8Array(0);
    this.maxFrameBytes = maxFrameBytes;
  }

  /** @returns {Uint8Array[]} every complete frame this chunk finished. */
  push(chunk) {
    // Copy: a Node stream chunk comes off a shared pool and may be reused before
    // the frame it belongs to is complete.
    const incoming = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    if (this.buffered.length === 0) {
      this.buffered = incoming.slice();
    } else {
      const merged = new Uint8Array(this.buffered.length + incoming.length);
      merged.set(this.buffered);
      merged.set(incoming, this.buffered.length);
      this.buffered = merged;
    }

    const frames = [];
    let offset = 0;
    for (;;) {
      if (this.buffered.length - offset < LENGTH_BYTES) break;
      const length = new DataView(
        this.buffered.buffer,
        this.buffered.byteOffset + offset,
        LENGTH_BYTES,
      ).getUint32(0, true);
      if (length > this.maxFrameBytes) {
        throw new RangeError(
          "IPC frame of " + length + " bytes exceeds the " + this.maxFrameBytes + "-byte limit",
        );
      }
      if (this.buffered.length - offset - LENGTH_BYTES < length) break;
      frames.push(this.buffered.subarray(offset + LENGTH_BYTES, offset + LENGTH_BYTES + length));
      offset += LENGTH_BYTES + length;
    }
    // `slice` rather than `subarray`: the frames just handed out are views onto
    // the old buffer, and the next push() must not write underneath them.
    if (offset > 0) this.buffered = this.buffered.slice(offset);
    return frames;
  }
}

/**
 * Wire one end of the channel onto an already-connected socket. Both ends are the
 * same code; only what they do with a message differs.
 *
 * `onMessage` is called once per frame, in arrival order, synchronously from the
 * socket's data event — the CALLER decides when to hand it to user code, because
 * the two ends schedule differently (the child emits on a loop turn so a
 * process.exit() from the handler is honoured).
 */
export function attachChannel({ socket, mode, onMessage, onClose, onError }) {
  const reader = new FrameReader();
  let open = true;

  const shutdown = (err) => {
    if (!open) return;
    open = false;
    try {
      socket.destroy();
    } catch {
      /* already gone */
    }
    if (err && typeof onError === "function") onError(err);
    if (typeof onClose === "function") onClose(err || null);
  };

  socket.on("data", (chunk) => {
    if (!open) return;
    let frames;
    try {
      frames = reader.push(chunk);
    } catch (err) {
      // A length we cannot trust means the stream is no longer parseable. There
      // is no resynchronizing a length-prefixed stream, so the channel dies here
      // rather than delivering garbage as a message.
      shutdown(err);
      return;
    }
    for (const frame of frames) {
      let message;
      try {
        message = decodeMessage(frame, mode);
      } catch (err) {
        shutdown(err);
        return;
      }
      if (!open) return;
      onMessage(message);
    }
  });
  socket.on("end", () => shutdown(null));
  socket.on("close", () => shutdown(null));
  // The peer exiting closes the relay under us. That is an ordinary end of a
  // channel, not a crash, and an unhandled 'error' on a socket would take the
  // process down with it.
  socket.on("error", () => shutdown(null));

  return {
    get open() {
      return open;
    },
    /** @param {Uint8Array} frame already encoded, so the value is captured at send time. */
    write(frame) {
      if (!open) return false;
      try {
        socket.write(frame);
      } catch {
        shutdown(null);
        return false;
      }
      return true;
    },
    close() {
      shutdown(null);
    },
  };
}

/**
 * An address no other process can guess. It is never created as a file — the
 * kernel's pipe table is keyed by the string alone — so this is a namespace
 * choice, not a path on disk.
 */
export function generateChannelPath(pid, randomHex) {
  return "/tmp/.vivari-ipc/" + (pid | 0) + "-" + randomHex + ".sock";
}
