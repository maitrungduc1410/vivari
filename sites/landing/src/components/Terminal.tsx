import { useEffect, useRef, useState } from "react";

type Line =
  | { kind: "cmd"; text: string }
  | { kind: "out"; text: string; tone?: "muted" | "ok" | "url" };

const SCRIPT: Line[] = [
  { kind: "cmd", text: "npm install" },
  { kind: "out", text: "added 214 packages in 1.8s", tone: "muted" },
  { kind: "cmd", text: "npm run dev" },
  { kind: "out", text: "VITE v8  ready in 92 ms", tone: "ok" },
  { kind: "out", text: "-> Local:  preview ready", tone: "url" },
  { kind: "out", text: "running 100% in your browser - no server", tone: "ok" },
];

const TYPE_MS = 34;
const LINE_PAUSE = 520;

// A self-driving fake terminal: types each command character-by-character, then
// reveals its output, loops forever. Cosmetic only - the real thing is /studio.
export function Terminal() {
  const [visible, setVisible] = useState<Line[]>([]);
  const [typed, setTyped] = useState("");
  const [idx, setIdx] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const line = SCRIPT[idx % SCRIPT.length];

    if (idx >= SCRIPT.length) {
      timer = setTimeout(() => {
        setVisible([]);
        setTyped("");
        setIdx(0);
      }, 2600);
      return () => clearTimeout(timer);
    }

    if (line.kind === "out") {
      timer = setTimeout(() => {
        setVisible((v) => [...v, line]);
        setIdx((i) => i + 1);
      }, LINE_PAUSE);
      return () => clearTimeout(timer);
    }

    if (typed.length < line.text.length) {
      timer = setTimeout(() => setTyped(line.text.slice(0, typed.length + 1)), TYPE_MS);
    } else {
      timer = setTimeout(() => {
        setVisible((v) => [...v, line]);
        setTyped("");
        setIdx((i) => i + 1);
      }, LINE_PAUSE);
    }
    return () => clearTimeout(timer);
  }, [idx, typed]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [visible, typed]);

  const activeIsCmd = idx < SCRIPT.length && SCRIPT[idx].kind === "cmd";

  return (
    <div className="glass overflow-hidden rounded-xl shadow-2xl shadow-black/50">
      <div className="flex items-center gap-2 border-b border-border bg-white/[0.02] px-4 py-3">
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        <span className="ml-3 font-mono text-xs text-faint">vivari - zsh</span>
      </div>
      <div
        ref={scroller}
        className="h-56 space-y-1 overflow-hidden p-4 font-mono text-[13px] leading-relaxed"
      >
        {visible.map((l, i) => (
          <Row key={i} line={l} />
        ))}
        {activeIsCmd && (
          <div className="flex">
            <span className="mr-2 text-brand-2">&#10095;</span>
            <span className="text-fg">{typed}</span>
            <span className="ml-0.5 inline-block w-2 animate-pulse bg-fg">&nbsp;</span>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ line }: { line: Line }) {
  if (line.kind === "cmd") {
    return (
      <div className="flex">
        <span className="mr-2 text-brand-2">&#10095;</span>
        <span className="text-fg">{line.text}</span>
      </div>
    );
  }
  const tone =
    line.tone === "ok"
      ? "text-emerald-400"
      : line.tone === "url"
        ? "text-brand-2"
        : "text-muted";
  return <div className={`pl-5 ${tone}`}>{line.text}</div>;
}
