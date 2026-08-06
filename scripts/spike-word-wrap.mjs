// Spike (OFFLINE, fast): the word-wrap chord must match on macOS, where holding
// Option composes the character away.
//
// This drives the studio's SHIPPED matcher — editor-prefs.js is plain JavaScript for
// that reason, the way s3-app-source.js is — rather than a copy of it. Which matters
// here more than usual: the whole bug class is that the obvious implementation
// (compare e.key to "z") works on Windows and Linux and fails on macOS, so a test
// against a paraphrase would agree with the paraphrase and prove nothing.
//
// What it CANNOT do is press a key. There is no browser here and no macOS anywhere in
// CI, so the macOS event shapes below are asserted as data, taken from the platform
// behaviour this repo already hit and recorded for ⌥⌘B (AppShell: "⌥B → ∫"). The claim
// under test is "given this event, does the matcher fire", not "does macOS send it".
//
//   run:  node scripts/spike-word-wrap.mjs

import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};

// A localStorage stand-in, installed before the module is imported so the persistence
// helpers exercise their real bodies rather than their catch blocks.
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => void store.set(k, String(v)),
  removeItem: (k) => void store.delete(k),
};

const prefs = await import(
  path.join(ROOT, "packages/studio/src/vv/editor-prefs.js").replace(/^/, "file://")
);
const { isWordWrapChord, loadWordWrap, saveWordWrap } = prefs;

console.log("\n1) the chord fires on every platform, composed character or not");
{
  // Windows / Linux, and macOS with a layout that does not compose: the letter arrives.
  ok(isWordWrapChord({ altKey: true, key: "z", code: "KeyZ" }), "Alt+Z on Windows/Linux");
  // macOS: Option composes, so `key` is "Ω" — and "Ω".toLowerCase() is "ω", not "z", so
  // `code` is the only field left saying which key was pressed. This is the case the
  // obvious implementation fails, and the reason the matcher reads both.
  ok(isWordWrapChord({ altKey: true, key: "Ω", code: "KeyZ" }), "⌥Z on macOS, where the key composes to Ω");
  ok("Ω".toLowerCase() !== "z", "…and it is not a casing problem: Ω lowercases to ω, never to z");
  // A layout where `code` is not KeyZ but the key still typed a z (AZERTY moves the
  // physical letters around). The second half of the matcher is what covers this.
  ok(isWordWrapChord({ altKey: true, key: "z", code: "KeyW" }), "a layout that types z from another physical key");
}

console.log("\n2) and does not fire for anything else");
{
  ok(!isWordWrapChord({ altKey: false, key: "z", code: "KeyZ" }), "plain z is typing, not a command");
  ok(!isWordWrapChord({ altKey: true, metaKey: true, key: "z", code: "KeyZ" }), "⌘⌥Z is an undo variant, left alone");
  ok(!isWordWrapChord({ altKey: true, ctrlKey: true, key: "z", code: "KeyZ" }), "Ctrl+Alt+Z likewise");
  ok(!isWordWrapChord({ altKey: true, shiftKey: true, key: "¸", code: "KeyZ" }), "⌥⇧Z is its own chord, not this one");
  ok(!isWordWrapChord({ altKey: true, key: "b", code: "KeyB" }), "⌥B belongs to the preview panel");
  // AltGr, which Windows delivers as ctrl+alt: on a Polish layout AltGr+Z types "ż", and
  // a matcher that only checked altKey would eat it. Excluding ctrl covers it. (X11
  // sends AltGraph with altKey false, so that spelling never reaches here either. An
  // AltGr remapped to a bare right Alt does match — but so does VS Code's own Alt+Z,
  // so that is parity, not a regression.)
  ok(!isWordWrapChord({ altKey: true, ctrlKey: true, code: "KeyZ", key: "ż" }), "AltGr+Z types a letter and is left alone");
  // The composed character alone must not be enough: ⌥Z on one layout could be some
  // other key's composition on another, and `code` is what disambiguates.
  ok(!isWordWrapChord({ altKey: true, key: "Ω", code: "KeyQ" }), "Ω from a different physical key is not it");
  ok(!isWordWrapChord(null), "a missing event is not a match");
}

