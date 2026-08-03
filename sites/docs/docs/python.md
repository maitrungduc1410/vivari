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

[Pyodide]: https://pyodide.org

## What works

| | |
| --- | --- |
| **Scripts, the REPL, `-c`** | with the project directory mirrored in, so file I/O and sibling imports work |
| **The scientific stack** | NumPy, pandas, Matplotlib, SciPy, scikit-learn, SymPy, Pillow — as prebuilt WASM wheels |
| **`sqlite3`** | compiled into the interpreter; databases are real files |
| **Web frameworks** | Flask, FastAPI and Django, with a live preview |
| **pytest** | including real exit codes, so `pytest && …` behaves |
| **`python -m <module>`** | any importable module, through CPython's own `runpy` — `unittest`, `http.server`, `json.tool` |
| **Pure-Python packages from PyPI** | installed at runtime through `micropip` |
| **`pip install` that persists** | into a per-project `.venv`, with `list`/`freeze`/`show`/`uninstall`/`check` |
| **Outbound HTTP** | `requests`, or `pyfetch` if you want it async — subject to the target's CORS headers |

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

Because the preview is served under `/preview/<port>/`, **generate URLs rather
than hardcoding them** — `url_for()`, `reverse()`, `{% url %}`,
`request.url_for()`. The bridge tells your framework which prefix it is mounted
under, so generated URLs stay inside the preview. A hardcoded `/about` will
escape it.

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
does not, because it needs a subprocess.

A handful of modules are refused up front, with the reason: `smtplib`, `ftplib`,
`poplib`, `imaplib`, `socketserver`, `wsgiref.simple_server` and
`xmlrpc.server`. Each of them is a socket and nothing else. This is a refusal
rather than a failure because of a trap — Pyodide *has* a `socket` module, and
`connect()` and `bind()` on it succeed, so these would print their banner, look
like they had started, and then wait forever for bytes that never move.

Anything else that is missing gets CPython's error, not ours:
`python: No module named nosuchthing`, exit 1.

## Packages

Most of the time `import` is enough on its own: Vivari reads your script and
loads what it recognises before running it. When a name does have to be
resolved, it is tried three ways.

**Vendored, and fully offline.** NumPy, pandas, Matplotlib, FastAPI and micropip,
plus everything they depend on, ship with Vivari and load from the same origin.
These work with no network at all.

**Pyodide's own distribution.** Anything else Pyodide has built a WASM wheel for
— SciPy, scikit-learn, Pillow, SymPy — is fetched from its CDN the first time it
is used.

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

A few consequences of the way this works:

- **You often do not need it.** Vivari reads your script and loads the packages
  it recognises before running, so `import numpy` works without installing
  anything, and a served app reads its `requirements.txt`.
- **The store is capped at 64 MB**, which fits a scientific stack — SciPy is
  around 13 MB — but not an unbounded one. An install that would go over is
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

**What you do not get is a socket.** `socket`, `urllib.request`, `http.client`,
`smtplib` and `ftplib` all reach below the level a browser exposes, and this
build's `ssl` is a stub — anything that negotiates TLS itself stops at
`RuntimeError: TLS not supported in this environment`. Use `requests`.

**And the browser's rules apply, because the browser is what makes the request.**
The server has to allow this origin (`Access-Control-Allow-Origin`) and satisfy
the studio's cross-origin isolation (a `Cross-Origin-Resource-Policy`, or CORS).
An API that sends no CORS headers cannot be read from Python here — and moving
the call to JavaScript does not help, because it is the same restriction. This
one is not something Vivari can lift.

## Limits

Vivari is a pure client-side environment, and that has real consequences. None
of the following is a bug we intend to fix — they follow from running inside a
browser tab.

**No OS threads, no processes.** `threading.Thread().start()` and
`ThreadPoolExecutor` raise `RuntimeError: can't start new thread`. `subprocess`
raises `OSError: [Errno 138] emscripten does not support processes.`,
`multiprocessing` cannot even import, and `os.fork()` gives `OSError: [Errno 52]
Function not implemented`. This rules out Celery, `pytest-xdist`, gunicorn's real
worker model, and any `--reload` file watcher. `threading.Lock` and the other
synchronisation primitives do exist, since nothing ever contends for them.

You do not have to discover this from the flags' silence: `gunicorn -w 4` and
`uvicorn --reload` say on stderr that the flag is being ignored and why, and a
flag that would change what gets served — `--worker-class gevent`, `--factory` —
stops rather than serving you something else.

**No sockets, and no way around CORS.** Outbound HTTP does work — see [Talking to
the network](#talking-to-the-network) — but it is the browser that makes the
request. So `socket`, `urllib.request` and `http.client` have no TCP stack under
them and `ssl` is a stub, and a server that sends no CORS headers is unreachable
from the tab at all, in any language.

**`asyncio.run()` depends on a browser feature that is not yet everywhere.** It
needs WebAssembly JavaScript Promise Integration — stack switching — which Chrome
ships from 137 and Firefox from 139. Where it is missing you get `RuntimeError:
WebAssembly stack switching not supported in this JavaScript runtime`.
Module-level `await` needs none of it and works regardless, so prefer it: Vivari
runs your script in a context where that is valid.

**Buffered request/response only.** No streaming responses, no Server-Sent
Events, no WebSocket from Python. Each request is converted, run, and returned
whole.

**No DOM, so no windows.** The interpreter runs in a Web Worker. Matplotlib needs
its headless `Agg` backend and writes an image file, which is how the
`fastapi-dashboard` template gets a chart onto the page. `tkinter`, `turtle` and
`pygame` are not in the build at all.

**No timezone database.** The WASM build ships none, not even UTC, so `zoneinfo`
raises `ZoneInfoNotFoundError` on any key until you add `tzdata` to your
requirements. Django needs it as soon as it renders a datetime.

**Packages need a wheel**, either one Pyodide has built or a pure-Python one.
Anything carrying an unbuilt C extension stops at install time — `psycopg2`
gives `ValueError: Can't find a pure Python 3 wheel for 'psycopg2'.`

That is the wall the most-reached-for tools hit, so it is worth knowing in
advance which ones will not start:

- **Streamlit** stops on `watchdog`, its file-watching dependency.
- **Jupyter** stops on `tornado`, which it needs for a real server.
- **Gradio** does install, then fails on `import gradio` with a missing
  dependency of its own — and could not have served anyway, since it wants a
  socket and a WebSocket.

None of these are near misses. Each needs something the browser does not hand
out, so there is no version of Vivari that runs them.

**Editor edits do not reach a running server.** Files written by your code —
by `python script.py`, and by a running Flask, FastAPI or Django app — are
mirrored back into the editor. A served app's writes land at the end of each
request, so an upload or a SQLite commit is on disk and visible while the server
is still running, and survives closing the tab rather than needing a clean
shutdown. The reverse direction is the gap: the project is copied in when the
server starts, so editing a file afterwards will not be seen until you restart
it. There is no `--reload` to do that for you, since it would need a file
watcher and a subprocess.