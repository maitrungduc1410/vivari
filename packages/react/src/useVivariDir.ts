"use client";

// A live directory listing.
//
// Every IDE-shaped consumer needs this: studio re-reads each loaded directory
// whenever the VFS changes (packages/studio/src/components/ide/Explorer.tsx
// keys an effect on a `treeVersion` counter bumped by `vv-fs-changed`). Until
// core exposed `fs.watch`, the only way to hear about a change from React was
// the kernel-bridge escape hatch.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DirEnt, Vivari as VivariInstance } from "@vivari/core";
import { useVivariInstance } from "./context";

export type VivariDirStatus = "idle" | "loading" | "ready" | "error";

export interface UseVivariDirOptions {
  /**
   * Coalesce filesystem events before re-reading, in ms. Core reports every
   * change with no coalescing — a single `npm install` fires thousands — so this
   * is what keeps an install from re-rendering the tree thousands of times.
   */
  debounce?: number;
  /** Act on this instance instead of the nearest `<VivariProvider>`'s. */
  vivari?: VivariInstance | null;
  onError?: (error: Error) => void;
}

export interface UseVivariDirResult {
  entries: DirEnt[];
  status: VivariDirStatus;
  error: Error | null;
  /** Re-read now, ignoring the debounce. */
  refresh: () => Promise<void>;
}

const NO_ENTRIES: DirEnt[] = [];

/**
 * List `path`, and keep the listing current as the VFS changes underneath it.
 *
 *   const { entries, status } = useVivariDir("/src");
 *
 * The watch is non-recursive: only entries appearing, disappearing or changing
 * directly inside `path` can alter this listing, so a deep write doesn't wake it.
 */
export function useVivariDir(
  path: string,
  options: UseVivariDirOptions = {},
): UseVivariDirResult {
  const { debounce = 100, vivari: explicit, onError } = options;
  const instance = useVivariInstance(explicit);

  const [entries, setEntries] = useState<DirEnt[]>(NO_ENTRIES);
  const [status, setStatus] = useState<VivariDirStatus>("idle");
  const [error, setError] = useState<Error | null>(null);

  const latest = useRef({ debounce, onError });
  const instanceRef = useRef(instance);
  const mounted = useRef(true);
  useEffect(() => {
    latest.current = { debounce, onError };
    instanceRef.current = instance;
  });

  /** Supersedes an in-flight read, so a slow one can't overwrite a newer listing. */
  const readSeq = useRef(0);

  const refresh = useCallback(async () => {
    const vm = instanceRef.current;
    if (!vm) return;
    const gen = ++readSeq.current;
    try {
      const next = await vm.fs.readdir(path, { withFileTypes: true });
      if (!mounted.current || gen !== readSeq.current) return;
      setEntries(next);
      setStatus("ready");
      setError(null);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (mounted.current && gen === readSeq.current) {
        setStatus("error");
        setError(err);
      }
      latest.current.onError?.(err);
    }
  }, [path]);

  const refreshRef = useRef(refresh);
  useEffect(() => {
    refreshRef.current = refresh;
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!instance) return;
    setStatus("loading");
    void refresh();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const watcher = instance.fs.watch(path, { recursive: false }, () => {
      if (latest.current.debounce <= 0) {
        void refreshRef.current();
        return;
      }
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void refreshRef.current();
      }, latest.current.debounce);
    });

    return () => {
      if (timer !== undefined) clearTimeout(timer);
      watcher.close();
    };
  }, [instance, path, refresh]);

  return useMemo(
    () => ({ entries, status, error, refresh }),
    [entries, status, error, refresh],
  );
}