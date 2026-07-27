import { Check, X } from "lucide-react";
import { Reveal } from "./Reveal";

// Two groups on purpose. The capability rows are mostly parity — claiming a
// proprietary WebContainer can't run Next.js would be false and would be the
// first thing anyone tested. The point is that parity is the price of entry,
// and the terms below it are where the projects actually differ.

type Row = { label: string; vivari: boolean; other: boolean };
type Group = { title: string; note: string; rows: Row[] };

const GROUPS: Group[] = [
  {
    title: "What it runs",
    note: "Table stakes. Both clear this bar.",
    rows: [
      { label: "Node projects, fully in-browser", vivari: true, other: true },
      { label: "The real npm / yarn / pnpm", vivari: true, other: true },
      { label: "Next.js App Router dev server", vivari: true, other: true },
      { label: "Databases in the VM (SQLite, Postgres)", vivari: true, other: true },
    ],
  },
  {
    title: "What you are allowed to do with it",
    note: "Where the two actually diverge.",
    rows: [
      { label: "MIT-licensed", vivari: true, other: false },
      { label: "Free for commercial use", vivari: true, other: false },
      { label: "No per-seat / usage fee", vivari: true, other: false },
      { label: "Self-host every asset", vivari: true, other: false },
      { label: "Previews on a domain you control", vivari: true, other: false },
      { label: "Fork it and ship it", vivari: true, other: false },
    ],
  },
];

function Mark({ on, muted }: { on: boolean; muted?: boolean }) {
  if (!on) return <X className="h-5 w-5 text-faint" />;
  return (
    <Check className={`h-5 w-5 ${muted ? "text-muted" : "text-emerald-400"}`} />
  );
}

export function Comparison() {
  return (
    <section className="mx-auto max-w-4xl px-6 py-24">
      <Reveal className="text-center">
        <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
          Same capability, <span className="text-gradient">different terms</span>
        </h2>
        <p className="mt-4 text-muted">
          Vivari is not a cheaper, weaker WebContainer. It runs the same class of
          project — and then lets you self-host it, embed it in a commercial
          product, and change it, with no licence to negotiate.
        </p>
      </Reveal>

      <Reveal className="mt-12">
        <div className="glass overflow-hidden rounded-2xl">
          <div className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-border px-4 py-4 text-sm font-medium sm:px-6">
            <span className="min-w-0 text-muted">Capability</span>
            <span className="text-gradient w-16 text-center sm:w-24">Vivari</span>
            <span className="w-16 text-center text-faint sm:w-24">Proprietary</span>
          </div>

          {GROUPS.map((group) => (
            <div key={group.title}>
              <div className="border-b border-border/60 bg-white/[0.02] px-4 py-3 sm:px-6">
                <span className="text-sm font-medium text-fg">{group.title}</span>
                <span className="ml-2 text-xs text-faint">{group.note}</span>
              </div>
              {group.rows.map((r) => (
                <div
                  key={r.label}
                  className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-border/60 px-4 py-3.5 text-sm last:border-0 sm:px-6"
                >
                  <span className="min-w-0 text-fg">{r.label}</span>
                  <span className="flex w-16 justify-center sm:w-24">
                    <Mark on={r.vivari} />
                  </span>
                  <span className="flex w-16 justify-center sm:w-24">
                    <Mark on={r.other} muted />
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </Reveal>
    </section>
  );
}
