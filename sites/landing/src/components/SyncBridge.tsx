import { motion, useReducedMotion } from "motion/react";
import { Cpu, Server } from "lucide-react";

// An animated version of the old ASCII round-trip diagram. It shows a
// synchronous-looking fs.readFileSync() on a Web Worker crossing a
// SharedArrayBuffer channel to the host and back, so the "blocking on a worker"
// idea reads at a glance. Two packets travel in opposite directions on the
// channel; the return trip is offset so it feels like a request/response.

const DOT_CYAN = "shadow-[0_0_10px_2px_rgba(34,211,238,0.6)]";
const DOT_PINK = "shadow-[0_0_10px_2px_rgba(244,114,182,0.6)]";

export function SyncBridge() {
  const reduce = useReducedMotion();

  return (
    <div className="glass mt-8 rounded-xl p-4 sm:p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-stretch">
        {/* Web Worker side */}
        <div className="flex-1 rounded-lg border border-border bg-white/[0.02] p-4">
          <div className="mb-3 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-faint">
            <Cpu className="h-3.5 w-3.5" /> user code · Web Worker
          </div>
          <div className="font-mono text-[12px] leading-relaxed">
            <span className="text-fg">fs</span>
            <span className="text-muted">.</span>
            <span className="text-brand-2">readFileSync</span>
            <span className="text-muted">(</span>
            <span className="text-emerald-400">"/x"</span>
            <span className="text-muted">)</span>
          </div>
          <div className="mt-2 text-[11px] text-muted">
            parks on{" "}
            <span className="rounded bg-white/5 px-1 py-0.5 font-mono text-fg">
              Atomics.wait()
            </span>
          </div>
        </div>

        {/* SharedArrayBuffer channel */}
        <div className="flex w-full shrink-0 flex-col justify-center gap-6 px-1 sm:w-[160px]">
          <div className="text-center text-[9px] font-medium uppercase tracking-[0.18em] text-faint">
            SharedArrayBuffer
          </div>

          {/* request: worker -> host */}
          <div>
            <div className="mb-1 text-center text-[9px] uppercase tracking-wider text-brand-2/80">
              request →
            </div>
            <div className="relative h-px w-full bg-gradient-to-r from-transparent via-brand-2/40 to-transparent">
              <motion.span
                className={`absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-2 ${DOT_CYAN}`}
                animate={
                  reduce
                    ? { left: "50%" }
                    : { left: ["0%", "100%"], opacity: [0, 1, 1, 0] }
                }
                transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
              />
            </div>
          </div>

          {/* response: host -> worker */}
          <div>
            <div className="relative h-px w-full bg-gradient-to-r from-transparent via-brand-3/40 to-transparent">
              <motion.span
                className={`absolute top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-3 ${DOT_PINK}`}
                animate={
                  reduce
                    ? { left: "50%" }
                    : { left: ["100%", "0%"], opacity: [0, 1, 1, 0] }
                }
                transition={{
                  duration: 1.6,
                  repeat: Infinity,
                  ease: "easeInOut",
                  delay: 0.8,
                }}
              />
            </div>
            <div className="mt-1 text-center text-[9px] uppercase tracking-wider text-brand-3/80">
              ← Atomics.notify
            </div>
          </div>
        </div>

        {/* Host side */}
        <div className="flex-1 rounded-lg border border-border bg-white/[0.02] p-4">
          <div className="mb-3 flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-faint">
            <Server className="h-3.5 w-3.5" /> host · main thread
          </div>
          <div className="font-mono text-[12px] leading-relaxed text-fg">
            Rust/Wasm <span className="text-brand-2">VFS</span> lookup
          </div>
          <div className="mt-2 text-[11px] text-emerald-400">
            returns bytes — still synchronous
          </div>
        </div>
      </div>
    </div>
  );
}
