// Drives a REAL Chrome over CDP through the studio UI — pick a template, press Create, then
// watch a cold install the way a user experiences it. Everything else in scripts/ runs the
// kernel under Node, and this exists because a whole class of defect is invisible there:
// `worker.onerror` has no Node equivalent, and the studio's own boot path (shared loader, PATH
// shims, service worker) only assembles in a browser. spike-starlight and
// spike-starlight-studio both PASS while this fails.
//
// What it found, and what it is for: Starlight's `astro dev` throws ~113 uncaught
// `SyntaxError: "[object Object]" is not valid JSON` from its process worker every run
// (Rspress: zero). A browser Worker survives an uncaught error, so those are invisible until
// something treats `worker.onerror` as worker death — at which point the first one kills the
// dev server and the studio spins forever with an empty terminal. Measured here as 0/4 runs
// binding versus 9/9 without such a change. Run this before and after any change to worker
// error handling, and after any change to this template's dependency set.
//
// Two negative results worth not re-deriving: an incognito browser context (Target.
// createBrowserContext, since headless Chrome ignores --incognito) is INDISTINGUISHABLE from a
// fresh profile on time-to-listening, so memory-backed OPFS is not the trigger; and no setting
// of MEM_MB reproduces a lone worker dying — below ~1.6 GB the kernel SIGKILLs the whole
// renderer instead, which is Chrome's crash page rather than a frozen terminal.
//
// Not in run-spikes.mjs on purpose: it needs a Chrome binary and a served studio build, which
// the spike tiers do not assume. Run it by hand.
//
// Usage — build and serve the studio first, then:
//   (cd packages/studio && npx vite build && npx vite preview --port 4173) &
//   VV_CHROME=/path/to/chrome node scripts/repro-starlight-browser.mjs
//
// env: VV_CHROME (required unless the puppeteer cache path below exists), STUDIO_URL,
//   VV_TEMPLATE (default Starlight), WORK_DIR, TAG, PORT, WATCH_MS, POST_LISTEN_MS,
//   INCOGNITO=0 for a normal-profile control, CPUS (taskset pinning, e.g. 0-3),
//   MEM_MB (cgroup v1 ceiling on the whole Chrome tree), HEAP_MB (V8 --max-old-space-size),
//   CDP_PORT (default 0 = let Chrome choose), SECOND_PROJECT=1 (measure a depcache restore),
//   RESTORE_VIA_TERMINAL=1 (measure it by retyping the install instead of making a project),
//   PAUSE_ON_EXC=1 (break on uncaught worker exceptions to read a live stack).
import { spawn } from "node:child_process";
import fs from "node:fs";

// Discovered, not pinned: puppeteer's cache path carries the Chrome version, so hardcoding one
// breaks the moment the cache is repopulated.
const CHROME = process.env.VV_CHROME || (() => {
  const base = "/root/.cache/puppeteer/chrome";
  const dirs = fs.existsSync(base) ? fs.readdirSync(base).sort() : [];
  for (const d of dirs.reverse()) {
    const c = `${base}/${d}/chrome-linux64/chrome`;
    if (fs.existsSync(c)) return c;
  }
  return "chrome";
})();
const STUDIO_URL = process.env.STUDIO_URL || "http://127.0.0.1:4173/";
// Profiles and transcripts land here; each run wipes its own profile so "cold" means cold.
const WORK = process.env.WORK_DIR || "/tmp/vv-repro";
fs.mkdirSync(WORK, { recursive: true });
const TEMPLATE = process.env.VV_TEMPLATE || "Starlight";
// 0 = let Chrome pick, then read the real port out of the profile's DevToolsActivePort. A fixed
// port is a liability: anything already bound (a sandbox helper, a previous run that did not die)
// makes Chrome start WITHOUT a debugging endpoint, which looks identical to Chrome not starting.
const PORT = Number(process.env.CDP_PORT || 0);
const WATCH_MS = Number(process.env.WATCH_MS || 1800000);
const INCOGNITO = process.env.INCOGNITO !== "0";
const TAG = process.env.TAG || (INCOGNITO ? "incognito" : "normal");
const PROFILE = WORK + "/profile-" + TAG;
fs.rmSync(PROFILE, { recursive: true, force: true });

