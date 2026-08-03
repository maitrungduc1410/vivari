// Spike (offline, no Wasm, no network): every shipped template's JavaScript
// parses, and every JSON file is JSON.
//
// Templates are source code stored inside a TypeScript file, mostly as template
// literals. That nesting has a trap with no warning: a backslash belongs to the
// OUTER literal first. A regex written `/^https?:\/\//i` inside a template's
// source arrives in the generated project as `/^https?:///i` — the `//` starts a
// comment, the statement never closes, and the app dies on boot with
// `SyntaxError: Unexpected token 'const'` pointing at a line that is fine.
//
// That is not hypothetical: it shipped in the S3 template and was caught by a
// spike in the network tier, which is `continue-on-error` and schedule-only, so
// it gates nothing. 75 templates carry 59 JavaScript files and 98 JSON files and
// nothing was checking that any of them parse. This runs on every push.
//
// Deliberately NOT type-checking, linting or executing anything — it answers one
// question, the cheapest and most embarrassing one to get wrong: is this a file
// Node can even read?
//
// Run: node scripts/spike-template-syntax.mjs

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { loadShippedTemplates } from "./lib/shipped-templates.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// `node --check` reads the module goal from the extension and the nearest
// package.json, which is why each template is written out whole rather than
// checked file by file in isolation: a template that declares "type": "module"
// must have its plain .js files parsed as ESM, and one that does not must not.
const JS = /\.(js|mjs|cjs)$/;
// TypeScript and JSX are out of scope: `node --check` does not strip types, so
// it rejects every .ts file on syntax that is perfectly valid. Checking those
// needs a real parser, which is a different (and much heavier) gate.
const SKIP = /\.(ts|tsx|jsx|mts|cts)$/;

const templates = await loadShippedTemplates();
console.log(`\n== ${templates.length} shipped templates ==`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vv-template-syntax-"));
let jsChecked = 0;
let jsonChecked = 0;
const failures = [];

// Write a template out, then hand each JavaScript file to `node --check`.
async function checkTemplate(t) {
  const id = t.manifest?.id || "(no id)";
  const files = t.files || {};
  const dir = path.join(tmp, id.replace(/[^\w.-]/g, "_"));

  for (const [rel, contents] of Object.entries(files)) {
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, typeof contents === "string" ? contents : String(contents));
  }

  for (const rel of Object.keys(files)) {
    if (rel.endsWith(".json")) {
      jsonChecked++;
      try {
        JSON.parse(files[rel]);
      } catch (e) {
        failures.push({ id, rel, why: `invalid JSON — ${e.message}` });
      }
      continue;
    }
    if (SKIP.test(rel) || !JS.test(rel)) continue;
    jsChecked++;
    try {
      await execFileAsync(process.execPath, ["--check", path.join(dir, rel)]);
    } catch (e) {
      // The useful part of node's output is the SyntaxError and the line above it.
      const out = String(e.stderr || e.message);
      const line = out.split("\n").find((l) => /Error/.test(l)) || out.split("\n")[0];
      failures.push({ id, rel, why: line.trim() });
    }
  }
}

// The registry itself: a manifest that points at a file it does not ship is a
// template that cannot start, and no amount of valid syntax fixes it.
function checkRegistry(t, seen) {
  const id = t.manifest?.id;
  if (!id) {
    failures.push({ id: "(no id)", rel: "manifest", why: "template has no id" });
    return;
  }
  if (seen.has(id)) failures.push({ id, rel: "manifest", why: "duplicate template id" });
  seen.add(id);
  const entry = t.manifest.entry;
  if (entry && !(entry in (t.files || {}))) {
    failures.push({ id, rel: "manifest.entry", why: `entry "${entry}" is not among the template's files` });
  }
}

const seen = new Set();
// A little concurrency: this is ~60 short-lived node processes.
const queue = [...templates];
const workers = Array.from({ length: 8 }, async () => {
  for (let t = queue.shift(); t; t = queue.shift()) await checkTemplate(t);
});
for (const t of templates) checkRegistry(t, seen);
await Promise.all(workers);

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`  ${jsChecked} JavaScript files parsed`);
console.log(`  ${jsonChecked} JSON files parsed`);
console.log(`  ${templates.length} manifests checked against their own file lists`);

// The gate has to be registered to be a gate. Bun's and Python's entries both
// found spikes that ran in no job at all, so this one refuses to pass quietly if
// it drops out of the offline tier.
const registry = fs.readFileSync(path.join(ROOT, "scripts/run-spikes.mjs"), "utf8");
const registered = /\{ name: "template-syntax",[^}]*net: false/.test(registry);
if (!registered) {
  failures.push({
    id: "(self)",
    rel: "scripts/run-spikes.mjs",
    why: 'this spike is not registered as { name: "template-syntax", …, net: false } — it would run in no job',
  });
}

if (failures.length) {
  console.log(`\n${failures.length} problem(s):`);
  for (const f of failures) console.log(`  FAIL  ${f.id}  ${f.rel}\n        ${f.why}`);
}

const ok = failures.length === 0;
console.log(`\nRESULT: ${ok ? "PASS — every shipped template parses" : "FAIL — see above"}`);
process.exit(ok ? 0 : 1);