# Vivari Studio

The primary UI for Vivari — a VS Code–style IDE that runs real Node
projects (Vite + React + HMR, NestJS `--watch`) entirely in the browser tab.

Stack: **Vite 8 + React 19 (React Compiler) + Tailwind v4 + shadcn/ui + lucide**,
scaffolded with **Bun**. Vite is the single toolchain and also bundles the
Vivari runtime workers + wasm.

## Run

From the repo root:

```bash
npm run dev            # studio dev server (Vite, http://localhost:5173)
npm run build:studio   # production build
npm run preview:studio # preview the production build
```

Or from this folder with Bun: `bun run dev` / `bun run build` / `bun run preview`.

The page must be **cross-origin isolated** (`SharedArrayBuffer`). `vite.config.ts`
sends `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
require-corp` on the dev and preview servers and stamps `Service-Worker-Allowed: /`
on `/sw.js` (the preview proxy needs root scope).

## How it fits together

- `src/vv/kernel.ts` — a thin re-export of `@vivari/core`'s `KernelBridge` (which
  spawns the kernel worker `packages/core/src/workers/kernel-worker.ts`, bundled
  by Vite along with its nested `fs` / `fetcher` / `process` workers and the
  `packages/{vfs,codec,crypto}/pkg` wasm), registers the preview Service Worker,
  and relays its HTTP requests into the VM) plus `resetVfs`. VFS whole-file lazy
  compression is always on; a clean slate is available from the Home screen's
  "Reset everything" button (wipes the OPFS-mirrored VFS + dependency cache).
- `src/vv/controller.ts` — `IdeController`: the imperative core (Monaco, xterm
  terminals, the demo "Run" flow via `VV_RUN`, preview) exposed as an external
  store that React reads via `useSyncExternalStore`.
- `src/vv/debug-session.ts` — the breakpoint debugger's CDP client for Node guest
  processes: sends/receives CDP over the kernel bridge and drives Monaco gutter
  breakpoints + the paused-line highlight. Enable "Debug mode" (sets `VV_DEBUG` for
  subsequent runs) and open "Run and Debug" from the ActivityBar. See the repo root
  `ARCHITECTURE.md` §7.2 for the full model.
- `src/vv/editor-status.ts` — cursor / indentation / language-mode readouts for the
  status bar, fed by Monaco listeners in the controller. A store of its own (not
  `IdeSnapshot`) so a cursor move doesn't re-render the whole IDE.
- `src/components/ide/*` — the chrome: AppShell, ActivityBar, Explorer,
  EditorGroup, TerminalPanel, PreviewPanel, StatusBar (+ StatusBarPickers: Go to
  Line, indentation, language mode), CommandPalette, DebugPanel
  (Call Stack / Variables / Watch / Breakpoints).

The kernel/worker files now live in the `@vivari/core` SDK
(`packages/core/src/workers/*.js`) — studio is just their first consumer, via the
`@vivari/core` Vite alias. See the repo root `ARCHITECTURE.md` for the full model,
and `packages/core/README.md` for the embeddable SDK.