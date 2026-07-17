// Remote project sources (P2): import a public GitHub repo or an npm package as
// a new project — fully client-side, no backend/proxy.
//
// The studio page is cross-origin-isolated (COEP require-corp). A cors-mode
// fetch() is readable and satisfies COEP when the response sends
// `Access-Control-Allow-Origin: *`, which all the hosts below do:
//   - npm:    registry.npmjs.org (packument + dist.tarball)
//   - GitHub: api.github.com (repo info + git trees) + raw.githubusercontent.com
// So we fetch them directly from the main thread; the in-VM Fetcher Worker is
// not involved.

import { gunzip } from "../../../kernel-host/archive.js";
import { parseTar, stripFirstSegment } from "../../../kernel-host/tar.js";
import type { FileTree, ImportTree } from "./controller";

export type RemoteTree = ImportTree & { truncated?: boolean };
export type ProgressFn = (done: number, total: number, phase: string) => void;

// Bounds so a huge repo can't wedge the tab; surfaced as a "truncated" warning.
const MAX_FILES = 2000;
const MAX_BYTES = 50 * 1024 * 1024;
const CONCURRENCY = 12;

const NPM_REGISTRY = "https://registry.npmjs.org";
const GH_API = "https://api.github.com";
const GH_RAW = "https://raw.githubusercontent.com";

const isNodeModules = (p: string) => p.split("/").some((s) => s === "node_modules");
const isGit = (p: string) => p.split("/").some((s) => s === ".git");
const encPath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

// Run `fn` over `items` with bounded concurrency, preserving order.
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) break;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 0 }, worker));
  return out;
}

