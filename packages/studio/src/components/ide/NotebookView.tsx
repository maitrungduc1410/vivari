// The notebook surface: a column of cells, each with its own Monaco editor, and
// the outputs the kernel sent back.
//
// The reason a cell editor is a real Monaco model with `language: "python"` and
// not a textarea is that the studio already registers jedi completion, mypy
// markers and ruff diagnostics against that language id globally
// (`python-lsp.js`, `registerCompletionItemProvider("python", …)`). A model with
// that language gets all of it and this file has to do nothing. The models are
// given real file URIs under the notebook's own folder for the same reason: the
// LSP host resolves a workspace root from `model.uri.path`, so a cell that lives
// nowhere would be completed against nothing.
//
// Everything here is layout. What a Run does, what the counters mean and what a
// save writes are in `vv/notebook/*.js`, which `scripts/spike-notebook.mjs`
// drives — see that file's header for what this split is for.
//
// "Everything here is layout" was once taken to mean this file needed no test,
// and it shipped with every cell editor dead while 186 assertions passed. Who
// owns a cell's editor and its model therefore lives in
// `vv/notebook/cell-editors.js`, and `scripts/spike-notebook-view.mjs` renders
// THIS component headlessly — under <StrictMode>, which is what the studio ships
// — and asserts that each cell gets a live editor holding that cell's source.
//
// ── "use no memo", and why three components here carry it ────────────────────
//
// The studio compiles with the React Compiler (vite.config.ts wires
// `reactCompilerPreset()` through @rolldown/plugin-babel), and the compiler
// memoises on IDENTITY. `NotebookDoc` and `NotebookSession` are mutable stores:
// a run does `c.outputs.push(…)`, `c.queued = false`, `session.queue.shift()`
// and then bumps a version, so the array, the cell and the store are the same
// objects they were before. Compile this file and read the output and the whole
// bug is written out in it —
//
//     if ($[5] !== cells || $[6] !== doc.selected || $[7] !== doc.stale …)
//     …
//     else { t4 = $[9]; }        // Notebook: the entire cell list, cached
//
//     if ($[19] !== cell.outputs || $[20] !== isCode || $[21] !== stale)
//     …
//     else { t10 = $[22]; }      // CellRow: the outputs block, cached
//
// — because none of those deps change when a cell produces output. So the store
// notified, useSyncExternalStore re-rendered, and the compiler handed back the
// identical element tree: React reconciled nothing and the screen kept the last
// frame until the tab was switched away and back, which unmounts this view
// (EditorGroup keys it on the active tab) and throws the memo cache out. That is
// exactly what the user saw, and it is why every link in the notification chain
// reads correct — the break is in code that is not in this file.
//
// The directive is the React Compiler's own escape hatch for reading a mutable
// source, and it goes on the three components that memoise on a store OBJECT:
// Notebook (`cells`, `doc.stale`, `session.queue`), CellRow (`cell.outputs`) and
// Toolbar (`session.log`). Everything else here — ExecutionMark, MarkdownCell,
// OutputView, DataView, IconBtn, DeadKernelBanner — derives from primitives or
// from output objects that ARE replaced on write, so it keeps its memoisation,
// including the DOM-parsing sanitiser in DataView, which is the expensive one.
//
// THE RULE, for the next component added here: if it reads a field off `doc`,
// `session` or a `cell` that is an object or an array, it needs this directive.
// `spike-notebook-view.mjs` compiles the bundle through the real React Compiler
// for this reason, and asserts a repaint WITHOUT a remount — so the check is on
// the behaviour rather than on remembering the rule.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import Play from "~icons/lucide/play";
import Square from "~icons/lucide/square";
import RotateCcw from "~icons/lucide/rotate-ccw";
import Plus from "~icons/lucide/plus";
import Trash2 from "~icons/lucide/trash-2";
import ChevronUp from "~icons/lucide/chevron-up";
import ChevronDown from "~icons/lucide/chevron-down";
import FastForward from "~icons/lucide/fast-forward";
import Eraser from "~icons/lucide/eraser";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import type { NotebookHandle } from "@/vv/controller";
import type { CellEditorSlot } from "@/vv/notebook/cell-editors.js";
import type { Cell, DataOutput, ErrorOutput, Output, StreamOutput } from "@/vv/notebook/ipynb.js";
import { chooseRender, renderMarkdown, stripAnsi } from "@/vv/notebook/render.js";
import { useIde } from "./useIde";

