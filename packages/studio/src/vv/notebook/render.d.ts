// Plain JavaScript so scripts/spike-notebook.mjs can enumerate the output policy
// rather than trust a description of it; `allowJs` is off here, so tsc needs this.

import type { MimeBundle } from "./ipynb.js";

export declare const MIME_ORDER: string[];
export declare const ALLOWED_TAGS: Set<string>;
export declare const ALLOWED_ATTRS: Set<string>;
export declare const URL_ATTRS: Set<string>;
export declare const RAW_TEXT_TAGS: Set<string>;
export declare const OPAQUE_TAGS: Set<string>;

/** What `chooseRender` decided to draw. `kind` is exhaustive by construction: it
 *  never describes something with no content in it — see render.js, which says
 *  where that stops being decidable. */
export type Rendered =
  | { kind: "image"; mime: string; src: string }
  | { kind: "html"; mime: string; html: string }
  | { kind: "markdown"; mime: string; html: string }
  | { kind: "json"; mime: string; value: unknown }
  | { kind: "text"; mime: string; text: string }
  | { kind: "notice"; mime: null; text: string };

export declare function chooseRender(data: MimeBundle | null | undefined): Rendered | null;
export declare function mimeCandidates(data: MimeBundle | null | undefined): string[];
export declare function asText(value: unknown): string;
export declare function svgDataUrl(svg: unknown): string | null;
export declare function pickMime(data: MimeBundle | null | undefined): string | null;
export declare function stripAnsi(s: string): string;
export declare function escapeHtml(s: string): string;
export declare function isSafeUrl(value: string): boolean;
export declare function isAllowedAttr(tag: string, name: string, value: string): boolean;
export declare function isAllowedTag(tag: string): boolean;
/** Browser-only: uses DOMParser, which is the only parser that agrees with the
 *  one that will render the result. Falls back to escaping everything elsewhere. */
export declare function sanitizeHtml(html: string): string;
export declare function renderMarkdown(src: string): string;
