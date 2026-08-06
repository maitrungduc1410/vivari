// The notebook kernel: a Python program that executes cells and reports what
// happened, one JSON line at a time.
//
// Plain JS (not TS) so `scripts/spike-notebook.mjs` can import these exact bytes
// and run them under the host's real CPython — see `s3-app-source.js` for the
// same arrangement and the same reason. The spike is the only place the
// execution semantics below are actually executed, so a copy would be worse than
// no test at all.
//
// WHY A PYTHON PROGRAM AND NOT A JS ONE. There is exactly one Pyodide per process
// worker (`builtins/python.js`, "One Pyodide per process"), and the notebook needs
// one interpreter across many cells. Keeping the execution semantics — the
// last-expression rule, the display protocol, what a traceback is trimmed to —
// inside one Python program is what lets the offline spike run the shipped bytes
// under the host's own CPython, where no browser is needed to prove any of it.
//
// WHO CALLS IT. Two hosts, and the difference between them is the reason this file
// is arranged the way it is:
//
//   * `python <NB_KERNEL_PATH>` — main() below reads its own stdin, blocking on
//     `input()` (a real syscall, OP_STDIN). This is what a person gets by running
//     the file, and what the offline spike drives.
//   * the studio's kernel — `python --vv-notebook-kernel <NB_KERNEL_PATH>`, which
//     runs this module for its definitions and then drives it a line at a time
//     from JS (`notebookKernel` in packages/runtime/builtins/python.js).
//
// The studio needs the second one because a cell's imports have to be resolved
// against the package index before the cell is exec'd, fetching a wheel is
// asynchronous, and Python here has no way to await: the worker thread is what
// would have to block, and blocking it is what stops the fetch from completing.
// So the await lives in JS, on the other side of `source_of()` / `handle_line()`,
// and nothing about a cell's execution moved out of Python.
//
// THE PROTOCOL. Requests arrive as one JSON object per line (JSON escapes
// newlines, so a cell of any size is still one line). Replies go to stdout as
// `\x1e` + JSON + `\n`: `ready`, `busy`, `stream`, `display`, `result`, `error`,
// `done`, plus `loading` (wheels are being fetched for this cell — transient) and
// `dead` (this kernel is about to stop, and here is why). The record-separator
// prefix is there because stdout is shared with the shell that launched us and
// with Pyodide's own package loader; anything without it is kernel noise, not a
// frame.
//
// WHAT STDOUT IS NOT. The cell's own `print()` never reaches the real stdout —
// `sys.stdout` is swapped for a writer that turns each write into a `stream`
// frame. That is what makes output land in the cell that produced it instead of
// in a terminal, and it is why a cell cannot read stdin: the protocol owns it.
// `input()` says so rather than silently eating the next frame.

/**
 * The kernel program. Written to `/tmp` and run as `python <path>`.
 *
 * Authoring note: everything below is Python inside a JS template literal, so a
 * backtick in a comment down there has to be escaped, as the ones already there
 * are. Unescaped it ends the string, and what you get is a JS SyntaxError pointing
 * at a line of Python — which cost two cycles in one sitting before this note
 * existed. A newline escape and a literal backslash need the same doubling.
 */
