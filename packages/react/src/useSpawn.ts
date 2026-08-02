"use client";

// Run a command in the VM and observe it from React.
//
// This exists because the project's own React demo of running a Node process —
// sites/embed/src/scenarios/NodeTerminal.tsx — could not be built on
// @vivari/react at all. It imports @vivari/core directly and hand-writes the
// status enum, the spawn, the stdin writer, the output pipe, the exit await and
// the kill-on-unmount. All of that is below, once.

import { useCallback, useEffect, useRef, useState } from "react";
import type { SpawnOptions, Vivari as VivariInstance, VivariProcess } from "@vivari/core";
import { useVivariInstance } from "./context";

export type SpawnStatus = "idle" | "running" | "exited" | "error";

export interface UseSpawnOptions extends SpawnOptions {
  /** Run once as soon as an instance is ready, instead of waiting for `run()`. */
  auto?: boolean;
  /**
   * Accumulate output into `output`. Off by default, deliberately: `npm install`
   * emits thousands of chunks and a re-render per chunk is a perf disaster. Use
   * `onOutput` (zero re-renders) to feed a terminal; turn this on for a `<pre>`.
   */
  collect?: boolean;
  /** Every stdout/stderr chunk, as it arrives. The fast path — no re-render. */
  onOutput?: (chunk: string) => void;
  onExit?: (code: number) => void;
  onError?: (error: Error) => void;
  /** Act on this instance instead of the nearest `<VivariProvider>`'s. */
  vivari?: VivariInstance | null;
}

export interface UseSpawnResult {
  status: SpawnStatus;
  /** Accumulated output — always `""` unless you passed `collect: true`. */
  output: string;
  exitCode: number | null;
  error: Error | null;
  /** The live process while running, for anything this hook doesn't cover. */
  process: VivariProcess | null;
  /** Start (or restart) the command. Resolves with the exit code. */
  run: (overrides?: {
    command?: string;
    args?: string[];
    options?: SpawnOptions;
  }) => Promise<number | null>;
  /** Terminate the process. Its `exit` still resolves, so `status` reaches "exited". */
  kill: () => void;
  /** Write to the process's stdin. No-op when nothing is running. */
  write: (chunk: string) => void;
}

const NO_ARGS: string[] = [];

/**
 * Spawn `command` in the VM.
 *
 * `command`/`args` are read when a run starts, so an inline array is fine and
 * changing them does not restart anything — call `run()` for that. Any running
 * process is killed on unmount, which is the leak `<Vivari>` used to have.
 */
