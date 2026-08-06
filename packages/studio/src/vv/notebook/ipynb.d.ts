// The notebook's format layer is plain JavaScript so scripts/spike-notebook.mjs can
// round-trip the exact code the studio ships (Node cannot import the studio's .ts).
// `allowJs` is off here, so tsc needs this to resolve the module.

export type CellType = "code" | "markdown" | "raw" | (string & {});

/** A mime bundle: mime type -> payload. Text types are strings; `image/png` and
 *  friends are base64; `application/*+json` may be any JSON value. */
export type MimeBundle = Record<string, unknown>;

export interface StreamOutput {
  output_type: "stream";
  name: "stdout" | "stderr";
  text: string;
  raw: unknown;
}
export interface DataOutput {
  output_type: "execute_result" | "display_data";
  data: MimeBundle;
  metadata: Record<string, unknown>;
  execution_count: number | null;
  raw: unknown;
}
export interface ErrorOutput {
  output_type: "error";
  ename: string;
  evalue: string;
  traceback: string[];
  raw: unknown;
}
/** An output type this version does not model, kept whole so a save preserves it. */
export interface UnknownOutput {
  output_type: string;
  raw: unknown;
}
export type Output = StreamOutput | DataOutput | ErrorOutput | UnknownOutput;

export interface Cell {
  id: string;
  type: CellType;
  source: string;
  executionCount: number | null;
  outputs: Output[];
  /** The object this cell was parsed from, re-emitted on save with only the
   *  managed fields written over it. Null for a cell created here. */
  raw: unknown;
  /** The notebook's `nbformat_minor`, which decides whether an `id` is written. */
  minor?: number;
  hadId?: boolean;
  /** Waiting in the execution queue. */
  queued?: boolean;
  /** Why this cell did not finish, when it did not. */
  aborted?: string;
  /** What the kernel is fetching for this cell right now — a wheel this cell's
   *  imports need. Transient: true only while the cell runs, never an output, and
   *  never written to the file. */
  loading?: string;
}

export interface Notebook {
  cells: Cell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformatMinor: number;
  raw: unknown;
}

export declare const NBFORMAT: number;
export declare const NBFORMAT_MINOR: number;

export declare function joinSource(v: unknown): string;
export declare function splitSource(text: string): string[];
export declare function newCellId(): string;
export declare function resetIdSeq(): void;
export declare function emptyNotebook(): Notebook;
export declare function newCell(type: CellType, source?: string): Cell;
export declare function parseNotebook(text: string): Notebook;
export declare function serializeNotebook(nb: Notebook): string;
export declare function stableJson(value: unknown): string;