export function NotebookView({ abs }: { abs: string }) {
  const { c } = useIde();
  const handle = c.notebook(abs);
  if (!handle) return <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">Loading notebook…</div>;
  return <Notebook handle={handle} />;
}

function Notebook({ handle }: { handle: NotebookHandle }) {
  "use no memo"; // reads doc.cells / doc.stale / session.queue — see the header
  const { doc, session } = handle;
  useSyncExternalStore(doc.subscribe, doc.getSnapshot);
  const cells = doc.cells;
  const busy = session.status === "busy";

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Cell-level shortcuts only fire outside an editor; Monaco owns its own keys
    // and handles Shift-Enter itself (see CellEditor).
    if ((e.target as HTMLElement).closest(".vv-cell-editor")) return;
    if (e.key === "a" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      doc.insert("code", doc.indexOf(doc.selected ?? "") );
    } else if (e.key === "b" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      doc.insert("code");
    } else if (e.key === "m" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (doc.selected) doc.setType(doc.selected, "markdown");
    } else if (e.key === "y" && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      if (doc.selected) doc.setType(doc.selected, "code");
    }
  };

  return (
    <div className="absolute inset-0 flex flex-col bg-background" onKeyDown={onKeyDown}>
      <Toolbar handle={handle} />
      <DeadKernelBanner handle={handle} />
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        <div className="mx-auto flex max-w-4xl flex-col gap-2">
          {cells.map((cell, i) => (
            <CellRow
              key={cell.id}
              cell={cell}
              handle={handle}
              stale={doc.stale.has(cell.id)}
              selected={doc.selected === cell.id}
              first={i === 0}
              last={i === cells.length - 1}
            />
          ))}
          <div className="flex justify-center gap-2 py-4">
            <Button variant="ghost" size="sm" onClick={() => doc.insert("code", cells.length)}>
              <Plus className="size-3.5" /> Code
            </Button>
            <Button variant="ghost" size="sm" onClick={() => doc.insert("markdown", cells.length)}>
              <Plus className="size-3.5" /> Markdown
            </Button>
          </div>
        </div>
      </div>
      {busy && session.queue.length > 0 && (
        <div className="shrink-0 border-t bg-muted/40 px-4 py-1 text-xs text-muted-foreground">
          {session.queue.length} cell{session.queue.length === 1 ? "" : "s"} queued — one interpreter, so they run in turn
        </div>
      )}
    </div>
  );
}

/**
 * The kernel is gone. Say so where the user is, and offer the one action that
 * helps.
 *
 * This exists because a crashed kernel produced NOTHING on screen: the frames
 * stopped, the cell sat there, and the reason was in a terminal the notebook does
 * not show. A status dot two words wide is not a report — the same argument as the
 * swallowed cell-editor rejection, in the same file's history.
 */
function DeadKernelBanner({ handle }: { handle: NotebookHandle }) {
  const { session } = handle;
  if (session.status !== "dead") return null;
  const why = session.exit?.ename
    ? `${session.exit.ename}${session.exit.evalue ? `: ${session.exit.evalue}` : ""}`
    : `exit code ${session.exit?.code ?? "unknown"}`;
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-4 py-1.5 text-xs text-foreground">
      <span className="font-medium">The Python kernel stopped ({why}).</span>
      <span className="text-muted-foreground">
        Cell state is gone. Restart to run cells again — the kernel log has everything it printed.
      </span>
      <div className="flex-1" />
      <Button variant="outline" size="sm" onClick={() => handle.restart()}>
        <RotateCcw className="size-3.5" /> Restart kernel
      </Button>
    </div>
  );
}

