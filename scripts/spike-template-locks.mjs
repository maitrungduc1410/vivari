// One gate for every shipped lockfile: install the template in the VM FROM THE
// GENERATED LOCK and prove the tree that comes out is usable.
//
//   node scripts/spike-template-locks.mjs                 # gate the COVERAGE set
//   VV_LOCK_IDS=all node scripts/spike-template-locks.mjs # try every eligible id
//   VV_LOCK_IDS=next-ts,astro node scripts/spike-template-locks.mjs
//
// WHY ONE GATE AND NOT FIFTY-THREE SPIKES. `COVERAGE` in gen-template-locks.mjs
// is the list of templates whose lock is SHIPPED, and the bar for joining it is
// that something installs that template from that lock inside the VM. Meeting
// that bar with a bespoke spike per template is ~50 files of near-identical
// boilerplate, each with its own timeout and its own way of being subtly wrong.
// This is the same list, driven once.
//
// WHAT IT IS FOR. A lock is resolved on an x64 host and reified on wasm32. The
// failure that motivates the whole rule is not a crash — it is `npm install`
// exiting **0** having installed a tree that cannot run. A lock resolved
// against a private mirror pins `http://npm.mirror.invalid/...` for all 102
// packages: every fetch then fails in the VM, npm exits 0, and the project
// lands with no `node_modules/.bin/vite`.
// Exit code alone would have called that a pass. So would "node_modules exists".
//
// WHAT "USABLE" MEANS HERE, all of it derived from the template rather than
// listed per id, so a new template is covered without anyone editing this file:
//
//   1. `npm install` exits 0.
//   2. Every DIRECT dependency in package.json resolves to a real package
//      directory with its own package.json. This is the check that would have
//      caught the mirror bug on any template, not just ones with a binary.
//   3. Every executable the template's own dev command reaches exists in
//      `node_modules/.bin`. `manifest.dev` is always `npm run <script>` or
//      `node <file>`, so the real tool name is one hop away, inside
//      package.json's `scripts` — `devTools` below walks that.
//   4. Where the dev command runs a FILE (`node src/index.js`), that file
//      exists. Nine templates have no binary at all and would otherwise be
//      gated by (1) and (2) alone.
//
//   5. And where the lock carries an ALIASED entry — a wasm drop-in resolved
//      under a native package's name, which is how esbuild and lightningcss are
//      made to work in a lock — that package is `require()`d and the template's
//      dev server has to BIND. Installing proves neither: `tailwind` passed 1-4
//      with exit 0 and then died on `failed to load config from vite.config.js`
//      because its lock pinned the real lightningcss. Which ids these are is
//      read off each lock, not listed, so it tracks what the locks actually pin.
//
// WHAT IT DELIBERATELY DOES NOT PROVE. It does not boot the templates whose lock
// has no aliased entry, nor does it render anything for the ones it does boot —
// a bound port is not a working app. The eight framework spikes in
// `template-gate` (react, preact, lit, solid, vue, svelte, qwik, ember) go
// further and assert on the response. So
// this gate is a floor, not a ceiling, and the COVERAGE comment says which ids
// have which.
//
// COST. One kernel is booted for the whole corpus and each template installs
// into its own directory, so the in-VM npm cache is shared and warm from the
// second template onward — the same amortisation gen-template-locks.mjs gets on
// the host. `node_modules` is deleted after each template because 53 trees in a
// Wasm VFS is gigabytes; the cache, which is the part worth keeping, stays.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VFS_NPM, bootSpikeKernel, defaultEnv, npmInstall, waitListen, writeProject } from "./lib/spike-harness.mjs";
import { loadShippedTemplates } from "./lib/shipped-templates.mjs";
import { COVERAGE, eligibility } from "./gen-template-locks.mjs";
import { NATIVE_DROPIN_ALIASES, NATIVE_WASM_ALIASES } from "../packages/runtime/toolchain-shims.js";

const ALIASED_NATIVES = { ...NATIVE_WASM_ALIASES, ...NATIVE_DROPIN_ALIASES };

