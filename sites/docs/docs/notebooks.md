---
sidebar_position: 8
title: Notebooks
---

# Notebooks

Vivari's studio opens a `.ipynb` as a notebook: a column of cells, each one run
by the same CPython interpreter, with output — text, tracebacks, DataFrames,
plots — underneath the cell that produced it. It reads and writes real
[nbformat] 4 JSON, so a notebook you bring from Jupyter opens here, and one you
write here opens there.

There is no Jupyter server involved, and there could not be: Jupyter's server
needs `tornado`, which needs a socket. The **notebook interface** never needed
one. What a notebook actually requires is an interpreter that stays alive
between cells and a way to talk to it, and both of those already existed here.

[nbformat]: https://nbformat.readthedocs.io/

## Getting one

Create a project from the **Python Notebook** template, or open any `.ipynb` in
the Workspace. Files ending `.ipynb` open in the notebook view rather than as
their JSON; if the file will not parse as nbformat 4, it opens as text instead,
which is the only view that can repair it.

The template is flagged **experimental**. That flag means what it says
everywhere else in this project: the parts of it a headless test can reach are
proven, and the parts that need a real browser tab are not.
`scripts/spike-notebook.mjs` proves the execution semantics and the `.ipynb`
round-trip; `scripts/spike-notebook-view.mjs` renders the notebook view itself
under jsdom and proves every cell gets a live editor holding that cell's source.
What is left on the other side of the line is the kernel actually launching in
the VM, and a figure coming back from the real matplotlib.

## Keys

| | |
| --- | --- |
| `Shift-Enter` | run the cell and move to the next one, appending one if there is none |
| `Ctrl-Enter` / `Cmd-Enter` | run the cell and stay in it |
| `a` / `b` | insert a cell above / below (with a cell selected, not while typing in one) |
| `m` / `y` | turn the selected cell into markdown / code |
| double-click | edit a rendered markdown cell |

Cell editors are the studio's own Monaco editors with the language set to
Python, so they get everything a `.py` file gets: jedi completion, mypy markers
and ruff diagnostics, without the notebook doing anything to arrange it.

## One interpreter, and what follows from that

Every cell runs in one CPython, so a name defined in cell 1 is there in cell 3.
That is the whole point, and everything below is a consequence of it.

**There are no threads.** Pyodide has none, so cells run strictly one at a time.
Pressing Run on four cells queues four cells, and they run in the order you
pressed them.

**The number beside a cell is the order the interpreter saw it in.** `[ ]` has
never run, `[*]` is queued or running, `[7]` was the seventh thing this
interpreter did. It is handed out when a cell *starts*, so it is not the order
the cells appear on screen — which is exactly what makes it worth showing. A
notebook that reads top to bottom but ran out of order is the oldest bug in the
format, and the counters are how you catch it.

**Interrupt sends a real `SIGINT`.** A runaway loop stops with a
`KeyboardInterrupt` reported against your line, and the interpreter keeps
everything it had defined. Interrupting also abandons anything still queued:
those cells were queued on the assumption that this one finished.

That holds during the wait for a package too. A cell whose first line is `import
pandas` spends its first seconds fetching wheels rather than running, and stop
works there: the download cannot be cancelled — nothing here can abort a fetch —
but the cell does not run, the interpreter keeps its state, and you get the
`KeyboardInterrupt` you asked for. It used to take the whole session with it.

Interrupt only works **while a cell is running**, and the button is disabled
otherwise. At an idle prompt the interpreter is parked in the stdin syscall, and
a signal there ends the process instead of raising — the same rough edge the
[REPL has](python.md). Sending one anyway would throw away the session to stop
nothing.

**Restart** replaces the interpreter. Outputs stay where they are, because they
are the record of what happened and you are usually restarting *because* of
them; they are dimmed, and the execution counters go, because they described an
interpreter that no longer exists.

## Output

Anything a cell prints appears under it as it is written, `stderr` in red. The
value of a cell's last expression is shown the way a REPL shows it — an
assignment, a bare `print()` or a `None` produce nothing.

A child process counts as the cell's output too: `subprocess.run(["ruff",
"check", "."])` in a cell puts `ruff`'s output under the cell, not in a terminal
you cannot see. The one difference from a script is *when* — the notebook reads
the child's output back through Python rather than letting it write directly, so
it arrives when the child exits rather than line by line while it runs.

Rich output uses the same protocol IPython does, which is also the one `.ipynb`
stores: an object describes itself in as many MIME types as it can, and the
notebook renders the richest one it understands. A pandas `DataFrame` has
`_repr_html_`, so it renders as a table. Anything with `_repr_png_`,
`_repr_svg_`, `_repr_markdown_` or `_repr_mimebundle_` works the same way, with
`repr()` as the fallback.

### Plots

```python
import matplotlib.pyplot as plt

fig, ax = plt.subplots()
ax.plot([1, 4, 9, 16])
plt.show()
```

The figure appears under the cell. There is no `savefig` and no file to open.

This is the same mechanism the rest of Vivari's matplotlib support uses — a
`module://` backend, matplotlib's own extension point — pointed somewhere else.
Outside a notebook, `plt.show()` writes the figure into your project as
`plot.png`, because for a script the file tree *is* the output. In a notebook
the figure goes back to the cell instead. A cell that leaves a figure open
without calling `show()` gets it collected at the end of the cell, the way an
inline backend does.

