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
export function blackCli(oracleDir, source) {
  const r = spawnSync("python3", ["-m", "black", "--quiet", "-"], {
    input: source,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: oracleDir },
  });
  if (r.status !== 0) return { error: (r.stderr || "").trim().split("\n")[0] };
  return { text: r.stdout };
}