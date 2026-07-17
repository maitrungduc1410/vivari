import { Check, X } from "lucide-react";
import { Reveal } from "./Reveal";

const ROWS = [
  { label: "Runs Node projects in-browser", vivari: true, other: true },
  { label: "MIT-licensed", vivari: true, other: false },
  { label: "Free for commercial use", vivari: true, other: false },
  { label: "No per-seat / usage fee", vivari: true, other: false },
  { label: "Self-host every asset", vivari: true, other: false },
  { label: "Fork it and ship it", vivari: true, other: false },
];

export function Comparison() {
  return (
    <section className="mx-auto max-w-4xl px-6 py-24">
      <Reveal className="text-center">
        <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
          Genuinely <span className="text-gradient">open</span>
        </h2>
        <p className="mt-4 text-muted">
          Unlike a proprietary WebContainer API, there is no commercial license or
          usage fee. Embed it, fork it, ship it.
        </p>
      </Reveal>

      <Reveal className="mt-12">
        <div className="glass overflow-hidden rounded-2xl">
          <div className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-border px-6 py-4 text-sm font-medium">
            <span className="text-muted">Capability</span>
            <span className="text-gradient w-24 text-center">Vivari</span>
            <span className="w-24 text-center text-faint">Proprietary</span>
          </div>
          {ROWS.map((r) => (
            <div
              key={r.label}
              className="grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-border/60 px-6 py-3.5 text-sm last:border-0"
            >
              <span className="text-fg">{r.label}</span>
              <span className="flex w-24 justify-center">
                {r.vivari ? (
                  <Check className="h-5 w-5 text-emerald-400" />
                ) : (
                  <X className="h-5 w-5 text-faint" />
                )}
              </span>
              <span className="flex w-24 justify-center">
                {r.other ? (
                  <Check className="h-5 w-5 text-muted" />
                ) : (
                  <X className="h-5 w-5 text-faint" />
                )}
              </span>
            </div>
          ))}
        </div>
      </Reveal>
    </section>
  );
}
