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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the in-VM dev server at `url` is actually serving, then warm it, so
 * the preview iframe loads a working (and already-optimized) page.
 *
 * Why: a dev server (Vite/rolldown) binds -> closes -> rebinds its port several
 * times during startup, so the first `listen` event is transient. Pointing the
 * iframe there immediately races that window and the Service Worker preview proxy
 * returns `502 No server listening on port N`. This mirrors the studio's
 * kernel-side `waitServing` + `warmDevServer`, but over the same SW proxy the
 * iframe uses (so it needs no extra kernel API). Best-effort throughout: any
 * failure just falls through so the iframe still gets a chance to load.
 */
async function waitForPreview(url: string, timeoutMs = 60000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // 1) Poll until the server answers with something other than the proxy's
  //    "no listener yet" / gateway statuses (Vite rebinds during boot).
  for (;;) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.status !== 502 && res.status !== 503 && res.status !== 504) break;
    } catch {
      /* not answering yet */
    }
    if (Date.now() > deadline) return;
    await sleep(150);
  }
  // 2) Warm the dependency optimizer: fetch the entry module scripts (+ Vite's
  //    client) so the cold optimize completes BEFORE the iframe requests them —
  //    otherwise those subresources can race the SW's per-request timeout on a
  //    cold `.vite` cache and 504.
  try {
    const res = await fetch(url, { cache: "no-store" });
    const html = await res.text();
    const mods = new Set<string>(["/@vite/client"]);
    const re = /<script[^>]*type=["']module["'][^>]*src=["']([^"']+)["']/gi;
    for (let m; (m = re.exec(html)); ) if (m[1].startsWith("/")) mods.add(m[1]);
    const origin = new URL(url).origin;
    const base = url.replace(origin, "").replace(/\/$/, ""); // e.g. /preview/5173
    await Promise.all(
      [...mods].map((p) =>
        fetch(origin + base + p, { cache: "no-store" }).catch(() => {}),
      ),
    );
  } catch {
    /* warm is best-effort; the iframe will still load */
  }
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
  // Guards the preview against the dev server's transient boot re-binds: only the
  // first listened port drives the iframe, and only after it's really serving.
  const previewStartedRef = useRef(false);
  // The preview <iframe>; inbound HMR/SSE frames are delivered to its shim.
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    if (!vivari || startedRef.current) return;
    startedRef.current = true;
    let disposed = false;

    // Inbound half of the HMR/SSE tunnel. The preview's WS/SSE shim posts OUTbound
    // frames to this window (the bridge forwards them to the kernel); the kernel's
    // INbound frames arrive here as vv-ws/vv-sse and must be delivered back to the
    // iframe's shim, or Vite HMR stays stuck at "[vite] connecting…". The frame
    // carries no port, so we deliver to our single iframe; the shim ignores frames
    // for connIds it doesn't own. (The studio does the same in its controller.)
    const relay = (type: "vv-ws" | "vv-sse") =>
      vivari.bridge.on(type, (m) => {
        const win = frameRef.current?.contentWindow;
        const msg = (m as { msg?: Record<string, unknown> }).msg;
        if (win && msg) win.postMessage({ ...msg, type, dir: "in" }, "*");
      });
    const offWs = relay("vv-ws");
    const offSse = relay("vv-sse");

    const offServer = vivari.on("server-ready", (port, url) => {
      // A dev server rebinds its port a few times during boot, firing several
      // `listen` events; act on the first and only after it's actually serving,
      // so the iframe never loads into a momentarily-closed port (502).
      if (disposed || previewStartedRef.current) return;
      previewStartedRef.current = true;
      void waitForPreview(url).then(() => {
        if (disposed) return;
        setPreviewSrc(url);
        cbs.current.onServerReady?.(port, url);
      });
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
      offWs();
      offSse();
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
      ref={frameRef}
      src={previewSrc}
      className={className}
      style={style}
      title="Vivari preview"
      allow="cross-origin-isolated"
    />
  );
}

export type { VivariStatus };
