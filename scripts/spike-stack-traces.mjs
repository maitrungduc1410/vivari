// Spike: a stack frame must name the USER'S file, at the USER'S line.
//
// Why this is worth a gate of its own: the loader compiles every module through a
// wrapper, and for a long time that wrapper was built with `new Function`, which
// produces an anonymous script. Every guest frame therefore read
//
//   at f (eval at compile (…/packages/runtime/module.js:585:11), <anonymous>:3:21)
//
// naming OUR loader, hiding theirs, and counting lines from the wrapper rather than
// the file. That is the single least actionable thing a runtime can print.
//
// The fix has two halves and this spike exists because HALF a fix is worse than
// none. Attaching `//# sourceURL` names the file; but the TypeScript strip used to
// delete the lines that types occupied, so a named `.ts` frame would have carried a
// line number that looked authoritative and was wrong. So the assertions below pin
// the exact LINE, never just the filename, and they cover .ts/.tsx as well as .js —
// the combination is the only thing that proves both halves landed.
//
// Shape follows spike-node-cli.mjs: the same programs run on the host's real node
// and in the VM, and the two transcripts must agree. Host parity is only claimed
// for what real node runs unaided (.js/.mjs/.cjs); for .ts/.tsx the expectation is
// pinned absolutely, since whether the host strips types depends on its version.
//
//   run:  node scripts/spike-stack-traces.mjs

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bootSpikeKernel, writeProject } from "./lib/spike-harness.mjs";

