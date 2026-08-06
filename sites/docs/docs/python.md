---
sidebar_position: 7
title: Python
---

# Python

Vivari runs **real CPython, compiled to WebAssembly** ([Pyodide]), in the same
browser tab as everything else. Not a transpiler, not a Python-flavoured
interpreter written in JavaScript — the actual reference implementation, version
3.14, with its standard library and its C extension modules.

```bash
python main.py            # run a script
python -c "print(1 + 1)"  # run an inline program
python                    # a REPL
pip install requests-like-things
```

The Pyodide runtime is loaded **lazily**, the first time you run `python`. If a
project never touches Python, it never pays for it.

### The first command is the slow one

Every `python` command is its own process with its own interpreter — that is
what makes a crashing script harmless — and starting CPython costs about **1.8
seconds**. Paying that on every command is what made Python here feel heavy:
`python a.py && python b.py` used to boot twice.

So the first interpreter of a session is **saved** once it has finished starting,
and the ones after it resume from that instead of starting over. A command after
the first spends about **0.2 seconds** getting an interpreter rather than 1.8 —
the REPL, `pytest`, `pip`, everything. The saving lives in the session's
filesystem cache, not on disk, so a reload starts fresh.

Nothing about your program changes: the snapshot is of a bare interpreter, taken
before anything of yours has run. If it cannot be restored for any reason, the
command boots the slow way and says nothing, because a cache that has to be
explained is a cache with a bug. `VV_PYTHON_SNAPSHOT=0` turns it off if you ever
need to rule it out.

### …and so is the first `import pandas`

Getting an interpreter is not the whole wait. `import pandas` costs about **2.3
seconds** the first time, `import matplotlib.pyplot` about 1.9, and almost none
of that is pandas doing anything — it is CPython compiling a thousand `.py`
files to bytecode. Ordinarily it would write that bytecode into `__pycache__`
and never do it again, which is why the second `import pandas` on your own
machine is instant.

Here, each command is a new interpreter with a freshly unpacked copy of every
package, so there was never a second time. Now there is: the bytecode a command
compiles is kept, and the commands after it start from it. `import pandas` drops
to about **0.6 seconds**, and a script that pulls in NumPy, pandas and
Matplotlib saves several seconds a run.

Nothing is compiled ahead of time, and nothing is compiled that you did not
import — the bytecode is simply what your run already produced, kept instead of
thrown away. Only packages are cached this way, never your own modules, so a
file you just edited is never at risk of running as a stale copy. Like the
interpreter cache it lives in the session's filesystem and goes when you reload.
`VV_PYTHON_BYTECODE=0` turns it off.

[Pyodide]: https://pyodide.org

## What works

| | |
| --- | --- |
| **Scripts, the REPL, `-c`** | with the project directory mirrored in, so file I/O and sibling imports work |
| **The scientific stack** | NumPy, pandas, Matplotlib, SciPy and scikit-learn ship vendored and work offline; SymPy and Pillow come from Pyodide's CDN |
| **Spreadsheets** | `pd.read_excel` / `to_excel`, through a vendored openpyxl |
| **`sqlite3`** | compiled into the interpreter; databases are real files |
| **Web frameworks** | Flask, FastAPI and Django, with a live preview |
| **`--reload`** | save a `.py` file and the app is re-imported; a broken save leaves the old one serving |
| **pytest** | including real exit codes, so `pytest && …` behaves |
| **`python -m <module>`** | any importable module, through CPython's own `runpy` — `unittest`, `http.server`, `json.tool` |
| **`subprocess.run`** | spawns the programs in the VM, so a script can drive `pytest` or `ruff`; `Popen` is refused by name |
| **Pure-Python packages from PyPI** | installed at runtime through `micropip` |
| **`pip install` that persists** | into a per-project `.venv`, with `list`/`freeze`/`show`/`uninstall`/`check` |
| **Outbound HTTP** | `requests` or `httpx`, sync or async — subject to the target's CORS headers |
| **SQLAlchemy** | the 2.0 ORM over the built-in SQLite, offline |
| **rich** | tables, colour, trees and progress in a real terminal |
| **ruff** | `ruff check` and `ruff format`, byte-identical to the real ruff, without starting Python |
| **Charts** | `plt.show()` writes the figure into your project and tells you where |
| **Timezones** | `zoneinfo` works: tzdata ships with the runtime |
| **`input()` and `pdb`** | programs that ask questions, and `breakpoint()` with a real prompt |
| **Editor intelligence** | completion, hover, signature help, go-to-definition, formatting, and both ruff and mypy diagnostics |

Start from any of the templates in the Studio's **Native** tab.

## Web servers, without sockets

Pyodide has no sockets, so a Python web server cannot bind a port. Vivari
bridges instead: the `python` launcher is itself a program on Vivari's
Node-compatible runtime, so it stands up a guest HTTP server on the port — which
registers with the kernel exactly like an Express app, opening a preview tab —
and converts each request into a WSGI `environ` or an ASGI `scope`.

That means the commands you already know are the commands you type:

```bash
uvicorn main:app --port 8000                   # FastAPI and other ASGI apps
flask --app main run --port 8000               # Flask
gunicorn wsgi:application --bind 0.0.0.0:8000  # Django and any other WSGI app
```

They are entrypoints, not the real servers: they parse their arguments the way
you expect and hand the app to the bridge.

