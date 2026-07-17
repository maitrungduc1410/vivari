// Type declarations for tar.js. Keep in sync with the exports there.

export interface TarEntry {
  name: string;
  bytes: Uint8Array;
}

/** Parse a (gunzipped) tar buffer into its regular-file entries. */
export function parseTar(input: Uint8Array | ArrayBufferLike): TarEntry[];

/** Drop the leading path segment (npm `package/` / GitHub `<repo>-<ref>/`). */
export function stripFirstSegment(name: string): string;
