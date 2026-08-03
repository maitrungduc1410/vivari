// Python language intelligence, wired into Monaco — the typed door onto the
// implementation in runtime/builtins/python-lsp.js.
//
// The implementation lives there, in plain JavaScript, because Monaco is a
// PARAMETER of registerPythonLanguage rather than an import of it: nothing in the
// provider logic needs an editor to exist. That is what puts the request shapes,
// the cancellation and the failure wording in the offline spike tier, which gates
// every PR, instead of in a browser test that gates nothing.

import type * as Monaco from "monaco-editor";
import { registerPythonLanguage as register } from "../../../runtime/builtins/python-lsp.js";

export interface PythonServiceHost {
  /** One round trip to the language service. Resolves to the driver's reply. */
  request(root: string, req: Record<string, unknown>): Promise<{ ok: boolean; result: unknown; error: string }>;
  /** The workspace folder a file belongs to — jedi's project root. */
  rootFor(path: string): string;
  /** Transient status-bar text (formatting outcomes, refusals with reasons). */
  notify(message: string): void;
  /** Open a definition in another file. */
  openFileAt(path: string, line: number, column: number): void;
  /** Persistent state readout, so a boot in progress is visible. */
  setState(state: string, detail?: string): void;
}

/** Register completion, hover, signature help, definitions and formatting for
 * `python`. Returns a disposer that removes all five. */
export function registerPythonLanguage(monaco: typeof Monaco, host: PythonServiceHost): () => void {
  return register(monaco, host) as () => void;
}