const flags = ["--headless=new", "--remote-debugging-port=" + PORT, "--no-sandbox", "--user-data-dir=" + PROFILE];
if (process.env.EXTRA_FLAGS) flags.push(...process.env.EXTRA_FLAGS.split(" ").filter(Boolean));
console.log(`rig: TAG=${TAG} incognito=${INCOGNITO}`);
console.log("chrome: " + CHROME);
console.log("chrome flags: " + flags.join(" "));
// CPUS=0-3 pins chrome to a few cores. This host has 384; a user laptop has 4-8, and the
// incognito slowdown is CPU/memcpy-bound, so core count is the closest lever to their hardware.
const CPUS = process.env.CPUS || "";
// MEM_MB caps the whole chrome process tree via a cgroup, which is the only lever that makes
// incognito's memory-backed OPFS actually hurt: on a host with plenty of RAM, holding the OPFS
// mirror in memory costs nothing, so the user's machine cannot be emulated by incognito alone.
// HEAP_MB caps every V8 isolate, matching the 128 MB worker heap measured on the runtime side.
const MEM_MB = process.env.MEM_MB || "";
const HEAP_MB = process.env.HEAP_MB || "";
const CG = "/sys/fs/cgroup/memory/slrig";
if (HEAP_MB) flags.push(`--js-flags=--max-old-space-size=${HEAP_MB}`);
if (MEM_MB) {
  fs.mkdirSync(CG, { recursive: true });
  fs.writeFileSync(CG + "/memory.limit_in_bytes", String(Number(MEM_MB) * 1024 * 1024));
  try { fs.writeFileSync(CG + "/memory.failcnt", "0"); } catch {}
  try { fs.writeFileSync(CG + "/memory.max_usage_in_bytes", "0"); } catch {}
  console.log(`memory cgroup: ${MEM_MB}MB` + (HEAP_MB ? `, v8 heap cap ${HEAP_MB}MB` : ""));
}
if (CPUS) console.log("pinned to cores: " + CPUS);
// Joining the cgroup in the child before exec means every chrome subprocess inherits the limit.
const inner = (MEM_MB ? `echo $$ > ${CG}/cgroup.procs; ` : "") +
  (CPUS ? `exec taskset -c ${CPUS} ` : "exec ") +
  [CHROME, ...flags, "about:blank"].map((a) => `'${a}'`).join(" ");
const chrome = spawn("sh", ["-c", inner], { stdio: ["ignore", "ignore", "pipe"] });
const cgStat = () => {
  if (!MEM_MB) return "";
  try {
    const peak = Math.round(Number(fs.readFileSync(CG + "/memory.max_usage_in_bytes", "utf8")) / 1048576);
    const fail = Number(fs.readFileSync(CG + "/memory.failcnt", "utf8").trim());
    const oom = (fs.readFileSync(CG + "/memory.oom_control", "utf8").match(/oom_kill (\d+)/) || ["", "?"])[1];
    return ` cg=peak${peak}MB/fail${fail}/oomkill${oom}`;
  } catch { return " cg=?"; }
};
const chromeErr = [];
chrome.stderr.on("data", (d) => {
  const s = d.toString();
  chromeErr.push(s);
  if (/OOM|out of memory|Fatal|crashed|Killed/i.test(s)) console.log("[chrome!] " + s.trim().slice(0, 300));
});

let wsUrl = "";
for (let i = 0; i < 80 && !wsUrl; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try {
    const [livePort] = fs.readFileSync(PROFILE + "/DevToolsActivePort", "utf8").split("\n");
    wsUrl = (await (await fetch(`http://127.0.0.1:${livePort}/json/version`)).json()).webSocketDebuggerUrl;
  } catch { /* not up yet */ }
}
if (!wsUrl) {
  console.log("no CDP endpoint — chrome stderr:\n" + chromeErr.join("").slice(-1500));
  process.exit(2);
}
const ws = new WebSocket(wsUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
const listeners = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    if (m.error) p.reject(new Error(JSON.stringify(m.error)));
    else p.resolve(m.result);
  } else for (const l of listeners) l(m);
});
const send = (method, params = {}, s) => new Promise((res, rej) => {
  const i = ++id; pending.set(i, { resolve: res, reject: rej });
  ws.send(JSON.stringify({ id: i, method, params, ...(s ? { sessionId: s } : {}) }));
});

