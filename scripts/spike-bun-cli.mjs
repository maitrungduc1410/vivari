// `bun init` and `bun pm`, run as real processes in the VM.
//
// Both used to print "not implemented in the Vivari shim yet" and exit 1, which
// for `bun init` means the first command in Bun's own getting-started page did
// nothing. The files and the wording here are the 1.3.14 binary's, recorded from
// a real `bun init -y`: a template people copy from is a contract, and a project
// scaffolded here should diff clean against one scaffolded there.
//
// The install step at the end of `bun init` is npm's and needs a registry, so it
// is not asserted here — what is asserted is that every file exists, with the
// right bytes, BEFORE that step, which is the part this change owns.
//
// Run: node scripts/run-spikes.mjs --offline bun-cli

import { bootSpikeKernel, writeProject, defaultEnv } from "./lib/spike-harness.mjs";

const APP = "/app";
let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + label);
  if (!cond) failed++;
};

const { kernel } = await bootSpikeKernel();
writeProject(kernel, APP, { ".keep": "" });
const ENV = defaultEnv(APP);

console.log("\n1) bun init writes the project real bun writes");
{
  const r = await kernel.start("bun", ["init", "-y", "demo"], { cwd: APP, env: ENV, capture: true });
  const out = r.stdout || "";
  const read = (f) => {
    try {
      return kernel.readFile(APP + "/demo/" + f);
    } catch {
      return null;
    }
  };
  ok(/ \+ index\.ts/.test(out), "it reports the files it created, in Bun's format");
  ok(/tsconfig\.json \(for editor autocomplete\)/.test(out), "including the tsconfig note Bun prints");
  ok(/To get started, run:/.test(out) && /bun run index\.ts/.test(out), "and Bun's getting-started footer");

  const pkg = JSON.parse(read("package.json") || "{}");
  ok(pkg.name === "demo", "package.json takes its name from the folder");
  ok(pkg.module === "index.ts" && pkg.type === "module" && pkg.private === true, "with Bun's module/type/private fields");
  ok(pkg.devDependencies && pkg.devDependencies["@types/bun"] === "latest", "@types/bun is a devDependency, as Bun writes it");
  ok(pkg.peerDependencies && pkg.peerDependencies.typescript === "^5", "and typescript is a peerDependency");

  ok(read("index.ts") === 'console.log("Hello via Bun!");', "index.ts is byte-identical to Bun's");
  const ts = read("tsconfig.json") || "";
  ok(/"moduleResolution": "bundler"/.test(ts) && /"types": \["bun"\]/.test(ts), "tsconfig carries Bun's compiler options");
  ok(/\/\/ Bundler mode/.test(ts), "including the comments Bun's template has (it is JSONC, and people read it)");
  const gitignore = read(".gitignore") || "";
  ok(/^# dependencies \(bun install\)/.test(gitignore) && /node_modules/.test(gitignore), ".gitignore is Bun's");
  ok(/_\.log/.test(gitignore), "typos included: Bun's own template says '_.log', and matching it is the point");
  const readme = read("README.md") || "";
  ok(/^# demo/.test(readme) && /bun run index\.ts/.test(readme), "README is Bun's, with the project name");
}

console.log("\n2) running it twice does not clobber your work");
{
  kernel.writeFile(APP + "/demo/index.ts", "console.log('mine');");
  const r = await kernel.start("bun", ["init", "-y"], { cwd: APP + "/demo", env: defaultEnv(APP + "/demo"), capture: true });
  ok(kernel.readFile(APP + "/demo/index.ts") === "console.log('mine');", "an existing index.ts survives a second bun init");
  ok(!/ \+ index\.ts/.test(r.stdout || ""), "and is not reported as created");
}

console.log("\n3) bun pm answers questions about the project on disk");
{
  writeProject(kernel, APP + "/pm", {
    "package.json": JSON.stringify({ name: "pmdemo", version: "1.0.0", dependencies: { left: "^1.0.0" } }, null, 2),
    "node_modules/left/package.json": JSON.stringify({ name: "left", version: "1.2.3" }),
    "node_modules/hidden/package.json": JSON.stringify({ name: "hidden", version: "9.9.9" }),
  });
  const PM = defaultEnv(APP + "/pm");
  const run = (args) => kernel.start("bun", args, { cwd: APP + "/pm", env: PM, capture: true });

  const ls = await run(["pm", "ls"]);
  ok(/node_modules \(2\)/.test(ls.stdout || ""), "bun pm ls counts what is installed: " + JSON.stringify((ls.stdout || "").split("\n")[0]));
  ok(/left@1\.2\.3/.test(ls.stdout || "") && !/hidden@/.test(ls.stdout || ""), "and lists the direct dependencies only");
  const all = await run(["pm", "ls", "--all"]);
  ok(/hidden@9\.9\.9/.test(all.stdout || ""), "--all lists the transitive ones too");

  const bin = await run(["pm", "bin"]);
  ok(/\/app\/pm\/node_modules\/\.bin/.test(bin.stdout || ""), "bun pm bin prints the bin folder: " + JSON.stringify((bin.stdout || "").trim()));

  const get = await run(["pm", "pkg", "get", "name"]);
  ok((get.stdout || "").trim() === '"pmdemo"', "bun pm pkg get prints JSON, as Bun does: " + JSON.stringify((get.stdout || "").trim()));
  await run(["pm", "pkg", "set", "scripts.dev=bun run index.ts", "private=true"]);
  const after = JSON.parse(kernel.readFile(APP + "/pm/package.json"));
  ok(after.scripts && after.scripts.dev === "bun run index.ts", "set writes a dotted path");
  ok(after.private === true, "and parses a JSON value rather than storing the string 'true'");
  await run(["pm", "pkg", "delete", "scripts.dev"]);
  const deleted = JSON.parse(kernel.readFile(APP + "/pm/package.json"));
  ok(deleted.scripts && deleted.scripts.dev === undefined, "delete removes it again");

  const whoami = await run(["pm", "whoami"]);
  ok(/no credential store/.test(whoami.stderr || ""), "whoami refuses with the reason rather than an empty answer");
  ok(whoami.code === 1, "and exits 1");

  const usage = await run(["pm"]);
  ok(/Run package manager utilities/.test(usage.stdout || ""), "bare `bun pm` prints usage instead of failing");
}

console.log("\n4) what bun create can and cannot do here");
{
  const r = await kernel.start("bun", ["create", "some-user/some-repo"], { cwd: APP, env: ENV, capture: true });
  ok(/no git transport/.test(r.stderr || ""), "a GitHub template says which half is missing: " + JSON.stringify((r.stderr || "").slice(0, 70)));
  ok(r.code === 1, "and exits 1 rather than half-scaffolding");
}

console.log("\n5) bun exec runs a SHELL command, bun x runs a package");
{
  // These were the same function, pointed at npx. `bun exec 'echo hi && pwd'` went
  // looking for a package named "echo hi && pwd" — checked against the 1.3 binary,
  // which runs it through Bun Shell and honours the &&.
  const r = await kernel.start("bun", ["exec", "echo HELLO-FROM-SHELL && echo second"], { cwd: APP, env: ENV, capture: true });
  const out = (r.stdout || "").replace(/\s+/g, " ");
  ok(/HELLO-FROM-SHELL/.test(out), "bun exec runs the command: " + JSON.stringify(out.slice(0, 60)));
  ok(/second/.test(out), "…and && is the shell's, not a literal argument");
  ok(r.code === 0, "…and the exit code is the command's");

  const fail = await kernel.start("bun", ["exec", "exit 3"], { cwd: APP, env: ENV, capture: true });
  ok(fail.code === 3, "a failing command's exit code is passed through, not swallowed: " + fail.code);

  const bare = await kernel.start("bun", ["exec"], { cwd: APP, env: ENV, capture: true });
  ok(/usage: bun exec/.test(bare.stderr || ""), "bare `bun exec` prints usage and points at bun x");
  ok(/bun x <package>/.test(bare.stderr || ""), "…naming the other command, since that is the likely mix-up");
}

console.log("\n6) the registry verbs, and the three that cannot work");
{
  // `why` is the interesting one: `bun pm why` already existed, but the top-level
  // spelling is what Bun's docs use, and it printed "not implemented".
  const why = await kernel.start("bun", ["why", "nothing-installed-here"], { cwd: APP + "/pm", env: ENV, capture: true });
  ok(!/not implemented in the Vivari shim/.test(why.stderr || ""), "bun why reaches npm instead of refusing: " + JSON.stringify(((why.stdout || "") + (why.stderr || "")).slice(0, 60)));

  for (const [verb, phrase] of [
    ["publish", /authenticated npm session/],
    ["patch", /no git transport/],
    ["repl", /wants a tty/],
  ]) {
    const r = await kernel.start("bun", [verb], { cwd: APP, env: ENV, capture: true });
    ok(phrase.test(r.stderr || ""), "bun " + verb + " refuses with the reason: " + JSON.stringify((r.stderr || "").slice(0, 60)));
    ok(r.code === 1, "…and exits 1");
  }
}

console.log(failed ? `\nFAIL: ${failed} check(s) failed` : "\nOK: bun init and bun pm behave as the binary does");
process.exit(failed ? 1 : 0);
