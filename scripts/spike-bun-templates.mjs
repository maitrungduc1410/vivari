// Every template in the studio's "Bun" tab, run from its SHIPPED bytes.
//
// scripts/spike-bun.mjs proves the Bun APIs against sources written inline in
// that spike. This one proves what a user actually gets: it reads
// packages/studio/src/vv/templates.ts, takes each Bun template's real file map
// and its real manifest, writes them into the Wasm VFS the way
// `vv-create-project` does, and runs the manifest's own `install` and `dev`
// commands. A template that stops booting fails here even when every API it uses
// is still green next door — which was the gap that left all four Bun templates
// sitting at `experimental: true` with nothing able to graduate them.
//
// The Bun CATEGORY is the input, not a list kept here, so a template added to
// that tab cannot skip this gate by not being registered. A template with no
// expectation below fails loudly rather than passing untested.
//
// No network: these templates are dependency-free by design, so `install` is a
// version check rather than a registry fetch. That is what makes them instant in
// the browser and runnable in this tier.

import { bootSpikeKernel, writeProject, httpGet } from "./lib/spike-harness.mjs";
import { readShippedManifests, readShippedTemplates } from "./lib/shipped-templates.mjs";
import fs from "node:fs";

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  \u2713 " : "  \u2717 ") + msg);
  if (!cond) failed++;
};

const { kernel, out, listening } = await bootSpikeKernel();

// bun:sqlite pulls its engine from VV_SQLITE_WASM_PATH here; in the browser the
// kernel sets VV_SQLITE_WASM_URL and the guest fetches the same bytes through the
// syscall bridge. Templates that never touch SQLite never read it.
const ENGINE_VFS_PATH = "/usr/lib/vivari/sqlite3.wasm";
const ENGINE_SRC = new URL("../packages/runtime/vendor/sqlite/sqlite3.wasm", import.meta.url);
const sqliteReady = fs.existsSync(ENGINE_SRC);
if (sqliteReady) {
  kernel.mkdirp("/usr/lib/vivari");
  kernel.writeFile(ENGINE_VFS_PATH, fs.readFileSync(ENGINE_SRC));
}

const manifests = await readShippedManifests();
const templates = await readShippedTemplates();
const BUN_IDS = Object.values(manifests).filter((m) => m.category === "Bun").map((m) => m.id);