export function useSpawn(
  command: string,
  args: string[] = NO_ARGS,
  options: UseSpawnOptions = {},
): UseSpawnResult {
  const { auto = false, collect = false, onOutput, onExit, onError, vivari: explicit, ...spawnOptions } = options;
  const instance = useVivariInstance(explicit);

  const [status, setStatus] = useState<SpawnStatus>("idle");
  const [output, setOutput] = useState("");
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [process, setProcess] = useState<VivariProcess | null>(null);

  // Latest props parked in refs so `run`/`kill`/`write` keep a stable identity
  // (consumers put them in dependency arrays). Declared first so they are
  // current before the auto-run effect below fires.
  const cbs = useRef({ onOutput, onExit, onError });
  const latest = useRef({ command, args, spawnOptions, collect });
  const instanceRef = useRef(instance);
  useEffect(() => {
    cbs.current = { onOutput, onExit, onError };
    latest.current = { command, args, spawnOptions, collect };
    instanceRef.current = instance;
  });

  const procRef = useRef<VivariProcess | null>(null);
  const writerRef = useRef<WritableStreamDefaultWriter<string> | null>(null);
  const mounted = useRef(true);
  /** Supersedes an older run: its tail must not clobber the newer run's state. */
  const runSeq = useRef(0);

  // Collected output is batched: one setState per chunk would re-render the tree
  // thousands of times during an install. rAF is paused in a background tab, so
  // the exit path flushes synchronously rather than losing the tail.
  const buffer = useRef<string[]>([]);
  const flushHandle = useRef<number | null>(null);
  const flushNow = useCallback(() => {
    if (flushHandle.current !== null) {
      cancelAnimationFrame(flushHandle.current);
      flushHandle.current = null;
    }
    if (!buffer.current.length) return;
    const pending = buffer.current.join("");
    buffer.current.length = 0;
    if (mounted.current) setOutput((prev) => prev + pending);
  }, []);
  const scheduleFlush = useCallback(() => {
    if (flushHandle.current !== null) return;
    flushHandle.current = requestAnimationFrame(() => {
      flushHandle.current = null;
      flushNow();
    });
  }, [flushNow]);

  const kill = useCallback(() => {
    const p = procRef.current;
    if (!p) return;
    try {
      writerRef.current?.releaseLock();
    } catch {
      /* already released */
    }
    writerRef.current = null;
    // A killed process still resolves its `exit`, so the run() tail below is
    // what flips status to "exited" — nothing to update here.
    p.kill();
  }, []);

  const run = useCallback<UseSpawnResult["run"]>(
    async (overrides) => {
      const gen = ++runSeq.current;
      const vm = instanceRef.current;
      if (!vm) {
        const err = new Error(
          "useSpawn: no Vivari instance — wrap the tree in <VivariProvider> or pass `vivari`.",
        );
        setStatus("error");
        setError(err);
        cbs.current.onError?.(err);
        return null;
      }
      // A new run supersedes the old process, so two dev servers never fight
      // over the same port.
      kill();

      setStatus("running");
      setError(null);
      setExitCode(null);
      if (latest.current.collect) {
        buffer.current.length = 0;
        setOutput("");
      }

      let proc: VivariProcess;
      try {
        const l = latest.current;
        proc = await vm.spawn(
          overrides?.command ?? l.command,
          overrides?.args ?? l.args,
          overrides?.options ?? l.spawnOptions,
        );
      } catch (e) {
        if (gen !== runSeq.current) return null;
        const err = e instanceof Error ? e : new Error(String(e));
        setStatus("error");
        setError(err);
        cbs.current.onError?.(err);
        return null;
      }

      // Superseded, or unmounted while the spawn was in flight — don't leave an
      // orphan process running inside a VM nobody is watching.
      if (gen !== runSeq.current || !mounted.current) {
        proc.kill();
        return null;
      }
      procRef.current = proc;
      writerRef.current = null;
      setProcess(proc);

      void proc.output
        .pipeTo(
          new WritableStream({
            write: (chunk) => {
              if (gen !== runSeq.current) return;
              cbs.current.onOutput?.(chunk);
              if (latest.current.collect) {
                buffer.current.push(chunk);
                scheduleFlush();
              }
            },
          }),
        )
        .catch(() => {
          /* the stream is cancelled by kill(); that is not a failure */
        });

      const code = await proc.exit;
      if (gen !== runSeq.current) return code;
      flushNow();
      procRef.current = null;
      if (mounted.current) {
        setProcess(null);
        setExitCode(code);
        setStatus("exited");
      }
      cbs.current.onExit?.(code);
      return code;
    },
    [kill, flushNow, scheduleFlush],
  );

  const write = useCallback((chunk: string) => {
    const p = procRef.current;
    if (!p) return;
    // Lock stdin lazily: a consumer that never writes shouldn't hold a writer
    // (and shouldn't send EOF when the hook tears down).
    writerRef.current ??= p.input.getWriter();
    void writerRef.current.write(chunk).catch(() => {});
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (flushHandle.current !== null) cancelAnimationFrame(flushHandle.current);
      // Supersede first so the in-flight run() tail doesn't touch state, then
      // kill: an unmounted preview must not leave `npm run dev` running.
      runSeq.current++;
      kill();
    };
  }, [kill]);

  // `auto` runs once per instance — not once per command change, which would
  // make an inline args array restart the process on every render.
  const autoRanFor = useRef<VivariInstance | null>(null);
  useEffect(() => {
    if (!auto || !instance || autoRanFor.current === instance) return;
    autoRanFor.current = instance;
    void run();
  }, [auto, instance, run]);

  return { status, output, exitCode, error, process, run, kill, write };
}