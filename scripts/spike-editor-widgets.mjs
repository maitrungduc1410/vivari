// Spike (OFFLINE, static): Monaco's overflowing widgets must outlive the editor
// pane they are anchored in.
//
//   run:  node scripts/spike-editor-widgets.mjs
//
// THE BUG THIS EXISTS FOR. A hover on a very long line — Monaco's "Rendering
// paused for long line / Show more" — was cut off exactly at the seam where the
// editor pane ends and the preview pane begins. Monaco already lifts hover,
// suggest and the context menu out of the editor's scrolling box into an
// `.overflowingContentWidgets` div, which is why they can reach past the gutter
// at all; what that div cannot do is leave the PAGE. It stays inside the
// editor's own DOM, the editor pane is an EARLIER sibling of the preview pane,
// and the preview's iframe is positioned — so it paints over anything reaching
// in from an earlier sibling. Nothing was clipped; the tooltip was underneath.
//
// WHY THIS IS STATIC. The failure is a paint-order fact, and no CI job here runs
// a browser (the same reason `site-headers` and `studio-types` are static, and
// the reason `spike-notebook-view` asserts option shape rather than showing a
// widget clipped — jsdom has no layout engine). So this pins the four decisions
// the fix rests on, each of which is silent when broken: the rendering simply
// goes back to being wrong, in a place only a human with a 1 MB file will look.
//
// Each was measured against monaco-editor 0.55.1 in a real Chromium before being
// written down, rather than reasoned about — `fixedOverflowWidgets` on its own
// was the obvious fix and rendered pixel-identical to the bug.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  \u2713 " : "  \u2717 ") + msg);
  if (!cond) failed++;
};

const controller = read("packages/studio/src/vv/controller.ts");
const css = read("packages/studio/src/index.css");
const appShell = read("packages/studio/src/components/ide/AppShell.tsx");

// ---------------------------------------------------------------------------
console.log("\n== every editor in the pane hands its widgets to the shared host ==");
// One missed call site is one editor whose tooltips still go under the preview,
// and all three live in this file: the text editor, the diff editor, and the
// notebook cells (whose options module takes Monaco as a parameter so it can be
// driven without a DOM, so the host is passed in from here rather than imported
// there).
// ---------------------------------------------------------------------------
{
  const mounts = [
    ["text editor", /monaco\.editor\.create\(el,\s*\{/],
    ["diff editor", /monaco\.editor\.createDiffEditor\(el,\s*\{/],
    ["notebook cells", /editors\.mount\(el,[^{]*\{/],
  ];
  for (const [what, open] of mounts) {
    const at = controller.search(open);
    ok(at !== -1, `${what}: found the call site`);
    if (at === -1) continue;
    // The options literal, to its closing brace at the same indent.
    const body = controller.slice(at, at + 4000);
    const end = body.search(/\n {4}\}\)/);
    const opts = end === -1 ? body : body.slice(0, end);
    ok(
      /overflowWidgetsDomNode:\s*overflowWidgetsNode\(\)/.test(opts),
      `${what}: reparents its overflowing widgets into the shared host`,
    );
  }
}

// ---------------------------------------------------------------------------
console.log("\n== the host is outside the app, and themed ==");
// ---------------------------------------------------------------------------
{
  const fn = controller.slice(controller.indexOf("function overflowWidgetsNode"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  ok(/document\.body\.appendChild\(/.test(body),
    "the host is appended to document.body — a later sibling of the app is the whole point, since that is what wins the paint order against the preview");
  ok(/className\s*=\s*"[^"]*\bmonaco-editor\b/.test(body),
    "…and carries the `monaco-editor` class: the standalone theme service emits every --vscode-* colour on `.monaco-editor, .monaco-diff-editor, .monaco-component`, so a widget outside one renders with no background over whatever it covers");
  ok(/fixedOverflowWidgets:\s*true/.test(controller),
    "fixedOverflowWidgets is on, so Monaco lays widgets out in page coordinates clamped to the window rather than against the editor");
}

// ---------------------------------------------------------------------------
console.log("\n== the host cannot paint over the app by accident ==");
// `.monaco-editor` is not free: it carries `background-color:
// var(--vscode-editor-background)`. On a node sized to anything, that is an
// editor-coloured rectangle over the page.
// ---------------------------------------------------------------------------
{
  const at = css.indexOf(".vv-overflow-widgets");
  ok(at !== -1, "index.css styles the host");
  const rule = css.slice(at, css.indexOf("}", at));
  ok(/width:\s*0/.test(rule) && /height:\s*0/.test(rule),
    "the host is zero-size, so the background the `monaco-editor` class brings paints nothing (the widgets inside are positioned against the viewport, not this box)");
  ok(!/z-index/.test(rule),
    "…and sets no z-index: at `auto` it already beats the panes, which are also `auto`, while still losing to the app's real overlays — a modal should cover a tooltip, not the reverse");
}

// ---------------------------------------------------------------------------
console.log("\n== nothing above the panes turns that ordering back off ==");
// The host wins on DOM order, which holds only while no ancestor of the PANES
// creates a stacking context that the host is not part of. Give `#root` a
// z-index, an `isolation`, or a transform and the app's own layers start beating
// a later sibling again — the tooltip goes back under the preview, and nothing
// else in the app changes visibly.
// ---------------------------------------------------------------------------
{
  const rootAt = css.search(/html,\s*body,\s*#root\s*\{/);
  ok(rootAt !== -1, "index.css has the html/body/#root rule");
  const rootRule = css.slice(rootAt, css.indexOf("}", rootAt));
  const traps = ["z-index", "isolation", "transform", "filter", "perspective", "will-change", "contain"];
  const found = traps.filter((p) => new RegExp(`(^|[;{\\s])${p}\\s*:`).test(rootRule));
  ok(found.length === 0,
    `#root establishes no stacking context${found.length ? ` — found ${found.join(", ")}` : ""}`);

  const shellRoot = appShell.match(/<div className="([^"]*\bflex h-full w-full flex-col[^"]*)"/);
  ok(!!shellRoot, "AppShell's root element is recognisable");
  const classes = shellRoot ? shellRoot[1] : "";
  const shellTraps = /\b(z-\d+|isolate|transform|scale-|rotate-|translate-|blur|backdrop-|will-change|contain-)/.exec(classes);
  ok(!shellTraps,
    `AppShell's root does not either${shellTraps ? ` — found '${shellTraps[0]}'` : ""}`);
}

console.log(failed === 0 ? "\neditor widgets: OK" : `\neditor widgets: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);