### HTML in outputs is sanitised

Jupyter's answer to untrusted HTML in a saved notebook is a trust signature:
a notebook you did not execute yourself has its HTML stripped. There is no
signature store here, so a stricter rule applies instead — output HTML is
filtered through an allowlist before it is rendered. Tables, spans, inline
`style` attributes and inline images survive, which is what the libraries that
emit HTML actually use. Scripts, iframes, event handlers, `javascript:` URLs and
remote URLs in a `style` attribute do not.

Neither does a `<style>` block. A stylesheet is not scoped to the output it
arrived in, so a notebook from a stranger could restyle the editor around it —
and a `<style>` element's contents are text to an HTML parser, which is exactly
what an allowlist of tags and attributes does not inspect. `pandas` needs only
the attribute, which still works. The same goes for `<template>`, whose contents
an HTML parser puts somewhere a filter walking the document will not visit.

The inline `style` attribute that survives is confined to the output's own area.
An allowlist can say what an output may not fetch or execute; it cannot easily say
what an output may not look like, and a permitted style can position an element
over the editor as convincingly as a script could. So the box an output renders
into clips its own painting and anchors anything positioned inside it. A table can
colour its cells; nothing in a notebook can paint outside its output.

An `image/svg+xml` output renders as an image rather than as inline markup, which
is what keeps a figure a figure: SVG can carry script and external references,
and a browser refuses both to an SVG loaded through `<img>`. Figures from
matplotlib, `_repr_svg_` and friends all render; nothing about them executes.

`.ipynb` is a format people download from strangers, and opening a file is not
consent to run it. The output is preserved in the file either way; it is only
the rendering that is filtered.

## `.ipynb` fidelity

Saving writes nbformat 4 the way `nbformat` itself writes it: one-space indent,
sorted keys, one trailing newline, `source` as a list of lines. That is not
cosmetic — it is what stops a notebook this studio saved from appearing as a
whole-file diff next to one Jupyter saved.

**Fields this editor does not understand are preserved rather than dropped.** A
notebook carries kernelspecs, language info, per-cell tags, slideshow sections,
Colab and VS Code metadata, and output MIME types from libraries that did not
exist when this was written. All of it is kept, and so is anything at the top
level that some other tool put there. An output type this cannot render says so
in place of the output, and still writes it back out whole.

A cell you did not edit is written back **byte for byte**, in the shape it
arrived in — nbformat allows `source` to be a string or a list of lines, real
notebooks contain both, and rewriting one as the other turns opening a file into
a diff across every cell in it.

Two version details, since they are the ones that go wrong quietly:

- `nbformat_minor` is preserved, never silently upgraded.
- Cell `id`s arrived in 4.5. A notebook below that gets ids in memory, so the
  view has something to key on, and **no ids written back**, because writing one
  into a 4.4 notebook makes it fail validation against its own declared version.

nbformat 3 and earlier are refused rather than read: they nest cells under
`worksheets`, which is a different format rather than a smaller one.

## What does not work

**`input()` raises in a cell.** The kernel reads its own stdin to receive cells,
so a cell reading stdin would eat the next one. It fails with a message saying
so, and pointing at the terminal — where `input()` genuinely blocks, on a real
syscall. This is a real difference from Jupyter, which prompts.

**Only some packages are local.** `numpy`, `pandas` and `matplotlib` are
vendored and import with no network. The rest of the scientific stack comes from
the Pyodide CDN on first import — see [Python](python.md) for the full list and
for the `pip install` story, both of which apply here unchanged.

**No widgets.** `ipywidgets` needs a comm channel and a JavaScript half; neither
exists here.

**One notebook, one interpreter.** Two open notebooks are two kernels and two
Pyodide heaps. Closing a notebook stops its interpreter.

## How it is wired, and why

The kernel is a Python program that runs *inside* the VM as an ordinary guest
process, reading one JSON request per line from stdin and writing frames back to
stdout. Nothing was added to the runtime for it: there is already exactly one
Pyodide per process worker, and `input()` is already a genuinely blocking
syscall, so one long-lived `python` process is already the thing a notebook
needs.

It runs in a **shell**, and that is the load-bearing choice. The SDK's
`vivari.spawn` channel would be tidier — clean stdin, `stdout` and `stderr` kept
apart, no shell in the middle — but it has no way to send a signal: a kill on
that channel ends the process. On that channel, "interrupt" could only ever mean
"throw the interpreter away", which is a restart with a misleading label. The
shell has the signal. It hands a foreground child's stdin through untouched and
turns a `Ctrl-C` in that stream into a `SIGINT`, which is what sets the byte
CPython polls. It is the same path a person pressing Ctrl-C in a terminal takes,
which is the argument for using it.

The cost is that the kernel's stdout is shared with the shell, so every protocol
frame carries a record separator and everything without one is treated as
kernel noise — visible behind the status indicator in the notebook's toolbar,
which is also where Pyodide's package loader and any kernel-level crash show up.