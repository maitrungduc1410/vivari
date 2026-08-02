"use client";

// The preview <iframe> for an in-VM server, as a standalone component.
//
// It exists because this used to be fused into the monolithic <Vivari> widget,
// unreachable to anyone composing their own layout — so the studio had to
// reimplement the same HMR wiring in packages/studio/src/vv/controller.ts.
//
// Both halves of the hard part now live in core: `server-ready` fires off the
// kernel's `serving` probe (not the raw `listen`, which a dev server emits
// several times while it rebinds), and `attachPreview()` owns the inbound
// WebSocket/SSE tunnel that Vite's HMR client needs. This component is the React
// lifecycle around them.

import {
  forwardRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type IframeHTMLAttributes,
  type ReactNode,
} from "react";
import type { Vivari as VivariInstance } from "@vivari/core";
import { useVivariInstance } from "./context";

export interface VivariPreviewProps
  extends Omit<IframeHTMLAttributes<HTMLIFrameElement>, "src" | "children"> {
  /** The in-VM port to show. Omit to follow the first server that starts serving. */
  port?: number;
  /** Path within the dev server. Default `/`. */
  path?: string;
  /** Act on this instance instead of the nearest `<VivariProvider>`'s. */
  vivari?: VivariInstance | null;
  /** Change this to reload the frame (a "Reload preview" button). */
  reloadKey?: string | number;
  /** Fired each time the frame is pointed at a serving URL. */
  onServerReady?: (port: number, url: string) => void;
  /** Rendered until the first server is serving. */
  fallback?: ReactNode;
}

/** The URL to show, plus a counter that makes a repeat of the same URL reload. */
interface Target {
  port: number;
  url: string;
  nonce: number;
}

/**
 * Render an in-VM server's preview.
 *
 *   <VivariPreview port={5173} style={{ width: "100%", height: 480, border: 0 }} />
 *
 * Waits for `server-ready`, so a component mounted before the server starts just
 * shows `fallback` until it does. One mounted *after* a server started won't see
 * that event — give it a `reloadKey` bump, or keep it mounted.
 */
export const VivariPreview = forwardRef<HTMLIFrameElement, VivariPreviewProps>(
  function VivariPreview(
    { port, path = "/", vivari: explicit, reloadKey, onServerReady, fallback, ...iframeProps },
    forwardedRef,
  ) {
    const instance = useVivariInstance(explicit);
    const [target, setTarget] = useState<Target | null>(null);
    // The element in state, not a ref: attachPreview needs the real node, and an
    // effect keyed on it re-attaches correctly if React ever swaps the frame.
    const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);

    const cbs = useRef({ onServerReady });
    useEffect(() => {
      cbs.current = { onServerReady };
    });

    const attachRef = useCallback(
      (el: HTMLIFrameElement | null) => {
        setFrame(el);
        if (typeof forwardedRef === "function") forwardedRef(el);
        else if (forwardedRef) forwardedRef.current = el;
      },
      [forwardedRef],
    );

    useEffect(() => {
      if (!instance) return;
      // Every `server-ready` re-points, so a dev server that dies and restarts
      // reconnects instead of being ignored forever by a one-shot latch.
      return instance.on("server-ready", (p, url) => {
        if (port != null && p !== port) return;
        setTarget((prev) => ({
          port: p,
          url: path === "/" ? url : instance.previewUrl(p, path),
          nonce: (prev?.nonce ?? 0) + 1,
        }));
      });
    }, [instance, port, path]);

    // Inbound HMR/SSE frames, delivered into this iframe's shim. Without it Vite
    // HMR stays stuck at "[vite] connecting…".
    useEffect(() => {
      if (!instance || !frame) return;
      return instance.attachPreview(frame);
    }, [instance, frame]);

    // Navigate imperatively rather than through the `src` prop, for two reasons:
    // a restart yields the same URL (React would see no change and not reload),
    // and the preview Service Worker reliably intercepts a navigation from an
    // existing about:blank client but not always an iframe whose very first
    // navigation is a direct in-scope URL. The studio's PreviewFrame does the same.
    useEffect(() => {
      if (!frame || !target) return;
      frame.src = target.url;
      cbs.current.onServerReady?.(target.port, target.url);
    }, [frame, target, reloadKey]);

    if (!target) return <>{fallback}</>;
    return (
      <iframe
        {...iframeProps}
        ref={attachRef}
        title={iframeProps.title ?? "Vivari preview"}
        allow={iframeProps.allow ?? "cross-origin-isolated"}
        // Matches the studio's preview frame: guest code is untrusted, but it
        // needs same-origin to reach the Service Worker proxy that serves it.
        // Override `sandbox` if your guests are more hostile than your own code.
        sandbox={
          iframeProps.sandbox ??
          "allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
        }
      />
    );
  },
);