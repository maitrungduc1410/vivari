"use client";

// The drop-in embed: boot, mount files, install, run, preview.
//
// It is now a thin composition of useVivari + <VivariPreview> rather than a
// closed widget, so anything it does you can also do yourself. Pass `children`
// (a node or a render prop) to take over rendering entirely and still get the
// boot + install + run orchestration.

import {
  forwardRef,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type IframeHTMLAttributes,
  type ReactNode,
} from "react";
import type {
  BootOptions,
  FileSystemTree,
  Vivari as VivariInstance,
  VivariProcess,
} from "@vivari/core";
import { useVivariContext } from "./context";
import { useVivari, type UseVivariResult, type VivariUnsupportedReason } from "./useVivari";
import { VivariPreview } from "./VivariPreview";

/** Which step of the embed's lifecycle failed. */
export type VivariPhase = "unsupported" | "boot" | "mount" | "install" | "run";

export type VivariFailure =
  | { phase: "unsupported"; error: Error; reason: VivariUnsupportedReason }
  | { phase: "boot" | "mount" | "install" | "run"; error: Error; reason?: undefined };

export interface VivariProps
  // Real iframe props (id, className, style, allow, sandbox, loading, …) reach
  // the frame instead of being swallowed. `onError` is ours, not the DOM's.
  extends Omit<IframeHTMLAttributes<HTMLIFrameElement>, "src" | "children" | "onError"> {
  /** Boot options for the underlying kernel. */
  boot?: BootOptions;
  /** Share a kernel with the rest of the tree. Defaults to the enclosing provider's. */
  instanceKey?: string;
  /** `false` defers the boot until the render prop's `boot()` is called. */
  autoBoot?: boolean;
  /** Files to mount into the VM before running commands. */
  files?: FileSystemTree;
  /** Install step. Default `["npm", "install"]`; pass `false` to skip. */
  install?: string | string[] | false;
  /** Command to run after install, e.g. `["npm", "run", "dev"]` or `"npm run dev"`. */
  run?: string | string[];
  /** Called once the instance is booted and files are mounted. */
  onReady?: (vivari: VivariInstance) => void;
  /** Called when a server starts listening inside the VM (the raw kernel event). */
  onServerReady?: (port: number, url: string) => void;
  /** Called for each stdout/stderr chunk of the install + run commands. */
  onOutput?: (chunk: string) => void;
  /** Called for every failure, at any phase. Nothing is swallowed. */
  onError?: (failure: VivariFailure) => void;
  /** Render the preview `<iframe>`. Default `true`. */
  showPreview?: boolean;
  /** Preview a specific port instead of the first one that listens. */
  previewPort?: number;
  /** Path within the previewed server. Default `/`. */
  previewPath?: string;
  /** Shown while booting / installing / before a preview URL exists. */
  fallback?: ReactNode;
  /** Replace the built-in failure UI. */
  renderError?: (failure: VivariFailure) => ReactNode;
  /** Take over rendering. A function receives the live boot state. */
  children?: ReactNode | ((state: UseVivariResult) => ReactNode);
}

const DEFAULT_INSTALL = ["npm", "install"];

// Whitespace-split; prefer the array form for anything containing quotes.
function toCommand(cmd: string | string[]): [string, string[]] {
  const parts = Array.isArray(cmd) ? cmd : cmd.trim().split(/\s+/);
  return [parts[0], parts.slice(1)];
}

function FailureNotice({
  failure,
  className,
  style,
}: {
  failure: VivariFailure;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={className} style={style} role="alert">
      {failure.phase === "unsupported" ? (
        <>
          <p>{failure.error.message}</p>
          <pre>
            Cross-Origin-Opener-Policy: same-origin{"\n"}
            Cross-Origin-Embedder-Policy: require-corp
          </pre>
        </>
      ) : (
        <p>
          Vivari failed during {failure.phase}: {failure.error.message}
        </p>
      )}
    </div>
  );
}

/**
 * Boots Vivari, mounts `files`, runs `install` then `run`, and renders the
 * resulting dev-server preview in an `<iframe>`.
 *
 *   <Vivari files={tree} run="npm run dev" style={{ height: 480 }} />
 *
 * The host page must be cross-origin isolated (COOP + COEP).
 */