**Django's `manage.py runserver` is the exception, and it is refused.** It is
the one command in this list that binds a socket itself instead of handing you
an app, and Pyodide's socket accepts `bind()` and `listen()` and then never
reports a connection — so runserver would print `Starting development server at
http://127.0.0.1:8000/` and answer nothing, for as long as you left it. Rather
than let it look like it started, `python manage.py runserver` stops and points
at the `gunicorn` line above, which serves the same app through the bridge. The
rest of `manage.py` is untouched: `migrate`, `makemigrations`, `shell`,
`createsuperuser` and the others all run normally.

Because the preview is served under `/preview/<port>/`, **generate URLs rather
than hardcoding them** — `url_for()`, `reverse()`, `{% url %}`,
`request.url_for()`. The bridge tells your framework which prefix it is mounted
under, so generated URLs stay inside the preview. A hardcoded `/about` will
escape it.

## Restarting on save

`--reload` works, on all three entrypoints:

```bash
uvicorn main:app --reload --port 8000
flask --app main run --reload --port 8000
gunicorn wsgi:application --reload --bind 0.0.0.0:8000
```

Save a `.py` file and the app is re-imported; the next request is served by the
new code. The terminal says which file changed and that the re-import happened,
so a reload that did nothing is not something you have to infer.

This page used to say it was impossible, on the grounds that a reloader needs a
file watcher and a subprocess. Both halves were wrong, and it is worth saying why
rather than just deleting the sentence, because the reasoning is the useful part.

**The filesystem already says when a file changed.** A reloader on your laptop
polls or asks the OS, and under WebAssembly there is no OS to ask. But every
write here goes through one place — the component that owns the virtual
filesystem — and it already tells interested processes what changed, because that
is how Vite's dev server sees your edits and rebuilds. `fs.watch` in a Python
server is the same subscription Vite has been using all along, so what looked
like a missing capability was an unused one. Notably this means an editor save is
seen the same way a write from another program is: the watch is on the
filesystem, not on the editor.

**And there is no process to restart.** `uvicorn` here is not the real uvicorn —
it is an entrypoint that hands your app to the bridge (see above), and the bridge
imports your app into the server's own process. Real `--reload` needs a
subprocess because it has a real server to kill and respawn. Here the thing to
replace is a Python object, so a reload re-imports the module and rebinds it.

### What it re-imports, and what it does not

**A failed re-import changes nothing.** This is the part worth trusting, because
a syntax error in a file you just saved is the normal case rather than the
exceptional one. Your project's modules are set aside, the import is attempted,
and if it raises anything at all the previous set is put back and the app that
was serving keeps serving — including any module that had already been
re-imported before the failure. The traceback goes to the terminal, prefixed
with which file triggered the attempt. Fix the file, save again, and the reload
that follows behaves as though the broken one never happened.

**Your modules are re-executed; the packages under them are not.** A re-import
runs your files again, so module-level code in them runs again and module-level
state in them resets — which is what restarting a process would have done. What
does not reset is anything living inside an installed package: a framework's
cached route table, a connection pool something opened, a registry a library
populated on first import. Real `--reload` gets those for free by starting a new
process, and there is no new process here. If a change is not showing up and it
is not in your own code, restart the server; that is the case this does not
cover.

**`.py` files only, anywhere under the project.** Templates, CSS and data files
are not watched — they are usually re-read per request anyway — and neither is
anything inside `.venv`, `__pycache__`, `node_modules` or `.git`. The `.py`
restriction is also what stops a server that writes files from restarting itself:
those writes are mirrored back to the project at the end of every request, and a
watch that fired on any of them would loop forever.

**A burst of saves is one restart.** "Save all" writes several files; they are
coalesced and the app is re-imported once, after about a fifth of a second of
quiet. A save that lands while a request is in flight waits for that request to
finish rather than re-importing underneath it.

**Flags that narrow the watch are refused rather than ignored.**
`uvicorn --reload-include`, `--reload-exclude`, `--reload-dir`, `--reload-delay`
and `gunicorn --reload-engine`, `--reload-extra-file` all say on stderr that they
are not applied — the watch is `.py` under the project and there is no filter to
set. `flask --debug` means two things, a reloader and Werkzeug's in-browser
debugger; the reloader happens, the debugger does not, and the flag says so
rather than implying both.

## Running a module with `-m`

`python -m <module>` runs whatever you name, through CPython's own `runpy` — the
same code path the interpreter on your laptop uses. So the stdlib runners work
as written:

```bash
python -m unittest discover      # the stdlib test runner, alongside pytest
python -m http.server 8000       # a static server, with a preview tab
python -m json.tool data.json    # and anything else that is importable
```

