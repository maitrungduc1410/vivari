// The outside oracle for the Python language service: the SHIPPED driver, run
// under the real CPython on this machine.
//
// The point is that nothing here is a hand-written expectation. The same
// LSP_DRIVER_SOURCE that the browser executes is handed to the host's own
// interpreter, with jedi and black pinned to the versions the browser gets — so
// a comparison is two interpreters running one program, and any disagreement is
// either a stdlib difference (which the caller has to scope around deliberately)
// or a bug. An expectation table written by the person writing the feature would
// have agreed with the feature by construction.
//
// The versions are READ from the shipping configuration rather than restated:
// jedi's from the Pyodide lock, black's closure from vendor-pyodide.mjs. Pinning
// them twice would let the oracle drift into agreeing with an older build.

import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

/** jedi's version, from whichever Pyodide lock this checkout is using. */
export function lockVersion(lockPath, name) {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    const key = Object.keys(lock.packages).find(
      (k) => k.toLowerCase().replace(/[-_.]+/g, "-") === name.toLowerCase(),
    );
    return key ? lock.packages[key].version : null;
  } catch {
    return null;
  }
}

/** black and its PyPI-only closure, from the pins the vendor script ships. */
export function vendoredPyPIPins(vendorScriptPath) {
  const src = fs.readFileSync(vendorScriptPath, "utf8");
  const block = /const PYPI_PACKAGES = \[([\s\S]*?)\n\];/.exec(src);
  if (!block) return [];
  return [...block[1].matchAll(/name: "([^"]+)", version: "([^"]+)"/g)].map((m) => ({
    name: m[1],
    version: m[2],
  }));
}

/**
 * Install the oracle's libraries into a scratch directory, pinned. Returns the
 * directory to put on PYTHONPATH, or null with a reason if it cannot be built —
 * the caller reports that as a skipped oracle rather than a passing test, since
 * "the comparison did not run" and "the comparison agreed" must not look alike.
 */
export function ensureOracle(dir, pins) {
  const marker = path.join(dir, ".pins.json");
  const want = JSON.stringify(pins);
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === want) return { dir };
  fs.mkdirSync(dir, { recursive: true });
  const specs = pins.map((p) => `${p.name}==${p.version}`);
  const r = spawnSync(
    "python3",
    ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--target", dir, ...specs],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    return { error: `pip install ${specs.join(" ")} failed: ${(r.stderr || "").trim().split("\n").pop()}` };
  }
  fs.writeFileSync(marker, want);
  return { dir };
}

/**
 * Run the shipped driver under host CPython and answer one request, exactly as
 * the worker does in the browser: source in, JSON string in, JSON string out.
 */
export function askHost(oracleDir, driverSource, req, cwd) {
  const runner = [
    "import json, sys",
    `sys.path.insert(0, ${JSON.stringify(oracleDir)})`,
    // Reproduce the condition that makes InterpreterEnvironment necessary in the
    // browser: our runtime sets sys.executable, and jedi's default environment
    // discovery would try to run it. Setting it here too keeps the oracle honest
    // about WHY the driver is written the way it is.
    'sys.executable = "python"',
    driverSource,
    `print(_vv_lsp(${JSON.stringify(JSON.stringify(req))}))`,
  ].join("\n");
  try {
    const out = execFileSync("python3", ["-c", runner], {
      encoding: "utf8",
      cwd: cwd || process.cwd(),
      maxBuffer: 32 * 1024 * 1024,
    });
    return JSON.parse(out.trim().split("\n").pop());
  } catch (e) {
    return { error: "host", message: ((e && e.stderr) || (e && e.message) || String(e)).slice(-400) };
  }
}

/** The versions the oracle actually imported, for the report. */
export function oracleVersions(oracleDir) {
  try {
    const out = execFileSync(
      "python3",
      [
        "-c",
        `import sys; sys.path.insert(0, ${JSON.stringify(oracleDir)});
import jedi, black, json
print(json.dumps({"jedi": jedi.__version__, "black": black.__version__, "python": sys.version.split()[0]}))`,
      ],
      { encoding: "utf8" },
    );
    return JSON.parse(out.trim());
  } catch {
    return null;
  }
}

/**
 * black's own CLI, over stdin, with NO driver in the way.
 *
 * The comparisons that run the shipped driver on both sides share a blind spot:
 * a change to the driver itself — a different Mode, a line length nobody asked
 * for — moves both answers together and the two still agree. This does not go
 * through the driver at all, so it is the check that notices the editor
 * formatting differently from `black yourfile.py` on the command line, which is
 * the promise the feature is actually making.
 */