await send("Target.setDiscoverTargets", { discover: true });
// The incognito context: memory-backed OPFS + reduced quota, the variable under test.
let browserContextId;
if (INCOGNITO) {
  const ctx = await send("Target.createBrowserContext", { disposeOnDetach: false });
  browserContextId = ctx.browserContextId;
  console.log("created incognito browser context " + browserContextId);
}
const { targetId } = await send("Target.createTarget", { url: "about:blank", ...(browserContextId ? { browserContextId } : {}) });
const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
await send("Page.enable", {}, sessionId);
await send("Runtime.enable", {}, sessionId);
await send("Log.enable", {}, sessionId);

const crashes = [];
const exceptions = []; // { text, stack }
const logErrors = [];
listeners.push((m) => {
  if (m.method === "Target.targetCrashed") crashes.push("targetCrashed " + JSON.stringify(m.params) + " who=" + (workerSessions.get(m.params.targetId) || "?"));
  if (m.method === "Inspector.targetCrashed") crashes.push("INSPECTOR target crashed");
  // NOTE: Target.targetDestroyed is normal (service worker / about:blank teardown) — not a crash.
  if (m.sessionId !== sessionId) return;
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    const frames = (d.stackTrace?.callFrames || [])
      .slice(0, 6)
      .map((f) => `${f.functionName || "(anon)"}@${(f.url || "").split("/").pop()}:${f.lineNumber}:${f.columnNumber}`);
    exceptions.push({ text: (d.exception?.description || d.text || "").slice(0, 200), stack: frames });
  }
  if (m.method === "Log.entryAdded" && m.params.entry.level === "error") logErrors.push(m.params.entry.text.slice(0, 220));
});

// Attach to workers too: a worker's uncaught exception only carries a stack on its OWN
// session. The page-level 'error' event gives a message and nothing else, which is why the
// recurring JSON error stayed unattributed for three rounds.
const workerSessions = new Map();
listeners.push(async (m) => {
  if (m.method !== "Target.attachedToTarget") return;
  const { sessionId: wsid, targetInfo } = m.params;
  workerSessions.set(wsid, targetInfo.url.split("/").pop() || targetInfo.type);
  try {
    await send("Runtime.enable", {}, wsid);
    await send("Log.enable", {}, wsid);
    // PAUSE_ON_EXC: Runtime.exceptionThrown arrives with an EMPTY callFrames list for these
    // workers, so the only way to see where the throw happens is to break on it and read the
    // live call stack. Diagnostic only -- it changes worker timing.
    if (process.env.PAUSE_ON_EXC) {
      await send("Debugger.enable", {}, wsid);
      await send("Debugger.setPauseOnExceptions", { state: "uncaught" }, wsid);
    }
  } catch {}
});
const pausedStacks = [];
listeners.push(async (m) => {
  if (m.method !== "Debugger.paused" || !workerSessions.has(m.sessionId)) return;
  const who = workerSessions.get(m.sessionId);
  const frames = (m.params.callFrames || []).slice(0, 12).map(
    (f) => `${f.functionName || "(anon)"} @ ${(f.url || "?").replace(/^.*\/(?=[^/]*$)/, "")}:${f.location.lineNumber + 1}:${f.location.columnNumber}`,
  );
  const desc = m.params.data?.description || m.params.data?.value || "";
  if (pausedStacks.length < 6) {
    pausedStacks.push({ who, desc: String(desc).slice(0, 160), frames, reason: m.params.reason });
    console.log(`\n>>> PAUSED in ${who} (${m.params.reason}): ${String(desc).slice(0, 120)}`);
    console.log("    " + frames.join("\n    "));
  }
  try { await send("Debugger.resume", {}, m.sessionId); } catch {}
});
listeners.push((m) => {
  if (!workerSessions.has(m.sessionId)) return;
  const who = workerSessions.get(m.sessionId);
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    const frames = (d.stackTrace?.callFrames || []).slice(0, 8)
      .map((f) => `${f.functionName || "(anon)"} @${(f.url || "").split("/").pop()}:${f.lineNumber}:${f.columnNumber}`);
    exceptions.push({ text: `[${who}] ` + (d.exception?.description || d.text || "").slice(0, 200), stack: frames });
  }
});
await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);

