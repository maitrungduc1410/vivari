import {
  FolderTree,
  Terminal as TerminalIcon,
  Globe,
  Cpu,
  Package,
  Share2,
} from "lucide-react";
import { Reveal } from "./Reveal";

const FEATURES = [
  {
    icon: FolderTree,
    title: "Real virtual filesystem",
    body: "A POSIX-ish VFS in Rust/Wasm: directories, stat/lstat, symlinks, rename, errno errors. Mirrored to OPFS so projects persist across reloads.",
  },
  {
    icon: Cpu,
    title: "Node-compatible runtime",
    body: "Synchronous CommonJS require with node_modules resolution, plus core builtins: fs, path, process, http, child_process and more.",
  },
  {
    icon: TerminalIcon,
    title: "A real process model",
    body: "A kernel with a PID table and a shell. Each command is its own worker/process; parents block on children via execSync over an Atomics bridge.",
  },
  {
    icon: Globe,
    title: "Virtual networking",
    body: "http.createServer().listen() runs inside a worker and a Service Worker previews it live in an iframe - with no network involved.",
  },
  {
    icon: Package,
    title: "Dependencies that cache",
    body: "node_modules is snapshotted keyed by the lockfile, so reopening a project restores deps from disk instead of reinstalling.",
  },
  {
    icon: Share2,
    title: "Import, export, share",
    body: "Import a public GitHub repo or npm package, drag in a local folder, export a .zip, or share a project as a self-contained link.",
  },
];

export function Features() {
  return (
    <section id="features" className="mx-auto max-w-7xl px-6 py-24">
      <Reveal className="mx-auto max-w-2xl text-center">
        <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
          A whole toolchain, <span className="text-gradient">client-side</span>
        </h2>
        <p className="mt-4 text-muted">
          Everything a Node project expects at runtime, reimplemented to run inside
          the browser tab.
        </p>
      </Reveal>

      <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {FEATURES.map((f, i) => (
          <Reveal key={f.title} delay={(i % 3) * 0.08}>
            <article className="group glass h-full rounded-2xl p-6 transition-all duration-300 hover:-translate-y-1 hover:border-brand/40">
              <div className="mb-4 inline-flex rounded-xl bg-white/5 p-3 text-brand-2 transition-colors group-hover:text-brand">
                <f.icon className="h-6 w-6" />
              </div>
              <h3 className="text-lg font-medium">{f.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{f.body}</p>
            </article>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