// ── toolbar ─────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  off: "no kernel",
  starting: "starting…",
  idle: "idle",
  busy: "busy",
  dead: "kernel exited",
};

function Toolbar({ handle }: { handle: NotebookHandle }) {
  "use no memo"; // the kernel log is an array the session pushes into — see the header
  const { doc, session } = handle;
  const [logOpen, setLogOpen] = useState(false);
  const status = session.status;
  const busy = status === "busy";

  return (
    <div className="shrink-0 border-b">
      <div className="flex h-9 items-center gap-1 px-2">
        <Button variant="ghost" size="sm" onClick={() => handle.runSelected()} title="Run cell (⇧↵)">
          <Play className="size-3.5" /> Run
        </Button>
        <Button variant="ghost" size="sm" onClick={() => handle.runAll()} title="Run every cell, top to bottom">
          <FastForward className="size-3.5" /> Run all
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={!busy}
          onClick={() => handle.interrupt()}
          // Disabled rather than hidden when idle, because "why is this greyed
          // out" is a better question than the one an idle interrupt would raise:
          // at an idle prompt the signal kills the interpreter instead of raising
          // KeyboardInterrupt, so it must not be sent.
          title={busy ? "Interrupt the running cell (SIGINT)" : "Nothing is running"}
        >
          <Square className="size-3.5" /> Interrupt
        </Button>
        <Button variant="ghost" size="sm" onClick={() => handle.restart()} title="Throw the interpreter away and start a new one">
          <RotateCcw className="size-3.5" /> Restart
        </Button>
        <Button variant="ghost" size="sm" onClick={() => doc.clearAllOutputs()} title="Clear every cell's output">
          <Eraser className="size-3.5" /> Clear
        </Button>

        <div className="flex-1" />

        <button
          type="button"
          className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent"
          onClick={() => setLogOpen((v) => !v)}
          title="What the kernel process printed outside the notebook protocol"
        >
          <span
            className={cn(
              "size-2 rounded-full",
              status === "idle" && "bg-emerald-500",
              status === "busy" && "bg-amber-500",
              status === "starting" && "bg-amber-500/60",
              status === "dead" && "bg-destructive",
              status === "off" && "bg-muted-foreground/50",
            )}
          />
          <span>
            Python{session.info ? ` ${session.info.python}` : ""} — {STATUS_LABEL[status] ?? status}
          </span>
        </button>
      </div>
      {logOpen && (
        <div className="max-h-40 overflow-y-auto border-t bg-muted/30 px-3 py-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {session.log.length === 0 ? (
            <span>Nothing yet. Pyodide's loader and any kernel-level error appear here.</span>
          ) : (
            session.log.map((line, i) => <div key={i}>{stripAnsi(line)}</div>)
          )}
        </div>
      )}
    </div>
  );
}

// ── one cell ────────────────────────────────────────────────────────────────