await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `
    window.__rig = { t0: Date.now(), term: [], log: [], listen: [], hooked: 0, werr: [] };
    const OW = Worker;
    function Hooked(url, opts) {
      window.__rig.hooked++;
      const w = new OW(url, opts);
      const name = String(url).split('/').pop();
      w.addEventListener('message', function (e) {
        try {
          var d = e.data; if (!d || !d.type) return;
          var dt = Date.now() - window.__rig.t0;
          if (d.type === 'term-out') window.__rig.term.push([dt, String(d.chunk == null ? '' : d.chunk), String(d.terminalId)]);
          else if (d.type === 'log') window.__rig.log.push([dt, String(d.line == null ? '' : d.line)]);
          else if (d.type === 'listen') window.__rig.listen.push([dt, JSON.stringify({ port: d.port, pid: d.pid })]);
        } catch (err) {}
      });
      // A worker killed for memory fires 'error' with an empty message, or simply goes silent.
      w.addEventListener('error', function (e) {
        window.__rig.werr.push([Date.now() - window.__rig.t0, name + ' :: ' + ((e && e.message) || '(no message — likely killed)')]);
      });
      return w;
    }
    Hooked.prototype = OW.prototype;
    Object.defineProperty(window, 'Worker', { value: Hooked, writable: true, configurable: true });
    // What actually reaches the SCREEN. Everything above captures bytes the kernel *emitted*;
    // this captures the text xterm actually painted, because "the terminal stopped rendering"
    // and "the install never finished" look identical from the byte stream alone. xterm's DOM
    // renderer only keeps the visible viewport, so lines are collected as they appear (on
    // mutation, plus a slow poll) rather than read once at the end. Observe the document, not
    // documentElement: this runs before the document exists, and observing null throws.
    window.__rig.rendered = [];
    window.__rig.snaps = 0;
    const seenRows = new Set();
    // EVERY xterm on the page, tagged by which one. The studio runs at least two (the boot
    // console and the project's shell); reading only the first captured the console and made a
    // healthy terminal look like it had stopped rendering.
    const snapRows = () => {
      const panels = document.querySelectorAll('.xterm-rows');
      if (!panels.length) return;
      window.__rig.snaps++;
      for (let i = 0; i < panels.length; i++) {
        for (const row of panels[i].children) {
          const text = (row.textContent || '').replace(/\u00a0/g, ' ').replace(/[ ]+$/, '');
          if (!text) continue;
          const tagged = i + '|' + text;
          if (!seenRows.has(tagged)) {
            seenRows.add(tagged);
            window.__rig.rendered.push([Date.now() - window.__rig.t0, text, i]);
          }
        }
      }
    };
    let queued = false;
    new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; snapRows(); });
    }).observe(document, { subtree: true, childList: true, characterData: true });
    setInterval(snapRows, 250);

  `,
}, sessionId);

// A renderer being OOM-killed does NOT fail Runtime.evaluate — the call simply never returns,
// which silently froze this watch loop the first time it reproduced the bug. Time it out so an
// unresponsive renderer is reported instead of stalling the harness.
const withTimeout = (p, ms, label) =>
  Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(label + " timed out after " + ms + "ms")), ms))]);
const ev = async (x) => {
  try {
    const r = await withTimeout(
      send("Runtime.evaluate", { expression: x, returnByValue: true, awaitPromise: true }, sessionId),
      20000, "Runtime.evaluate");
    return r.exceptionDetails ? { err: (r.exceptionDetails.exception?.description || "").slice(0, 200) } : { value: r.result.value };
  } catch (e) { return { err: "CDP:" + e.message.slice(0, 150) }; }
};
const click = async (t, exact = false) => (await ev(`(() => {
  const els=[...document.querySelectorAll('button,[role=button],a,[role=tab]')];
  const n=${JSON.stringify(t)};
  const h=els.find(e=>{const s=(e.innerText||'').trim();return ${exact}?s===n:s.includes(n)});
  if(!h) return "NOTFOUND"; h.click(); return "OK";})()`)).value;
