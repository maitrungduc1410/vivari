import { Reveal } from "./Reveal";

const STEPS = [
  {
    n: "01",
    title: "Synchronous FS bridge",
    body: "Node's APIs are synchronous. On a Web Worker, Atomics.wait() can genuinely block — so fs.readFileSync() parks the thread until the host answers over a SharedArrayBuffer.",
  },
  {
    n: "02",
    title: "A kernel over Wasm",
    body: "A supervisor owns the Rust/Wasm VFS and a PID table. It services syscalls and spawns each command as its own worker/process.",
  },
  {
    n: "03",
    title: "Service Worker preview",
    body: "An in-VM server that calls listen() is reachable at /preview/<port>/. A Service Worker turns each iframe request into an in-memory HTTP call.",
  },
];

export function HowItWorks() {
  return (
    <section id="how" className="mx-auto max-w-7xl px-6 py-24">
      <div className="grid gap-14 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
        <Reveal>
          <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
            The trick: <span className="text-gradient">blocking</span> on a worker
          </h2>
          <p className="mt-4 text-muted">
            Browsers won't let you block on async work — except on a Web Worker
            thread, where <code className="rounded bg-white/5 px-1.5 py-0.5 font-mono text-sm text-fg">Atomics.wait()</code>{" "}
            can park execution. That single primitive makes a synchronous Node
            runtime possible in the browser.
          </p>

          <pre className="glass mt-8 overflow-x-auto rounded-xl p-5 font-mono text-xs leading-relaxed text-muted">
{`user code (Web Worker)
   |  fs.readFileSync("/x")   <- looks synchronous
   v
SharedArrayBuffer  -- request -->  Host (main thread)
   ^                                  |  Rust/Wasm VFS lookup
   +------ Atomics.notify <-----------+
   v
returns bytes, still synchronous`}
          </pre>
        </Reveal>

        <div className="space-y-4">
          {STEPS.map((s, i) => (
            <Reveal key={s.n} delay={i * 0.1}>
              <div className="glass flex gap-5 rounded-2xl p-6">
                <span className="text-gradient font-mono text-2xl font-semibold">
                  {s.n}
                </span>
                <div>
                  <h3 className="text-lg font-medium">{s.title}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted">{s.body}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
