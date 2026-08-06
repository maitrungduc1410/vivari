// What CPython does when SystemExit reaches the top level — the outside value
// the Python shim's termination handling is measured against.
//
// The shim claims "CPython-faithful", so the expected column is not ours to
// choose. Every row here was captured by running the expression under a real
// interpreter and recording the two observable outputs:
//
//   $ python3 -c "import sys; sys.exit(False)"; echo "rc=$?"
//   rc=0
//
// against CPython 3.11.2 (main, Apr 28 2025) [GCC 12.2.0]. `traceback` is the
// last line of the error real Pyodide 314.0.3 raises for that same expression,
// captured the same way — it is the actual input the shim parses, not a guess
// at one.
//
// Guessing these is exactly the trap: the first version of this table was
// written from what we assumed CPython did, and two rows were wrong.
// `sys.exit(None)` does not produce "SystemExit: None" (it produces a bare
// "SystemExit"), and `sys.exit(False)` exits 0 printing nothing rather than
// exiting 1 printing "False" — so `sys.exit(not ok)`, a common idiom, reported
// failure on a successful run. A self-consistent table agreed with the shim on
// both. Re-derive with realCPythonExit() rather than editing by hand.

export const CPYTHON_EXITS = [
  // expression         last traceback line   exit code   stderr
  { expr: "sys.exit()", traceback: "SystemExit", code: 0, report: "" },
  { expr: "sys.exit(0)", traceback: "SystemExit: 0", code: 0, report: "" },
  { expr: "sys.exit(3)", traceback: "SystemExit: 3", code: 3, report: "" },
  { expr: "sys.exit(None)", traceback: "SystemExit", code: 0, report: "" },
  { expr: "sys.exit('boom')", traceback: "SystemExit: boom", code: 1, report: "boom" },
  // Bools are ints in Python, so these carry an exit code and print nothing.
  { expr: "sys.exit(True)", traceback: "SystemExit: True", code: 1, report: "" },
  { expr: "sys.exit(False)", traceback: "SystemExit: False", code: 0, report: "" },
];

// Deliberate difference, recorded so nobody "fixes" it in isolation: real
// CPython reports sys.exit(-1) as 255 and sys.exit(256) as 0, because a POSIX
// exit status is 8 bits — that truncation is the OS's, not CPython's. Vivari's
// kernel carries exit codes as plain integers (`m.code | 0`) for every program,
// Node and Bun alike, so the Python shim passes the value through; truncating
// here and nowhere else in the VM would be the real inconsistency.
export const UNTRUNCATED = [
  { expr: "sys.exit(-1)", traceback: "SystemExit: -1", code: -1, report: "", cpython: 255 },
];

// Run the expression under whatever CPython is on PATH. Returns null when
// there is none, so callers can say so out loud instead of skipping quietly.
export function realCPythonExit(expr, spawnSync) {
  const r = spawnSync("python3", ["-c", "import sys; " + expr], { encoding: "utf8" });
  if (r.error) return null;
  return { code: r.status, report: (r.stderr || "").trimEnd() };
}