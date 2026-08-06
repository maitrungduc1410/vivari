// Editor preferences that outlive a reload, and the keystroke that toggles them.
//
// One preference so far — word wrap — kept here rather than threaded through the
// controller so the chord and the storage key sit next to the reasoning about them.
// If a second editor preference arrives this is where it goes; it is not a settings
// system and should not grow into one until there is something to generalise from.
//
// Plain JS (not TS) so scripts/spike-word-wrap.mjs can drive the exact matcher the
// studio ships, the way s3-app-source.js exists for its spike. `allowJs` is off
// here, so the sibling .d.ts is what lets `tsc -b` resolve this module.

const WORD_WRAP_KEY = "vv-word-wrap";

/** Off by default, which is Monaco's default and what the studio did before this. */
export function loadWordWrap() {
  try {
    return localStorage.getItem(WORD_WRAP_KEY) === "on";
  } catch {
    return false; // storage disabled (private mode, embedded frame) — session-only
  }
}

export function saveWordWrap(on) {
  try {
    localStorage.setItem(WORD_WRAP_KEY, on ? "on" : "off");
  } catch {
    /* storage full / disabled — the toggle still works for this session */
  }
}

/**
 * Alt+Z / ⌥Z, VS Code's word-wrap chord.
 *
 * MATCHED ON `code` AS WELL AS `key`, and the `code` half is the half that works on
 * macOS. Holding Option composes a character, so ⌥Z arrives with `key: "Ω"` — and
 * "Ω".toLowerCase() is "ω", not "z", so any matcher that reads `key` alone is dead on
 * the platform the shortcut is best known from. `code` names the physical key
 * regardless of what it produced. The same trick is already in AppShell for ⌥⌘B,
 * where ⌥B composes "∫".
 *
 * `key` is kept as the second half because `code` is US-layout positional: on AZERTY
 * the key at QWERTY's Z position is the one labelled W. Between the two, a user gets
 * a match either from where the key is or from what it typed, which is as far as the
 * platform lets this go.
 *
 * Meta/Ctrl are excluded so this cannot fire as part of ⌘⌥Z or ⌃⌥Z (undo variants),
 * and Shift because ⌥⇧Z is its own composed character and its own potential chord.
 */
export function isWordWrapChord(e) {
  if (!e || !e.altKey) return false;
  if (e.metaKey || e.ctrlKey || e.shiftKey) return false;
  if (e.code === "KeyZ") return true;
  return typeof e.key === "string" && e.key.toLowerCase() === "z";
}
