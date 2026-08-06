// Plain JavaScript so scripts/spike-notebook-view.mjs can drive the shipped
// editor-lifetime rules against a stand-in `monaco`; `allowJs` is off here, so
// tsc needs this.

import type * as Monaco from "monaco-editor";

/** One mounted cell editor. `release()` disposes the EDITOR only, and is a no-op
 *  once a later mount has taken the cell's slot — see cell-editors.js. */
export interface CellEditorSlot {
  readonly editor: Monaco.editor.IStandaloneCodeEditor;
  readonly model: Monaco.editor.ITextModel;
  readonly monaco: typeof Monaco;
  release(): void;
}

export declare function cellFolder(notebookAbs: string): string;
export declare function cellPath(notebookAbs: string, id: string, language: "python" | "markdown"): string;
export declare function cellEditorOptions(
  overrides?: Monaco.editor.IStandaloneEditorConstructionOptions,
): Monaco.editor.IStandaloneEditorConstructionOptions;

export declare class CellEditors {
  constructor(monaco: typeof Monaco, notebookAbs: string);
  readonly abs: string;
  readonly folder: string;
  uriFor(id: string, language: "python" | "markdown"): Monaco.Uri;
  mount(
    el: HTMLElement,
    id: string,
    language: "python" | "markdown",
    source: string,
    overrides?: Monaco.editor.IStandaloneEditorConstructionOptions,
  ): CellEditorSlot;
  modelFor(id: string): Monaco.editor.ITextModel | null;
  disposeAll(): void;
}