// The id that additionally proves the alias survives a user's own npm command,
// and the package it adds to do it — see the block that uses them. One id
// rather than all 27, because the answer is npm's and not the template's; a
// tiny dependency-free package, so what is being measured is the reconcile.
const SURVIVAL_ID = "tailwind";
const SURVIVAL_ADD = "ms";

/**
 * The `[nativeName, dropInName]` pairs a lock aliases, deduplicated by name.
 *
 * Read from the shipped bytes rather than from a list in the generator, so the
 * ids that owe a boot are exactly the ids whose lock pins one — add an aliased
 * native to a template and the gate demands the evidence without being told.
 */
function aliasedEntries(lockText) {
  const seen = new Map();
  for (const [key, meta] of Object.entries(JSON.parse(lockText).packages || {})) {
    const name = key.split("node_modules/").pop();
    if (meta && meta.name && ALIASED_NATIVES[name] === meta.name) seen.set(name, meta.name);
  }
  return [...seen];
}

const lastLine = (r) =>
  String(r.stderr || r.stdout || "").trim().split("\n").filter(Boolean).pop() || `exit ${r.code}`;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_DIR = path.join(ROOT, "packages/studio/public/vendor/locks");

// Commands that are not a package binary: resolving them proves nothing about
// node_modules. `node` is the interpreter, the rest are coreutils the kernel
// installs itself.
const NOT_A_BIN = new Set([
  "node", "sh", "bash", "cd", "echo", "true", "false", "rm", "mkdir", "cp", "mv",
  "cat", "wait", "sleep", "export", "set", "test", "exit", "printf", "touch", "ls",
  // `bun` is the kernel's own program (kernel-host/programs/bun.js), installed
  // at /bin/bun.js like the coreutils — never a package in node_modules.
  "bun", "bunx",
]);

/** A token that names a file to run, rather than a script or a flag. */
const looksLikeFile = (s) => /\.[cm]?[jt]sx?$/.test(s);

/**
 * The executables a template's dev command actually reaches, and the files it
 * runs, by walking `manifest.dev` through package.json's `scripts`.
 *
 * Every eligible template's dev command is `npm run <script>`, `npm start` or
 * `node <file>` — 44 and 9 of the 53 — so the binary is never named in the
 * manifest itself. `npm run dev -- --configLoader native` has to become
 * `scripts.dev`, which is `vite`, which is the thing whose absence is the bug.
 *
 * Chains (`npm run build && node dist/index.js`) contribute from every link,
 * and the walk is depth-limited because a script may reference itself.
 */
export function devTools(manifest, pkg) {
  const scripts = (pkg && pkg.scripts) || {};
  const tools = new Set();
  const files = new Set();
  const seen = new Set();
  const walk = (cmd, depth) => {
    if (!cmd || depth > 4) return;
    for (const part of String(cmd).split(/&&|\|\||;|\|/)) {
      const toks = part.trim().split(/\s+/).filter(Boolean);
      // `FOO=bar cmd …` — step over the assignments to reach the command.
      let i = 0;
      while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
      const head = toks[i];
      if (!head || head.startsWith("-")) continue;
      if (head === "npm" || head === "pnpm" || head === "yarn") {
        const sub = toks[i + 1];
        const name = sub === "run" || sub === "run-script" ? toks[i + 2] : sub === "start" || sub === "test" ? sub : null;
        if (name && scripts[name] && !seen.has(name)) {
          seen.add(name);
          walk(scripts[name], depth + 1);
        }
        continue;
      }
      // `npx foo` runs foo from node_modules/.bin when it is installed.
      if (head === "npx") {
        const t = toks.slice(i + 1).find((a) => !a.startsWith("-"));
        if (t) tools.add(t);
        continue;
      }
      if (head === "node") {
        const f = toks.slice(i + 1).find((a) => !a.startsWith("-"));
        // Skip a node flag's value and anything that is plainly not a path.
        if (f && looksLikeFile(f)) files.add(f);
        continue;
      }
      // `bun run X` is either a file (`bun run index.ts`) or a script name, and
      // `bun test` is neither. Bun templates are all the first form.
      if (head === "bun" || head === "bunx") {
        const rest = toks.slice(i + 1).filter((a) => !a.startsWith("-"));
        const arg = rest[0] === "run" ? rest[1] : rest[0];
        if (arg && looksLikeFile(arg)) files.add(arg);
        else if (arg && scripts[arg] && !seen.has(arg)) {
          seen.add(arg);
          walk(scripts[arg], depth + 1);
        }
        continue;
      }
      if (NOT_A_BIN.has(head)) continue;
      tools.add(head);
    }
  };
  walk(manifest.dev, 0);
  return { tools: [...tools], files: [...files] };
}

