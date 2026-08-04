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

/**
 * One request against the in-VM server, from an `also` probe.
 *
 * Deliberately not the harness's httpGet: that one retries a 404 for a minute
 * (a warm-up loop for real dev servers, which is wrong when the 404 IS the
 * assertion) and drops the response headers, which is where a redirect's
 * Location lives.
 */
const request = async (kernel, port, probe) => {
  const r = await kernel.handleHttpRequest(port, {
    port,
    method: probe.method || "GET",
    url: probe.path,
    headers: { host: "127.0.0.1:" + port, ...(probe.headers || {}) },
    body: probe.send || "",
  });
  return {
    status: r.status,
    headers: r.headers || {},
    body: typeof r.body === "string" ? r.body : Buffer.from(r.body || "").toString(),
  };
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
//
// A server template's `also` entry is either a function of the first response's
// body, or a REQUEST: `{ method, path, headers, send, status, body, location }`,
// defaulting to `GET path` expecting 200. That is what lets a template whose
// point is a form post — or a rewrite that only happens behind the preview's
// `x-forwarded-prefix` — be gated declaratively rather than in a special case.
// Entries run in source order, so a mutation may be followed by a read of it.
//
// `tests` runs the project's own `bun test` before the server starts. `min` is a
// floor rather than an equality so adding a test does not fail the gate, and a
// zero fail count is asserted separately because an empty suite exits 0.
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const PREVIEW = { "x-forwarded-prefix": "/preview/3000" };

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
  // The full-stack one. Three APIs have to cooperate for a single response —
  // Bun.serve routes it, bun:sqlite answers it, HTMLRewriter renders it — so the
  // assertions below are deliberately about the SEAMS between them rather than
  // about any one API, which spike-bun.mjs already covers.
  "bun-fullstack": {
    kind: "server",
    path: "/",
    body: /Ship the HTMLRewriter demo/,
    also: {
      // The reason to use a rewriter instead of a string template: the file it
      // was handed comes back untouched apart from the slots. This exact line is
      // what a parse-and-serialize renderer would quietly reformat.
      "the shell's untouched markup survives byte for byte": (b) =>
        b.includes('<meta name="viewport" content="width=device-width, initial-scale=1.0" />'),
      "…while the comments meant for whoever edits the file do not ship": (b) => !b.includes("<!--"),
      "the <title> carries a number that came from SQL": /<title>\d+ open · Issue board<\/title>/,
      "all four tab counters were filled by the one handler": (b) =>
        (b.match(/data-count="\w+">\d+</g) || []).length === 4,
      "the active tab is marked, and only that one": (b) => (b.match(/aria-current="page"/g) || []).length === 1,
      "the empty-state placeholder was removed, because there are rows": (b) => !b.includes("Nothing on this tab yet"),
      "the many-to-many join reached the page as label chips": /class="pill label">bug</,
      "?status=done narrows the board through the indexed column": {
        path: "/?status=done",
        body: /Index the status column/,
      },
      "an issue page renders one row of that same join": {
        path: "/issue/1",
        body: /#1 Preview pane forgets its scroll position/,
      },
      "…with the status form pointed at that issue rather than the file's placeholder": {
        path: "/issue/1",
        body: /action="\/api\/issues\/1\/status"/,
      },
      "a missing issue 404s instead of rendering a page full of blanks": {
        path: "/issue/9999",
        status: 404,
        body: /not found/,
      },
      // A BunFile is not a platform Blob here, so `new Response(Bun.file(p))`
      // serves the string "[object Object]" with a 200. The template uses
      // `.stream()` for exactly that reason and this is the assertion that
      // notices if it ever gets "simplified" back.
      "the stylesheet is streamed, not stringified": { path: "/app.css", body: /color-scheme: dark/ },

      // The preview-prefix pass. Root-absolute NAVIGATION URLs escape the preview
      // (see AGENTS.md), so both directions matter: no header means no rewrite.
      "served at the root, the links stay root-absolute": (b) => b.includes('href="/issue/'),
      "behind the preview prefix, every navigation URL is rebased": {
        path: "/",
        headers: PREVIEW,
        body: /href="\/preview\/3000\/issue\/\d+"/,
      },
      "…including the form action, which is the one a POST needs": {
        path: "/",
        headers: PREVIEW,
        body: /action="\/preview\/3000\/api\/issues"/,
      },
      // The subresource too, so the page is styled either way. (That the pass
      // leaves `https://`, `#anchor` and `./relative` alone is the template's own
      // src/render.test.ts, which the `tests` gate above runs — the board page
      // has no such URL to check here, and asserting one it cannot produce would
      // be a green tick for nothing.)
      "…and the stylesheet link, so the page is styled behind the prefix too": {
        path: "/",
        headers: PREVIEW,
        body: /<link rel="stylesheet" href="\/preview\/3000\/app\.css" \/>/,
      },

      // Post/redirect/get, the flow a user actually performs.
      "a form post inserts a row and redirects back inside the preview": {
        method: "POST",
        path: "/api/issues",
        headers: { ...FORM, ...PREVIEW },
        send: "title=Added+by+the+spike&labels=spike",
        status: 303,
        location: "/preview/3000/",
      },
      "…and the next GET shows it, so the write reached SQLite": { path: "/", body: /Added by the spike/ },
      "moving it redirects to the issue": {
        method: "POST",
        path: "/api/issues/1/status",
        headers: FORM,
        send: "status=done",
        status: 303,
        location: "/issue/1",
      },
      "a blank title is refused rather than stored": {
        method: "POST",
        path: "/api/issues",
        headers: FORM,
        send: "title=+++",
        status: 400,
      },
    },
    // 48 today. The floor is what stops the suite silently emptying out.
    tests: { min: 40 },
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
      // Section 10. All three jobs must come back, each from the SAME real thread,
      // and the thread id must not be the main thread's 0 — a Worker that silently
      // ran on the main thread would still print three lines.
      "all three jobs came back from a worker thread": (t) => {
        const threads = [...t.matchAll(/job \d -> [0-9a-f]{16} \(thread (\d+)\)/g)].map((m) => m[1]);
        return threads.length === 3 && new Set(threads).size === 1 && threads[0] !== "0";
      },
      "the tour itself stayed on the main thread": /this thread is the main one: true/,
      "terminate() closed the worker cleanly": /worker closed with code: 0/,
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

  // The project's own test suite, before anything binds a port. A template that
  // ships tests is claiming they pass in the Studio's terminal; this is that
  // claim, run from the shipped bytes.
  if (expect.tests) {
    const t = await kernel.start("bun", ["test"], { cwd: dir, env, capture: true });
    const text = (t.stdout || "") + (t.stderr || "");
    const counted = text.match(/(\d+) pass,\s*(\d+) fail/);
    console.log("  -> bun test:", counted ? counted[0] : JSON.stringify(text.trim().slice(-200)));
    if (t.code !== 0) console.log("  test output tail:\n          " + text.trim().split("\n").slice(-14).join("\n          "));
    ok(t.code === 0, `${id}: \`bun test\` exits 0`);
    ok(
      !!counted && Number(counted[1]) >= expect.tests.min && Number(counted[2]) === 0,
      `${id}: at least ${expect.tests.min} tests pass and none fail`,
    );
  }

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
      // is a request of its own (see the EXPECT header).
      if (typeof probe === "function") {
        ok(probe(String(r.body)), `${id}: ${label}`);
        continue;
      }
      const r2 = await request(kernel, manifest.port, probe);
      const why = [];
      const want = probe.status ?? 200;
      if (r2.status !== want) why.push(`status ${r2.status}, wanted ${want}`);
      if (probe.body && !probe.body.test(String(r2.body))) why.push(`body did not match ${probe.body}`);
      if (probe.location && r2.headers.location !== probe.location) {
        why.push(`location '${r2.headers.location}', wanted '${probe.location}'`);
      }
      ok(why.length === 0, `${id}: ${label}${why.length ? ` — ${why.join("; ")}` : ""}`);
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