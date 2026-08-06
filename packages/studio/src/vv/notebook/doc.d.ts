// Plain JavaScript so scripts/spike-notebook.mjs drives the exact store the studio
// ships; `allowJs` is off here, so tsc needs this to resolve the module.

import type { Cell, CellType, MimeBundle, Notebook } from "./ipynb.js";

/** What `NotebookSession` reports into. */
export interface NotebookSink {
  onQueued?(id: string): void;
  onStart(id: string, count: number): void;
  onStream(id: string, name: "stdout" | "stderr", text: string): void;
  onDisplay(id: string, data: MimeBundle): void;
  onResult(id: string, data: MimeBundle, count: number): void;
  onError(id: string, ename: string, evalue: string, traceback: string[]): void;
  onDone(id: string, status: "ok" | "error"): void;
  /** Wheels are being fetched for this cell. Transient status, not an output. */
  onLoading?(id: string, text: string): void;
  onAborted?(id: string, reason: string, started: boolean): void;
  onRestart?(): void;
  onKernelExit?(code: number, wasRunning: boolean): void;
  onStatus?(status: string, queued: number, running: string | null): void;
  onLog?(lines: string[]): void;
}

export declare class NotebookDoc {
  constructor(nb?: Notebook);
  static fromText(text: string): NotebookDoc;

  nb: Notebook;
  /** Cells whose outputs came from an interpreter that is no longer running. */
  stale: Set<string>;
  selected: string | null;
  dirty: boolean;

  readonly cells: Cell[];

  /** `useSyncExternalStore` pair. */
  subscribe(fn: () => void): () => void;
  getSnapshot(): number;

  toText(): string;
  indexOf(id: string): number;
  cell(id: string): Cell | null;

  setSource(id: string, source: string): void;
  select(id: string): void;
  insert(type?: CellType, index?: number | null, source?: string): string;
  remove(id: string): void;
  move(id: string, delta: number): void;
  setType(id: string, type: CellType): void;
  split(id: string, offset: number): string | null;
  mergeUp(id: string): boolean;
  clearOutputs(id: string): void;
  clearAllOutputs(): void;

  changed(opts?: { dirty?: boolean }): void;
  sink(): NotebookSink;
}

export declare function newCellId(): string;
