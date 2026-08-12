// Measure what a user actually waits for: navigation → kernel → installed →
// preview painted, and the wire bytes each of those phases costs.
//
// Everything else in scripts/ measures the kernel under Node, where none of this
// is visible: the cold path is a browser download problem (five serial round
// trips before the first Wasm byte is requested), the install is a browser
// network problem (npm's metadata dwarfs its tarballs), and both are invisible
// to a headless harness that imports the kernel directly.
//
// It also exists as a regression gate for a specific failure mode. Two assets
// the kernel fetches — `vendor/depcache/index.json` and `vendor/sqlite/
// sqlite3.wasm` — have been absent from production while the SPA fallback
// answered `200 text/html`, so the consuming code's `catch` disabled the feature
// in silence. Nothing measured stage timings, so nobody noticed. `--assert`
// turns the numbers into a pass/fail so the next such regression is loud.
//
// Usage — build and serve the studio first, then point this at it:
//   (cd packages/studio && npx vite build && npx vite preview --port 4173) &
//   VV_CHROME=/path/to/chrome node scripts/measure-studio-boot.mjs
//
// Compare two runs:
//   node scripts/measure-studio-boot.mjs --json before.json
//   …change something, rebuild…
//   node scripts/measure-studio-boot.mjs --json after.json --baseline before.json
//
// Flags:
//   --mode boot|full   boot = cold load only (fast, ~20s). full = also create a
//                      project and wait for its preview. Default: full.
//   --template <name>  Template name to create. Default: React.
//   --language <lang>  Disambiguates same-named templates. Default: TypeScript.
//   --warm             Reload once after the cold pass and report both.
//   --json <file>      Write the full report as JSON.
//   --baseline <file>  Print a delta table against a previous --json report.
//   --assert           Exit non-zero if any expected asset 404s or answers HTML.
//   --runs <n>         Repeat and report the median. Default: 1.
//
// env: VV_CHROME, STUDIO_URL (or --url; default http://127.0.0.1:4173/), WORK_DIR,
//   TIMEOUT_MS (default 300000 for the full mode).
import { spawn } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf("--" + name);
  return i === -1 ? fallback : args[i + 1];
};
const has = (name) => args.includes("--" + name);

// A mistyped flag must not silently measure the default URL for 60s and then
// report a timeout as if the app were broken.
const VALUED = ["mode", "template", "language", "runs", "json", "baseline", "url"];
const BOOLEAN = ["assert", "warm"];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (!a.startsWith("--")) continue;
  const name = a.slice(2);
  if (VALUED.includes(name)) i++;
  else if (!BOOLEAN.includes(name)) {
    console.error(`unknown flag ${a}\n  valued: ${VALUED.map((n) => "--" + n).join(" ")}\n  boolean: ${BOOLEAN.map((n) => "--" + n).join(" ")}`);
    process.exit(2);
  }
}

const MODE = flag("mode", "full");
const TEMPLATE = flag("template", "React");
const LANGUAGE = flag("language", "TypeScript");
const RUNS = Number(flag("runs", "1"));
const JSON_OUT = flag("json");
const BASELINE = flag("baseline");
const ASSERT = has("assert");
const WARM = has("warm");
const STUDIO_URL = flag("url") || process.env.STUDIO_URL || "http://127.0.0.1:4173/";
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || (MODE === "full" ? 300000 : 60000));
const WORK = process.env.WORK_DIR || "/tmp/vv-measure";

// Discovered, not pinned: puppeteer's cache path carries the Chrome version, so
// hardcoding one breaks the moment the cache is repopulated. Same lookup as
// scripts/repro-starlight-browser.mjs.
const CHROME = process.env.VV_CHROME || (() => {
  const base = "/root/.cache/puppeteer/chrome";
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).sort() : [];
  for (const d of dirs.reverse()) {
    const c = `${base}/${d}/chrome-linux64/chrome`;
    if (fs.existsSync(c)) return c;
  }
  return "chrome";
})();

