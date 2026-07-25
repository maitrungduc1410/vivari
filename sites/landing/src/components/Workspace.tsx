import { useEffect, useState, type ReactNode } from "react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";

// A tiny, self-explanatory studio mock for the hero: a browser window with a code
// editor + terminal on the left and a live preview on the right. It plays a
// looping story — code appears, `npm run dev` runs, Vite boots, the preview fades
// in — so a first-time visitor immediately "gets" the headline: a Node dev server
// running entirely in the browser. Cosmetic only; the real thing is /studio.

// The App.jsx shown in the editor. Each line is pre-tokenized so it reads like a
// syntax-highlighted file. It deliberately matches the counter in the preview.
const CODE: ReactNode[] = [
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

type Term = { text: string; tone: "cmd" | "muted" | "ok" | "url" };
const TERMINAL: Term[] = [
  { text: "VITE v8.1  ready in 92 ms", tone: "muted" },
  { text: "->  Local:   preview ready", tone: "url" },
  { text: "running in your browser - no server", tone: "ok" },
];

const CMD = "npm run dev";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function Workspace() {
  const reduce = useReducedMotion();
  const [code, setCode] = useState(0);
  const [typed, setTyped] = useState("");
  const [term, setTerm] = useState(0);
  const [ready, setReady] = useState(false);
  const [count, setCount] = useState(3);

  // Self-driving looped timeline. Under reduced motion we jump straight to the
  // finished frame and skip the loop.
  useEffect(() => {
    if (reduce) {
      setCode(CODE.length);
      setTyped(CMD);
      setTerm(TERMINAL.length);
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
        for (let i = 1; i <= CODE.length; i++) {
          if (!alive) return;
          setCode(i);
          await sleep(150);
        }
        await sleep(350);
        for (let i = 1; i <= CMD.length; i++) {
          if (!alive) return;
          setTyped(CMD.slice(0, i));
          await sleep(55);
        }
        await sleep(450);
        for (let i = 1; i <= TERMINAL.length; i++) {
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
  }, [reduce]);

  // Nudge the preview counter while it's live so the mock feels alive.
  useEffect(() => {
    if (!ready || reduce) return;
    const id = setInterval(() => setCount((c) => c + 1), 1100);
    return () => clearInterval(id);
  }, [ready, reduce]);

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
          my-vite-app
        </div>
      </div>

      {/* Body: editor + terminal | preview */}
      <div className="grid h-[300px] grid-cols-2 md:h-[320px]">
        {/* Left: code editor over a terminal strip */}
        <div className="flex min-w-0 flex-col border-r border-border">
          <div className="flex items-center gap-2 border-b border-border/70 bg-white/[0.015] px-3 py-1.5">
            <span className="rounded bg-white/10 px-2 py-0.5 text-[10px] text-muted">App.jsx</span>
          </div>
          <div className="flex-1 overflow-x-auto overflow-y-hidden px-3 py-2 font-mono text-[11px] leading-[1.55]">
            {CODE.slice(0, code).map((line, i) => (
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
              <span className="text-fg">{typed}</span>
              {typed.length < CMD.length && (
                <span className="ml-0.5 inline-block w-1.5 animate-pulse bg-fg">&nbsp;</span>
              )}
            </div>
            {TERMINAL.slice(0, term).map((l, i) => (
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

        {/* Right: live preview */}
        <div className="relative flex min-w-0 flex-col bg-gradient-to-br from-bg-soft to-panel">
          <div className="flex items-center gap-2 border-b border-border/70 px-3 py-1.5 text-[10px] text-faint">
            <motion.span
              animate={ready ? { backgroundColor: "#34d399" } : { backgroundColor: "#5b6479" }}
              className="h-2 w-2 rounded-full"
            />
            {ready ? "localhost preview" : "waiting for server…"}
          </div>
          <div className="relative flex flex-1 items-center justify-center overflow-hidden p-4">
            <AnimatePresence>
              {ready && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.9, y: 8 }}
                  animate={{ opacity: 1, scale: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.5, ease: "easeOut" }}
                  className="flex flex-col items-center gap-4 text-center"
                >
                  <div className="text-lg font-semibold">
                    <span className="text-gradient">Hello from Vivari</span>
                  </div>
                  <button className="rounded-lg border border-border bg-white/5 px-4 py-2 text-sm text-fg">
                    count is {count}
                  </button>
                  <p className="max-w-[16rem] text-[11px] text-faint">
                    Edit <span className="font-mono">App.jsx</span> and save to test HMR
                  </p>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Node runtime badge at the terminal -> preview seam */}
      <AnimatePresence>
        {ready && (
          <motion.div
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.6 }}
            transition={{ type: "spring", stiffness: 260, damping: 18 }}
            className="glass absolute left-[52%] top-[58%] flex -translate-x-1/2 -translate-y-1/2 items-center gap-1.5 rounded-full px-2.5 py-1 shadow-lg shadow-black/40"
          >
            <span className="relative flex h-4 w-4 items-center justify-center">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/40" />
              <NodeMark className="relative h-4 w-4 transform-[scale(1.4)]" />
            </span>
            <span className="text-[10px] font-medium text-fg">Node</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// The Node.js hexagon mark (inline; lucide has no Node logo).
function NodeMark({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
      <path d="M0 0h32v32H0z" fill="none" />
      <path fill="#83cd29" d="M16 30a2.15 2.15 0 0 1-1.076-.288L11.5 27.685c-.511-.286-.262-.387-.093-.446a6.8 6.8 0 0 0 1.549-.7a.26.26 0 0 1 .255.019l2.631 1.563a.34.34 0 0 0 .318 0l10.26-5.922a.32.32 0 0 0 .157-.278V10.075a.33.33 0 0 0-.159-.283l-10.26-5.917a.32.32 0 0 0-.317 0L5.587 9.794a.33.33 0 0 0-.162.281v11.841a.32.32 0 0 0 .161.274L8.4 23.814c1.525.762 2.459-.136 2.459-1.038V11.085a.3.3 0 0 1 .3-.3h1.3a.3.3 0 0 1 .3.3v11.692c0 2.035-1.108 3.2-3.038 3.2a4.4 4.4 0 0 1-2.363-.642l-2.697-1.547a2.17 2.17 0 0 1-1.076-1.872V10.075A2.16 2.16 0 0 1 4.661 8.2l10.261-5.924a2.25 2.25 0 0 1 2.156 0L27.338 8.2a2.17 2.17 0 0 1 1.077 1.87v11.846a2.17 2.17 0 0 1-1.077 1.872l-10.26 5.924A2.15 2.15 0 0 1 16 30" />
      <path fill="#83cd29" d="M14.054 17.953a.3.3 0 0 1 .3-.3h1.327a.3.3 0 0 1 .295.251c.2 1.351.8 2.032 3.513 2.032c2.161 0 3.082-.489 3.082-1.636c0-.661-.261-1.152-3.62-1.481c-2.808-.278-4.544-.9-4.544-3.144c0-2.07 1.745-3.305 4.67-3.305c3.287 0 4.914 1.141 5.12 3.589a.3.3 0 0 1-.295.323h-1.336a.3.3 0 0 1-.288-.232c-.319-1.421-1.1-1.875-3.2-1.875c-2.36 0-2.634.822-2.634 1.438c0 .746.324.964 3.51 1.385c3.153.417 4.651 1.007 4.651 3.223c0 2.236-1.864 3.516-5.115 3.516c-4.495.006-5.436-2.055-5.436-3.784" />
    </svg>

  );
}