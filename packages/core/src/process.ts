// A spawned in-VM process, exposed with Web Streams for stdio.
//
// Output (stdout + stderr, terminal-style) arrives as string chunks on a
// ReadableStream; stdin is a WritableStream; `exit` resolves with the code. This
// maps onto the kernel worker's generic `proc-spawn` / `proc-out` / `proc-exit`
// protocol (one process per `execId`).

import type { KernelBridge } from "./bridge";
import type { KernelMessage, SpawnOptions } from "./types";

export class VivariProcess {
  /** Merged stdout + stderr as UTF-8 string chunks (raw, ANSI escapes intact). */
  readonly output: ReadableStream<string>;
  /** Process stdin. Writing a string forwards it; closing the stream sends EOF. */
  readonly input: WritableStream<string>;
  /** Resolves with the exit code when the process ends. */
  readonly exit: Promise<number>;

  private readonly bridge: KernelBridge;
  private readonly execId: number;
  private killed = false;

  constructor(
    bridge: KernelBridge,
    execId: number,
    command: string,
    args: string[],
    options: SpawnOptions,
  ) {
    this.bridge = bridge;
    this.execId = execId;

    let outController!: ReadableStreamDefaultController<string>;
    let resolveExit!: (code: number) => void;
    this.exit = new Promise<number>((resolve) => (resolveExit = resolve));

    const offOut = bridge.on("proc-out", (m: KernelMessage) => {
      if (m.execId !== execId) return;
      try {
        outController.enqueue(m.chunk as string);
      } catch {
        /* consumer cancelled the stream */
      }
    });
    const offExit = bridge.on("proc-exit", (m: KernelMessage) => {
      if (m.execId !== execId) return;
      offOut();
      offExit();
      try {
        outController.close();
      } catch {
        /* already closed */
      }
      resolveExit(typeof m.code === "number" ? m.code : 0);
    });

    this.output = new ReadableStream<string>({
      start: (controller) => {
        outController = controller;
      },
      cancel: () => this.kill(),
    });

    this.input = new WritableStream<string>({
      write: (chunk) => {
        bridge.post("proc-input", { execId, chunk });
      },
      close: () => {
        bridge.post("proc-input", { execId, chunk: null });
      },
      abort: () => this.kill(),
    });

    // Listeners are wired; launch the process.
    bridge.post("proc-spawn", {
      execId,
      command,
      args,
      cwd: options.cwd,
      env: options.env,
    });
  }

  /** Terminate the process (SIGTERM). Its `exit` still resolves. */
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.bridge.post("proc-kill", { execId: this.execId });
  }
}
