import { useState } from "react";
import { ArrowUpRight } from "lucide-react";
import { Reveal } from "./Reveal";
import { highlight } from "@/lib/highlight";
import { site } from "@/site";

const SNIPPETS = {
  core: `import { Vivari } from "@vivari/core";

const vivari = await Vivari.boot();
await vivari.mount({
  "package.json": { file: { contents: '{ "type": "module" }' } },
  "index.js": { file: { contents: "console.log('hello from the browser')" } },
});

const proc = await vivari.spawn("node", ["index.js"]);
proc.output.pipeTo(new WritableStream({ write: (c) => console.log(c) }));
await proc.exit;`,
  react: `import { Vivari } from "@vivari/react";

export function Playground() {
  return (
    <Vivari
      files={tree}
      run="npm run dev"
      style={{ width: "100%", height: 480 }}
    />
  );
}`,
} as const;

type Tab = keyof typeof SNIPPETS;

export function Embed() {
  const [tab, setTab] = useState<Tab>("core");

  return (
    <section id="embed" className="mx-auto max-w-7xl px-6 py-24">
      <Reveal className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
          Embed it in <span className="text-gradient">a few lines</span>
        </h2>
        <p className="mt-4 text-muted">
          The same runtime that powers the Studio ships as an embeddable SDK —
          framework-agnostic core, plus first-class React bindings.
        </p>
      </Reveal>

      <Reveal className="mx-auto mt-12 max-w-3xl">
        <div className="glass overflow-hidden rounded-2xl">
          <div className="flex items-center gap-1 border-b border-border bg-white/[0.02] p-2">
            {(Object.keys(SNIPPETS) as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-lg px-3.5 py-1.5 font-mono text-sm transition-colors ${
                  tab === t ? "bg-white/10 text-fg" : "text-muted hover:text-fg"
                }`}
              >
                {t === "core" ? "@vivari/core" : "@vivari/react"}
              </button>
            ))}
          </div>
          <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed">
            <code className="text-fg">{highlight(SNIPPETS[tab])}</code>
          </pre>
        </div>

        <div className="mt-6 text-center">
          <a
            href={`${site.docsUrl}getting-started`}
            className="group inline-flex items-center gap-1 text-sm font-medium text-brand-2 hover:text-fg"
          >
            Full getting-started guide
            <ArrowUpRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
          </a>
        </div>
      </Reveal>
    </section>
  );
}
