// A stand-in for urllib3's Emscripten transport, and the list of fragments it
// copies out of the real one.
//
// WHY A STAND-IN EXISTS AT ALL. `urllib3.contrib.emscripten.fetch` is the module
// that decides how Python reaches the network, and it only exists inside
// Pyodide — there is no host-installable copy. Our fix for it
// (URLLIB3_REALM_PATCH) is ordinary Python, though, so the host interpreter can
// run it, and spike-python-offline.mjs does exactly that against the model
// below. That puts the hook's LOGIC in the tier CI enforces per-PR instead of
// leaving it to the network tier, which gates nothing.
//
// WHAT MAKES THE MODEL WORTH ANYTHING. On its own, nothing: a test against a
// fixture we wrote is a test of our own opinion, which is the failure this
// repo's spikes are written to avoid. So MODELLED_FRAGMENTS names every piece
// of real urllib3 the stand-in reproduces, and the two tiers check it from
// opposite ends:
//
//   spike-python-offline.mjs — every fragment appears in STANDIN
//                              (the model has not drifted from the list)
//   spike-python-bridge.mjs  — every fragment appears in the REAL module,
//                              read out of a live Pyodide's site-packages
//                              (the list has not drifted from urllib3)
//
// Fail either and the pair stops meaning anything, so both are assertions.
// Captured from urllib3 2.6.3, as shipped in Pyodide 314.0.3.

// Whitespace-insensitive containment: indentation and blank lines are not what
// is being asserted, the expressions are.
export const normalize = (s) => String(s).replace(/\s+/g, " ").trim();

// Verbatim from urllib3/contrib/emscripten/fetch.py. `is_in_node` is the one
// this whole change is about — it reads js.process.release.name, which our
// runtime sets to "node" for real tools' benefit (builtins/process.js).
export const MODELLED_FRAGMENTS = [
  { label: "is_in_browser_main_thread()", source: `def is_in_browser_main_thread() -> bool:
    return hasattr(js, "window") and hasattr(js, "self") and js.self == js.window` },

  { label: "is_cross_origin_isolated()", source: `def is_cross_origin_isolated() -> bool:
    return hasattr(js, "crossOriginIsolated") and js.crossOriginIsolated` },

  { label: "is_in_node() — the read of process.release.name this change is about", source: `def is_in_node() -> bool:
    return (
        hasattr(js, "process")
        and hasattr(js.process, "release")
        and hasattr(js.process.release, "name")
        and js.process.release.name == "node"
    )` },

  { label: "is_worker_available()", source: `def is_worker_available() -> bool:
    return hasattr(js, "Worker") and hasattr(js, "Blob")` },

  // The import-time decision the old is_in_node() also poisoned, which is why
  // fixing the predicate alone would have left streaming off.
  { label: "the module-level _fetcher gate", source: `if is_worker_available() and (
    (is_cross_origin_isolated() and not is_in_browser_main_thread())
    and (not is_in_node())
):
    _fetcher = _StreamingFetcher()
else:
    _fetcher = None` },
];

// The stand-in. Everything above appears here verbatim; `_StreamingFetcher` is
// reduced to a constructible object on purpose, because its real body is
// Blob/Worker/objectURL plumbing that only a browser has — "does the gate get
// re-evaluated" is the question this model answers, and the real class
// constructing is a browser-tier question no host can settle.
export const STANDIN = `
import js

EXEC_COUNT = 0
EXEC_COUNT += 1


def is_in_browser_main_thread() -> bool:
    return hasattr(js, "window") and hasattr(js, "self") and js.self == js.window


def is_cross_origin_isolated() -> bool:
    return hasattr(js, "crossOriginIsolated") and js.crossOriginIsolated


def is_in_node() -> bool:
    return (
        hasattr(js, "process")
        and hasattr(js.process, "release")
        and hasattr(js.process.release, "name")
        and js.process.release.name == "node"
    )


def is_worker_available() -> bool:
    return hasattr(js, "Worker") and hasattr(js, "Blob")


class _StreamingFetcher:
    def __init__(self):
        self.streaming_ready = False


_fetcher = None

if is_worker_available() and (
    (is_cross_origin_isolated() and not is_in_browser_main_thread())
    and (not is_in_node())
):
    _fetcher = _StreamingFetcher()
else:
    _fetcher = None
`;