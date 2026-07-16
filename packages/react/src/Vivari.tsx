import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { BootOptions, FileSystemTree, Vivari as VivariInstance } from "@vivari/core";
import { useVivari, type VivariStatus } from "./useVivari";

export interface VivariProps extends BootOptions {
  /** Files to mount into the VM before running commands. */
  files?: FileSystemTree;
  /** Install step. Default `["npm", "install"]`; pass `false` to skip. */
  install?: string | string[] | false;
  /** Command to run after install, e.g. `["npm", "run", "dev"]` or `"npm run dev"`. */
  run?: string | string[];
  /** Called once the instance is booted and files are mounted. */
  onReady?: (vivari: VivariInstance) => void;
  /** Called when an in-VM server starts listening; `url` is the preview URL. */
  onServerReady?: (port: number, url: string) => void;
  /** Called for each stdout/stderr chunk of the install + run commands. */
  onOutput?: (chunk: string) => void;
  /** Render the preview <iframe> when a server is ready. Default `true`. */
  showPreview?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Shown while booting / before a preview URL exists. */
  fallback?: ReactNode;
}

function toCommand(cmd: string | string[]): [string, string[]] {
  const parts = Array.isArray(cmd) ? cmd : cmd.trim().split(/\s+/);
  return [parts[0], parts.slice(1)];
}

/**
 * Drop-in embed: boots Vivari, mounts `files`, runs `install` then `run`, and
 * renders the resulting dev-server preview in an <iframe>.
 *
 *   <Vivari files={tree} run="npm run dev" style={{ height: 480 }} />
 *
 * The host page must be cross-origin isolated (COOP + COEP).
 */
export function Vivari(props: VivariProps): ReactNode {
  const {
    files,
    install = ["npm", "install"],
    run,
    onReady,
    onServerReady,
    onOutput,
    showPreview = true,
    className,
    style,
    fallback,
    ...bootOptions
  } = props;

  const { vivari, status, error } = useVivari(bootOptions);
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  // Latest callbacks without re-triggering the orchestration effect.
  const cbs = useRef({ onReady, onServerReady, onOutput });
  cbs.current = { onReady, onServerReady, onOutput };
  const startedRef = useRef(false);

  useEffect(() => {
    if (!vivari || startedRef.current) return;
    startedRef.current = true;
    let disposed = false;

    const offServer = vivari.on("server-ready", (port, url) => {
      if (disposed) return;
      setPreviewSrc(url);
      cbs.current.onServerReady?.(port, url);
    });

    const pump = (proc: { output: ReadableStream<string> }) =>
      proc.output.pipeTo(
        new WritableStream({
          write: (chunk) => cbs.current.onOutput?.(chunk),
        }),
      ).catch(() => {});

    (async () => {
      if (files) await vivari.mount(files);
      cbs.current.onReady?.(vivari);
      if (install !== false) {
        const [cmd, args] = toCommand(install);
        const proc = await vivari.spawn(cmd, args);
        void pump(proc);
        const code = await proc.exit;
        if (code !== 0 || disposed) return;
      }
      if (run) {
        const [cmd, args] = toCommand(run);
        const proc = await vivari.spawn(cmd, args);
        void pump(proc);
      }
    })().catch(() => {});

    return () => {
      disposed = true;
      offServer();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vivari]);

  if (status === "error") {
    return fallback ?? <div className={className} style={style}>Vivari failed to boot: {error?.message}</div>;
  }
  if (!showPreview) return null;
  if (!previewSrc) {
    return (fallback as ReactNode) ?? null;
  }
  return (
    <iframe
      src={previewSrc}
      className={className}
      style={style}
      title="Vivari preview"
      allow="cross-origin-isolated"
    />
  );
}

export type { VivariStatus };