// Assets the kernel fetches at runtime whose absence does not raise anything.
// Each entry says what a healthy response looks like, because the failure being
// guarded is a 200 with the landing page's HTML in it — a status check alone
// reads that as success. `optional` covers what a given build may legitimately
// not ship (the depcache producer is opt-in); those are reported, never fatal.
const KERNEL_ASSETS = [
  { path: "vendor/npm-pack.bin", type: "application/octet-stream" },
  { path: "vendor/sqlite/sqlite3.wasm", type: "application/wasm" },
  { path: "vendor/depcache/index.json", type: "application/json", optional: true },
  { path: "vendor/locks/index.json", type: "application/json", optional: true },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── CDP plumbing ─────────────────────────────────────────────────────────────

async function launchChrome(profile) {
  fs.rmSync(profile, { recursive: true, force: true });
  fs.mkdirSync(profile, { recursive: true });
  const flags = [
    "--headless=new",
    "--remote-debugging-port=0", // let Chrome pick; a bound fixed port starts it WITHOUT an endpoint
    "--no-sandbox",
    "--user-data-dir=" + profile,
    "about:blank",
  ];
  const chrome = spawn(CHROME, flags, { stdio: ["ignore", "ignore", "pipe"] });
  const stderr = [];
  chrome.stderr.on("data", (d) => stderr.push(d.toString()));
  let wsUrl = "";
  for (let i = 0; i < 80 && !wsUrl; i++) {
    await sleep(250);
    try {
      const [port] = fs.readFileSync(profile + "/DevToolsActivePort", "utf8").split("\n");
      wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl;
    } catch { /* not up yet */ }
  }
  if (!wsUrl) {
    chrome.kill("SIGKILL");
    throw new Error("no CDP endpoint — chrome stderr:\n" + stderr.join("").slice(-1200));
  }
  return { chrome, wsUrl };
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", () => rej(new Error("CDP socket failed")), { once: true });
  });
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(JSON.stringify(m.error)));
      else p.resolve(m.result);
    } else for (const l of listeners) l(m);
  });
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      pending.set(i, { resolve, reject });
      ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return { ws, send, listeners };
}

// ── phase classification ─────────────────────────────────────────────────────

// One request, one bucket. The split that matters is packument-vs-tarball: they
// are the same host and the same verb, and the whole install story is that the
// first dwarfs the second.
function classify(url, origin) {
  if (url.startsWith("data:") || url.startsWith("blob:")) return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.host === "registry.npmjs.org" || /(^|\.)npmjs\.(org|com)$/.test(u.host)) {
    return u.pathname.includes("/-/") ? "tarball" : "packument";
  }
  if (u.origin !== origin) return "third-party";
  if (u.pathname.includes("/vendor/")) return "vendor";
  if (u.pathname.endsWith(".wasm")) return "wasm";
  if (/(^|\/)(monaco|editor\.)|monaco-editor/.test(u.pathname)) return "monaco";
  return "app";
}

// ── one measured pass ────────────────────────────────────────────────────────