export const NB_KERNEL_PY = `# Vivari notebook kernel. Generated — see packages/studio/src/vv/notebook/kernel-source.js.
import ast
import base64
import builtins
import io
import json
import linecache
import os
import sys
import traceback

RS = "\\x1e"
# The real stdout, captured before anything is swapped. Every frame goes here and
# nothing else does.
_RAW = sys.stdout


# The six characters \\u001e, obtained from json itself rather than typed, so that
# it cannot drift from what the escaping below is undoing.
_RS_ESCAPED = json.dumps(RS)[1:-1]


def emit(obj):
    # THE FRAMING INVARIANT: a frame's own bytes never contain the separator.
    # The reader (session.js) splits a line at its LAST separator so that junk
    # arriving on the same line cannot swallow the frame behind it, and that is
    # correct only while this holds. json.dumps escapes control characters, so it
    # already holds today — but that is a property of this writer's default
    # arguments, not of the protocol, and ensure_ascii=False or a second writer
    # would break framing silently. Enforced here, where there is exactly one
    # place to enforce it, rather than assumed there.
    #
    # AND THE FRAME HAS TO BE PARSEABLE BY THE THING THAT READS IT, which is not
    # the same requirement and is not satisfied by default. Python writes bare
    # NaN, Infinity and -Infinity for out-of-range floats; JSON.parse rejects all
    # three, because none of them is JSON. So a frame could serialise perfectly
    # here and arrive unreadable: the reader's catch files it in the collapsed
    # kernel log, the done frame on the next line lands normally, and the cell
    # goes idle having shown NOTHING. Not an error, not a partial render -
    # silence, which is the failure this whole feature keeps producing.
    #
    # allow_nan=False turns that into a ValueError at the one call that knows the
    # frame is about to cross the boundary, where every caller already handles an
    # exception by SAYING so. A missing value in a Vega-Lite or Plotly spec is the
    # ordinary case that reaches this, and _repr_mimebundle_ - which passes its
    # values through unconverted - is exactly what those libraries implement.
    # This function is the only place with both facts: what is being written, and
    # what will have to read it.
    text = json.dumps(obj, allow_nan=False).replace(RS, _RS_ESCAPED)
    _RAW.write(RS + text + "\\n")
    _RAW.flush()


# The filename the interpreter itself stamped on this module's code objects, which
# is what _traceback() below has to compare a frame against to know it is ours.
#
# NOT __file__, which is the same string in one of the two environments this
# program runs in and undefined in the other. \`python vv-notebook-kernel.py\`
# defines it; the runtime's notebook driver hands this source to Pyodide's
# eval_code_async, which does not — and _traceback() reads it while HANDLING a
# user's exception, so in the browser the first cell to raise took the kernel down
# with a NameError and the notebook showed nothing at all. A code object always
# knows the name it was compiled under, however it was run, so this is the same
# answer in both places and cannot come apart again.
_SELF = emit.__code__.co_filename


class _CellStream(io.TextIOBase):
    """A cell's stdout/stderr: every write becomes a frame, so output streams.

    Frames are per-write rather than per-line because a progress bar that ends
    each update with a carriage return and no newline is exactly the case a
    line-buffered notebook gets wrong.
    """

    def __init__(self, name):
        self._name = name

    def write(self, s):
        if s:
            emit({"t": "stream", "name": self._name, "text": s})
        return len(s)

    def writable(self):
        return True

    def isatty(self):
        return False

    def flush(self):
        pass


def _no_stdin(prompt=""):
    raise OSError(
        "input() is not available in a notebook cell: the notebook kernel reads "
        "stdin itself to receive cells. Run the script in a terminal "
        "(python your_file.py) if it needs to read input."
    )


def _b64(v):
    if isinstance(v, (bytes, bytearray)):
        return base64.b64encode(bytes(v)).decode("ascii")
    return v


# The IPython display protocol, which is also the .ipynb output schema: an object
# describes itself in as many mime types as it can, and the front end picks. This
# is the whole reason a DataFrame renders as a table and a figure as an image
# without the notebook knowing what either one is.
_REPRS = (
    ("_repr_html_", "text/html"),
    ("_repr_markdown_", "text/markdown"),
    ("_repr_svg_", "image/svg+xml"),
    ("_repr_png_", "image/png"),
    ("_repr_jpeg_", "image/jpeg"),
    ("_repr_latex_", "text/latex"),
)
_BINARY = ("image/png", "image/jpeg")


def mimebundle(obj):
    data = {}
    bundle = getattr(obj, "_repr_mimebundle_", None)
    if callable(bundle):
        try:
            got = bundle()
            if isinstance(got, tuple):
                got = got[0]
            if isinstance(got, dict):
                for k, v in got.items():
                    data[k] = _b64(v) if k in _BINARY else v
        except Exception:
            pass
    for attr, mime in _REPRS:
        if mime in data:
            continue
        fn = getattr(obj, attr, None)
        if not callable(fn):
            continue
        try:
            got = fn()
        except Exception:
            # A repr that raises is the object's problem, not the cell's: fall
            # through to the next one rather than failing the whole execution.
            continue
        if got is None:
            continue
        data[mime] = _b64(got) if mime in _BINARY else got
    try:
        data["text/plain"] = repr(obj)
    except Exception as exc:
        data["text/plain"] = "<unrepresentable: %s>" % exc.__class__.__name__
    return data


def _figures():
    """Emit every open matplotlib figure as an inline PNG, then close it.

    Only if pyplot is ALREADY imported: importing matplotlib to ask whether the
    user wanted it would cost seconds on every cell and pull a package a text-only
    notebook never needs.
    """
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return
    try:
        nums = list(plt.get_fignums())
    except Exception:
        return
    for num in nums:
        try:
            fig = plt.figure(num)
            buf = io.BytesIO()
            fig.savefig(buf, format="png", bbox_inches="tight")
            emit(
                {
                    "t": "display",
                    "data": {"image/png": base64.b64encode(buf.getvalue()).decode("ascii")},
                }
            )
        except Exception:
            pass
    try:
        plt.close("all")
    except Exception:
        pass


def _install_mpl_backend():
    """Point matplotlib's module:// hook at a backend that shows figures INLINE.

    The runtime ships one of these already (module://vv_mpl, builtins/python.js):
    it writes the figure into the project as plot.png and prints where it went,
    which is the right answer for a script whose output is the file tree and the
    wrong one for a cell. Same extension point, different destination — so this
    reuses matplotlib's mechanism rather than adding a second one, and a cell that
    calls plt.show() gets the image where the call was.

    Registered in sys.modules directly: importlib finds it there, so there is no
    file to write and no sys.path to extend. Set before the first pyplot import,
    which is guaranteed — this runs before any cell does.

    A BACKEND IS ITS CANVAS CLASS, NOT ITS show(). \`FigureCanvas = None\` was
    enough to satisfy an import and nothing else: pyplot reads
    \`_get_backend_mod().FigureCanvas.required_interactive_framework\` inside
    switch_backend, which every figure goes through, so \`plt.subplots()\` — the
    first line of the template's own plotting cell — died on
    \`'NoneType' object has no attribute 'required_interactive_framework'\` before
    anything was ever drawn. The class is the Agg one with our manager attached,
    exactly as vv_mpl does it; only the destination differs.

    Built on first READ rather than here, through PEP 562's module __getattr__,
    because building it means importing matplotlib — and this function runs at
    kernel start, in every session, including the ones that never plot. Nothing
    reads the attribute until matplotlib is resolving the backend, by which point
    matplotlib is imported anyway.
    """
    import types as _types

    mod = _types.ModuleType("vv_nb_mpl")

    def show(*_args, **_kwargs):
        _figures()

    def draw_if_interactive():
        pass

    def __getattr__(name):
        if name != "FigureCanvas":
            raise AttributeError(name)
        from matplotlib.backend_bases import FigureManagerBase
        from matplotlib.backends.backend_agg import FigureCanvasAgg

        class FigureManager(FigureManagerBase):
            # figure.show() reaches the MANAGER, not this module's show(), and an
            # Agg manager answers it with "is non-interactive and thus cannot be
            # shown" — true of Agg, untrue of what a cell does with it.
            def show(self):
                _figures()

        class FigureCanvas(FigureCanvasAgg):
            manager_class = FigureManager

        # Cached on the module, so the class is built once and every figure that
        # follows is the same type.
        mod.FigureCanvas = FigureCanvas
        return FigureCanvas

    mod.show = show
    mod.draw_if_interactive = draw_if_interactive
    mod.__getattr__ = __getattr__
    sys.modules["vv_nb_mpl"] = mod
    os.environ["MPLBACKEND"] = "module://vv_nb_mpl"


def _traceback(exc):
    """Format an exception the way a notebook wants it: the cell's frames only.

    The traceback opens with this file's own frames — the try block in
    handle_line() and the exec()/eval() in run_cell() — which are noise the user
    cannot act on and did not write. Drop the whole leading run of them, not just
    the first: how many there are is an implementation detail of this file, and
    hard-coding one left "line 216, in run_cell" on top of every error.

    This function runs while REPORTING a failure, which makes it the one function
    here that must not raise. It did: reading an undefined __file__ turned every
    failed cell into a dead kernel. So the formatting is guarded too — a cell that
    raises must always come back as an error, even if the error is one this cannot
    lay out nicely.
    """
    lines = None
    try:
        tb = exc.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename == _SELF:
            tb = tb.tb_next
        lines = traceback.format_exception(type(exc), exc, tb)
    except Exception:
        try:
            lines = traceback.format_exception_only(type(exc), exc)
        except Exception:
            lines = ["%s (an exception this kernel could not format)" % type(exc).__name__]
    out = []
    for chunk in lines:
        out.extend(chunk.rstrip("\\n").split("\\n"))
    return [l for l in out if l != ""]


def run_cell(source, cell_id, ns):
    """Execute one cell. Returns the value of its last expression, or None.

    The last-expression rule is the notebook's, not Python's: a cell ending in an
    expression shows that expression's value. Everything before it is exec'd, the
    tail is eval'd, so a cell is not silently turned into an expression-statement
    program.
    """
    filename = "<cell %s>" % cell_id
    # linecache is what traceback reads source lines out of. Registering the cell
    # means a traceback points at the line the user is looking at instead of
    # printing nothing where the code should be.
    linecache.cache[filename] = (len(source), None, source.splitlines(True), filename)
    tree = ast.parse(source, filename, "exec")
    tail = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        tail = ast.Expression(tree.body[-1].value)
        ast.copy_location(tail, tree.body[-1])
        tree.body = tree.body[:-1]
    if tree.body:
        exec(compile(tree, filename, "exec"), ns)
    if tail is None:
        return None
    return eval(compile(tail, filename, "eval"), ns)


# The interpreter every cell runs in. One dict for the life of the kernel, which
# is what makes a name defined in one cell visible in the next.
NS = {"__name__": "__main__", "__builtins__": builtins}


def start():
    """Everything that happens before the first cell. Also a driver's entry point."""
    _install_mpl_backend()
    emit({"t": "ready", "python": sys.version.split()[0], "platform": sys.platform})


def source_of(line):
    """The code a request line will execute, or "" if it will execute none.

    Here, rather than in whatever is feeding us lines, so that the protocol stays
    in this one file. The runtime's notebook driver needs exactly this much of it:
    a cell's imports have to be resolved against the package index BEFORE
    handle_line() execs the cell, because fetching a wheel is asynchronous and an
    import statement is not (see the notebook driver in
    packages/runtime/builtins/python.js).
    """
    try:
        req = json.loads(line.strip())
    except Exception:
        return ""
    if not isinstance(req, dict) or req.get("op") != "run":
        return ""
    return req.get("source") or ""


def loading(text):
    """Say what is being fetched for the cell that is about to run.

    A frame rather than a print, so it lands on the cell the user is looking at:
    the first \`import pandas\` in a session is several seconds of nothing, and the
    terminal where Pyodide's loader progress would otherwise appear is a terminal
    nobody has open. Transient by contract — the front end shows it while the cell
    runs and does not keep it in the notebook's outputs.
    """
    emit({"t": "loading", "text": str(text)})


def died(message=None):
    """Report, on the way out, that this kernel is about to stop existing.

    A front end learns the kernel is gone by watching the process exit, and an
    exception in the code above is precisely the case where that signal arrives
    with nothing attached to it: Run pressed, nothing on screen, the reason
    readable only in a terminal the user has no reason to open. So the reason goes
    down the protocol first, while there is still a kernel to send it with.

    \`message\` is for a host that caught what killed us; with no argument this
    reads the exception being handled.
    """
    try:
        if message is None:
            kind, value, _ = sys.exc_info()
            emit(
                {
                    "t": "dead",
                    "ename": kind.__name__ if kind is not None else "SystemExit",
                    "evalue": str(value) if value is not None else "",
                    "traceback": traceback.format_exc().rstrip("\\n").split("\\n"),
                }
            )
        else:
            emit({"t": "dead", "ename": "KernelError", "evalue": str(message), "traceback": [str(message)]})
    except Exception:
        # Nothing left to report with. The exit itself is still visible.
        pass


def handle_line(line):
    """Execute one request line. Returns False when the kernel should stop.

    Split out of main() so a host that has to do asynchronous work between lines
    can drive the kernel one request at a time without reimplementing any of this.

    A REQUEST IS THE UNIT AN INTERRUPT BELONGS TO, and that is what this wrapper is
    for. CPython raises KeyboardInterrupt on whichever bytecode it happens to be
    running when it next reads the interrupt byte, and there is no rule that says
    that bytecode is the user's: measured, a Ctrl-C pressed while a cell's wheels
    were being fetched arrived back here and landed first inside the emit() of the
    busy frame, and then, once that was guarded, inside json.loads of the request
    itself. Both escaped - the parse is guarded by \`except Exception\`, and a
    KeyboardInterrupt is not one - and an escape from here kills the kernel and
    every name the notebook had defined. Chasing the landing site is a losing game,
    so the whole request is wrapped once and reported as the cell's interrupt.
    """
    try:
        return _dispatch(line)
    except KeyboardInterrupt:
        return interrupted(line)


def interrupted(line):
    """Report a KeyboardInterrupt against the cell a request line names.

    Called from two places, because an interrupt can escape from two, and the
    difference is the point. The guard in handle_line covers the body of its try -
    which is nearly everything, and not the function-entry check that sits outside
    the try's range, nor this reporting itself, where a second Ctrl-C can land
    because the session stays \`busy\` until the \`done\` frame below is sent. Those
    residuals are microseconds wide and there is no way to close them from in here:
    a guard can only ever cover the code it encloses.

    So the driver's own \`catch\` calls this too (driveNotebook in
    packages/runtime/builtins/python.js). That one runs for EVERY escape, whatever
    line CPython chose to raise on, so between them there is no landing site left -
    and the belt does not depend on knowing where the raise will happen, which is
    the part nobody has been able to settle by reading.

    Reported as a pair, because the front end is waiting for both: the error is what
    the user sees under the cell, and the \`done\` frame is what returns the session
    to idle so the next Run works.

    BOTH frames name the cell, which the cell-level reports elsewhere in this file do
    not need to do and these two do. Two callers means the pair can be sent twice for
    one request, and the session drops a frame that names a cell other than the one
    it has running (onFrame in session.js) - so the id is what makes the duplicate
    identifiable as a duplicate rather than as news about whatever is running by
    then. An unnamed frame is indistinguishable from a fresh one.
    """
    cell = _cell_id_of(line)
    emit({"t": "error", "id": cell, "ename": "KeyboardInterrupt", "evalue": "", "traceback": ["KeyboardInterrupt"]})
    emit({"t": "done", "id": cell, "status": "error"})
    return True


def _cell_id_of(line):
    """The cell a request names, for a report that has to be made after something
    went wrong in the middle of reading it. Never raises: a missing id is "?"."""
    try:
        return json.loads(line.strip()).get("id") or "?"
    except BaseException:
        return "?"


def _dispatch(line):
    line = line.strip()
    if not line:
        return True
    try:
        req = json.loads(line)
    except Exception:
        return True
    op = req.get("op")
    if op == "shutdown":
        return False
    if op != "run":
        return True

    cell_id = req.get("id") or "?"
    source = req.get("source") or ""
    emit({"t": "busy", "id": cell_id})

    out, err = _CellStream("stdout"), _CellStream("stderr")
    real_out, real_err, real_input = sys.stdout, sys.stderr, builtins.input
    sys.stdout, sys.stderr, builtins.input = out, err, _no_stdin
    status, value = "ok", None
    try:
        value = run_cell(source, cell_id, NS)
    except KeyboardInterrupt as exc:
        status = "error"
        emit({"t": "error", "ename": "KeyboardInterrupt", "evalue": "", "traceback": _traceback(exc)})
    except SystemExit as exc:
        # A cell is not a program: sys.exit() reports and returns to the
        # prompt, exactly as it does in a REPL. Killing the interpreter would
        # take every other cell's state with it.
        status = "error"
        emit(
            {
                "t": "error",
                "ename": "SystemExit",
                "evalue": str(exc.code) if exc.code is not None else "",
                "traceback": ["SystemExit: %s" % ("" if exc.code is None else exc.code)],
            }
        )
    except BaseException as exc:  # noqa: BLE001 — a cell may raise anything
        status = "error"
        emit(
            {
                "t": "error",
                "ename": type(exc).__name__,
                "evalue": str(exc),
                "traceback": _traceback(exc),
            }
        )
    finally:
        sys.stdout, sys.stderr, builtins.input = real_out, real_err, real_input

    # Figures first: a cell that plots and then returns a value should show
    # the plot above the value, which is the order they were produced in.
    try:
        _figures()
    except Exception:
        pass
    if status == "ok" and value is not None:
        try:
            emit({"t": "result", "data": mimebundle(value)})
        except Exception as exc:
            emit({"t": "stream", "name": "stderr", "text": "<display failed: %s>\\n" % exc})
    emit({"t": "done", "id": cell_id, "status": status})
    return True


def main():
    """The blocking read loop, for a host that has nothing to do between cells.

    This is the shape \`python vv-notebook-kernel.py\` runs, and the one the offline
    spike drives under the host's own CPython. The studio does NOT use it — its
    kernel needs an await between the line and the exec, to fetch the cell's wheels
    — so nothing that matters is allowed to live in here rather than above.
    """
    start()
    while True:
        try:
            line = input()
        except (EOFError, KeyboardInterrupt):
            # stdin closed, or an interrupt arrived while idle. Either way there
            # is nothing left to execute.
            return
        try:
            if not handle_line(line):
                return
        except BaseException:
            died()
            raise


if __name__ == "__main__":
    main()
`;

/** Where the kernel is written in the VM. Outside any project, so it never
 *  shows up in the Explorer or in a user's git status. */
export const NB_KERNEL_PATH = "/tmp/vv-notebook-kernel.py";
