import { useEffect, useState, type ReactNode } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { TechIcon } from "./techIcons";
import type { RuntimeId } from "@/runtimes";

// A tiny, self-explanatory studio mock for the hero: a browser window with a code
// editor + terminal on the left and a preview pane on the right. It plays a
// looping story: code appears, a dev command runs, the runtime boots, the pane
// fades in. A first-time visitor immediately "gets" the headline, which is Node,
// Bun and Python running entirely in the browser.
//
// COSMETIC ONLY. Nothing here executes: the code is a hand-tokenised array, the
// terminal is a fixed list of strings, and the timeline is a loop of sleeps. The
// real thing is /studio. The landing page is deliberately NOT cross-origin
// isolated (see vite.config.ts and scripts/assemble-site.mjs), so it has no
// SharedArrayBuffer and *cannot* boot the runtime even if we wanted it to.
// Parameterising it by runtime below does not change that. Please keep this
// note, and keep the copy around it honest, if you add a fourth scene.
//
// One accuracy constraint is baked into the scenes and is not a style choice:
// the Python pane shows a raw HTTP response, not a rendered page. Vivari's
// WSGI/ASGI bridge is proven (scripts/spike-python-bridge.mjs drives real Flask
// and Django through it), but the preview tab, guest port registration and the
// service-worker tunnel are explicitly NOT proven for Python, and that spike's
// header says so. Drawing a rendered Flask page here would claim more than the
// suite does. For the same reason the command is `gunicorn wsgi:application`
// and never `manage.py runserver`, which the runtime refuses on purpose because
// it wants a TCP socket.

type Tone = "muted" | "ok" | "url";
type Term = { text: string; tone: Tone };

/** The preview pane's two shapes. See the note above for why Python gets `response`. */
type Preview =
  | { kind: "app"; title: string; button: string; note: ReactNode }
  | { kind: "response"; status: string; lines: string[] };

type Scene = {
  /** Text in the mock browser's address pill. */
  project: string;
  /** Editor tab label. */
  file: string;
  /** Pre-tokenised source, one entry per rendered line. */
  code: ReactNode[];
  /** The command typed at the prompt. */
  cmd: string;
  terminal: Term[];
  /** Label on the floating runtime badge, and its brand mark slug. */
  badge: string;
  icon: string;
  /** Header of the right-hand pane, before and after the runtime is up. */
  waitingLabel: string;
  readyLabel: string;
  preview: Preview;
};

// --- Node -------------------------------------------------------------------

const NODE_CODE: ReactNode[] = [
  <>
    <span className="text-brand-3">import</span>
    <span className="text-fg"> {"{ useState }"} </span>
    <span className="text-brand-3">from</span>
    <span className="text-emerald-400"> 'react'</span>
  </>,
  <>
    <span className="text-brand-3">import</span>
    <span className="text-emerald-400"> './App.css'</span>
  </>,
  <span className="opacity-0">.</span>,
  <>
    <span className="text-brand-3">export default function</span>
    <span className="text-brand-2"> App</span>
    <span className="text-muted">() {"{"}</span>
  </>,
  <>
    <span className="pl-4 text-brand-3">const</span>
    <span className="text-fg"> [n, setN] = </span>
    <span className="text-brand-2">useState</span>
    <span className="text-muted">(</span>
    <span className="text-amber-300">0</span>
    <span className="text-muted">)</span>
  </>,
  <>
    <span className="pl-4 text-brand-3">return</span>
    <span className="text-muted"> (</span>
  </>,
  <>
    <span className="pl-8 text-muted">&lt;</span>
    <span className="text-brand-2">button</span>
    <span className="text-brand-3"> onClick</span>
    <span className="text-muted">={"{"}() =&gt; </span>
    <span className="text-fg">setN(n + </span>
    <span className="text-amber-300">1</span>
    <span className="text-fg">)</span>
    <span className="text-muted">{"}"}&gt;</span>
  </>,
  <>
    <span className="pl-12 text-fg">count is </span>
    <span className="text-muted">{"{"}n{"}"}</span>
  </>,
  <>
    <span className="pl-8 text-muted">&lt;/</span>
    <span className="text-brand-2">button</span>
    <span className="text-muted">&gt;)</span>
  </>,
  <span className="text-muted">{"}"}</span>,
];