function CellRow({
  cell,
  handle,
  stale,
  selected,
  first,
  last,
}: {
  cell: Cell;
  handle: NotebookHandle;
  stale: boolean;
  selected: boolean;
  first: boolean;
  last: boolean;
}) {
  "use no memo"; // cell.outputs is pushed into in place — see the header
  const { doc } = handle;
  const isCode = cell.type === "code";
  const [editing, setEditing] = useState(cell.type === "markdown" && cell.source === "");

  return (
    <div
      className={cn("group rounded-md border border-transparent", selected && "border-border bg-muted/20")}
      onFocusCapture={() => doc.select(cell.id)}
      onMouseDown={() => doc.select(cell.id)}
    >
      <div className="flex items-start gap-2 p-1.5">
        {/* The execution count, which is the notebook's only honest record of the
            order the interpreter saw things in. */}
        <div className={cn("w-14 shrink-0 pt-1.5 text-right font-mono text-[11px]", stale ? "text-muted-foreground/40" : "text-muted-foreground")}>
          {isCode ? <ExecutionMark cell={cell} /> : null}
        </div>

        <div className="min-w-0 flex-1">
          {isCode || editing ? (
            <CellEditor cell={cell} handle={handle} onBlurMarkdown={() => setEditing(false)} />
          ) : (
            <MarkdownCell cell={cell} onEdit={() => setEditing(true)} />
          )}
          {isCode && cell.outputs.length > 0 && (
            <div className={cn("mt-1.5 border-l-2 border-border/60 pl-3", stale && "opacity-60")}>
              {cell.outputs.map((out, i) => (
                <OutputView key={i} out={out} />
              ))}
            </div>
          )}
          {/* What this cell is waiting for, while it waits. The first import of a
              vendored package fetches ~20 MB of wheels, and the alternative to
              saying so is a cell that looks hung. */}
          {cell.loading && (
            <div className="mt-1.5 pl-3 text-xs italic text-muted-foreground">{cell.loading}</div>
          )}
          {cell.aborted && (
            <div className="mt-1.5 pl-3 text-xs italic text-muted-foreground">{cell.aborted}</div>
          )}
        </div>

        <div className="flex shrink-0 flex-col gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
          {isCode && (
            <IconBtn title="Run this cell" onClick={() => handle.run(cell.id)}>
              <Play className="size-3" />
            </IconBtn>
          )}
          <IconBtn title="Move up" disabled={first} onClick={() => doc.move(cell.id, -1)}>
            <ChevronUp className="size-3" />
          </IconBtn>
          <IconBtn title="Move down" disabled={last} onClick={() => doc.move(cell.id, 1)}>
            <ChevronDown className="size-3" />
          </IconBtn>
          <IconBtn title="Delete this cell" onClick={() => doc.remove(cell.id)}>
            <Trash2 className="size-3" />
          </IconBtn>
        </div>
      </div>
    </div>
  );
}

/** `[ ]` never run, `[*]` queued or running, `[7]` the seventh thing this
 *  interpreter did. Same notation as every other notebook, for the same reason. */
function ExecutionMark({ cell }: { cell: Cell }) {
  if (cell.queued) return <span>[*]</span>;
  return <span>[{cell.executionCount ?? " "}]</span>;
}