console.log("\n3) the preference survives a reload");
{
  store.clear();
  ok(loadWordWrap() === false, "off by default, which is what the editor did before");
  saveWordWrap(true);
  ok(loadWordWrap() === true, "…on after being turned on");
  ok(store.get("vv-word-wrap") === "on", "…stored under one key, readable as text: " + store.get("vv-word-wrap"));
  saveWordWrap(false);
  ok(loadWordWrap() === false, "…and off again");
  // Storage can be denied outright (private mode, a sandboxed frame). The toggle has to
  // keep working for the session rather than throwing out of the keydown handler.
  const real = globalThis.localStorage;
  globalThis.localStorage = {
    getItem() { throw new Error("denied"); },
    setItem() { throw new Error("denied"); },
  };
  let threw = false;
  try {
    saveWordWrap(true);
    ok(loadWordWrap() === false, "with storage denied it reads as off rather than throwing");
  } catch {
    threw = true;
  }
  ok(!threw, "…and neither helper throws out of the caller");
  globalThis.localStorage = real;
}

console.log("\n4) both editors are wired, and the palette only claims what exists");
{
  // Static checks, because the editors need a DOM. They pin the three places a
  // reviewer would otherwise have to take on trust.
  const fs = await import("node:fs");
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  const controller = read("packages/studio/src/vv/controller.ts");
  const wraps = controller.match(/wordWrap: this\.snap\.wordWrap \? "on" : "off"/g) || [];
  ok(wraps.length === 2, "the text editor AND the diff editor are created wrapped: " + wraps.length + " sites");
  ok(/toggleWordWrap\(force\?: boolean\)/.test(controller), "there is one toggle, not a per-editor pair");
  ok(
    /this\.editor\?\.updateOptions\(\{ wordWrap \}\)/.test(controller) &&
      /this\.diffEditor\?\.updateOptions\(\{ wordWrap \}\)/.test(controller),
    "…and it reaches editors that are already open, not just newly created ones",
  );
  const shell = read("packages/studio/src/components/ide/AppShell.tsx");
  // The chord must be tested BEFORE the ⌘/Ctrl gate. Alt+Z has neither, so below the
  // gate it would be unreachable — which is exactly why the shortcut did nothing.
  ok(
    shell.indexOf("isWordWrapChord") < shell.indexOf("if (!mod) return;"),
    "the chord is matched above AppShell's ⌘/Ctrl gate, or it could never run",
  );
  ok(/closest\("\.vv-term-host"\)/.test(shell), "…and a focused terminal keeps its own ⌥Z escape sequence");
  const palette = read("packages/studio/src/components/ide/CommandPalette.tsx");
  ok(/"Toggle Word Wrap"/.test(palette), "the palette offers it, for the terminal case and for discovery");
  ok(/keys: "⌥Z"/.test(palette), "…and advertises the binding, which now genuinely exists");
}

console.log("\n5) the assumption the design rests on: Monaco lets Alt+Z through");
{
  // A window listener only works because Monaco does not swallow the key. Its standalone
  // keybinding service stops propagation ONLY for a chord it resolved, and it ships no
  // word-wrap action at all — which is both why Alt+Z did nothing before and why
  // handling it above Monaco is safe. If a future Monaco started binding Alt+Z itself,
  // the two would fight and toggle twice, i.e. do nothing. This is the tripwire.
  //
  // Conditional, and worth being plain about what that costs: CI runs the offline tier
  // only (ci.yml) and never installs the studio's node_modules, so this pair of checks
  // is skipped there. It fires for whoever runs the spike locally or bumps Monaco —
  // which is when it matters — but nothing in CI is watching for that collision.
  const fs = await import("node:fs");
  const MONACO = path.join(ROOT, "packages/studio/node_modules/monaco-editor/esm/vs");
  if (!fs.existsSync(MONACO)) {
    console.log("  ○ monaco-editor not installed — run npm install in packages/studio (skipped)");
  } else {
    const services = fs.readFileSync(path.join(MONACO, "editor/standalone/browser/standaloneServices.js"), "utf8");
    ok(
      /const shouldPreventDefault = this\._dispatch\([\s\S]{0,200}?stopPropagation\(\)/.test(services),
      "propagation is stopped only for a chord Monaco resolved",
    );
    let bound = 0;
    for (const dir of ["editor/contrib", "editor/browser", "editor/standalone"]) {
      const stack = [path.join(MONACO, dir)];
      while (stack.length) {
        const d = stack.pop();
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) stack.push(p);
          else if (e.name.endsWith(".js") && /[Tt]oggleWordWrap/.test(fs.readFileSync(p, "utf8"))) bound++;
        }
      }
    }
    ok(bound === 0, "…and embedded Monaco ships no word-wrap action to collide with: " + bound);
  }
}

console.log(failed ? `\nFAIL: ${failed} check(s) failed` : "\nOK: the word-wrap chord survives Option");
process.exit(failed ? 1 : 0);