const rss = () => {
  // Total RSS of this chrome's process tree, so a memory-driven kill is visible from outside.
  try {
    const out = spawnSyncRss();
    return out;
  } catch { return "?"; }
};
function spawnSyncRss() {
  const { execSync } = require("node:child_process");
  const s = execSync(`ps -o rss=,args= -e | grep -F ${JSON.stringify(PROFILE)} | grep -v grep | awk '{s+=$1} END {print int(s/1024)}'`, { encoding: "utf8" });
  return (s.trim() || "0") + "MB rss";
}
const { createRequire } = await import("node:module");
const require = createRequire(import.meta.url);

await send("Page.navigate", { url: STUDIO_URL }, sessionId);
await new Promise((r) => setTimeout(r, 18000));

console.log("hook self-test: " + (await ev(`JSON.stringify({hooked: window.__rig&&window.__rig.hooked, logs: window.__rig?window.__rig.log.length:-1})`)).value);
const cold = await ev(`(async () => {
  const root = await navigator.storage.getDirectory();
  let n = 0; for await (const _ of root.keys()) n++;
  const c = await caches.keys();
  const est = await navigator.storage.estimate();
  return JSON.stringify({ opfsEntries: n, caches: c.length,
    usageMB: +(est.usage/1048576).toFixed(1), quotaMB: Math.round(est.quota/1048576),
    persisted: await navigator.storage.persisted?.().catch(()=>null) });
})()`);
console.log("cold + quota check: " + (cold.value || cold.err));

await click("Start from template"); await new Promise((r) => setTimeout(r, 2500));
await click("Docs", true); await new Promise((r) => setTimeout(r, 1500));
console.log("pick " + TEMPLATE + ": " + (await click(TEMPLATE)));
await new Promise((r) => setTimeout(r, 1500));
console.log("create: " + (await click("Create", true)));

// SECOND_PROJECT=1: once the first install has snapshotted node_modules, create another
// project from the same template. A fresh project has no lockfile, so the kernel's pre-install
// lookup keys on the package.json hash and should HIT that snapshot — i.e. this measures the
// restore path a shipped snapshot would use, in a browser, with the OPFS mirror in play. The
// headless spike (spike-starlight-depcache.mjs) cannot measure that half.
const SECOND_PROJECT = process.env.SECOND_PROJECT === "1";
let secondAt = 0;
// Typing into the real terminal is the only way to exercise a restore in-browser: creating a
// second project needs launcher UI that is gone once a project is open, and the studio skips
// the dep cache entirely when node_modules already exists. So: remove node_modules and install
// again, which is exactly the pre-install lookup a shipped snapshot would satisfy.
const typeInTerminal = async (cmd) => {
  // xterm only takes keystrokes after a genuine click: a scripted .focus() leaves the DIV
  // focused and every keystroke is dropped.
  const box = (await ev(`(() => {
    const el = document.querySelector('.xterm-screen') || document.querySelector('.xterm');
    if (!el) return "";
    const r = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) });
  })()`)).value;
  if (!box) return "NO-TERMINAL";
  const { x, y } = JSON.parse(box);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 }, sessionId);
  }
  const focused = (await ev(`(document.activeElement && document.activeElement.className || "") .includes("xterm") ? "FOCUSED" : "FOCUS:" + (document.activeElement||{}).tagName`)).value;
  await send("Input.insertText", { text: cmd }, sessionId);
  for (const type of ["keyDown", "keyUp"]) {
    await send("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" }, sessionId);
  }
  return focused;
};

const createProject = async () => {
  await click("Start from template");
  await new Promise((r) => setTimeout(r, 2500));
  await click("Docs", true);
  await new Promise((r) => setTimeout(r, 1500));
  await click(TEMPLATE);
  await new Promise((r) => setTimeout(r, 1500));
  return await click("Create", true);
};