// --- Bun --------------------------------------------------------------------

const BUN_CODE: ReactNode[] = [
  <>
    <span className="text-brand-3">const</span>
    <span className="text-fg"> tasks</span>
    <span className="text-muted">: </span>
    <span className="text-brand-2">Task</span>
    <span className="text-muted">[] = [</span>
    <span className="text-emerald-400">'ship it'</span>
    <span className="text-muted">]</span>
  </>,
  <span className="opacity-0">.</span>,
  <>
    <span className="text-brand-3">const</span>
    <span className="text-fg"> server = </span>
    <span className="text-brand-2">Bun</span>
    <span className="text-muted">.</span>
    <span className="text-brand-2">serve</span>
    <span className="text-muted">({"{"}</span>
  </>,
  <>
    <span className="pl-4 text-fg">port</span>
    <span className="text-muted">: </span>
    <span className="text-amber-300">3000</span>
    <span className="text-muted">,</span>
  </>,
  <>
    <span className="pl-4 text-fg">routes</span>
    <span className="text-muted">: {"{"}</span>
  </>,
  <>
    <span className="pl-8 text-emerald-400">'/api/tasks'</span>
    <span className="text-muted">: () =&gt; </span>
    <span className="text-brand-2">Response</span>
    <span className="text-muted">.</span>
    <span className="text-brand-2">json</span>
    <span className="text-muted">(tasks),</span>
  </>,
  <>
    <span className="pl-4 text-muted">{"}"},</span>
  </>,
  <span className="text-muted">{"}"})</span>,
  <span className="opacity-0">.</span>,
  <>
    <span className="text-brand-2">console</span>
    <span className="text-muted">.</span>
    <span className="text-brand-2">log</span>
    <span className="text-muted">(</span>
    <span className="text-emerald-400">`up on :${"{"}server.port{"}"}`</span>
    <span className="text-muted">)</span>
  </>,
];

// --- Python -----------------------------------------------------------------

const PYTHON_CODE: ReactNode[] = [
  <>
    <span className="text-brand-3">from</span>
    <span className="text-fg"> flask </span>
    <span className="text-brand-3">import</span>
    <span className="text-fg"> Flask, jsonify</span>
  </>,
  <span className="opacity-0">.</span>,
  <>
    <span className="text-fg">app = </span>
    <span className="text-brand-2">Flask</span>
    <span className="text-muted">(</span>
    <span className="text-brand-3">__name__</span>
    <span className="text-muted">)</span>
  </>,
  <>
    <span className="text-fg">tasks = [</span>
    <span className="text-emerald-400">'ship it'</span>
    <span className="text-fg">]</span>
  </>,
  <span className="opacity-0">.</span>,
  <>
    <span className="text-brand-3">@app</span>
    <span className="text-muted">.</span>
    <span className="text-brand-2">get</span>
    <span className="text-muted">(</span>
    <span className="text-emerald-400">'/api/tasks'</span>
    <span className="text-muted">)</span>
  </>,
  <>
    <span className="text-brand-3">def</span>
    <span className="text-brand-2"> list_tasks</span>
    <span className="text-muted">():</span>
  </>,
  <>
    <span className="pl-4 text-brand-3">return</span>
    <span className="text-brand-2"> jsonify</span>
    <span className="text-muted">(</span>
    <span className="text-fg">tasks</span>
    <span className="text-muted">)</span>
  </>,
  <span className="opacity-0">.</span>,
  <>
    <span className="text-fg">application = app</span>
    <span className="text-muted">  # served by gunicorn</span>
  </>,
];

