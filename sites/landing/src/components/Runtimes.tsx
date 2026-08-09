import { Reveal } from "./Reveal";
import { TechIcon } from "./techIcons";
import { RUNTIME_DEFS, EVIDENCE_LABEL, type CapabilityGroup } from "@/runtimes";

// "What it runs", grouped by runtime and then by category.
//
// The grouping IS the argument. A flat wall of logos says "we are adjacent to
// these brands"; a grouped one says Flask is Python, Docusaurus is a docs tool,
// and pnpm is a package manager, which is the actual claim, and the one a
// visitor is trying to check. It is also why this is a static grid and not a
// carousel or an orbiting cloud: both of those hide most of the content behind
// time or behind a ring that has nowhere to put a hierarchy, and both create a
// WCAG 2.2.2 (Pause, Stop, Hide) obligation for content that does not need to
// move at all. Nothing in this section animates beyond the shared `Reveal`
// scroll-in, so there is nothing to pause and nothing to redesign under
// `prefers-reduced-motion`.
//
// Each group carries an `evidence` tier from src/runtimes.ts, surfaced as the
// small caption beside its heading. Keeping that visible is the point: the page
// claims a lot, and a reader who wants to know which claims are continuously
// gated and which are checked nightly can see it without leaving the page.

function Group({ group }: { group: CapabilityGroup }) {
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h4 className="text-[11px] font-medium uppercase tracking-wider text-muted">
          {group.title}
        </h4>
        <span className="font-mono text-[10px] text-faint">
          {EVIDENCE_LABEL[group.evidence]}
        </span>
      </div>
      <ul className="mt-2.5 flex flex-wrap gap-1.5">
        {group.items.map((it) => (
          <li
            key={it.name}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/70 bg-white/[0.03] px-2 py-1 text-[12px] text-fg"
          >
            <TechIcon slug={it.icon} className="h-3.5 w-3.5 shrink-0" />
            {it.name}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Runtimes() {
  return (
    <section id="runs" className="mx-auto max-w-7xl px-6 py-24">
      <Reveal className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
          Three runtimes, <span className="text-gradient">one browser tab</span>
        </h2>
        <p className="mt-4 text-muted">
          Node, Bun and Python, each with the stack you would actually reach for,
          and beside every group, how continuously we prove it still works.
        </p>
      </Reveal>

      <div className="mt-14 grid gap-4 lg:grid-cols-3">
        {RUNTIME_DEFS.map((r, i) => (
          <Reveal key={r.id} delay={i * 0.08} className="h-full">
            <article className="glass flex h-full flex-col rounded-2xl p-6">
              <header className="flex items-center gap-3">
                <span className="inline-flex rounded-xl bg-white/5 p-2.5">
                  <TechIcon slug={r.icon} className="h-6 w-6" />
                </span>
                <div className="min-w-0">
                  <h3 className="flex items-center gap-2 text-lg font-medium">
                    <span className={r.accent}>{r.label}</span>
                    {r.tag && (
                      <span className="rounded-full bg-brand/20 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-brand-2">
                        {r.tag}
                      </span>
                    )}
                  </h3>
                  <p className="text-xs text-muted">{r.blurb}</p>
                </div>
              </header>

              <div className="mt-6 flex-1 space-y-5">
                {r.groups.map((g) => (
                  <Group key={g.title} group={g} />
                ))}
              </div>

              <p className="mt-6 border-t border-border/60 pt-4 text-xs leading-relaxed text-faint">
                {r.note}
              </p>
            </article>
          </Reveal>
        ))}
      </div>

      <Reveal className="mt-8">
        <p className="mx-auto max-w-3xl text-center text-xs leading-relaxed text-faint">
          <span className="font-mono text-muted">every change</span>: proven by a
          spike that blocks every pull request.{" "}
          <span className="font-mono text-muted">nightly</span>: proven by a
          scheduled job that can fail the build.{" "}
          <span className="font-mono text-muted">nightly, advisory</span>: proven
          by the network tier, which installs from the live npm registry and is
          allowed to be flaky, so treat it as credible rather than as checked
          today.{" "}
          <span className="font-mono text-muted">shipped, not gated</span>: a
          template you can boot today, but no spike exercises it, so nothing here
          would catch a regression.
        </p>
      </Reveal>
    </section>
  );
}
