/// <reference types="vite/client" />
/// <reference types="unplugin-icons/types/react" />

interface ImportMetaEnv {
  /**
   * Mode B (separate preview origin). When set to another origin (e.g.
   * `https://vivari-preview.pages.dev`), previews are served from there for
   * IDE↔preview isolation. Unset in the default same-origin deploy + local dev.
   */
  readonly VITE_PREVIEW_ORIGIN?: string;
}