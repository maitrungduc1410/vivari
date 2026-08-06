// Plain JavaScript so scripts/spike-notebook.mjs drives the exact queue the studio
// ships; `allowJs` is off here, so tsc needs this to resolve the module.

import type { NotebookSink } from "./doc.js";
import type { Cell } from "./ipynb.js";

export declare const RS: string;

export type KernelStatus = "off" | "starting" | "idle" | "busy" | "dead";
export declare const KERNEL_STATES: KernelStatus[];

export declare class FrameReader {
  push(chunk: string): { frames: Record<string, unknown>[]; log: string[] };
}

/** The transport. Everything in it needs a browser; nothing else here does. */
export interface KernelIO {
  /** One JSON request line to the kernel's stdin. */
  send(line: string): void;
  /** Deliver SIGINT to the running cell. */
  interrupt(): void;
  /** Start the kernel process. */
  launch(): void;
  /** Kill it. */
  stop(): void;
}

export declare class NotebookSession {
  constructor(io: KernelIO, sink: NotebookSink);

  status: KernelStatus;
  execCount: number;
  queue: string[];
  running: { id: string; count: number } | null;
  log: string[];
  info: { python: string; platform: string } | null;
  /** What the kernel said killed it, if it got the chance. */
  crash: { ename: string; evalue: string } | null;
  /** The last exit, for a front end that has to report one. */
  exit: { code: number; ename: string; evalue: string } | null;

  start(): void;
  restart(): void;
  shutdown(): void;
  onExit(code: number): void;

  run(cellId: string, source: string): void;
  runMany(cells: Pick<Cell, "id" | "source">[]): void;
  /** False when there is nothing running to interrupt. */
  interrupt(): boolean;

  feed(chunk: string): void;
}