/**
 * mypy's own CLI, on real files, under host CPython.
 *
 * The seam in the launcher does not run mypy's command line — it calls
 * mypy.api.run(), because the command line ends in os._exit() and that takes
 * Emscripten down with it. So the thing worth checking is that going in through
 * the API still produces what the command line would: same diagnostics, same
 * error codes, same exit status. Only the host can say what that is.
 */
export function mypyCli(oracleDir, files, cwd) {
  const r = spawnSync(
    "python3",
    ["-m", "mypy", "--no-incremental", "--no-color-output", "--no-error-summary", ...files],
    { encoding: "utf8", cwd, env: { ...process.env, PYTHONPATH: oracleDir } },
  );
  // 0 = clean, 1 = errors found, 2 = a usage error. Anything else means the
  // oracle itself failed to run, which is not a verdict about the code.
  if (r.status !== 0 && r.status !== 1 && r.status !== 2) {
    return { error: (r.stderr || r.stdout || "").trim().split("\n").pop() };
  }
  return { status: r.status, text: (r.stdout || "").trim() };
}

export function blackCli(oracleDir, source) {
  const r = spawnSync("python3", ["-m", "black", "--quiet", "-"], {
    input: source,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: oracleDir },
  });
  if (r.status !== 0) return { error: (r.stderr || "").trim().split("\n")[0] };
  return { text: r.stdout };
}
/**
 * Run the REAL ruff CLI over a directory and return its findings and its
 * formatting, so the wasm build can be held to them.
 *
 * Pinned to the same version scripts/vendor-ruff.mjs vendors — comparing
 * against a different ruff would produce disagreements that are upstream's
 * changelog rather than our bug. Installed with pip like the other oracles
 * (ruff ships a wheel with the binary in it), and a missing one is reported as
 * a skipped comparison rather than a pass.
 */
export function ensureRuffOracle(dir, version) {
  const marker = path.join(dir, ".ruff-" + version);
  // Debian's pip puts a --prefix install under <prefix>/local/bin, everyone
  // else under <prefix>/bin. Looking in both beats guessing which host this is.
  const findBin = () => [path.join(dir, "bin", "ruff"), path.join(dir, "local", "bin", "ruff")].find((p) => fs.existsSync(p));
  const existing = findBin();
  if (fs.existsSync(marker) && existing) return { bin: existing };
  fs.mkdirSync(dir, { recursive: true });
  const r = spawnSync(
    "python3",
    // --ignore-installed because a ruff already on this machine makes pip skip
    // the install and leave the prefix empty, which reads as a broken oracle.
    ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "--ignore-installed", "--prefix", dir, `ruff==${version}`],
    { encoding: "utf8" },
  );
  const bin = findBin();
  if (r.status !== 0 || !bin) {
    return { error: `pip install ruff==${version} failed: ${(r.stderr || "").trim().split("\n").pop() || "installed no ruff binary"}` };
  }
  fs.writeFileSync(marker, version);
  return { bin };
}

/** `ruff check`, as "path:row:col: CODE message" lines, sorted for comparison. */
export function ruffCheckCli(bin, cwd, args = []) {
  // --color never, not NO_COLOR: this ruff colourises regardless of the
  // environment variable, and a comparison against escape codes would be a
  // comparison of terminal styling. The strip below is the belt to that brace.
  const r = spawnSync(bin, ["check", "--no-cache", "--color", "never", "--output-format", "concise", ...args, "."], {
    cwd,
    encoding: "utf8",
  });
  const lines = (r.stdout || "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .split("\n")
    .map((l) => l.trim())
    // The concise format tags a fixable finding with "[*]". Ours does not, on
    // purpose: --fix is refused here, so advertising a fix flag that answers
    // with a refusal would be the wrong kind of faithful. Dropped so the
    // comparison is about the finding, which is the part that must match.
    .map((l) => l.replace(/^(.*?:\d+:\d+: [A-Z]+\d+) \[\*\] /, "$1 "))
    .filter((l) => /^[^\s].*:\d+:\d+: /.test(l));
  return { status: r.status, lines: lines.sort() };
}

/** `ruff format -` on one source string. */
export function ruffFormatCli(bin, source) {
  const r = spawnSync(bin, ["format", "--no-cache", "-"], { input: source, encoding: "utf8" });
  if (r.status !== 0) return { error: (r.stderr || "").trim().split("\n")[0] };
  return { text: r.stdout };
}
