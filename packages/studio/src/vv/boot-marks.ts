// The studio's boot timeline, in a form a machine can read.
//
// `scripts/measure-studio-boot.mjs` needs to know when the app's JS started
// running, when the kernel came online, and when a project's preview actually
// painted. None of those are observable from the network waterfall: the kernel
// comes online after three Wasm modules and an OPFS restore finish in workers,
// and the preview iframe's `load` fires for the boot page too. Before this
// module the harness scraped `document.body.innerText` for the terminal's
// "Kernel ready." line, which is a rendering detail of the boot console — it
// silently reported `null` for the whole milestone once the console stopped
// being mounted on Home.
//
// Two sinks, because they answer different questions:
//   - `performance.mark`, so the marks show up in a DevTools/Lighthouse trace
//     next to the browser's own navigation timings with no extra plumbing.
//   - `window.__vvBoot`, an append-only array the harness reads in one
//     `Runtime.evaluate`. Marks alone would do, but the User Timing buffer is
//     capped and clearable by anything on the page, and a measurement rig must
//     not depend on nobody having called `performance.clearMarks()`.
//
// Cheap enough to leave in production (one `performance.now()` per milestone,
// six milestones), and it has to be: the deploy is the thing worth measuring,
// and a marker that only exists in dev measures a different app.

/** Milestones on the path from navigation to a usable project. */
export type BootMark =
  /** The entry bundle has parsed and is about to mount React. */
  | "js-executed"
  /** Kernel + VFS are up; Home unlocks. Earlier than the kernel's `ready`. */
  | "kernel-online"
  /** Every vendored asset is unpacked and the shell is live. */
  | "kernel-ready"
  /** A project's install/dev command has been handed to a terminal. */
  | "install-start"
  /** A dev server bound a port and the preview tab now points at it. */
  | "preview-open"
  /** That preview's iframe finished loading — the first frame a user sees. */
  | "preview-paint";

export interface BootMarkEntry {
  name: BootMark;
  /** ms since `timeOrigin`, i.e. the same clock as `performance.now()`. */
  t: number;
}

declare global {
  interface Window {
    __vvBoot?: BootMarkEntry[];
  }
}

// First mark wins. `install-start` and `preview-paint` can each fire again for
// a second project in the same tab, and a timeline whose milestones move
// backwards is worse than one that stops — the harness measures the first run.
const seen = new Set<BootMark>();

export function markBoot(name: BootMark): void {
  if (typeof performance === "undefined" || seen.has(name)) return;
  seen.add(name);
  const t = performance.now();
  try {
    performance.mark("vv:" + name);
  } catch {
    /* User Timing is unavailable or the buffer is full — the array still has it. */
  }
  const w = window as Window;
  (w.__vvBoot ??= []).push({ name, t });
}