// What each template must print (terminal) or serve (server) to count as alive.
// `also` is a second assertion: another path for a server, another marker for a
// terminal run — the point being to check the template's POINT, not just that a
// process exited 0. A `bun test` template that ran zero tests exits 0 too.
const EXPECT = {
  bun: { kind: "server", path: "/api/hello", body: /"runtime"\s*:\s*"bun"/, also: { "serves its HTML page": { path: "/", body: /<html|<!doctype/i } } },
  "bun-routes": { kind: "server", path: "/api/users/42", body: /42/ },
  // The WebSocket handshake and frame codec are covered by spike-bun.mjs; what is
  // template-specific here is that the page it serves is its own chat UI.
  "bun-ws": { kind: "server", path: "/", body: /new WebSocket|\/ws/ },
  // /app.js is app.tsx transpiled on the fly, so asserting it is JSX-free output
  // (not the .tsx source) is what proves the transpile step really ran.
  "bun-react": {
    kind: "server",
    path: "/app.js",
    body: /createElement|jsx/,
    also: {
      "the served JS is transpiled, not the raw TSX": (b) => !/:\s*CounterProps/.test(b),
      "and it serves the HTML shell": { path: "/", body: /<html|<!doctype/i },
    },
  },
  // `bun test` exits 0 on a suite that discovered NOTHING, so the pass count and
  // a zero fail count are both asserted — otherwise a template whose tests
  // stopped being found would sail through this gate.
  // The point of this one is PERSISTENCE, so the seeded rows are read back over
  // HTTP and the query plan is checked to confirm the index is really used.
  "bun-sqlite": {
    kind: "server",
    path: "/api/notes",
    body: /"Rows survive a reload"/,
    also: { "the planner uses the index we created": { path: "/api/notes", body: /notes_created_at|USING INDEX/i } },
  },
  "bun-shell": {
    kind: "terminal",
    stdout: /SHELL DEMO COMPLETE/,
    also: {
      "interpolation is escaped, so a spaced filename stays one argument": /written by Bun\.write/,
      // Section 2 says "capturing output instead of printing it", so the raw `ls`
      // listing must NOT appear — it did, because .text() echoed as well as
      // captured, and asserting on the processed line alone could not see it.
      "capturing really does capture: the raw listing is not echoed": (t) =>
        !/^package\.json$/m.test(t) && (t.match(/written by Bun\.write/g) || []).length === 1,
      "the pipeline really deduplicated": (t) => /unique, sorted: apple banana cherry/.test(t),
      "a failing command throws by default": /a failing command threw, as it should/,
      "…and .nothrow() reports the code instead": /with \.nothrow\(\) the exit code is [1-9]/,
      "per-command env is applied": /GREETING = set for one command/,
      ".cwd() actually changes directory": /pwd inside \.cwd\(\) = .*workspace\/nested/,
    },
  },
  "bun-build": {
    kind: "terminal",
    stdout: /BUILD DEMO COMPLETE/,
    also: {
      "the plugin saw the whole module graph": (t) => /modules the plugin saw: .*index\.ts/.test(t) && /greet\.ts/.test(t) && /inventory\.ts/.test(t),
      "define replaced BUILD_STAMP with a real timestamp": /built at: \d{4}-\d{2}-\d{2}T/,
      "a second build emitted one file per entry point": (t) => (t.match(/dist-lib\/\w+\.js/g) || []).length === 2,
      // The template teaches that these are refused rather than silently ignored,
      // so the spike checks they really are — this is the assertion that fails if
      // minify ever starts quietly no-op'ing.
      "minify/splitting/sourcemap are all refused": (t) =>
        (t.match(/: refused here, deliberately/g) || []).length === 3,
      "the emitted bundle ran": /parts: 3, units: 53/,
    },
  },
  "bun-apis": {
    kind: "terminal",
    stdout: /TOUR COMPLETE/,
    also: {
      "YAML parsed to real structure": /"service":"checkout"/,
      "TOML parsed to real structure": /"oncall":true/,
      "argon2id verifies the right password and rejects the wrong one": (t) =>
        /verify \(right password\): true/.test(t) && /verify \(wrong password\): false/.test(t),
      "Glob.scan walked the actual filesystem": /scan\('\.'\) :.*tour\.ts/,
      "stringWidth counts columns, not code units": /width of '日本語'  : 6/,
      "the transpiler reported the import graph": /"path":"node:fs\/promises"/,
    },
  },
  "bun-test": {
    kind: "terminal",
    stdout: /(\d+) pass, (\d+) fail/,
    also: {
      // Counted rather than pattern-matched: "0 pass, 0 fail" contains "0 fail"
      // and would satisfy a naive /0 fail/, which is exactly the empty-suite case
      // this is here to catch.
      "every test passed and none failed": (t) => {
        const m = t.match(/(\d+) pass, (\d+) fail/);
        return !!m && Number(m[1]) >= 12 && Number(m[2]) === 0;
      },
      "the parameterised cases each ran": /applies tax/,
      "the snapshot was written and matched": /serialises the way we expect/,
    },
  },
};

