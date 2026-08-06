// Spike: an interactive scaffolder can be answered.
//
// This is the reason `readline` was rebuilt (spike-readline.mjs covers the API
// itself). `npm init` is nine sequential questions driven through npm's `read`, which
// is the same shape `create-vite` and `bun create` use, and before the rebuild it
// printed its first question and exited 0 — the single most visible symptom of a
// readline that could not read.
//
// On the net tier because it needs a real vendored npm, which only that tier
// provisions.
//
//   run:  node scripts/spike-scaffolder.mjs

import { bootSpikeKernel } from "./lib/spike-harness.mjs";

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const h = await bootSpikeKernel({ npm: true });
const { kernel } = h;
kernel.mkdirp("/proj");
kernel.mkdirp("/home/user");

console.log("\n`npm init`, answered question by question");
const from = h.out.length;
const pid = kernel.launch("npm", ["init"], {
  cwd: "/proj",
  env: { PATH: "/bin", HOME: "/home/user", PWD: "/proj" },
});
if (pid < 0) throw new Error("could not launch npm");
await sleep(4000);

// name, version, description, entry point, test command, git repo, keywords, author,
// license, then the "Is this OK?" confirmation. Blank means "take the default".
const ANSWERS = ["my-app\n", "2.3.4\n", "a test\n", "\n", "\n", "\n", "\n", "Ada\n", "MIT\n", "\n", "yes\n", "\n"];
for (const a of ANSWERS) {
  kernel.sendStdin(pid, a);
  await sleep(700);
}
await sleep(2500);
const text = h.out.slice(from).join("");

ok(/package name:/.test(text), "it asks its first question");
ok(/license:/.test(text), "…and reaches its last one, rather than exiting after the first");
// The echo is asserted on purpose. Nothing in this stack echoes for us — not xterm,
// not the kernel — so an answer the user cannot see is an answer they cannot correct,
// and `npm init` chooses its non-echoing path off process.stdout.isTTY, which is
// false here. See the note on _interactive in node/lib/readline.js.
ok(
  /package name: \(proj\) my-app/.test(text),
  "…with the answers visible as typed: " + JSON.stringify((/package name:.*/.exec(text) || [""])[0]),
);

let pkg = null;
try {
  pkg = JSON.parse(kernel.readFile("/proj/package.json", "utf8"));
} catch {
  pkg = null;
}
ok(!!pkg, "it writes a package.json");
ok(
  pkg && pkg.name === "my-app" && pkg.version === "2.3.4" && pkg.author === "Ada" && pkg.license === "MIT",
  "…built from the answers given, not the defaults: " +
    JSON.stringify(pkg && { name: pkg.name, version: pkg.version, author: pkg.author, license: pkg.license }),
);

console.log(failed === 0 ? "\nOK: a scaffolder can be answered" : `\nFAIL: ${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