// ── GitHub ──────────────────────────────────────────────────────────────────
export function parseGithubSpec(input: string): { owner: string; repo: string; ref?: string } | null {
  let s = input.trim();
  if (!s) return null;
  let ref: string | undefined;
  // Full URL: https://github.com/owner/repo(/tree/ref)?(.git)?
  const urlMatch = s.match(/github\.com[/:]([^/]+)\/([^/#?]+)(?:\/tree\/([^/#?]+))?/i);
  if (urlMatch) {
    const owner = urlMatch[1];
    const repo = urlMatch[2].replace(/\.git$/, "");
    return { owner, repo, ref: urlMatch[3] };
  }
  // Shorthand: owner/repo, owner/repo@ref, owner/repo#branch
  const hashOrAt = s.match(/[@#]/);
  if (hashOrAt) {
    ref = s.slice(hashOrAt.index! + 1) || undefined;
    s = s.slice(0, hashOrAt.index!);
  }
  const parts = s.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[0], repo: parts[1].replace(/\.git$/, ""), ref };
}

async function ghJson(url: string): Promise<Response> {
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (res.status === 404) throw new Error("Repository not found (it may be private or misspelled).");
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0") {
    throw new Error("GitHub API rate limit reached — please try again later.");
  }
  if (!res.ok) throw new Error(`GitHub request failed (HTTP ${res.status}).`);
  return res;
}

export async function fetchGithubRepo(
  spec: { owner: string; repo: string; ref?: string },
  onProgress?: ProgressFn,
): Promise<RemoteTree> {
  const { owner, repo } = spec;
  let ref = spec.ref;
  onProgress?.(0, 0, "Resolving repository…");
  if (!ref) {
    const info = await (await ghJson(`${GH_API}/repos/${owner}/${repo}`)).json();
    ref = info.default_branch || "main";
  }
  onProgress?.(0, 0, "Fetching file list…");
  const tree = await (await ghJson(`${GH_API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref!)}?recursive=1`)).json();
  const nodes: { type: string; path: string; size?: number }[] = tree.tree || [];
  const excludedNodeModules = nodes.some((n) => isNodeModules(n.path));

  // Keep regular files (git-tree entries carry `size`), applying the count/byte caps.
  let bytes = 0;
  let truncated = !!tree.truncated;
  const kept: { path: string }[] = [];
  for (const n of nodes) {
    if (n.type !== "blob" || isNodeModules(n.path) || isGit(n.path)) continue;
    if (kept.length >= MAX_FILES || bytes + (n.size || 0) > MAX_BYTES) { truncated = true; continue; }
    bytes += n.size || 0;
    kept.push({ path: n.path });
  }

  if (!kept.length) throw new Error("That repository has no importable files.");

  let done = 0;
  const total = kept.length;
  onProgress?.(0, total, "Downloading files…");
  const files: FileTree = await mapPool(kept, CONCURRENCY, async (b) => {
    const res = await fetch(`${GH_RAW}/${owner}/${repo}/${encodeURIComponent(ref!)}/${encPath(b.path)}`);
    if (!res.ok) throw new Error(`Failed to download ${b.path} (HTTP ${res.status}).`);
    const buf = new Uint8Array(await res.arrayBuffer());
    onProgress?.(++done, total, "Downloading files…");
    return { path: b.path, bytes: buf };
  });

  return { name: repo, files, excludedNodeModules, truncated };
}

// ── npm ─────────────────────────────────────────────────────────────────────
export function parseNpmSpec(input: string): { name: string; version?: string } | null {
  const s = input.trim().replace(/^npm:/, "");
  if (!s) return null;
  // Scoped: @scope/name(@version); unscoped: name(@version)
  const scoped = s.startsWith("@");
  const at = s.indexOf("@", scoped ? 1 : 0);
  if (at > 0) return { name: s.slice(0, at), version: s.slice(at + 1) || undefined };
  return { name: s };
}

export async function fetchNpmPackage(
  spec: { name: string; version?: string },
  onProgress?: ProgressFn,
): Promise<RemoteTree> {
  const { name } = spec;
  onProgress?.(0, 0, "Resolving package…");
  const metaRes = await fetch(`${NPM_REGISTRY}/${name}`);
  if (metaRes.status === 404) throw new Error(`Package "${name}" not found on npm.`);
  if (!metaRes.ok) throw new Error(`npm request failed (HTTP ${metaRes.status}).`);
  const meta = await metaRes.json();
  const tags = meta["dist-tags"] || {};
  const versions = meta.versions || {};
  let version = spec.version;
  if (!version) version = tags.latest;
  else if (tags[version]) version = tags[version]; // a dist-tag like "next"
  else if (!versions[version]) version = tags.latest; // unknown/range → latest (no semver-range resolution)
  const v = version && versions[version];
  const tarball = v && v.dist && v.dist.tarball;
  if (!tarball) throw new Error(`Could not resolve a version for "${name}".`);

  onProgress?.(0, 0, "Downloading tarball…");
  const tgzRes = await fetch(tarball);
  if (!tgzRes.ok) throw new Error(`Failed to download tarball (HTTP ${tgzRes.status}).`);
  const gz = new Uint8Array(await tgzRes.arrayBuffer());

  onProgress?.(0, 0, "Unpacking…");
  const tar = await gunzip(gz);
  let excludedNodeModules = false;
  const files: FileTree = [];
  let bytes = 0;
  let truncated = false;
  for (const entry of parseTar(tar)) {
    const rel = stripFirstSegment(entry.name);
    if (!rel) continue;
    if (isNodeModules(rel)) { excludedNodeModules = true; continue; }
    if (isGit(rel)) continue;
    if (files.length >= MAX_FILES || bytes + entry.bytes.byteLength > MAX_BYTES) { truncated = true; continue; }
    bytes += entry.bytes.byteLength;
    files.push({ path: rel, bytes: entry.bytes });
  }
  if (!files.length) throw new Error(`Package "${name}" contained no importable files.`);

  const safeName = (version ? `${name}-${version}` : name).replace(/^@/, "").replace(/\//g, "-");
  return { name: safeName, files, excludedNodeModules, truncated };
}