`python -m unittest` discovers and runs tests against your project directory,
and exits non-zero when they fail. `python -m http.server` is CPython's own
`SimpleHTTPRequestHandler` — the real directory listings, the real MIME types,
the real 404 — served over the same bridge as Flask and FastAPI rather than a
socket, so `--directory` and `--bind` behave and a preview tab opens. `--cgi`
does not: it needs to write to a child's stdin and read its stdout while the
child is still running, which is the one shape of subprocess this runtime cannot
offer (see [Running another program](#running-another-program)).

A handful of modules are refused up front, with the reason: `smtplib`, `ftplib`,
`poplib`, `imaplib`, `socketserver`, `wsgiref.simple_server` and
`xmlrpc.server`. Each of them is a socket and nothing else. This is a refusal
rather than a failure because of a trap — Pyodide *has* a `socket` module, and
`connect()` and `bind()` on it succeed, so these would print their banner, look
like they had started, and then wait forever for bytes that never move.

Anything else that is missing gets CPython's error, not ours:
`python: No module named nosuchthing`, exit 1.

## Running another program

`subprocess.run()` works. A script can drive the other tools in the VM:

```python
import subprocess

subprocess.run(["python", "-m", "pytest"], check=True)
subprocess.run(["ruff", "check", "."], check=True)

out = subprocess.run(["ruff", "--version"], capture_output=True, text=True).stdout
```

This page used to say `subprocess` raised `OSError: [Errno 138] emscripten does
not support processes.` and leave it there. Unpatched, it does — that error is
CPython's, and it is about `fork`, which Emscripten genuinely does not have. The
mistake was reading it as *there are no processes here*. There are: Vivari runs
every command as a real process with its own worker, and Node code in the same VM
has spawned them since long before Python could. `subprocess.run()` is one
blocking call that returns when the child exits, which is the shape the kernel's
spawn already had.

### What can be spawned, and what is simply not here

Programs that exist **inside the VM**: `python`, `pytest`, `ruff`, `mypy`,
`black`, `pip`, `node`, `npm`, `bun`, `sh`, `uvicorn`, `flask`, `gunicorn` and the
handful of file utilities, plus anything on `PATH` — a project's
`node_modules/.bin`, or a console script from your `.venv`.

Native binaries are **not** here, and this is a different limit from the one
above. `git`, `ffmpeg`, `curl` and `gcc` are not part of Vivari and cannot be
installed into it, so:

```python
subprocess.run(["ffmpeg", "-i", "in.mp4", "out.webm"])
```

raises `FileNotFoundError` whose message says the binary is missing and lists
what you *can* run. It deliberately does not say processes are impossible,
because that would teach the wrong lesson about a call that works.

### What is honoured

`args` as a list or, with `shell=True`, a string run through `sh`. `cwd`, `env`,
`check`, `capture_output`, `stdout`/`stderr` as `PIPE`, `DEVNULL`, `STDOUT` or an
open file, `text=` / `encoding=`, and `input=`. Exit codes are the child's, and a non-zero
one under `check=True` raises the real `subprocess.CalledProcessError` with the
output on it — the stdlib's own class, so an existing `except` clause keeps
working. `call()`, `check_call()`, `check_output()`, `getoutput()`,
`getstatusoutput()` and `os.system()` all work, since they all reduce to the same
one call.

With no capture asked for, the child writes straight to your terminal as it goes,
which is what you want watching a test run. Ask for the output and it arrives
whole when the child exits — captured output cannot arrive before the exit that
carries it.

### What is refused, and why

- **`Popen` is refused.** Its contract is that it returns while the child is
  still running, so you can stream its output and write to its stdin. That needs
  either threads or a non-blocking spawn, and this runtime has one interpreter, no
  threads, and a spawn that does not return until the child is gone. Running the
  child to completion inside `Popen()` and serving the buffered output afterwards
  would make `communicate()` pass and make `Popen(["uvicorn", …])` hang forever,
  so it says what it cannot do and points at `run()`. `os.popen` says the same.
- **`timeout=` is refused**, rather than accepted and ignored. Once the child
  starts, the caller is parked until it exits and nothing can interrupt that wait
   — so a timeout could be taken and never enforced, which would turn the one
  argument you wrote to bound a wait into an unbounded one.
- **`stdin=` takes `None`, `PIPE` or `DEVNULL`.** A file or a descriptor is
  refused: the parent is parked from the moment the child starts, so there is no
  pipe left to write into. Pass what you were going to write as `input=`.
- **A file descriptor is refused** where `stdout=` or `stderr=` would take one. A
  child here is a separate worker rather than a fork of this process, so nothing
  is inherited across the spawn. Pass the open file *object* instead — that is
  honoured, and the child's output is written into it.
- **A child's stdin is closed immediately** — it sees EOF rather than your
  terminal. A child that stops to ask a question would otherwise wait for a
  keystroke that can never arrive, so `input=` is the only way to answer it.
- `preexec_fn`, `pass_fds`, `start_new_session`, `user`, `group` and `umask` are
  refused by name; they describe POSIX facilities that have no counterpart here.
  `bufsize`, `close_fds` and the Windows-only options warn on stderr and are
  ignored.

### Two things to know

**Captured output is text.** The syscall carries the child's output back as a
string, so `capture_output=True` without `text=True` gives you bytes that have
been through a decode. Piping real binary out of a child is not byte-exact.

**Held output arrives at the end, and merged output loses its interleaving.**
Anything not going straight to the terminal — captured, or redirected to a file —
is delivered when the child exits, so a file you passed as `stdout=` fills up in
one write rather than as the child produces it. And because the two streams are
captured separately, `stderr=STDOUT` gives you all of stdout followed by all of
stderr, not the order the child actually wrote them in. Every line is there; on
your own machine both streams share one descriptor and the order is whichever
flushed first.

**Ctrl-C does not arrive while a child is running.** Your code is inside a
blocking call for as long as the child lives, so a `KeyboardInterrupt` cannot be
raised in it until the child exits — a `try/except KeyboardInterrupt` around
`subprocess.run` will not fire mid-child. Ctrl-C still reaches the process, and
the kernel terminates it if nothing answers within its grace window. This is the
same as `spawnSync` in Node and is not specific to Python.

**Nesting is bounded.** Each level is another process with its own Python
interpreter behind it, and each parent is blocked until its child exits — so a
script that spawned itself would fill the tab with interpreters that nothing could
interrupt. Three levels deep is allowed; the fourth is refused with that reason.

**On what this widens.** Guest Python can now run the programs in the VM. That is
parity with guest Node, which has had `child_process.spawnSync` all along and goes
through the same syscall — Python was the odd one out, not the newly privileged
one. Nothing here reaches outside the tab: there is no host filesystem and no host
process to reach, and a spawned program is another sandboxed worker under the same
kernel.

## Programs that ask questions

`input()` waits, the way it does anywhere else:

```python
name = input("What is your name? ")
print(f"hello, {name}")
```

This is worth saying plainly because it used to be the one thing here that
could not work. CPython blocks inside `input()`, and stdin arrived as a message
that could only be delivered once the program had gone back to its event loop —
so the keystroke could only turn up after `input()` had already given up. It
raised `EOFError`, and the advice was to use `sys.argv` instead.

Stdin now has a syscall of its own. The process parks in shared memory until the
kernel has a line for it, which is what CPython does with a real terminal, so
nothing is being emulated: `sys.stdin.isatty()` is true, typing ahead works
(three lines pasted at once feed three `input()` calls), and Ctrl-D raises
`EOFError` exactly as a closed stdin does anywhere.

A script run where nobody can type at it — inside `$(…)`, or from another
program — reads end of input immediately rather than hanging, which is what
`python script.py < /dev/null` does.

### `breakpoint()`

The same read is the one pdb's prompt uses, so the debugger is real:

```python
def add(items):
    total = 0
    breakpoint()          # drops you into pdb, in the terminal
    for i in items:
        total += i
    return total
```

`p total`, `n`, `s`, `c`, `l`, `w` — the whole thing, including stepping through
a loop and watching a variable change. `python -m pdb script.py` works too.

This is the one feature here that replaces printing to debug, and it is worth
knowing it exists before you reach for `print()`.

## Checking and formatting your code

`mypy` and `black` are installed, at pinned versions, and both work offline:

```bash
mypy .                  # type-check; exits 1 when it finds something
black .                 # format, with black's defaults
mypy --strict app.py    # every flag is mypy's own
```

Both are the real tools rather than an imitation, so the output is what you get
on your own machine — the same diagnostics, the same `[return-value]` error
codes, the same exit status. `mypy` with no target prints mypy's usage error
rather than quietly checking the current directory, and `black` writes the same
bytes the command line writes, which is also what Format Document in the editor
produces. They are also spelled `python -m mypy` and `python -m black`.

The one difference worth knowing: mypy's output arrives all at once when the run
finishes, rather than streaming. Vivari calls mypy through its own embedding API
because mypy's command line ends by calling `os._exit()`, which under
WebAssembly would take the interpreter down with it and lose the exit code —
`mypy && deploy` would deploy on a failed check. The API is upstream's supported
way in and returns the status honestly instead.

The same checker also runs in the editor and marks what it finds as you go —
see [Type errors, as you edit](#type-errors-as-you-edit).

### ruff, which never starts Python

```bash
ruff check              # lint the project
ruff check --select F   # only the pyflakes rules
ruff format             # format in place
ruff format --check     # or just report, exiting 1 if anything would change
```

ruff is Rust, so it is not a wheel and does not go through the interpreter at
all: it is compiled to WebAssembly and loaded on its own. That is the useful
part rather than a footnote — `ruff check` on a cold project does not pay
Python's start-up, does not load a single package, and answers in the time it
takes to read the files. It catches the class of problem mypy does not bother
with and vice versa: unused imports, unsorted imports, a name you misspelled
(`F821`, before you spend a run finding out).

The findings and the formatting are checked against the real `ruff` at the same
pinned version on every run of the test suite, line, column and byte.

Two differences to know:

- **A `[tool.ruff]` table in `pyproject.toml` is not applied.** Reading TOML
  well enough to be trusted with someone's lint configuration is a bigger thing
  than this is, and misreading it silently is worse than not reading it — so
  when there is config, ruff says on stderr that it is running with defaults.
  `--select`, `--ignore` and `--line-length` on the command line do work, and
  go to ruff as its own settings.
- **`--fix` is refused.** The WebAssembly build reports a fix as a set of edits
  without saying whether it is safe, so applying them would silently be real
  ruff's `--unsafe-fixes` — allowed to change what your code does, under a flag
  you did not type. `ruff check` still tells you what to change, and
  `ruff format` is unaffected, because formatting rewrites a whole file rather
  than patching one.

## Packages

Most of the time `import` is enough on its own: Vivari reads your script and
loads what it recognises before running it. When a name does have to be
resolved, it is tried three ways.

**Vendored, and fully offline.** NumPy, pandas, Matplotlib, SciPy,
scikit-learn, openpyxl, FastAPI, httpx, requests, SQLAlchemy, rich, tzdata and
micropip, plus everything they depend on, ship with Vivari and load from the same
origin. These work with no network at all.

SciPy and scikit-learn are the expensive entries and are here deliberately.
Measured against the pinned Pyodide lock, the two of them plus joblib and
threadpoolctl — the only other packages they drag in — add 17.6 MiB of wheels,
and openpyxl and its one dependency add another 0.26 MiB. What that buys is not a
faster download, it is the removal of a
*network dependency*: anything not vendored is fetched from Pyodide's CDN the
first time it is used, so `from sklearn.linear_model import LinearRegression`
used to be the one line in a data-science notebook that failed on a plane. SciPy
was never really the separate half of that choice — scikit-learn depends on it.

Nothing is paid for until it is used. The whole tree is fetched the first time a
`python` process runs, and each wheel only when something imports it, so a
project that never touches scikit-learn never downloads it.

Two of these are loaded without any `import` statement naming them, which is a
thing worth knowing about because the failure mode is confusing:

- **tzdata** is data rather than code. Nothing imports it — `zoneinfo` is stdlib,
  and it finds the database at call time — so any file mentioning `zoneinfo`
  pulls it in on that basis.
- **openpyxl** is code, but pandas imports it *inside* `read_excel`, not at the
  top of the module. A script that says `import pandas` and reads a spreadsheet
  names openpyxl nowhere, so any file mentioning `read_excel`, `to_excel`,
  `ExcelWriter` or `ExcelFile` pulls it in. Without this, `pd.read_excel` raised
  `ImportError: Missing optional dependency 'openpyxl'` with the wheel sitting
  right there unloaded. Legacy `.xls` needs `xlrd`, which is a different engine
  and is not vendored.

Two more ship for the type checker and are never imported by anything:
`types-requests` and `pandas-stubs`, the stubs for the only two vendored
libraries that carry no type information of their own. See [Type errors, as you
edit](#type-errors-as-you-edit).

Two of those carry wheels their own Pyodide metadata does not mention. `rich`
declares no dependencies at all and imports pygments and markdown-it-py lazily,
so on a stock Pyodide `rich.syntax` and `rich.markdown` raise
`ModuleNotFoundError` at the moment you use them; both are vendored here,
including markdown-it-py, which Pyodide does not distribute at all.

**Pyodide's own distribution.** Anything else Pyodide has built a WASM wheel for
— Pillow, SymPy, statsmodels — is fetched from its CDN the first time it is
used, which is the one step in this list that needs the network.

**PyPI, through micropip**, for everything that remains, provided it is pure
Python. This is how Flask and Django arrive.

## `pip install`, and the `.venv` it writes to

`pip install` persists. What you install stays installed, for this project, and
every later `python` command in it sees the package:

```bash
pip install tabulate
python -c "from tabulate import tabulate; print(tabulate([[1, 2]]))"
```

The packages live in `.venv/lib/python3.14/site-packages`, which `pip install`
creates on first use. `python -m venv .venv` makes it up front if you would
rather, and the usual read-only verbs work off it:

```bash
python -m venv .venv
pip list              # Package  Version, as pip prints it
pip freeze            # name==version, safe to redirect into a file
pip show tabulate
pip check
pip uninstall -y tabulate
```

**`.venv` here is a package store, not a second interpreter.** This is the one
place where the familiar name does not carry all of its usual meaning, so it is
worth being precise. There is no `bin/activate`, nothing to deactivate, and no
isolation: every `python` command boots one CPython/WASM interpreter and copies
this directory into it, so a package in the store is a package that interpreter
has. Two projects get two stores, which is the part of a virtualenv people
actually want, but there is no second Python to switch between.

Deleting the directory resets it, and so does `python -m venv --clear .venv`.

**Commands that come with a package work.** A wheel that declares a console
script gets one, in `.venv/bin`, on `PATH` for that project — the same place and
the same name a real venv would use:

```bash
pip install httpie
http --version          # the command the package's README tells you to run
pip uninstall -y httpie
http                    # gone again
```

The commands Vivari provides itself — `pip`, `pytest`, `uvicorn`, `flask`,
`gunicorn`, `black`, `mypy` — are **not** replaced by an installed package's
version of the same name. They are not merely another way to reach the module:
`pytest` turns pytest's exit code into the process's, `uvicorn` and `gunicorn`
are the bridge that runs a server without sockets. A shim that bypassed those
would quietly undo them.

**`pip install -e .` works, for a project that says what it is.** An editable
install here is what it is anywhere: your source directory on the import path,
so an edit takes effect without reinstalling, plus metadata so `pip list` admits
it exists. Any `[project.scripts]` you declare become commands, as above.

What it will not do is guess. There is no build backend here to run, and pip's
build isolation would fetch one from the network and execute it before your
install could finish — so the metadata has to be readable rather than computed. A `pyproject.toml` with a static `[project]`
`name` and `version` is enough. A dynamic version, a `setup.py` that computes its
own name, or a Poetry project with only a `[tool.poetry]` table is refused with
the reason and the fix, instead of being installed under a name nothing else
agrees with. Dependencies are not installed either, and it says so and lists
them rather than leaving an `ImportError` for later.

A few consequences of the way this works:

- **You often do not need it.** Vivari reads your script and loads the packages
  it recognises before running, so `import numpy` works without installing
  anything, and a served app reads its `requirements.txt`.
- **The store is capped at 64 MB**, which is generous for pure-Python packages
  but not unbounded. It is mostly beside the point for the heavy scientific
  wheels, which are vendored rather than installed and so never enter the store
  at all — SciPy alone is 13.2 MiB of wheel. An install that would go over is
  refused outright and the store is left exactly as it was, rather than being
  grown half way to a package it cannot finish. `pip uninstall` makes room.
- **It is stamped with the interpreter that built it.** If Vivari updates to a
  newer Python or Pyodide, a store built by the old one is ignored rather than
  half-loaded, with a message saying so; `python -m venv --clear .venv` rebuilds
  it.

## Talking to the network

Python reaches the network the way the page does — through the browser's `fetch`
and `XMLHttpRequest` — rather than through a TCP stack of its own. `requests`
works, because Pyodide's `urllib3` ships a transport built on exactly those:

```python
import requests

r = requests.get("https://api.example.com/items")
print(r.status_code, r.json())
```

If you would rather be asynchronous, the JavaScript side is right there, and
Vivari runs your script where module-level `await` is valid — so there is no
wrapper to write:

```python
from pyodide.http import pyfetch

resp = await pyfetch("https://api.example.com/items")
data = await resp.json()
```

`httpx` works too, and needs nothing special. Pyodide's build of it defaults to
a transport built on `fetch`, so both styles are fine:

```python
import httpx

r = httpx.get("https://api.example.com/items")      # sync

async with httpx.AsyncClient() as client:            # async
    r = await client.get("https://api.example.com/items")
```

**`aiohttp` cannot work here.** It is in the package index, which is not the same
thing: it opens real connections and fails with `ClientConnectorDNSError` on the
first request, because there is no DNS and no socket underneath it. There is no
flag that changes this. Use `httpx` — its async API is close enough that the
change is usually the import and the client class.

**What you do not get is a socket.** `socket`, `urllib.request`, `http.client`,
`smtplib` and `ftplib` all reach below the level a browser exposes, and this
build's `ssl` is a stub — anything that negotiates TLS itself stops at
`RuntimeError: TLS not supported in this environment`. Use `requests` or `httpx`.

**And the browser's rules apply, because the browser is what makes the request.**
The server has to allow this origin (`Access-Control-Allow-Origin`) and satisfy
the studio's cross-origin isolation (a `Cross-Origin-Resource-Policy`, or CORS).
An API that sends no CORS headers cannot be read from Python here — and moving
the call to JavaScript does not help, because it is the same restriction. This
one is not something Vivari can lift.

## In the editor

Python files get completion, hover, signature help, go-to-definition and
formatting. These come from [jedi](https://jedi.readthedocs.io/) and
[black](https://black.readthedocs.io/) — the same libraries you would run
locally, at the same versions, shipped with the app rather than fetched.

Type errors are marked as you edit, by mypy — see below.

### What completion can see

- **The buffer you are typing in**, unsaved. A class you defined thirty seconds
  ago and have not saved is completed.
- **The rest of the project** — your own modules, including from a file in a
  subdirectory importing something at the top level.
- **Packages you installed.** `pip install tabulate` and then `tabulate.` offers
  its members, because the language service reads the same per-project `.venv`
  store that `pip` writes to.
- **The standard library**, at the interpreter's own version.

What it cannot see is anything outside the project directory, and go-to-definition
says so rather than doing nothing: a definition inside the standard library or a
package reports where it lives instead of opening a file the editor has no copy
of.

### Lint findings, while you type

ruff's findings appear as warnings as you type — an unused import, a misspelled
name, a shadowed builtin — from the same ruff `ruff check` runs at a terminal.
Hovering one shows its rule id, which is what a `# noqa: F401` would name.

These arrive about a **sixth of a second** after you stop typing, and they arrive
even on the first Python file you open, while the interpreter behind everything
else on this page is still starting. That is because ruff is not a Python
package: it is WebAssembly of its own that needs no interpreter, so a lint costs
a couple of milliseconds and competes with nothing.

A file ruff cannot parse is **not** marked up. Half of an expression is the normal
state of a line you are in the middle of writing, and a red squiggle appearing
under the cursor during a pause for thought is the reason people turn linters
off. A file that will not parse is still reported — by the type checker below,
on its longer pause.

As at the terminal, `[tool.ruff]` in your `pyproject.toml` is not applied; see
[ruff, which never starts Python](#ruff-which-never-starts-python).

### Type errors, as you edit

Type errors appear as squiggles, from [mypy](https://mypy.readthedocs.io/) — the
same checker `mypy` runs at the terminal, at the same version, so a marker in the
editor and a line of terminal output are the same finding. Hovering one shows
mypy's wording and its error code, which is what you would write in a
`# type: ignore[...]`.

Checking happens when you **pause**, not on every keystroke, and that is a
deliberate limit rather than a rough edge. The language service is one
single-threaded interpreter shared with completion, so a check that is running is
a completion that is waiting. A check costs about 2 seconds the first time it
sees a project and about a third of a second per edit after that, which is
affordable in a gap and not between two characters.

A few consequences worth knowing:

- **mypy arrives when you first save something worth checking**, not at boot. It
  is the largest wheel the studio ships, and nobody editing a `.ts` file should
  pay for it.
- **Only the file you are looking at gets markers.** Imports are followed for
  their types, so a wrong argument to your own helper in another module is
  caught, but errors *inside* that other module are not drawn — there is nowhere
  to draw them.
- **Stubs for the untyped libraries ship with it.** Without them, the first
  thing mypy says about a file that imports `requests` is `Library stubs not
  installed for "requests"` on line 1 — a complaint about packaging, pointing at
  a `pip install` that needs a network, on a line you did not write. Worse, the
  untyped import makes the module `Any`, so the mistake two lines down that you
  wanted mypy for goes unreported. `types-requests` and `pandas-stubs` are
  vendored (the only two of the bundled libraries that carry no types of their
  own), so `r.jsonn()` gets you `"Response" has no attribute "jsonn"; maybe
  "json"?` instead.
- **Your `mypy.ini` / `[tool.mypy]` is read**, because this is mypy. If that
  configuration is broken, you get one message saying so instead of squiggles
  that are not about your code.
- **If the language service dies, the markers stay put.** They describe the last
  state anything actually checked. Clearing them would be a claim that the file
  became clean.

### Formatting

`black`, with its defaults, so the result is byte-for-byte what running
`black yourfile.py` at a terminal produces. If black cannot parse the file, the
buffer is **left exactly as it was** and the error says where — a file with a
syntax error is not silently reported as already formatted, and never gets
partially rewritten.

### The first request is slow, and says so

The language service runs on its own Python interpreter, separate from anything
you run. It does not exist until you open a Python file, because someone editing
TypeScript should not download an interpreter. The first completion in a session
therefore waits for it to start, and the editor's status bar says `Python:
starting…` while that happens. It is a few seconds, once. After that the
interpreter stays up: it is not tied to any process you run, so quitting the
REPL or a crashing script leaves completion working.

If it cannot start — or if jedi fails on some particular file — the status bar
says so with the reason. An empty completion popup here always means jedi had
nothing to suggest, never that something broke quietly.

Requests are answered one at a time, because the interpreter is single-threaded.
Typing faster than it can answer is fine: superseded requests are dropped rather
than queued, so what you get is an answer for where the cursor is now, not a
backlog of answers for where it used to be.

## Ctrl-C

Ctrl-C interrupts running Python code the way it does anywhere else: the current
operation raises `KeyboardInterrupt`, your `try`/`except KeyboardInterrupt` and
`finally` blocks run, and a script that does not catch it prints its traceback
and exits **130**. At the REPL, an accidental infinite loop takes a Ctrl-C and
gives you a fresh `>>>` prompt with the session intact.

This needs a mechanism, rather than being free, because while CPython is running
the worker thread is inside the interpreter and no JavaScript on it can run —
including a signal handler. CPython's WebAssembly build polls a byte of shared
memory for exactly this situation, so Ctrl-C sets that byte and the interpreter
raises at its next bytecode boundary. In practice the interrupt lands about 5ms
after the keystroke.

Two things it will not do:

- **Interrupt code that is not Python.** A long call inside a C extension —
  a big NumPy operation, a regex on a huge string — is not checking the byte,
  so the interrupt arrives when that call returns. Same as CPython everywhere.
- **Do anything at an idle prompt.** Ctrl-C while the REPL is waiting for you to
  type, or while `pip` is downloading, still terminates the process as it always
  has. Interrupting a read that has not returned needs the read itself to be
  interruptible, which it is not yet.

A program that catches `KeyboardInterrupt` and keeps going keeps going — it is
not force-killed a few seconds later for having survived. Pressing Ctrl-C again
at a prompt that is answering is simply a second interrupt.

## Stopping on a line

Click the gutter next to a line in a `.py` file to set a breakpoint, run the
file under the debugger, and the program stops there — same panel, same
buttons, same call-stack and variables views the JavaScript debugger uses.

To try it: open **Run and Debug** in the activity bar, turn **Debug mode** on,
click the gutter beside a line that actually runs, then run the file from a
terminal (`python main.py`). The panel lists the process as a target while it is
alive, and switches to the paused view when the breakpoint is hit. The
breakpoints you want should be set **before** you run: a breakpoint added while
a script is already running only takes effect once the interpreter next hands
control back to the browser, because a thread inside CPython is not reading its
message queue.

What you get at a stop:

- **The call stack**, in Python's terms. A module's frame is `<module>` in
  CPython; it is shown as `(module)`. Library frames are left out, so a stop
  inside your code reads as your code rather than forty frames of interpreter
  and package internals.
- **Local and global variables**, described the way Python describes them —
  `{'n': 1}` is a dict, not `Object`. Expand a value to see inside it: dicts by
  key, lists and tuples by index, anything else by attribute. `__builtins__` and
  friends are hidden, because a module frame otherwise opens with three
  kilobytes of the builtins dict.
- **An expression box** that evaluates in the stopped frame's own scope, so
  `acc + rows[2]['n']` means what it means on that line.
- **Step over, step into, step out, continue**, which follow calls between your
  own files but do not descend into the standard library or an installed
  package.

A breakpoint on a blank line or a comment binds to the next line the interpreter
can actually stop on, rather than sitting there never firing.

### It does not slow your program down

Python's older tracing hook (`sys.settrace`, which is what `pdb` uses) is called
for every line of every function, and costs about 10x on a tight loop —
measured here, a 300k-iteration loop goes from 22ms to 217ms. A debugger that
changes the program's speed that much changes the program you are debugging.

This uses [PEP 669](https://peps.python.org/pep-0669/) monitoring instead
(Python 3.12+; the interpreter here is 3.14). A line that is not a breakpoint
answers "never ask about me again" the first time it runs and costs nothing
after that: the same loop is 23ms against a 22ms baseline. Setting a breakpoint
on the hot line itself costs 83ms, and that is a line you are about to stop on.
Importing a package while a breakpoint is set is not affected at all, because
code outside your project is dropped the first time it is seen.

### `pdb` still works

Nothing above replaces `breakpoint()` and `pdb`, which work at the terminal and
are the right tool when you want a REPL at the stop rather than a panel. The two
are independent.

## Limits

Vivari is a pure client-side environment, and that has real consequences. None
of the following is a bug we intend to fix — they follow from running inside a
browser tab.

**No OS threads, no processes.** `threading.Thread().start()` and
`ThreadPoolExecutor` raise `RuntimeError: can't start new thread`. This catches
libraries that animate themselves: `rich`'s `Progress` and `Live` refresh from a
background thread by default and need `auto_refresh=False` plus a `refresh()`
call of your own, and `console.status()` cannot work at all, because the spinner
*is* the thread. `multiprocessing` cannot even import, and `os.fork()` gives
`OSError: [Errno 52] Function not implemented`. This rules out Celery,
`pytest-xdist` and gunicorn's real worker model. `threading.Lock` and the other
synchronisation primitives do exist, since nothing ever contends for them.

**No threads is not the same as no processes**, and this page used to run the two
together. There are processes here — they are just not made by forking this
interpreter, which is the only thing CPython's `OSError: [Errno 138] emscripten
does not support processes.` was ever about. `subprocess.run()` works: see
[Running another program](#running-another-program). What remains true is that
nothing here spawns a *thread*, so anything needing one concurrently with your own
code — `Popen`'s streaming, a worker pool — is still out.

It does **not** rule out `--reload`, which this page used to say it did. A
reloader on your own machine needs a watcher thread and a subprocess because it
is watching a real filesystem and restarting a real process; here the filesystem
tells the runtime when a file changed, and the app is imported into the server's
own process rather than launched beside it. Neither half needs the thing that is
missing. See [Restarting on save](#restarting-on-save).

You do not have to discover the rest from the flags' silence: `gunicorn -w 4`
says on stderr that the flag is being ignored and why, a flag that would change
what gets served — `--worker-class gevent`, `--factory` — stops rather than
serving you something else, and a flag that names two things when only one of
them can happen says which one it did.

**No sockets, and no way around CORS.** Outbound HTTP does work — see [Talking to
the network](#talking-to-the-network) — but it is the browser that makes the
request. So `socket`, `urllib.request` and `http.client` have no TCP stack under
them and `ssl` is a stub, and a server that sends no CORS headers is unreachable
from the tab at all, in any language.

**`asyncio.run()` depends on a browser feature that is not yet everywhere.** It
has to block until the coroutine finishes, and blocking inside WebAssembly needs
JavaScript Promise Integration — stack switching — which Chrome ships from 137
and Firefox from 139. Where the browser has it, `asyncio.run()` simply works.
Where it does not, you get a `RuntimeError` that says so and tells you what to
write instead of CPython's own message about a WebAssembly proposal, which names
nothing you can act on. What to write is module-level `await`:

```python
async def main():
    ...

await main()          # instead of asyncio.run(main())
```

That needs no stack switching and works in every browser, because Vivari runs
your file in a context where top-level `await` is valid. `create_task`,
`gather`, `sleep` and the rest of asyncio are unaffected either way.

**Buffered request/response only.** No streaming responses, no Server-Sent
Events, no WebSocket from Python. Each request is converted, run, and returned
whole.

**No DOM, so no windows** — but `plt.show()` still shows you something. There is
no window to open, so it saves the figure into your project as `plot.png`
(`plot-2.png` for the next one) and prints where it went; the file appears in the
tree and opens in the editor. Charts are named per figure rather than per call,
so a script that draws two of them keeps both instead of overwriting the first.
`matplotlib.use("Agg")` in code that already says it still wins, and `savefig()`
is unchanged. `tkinter`, `turtle` and `pygame` are not in the build at all.

**Timezones work, which they did not used to.** The WASM build ships no system
timezone database, so `zoneinfo` used to raise `ZoneInfoNotFoundError` on every
key including UTC. `tzdata` is now vendored and loaded automatically for any
file that mentions `zoneinfo` — nothing imports it by name, so nothing else
could have known to. Django, which needs it the moment it renders a datetime,
gets it too.

**Packages need a wheel**, either one Pyodide has built or a pure-Python one.
Anything carrying an unbuilt C extension stops at install time — `psycopg2`
gives `ValueError: Can't find a pure Python 3 wheel for 'psycopg2'.`

That is the wall the most-reached-for tools hit, so it is worth knowing in
advance which ones will not start:

- **Streamlit** stops at install time on `watchdog`, which carries a C extension
  with no WASM wheel. Note what that is and is not: `watchdog` is a *file
  watcher*, and watching files is something this environment does do — the VFS
  pushes changes and `--reload` is built on them. What stops Streamlit is the
  unbuilt extension, and then its own server, which wants a socket and a
  WebSocket.
- **Jupyter** stops on `tornado`, which it needs for a real server.
- **Gradio** does install, then fails on `import gradio` with a missing
  dependency of its own — and could not have served anyway, since it wants a
  socket and a WebSocket.

None of these three is a near miss: each wants to listen on a socket, and that
is the thing a tab does not get. Read that as a statement about these packages
rather than about their whole category. A notebook *interface* driven straight
from Pyodide needs no server, is not covered by any of this, and Vivari now has
one — see [Notebooks](./notebooks.md). What is ruled out is the Jupyter server,
not the idea.

**Files move in both directions, and `--reload` is how the inbound half
happens.** Files written by your code — by `python script.py`, and by a running
Flask, FastAPI or Django app — are mirrored back into the editor. A served app's
writes land at the end of each request, so an upload or a SQLite commit is on
disk and visible while the server is still running, and survives closing the tab
rather than needing a clean shutdown.

The other direction used to be a gap: the project is copied in when the server
starts, so an edit afterwards was invisible until you restarted. `--reload` now
does that for you — see [Restarting on save](#restarting-on-save). Without the
flag the old behaviour stands, which is what a server started without it should
do.