export const Vivari = forwardRef<HTMLIFrameElement, VivariProps>(function Vivari(props, ref) {
  const {
    boot,
    instanceKey,
    autoBoot,
    files,
    install = DEFAULT_INSTALL,
    run,
    onReady,
    onServerReady,
    onOutput,
    onError,
    showPreview = true,
    previewPort,
    previewPath,
    fallback,
    renderError,
    children,
    ...iframeProps
  } = props;

  // Join an enclosing provider's kernel rather than booting a second one.
  const parent = useVivariContext({ optional: true });
  const state = useVivari({
    ...boot,
    instanceKey: instanceKey ?? parent?.instanceKey,
    autoBoot,
  });
  const { vivari } = state;
  const [runFailure, setRunFailure] = useState<VivariFailure | null>(null);

  // Latest callbacks without re-triggering the orchestration effect. In an effect,
  // not the render body: a render can be started and thrown away, and a ref write
  // during it is not undone. Declared first so it is current before that effect.
  const cbs = useRef({ onReady, onServerReady, onOutput, onError });
  useEffect(() => {
    cbs.current = { onReady, onServerReady, onOutput, onError };
  });

  // Keyed on the instance, not a boolean, so restart() re-orchestrates.
  const orchestratedFor = useRef<VivariInstance | null>(null);

  useEffect(() => {
    if (!vivari || orchestratedFor.current === vivari) return;
    orchestratedFor.current = vivari;
    setRunFailure(null);

    let disposed = false;
    const procs = new Set<VivariProcess>();

    const fail = (error: unknown, phase: "mount" | "install" | "run") => {
      if (disposed) return;
      const e = error instanceof Error ? error : new Error(String(error));
      const failure: VivariFailure = { phase, error: e };
      setRunFailure(failure);
      cbs.current.onError?.(failure);
    };

    const offServer = vivari.on("server-ready", (port, url) => {
      if (!disposed) cbs.current.onServerReady?.(port, url);
    });

    const pump = (proc: VivariProcess) =>
      proc.output
        .pipeTo(new WritableStream({ write: (chunk) => cbs.current.onOutput?.(chunk) }))
        .catch(() => {
          /* cancelled by kill() on unmount; not a failure */
        });

    const spawn = async (cmd: string | string[], phase: "install" | "run") => {
      const [bin, args] = toCommand(cmd);
      try {
        const proc = await vivari.spawn(bin, args);
        // Unmounted while the spawn was in flight — don't leak the process.
        if (disposed) {
          proc.kill();
          return null;
        }
        procs.add(proc);
        void pump(proc);
        return proc;
      } catch (e) {
        fail(e, phase);
        return null;
      }
    };

    void (async () => {
      try {
        if (files) await vivari.mount(files);
      } catch (e) {
        return fail(e, "mount");
      }
      if (disposed) return;
      cbs.current.onReady?.(vivari);

      if (install !== false) {
        const proc = await spawn(install, "install");
        if (!proc) return;
        const code = await proc.exit;
        if (disposed) return;
        if (code !== 0) {
          const [bin, args] = toCommand(install);
          return fail(
            new Error(`\`${[bin, ...args].join(" ")}\` exited with code ${code}`),
            "install",
          );
        }
      }

      if (run && !disposed) await spawn(run, "run");
    })();

    return () => {
      disposed = true;
      offServer();
      // An unmounted embed must not leave `npm run dev` running inside a VM
      // nobody is watching — the instance may be shared and outlive this tree.
      for (const p of procs) p.kill();
      procs.clear();
    };
    // `files`/`install`/`run` are read once per instance; change them by
    // restarting or remounting with a new `instanceKey`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vivari]);

  // `fallback` is the *pending* slot only. Routing failures through it is what
  // made a non-isolated page render "Booting…" forever with the actionable
  // COOP/COEP message discarded.
  const failure: VivariFailure | null =
    state.status === "unsupported"
      ? { phase: "unsupported", error: state.error, reason: state.reason }
      : state.status === "error"
        ? { phase: "boot", error: state.error }
        : runFailure;

  if (failure) {
    return (
      <>
        {renderError ? (
          renderError(failure)
        ) : (
          <FailureNotice
            failure={failure}
            className={iframeProps.className}
            style={iframeProps.style}
          />
        )}
      </>
    );
  }
  if (children !== undefined) {
    return <>{typeof children === "function" ? children(state) : children}</>;
  }
  if (!showPreview) return null;
  return (
    <VivariPreview
      {...iframeProps}
      ref={ref}
      port={previewPort}
      path={previewPath}
      fallback={fallback}
    />
  );
});