// Type declarations for archive.js (import/export/share codecs). Keep in sync
// with the exports in archive.js.

export interface ArchiveFile {
  path: string;
  bytes: Uint8Array;
}

export function crc32(bytes: Uint8Array | ArrayBufferLike): number;
export function deflateRaw(bytes: Uint8Array): Promise<Uint8Array>;
export function inflateRaw(bytes: Uint8Array): Promise<Uint8Array>;
export function gzip(bytes: Uint8Array): Promise<Uint8Array>;
export function gunzip(bytes: Uint8Array): Promise<Uint8Array>;

/** Build a PKZIP archive (DEFLATE, with STORE fallback) from a flat file tree. */
export function createZip(files: ArchiveFile[]): Promise<Uint8Array>;

/** Encode a project's source into a base64url, gzipped shareable-URL payload. */
export function encodeShare(project: { name: string; files: ArchiveFile[] }): Promise<string>;

/** Decode a shareable-URL payload back into a project tree. */
export function decodeShare(payload: string): Promise<{ name: string; files: ArchiveFile[] }>;
