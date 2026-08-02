// A spawned in-VM process, exposed with Web Streams for stdio.
//
// The kernel tags every chunk with the stream it came from, so `output` (the
// interleaved, terminal-faithful view) and the separate `stdout`/`stderr` views
// are all available; stdin is a WritableStream; `exit` resolves with the code.
// This maps onto the kernel worker's generic `proc-spawn` / `proc-out` /
// `proc-exit` protocol (one process per `execId`).

import type { KernelBridge } from "./bridge.js";
import { TEARDOWN_MESSAGE } from "./bridge.js";
import { VivariError } from "./errors.js";
import type { KernelMessage, SpawnOptions } from "./types.js";

/** Exit code reported when a process is still running when the instance is torn down. */
const EXIT_TORN_DOWN = -1;

/**
 * A `ReadableStream<string>` that is also async-iterable, so the common cases read
 * naturally without hand-building a `WritableStream`:
 *
 *   for await (const chunk of proc.output) term.write(chunk);
 *   const log = await proc.stderr.text();
 */
export interface OutputStream extends ReadableStream<string> {
  /** Drain the stream and concatenate it. Resolves when the process closes it. */
  text(): Promise<string>;
  [Symbol.asyncIterator](): AsyncIterableIterator<string>;
}

/** Attach the iteration helpers a bare `ReadableStream` doesn't (yet) have everywhere. */
function asOutputStream(stream: ReadableStream<string>): OutputStream {
  const out = stream as OutputStream;
  // Chrome and Node ship async iteration on ReadableStream; Safari does not yet.
  if (typeof out[Symbol.asyncIterator] !== "function") {
    out[Symbol.asyncIterator] = function (): AsyncIterableIterator<string> {
      const reader = out.getReader();
      const iterator: AsyncIterableIterator<string> = {
        async next() {
          const { done, value } = await reader.read();
          if (done) {
            reader.releaseLock();
            return { value: undefined, done: true };
          }
          return { value, done: false };
        },
        async return() {
          await reader.cancel();
          reader.releaseLock();
          return { value: undefined, done: true };
        },
        [Symbol.asyncIterator]() {
          return iterator;
        },
      };
      return iterator;
    };
  }
  out.text = async () => {
    let text = "";
    for await (const chunk of out) text += chunk;
    return text;
  };
  return out;
}

export class VivariProcess {
  /** Merged stdout + stderr as UTF-8 string chunks (raw, ANSI escapes intact). */
  readonly output: OutputStream;
  /** Just stdout. Reading it does not consume {@link output}. */
  readonly stdout: OutputStream;
  /** Just stderr. Reading it does not consume {@link output}. */
  readonly stderr: OutputStream;
  /** Process stdin. Writing a string forwards it; closing the stream sends EOF. */
  readonly input: WritableStream<string>;
  /** Resolves with the exit code when the process ends. */
  readonly exit: Promise<number>;
  /**
   * Resolves once the kernel confirms the process launched, or rejects with
   * `ERR_COMMAND_NOT_FOUND`. `Vivari.spawn` awaits this for you.
   */
  readonly started: Promise<void>;

  private readonly bridge: KernelBridge;
  private readonly execId: number;
  private killed = false;
  private code: number | null = null;
  private procPid = -1;

  constructor(
    bridge: KernelBridge,
    execId: number,
    command: string,
    args: string[],
    options: SpawnOptions,
  ) {
    this.bridge = bridge;
    this.execId = execId;

    const merged = new StreamSink();
    const out = new StreamSink();
    const err = new StreamSink();
    this.output = asOutputStream(merged.stream(() => this.kill()));
    this.stdout = asOutputStream(out.stream());
    this.stderr = asOutputStream(err.stream());

    let resolveExit!: (code: number) => void;
    let settleStarted!: (error?: VivariError) => void;
    this.exit = new Promise<number>((resolve) => (resolveExit = resolve));
    this.started = new Promise<void>((resolve, reject) => {
      settleStarted = (error) => (error ? reject(error) : resolve());
    });

    const offOut = bridge.on("proc-out", (m: KernelMessage) => {
      if (m.execId !== execId) return;
      const chunk = m.chunk as string;
      merged.push(chunk);
      (m.stream === "stderr" ? err : out).push(chunk);
    });
    const offStarted = bridge.on("proc-started", (m: KernelMessage) => {
      if (m.execId !== execId) return;
      this.procPid = (m.pid as number) ?? -1;
      settleStarted();
    });
    const finish = (code: number, error?: VivariError) => {
      offOut();
      offStarted();
      offExit();
      offTeardown();
      options.signal?.removeEventListener("abort", onAbort);
      this.code = code;
      merged.close();
      out.close();
      err.close();
      // A launch failure settles `started` (so spawn() rejects) but must still
      // settle `exit`, or a caller that already holds the process hangs.
      settleStarted(error);
      resolveExit(code);
    };
    const offExit = bridge.on("proc-exit", (m: KernelMessage) => {
      if (m.execId !== execId) return;
      const code = typeof m.code === "number" ? m.code : 0;
      // The kernel reports a failed launch as an exit that never had a matching
      // `proc-started` — that, not the 127, is what distinguishes "could not run"
      // from "ran and exited 127".
      const launchFailed = this.procPid < 0 && typeof m.error === "string";
      finish(
        code,
        launchFailed
          ? new VivariError("ERR_COMMAND_NOT_FOUND", `${command}: ${m.error as string}`)
          : undefined,
      );
    });
    // Without this a teardown mid-run leaves `exit` pending forever and `output`
    // never closed, so `await proc.exit` and any in-progress pipe deadlock.
    const offTeardown = bridge.on(TEARDOWN_MESSAGE, () =>
      finish(
        EXIT_TORN_DOWN,
        this.procPid < 0
          ? new VivariError("ERR_TORN_DOWN", `${command}: the Vivari instance was torn down`)
          : undefined,
      ),
    );

    this.input = new WritableStream<string>({
      write: (chunk) => {
        bridge.post("proc-input", { execId, chunk });
      },
      close: () => {
        bridge.post("proc-input", { execId, chunk: null });
      },
      abort: () => this.kill(),
    });

    const onAbort = () => this.kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    // Listeners are wired; launch the process.
    bridge.post("proc-spawn", {
      execId,
      command,
      args,
      cwd: options.cwd,
      env: options.env,
    });
  }

  /** In-VM process id, or -1 before the kernel confirms the launch. */
  get pid(): number {
    return this.procPid;
  }

  /** The exit code, or `null` while the process is still running. */
  get exitCode(): number | null {
    return this.code;
  }

  /** Terminate the process (SIGTERM). Its `exit` still resolves. */
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.bridge.post("proc-kill", { execId: this.execId });
  }
}

/**
 * One output view. The three sinks enqueue the *same* chunk strings, so splitting
 * stdout/stderr out of the merged view costs a queue slot per chunk rather than a
 * second copy of the bytes.
 */
class StreamSink {
  private controller!: ReadableStreamDefaultController<string>;
  private cancelled = false;

  push(chunk: string): void {
    if (this.cancelled) return;
    try {
      this.controller.enqueue(chunk);
    } catch {
      /* already closed */
    }
  }

  close(): void {
    if (this.cancelled) return;
    try {
      this.controller.close();
    } catch {
      /* already closed */
    }
  }

  /** `start` runs synchronously here, so the controller exists before any push. */
  stream(onCancel?: () => void): ReadableStream<string> {
    return new ReadableStream<string>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        this.cancelled = true;
        onCancel?.();
      },
    });
  }
}