async function measureOnce({ send, listeners }, { warm }) {
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send("Network.enable", {}, sessionId);
  // Registry traffic is issued by the Fetcher Worker and the worker bundles are
  // fetched by the kernel worker, so their Network events arrive on the WORKER's
  // session, not the page's. Without this the install looks like it downloads
  // nothing at all.
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);

  const origin = new URL(STUDIO_URL).origin;
  const reqs = new Map(); // sessionId|requestId -> record
  const finished = [];
  const workerSessions = new Set();

  const onEvent = (m) => {
    if (m.method === "Target.attachedToTarget") {
      const wsid = m.params.sessionId;
      workerSessions.add(wsid);
      // Best-effort: a target can die between attach and enable.
      send("Network.enable", {}, wsid).catch(() => {});
      send("Runtime.runIfWaitingForDebugger", {}, wsid).catch(() => {});
      return;
    }
    const sid = m.sessionId;
    if (sid !== sessionId && !workerSessions.has(sid)) return;
    const p = m.params;
    if (m.method === "Network.requestWillBeSent") {
      reqs.set(sid + "|" + p.requestId, {
        url: p.request.url,
        startWall: p.wallTime * 1000,
        bytes: 0,
        status: 0,
        mime: "",
        fromCache: false,
      });
    } else if (m.method === "Network.responseReceived") {
      const r = reqs.get(sid + "|" + p.requestId);
      if (r) {
        r.status = p.response.status;
        r.mime = p.response.mimeType || "";
        r.fromCache = !!p.response.fromDiskCache || !!p.response.fromPrefetchCache;
      }
    } else if (m.method === "Network.requestServedFromCache") {
      // The memory cache never fires responseReceived with fromDiskCache, and
      // it still reports the full encodedDataLength — counting those as network
      // bytes turns a working cache into a fake regression.
      const r = reqs.get(sid + "|" + p.requestId);
      if (r) r.fromCache = true;
    } else if (m.method === "Network.loadingFinished") {
      const r = reqs.get(sid + "|" + p.requestId);
      if (!r) return;
      r.bytes = p.encodedDataLength || 0;
      r.endWall = r.startWall + 0; // placeholder; wall end derived below from now()
      r.doneAt = Date.now();
      r.phase = classify(r.url, origin);
      finished.push(r);
    }
  };
  listeners.push(onEvent);

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "evaluate failed");
    return r.result.value;
  };
  const click = (text, exact = false) =>
    evaluate(`(() => {
      const els = [...document.querySelectorAll('button,[role=button],a,[role=tab]')];
      const n = ${JSON.stringify(text)};
      const hit = els.find((e) => { const s = (e.innerText || '').trim(); return ${exact} ? s === n : s.includes(n); });
      if (!hit) return "NOTFOUND";
      hit.click();
      return "OK";
    })()`);

  const t0 = Date.now();
  await send("Page.navigate", { url: STUDIO_URL }, sessionId);

  // `window.__vvBoot` (packages/studio/src/vv/boot-marks.ts) is the app telling
  // us where it is. The fallback below keeps this harness usable against a build
  // that predates the marker — the live deploy, or a `git archive` of an older
  // commit for a before/after — but it is strictly worse and only ever a
  // fallback: it can say "ready" and "a preview exists", not *when*, and it
  // reads UI state that is free to change.
  //
  // It reads `aria-disabled` on the Home import card, which is bound to
  // `snap.kernelReady`. The obvious alternative — grepping body.innerText for
  // the boot console's "Kernel ready." — does not work and is worth recording:
  // that console is not mounted on Home, and Home's boot banner is *kept*
  // mounted and collapsed to `grid-rows-[0fr]` after boot, so its "Starting
  // runtime…" stays in innerText forever. A studio that booted in 536 ms read
  // as a hang for the full 60 s timeout.
  const readMarks = () => evaluate(`(() => {
    const card = [...document.querySelectorAll('button')].find((b) => (b.innerText || '').includes('Import a folder'));
    const frame = [...document.querySelectorAll('iframe')].find((f) => /\\/preview\\/\\d+/.test(f.src || ''));
    return JSON.stringify({
      marks: window.__vvBoot || null,
      origin: performance.timeOrigin,
      legacyReady: card ? card.getAttribute('aria-disabled') !== 'true' : false,
      legacyPreview: !!frame,
    });
  })()`);

  // `observedAt` is the poll that first saw the condition: only meaningful for
  // an un-instrumented build, and only to ±the poll interval. An instrumented
  // build always prefers its own marks.
  const waitFor = async (pred, limitMs, label) => {
    const until = Date.now() + limitMs;
    while (Date.now() < until) {
      const state = JSON.parse(await readMarks());
      if (pred(state)) return { ...state, observedAt: Date.now() };
      await sleep(250);
    }
    throw new Error(`timed out after ${limitMs}ms waiting for ${label}`);
  };

  const hasMark = (s, name) => !!s.marks?.some((m) => m.name === name);
  const kernelState = await waitFor(
    (s) => hasMark(s, "kernel-online") || s.legacyReady,
    Math.min(TIMEOUT_MS, 90000),
    "the kernel to come online",
  );
  const instrumented = !!kernelState.marks;

  let created = false;
  if (MODE === "full") {
    // Drive the picker the way a user does. Clicking rather than calling into
    // `window.__ide` on purpose: that handle is dev-only, so a UI-driven pass is
    // the only one that can also be pointed at a production deploy.
    if ((await click("Start from template")) !== "OK") throw new Error("no 'Start from template' card");
    await sleep(1200);
    // Same-named templates differ only by language (React ships JS and TS), so
    // match on both — picking by name alone silently measured the wrong one.
    const picked = await evaluate(`(() => {
      const btns = [...document.querySelectorAll('button')];
      const hit = btns.find((b) => {
        const s = (b.innerText || '');
        return s.includes(${JSON.stringify(TEMPLATE)}) && s.includes(${JSON.stringify(LANGUAGE)});
      });
      if (!hit) return "NOTFOUND";
      hit.click();
      return "OK";
    })()`);
    if (picked !== "OK") throw new Error(`template ${TEMPLATE}/${LANGUAGE} not in the picker`);
    await sleep(600);
    if ((await click("Create", true)) !== "OK") throw new Error("no enabled 'Create' button");
    created = true;
  }

  const final = created
    ? await waitFor((s) => hasMark(s, "preview-paint") || (!s.marks && s.legacyPreview), TIMEOUT_MS, "the preview to paint")
    : kernelState;

  // Give in-flight requests a moment to report loadingFinished before we total.
  await sleep(500);
  const marks = final.marks || [];
  const markAt = (name, observed = null) => {
    const m = marks.find((x) => x.name === name);
    if (m) return Math.round(final.origin + m.t - t0);
    return observed == null ? null : Math.round(observed - t0);
  };

  const rel = (wall) => Math.round(wall - t0);
  // Resolve this once: on the legacy path markAt("kernel-online") is null, and a
  // null cutoff silently turned "the cold path" into "every byte of the run".
  const kernelOnlineAt = markAt("kernel-online", kernelState.observedAt);
  const byPhase = {};
  for (const r of finished) {
    if (!r.phase) continue;
    const b = (byPhase[r.phase] ??= { requests: 0, bytes: 0, cached: 0, firstAt: Infinity, lastAt: 0 });
    b.requests++;
    if (r.fromCache) b.cached++;
    else b.bytes += r.bytes;
    b.firstAt = Math.min(b.firstAt, rel(r.startWall));
    b.lastAt = Math.max(b.lastAt, r.doneAt - t0);
  }
  for (const b of Object.values(byPhase)) if (b.firstAt === Infinity) b.firstAt = null;

  const result = {
    warm: !!warm,
    instrumented,
    timeline: {
      navStart: 0,
      jsExecuted: markAt("js-executed"),
      kernelOnline: kernelOnlineAt,
      kernelReady: markAt("kernel-ready"),
      installStart: markAt("install-start"),
      firstPackument: byPhase.packument?.firstAt ?? null,
      lastPackument: byPhase.packument?.lastAt ?? null,
      lastTarball: byPhase.tarball?.lastAt ?? null,
      previewOpen: markAt("preview-open"),
      previewPaint: markAt("preview-paint", created ? final.observedAt : null),
    },
    bytes: Object.fromEntries(
      Object.entries(byPhase).map(([k, v]) => [k, { requests: v.requests, bytes: v.bytes, cached: v.cached }]),
    ),
    totalBytes: finished.reduce((a, r) => a + (r.fromCache ? 0 : r.bytes), 0),
    totalRequests: finished.length,
    // The cold path is what the app costs before it can do anything: everything
    // fetched up to kernel-online, registry traffic excluded by construction.
    coldPathBytes: finished
      .filter((r) => r.phase && r.phase !== "packument" && r.phase !== "tarball" && r.doneAt - t0 <= (kernelOnlineAt ?? Infinity))
      .reduce((a, r) => a + (r.fromCache ? 0 : r.bytes), 0),
    // Per-request detail only in --json: a totals table hides the failure this
    // catches, which is the same URL fetched twice (a preload hint the real
    // consumer did not reuse).
    requests: finished
      .filter((r) => r.phase)
      .map((r) => ({ url: r.url, phase: r.phase, bytes: r.bytes, cached: r.fromCache, at: rel(r.startWall) }))
      .sort((a, b) => a.at - b.at),
  };

  listeners.splice(listeners.indexOf(onEvent), 1);
  await send("Target.closeTarget", { targetId }).catch(() => {});
  return result;
}

