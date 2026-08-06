// editor-prefs is plain JavaScript so scripts/spike-word-wrap.mjs can import the
// exact matcher the studio ships (Node cannot import the studio's .ts). `allowJs` is
// off here, so tsc needs this to resolve the module.
export declare function loadWordWrap(): boolean;
export declare function saveWordWrap(on: boolean): void;
/** True for Alt+Z / ⌥Z. Accepts anything with the KeyboardEvent modifier fields. */
export declare function isWordWrapChord(e: {
  altKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  code?: string;
  key?: string;
}): boolean;