export const RUNTIMES: Record<RuntimeId, Scene> = {
  node: {
    project: "my-vite-app",
    file: "App.jsx",
    code: NODE_CODE,
    cmd: "npm run dev",
    terminal: [
      { text: "VITE v8.1  ready in 92 ms", tone: "muted" },
      { text: "->  Local:   preview ready", tone: "url" },
      { text: "running in your browser, no server", tone: "ok" },
    ],
    badge: "Node",
    icon: "node",
    waitingLabel: "waiting for server…",
    readyLabel: "localhost preview",
    preview: {
      kind: "app",
      title: "Hello from Vivari",
      button: "count is",
      note: (
        <>
          Edit <span className="font-mono">App.jsx</span> and save to test HMR
        </>
      ),
    },
  },
  bun: {
    project: "my-bun-api",
    file: "server.ts",
    code: BUN_CODE,
    cmd: "bun run server.ts",
    terminal: [
      { text: "bun v1.1.34  TypeScript, zero config", tone: "muted" },
      { text: "->  Local:   :3000 ready", tone: "url" },
      // The disclosure belongs where the demo is, not only in the docs.
      { text: "API-compatible shim, not the Bun binary", tone: "ok" },
    ],
    badge: "Bun",
    icon: "bun",
    waitingLabel: "waiting for Bun.serve…",
    readyLabel: "GET /api/tasks",
    preview: {
      kind: "response",
      status: "200 OK  ·  application/json",
      lines: ["{", '  "tasks": ["ship it"],', '  "runtime": "bun"', "}"],
    },
  },
  python: {
    project: "my-flask-app",
    file: "app.py",
    code: PYTHON_CODE,
    // NOT `manage.py runserver` / `flask run`: the runtime refuses those on
    // purpose (they want a TCP socket) and names this as the command that works.
    cmd: "gunicorn wsgi:application",
    terminal: [
      { text: "CPython 3.14.2 on Pyodide", tone: "muted" },
      { text: "->  WSGI bridge:  /api/tasks", tone: "url" },
      { text: "real CPython, compiled to WebAssembly", tone: "ok" },
    ],
    badge: "Python",
    icon: "python",
    waitingLabel: "starting CPython…",
    readyLabel: "GET /api/tasks",
    preview: {
      kind: "response",
      status: "200 OK  ·  application/json",
      lines: ["{", '  "tasks": ["ship it"],', '  "runtime": "cpython 3.14"', "}"],
    },
  },
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function Workspace({ runtime = "node" }: { runtime?: RuntimeId }) {
  const reduce = useReducedMotion();
  const scene = RUNTIMES[runtime];
  const [code, setCode] = useState(0);
  const [typed, setTyped] = useState("");
  const [term, setTerm] = useState(0);
  const [ready, setReady] = useState(false);
  const [count, setCount] = useState(3);

  // Self-driving looped timeline, restarted whenever the visitor picks another
  // runtime. Under reduced motion we jump straight to the finished frame and
  // skip the loop entirely.
  useEffect(() => {
    if (reduce) {
      setCode(scene.code.length);
      setTyped(scene.cmd);
      setTerm(scene.terminal.length);
      setReady(true);
      return;
    }
    let alive = true;
    (async () => {
      while (alive) {
        setCode(0);
        setTyped("");
        setTerm(0);
        setReady(false);
        await sleep(500);
        for (let i = 1; i <= scene.code.length; i++) {
          if (!alive) return;
          setCode(i);
          await sleep(150);
        }
        await sleep(350);
        for (let i = 1; i <= scene.cmd.length; i++) {
          if (!alive) return;
          setTyped(scene.cmd.slice(0, i));
          await sleep(55);
        }
        await sleep(450);
        for (let i = 1; i <= scene.terminal.length; i++) {
          if (!alive) return;
          setTerm(i);
          await sleep(300);
        }
        await sleep(250);
        if (!alive) return;
        setReady(true);
        await sleep(3600);
      }
    })();
    return () => {
      alive = false;
    };
  }, [reduce, scene]);

  // Nudge the preview counter while it's live so the mock feels alive.
  useEffect(() => {
    if (!ready || reduce || scene.preview.kind !== "app") return;
    const id = setInterval(() => setCount((c) => c + 1), 1100);
    return () => clearInterval(id);
  }, [ready, reduce, scene]);

  return (
    <div className="glass relative overflow-hidden rounded-xl shadow-2xl shadow-black/50">
      {/* Browser chrome */}
      <div className="flex items-center gap-2 border-b border-border bg-white/[0.02] px-4 py-3">
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        <div className="mx-auto flex items-center gap-2 rounded-md bg-white/5 px-3 py-1 text-[11px] text-faint">
          <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="4" y="10" width="16" height="10" rx="2" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" />
          </svg>
          {scene.project}
        </div>
      </div>

      {/* Body: editor + terminal | preview */}
      <div className="grid h-[300px] grid-cols-2 md:h-[320px]">
        {/* Left: code editor over a terminal strip */}
        <div className="flex min-w-0 flex-col border-r border-border">
          <div className="flex items-center gap-2 border-b border-border/70 bg-white/[0.015] px-3 py-1.5">
            <span className="rounded bg-white/10 px-2 py-0.5 text-[10px] text-muted">{scene.file}</span>
          </div>
          <div className="flex-1 overflow-x-auto overflow-y-hidden px-3 py-2 font-mono text-[11px] leading-[1.55]">
            {scene.code.slice(0, code).map((line, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: -6 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.25 }}
                className="flex"
              >
                <span className="mr-3 w-3 select-none text-right text-faint/60">{i + 1}</span>
                <span className="whitespace-pre">{line}</span>
              </motion.div>
            ))}
          </div>
          <div className="h-[38%] border-t border-border bg-black/30 px-3 py-2 font-mono text-[11px] leading-relaxed">
            <div className="flex">
              <span className="mr-2 text-brand-2">&#10095;</span>
              <span className="min-w-0 truncate text-fg">{typed}</span>
              {typed.length < scene.cmd.length && (
                <span className="ml-0.5 inline-block w-1.5 animate-pulse bg-fg">&nbsp;</span>
              )}
            </div>
            {scene.terminal.slice(0, term).map((l, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className={
                  l.tone === "ok"
                    ? "text-emerald-400"
                    : l.tone === "url"
                      ? "text-brand-2"
                      : "text-muted"
                }
              >
                {l.text}
              </motion.div>
            ))}
          </div>
        </div>

        {/* Right: preview pane */}
        <div className="relative flex min-w-0 flex-col bg-gradient-to-br from-bg-soft to-panel">
          <div className="flex items-center gap-2 border-b border-border/70 px-3 py-1.5 text-[10px] text-faint">
            <motion.span
              animate={ready ? { backgroundColor: "#34d399" } : { backgroundColor: "#5b6479" }}
              className="h-2 w-2 shrink-0 rounded-full"
            />
            <span className="truncate">{ready ? scene.readyLabel : scene.waitingLabel}</span>
          </div>
          <div className="relative flex flex-1 items-center justify-center overflow-hidden p-4">
            <AnimatePresence>
              {ready && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.9, y: 8 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.5, ease: "easeOut" }}
                  className="flex w-full flex-col items-center gap-4 text-center"
                >
                  {scene.preview.kind === "app" ? (
                    <>
                      <div className="text-lg font-semibold">
                        <span className="text-gradient">{scene.preview.title}</span>
                      </div>
                      {/* Drawn as a button because that is what the mock
                          depicts; taken out of the tab order because it does
                          nothing, and a focus stop that answers nothing is
                          worse than no focus stop. */}
                      <span
                        aria-hidden
                        className="rounded-lg border border-border bg-white/5 px-4 py-2 text-sm text-fg"
                      >
                        {scene.preview.button} {count}
                      </span>
                      <p className="max-w-[16rem] text-[11px] text-faint">{scene.preview.note}</p>
                    </>
                  ) : (
                    <div className="w-full min-w-0 text-left font-mono text-[11px] leading-relaxed">
                      <div className="mb-2 truncate text-emerald-400">{scene.preview.status}</div>
                      {scene.preview.lines.map((l) => (
                        <div key={l} className="truncate text-muted">
                          {l}
                        </div>
                      ))}
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Runtime badge at the terminal -> preview seam */}
      <AnimatePresence>
        {ready && (
          <motion.div
            key={runtime}
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.6 }}
            transition={{ type: "spring", stiffness: 260, damping: 18 }}
            // Sits on the terminal -> preview seam. The `app` preview is centred
            // with a gap at that height; the `response` one is a left-aligned
            // block of text that the badge would otherwise sit on top of, so it
            // drops below the text rather than over it.
            className={`glass absolute left-[52%] flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-full px-2.5 py-1 shadow-lg shadow-black/40 ${
              scene.preview.kind === "app" ? "top-[58%]" : "top-[88%]"
            }`}
          >
            <span className="relative flex h-4 w-4 items-center justify-center">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/40" />
              <TechIcon slug={scene.icon} className="relative h-4 w-4" />
            </span>
            <span className="text-[10px] font-medium text-fg">{scene.badge}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
