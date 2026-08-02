"use client";

// A file in the VFS, as React state, with debounced write-behind.
//
// sites/embed/src/scenarios/ReactPreview.tsx hand-rolls exactly this (a ref, a
// clearTimeout, a 250 ms setTimeout around fs.writeFile, plus an immediate write
// for Cmd+S) — along with the bug that pattern always has: the pending write is
// never flushed, so the last edit before unmount is silently dropped.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Vivari as VivariInstance } from "@vivari/core";
import { useVivariInstance } from "./context";

export type VivariFileStatus = "idle" | "loading" | "saving" | "saved" | "error";

export interface UseVivariFileOptions {
  /** Write-behind delay in ms. `0` writes on every change. Default `250`. */
  debounce?: number;
  /** Written to the VFS when the file doesn't exist yet. */
  initialContents?: string;
  /** Act on this instance instead of the nearest `<VivariProvider>`'s. */
  vivari?: VivariInstance | null;
  onError?: (error: Error) => void;
}

export interface UseVivariFileHandle {
  status: VivariFileStatus;
  error: Error | null;
  /** Write now, cancelling any pending debounced write — the Cmd+S path. */
  save: () => Promise<void>;
  /** Re-read from the VFS, discarding unsaved local edits. */
  reload: () => Promise<void>;
}

/**
 * Read/write a UTF-8 file as React state.
 *
 *   const [source, setSource, { status, save }] = useVivariFile("/src/App.jsx");
 *
 * Text only, on purpose: binary content isn't editable as a React value, so read
 * it with `vivari.fs.readFile(path)` (no encoding) instead.
 */
export function useVivariFile(
  path: string,
  options: UseVivariFileOptions = {},
): [string, (next: string) => void, UseVivariFileHandle] {
  const { debounce = 250, initialContents, vivari: explicit, onError } = options;
  const instance = useVivariInstance(explicit);

  const [contents, setContents] = useState(initialContents ?? "");
  const [status, setStatus] = useState<VivariFileStatus>("idle");
  const [error, setError] = useState<Error | null>(null);

  const latest = useRef({ debounce, initialContents, onError });
  const instanceRef = useRef(instance);
  const mounted = useRef(true);
  useEffect(() => {
    latest.current = { debounce, initialContents, onError };
    instanceRef.current = instance;
  });

  /** The value awaiting a write, or `null` when there is nothing outstanding. */
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearTimer = useCallback(() => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
  }, []);

  const fail = useCallback((e: unknown) => {
    const err = e instanceof Error ? e : new Error(String(e));
    if (mounted.current) {
      setStatus("error");
      setError(err);
    }
    latest.current.onError?.(err);
  }, []);

  const save = useCallback(async () => {
    const vm = instanceRef.current;
    const next = pending.current;
    clearTimer();
    if (!vm || next === null) return;
    pending.current = null;
    if (mounted.current) setStatus("saving");
    try {
      await vm.fs.writeFile(path, next);
      if (mounted.current) {
        setStatus("saved");
        setError(null);
      }
    } catch (e) {
      fail(e);
    }
  }, [path, clearTimer, fail]);

  const reload = useCallback(async () => {
    const vm = instanceRef.current;
    if (!vm) return;
    pending.current = null;
    clearTimer();
    setStatus("loading");
    try {
      const text = await vm.fs.readFile(path, "utf-8");
      if (!mounted.current) return;
      setContents(text);
      setStatus("saved");
      setError(null);
    } catch (e) {
      fail(e);
    }
  }, [path, clearTimer, fail]);

  // `save` changes identity with `path`; routing the debounce through a ref keeps
  // `update` stable for consumers that hand it to a memoised editor.
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });

  const update = useCallback(
    (next: string) => {
      setContents(next);
      pending.current = next;
      clearTimer();
      if (latest.current.debounce <= 0) {
        void saveRef.current();
        return;
      }
      timer.current = setTimeout(() => {
        timer.current = undefined;
        void saveRef.current();
      }, latest.current.debounce);
    },
    [clearTimer],
  );

  // Flush a pending write on unmount and before switching paths. Cleanups run
  // before any effect in a commit, so this still sees the *previous* path's
  // `save` — the one holding the unwritten edit. Declared before the read effect
  // so `mounted` is back to true before that effect's async work can settle.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      void saveRef.current();
    };
  }, [path]);

  // Initial read. Creates the file from `initialContents` when it's missing, so
  // a playground can seed a scratch file without a separate mount step.
  useEffect(() => {
    const vm = instance;
    if (!vm) return;
    let cancelled = false;
    setStatus("loading");
    void (async () => {
      try {
        const exists = await vm.fs.exists(path);
        const seed = latest.current.initialContents;
        if (!exists && seed !== undefined) await vm.fs.writeFile(path, seed);
        const text = exists ? await vm.fs.readFile(path, "utf-8") : (seed ?? "");
        if (cancelled) return;
        setContents(text);
        setStatus("saved");
        setError(null);
      } catch (e) {
        if (!cancelled) fail(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [instance, path, fail]);

  const handle = useMemo<UseVivariFileHandle>(
    () => ({ status, error, save, reload }),
    [status, error, save, reload],
  );
  return [contents, update, handle];
}