/** The ids this run gates: COVERAGE by default, anything on request. */
function selectIds(templates) {
  const raw = (process.env.VV_LOCK_IDS || "").trim();
  const eligible = templates.filter((t) => eligibility(t) === null).map((t) => t.manifest.id);
  if (!raw) return COVERAGE.slice();
  if (raw === "all") return eligible;
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

const templates = await loadShippedTemplates();
const byId = new Map(templates.map((t) => [t.manifest.id, t]));
const ids = selectIds(templates);

if (!ids.length) {
  console.error("No template ids selected. COVERAGE is empty and VV_LOCK_IDS was not set.");
  process.exit(2);
}

console.log(`== ${ids.length} template(s) install from their shipped lock ==\n`);

const h = await bootSpikeKernel();
const results = [];

for (const id of ids) {
  const t = byId.get(id);
  const dir = `/c/${id}`;
  const rec = { id, checks: [], ok: false, secs: 0, imported: [] };
  results.push(rec);
  const fail = (why) => {
    rec.checks.push(`✗ ${why}`);
  };
  const t0 = Date.now();

  if (!t) {
    fail(`no such template in templates.ts`);
    console.log(`${id.padEnd(18)} FAIL — no such template`);
    continue;
  }
  const why = eligibility(t);
  if (why) {
    fail(`not eligible for an npm lock: ${why}`);
    console.log(`${id.padEnd(18)} FAIL — ${why}`);
    continue;
  }
  const lockPath = path.join(LOCK_DIR, `${id}.json`);
  if (!fs.existsSync(lockPath)) {
    // Installing from ranges here would be green and would prove nothing about
    // the file that ships, which is the exact shape of the bug this gate is
    // for. So a missing lock is a failure of the gate, not a skip.
    fail(`no generated lock at ${path.relative(ROOT, lockPath)} — run \`npm run vendor:locks -- ${id}\``);
    console.log(`${id.padEnd(18)} FAIL — no generated lock`);
    continue;
  }

  try {
    writeProject(h.kernel, dir, t.files);
    h.kernel.writeFile(`${dir}/package-lock.json`, fs.readFileSync(lockPath, "utf8"));

    // Install the way the template says it installs. For the Bun tab that is
    // `bun install`, which delegates to the same real npm CLI but goes through
    // the shim — and the shim is the thing that has to read the shipped lock.
    // Running npm directly here would gate a command no user types.
    const pm = String(t.manifest.install || "npm").trim().split(/\s+/)[0];
    let inst;
    if (pm === "bun") {
      h.loadRealNpm(); // the shim spawns `npm`, which has to be on PATH first
      inst = await h.kernel.start("bun", ["install"], { cwd: dir, env: defaultEnv(dir), capture: true });
      console.log(`  bun install exit=${inst.code}`);
    } else {
      inst = await npmInstall(h, { dir });
    }
    if (inst.code !== 0) fail(`${pm} install exited ${inst.code}`);

    const pkg = JSON.parse(t.files["package.json"]);
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const missingDeps = Object.keys(deps).filter((n) => !h.kernel.exists(`${dir}/node_modules/${n}/package.json`));
    if (missingDeps.length) {
      fail(`${missingDeps.length} direct dep(s) absent from node_modules: ${missingDeps.slice(0, 4).join(", ")}`);
    }

    const { tools, files } = devTools(t.manifest, pkg);
    const missingBins = tools.filter((b) => !h.kernel.exists(`${dir}/node_modules/.bin/${b}`));
    if (missingBins.length) fail(`dev command needs ${missingBins.join(", ")}, absent from node_modules/.bin`);
    // Only files the template SHIPS. express-ts's dev command is
    // `npm run build && node dist/index.js`, and dist/index.js is tsc's output —
    // asserting it exists after an install is asserting the build ran, which is
    // a different and much heavier gate than this one.
    const shipped = files.filter((f) => t.files[f.replace(/^\.\//, "")] !== undefined);
    const missingFiles = shipped.filter((f) => !h.kernel.exists(`${dir}/${f.replace(/^\.\//, "")}`));
    if (missingFiles.length) fail(`dev command runs ${missingFiles.join(", ")}, which did not reach the VM`);

    // A lock with an aliased entry has to IMPORT and BOOT, not just install.
    // This is the evidence behind resolving a wasm drop-in under a native name
    // at all, and it is what installing cannot show: `tailwind` satisfied every
    // check above with exit 0 and then failed to load its vite config, because
    // its lock pinned the real lightningcss and the VM has no binding for it.
    // The import runs first because it localises the failure — a dead dev
    // server names a config file, `require()` names the package.
    const aliased = aliasedEntries(fs.readFileSync(lockPath, "utf8"));
    for (const [name, want] of aliased) {
      const probe = `${dir}/vv-alias-probe-${name.replace(/\W/g, "_")}.cjs`;
      h.kernel.writeFile(probe, `require(${JSON.stringify(name)}); console.log("VV_ALIAS_OK");`);
      const r = await h.kernel.start("node", [probe], { cwd: dir, env: defaultEnv(dir), capture: true });
      if (!String(r.stdout || "").includes("VV_ALIAS_OK")) {
        fail(`lock aliases ${name} to ${want}, and requiring it in the VM failed: ${lastLine(r)}`);
        continue;
      }
      // …and that it is the drop-in that answered, not the native package the
      // alias exists to keep out.
      const got = JSON.parse(h.kernel.readFile(`${dir}/node_modules/${name}/package.json`)).name;
      if (got !== want) fail(`lock aliases ${name} to ${want}, but ${got} is what installed`);
      else rec.imported.push(`${name}=${want}`);
    }

    // `vite`, `astro dev`, `ng serve`, `nitro dev`, `node server.js`… — the
    // first token is either the interpreter or a binary the checks above have
    // already found in .bin, so this needs no per-template knowledge. The port
    // is forced because manifest.port is what the harness watches, and a
    // template whose default differs would otherwise read as "never bound".
    const boot = async () => {
      const toks = String((pkg.scripts || {}).dev || (pkg.scripts || {}).start || "").split(/\s+/).filter(Boolean);
      const argv =
        toks[0] === "node"
          ? [`${dir}/${toks[1]}`, ...toks.slice(2)]
          : [`${dir}/node_modules/.bin/${toks[0]}`, ...toks.slice(1), "--port", String(t.manifest.port), "--host"];
      let pid = -1;
      const bound = await waitListen(h, { dir, port: t.manifest.port, argv, onPid: (p) => (pid = p) });
      // Nearly all of these are Vite on 5173 and one kernel serves the whole
      // corpus, so the server has to go before the next template starts: left
      // running it would hold the port AND leave `h.listening` saying the next
      // template bound — a green result for a template that never started.
      if (pid > 0) h.kernel.stop(pid);
      h.listening.delete(t.manifest.port);
      return bound;
    };

    if (aliased.length && t.manifest.port) {
      if (await boot()) rec.booted = true;
      else fail(`installs, but its dev server never bound port ${t.manifest.port}`);
    }

    // And the alias has to survive the user's NEXT npm command. This is the
    // property the whole aliased-lock design rests on, and the one nothing else
    // here would notice breaking: the template's package.json never declares
    // the override — only the generated lock carries it — so npm is entitled to
    // decide the aliased position is not what the manifest asks for and
    // re-resolve it back to the native. That is the tailwind failure again,
    // arriving days after project creation and looking like a random breakage.
    //
    // Measured across `npm install <pkg>`, bare `npm install`, `npm ci` and
    // `npm update` on npm 10.9.2, it survives all four. The first three keep the
    // `name` marker outright. `npm update` rewrites the lock and DROPS the
    // markers, leaving each position keyed on the native name with the
    // drop-in's tarball still in `resolved` — which reads like the alias is
    // gone but is not, because `resolved` is what npm fetches and the marker is
    // only a label. Reinstalling from that rewritten lock still gets the
    // drop-in.
    //
    // That is a claim about Arborist's reconciliation rather than about
    // anything in this repo, so it is precisely the kind of property that is
    // true when measured and quietly stops being true — a new npm, or a
    // template that starts depending on one of these directly. One
    // representative id pays for keeping it honest: `tailwind`, because it is
    // the template that shipped broken and its lock aliases the silent member.
    if (id === SURVIVAL_ID && aliased.length) {
      const r = await h.kernel.start(
        "node",
        [VFS_NPM + "/bin/npm-cli.js", "install", SURVIVAL_ADD, "--no-audit", "--no-fund"],
        { cwd: dir, env: defaultEnv(dir), capture: true },
      );
      if (r.code !== 0) fail(`\`npm install ${SURVIVAL_ADD}\` after installing from the lock exited ${r.code}`);
      for (const [name, want] of aliased) {
        const got = JSON.parse(h.kernel.readFile(`${dir}/node_modules/${name}/package.json`)).name;
        if (got !== want) {
          fail(
            `after \`npm install ${SURVIVAL_ADD}\`, ${name} is ${got} rather than ${want} — a user's own npm ` +
              `command re-resolved the alias back to the native, which the shipped lock exists to prevent`,
          );
        }
      }
      if (t.manifest.port && !(await boot())) {
        fail(`boots from the shipped lock, but not after \`npm install ${SURVIVAL_ADD}\``);
      } else {
        rec.survived = true;
      }
    }

    rec.ok = rec.checks.length === 0;
    rec.detail =
      `${Object.keys(deps).length} deps, bins[${tools.join(",") || "none"}]` +
      `${rec.imported.length ? `, aliased[${rec.imported.join(" ")}]` : ""}${rec.booted ? ", booted" : ""}` +
      `${rec.survived ? `, survived npm install ${SURVIVAL_ADD}` : ""}`;
  } catch (e) {
    fail(`threw: ${(e && e.message) || e}`);
  } finally {
    rec.secs = (Date.now() - t0) / 1000;
    // 53 node_modules trees in a Wasm VFS is gigabytes. The in-VM npm cache
    // under /tmp/.npm is what makes the next install fast, and it stays.
    try {
      await h.kernel.start("rm", ["-rf", dir], { cwd: "/", capture: true });
    } catch {
      /* best effort */
    }
  }
  console.log(
    `${id.padEnd(18)} ${rec.ok ? "ok  " : "FAIL"} ${rec.secs.toFixed(0).padStart(4)}s  ${rec.ok ? rec.detail : rec.checks[0]}`,
  );
}

const passed = results.filter((r) => r.ok);
const failed = results.filter((r) => !r.ok);

console.log(`\n== ${passed.length}/${results.length} usable ==`);
for (const r of failed) {
  console.log(`  ${r.id}`);
  for (const c of r.checks) console.log(`      ${c}`);
}
// A copy/pasteable COVERAGE body, since widening the list is the reason to run
// this over anything other than COVERAGE itself.
if (process.env.VV_LOCK_IDS) {
  console.log(`\npassing ids:\n${passed.map((r) => `  "${r.id}",`).join("\n")}`);
}

process.exit(failed.length ? 1 : 0);