"use client";

// Boot (or join) a Vivari instance from React.
//
// A WebContainer is a *page* resource — a kernel Worker, its nested
// fs/fetcher/process workers, a Rust/Wasm VFS and a Service Worker registration
// — not a per-component one. So instances live in a module-level, ref-counted
// registry keyed by `instanceKey`: sibling components share one kernel, and
// React StrictMode's mount → unmount → mount boots exactly once. Studio reached
// the same conclusion independently with a module singleton (see
// packages/studio/src/components/ide/useIde.ts).

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { Vivari, isCrossOriginIsolated, type BootOptions } from "@vivari/core";

/**
 * Why Vivari cannot run here at all. Distinct from `error` on purpose: an
 * `error` might clear on retry, an `unsupported` page needs a server-config fix
 * the consumer has to make, so an embedder should render the header recipe
 * instead of a generic "something went wrong".
 */
export type VivariUnsupportedReason = "not-cross-origin-isolated" | "no-web-workers";

/** The boot lifecycle as a discriminated union — `status` narrows `vivari`. */
export type VivariState =
  | { status: "idle"; vivari: null; error: null }
  | { status: "booting"; vivari: null; error: null }
  | { status: "ready"; vivari: Vivari; error: null }
  | { status: "error"; vivari: null; error: Error }
  | { status: "unsupported"; vivari: null; error: Error; reason: VivariUnsupportedReason };

export type VivariStatus = VivariState["status"];

export type UseVivariResult = VivariState & {
  /** The registry key this result is bound to. */
  instanceKey: string;
  /** Start booting. No-op while already booting or ready. */
  boot: () => void;
  /** Tear the instance down and boot a fresh one with the latest options. */
  restart: () => void;
};

export interface UseVivariOptions extends BootOptions {
  /**
   * Instances are shared and ref-counted per key. Two components with the same
   * key share one kernel; a second key boots a second kernel (rarely what you
   * want — each one costs a full worker tree). Default `"default"`.
   */
  instanceKey?: string;
  /**
   * Boot on mount (default). Pass `false` to defer until you call `boot()` —
   * use it for a playground below the fold, so a visitor who never scrolls
   * never pays for a kernel.
   */
  autoBoot?: boolean;
}

// ── the registry ────────────────────────────────────────────────────────────

const IDLE: VivariState = { status: "idle", vivari: null, error: null };
const BOOTING: VivariState = { status: "booting", vivari: null, error: null };

interface Entry {
  refs: number;
  /** The in-flight boot; also the generation token, since a restart nulls it. */
  promise: Promise<Vivari> | null;
  state: VivariState;
  /** Pending deferred teardown — see the unmount path below. */
  release: ReturnType<typeof setTimeout> | null;
  listeners: Set<() => void>;
}

const registry = new Map<string, Entry>();

function entryFor(key: string): Entry {
  let e = registry.get(key);
  if (!e) {
    e = { refs: 0, promise: null, state: IDLE, release: null, listeners: new Set() };
    registry.set(key, e);
  }
  return e;
}

function publish(e: Entry, state: VivariState) {
  e.state = state;
  // Copy: a listener may unsubscribe (React does, on unmount) while we notify.
  for (const l of [...e.listeners]) l();
}

// Both checks are page-level facts that a retry cannot change, which is why they
// gate `boot()` rather than being left to reject inside it. The wording mirrors
// core's own error (packages/core/src/vivari.ts) so the two never drift.
const UNSUPPORTED_MESSAGE: Record<VivariUnsupportedReason, string> = {
  "not-cross-origin-isolated":
    "Vivari requires a cross-origin isolated page (SharedArrayBuffer). Serve your page with " +
    "the headers `Cross-Origin-Opener-Policy: same-origin` and " +
    "`Cross-Origin-Embedder-Policy: require-corp`.",
  "no-web-workers":
    "Vivari requires Web Workers, which this environment does not provide.",
};

/** The single place to extend when core lands `VivariError` with typed codes. */
function unsupportedReason(): VivariUnsupportedReason | null {
  if (typeof Worker === "undefined") return "no-web-workers";
  if (!isCrossOriginIsolated()) return "not-cross-origin-isolated";
  return null;
}

