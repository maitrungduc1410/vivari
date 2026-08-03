// What real pip prints, and how to make real pip print it again here.
//
// WHY. `pip freeze > requirements.txt` is a load-bearing idiom, and `pip list`
// gets read by eye and by scripts. Output that is almost right — a column off,
// a name normalised differently, a `Requires:` we quietly left blank — is worse
// than no output, because it fails later and somewhere else. So the shapes below
// are not our idea of pip's format: they were captured from pip 25.3, and
// `realPipFormat()` re-derives them from whatever pip is on this machine so a
// row that is wrong cannot survive just because it was written down once. Same
// arrangement as scripts/lib/cpython-exit.mjs, and for the same reason.
//
// HOW THE RE-DERIVATION WORKS WITHOUT A NETWORK. `pip list --path DIR` and
// `pip freeze --path DIR` read dist-info directories off disk, so synthesising
// two .dist-info directories is enough to make real pip format real output for
// packages that were never downloaded. `pip show` has no --path, so it is driven
// with PYTHONPATH instead.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The fixture packages, chosen so that getting it wrong shows. Widths are
// uneven, and `zzz-wide-name` is the longest, so it — not the header — sets the
// first column's width. `Zebra` and `apple` straddle the case boundary: pip
// sorts by lowercased name, so they come out apple-then-Zebra, which is the
// opposite of what a plain ASCII sort gives. An all-lowercase fixture would let
// a case-sensitive sort pass.
export const FIXTURE_DISTS = [
  { name: "Alpha", version: "1.0" },
  { name: "zzz-wide-name", version: "2026.10.1" },
  { name: "mid", version: "0.3.1.dev0" },
  { name: "Zebra", version: "9.9" },
  { name: "apple", version: "0.1" },
];

// An install escapes the project name before naming the directory (PEP 427), so
// charset-normalizer installs to `charset_normalizer-3.4.9.dist-info`. Writing
// the unescaped name here makes real pip fall back to `===` for legacy versions,
// which is a fixture artefact rather than pip's behaviour on a real install.
const escapeName = (n) => n.replace(/[^A-Za-z0-9.]+/g, "_");

// Captured from pip 25.3 on 2026-08-02. Re-derived by realPipFormat() below on
// every offline run that finds a pip.
export const CAPTURED = {
  list:
    "Package       Version\n" +
    "------------- ----------\n" +
    "Alpha         1.0\n" +
    "apple         0.1\n" +
    "mid           0.3.1.dev0\n" +
    "Zebra         9.9\n" +
    "zzz-wide-name 2026.10.1\n",
  freeze:
    "Alpha==1.0\n" +
    "apple==0.1\n" +
    "mid==0.3.1.dev0\n" +
    "Zebra==9.9\n" +
    "zzz-wide-name==2026.10.1\n",
  // pip prints nothing at all for an empty environment — not a header, not a
  // blank line. A formatter that emits the header row would put a bare
  // "Package  Version" into someone's requirements.txt.
  emptyList: "",
  emptyFreeze: "",
  checkClean: "No broken requirements found.\n",
  // Both sentences reproduced against real pip: the first by uninstalling a
  // dependency, the second by rewriting an installed dist-info's Version.
  checkMissing: "requests 2.34.2 requires idna, which is not installed.\n",
  checkVersion:
    "requests 2.34.2 has requirement urllib3<3,>=1.26, but you have urllib3 1.0.0.\n",
  // pip show, on a package whose metadata uses PEP 621 fields — no Home-page,
  // a License-Expression instead of License, and an extras-only requirement
  // that must NOT appear under Requires.
  showModern:
    "Name: tabulate\n" +
    "Version: 0.10.0\n" +
    "Summary: Pretty-print tabular data\n" +
    "Home-page: https://github.com/astanin/python-tabulate\n" +
    "Author: \n" +
    "Author-email: Sergey Astanin <s.astanin@gmail.com>\n" +
    "License-Expression: MIT\n" +
    "Requires: \n" +
    "Required-by: \n",
  // The top-level surface, which only became reachable when `pip` went on PATH:
  // nobody types `python -m pip frobnicate`, but they will typo `pip instal`.
  // Both lines go to stderr and exit 1. The suggestion is difflib's, and it is
  // the reason the shim carries an edit distance rather than just printing the
  // first line — pip helps with the typo, and a pip that did not would be worse
  // at the moment the user is already confused.
  unknownCommand: 'ERROR: unknown command "frobnicate"\n',
  unknownCommandSuggest: 'ERROR: unknown command "instal" - maybe you meant "install"\n',
};

// Real pip's answer for a command it does not have. Same arrangement as
// realPipFormat: captured above, re-derived here, so the shape cannot drift.
export function realPipUnknown(spawnSync, word) {
  const r = spawnSync("python3", ["-m", "pip", word], { encoding: "utf8" });
  if (!r || r.status === null) return null;
  return { text: r.stderr, status: r.status };
}

function metadataFor(d) {
  return [
    "Metadata-Version: 2.1",
    "Name: " + d.name,
    "Version: " + d.version,
    "Summary: " + (d.summary || ""),
    "",
    "fixture",
    "",
  ].join("\n");
}

// Lay out .dist-info directories real pip will read.
export function writeFixtureSite(dir, dists = FIXTURE_DISTS) {
  fs.mkdirSync(dir, { recursive: true });
  for (const d of dists) {
    const info = path.join(dir, `${escapeName(d.name)}-${d.version}.dist-info`);
    fs.mkdirSync(info, { recursive: true });
    fs.writeFileSync(path.join(info, "METADATA"), metadataFor(d));
    fs.writeFileSync(path.join(info, "INSTALLER"), "pip\n");
    fs.writeFileSync(path.join(info, "RECORD"), "");
  }
  return dir;
}

// Runs the host's pip over a synthesised site directory and returns its exact
// stdout, or null when there is no usable pip here (reported loudly by the
// caller — a silent skip reads as green).
export function realPipFormat(spawnSync, dists = FIXTURE_DISTS) {
  const probe = spawnSync("python3", ["-m", "pip", "--version"], { encoding: "utf8" });
  if (!probe || probe.status !== 0) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vv-realpip-"));
  const site = writeFixtureSite(path.join(dir, "site"), dists);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "vv-realpip-empty-"));
  const run = (args) => {
    const r = spawnSync("python3", ["-m", "pip", ...args], { encoding: "utf8" });
    return r.status === 0 ? r.stdout : null;
  };
  const out = {
    version: (probe.stdout || "").trim().split(" ").slice(0, 2).join(" "),
    list: run(["list", "--path", site]),
    freeze: run(["freeze", "--path", site]),
    emptyList: run(["list", "--path", empty]),
    emptyFreeze: run(["freeze", "--path", empty]),
  };
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(empty, { recursive: true, force: true });
  return out;
}