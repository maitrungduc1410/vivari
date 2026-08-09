import { useRef } from "react";
import { motion, useReducedMotion } from "motion/react";
import { TechIcon } from "./techIcons";
import { RUNTIME_DEFS, type RuntimeId } from "@/runtimes";

// The hero's runtime switcher. A real tablist, not a row of clickable divs:
//
//  - `role="tablist"` / `role="tab"` / `aria-selected`, with `aria-controls`
//    pointing at the Workspace, which carries the matching `role="tabpanel"`.
//  - Roving tabindex: exactly one tab is in the tab order, so a keyboard user
//    tabs INTO the group once and then moves within it with the arrow keys
//    rather than tabbing through three separate stops.
//  - Left/Right (plus Home/End) move focus and selection together. Automatic
//    activation is the right call here because switching panels is free: the
//    Workspace is a mock and loads nothing.
//  - Focus is visible on its own terms (`focus-visible:ring`), so the control is
//    usable when the selected state is not the focused one.
//
// The sliding pill behind the active tab is `layoutId`, which motion animates
// between tabs. It is decorative: `useReducedMotion` drops the transition to
// zero so the pill jumps instead of sliding, and selection still reads
// correctly from the text colour and `aria-selected`.

export function RuntimeTabs({
  value,
  onChange,
  idPrefix,
}: {
  value: RuntimeId;
  onChange: (id: RuntimeId) => void;
  idPrefix: string;
}) {
  const reduce = useReducedMotion();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    const last = RUNTIME_DEFS.length - 1;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (e.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next === null) return;
    e.preventDefault();
    onChange(RUNTIME_DEFS[next].id);
    refs.current[next]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label="Choose a runtime"
      className="glass inline-flex items-center gap-1 rounded-xl p-1"
    >
      {RUNTIME_DEFS.map((r, i) => {
        const selected = r.id === value;
        return (
          <button
            key={r.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            role="tab"
            id={`${idPrefix}-tab-${r.id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(r.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={`relative inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bg ${
              selected ? "text-fg" : "text-muted hover:text-fg"
            }`}
          >
            {selected && (
              <motion.span
                layoutId={`${idPrefix}-runtime-pill`}
                transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 380, damping: 32 }}
                className="absolute inset-0 -z-10 rounded-lg bg-white/10"
              />
            )}
            <TechIcon slug={r.icon} className="h-4 w-4 shrink-0" />
            {r.label}
            {r.tag && (
              <span className="rounded-full bg-brand/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-brand-2">
                {r.tag}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
