/// <reference types="vite/client" />
/// <reference types="unplugin-icons/types/react" />

interface ImportMetaEnv {
  /**
   * Mode B (separate preview origin). When set to another origin (e.g.
   * `https://vivari-preview.pages.dev`), previews are served from there for
   * IDE↔preview isolation. Unset in the default same-origin deploy + local dev.
   */
  readonly VITE_PREVIEW_ORIGIN?: string;
  /**
   * How "Open in new tab" behaves in mode B (see BootOptions.previewPopout).
   * `"same-origin"` (default) opens the pop-out on the IDE origin (frictionless,
   * not isolated); `"isolated"` opens it on the preview origin behind a one-time
   * Storage Access gate. Unset/ignored in the default same-origin deploy.
   */
  readonly VITE_PREVIEW_POPOUT?: "same-origin" | "isolated";
  /**
   * Mode C (wildcard per-port preview origins). Set to a **base domain** you
   * control (e.g. `"jamesisme.com"`); each in-VM port is served from its own
   * origin `<token>--<port>-vv.<domain>` for full IDE↔preview and preview↔preview
   * isolation with real `localhost:<port>` semantics. Takes precedence over
   * VITE_PREVIEW_ORIGIN. Requires the wildcard Worker + DNS (see docs/deployment).
   * Unset in the default deploy + local dev.
   */
  readonly VITE_PREVIEW_WILDCARD_DOMAIN?: string;
}