// ── asset assertion ──────────────────────────────────────────────────────────

// A 200 carrying the SPA fallback is the failure mode, not a 404, so check the
// content type and reject HTML for anything that is not meant to be HTML.
async function checkAssets(base) {
  const out = [];
  for (const a of KERNEL_ASSETS) {
    const url = new URL(a.path, base).href;
    let ok = false;
    let note;
    try {
      const res = await fetch(url);
      const ct = (res.headers.get("content-type") || "").split(";")[0].trim();
      if (!res.ok) note = `HTTP ${res.status}`;
      else if (ct === "text/html" && a.type !== "text/html") note = `${res.status} but content-type ${ct} (SPA fallback)`;
      else { ok = true; note = `${res.status} ${ct}`; }
    } catch (err) {
      note = "fetch failed: " + err.message;
    }
    out.push({ ...a, url, ok, note });
  }
  return out;
}

// ── reporting ────────────────────────────────────────────────────────────────

const mib = (n) => (n / 1048576).toFixed(2) + " MiB";
const ms = (n) => (n == null ? "—" : n >= 1000 ? (n / 1000).toFixed(2) + " s" : n + " ms");

function printRun(r) {
  const t = r.timeline;
  console.log(`\n  ${r.warm ? "WARM RELOAD" : "COLD LOAD"}${r.instrumented ? "" : "  (no __vvBoot marker — legacy scrape)"}`);
  const rows = [
    ["js executed", t.jsExecuted],
    ["kernel online", t.kernelOnline],
    ["kernel ready", t.kernelReady],
    ["install started", t.installStart],
    ["first packument", t.firstPackument],
    ["last packument", t.lastPackument],
    ["last tarball", t.lastTarball],
    ["preview opened", t.previewOpen],
    ["preview painted", t.previewPaint],
  ];
  for (const [label, v] of rows) console.log(`    ${label.padEnd(18)} ${ms(v).padStart(9)}`);
  console.log(`    ${"—".repeat(28)}`);
  for (const [phase, v] of Object.entries(r.bytes).sort((a, b) => b[1].bytes - a[1].bytes))
    console.log(
      `    ${phase.padEnd(18)} ${mib(v.bytes).padStart(9)}  ${String(v.requests).padStart(4)} req` +
        (v.cached ? `  (${v.cached} from cache)` : ""),
    );
  console.log(`    ${"cold path".padEnd(18)} ${mib(r.coldPathBytes).padStart(9)}`);
  console.log(`    ${"total".padEnd(18)} ${mib(r.totalBytes).padStart(9)}  ${String(r.totalRequests).padStart(4)} req`);
}