const runTemplate = async (id) => {
  const manifest = manifests[id];
  const files = templates[id];
  const expect = EXPECT[id];
  if (!manifest || !files || !Object.keys(files).length) {
    ok(false, `${id}: could not be read out of templates.ts (inline file literals only)`);
    return;
  }
  if (!expect) {
    ok(false, `${id}: is in the Bun tab but has no expectation in this spike — add one`);
    return;
  }

  const dir = "/tpl/" + id;
  kernel.mkdirp(dir);
  writeProject(kernel, dir, files);
  const env = {
    HOME: "/home/user",
    PATH: dir + "/node_modules/.bin:/bin",
    PWD: dir,
    ...(sqliteReady ? { VV_SQLITE_WASM_PATH: ENGINE_VFS_PATH } : {}),
  };

  console.log(`\n== ${id} — \`${manifest.install}\` then \`${manifest.dev}\` ==`);

  // `install` is deliberately NOT run: it needs the registry, and this tier is
  // offline. Skipping it is only sound because these templates depend on nothing
  // at RUNTIME — their package.json carries `@types/bun` and nothing else, which
  // exists to feed the editor's IntelliSense (the studio harvests
  // node_modules/**/*.d.ts) and is never imported. So `dev` is expected to work
  // on a project with no node_modules at all, which is also what a user who
  // unticks "Run init script" gets.
  //
  // That reasoning is asserted rather than assumed: the moment a Bun template
  // takes a real dependency, this fails and the skip has to be revisited.
  const pkg = JSON.parse(files["package.json"] || "{}");
  const runtimeDeps = Object.keys(pkg.dependencies || {});
  ok(
    runtimeDeps.length === 0,
    `${id}: has no runtime dependencies, so \`${manifest.dev}\` is expected to work uninstalled` +
      (runtimeDeps.length ? ` — found ${runtimeDeps.join(", ")}` : ""),
  );

  const [dcmd, ...dargs] = manifest.dev.split(" ");

  if (expect.kind === "terminal") {
    const r = await kernel.start(dcmd, dargs, { cwd: dir, env, capture: true });
    const text = (r.stdout || "") + (r.stderr || "");
    console.log("  ->", JSON.stringify(text.trim().slice(0, 240)));
    if (r.code !== 0) console.log("  stderr:\n          " + (r.stderr || "").trim().split("\n").slice(0, 8).join("\n          "));
    ok(r.code === 0, `${id}: \`${manifest.dev}\` exits 0`);
    ok(expect.stdout.test(text), `${id}: prints what the template is for (${expect.stdout})`);
    for (const [label, probe] of Object.entries(expect.also || {})) {
      ok(typeof probe === "function" ? probe(text) : probe.test(text), `${id}: ${label}`);
    }
    return;
  }

  // A server template: boot it, hit it, then stop it — every Bun template binds
  // the same port, so leaving one running would make the next one's assertions
  // pass against the WRONG server.
  const before = new Set(kernel.procs.keys());
  listening.delete(manifest.port);
  kernel.start(dcmd, dargs, { cwd: dir, env }).catch(() => {});
  const started = Date.now();
  while (!listening.has(manifest.port) && Date.now() - started < 30000) await new Promise((r) => setTimeout(r, 100));

  if (!listening.has(manifest.port)) {
    ok(false, `${id}: \`${manifest.dev}\` never bound :${manifest.port}`);
    console.log("  output tail:\n          " + out.join("").trim().slice(-1200).split("\n").join("\n          "));
  } else {
    const r = await httpGet(kernel, manifest.port, expect.path);
    console.log("  ->", expect.path, r.status, JSON.stringify(String(r.body).slice(0, 140)));
    ok(r.status === 200, `${id}: GET ${expect.path} is 200`);
    ok(expect.body.test(String(r.body)), `${id}: the response is this template's own`);
    for (const [label, probe] of Object.entries(expect.also || {})) {
      // A function asserts something about the response already fetched; an object
      // is a second request to a different path.
      if (typeof probe === "function") {
        ok(probe(String(r.body)), `${id}: ${label}`);
        continue;
      }
      const r2 = await httpGet(kernel, manifest.port, probe.path);
      ok(r2.status === 200 && probe.body.test(String(r2.body)), `${id}: ${label}`);
    }
  }
  for (const pid of kernel.procs.keys()) if (!before.has(pid)) kernel.stop(pid);
  await new Promise((r) => setTimeout(r, 150));
};

console.log(`\n== the Bun tab ships ${BUN_IDS.length} templates ==`);
console.log("  ->", BUN_IDS.join(", "));
ok(BUN_IDS.length >= 4, "the Bun category is populated (the reader still understands templates.ts)");
if (!sqliteReady) ok(false, "packages/runtime/vendor/sqlite/sqlite3.wasm is missing — restore it with git or `node scripts/vendor-sqlite.mjs --refresh`");

for (const id of BUN_IDS) await runTemplate(id);

console.log(failed ? `\nFAIL: ${failed} check(s) failed` : "\nOK: every Bun template boots from its shipped bytes");
process.exit(failed ? 1 : 0);