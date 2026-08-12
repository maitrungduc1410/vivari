// Spike — the Next template's `postinstall` seeds Next's wasm SWC cache by
// LINKING, not by copying.
//
// The script it runs is 20 lines and looks harmless, which is the problem:
// `@next/swc-wasm-nodejs` is 30.4 MB and is almost entirely one .wasm, so
// `writeFileSync(dp, readFileSync(sp))` is 30 MB read and 30 MB written through
// the synchronous SAB bridge, plus a second 30 MB resident in the VFS's Wasm
// heap for the duplicate. It runs at the very end of the install, after the last
// progress line anything prints, so what a user sees is the terminal stopping.
//
// The fix is `fs.link` — a second name for the same inode, which is what OP_LINK
// was added for. Nothing about that is visible in the template's output, and a
// future edit could put the copy back with every other gate still green, so this
// asserts the property rather than the result: the destination has the source's
// bytes AND the source's inode.
//
// Runs the SHIPPED bytes — the script is read out of templates.ts, not retyped
// here — against the real kernel and the real Wasm VFS. Offline: the fixture
// stands in for the package, because what is under test is the copy, not Next.
//
//   run: node scripts/spike-seed-swc.mjs   (needs `npm run build:vfs:node`)

import { bootSpikeKernel } from "./lib/spike-harness.mjs";
import { loadShippedTemplates } from "./lib/shipped-templates.mjs";

const DIR = "/app";
const ENV = { HOME: "/home/user", PATH: "/bin", PWD: DIR };
// Big enough that a copy would be measurably different work, small enough to
// stay a fast offline gate. The real package is 30.4 MB.
const PAYLOAD_BYTES = 1 << 20;

let ok = true;
const gate = (label, pass, extra = "") => {
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!pass) ok = false;
};

const templates = await loadShippedTemplates();
const next = templates.find((t) => t.manifest.id === "next-ts");
gate("the next-ts template is still registered", !!next);
const seed = next && next.files["scripts/seed-swc.mjs"];
gate("it still ships scripts/seed-swc.mjs", !!seed);
gate(
  "and still runs it from postinstall",
  !!next && /"postinstall"\s*:\s*"node scripts\/seed-swc\.mjs"/.test(next.files["package.json"] || ""),
);
if (!seed) {
  console.log("\nFAIL: nothing to run");
  process.exit(1);
}

const { kernel } = await bootSpikeKernel();
kernel.mkdirp(`${DIR}/scripts`);
kernel.writeFile(`${DIR}/scripts/seed-swc.mjs`, seed);

const runNode = (src, name) => {
  kernel.writeFile(`${DIR}/${name}`, src);
  return kernel.start("node", [`${DIR}/${name}`], { cwd: DIR, env: ENV, capture: true });
};

// Stand in for the installed package: a nested dir and a file large enough that
// a copy is real work.
const setup = await runNode(
  `const fs = require('fs');
   fs.mkdirSync('${DIR}/node_modules/@next/swc-wasm-nodejs/inner', { recursive: true });
   fs.mkdirSync('${DIR}/node_modules/next', { recursive: true });
   fs.writeFileSync('${DIR}/node_modules/@next/swc-wasm-nodejs/next_swc.wasm', Buffer.alloc(${PAYLOAD_BYTES}, 7));
   fs.writeFileSync('${DIR}/node_modules/@next/swc-wasm-nodejs/package.json', '{"name":"@next/swc-wasm-nodejs"}');
   fs.writeFileSync('${DIR}/node_modules/@next/swc-wasm-nodejs/inner/wasm.js', 'module.exports = 1;');
   console.log('SETUP_OK');`,
  "setup.js",
);
gate("scaffold a stand-in @next/swc-wasm-nodejs", setup.code === 0 && /SETUP_OK/.test(setup.stdout || ""), setup.stderr.trim());

const run = await kernel.start("node", [`${DIR}/scripts/seed-swc.mjs`], { cwd: DIR, env: ENV, capture: true });
gate("the shipped postinstall runs clean", run.code === 0, (run.stderr || "").trim());
gate("and says it seeded", /seeded wasm SWC cache/.test(run.stdout || ""), (run.stdout || "").trim());

const DST = `${DIR}/node_modules/next/wasm/@next/swc-wasm-nodejs`;
const probe = await runNode(
  `const fs = require('fs');
   const s = fs.statSync('${DIR}/node_modules/@next/swc-wasm-nodejs/next_swc.wasm');
   const d = fs.statSync('${DST}/next_swc.wasm');
   console.log(JSON.stringify({
     bytes: d.size,
     sameInode: s.ino === d.ino && s.ino !== 0,
     nlink: d.nlink,
     nested: fs.readFileSync('${DST}/inner/wasm.js', 'utf8'),
     manifest: JSON.parse(fs.readFileSync('${DST}/package.json', 'utf8')).name,
   }));`,
  "probe.js",
);
let seen = null;
try {
  seen = JSON.parse((probe.stdout || "").trim());
} catch {
  /* reported below */
}
gate("the seeded wasm is there at full size", seen?.bytes === PAYLOAD_BYTES, String(seen?.bytes));
// THE assertion. Everything else here passes just as happily against the byte
// copy this replaced.
gate("it is the SAME inode — linked, not copied", seen?.sameInode === true, `nlink=${seen?.nlink}`);
gate("nested directories came across too", seen?.nested === "module.exports = 1;");
gate("so did the package manifest", seen?.manifest === "@next/swc-wasm-nodejs");

// The short-circuit that keeps a re-install from redoing any of this.
const again = await kernel.start("node", [`${DIR}/scripts/seed-swc.mjs`], { cwd: DIR, env: ENV, capture: true });
gate(
  "a second run is a no-op (the existsSync(dst) short-circuit still holds)",
  again.code === 0 && !/seeded wasm SWC cache/.test(again.stdout || ""),
  (again.stdout || "").trim(),
);

console.log(ok ? "\nOK: the wasm SWC cache is seeded by link" : "\nFAIL");
process.exit(ok ? 0 : 1);
