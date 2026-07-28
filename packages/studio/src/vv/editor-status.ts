// Studio-side editor status readouts (cursor, indentation, language mode).
//
// Feeds the VS Code-style right-hand side of the StatusBar. Mirrors the
// DebugSession / ScmSession pattern: an immutable snapshot exposed for
// useSyncExternalStore, owned by IdeController and fed from Monaco listeners.
//
// This is deliberately NOT part of IdeSnapshot. The cursor position changes on
// every keystroke and arrow key, so folding it into the main snapshot would
// notify every useIde() consumer in the IDE on each keypress. A dedicated store
// keeps those re-renders scoped to the status bar.

export interface CursorState {
  line: number; // 1-based
  column: number; // 1-based
  selected: number; // characters selected across all cursors
  selections: number; // cursor count (>1 = multi-cursor)
}

export interface IndentState {
  insertSpaces: boolean;
  tabSize: number;
}

export interface EditorStatusSnapshot {
  // All null when no text model is attached (no tab, or an image/directory/diff tab).
  cursor: CursorState | null;
  indent: IndentState | null;
  language: string | null; // monaco language id of the active model
  lineCount: number; // active model's line count (Go to Line validation hint)
}

const EMPTY: EditorStatusSnapshot = {
  cursor: null,
  indent: null,
  language: null,
  lineCount: 0,
};

export class EditorStatus {
  private listeners = new Set<() => void>();
  private snap: EditorStatusSnapshot = EMPTY;

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };
  getSnapshot = (): EditorStatusSnapshot => this.snap;

  /** Merge a partial update. No-ops when nothing actually changed, so a cursor
   * move within the same line/column doesn't wake the status bar. */
  set(partial: Partial<EditorStatusSnapshot>) {
    const next = { ...this.snap, ...partial };
    if (
      sameCursor(next.cursor, this.snap.cursor) &&
      sameIndent(next.indent, this.snap.indent) &&
      next.language === this.snap.language &&
      next.lineCount === this.snap.lineCount
    ) {
      return;
    }
    this.snap = next;
    for (const l of this.listeners) l();
  }

  /** No text model attached — the status bar hides the cursor/indent/language items. */
  clear() {
    this.set(EMPTY);
  }
}

function sameCursor(a: CursorState | null, b: CursorState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.line === b.line &&
    a.column === b.column &&
    a.selected === b.selected &&
    a.selections === b.selections
  );
}

function sameIndent(a: IndentState | null, b: IndentState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.insertSpaces === b.insertSpaces && a.tabSize === b.tabSize;
}