let failed = 0;
const ok = (cond, label, extra) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}`);
  if (!cond) {
    failed++;
    if (extra) console.log(`        ${extra}`);
  }
};

// Every file below puts its throw on a line whose number is stated in the name, so
// a reader can check the expectation against the source without running anything.
// The blank lines and type noise before each throw are the point: they are what a
// line-losing transform would eat.
const FILES = {
  // CJS, no transform at all — the control.
  "plain-cjs.js": [
    "'use strict';",
    "",
    "function boom() {",
    "  throw new Error('from-plain-cjs');",
    "}",
    "",
    "module.exports = { boom };",
    "boom();",
  ].join("\n"),

  // ESM, which goes through the import/export rewrite.
  "plain-esm.mjs": [
    "const label = 'from-plain-esm';",
    "",
    "export function boom() {",
    "  throw new Error(label);",
    "}",
    "",
    "boom();",
  ].join("\n"),

  // TypeScript. Types occupy lines 3-9; the throw is on line 13. A transform that
  // deletes those lines instead of blanking them reports 6 or 7 here.
  "typed.ts": [
    "const label: string = 'from-typed-ts';",
    "",
    "interface Config {",
    "  name: string;",
    "  retries: number;",
    "}",
    "",
    "type Handler = (c: Config) => void;",
    "",
    "export function boom(cfg?: Config): never {",
    "  const h: Handler | null = null;",
    "  void h;",
    "  throw new Error(label);",
    "}",
    "",
    "boom();",
  ].join("\n"),

  // TSX: JSX lowering collapses an element to a single call, so the throw after it
  // is the thing that moves if the lowering does not put the lines back.
  "typed.tsx": [
    "const React = { createElement: (t, p, ...c) => ({ t, p, c }) };",
    "",
    "type Props = { title: string };",
    "",
    "function View(props: Props) {",
    "  return (",
    "    <div className=\"wrap\">",
    "      <span>{props.title}</span>",
    "    </div>",
    "  );",
    "}",
    "",
    "void View;",
    "void React;",
    "throw new Error('from-typed-tsx');",
  ].join("\n"),
};

// label -> [file, expected line]. The line is the throw's own line, 1-based.
const CASES = [
  ["plain-cjs", "plain-cjs.js", 4],
  ["plain-esm", "plain-esm.mjs", 4],
  ["typed-ts", "typed.ts", 13],
  ["typed-tsx", "typed.tsx", 15],
];

// Reduce a stack to "<basename>:<line>" for the FIRST frame that mentions the file
// under test. Column is deliberately dropped: the wrapper header shares line 1 with
// the body, so a column on line 1 is offset, and nothing here throws on line 1.
const firstFrame = (text, base) => {
  const re = new RegExp(String.raw`${base.replace(/[.]/g, "\\.")}:(\d+):\d+`);
  const m = re.exec(text);
  return m ? `${base}:${m[1]}` : null;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vv-stacks-"));
for (const [rel, body] of Object.entries(FILES)) fs.writeFileSync(path.join(tmp, rel), body);
fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "stacks", private: true }));

// ── the VM ───────────────────────────────────────────────────────────────────
const h = await bootSpikeKernel();
const kernel = h.kernel;
writeProject(kernel, "/app", { ...FILES, "package.json": JSON.stringify({ name: "stacks", private: true }) });

console.log("stack traces: file + line, in the VM");
const vmFrames = new Map();
for (const [label, file, wantLine] of CASES) {
  const r = await kernel.start("node", [file], { cwd: "/app", capture: true });
  const out = (r.stdout || "") + (r.stderr || "");
  const got = firstFrame(out, file);
  vmFrames.set(label, got);
  ok(got === `${file}:${wantLine}`, `${label}: frame is ${file}:${wantLine}`, `got ${got === null ? "no frame naming the file" : got} — full output:\n        ${out.trim().split("\n").join("\n        ")}`);
}

// The TOP frame — the throw site, the one a reader acts on — must be the user's
// file. Loader frames further down are fine and expected; real node shows its own
// `node:internal/modules/...` there too. What must never come back is the old shape,
// where the top frame itself was `eval at compile (…/module.js:585:11), <anonymous>`.
console.log("\nstack traces: the throw site is the user's file, not the loader's");
for (const [label, file] of CASES) {
  const r = await kernel.start("node", [file], { cwd: "/app", capture: true });
  const out = (r.stdout || "") + (r.stderr || "");
  const top = (out.split("\n").find((l) => /^\s+at /.test(l)) || "").trim();
  ok(
    top.includes(file) && !/eval at compile|<anonymous>:\d+/.test(top),
    `${label}: top frame is ${file} — ${JSON.stringify(top)}`,
  );
}

// ── host parity, for what real node runs unaided ─────────────────────────────
console.log("\nstack traces: host node agrees (.js / .mjs)");
for (const [label, file, wantLine] of CASES) {
  if (!/\.(js|mjs|cjs)$/.test(file)) continue;
  let out = "";
  try {
    out = execFileSync(process.execPath, [file], { cwd: tmp, encoding: "utf8", timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = (e.stdout || "") + (e.stderr || "");
  }
  const hostFrame = firstFrame(out, file);
  ok(
    hostFrame === `${file}:${wantLine}` && hostFrame === vmFrames.get(label),
    `${label}: host ${hostFrame} === vm ${vmFrames.get(label)}`,
  );
}

// ── the REPL keeps its clean frames ──────────────────────────────────────────
// The REPL trims internal frames so a one-liner's error is one line. Naming the
// loader's scripts must not put them back, and typing a throw must still not
// mention module.js.
console.log("\nstack traces: the REPL still reports its own errors cleanly");
{
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  kernel.mkdirp("/home/user");
  // An uncaptured launch, so the REPL sees a tty — same as spike-repl.mjs.
  const pid = kernel.launch("node", [], { cwd: "/app", env: { PATH: "/bin", HOME: "/home/user", PWD: "/app" } });
  if (pid < 0) throw new Error("could not launch node");
  await sleep(1500);
  const mark = h.out.length;
  kernel.sendStdin(pid, "throw new Error('repl-boom')\n");
  await sleep(700);
  // Drop the echo of the typed line, so this reads the REPL's answer and not the
  // keystrokes — the assertion-matches-echo trap.
  const echoed = h.out.slice(mark).join("");
  const answer = echoed.slice(echoed.indexOf("\n") + 1);
  kernel.sendStdin(pid, "\u0004");
  await sleep(500);
  ok(/Error: repl-boom/.test(answer), "REPL reports the error", JSON.stringify(answer));
  ok(!/module\.js:\d+|eval at compile/.test(answer), "REPL error names no loader frame", JSON.stringify(answer));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed === 0 ? "\nstack traces: OK" : `\nstack traces: ${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