const t0 = Date.now();
const POST_LISTEN_MS = Number(process.env.POST_LISTEN_MS || 120000);
let lastLen = 0, lastGrowth = Date.now(), diagDumped = false, bound = false, wedged = false, died = false, boundAt = 0, restoreLine = "", logMark = 0;
while (Date.now() - t0 < WATCH_MS) {
  await new Promise((r) => setTimeout(r, 20000));
  const el = ((Date.now() - t0) / 1000) | 0;
  const r = await ev(`(() => { const v = window.__rig; if (!v) return "{}";
    const term = v.term.map(x=>x[1]).join('');
    return JSON.stringify({ chars: term.length, tail: term.slice(-500),
      lastAt: v.term.length ? v.term[v.term.length-1][0] : -1,
      snaps: v.snaps, renderedRows: v.rendered.length,
      renderedAdded: v.rendered.some(function (r) { return /added \\d+ packages/.test(r[1]); }),
      emittedAdded: /added \\d+ packages/.test(term),
      listen: v.listen, werr: v.werr, logTail: v.log.slice(-3).map(x=>((x[0]/1000)|0)+'s '+x[1]), logAll: v.log.map(x=>x[1]) }); })()`);
  if (r.err) {
    let alive = "?";
    try {
      const ts = await withTimeout(send("Target.getTargets"), 10000, "getTargets");
      const me = ts.targetInfos.find((t) => t.targetId === targetId);
      alive = me ? `page target present (${me.type})` : "PAGE TARGET GONE";
    } catch (e) { alive = "browser not answering: " + e.message.slice(0, 60); }
    console.log(`[t+${el}s] EVAL FAILED: ${r.err}  ${rss()}${cgStat()}  ${alive}`);
    if (crashes.length) { console.log("   crashes: " + crashes.join(" | ")); break; }
    continue;
  }
  const s = JSON.parse(r.value || "{}");
  const tail = s.tail || "";
  const all = [...tail.matchAll(/fetching · (\d+) requests · ([\d.]+) MB/g)];
  const spin = all.length ? `${all[all.length - 1][1]}req/${all[all.length - 1][2]}MB` : "-";
  const mem = await ev(`(() => { const m = performance.memory; return m ? Math.round(m.usedJSHeapSize/1048576)+'/'+Math.round(m.jsHeapSizeLimit/1048576)+'MB' : 'n/a'; })()`);
  const est = await ev(`navigator.storage.estimate().then(e => Math.round(e.usage/1048576)+'/'+Math.round(e.quota/1048576)+'MB')`);
  // Snapshot the terminal on EVERY tick. Reading it only at the end lost the whole transcript
  // on exactly the runs that failed, which are the ones worth reading.
  if (tail) fs.writeFileSync(`${WORK}/tail-${TAG}.txt`, `[t+${el}s] chars=${s.chars}\n` + tail);
  const grew = (s.chars || 0) !== lastLen;
  if (grew) { lastLen = s.chars || 0; lastGrowth = Date.now(); }
  const silentS = ((Date.now() - lastGrowth) / 1000) | 0;
  console.log(
    `[t+${el}s] ${grew ? "progress" : `SILENT ${silentS}s`} spin=${spin} term=${s.chars || 0}c heap=${mem.value} store=${est.value} ${rss()}${cgStat()}` +
      ` werr=${(s.werr || []).length} exc=${exceptions.length} rows=${s.renderedRows}` +
      ` added(emitted=${s.emittedAdded} rendered=${s.renderedAdded})`,
  );
  // Summarise: Starlight emits these in the hundreds, and dumping the array every tick buried
  // everything else in the log.
  if ((s.werr || []).length) {
    const msgs = [...new Set(s.werr.map((w) => w[1]))];
    console.log(`   worker errors: ${s.werr.length} (first at ${((s.werr[0][0] / 1000) | 0)}s) — ${msgs.slice(0, 2).join(" | ")}`);
  }
  // Once the terminal has been silent long enough to be a real stall, ask the runtime what it
  // thinks it is doing. This is the whole point of __vv.diag() existing, and the answer is only
  // meaningful while the process is still wedged — reading it afterwards tells you nothing.
  // Trigger on the runtime's own verdict as well as on silence: the watchdog line is itself
  // output, so it resets the silence counter and a stalled run can look intermittently alive.
  if (!diagDumped && (silentS >= 90 || /looks stuck rather than slow/.test(tail))) {
    diagDumped = true;
    const d = await ev(`(window.__vv && window.__vv.diag) ? __vv.diag().then(x => JSON.stringify(x)) : "no __vv.diag"`);
    console.log(`   __vv.diag() while wedged ${silentS}s:\n     ` + String(d.value || d.error).replace(/,"/g, ',\n     "').slice(0, 4000));
    fs.writeFileSync(`${WORK}/diag-${TAG}.json`, String(d.value || d.error));
  }
  const allLogs = s.logAll || [];
  if (SECOND_PROJECT && !secondAt && allLogs.some((l) => /cached node_modules/.test(l))) {
    logMark = allLogs.length; // only lines after this belong to the second project
    secondAt = Date.now();
    console.log(`   snapshot saved at t+${el}s — creating a SECOND project to exercise restore`);
    const how = process.env.RESTORE_VIA_TERMINAL === "1"
      ? "typed: " + (await typeInTerminal("rm -rf node_modules && npm install"))
      : "second create: " + (await createProject());
    console.log("   " + how);
  }
  if (secondAt) {
    const fresh = allLogs.slice(logMark);
    const hit = fresh.find((l) => /restored node_modules/.test(l));
    if (hit) {
      console.log(`   >>> RESTORE HIT ${(((Date.now() - secondAt) / 1000) | 0)}s after create: ${hit.trim()}`);
      restoreLine = hit.trim();
      break;
    }
    const miss = fresh.find((l) => /no snapshot for/.test(l));
    if (miss) {
      console.log(`   >>> RESTORE MISS — second project installed from scratch: ${miss.trim()}`);
      break;
    }
  }
  if (s.listen && s.listen.length && !bound) {
    console.log("LISTEN: " + JSON.stringify(s.listen));
    bound = true;
    boundAt = Date.now();
  }
  // Binding is not the end of the story: the new worker-error plumbing shows the astro process
  // worker DYING after it starts serving, which pre-fix was completely silent. So keep watching
  // past listen and check the dev server is still answering.
  if (bound) {
    if (/process worker died|worker died/.test(tail)) {
      const line = tail.split(/[\r\n]/).find((l) => /worker died/.test(l));
      console.log("   >>> WORKER DEATH AFTER LISTEN: " + (line || "").trim().slice(0, 160));
      died = true;
    }
    if (Date.now() - boundAt > POST_LISTEN_MS) break;
  }
  if (crashes.length) { console.log("CRASH: " + crashes.join(" | ")); break; }
  if (silentS > 420) { wedged = true; console.log(`>>> WEDGED: no terminal output for ${silentS}s`); break; }
}

// THE COMPARISON THIS SCRIPT EXISTS FOR: bytes the kernel emitted vs text the screen showed.
// Which terminal id did each interesting line go to?
const routing = await ev(`(() => {
  const byId = {};
  for (const [, chunk, id] of window.__rig.term) {
    const b = byId[id] || (byId[id] = { chunks: 0, chars: 0, added: false, runtime: false, sample: "" });
    b.chunks++; b.chars += chunk.length;
    if (/added \\d+ packages/.test(chunk)) b.added = true;
    if (/\\[runtime\\]/.test(chunk)) b.runtime = true;
    if (!b.sample && chunk.trim()) b.sample = chunk.replace(/\\x1b\\[[0-9;]*[A-Za-z]/g, "").trim().slice(0, 40);
  }
  return JSON.stringify(byId);
})()`);
console.log("\n──── term-out routing by terminalId ────");
for (const [id, b] of Object.entries(JSON.parse(routing.value || "{}"))) {
  console.log(`  ${id.padEnd(14)} chunks=${String(b.chunks).padEnd(6)} added=${String(b.added).padEnd(5)} [runtime]=${String(b.runtime).padEnd(5)} first: ${b.sample}`);
}
const rendered = await ev(`window.__rig ? JSON.stringify(window.__rig.rendered) : "[]"`);
const renderedRows = JSON.parse(rendered.value || "[]");
fs.writeFileSync(`${WORK}/rendered-${TAG}.txt`, renderedRows.map((r) => `${(r[0] / 1000).toFixed(1)}s  [panel ${r[2]}]  ${r[1]}`).join("\n"));
const full = await ev(`window.__rig ? window.__rig.term.map(x=>x[1]).join('') : ''`);
fs.writeFileSync(`${WORK}/term-${TAG}.txt`, full.value || "");
fs.writeFileSync(`${WORK}/logs-${TAG}.json`, (await ev(`window.__rig ? JSON.stringify(window.__rig.log) : "[]"`)).value || "[]");
fs.writeFileSync(`${WORK}/exc-${TAG}.json`, JSON.stringify({ exceptions, pausedStacks }, null, 1));
fs.writeFileSync(`${WORK}/chrome-${TAG}.log`, chromeErr.join(""));
// Compare on the strings a user would look for, not on character counts.
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*[A-Za-z]", "g");
const plain = (full.value || "").replace(ANSI, "");
// Stitch each panel's rows with NO separator as well as with newlines: xterm wraps mid-word at
// the panel width, so "[runtime]" or "added 364" can straddle a row boundary and a line-wise
// search would miss text that is plainly on screen.
const byPanel = new Map();
for (const r of renderedRows) byPanel.set(r[2], (byPanel.get(r[2]) || "") + r[1]);
const renderedText = renderedRows.map((r) => r[1]).join("\n") + "\n" + [...byPanel.values()].join("\n");
console.log(`\n──── emitted vs rendered ────`);
for (const [label, re] of [
  ["added N packages", /added \d+ packages/],
  ["tsconfck warning", /tsconfck/],
  ["astro ready", /astro\s+v[\d.]+ ready|watching for file changes/],
  ["[runtime] watchdog", /\[runtime\]/],
  ["worker died", /worker died/],
]) {
  const inBytes = re.test(plain);
  const onScreen = re.test(renderedText);
  // Absence is NOT proof of a drop: the DOM renderer only holds the visible viewport, so a row
  // that scrolls away between samples is never observed even though it was painted. Only the
  // positive result is evidence. (This bit me: a "never rendered" verdict for the watchdog line
  // turned out to be its own prefix rows scrolling past — the tail of the same line was captured.)
  const verdict = !inBytes ? "not emitted" : onScreen ? "RENDERED" : "not observed on screen (viewport sampling — see note)";
  console.log(`  ${label.padEnd(20)} emitted=${String(inBytes).padEnd(5)} rendered=${String(onScreen).padEnd(5)} ${verdict}`);
}
const panels = [...new Set(renderedRows.map((r) => r[2]))];
console.log(`  rendered rows captured: ${renderedRows.length} across ${panels.length} xterm panel(s) over ${(await ev("window.__rig?window.__rig.snaps:0")).value} snapshots`);
if (restoreLine) console.log("restore: " + restoreLine);
console.log(`\nRESULT tag=${TAG}: bound=${bound} workerDied=${died} wedged=${wedged} elapsed=${((Date.now() - t0) / 1000) | 0}s crashes=${crashes.length} exceptions=${exceptions.length}`);
// Attribute the recurring exception rather than just counting it.
const byText = {};
for (const e of exceptions) byText[e.text] = byText[e.text] || { n: 0, stack: e.stack };
for (const e of exceptions) byText[e.text].n++;
for (const [text, info] of Object.entries(byText).sort((a, b) => b[1].n - a[1].n).slice(0, 5)) {
  console.log(`\n  ${info.n}x  ${text}`);
  console.log("      at " + (info.stack.length ? info.stack.join("\n      at ") : "(no stack)"));
}
const distinctLog = [...new Set(logErrors)].slice(0, 6);
if (distinctLog.length) console.log("\nlog errors:\n  " + distinctLog.join("\n  "));
chrome.kill("SIGKILL");
process.exit(bound ? 0 : 1);