// Spike (OFFLINE, fast): the studio's TypeScript must be able to resolve every
// plain-JavaScript module it imports.
//
// Several runtime modules are deliberately written in JavaScript so the offline
// spikes can drive the exact code the studio ships — python-lsp.js keeps Monaco
// as a parameter for that reason, and s3-app-source.js exists so a spike can
// import the bytes a template ships. The studio has `allowJs` off, so each of
// those needs a sibling .d.ts or `tsc -b` fails with TS7016.
//
// Nothing caught that before this check: no CI job compiles the studio. The
// TypeScript build runs in scripts/cloudflare-build.sh, which is the DEPLOY, so a
// missing declaration merged green and broke the site build afterwards. That is
// what happened to python-lsp.js. This is the cheap half of the fix — it gates
// the one class of error that has actually escaped, per PR and without needing
// bun or the studio's node_modules in CI. The complete fix is a job that runs
// `tsc -b` for real; until that exists, this is what stands between a missing
// declaration and a red deploy.
//
//   run:  node scripts/spike-studio-types.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "packages/studio/src");

let failed = 0;
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
};

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.tsx?$/.test(e.name) && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

console.log("== every .js the studio's TypeScript imports has declarations ==");

const files = walk(SRC);
ok(files.length > 20, `${files.length} TypeScript sources scanned`);

// `import ... from "…/x.js"` and `await import("…/x.js")`, relative only: a
// bare specifier is a package and carries its own types.
const SPEC = /(?:from\s*|import\s*\(\s*)["'](\.[^"']*\.js)["']/g;

const imports = [];
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(SPEC)) {
    const target = path.resolve(path.dirname(file), m[1]);
    imports.push({ file, spec: m[1], target });
  }
}
ok(imports.length > 0, `${imports.length} relative .js imports found (0 would mean this check stopped looking)`);

const missing = [];
for (const imp of imports) {
  if (!fs.existsSync(imp.target)) continue; // a broken path is tsc's to report, not ours
  const decl = imp.target.replace(/\.js$/, ".d.ts");
  if (!fs.existsSync(decl)) missing.push(imp);
}

ok(
  missing.length === 0,
  missing.length
    ? `imported from TypeScript with no .d.ts, so \`tsc -b\` fails at deploy: ${missing
        .map((m) => `${path.relative(ROOT, m.target)} (from ${path.relative(ROOT, m.file)})`)
        .join(", ")}`
    : `all ${imports.length} of them resolve to a module with declarations beside it`,
);

// The known cases, named so that deleting one is a deliberate act rather than an
// accident that silently shrinks what this covers.
for (const rel of ["packages/runtime/builtins/python-lsp.d.ts", "packages/studio/src/vv/s3-app-source.d.ts"]) {
  ok(fs.existsSync(path.join(ROOT, rel)), `${rel} is present`);
}

console.log(failed ? `\nFAIL: ${failed} check(s) failed` : "\nOK: the studio's JavaScript imports are all typed");
process.exit(failed ? 1 : 0);