function printDelta(now, before) {
  console.log("\n  DELTA vs baseline");
  const d = (label, a, b, fmt) => {
    if (a == null || b == null) return;
    const diff = a - b;
    const pct = b ? ((diff / b) * 100).toFixed(1) : "—";
    console.log(`    ${label.padEnd(18)} ${fmt(b).padStart(9)} → ${fmt(a).padStart(9)}  ${diff >= 0 ? "+" : ""}${fmt(diff)} (${diff >= 0 ? "+" : ""}${pct}%)`);
  };
  d("kernel online", now.timeline.kernelOnline, before.timeline.kernelOnline, ms);
  d("preview painted", now.timeline.previewPaint, before.timeline.previewPaint, ms);
  d("cold path", now.coldPathBytes, before.coldPathBytes, mib);
  d("total bytes", now.totalBytes, before.totalBytes, mib);
  for (const phase of new Set([...Object.keys(now.bytes), ...Object.keys(before.bytes)]))
    d(phase, now.bytes[phase]?.bytes ?? 0, before.bytes[phase]?.bytes ?? 0, mib);
}

// ── main ─────────────────────────────────────────────────────────────────────

const assets = await checkAssets(STUDIO_URL);
console.log(`\nkernel-fetchable assets at ${STUDIO_URL}`);
for (const a of assets)
  console.log(`  ${a.ok ? "\u2713" : a.optional ? "\u25cb" : "\u2717"} ${a.path.padEnd(32)} ${a.note}`);
const assetFailures = assets.filter((a) => !a.ok && !a.optional);

const runs = [];
for (let i = 0; i < RUNS; i++) {
  const { chrome, wsUrl } = await launchChrome(`${WORK}/profile-${i}`);
  const cdp = await connect(wsUrl);
  try {
    await cdp.send("Target.setDiscoverTargets", { discover: true });
    runs.push(await measureOnce(cdp, { warm: false }));
    if (WARM) runs.push(await measureOnce(cdp, { warm: true }));
  } finally {
    cdp.ws.close();
    chrome.kill("SIGKILL");
  }
}

console.log(`\n${STUDIO_URL} · mode=${MODE}${MODE === "full" ? ` · ${TEMPLATE}/${LANGUAGE}` : ""} · ${RUNS} run(s)`);
for (const r of runs) printRun(r);

// The median run, not the mean: one GC pause or one slow registry response
// should not move the number a change is judged by.
const cold = runs.filter((r) => !r.warm);
const median = cold.slice().sort((a, b) => (a.timeline.previewPaint ?? a.timeline.kernelOnline) - (b.timeline.previewPaint ?? b.timeline.kernelOnline))[Math.floor(cold.length / 2)];

if (BASELINE) {
  const before = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  printDelta(median, before.median);
}

const report = { url: STUDIO_URL, mode: MODE, template: TEMPLATE, language: LANGUAGE, at: new Date().toISOString(), assets, runs, median };
if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}

if (ASSERT && assetFailures.length) {
  console.error(`\n\u2717 ${assetFailures.length} required kernel asset(s) missing or serving HTML`);
  process.exit(1);
}
console.log();