function IconBtn({ title, onClick, disabled, children }: { title: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

// ── the editor for one cell ─────────────────────────────────────────────────

function CellEditor({ cell, handle, onBlurMarkdown }: { cell: Cell; handle: NotebookHandle; onBlurMarkdown: () => void }) {
  const { doc } = handle;
  const hostRef = useRef<HTMLDivElement | null>(null);
  // The cell object is replaced on every store change; the commands registered
  // below outlive it, so they read the id through this rather than closing over
  // the one that existed when the editor was made.
  const cellRef = useRef(cell);
  cellRef.current = cell;

  const mount = useCallback(
    (el: HTMLDivElement | null) => {
      hostRef.current = el;
    },
    [],
  );

  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    // This effect runs TWICE for every cell: the studio renders under
    // <StrictMode> (main.tsx), and building an editor is asynchronous because
    // Monaco is imported on demand — so the first run's cleanup lands while the
    // second run is still in flight. Everything below is written for that, and
    // notebook/cell-editors.js carries the rules and the bug they came from.
    let released = false;
    let slot: CellEditorSlot | null = null;

    handle
      .createCellEditor(el, cell.id, cell.type === "markdown" ? "markdown" : "python")
      .then((made) => {
        // Null is "there is no editor to show", and it has already been reported
        // if that was a failure rather than a deleted cell (see the handle).
        if (!made) return;
        if (released) {
          made.release();
          return;
        }
        slot = made;
        const { editor, model } = made;

        // Height follows content: a notebook cell has no scrollbar of its own, it
        // is as tall as the code in it.
        const resize = () => {
          const h = Math.max(22, editor.getContentHeight());
          el.style.height = `${h}px`;
          editor.layout({ width: el.clientWidth, height: h });
        };
        editor.onDidContentSizeChange(resize);
        resize();

        // The EDITOR's change event, not the model's: the model outlives this
        // mount, so a listener registered on it would outlive it too and keep
        // writing into the document from an editor that is gone.
        editor.onDidChangeModelContent(() => doc.setSource(cellRef.current.id, model.getValue()));

        // Shift-Enter runs and moves on; Ctrl/Cmd-Enter runs and stays. Both are
        // the notebook conventions, and both are registered on the editor because
        // Monaco has the keyboard while a cell is focused.
        editor.addCommand(
          // eslint-disable-next-line no-bitwise -- Monaco's KeyMod|KeyCode is a bitfield
          made.monaco.KeyMod.Shift | made.monaco.KeyCode.Enter,
          () => {
            handle.run(cellRef.current.id);
            handle.focusAfter(cellRef.current.id);
            onBlurMarkdown();
          },
        );
        editor.addCommand(
          // eslint-disable-next-line no-bitwise -- as above
          made.monaco.KeyMod.CtrlCmd | made.monaco.KeyCode.Enter,
          () => {
            handle.run(cellRef.current.id);
            onBlurMarkdown();
          },
        );
        editor.onDidFocusEditorText(() => doc.select(cellRef.current.id));
        if (cellRef.current.type === "markdown") editor.onDidBlurEditorText(() => onBlurMarkdown());
      })
      .catch((err: unknown) => {
        // The backstop for this whole chain, including the body above. A throw
        // in here leaves a cell that renders as an empty box, which looks like a
        // broken notebook rather than like an error — so it has to say so
        // somewhere, and until now nothing did.
        console.error(`[notebook] cell ${cell.id}: editor did not mount`, err);
      });

    return () => {
      released = true;
      // The EDITOR only. The model belongs to the notebook, so a cleanup that
      // lands after a later mount can no longer take the model out from under
      // the editor the user is looking at — which is precisely what left every
      // cell an empty 22px box. `release()` is itself a no-op once a later mount
      // owns the slot.
      slot?.release();
    };
    // Only the cell's identity and type: re-running this on any other change would
    // throw the editor away mid-edit. A type change genuinely does need a new model
    // (a different language, and a different URI extension for the LSP).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cell.id, cell.type]);

  return <div ref={mount} className="vv-cell-editor overflow-hidden rounded border bg-card" />;
}

function MarkdownCell({ cell, onEdit }: { cell: Cell; onEdit: () => void }) {
  const html = useMemo(() => renderMarkdown(cell.source), [cell.source]);
  return (
    <div
      className="vv-md prose-sm max-w-none cursor-text overflow-x-auto rounded px-1 py-0.5 text-sm hover:bg-muted/30"
      onDoubleClick={onEdit}
      title="Double-click to edit"
      // Contained on the same terms as an output, and for the same reason: a
      // markdown CELL is a stranger's document rendered when the file is opened,
      // which is the earlier half of the same threat. Nothing it can carry needs
      // this today — renderMarkdown escapes its input before any rule runs, so this
      // string contains only markup this studio generated (render.js) — and the
      // containment is here so that stops being the load-bearing fact.
      style={{ contain: "layout paint" }}
      dangerouslySetInnerHTML={{ __html: html || '<span class="text-muted-foreground">Empty markdown cell — double-click to edit</span>' }}
    />
  );
}

// ── outputs ─────────────────────────────────────────────────────────────────

function OutputView({ out }: { out: Output }) {
  if (out.output_type === "stream") {
    const s = out as StreamOutput;
    return (
      <pre className={cn("whitespace-pre-wrap break-words font-mono text-xs leading-relaxed", s.name === "stderr" && "text-destructive")}>
        {stripAnsi(s.text)}
      </pre>
    );
  }
  if (out.output_type === "error") {
    const e = out as ErrorOutput;
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-destructive">
        {e.traceback.length ? e.traceback.map(stripAnsi).join("\n") : `${e.ename}: ${e.evalue}`}
      </pre>
    );
  }
  if (out.output_type === "execute_result" || out.output_type === "display_data") {
    return <DataView data={(out as DataOutput).data} />;
  }
  // An output type from a newer front end. Said out loud rather than rendered as
  // a blank space, and preserved on save either way (ipynb.js).
  return (
    <div className="py-1 font-mono text-xs italic text-muted-foreground">
      [{out.output_type} — this notebook editor cannot render it; it is preserved on save]
    </div>
  );
}

function DataView({ data }: { data: Record<string, unknown> }) {
  // Which representation to draw, and what to draw it as, is `chooseRender` in
  // render.js — a decision spread across this component's branches is a decision
  // no tier can drive, and every rendering bug this feature has had was in one of
  // them. Memoised because sanitising is a DOM parse: it must not run again
  // because a keystroke elsewhere in the notebook re-rendered the page.
  const picked = useMemo(() => chooseRender(data), [data]);
  if (!picked) return null;
  if (picked.kind === "image") {
    // The alt names the mime rather than being empty. An empty alt declares the
    // image decorative, so a payload that is well-formed enough to pass the checks
    // in render.js and still fails to decode would render as nothing and SAY
    // nothing — the same silence this whole area has been fixing, one layer down.
    return <img className="my-1 max-w-full" src={picked.src} alt={picked.mime} />;
  }
  if (picked.kind === "html" || picked.kind === "markdown") {
    // Sanitised against the allowlist in render.js: opening a notebook is not
    // consent to run the script somebody put in its saved output.
    //
    // CONTAINMENT, and it is a security boundary rather than a layout preference.
    // The `style` ATTRIBUTE is allowlisted — pandas' tables are made of it — and
    // refused only for `url(`, which covers fetching and not painting. So
    // `position:fixed;inset:0;width:100vw;height:100vh;background:#fff` arrives
    // intact and covers the studio, in the origin holding the kernel bridge, with
    // an allowlisted `<a href="https://…">` on top of it: a sign-in panel out of a
    // file somebody opened. `contain: layout paint` makes this div the containing
    // block for fixed and absolute descendants AND clips their painting to its
    // padding box, so the whole category is bounded by the output's own area —
    // including `transform`, `position: sticky` and negative margins, which a list
    // of refused property names would each have to be extended for. It is inline
    // rather than in index.css because it is not decoration: the next person to
    // edit this line is looking at the sanitiser, and the next person to tidy a
    // stylesheet is not. `spike-notebook-view.mjs` asserts it on the mounted DOM.
    //
    // Both branches get it, though only `html` can carry a style attribute today —
    // `renderMarkdown` escapes its input before any rule runs. That is a property
    // of a hand-written renderer that would not survive swapping in a library, and
    // this file should not be the thing that has to remember.
    //
    // THE ONE WAY TO TURN THIS OFF BY ACCIDENT: containment does not apply to
    // `display: contents`, to an inline box, or to an internal table box. Both of
    // these are block divs, and flattening either — a wrapper removed to fix a
    // margin, `display: contents` to let a child participate in a grid — disables
    // the boundary silently, because `getComputedStyle().contain` still reports
    // `layout paint`: the computed value does not depend on the declaration taking
    // effect. So the spike's assertion would stay green through exactly that edit.
    // Keep these display:block, or move the containment to whatever box replaces
    // them.
    const cls = picked.kind === "markdown" ? "vv-md prose-sm my-1 max-w-none" : "vv-nb-html my-1";
    return (
      <div
        className={`${cls} overflow-x-auto text-sm`}
        // Paired with the containment above: clipping content the user cannot then
        // scroll to would be this feature's own silent-blank-output bug, one layer out.
        style={{ contain: "layout paint" }}
        dangerouslySetInnerHTML={{ __html: picked.html }}
      />
    );
  }
  if (picked.kind === "json") {
    return <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{JSON.stringify(picked.value, null, 2)}</pre>;
  }
  if (picked.kind === "notice") {
    return <div className="py-1 font-mono text-xs italic text-muted-foreground">{picked.text}</div>;
  }
  return <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">{stripAnsi(picked.text)}</pre>;
}
