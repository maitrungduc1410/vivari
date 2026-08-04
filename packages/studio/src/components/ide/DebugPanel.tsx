import { useState, useSyncExternalStore } from "react";
import Play from "~icons/lucide/play";
import Pause from "~icons/lucide/pause";
import ArrowRight from "~icons/lucide/arrow-right";
import ArrowDown from "~icons/lucide/arrow-down";
import ArrowUp from "~icons/lucide/arrow-up";
import ChevronRight from "~icons/lucide/chevron-right";
import ChevronDown from "~icons/lucide/chevron-down";
import Circle from "~icons/lucide/circle";
import Bug from "~icons/lucide/bug";
import X from "~icons/lucide/x";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIde } from "./useIde";
import type { DebugScopeVar } from "@/vv/debug-session";

const baseName = (p: string) => p.split("/").pop() || p;

export function DebugPanel() {
  const { c } = useIde();
  const dbg = c.debug;
  const snap = useSyncExternalStore(dbg.subscribe, dbg.getSnapshot);

  const controlsDisabled = !snap.paused;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-sidebar text-sm">
      {/* header */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Bug className="size-4" />
        <span className="flex-1">Run and Debug</span>
      </div>

      {/* enable toggle */}
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="text-xs text-muted-foreground">
          Debug mode {snap.enabled ? "on" : "off"}
        </span>
        <button
          role="switch"
          aria-checked={snap.enabled}
          // The "Debug mode on/off" text is a sibling, not a child, so the switch
          // itself had no name. `aria-checked` already carries the on/off part.
          aria-label="Debug mode"
          onClick={() => dbg.setEnabled(!snap.enabled)}
          className={cn(
            "relative h-5 w-9 rounded-full transition-colors",
            snap.enabled ? "bg-primary" : "bg-muted",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 size-4 rounded-full bg-white transition-all",
              snap.enabled ? "left-[1.125rem]" : "left-0.5",
            )}
          />
        </button>
      </div>

      {!snap.enabled && (
        <div className="p-3 text-xs leading-relaxed text-muted-foreground">
          Turn on debug mode, then <span className="font-medium text-foreground">Run</span> a
          project. Node guest processes launch with breakpoints enabled — click the editor gutter
          to set one, and execution will pause here with a live call stack and variables.
        </div>
      )}

      {snap.enabled && (
        <>
          {/* toolbar */}
          <div className="flex shrink-0 items-center gap-0.5 border-b px-2 py-1.5">
            <CtrlBtn label="Continue (F5)" onClick={() => dbg.resume()} disabled={controlsDisabled}>
              <Play className="size-4" />
            </CtrlBtn>
            <CtrlBtn label="Step Over (F10)" onClick={() => dbg.stepOver()} disabled={controlsDisabled}>
              <ArrowRight className="size-4" />
            </CtrlBtn>
            <CtrlBtn label="Step Into (F11)" onClick={() => dbg.stepInto()} disabled={controlsDisabled}>
              <ArrowDown className="size-4" />
            </CtrlBtn>
            <CtrlBtn label="Step Out (Shift+F11)" onClick={() => dbg.stepOut()} disabled={controlsDisabled}>
              <ArrowUp className="size-4" />
            </CtrlBtn>
            <CtrlBtn label="Pause" onClick={() => dbg.pause()} disabled={snap.paused || snap.activePid == null}>
              <Pause className="size-4" />
            </CtrlBtn>
            <div className="ml-auto flex items-center gap-1 pr-1 text-[11px] text-muted-foreground">
              <span
                className={cn(
                  "inline-block size-2 rounded-full",
                  snap.activePid == null ? "bg-muted-foreground/40" : snap.paused ? "bg-amber-500" : "bg-green-500",
                )}
              />
              {snap.activePid == null ? "no target" : snap.paused ? "paused" : "running"}
            </div>
          </div>

          {/* target selector */}
          {snap.targets.length > 0 && (
            <div className="border-b px-3 py-1.5">
              <label className="text-[11px] uppercase tracking-wide text-muted-foreground">Target</label>
              <select
                className="mt-1 w-full rounded border bg-background px-2 py-1 text-xs"
                value={snap.activePid ?? ""}
                onChange={(e) => dbg.selectTarget(Number(e.target.value))}
              >
                {snap.targets.map((t) => (
                  <option key={t.pid} value={t.pid}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto">
            <CallStack />
            <Variables />
            <Watch />
            <Breakpoints />
          </div>
        </>
      )}
    </div>
  );
}

function CtrlBtn({
  label, onClick, disabled, children,
}: {
  label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className={cn(
          "flex size-7 items-center justify-center rounded text-foreground transition-colors hover:bg-accent",
          disabled && "cursor-not-allowed opacity-40 hover:bg-transparent",
        )}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

function Section({
  title, defaultOpen = true, children,
}: {
  title: string; defaultOpen?: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-1 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {title}
      </button>
      {open && <div className="pb-1">{children}</div>}
    </div>
  );
}

function CallStack() {
  const { c } = useIde();
  const dbg = c.debug;
  const snap = useSyncExternalStore(dbg.subscribe, dbg.getSnapshot);
  return (
    <Section title="Call Stack">
      {snap.callFrames.length === 0 ? (
        <div className="px-3 py-1 text-xs text-muted-foreground">Not paused.</div>
      ) : (
        snap.callFrames.map((f, i) => (
          <button
            key={f.callFrameId}
            onClick={() => dbg.selectFrame(i)}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-accent",
              i === snap.selectedFrame && "bg-accent/70",
            )}
          >
            <span className="truncate font-medium">{f.functionName}</span>
            <span className="ml-auto shrink-0 text-muted-foreground">
              {baseName(f.path)}:{f.line}
            </span>
          </button>
        ))
      )}
    </Section>
  );
}

function Variables() {
  const { c } = useIde();
  const dbg = c.debug;
  const snap = useSyncExternalStore(dbg.subscribe, dbg.getSnapshot);
  return (
    <Section title="Variables">
      {!snap.paused ? (
        <div className="px-3 py-1 text-xs text-muted-foreground">Run to a breakpoint to inspect variables.</div>
      ) : (
        snap.scopes.map((s, i) => (
          <div key={i}>
            <div className="px-3 py-1 text-[11px] font-semibold uppercase text-muted-foreground">{s.name}</div>
            {s.vars == null ? (
              <div className="px-4 py-1 text-xs text-muted-foreground">…</div>
            ) : s.vars.length === 0 ? (
              <div className="px-4 py-1 text-xs text-muted-foreground">(no variables)</div>
            ) : (
              s.vars.map((v) => <VarNode key={v.name} v={v} depth={0} />)
            )}
          </div>
        ))
      )}
    </Section>
  );
}

function VarNode({ v, depth }: { v: DebugScopeVar; depth: number }) {
  const { c } = useIde();
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<DebugScopeVar[] | null>(null);
  const toggle = async () => {
    if (!v.expandable || !v.objectId) return;
    const next = !open;
    setOpen(next);
    if (next && children == null) setChildren(await c.debug.getProperties(v.objectId));
  };
  return (
    <div>
      <div
        className={cn(
          "flex items-center gap-1 py-0.5 pr-2 text-xs hover:bg-accent",
          // Only an expandable node does anything on click — `toggle` bails otherwise.
          v.expandable && v.objectId ? "cursor-pointer" : "cursor-default",
        )}
        style={{ paddingLeft: 12 + depth * 12 }}
        onClick={toggle}
      >
        {v.expandable ? (
          open ? <ChevronDown className="size-3 shrink-0" /> : <ChevronRight className="size-3 shrink-0" />
        ) : (
          <span className="inline-block size-3 shrink-0" />
        )}
        <span className="shrink-0 text-sky-600 dark:text-sky-400">{v.name}</span>
        <span className="text-muted-foreground">:</span>
        <span className="truncate text-foreground">{v.value}</span>
      </div>
      {open && children && children.map((ch) => <VarNode key={ch.name} v={ch} depth={depth + 1} />)}
    </div>
  );
}

function Watch() {
  const { c } = useIde();
  const dbg = c.debug;
  const snap = useSyncExternalStore(dbg.subscribe, dbg.getSnapshot);
  const [expr, setExpr] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const submit = async () => {
    if (!expr.trim()) return;
    setResult(await dbg.evaluate(expr.trim()));
  };
  return (
    <Section title="Watch / Evaluate" defaultOpen={false}>
      <div className="px-3 py-1">
        <div className="flex gap-1">
          <input
            className="min-w-0 flex-1 rounded border bg-background px-2 py-1 text-xs font-mono"
            placeholder={snap.paused ? "expression in current frame" : "expression (global)"}
            value={expr}
            onChange={(e) => setExpr(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <button onClick={submit} className="rounded border px-2 text-xs hover:bg-accent">
            Eval
          </button>
        </div>
        {result != null && (
          <div className="mt-1 break-all rounded bg-muted/50 px-2 py-1 font-mono text-xs">{result}</div>
        )}
      </div>
    </Section>
  );
}

function Breakpoints() {
  const { c } = useIde();
  const dbg = c.debug;
  const snap = useSyncExternalStore(dbg.subscribe, dbg.getSnapshot);
  const entries = Object.entries(snap.breakpoints).flatMap(([path, lines]) =>
    lines.map((line) => ({ path, line })),
  );
  return (
    <Section title="Breakpoints">
      {entries.length === 0 ? (
        <div className="px-3 py-1 text-xs text-muted-foreground">Click the editor gutter to add a breakpoint.</div>
      ) : (
        entries.map(({ path, line }) => (
          <div key={path + ":" + line} className="group flex items-center gap-2 px-3 py-0.5 text-xs hover:bg-accent">
            <Circle className="size-2.5 shrink-0 fill-red-500 text-red-500" />
            <button
              className="min-w-0 flex-1 truncate text-left hover:underline"
              onClick={() => void c.openFileAt(path, line)}
              title={`${path}:${line}`}
            >
              {baseName(path)}:{line}
            </button>
            <button
              className="opacity-0 group-hover:opacity-100"
              onClick={() => dbg.toggleBreakpoint(path, line)}
              title="Remove breakpoint"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))
      )}
    </Section>
  );
}