function startBoot(e: Entry, options: BootOptions) {
  if (e.promise || e.state.status === "ready") return;

  const reason = unsupportedReason();
  if (reason) {
    publish(e, {
      status: "unsupported",
      vivari: null,
      error: new Error(UNSUPPORTED_MESSAGE[reason]),
      reason,
    });
    return;
  }

  const p = Vivari.boot(options);
  e.promise = p;
  publish(e, BOOTING);
  p.then(
    (v) => {
      // Superseded by a restart, or every consumer unmounted while we booted.
      if (e.promise !== p || e.refs === 0) {
        v.teardown();
        if (e.promise === p) {
          e.promise = null;
          publish(e, IDLE);
        }
        return;
      }
      publish(e, { status: "ready", vivari: v, error: null });
    },
    (err: unknown) => {
      if (e.promise !== p) return;
      e.promise = null;
      publish(e, {
        status: "error",
        vivari: null,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    },
  );
}

function dispose(key: string, e: Entry) {
  if (e.state.status === "ready") e.state.vivari.teardown();
  e.promise = null; // invalidates any in-flight boot (see the guard above)
  publish(e, IDLE);
  if (e.refs === 0 && e.listeners.size === 0) registry.delete(key);
}

/**
 * Boot (or join) a Vivari instance for the lifetime of the component.
 *
 * The instance is shared and ref-counted per `instanceKey`, so StrictMode's
 * double-mount, an `<Activity>` toggle and sibling components all reuse one
 * kernel. Boot options are read when the boot actually starts; later changes
 * apply on the next `restart()`.
 */
export function useVivari(options: UseVivariOptions = {}): UseVivariResult {
  const { instanceKey = "default", autoBoot = true, ...bootOptions } = options;

  // An inline options object gets a new identity every render; parking it in a
  // ref is what stops that from re-triggering anything. Declared FIRST so it is
  // already current by the time the mount effect below runs.
  const latest = useRef<BootOptions>(bootOptions);
  useEffect(() => {
    latest.current = bootOptions;
  });

  const subscribe = useCallback(
    (cb: () => void) => {
      const e = entryFor(instanceKey);
      e.listeners.add(cb);
      return () => {
        e.listeners.delete(cb);
      };
    },
    [instanceKey],
  );

  // useSyncExternalStore, not useState: a boot that resolves after unmount just
  // updates the store and React never reads it, so there is no
  // "setState after unmount" path left to get wrong. getSnapshot stays
  // side-effect-free (no entryFor) because it runs during render.
  const state = useSyncExternalStore(
    subscribe,
    useCallback(() => registry.get(instanceKey)?.state ?? IDLE, [instanceKey]),
    () => IDLE, // server snapshot: nothing boots during SSR/prerender
  );

  useEffect(() => {
    const e = entryFor(instanceKey);
    e.refs++;
    if (e.release) {
      clearTimeout(e.release);
      e.release = null;
    }
    if (autoBoot) startBoot(e, latest.current);

    return () => {
      e.refs--;
      if (e.refs > 0) return;
      // Deferred: StrictMode (and <Activity>) unmount and immediately remount
      // within the same task, and tearing the kernel down in between is exactly
      // what causes a double boot. A real unmount still disposes a tick later.
      e.release = setTimeout(() => {
        e.release = null;
        if (e.refs === 0) dispose(instanceKey, e);
      }, 0);
    };
  }, [instanceKey, autoBoot]);

  const boot = useCallback(() => {
    startBoot(entryFor(instanceKey), latest.current);
  }, [instanceKey]);

  const restart = useCallback(() => {
    const e = entryFor(instanceKey);
    dispose(instanceKey, e);
    startBoot(e, latest.current);
  }, [instanceKey]);

  // Stable identity: safe to drop straight into a context value.
  return useMemo(
    () => ({ ...state, instanceKey, boot, restart }),
    [state, instanceKey, boot, restart],
  );
}