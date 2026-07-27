import { ArrowUpRight } from "lucide-react";
import { site } from "@/site";
import { Reveal } from "./Reveal";

// The "so what" layer. Features says what the runtime has; this says what it is
// deep enough to actually run, and links each claim to the teardown that shows
// the work. Every entry here must correspond to something that ships today.

const RUNS = [
  {
    title: "Next.js 16, App Router",
    body: "next dev with the wasm SWC, compiling and server-rendering React Server Components in a tab.",
    href: `${site.blogUrl}nextjs-rsc-in-a-tab`,
    hrefLabel: "and the AsyncLocalStorage trap",
  },
  {
    title: "The real npm, yarn and pnpm",
    body: "Not a re-implemented installer — the actual CLIs from the registry, resolving and linking a lockfile.",
    href: `${site.blogUrl}real-package-managers-in-the-browser`,
    hrefLabel: "how each one broke the runtime",
  },
  {
    title: "Postgres and SQLite, in the VM",
    body: "PGlite and sql.js over the virtual filesystem. A full-stack app with a real database, no backend.",
    href: `${site.blogUrl}databases-and-the-http-parser`,
    hrefLabel: "read the teardown",
  },
  {
    title: "Previews on your own origin",
    body: "Three isolation modes, up to a wildcard per-port origin so each preview gets real localhost semantics.",
    href: `${site.blogUrl}three-ways-to-isolate-a-preview`,
    hrefLabel: "the Cloudflare wildcard trick",
  },
  {
    title: "Breakpoints, without a V8 inspector",
    body: "Pause, step, inspect and evaluate in guest Node processes over the Chrome DevTools Protocol.",
    href: `${site.docsUrl}how-it-works`,
    hrefLabel: "how it works",
  },
  {
    title: "Vitest, webpack, Angular, Astro",
    body: "Test runners and heavyweight build tools that assume a real Node install — because they get one.",
    href: site.studioUrl,
    hrefLabel: "try a template",
  },
];

export function Proof() {
  return (
    <section id="proof" className="mx-auto max-w-7xl px-6 py-24">
      <Reveal className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
          Yes — it really <span className="text-gradient">runs that</span>
        </h2>
        <p className="mt-4 text-muted">
          A browser Node runtime is easy to demo and hard to finish. These are the
          things that only work once the runtime is deep enough, each with the
          teardown that shows what it took.
        </p>
      </Reveal>

      <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {RUNS.map((r, i) => (
          <Reveal key={r.title} delay={(i % 3) * 0.08}>
            <article className="glass flex h-full flex-col rounded-2xl p-6">
              <h3 className="text-lg font-medium">{r.title}</h3>
              <p className="mt-2 flex-1 text-sm leading-relaxed text-muted">
                {r.body}
              </p>
              <a
                href={r.href}
                className="group mt-4 inline-flex items-center gap-1 text-sm text-brand-2 transition-colors hover:text-brand"
              >
                {r.hrefLabel}
                <ArrowUpRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
              </a>
            </article>
          </Reveal>
        ))}
      </div>

      <Reveal className="mt-12">
        <div className="glass rounded-2xl px-6 py-8 text-center">
          <h3 className="text-lg font-medium">Built for people shipping a tab</h3>
          <p className="mx-auto mt-3 max-w-3xl text-sm leading-relaxed text-muted">
            Documentation sites that want runnable examples instead of code blocks.
            Teaching platforms that cannot ask a beginner to install a toolchain.
            AI coding products that need somewhere safe to execute generated code.
            And anyone who wants a sandbox they can host themselves, on their own
            domain, without asking permission.
          </p>
        </div>
      </Reveal>
    </section>
  );
}
