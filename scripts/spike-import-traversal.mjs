// Spike (OFFLINE): every import vector must refuse a path that escapes the
// project root — and must NOT refuse an ordinary archive.
//
// Import sources are untrusted: an npm tarball, a GitHub tree, a `#share=`
// link. Every layer below the entry parsers joins the entry path onto the
// project dir verbatim, and the Rust VFS resolves `..` the way a filesystem
// must — which is correct for a VFS and is precisely why the missing
// sanitisation upstream of it was a hole: a crafted entry overwrote another
// project or a dotfile in the persisted VM under an "imported N files" success
// message. Real bsdtar refuses the same bytes (`Path contains '..'`), and so
// does node-tar, the library real npm uses. dep-cache.js has enforced exactly
// this on its own archives all along, with a comment naming the risk.
//
// The predicate NORMALIZES instead of blindly refusing: `tar czf x.tgz .`
// writes a `./` in front of every entry it creates, so `.` and empty segments
// are folded away and only `..`, absolute paths, and drive letters are refused
// — refused outright rather than popped, because popping would import a
// DIFFERENT file than the archive names, under the same success message.
//
// The share codec runs live; the studio importer and the vv-import-tree
// handler live in browser-worker modules (wasm + Worker at import time), so
// those two are read as source, the same way spike-python-offline pins the
// launcher wiring.
//
//   run:  node scripts/spike-import-traversal.mjs

import fs from "node:fs";
import * as archive from "../packages/kernel-host/archive.js";

// Looked up rather than destructured, so a tree WITHOUT the guard reports every
// assertion as red instead of dying on the import — which is what makes running
// this spike against the unfixed tree a meaningful negative control.
const { encodeShare, decodeShare } = archive;
const safeEntryPath = typeof archive.safeEntryPath === "function" ? archive.safeEntryPath : () => "GUARD-MISSING";

let failed = 0;
const ok = (cond, msg, detail) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) {
    failed++;
    if (detail) console.log("      " + String(detail).slice(0, 200));
  }
};
const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");

// ── the predicate ────────────────────────────────────────────────────────────
console.log("safeEntryPath — normalizes what is harmless, refuses what escapes");
const cases = [
  ["src/main.js", "src/main.js", "an ordinary path is untouched"],
  ["./src/main.js", "src/main.js", "the `./` that `tar czf x.tgz .` writes in front of every entry"],
  ["src/./main.js", "src/main.js", "a `.` in the middle"],
  ["./././a.txt", "a.txt", "several `.` in a row"],
  ["src//main.js", "src/main.js", "an empty segment from a doubled slash"],
  [".gitignore", ".gitignore", "a dot-leading NAME is not a dot segment"],
  ["../etc/passwd", null, "`..` at the start is refused"],
  ["src/../../etc/passwd", null, "`..` in the middle is refused"],
  ["src\\..\\..\\x", null, "`..` behind Windows separators is refused"],
  ["/etc/passwd", null, "an absolute path is refused"],
  ["\\etc\\passwd", null, "a Windows-shaped absolute path is refused"],
  ["C:/Windows/x", null, "a drive letter is refused"],
  [".", null, "a path that is empty after normalization is refused"],
  ["", null, "the empty path is refused"],
];
for (const [input, expected, why] of cases) {
  const got = safeEntryPath(input);
  ok(got === expected, `${why} — ${JSON.stringify(input)} -> ${JSON.stringify(got)}`);
}

// ── the share codec, live ────────────────────────────────────────────────────
console.log("the #share= payload — the vector a user is handed as a link");
{
  const share = await encodeShare({
    name: "p",
    files: [
      { path: "./src/main.js", bytes: new TextEncoder().encode("ok") },
      { path: "readme.md", bytes: new TextEncoder().encode("hi") },
    ],
  });
  const back = await decodeShare(share);
  ok(
    back.files.map((f) => f.path).join(",") === "src/main.js,readme.md",
    `a ./-prefixed entry survives the codec normalized — ${back.files.map((f) => f.path).join(",")}`,
  );
}
{
  let refused = "no throw";
  try {
    await decodeShare(await encodeShare({ name: "p", files: [{ path: "../victim.txt", bytes: new Uint8Array(1) }] }));
  } catch (e) {
    refused = String(e.message);
  }
  ok(refused.includes("escapes the project root"), `a ..-entry is refused by the codec — ${refused.slice(0, 60)}`);
}

// ── the two browser-worker consumers, read as source ─────────────────────────
console.log("the importer and the mount() handler apply the same guard");
{
  const src = read("packages/studio/src/vv/import-remote.ts");
  ok(/const safeEntryPath/.test(src), "import-remote.ts carries the predicate");
  ok(/safeEntryPath\(n\.path\)/.test(src), "…applies it to every GitHub tree entry");
  ok(
    /safeEntryPath\(entry\.name\)[\s\S]{0,400}stripFirstSegment\(norm\)/.test(src),
    "…and normalizes a tarball entry BEFORE stripping its package/ prefix, so `./package/x` cannot keep the prefix stripping exists to remove",
  );
}
{
  const src = read("packages/core/src/workers/kernel-worker.ts");
  const start = src.indexOf('m.type === "vv-import-tree"');
  const handler = start < 0 ? "" : src.slice(start, start + 1800);
  ok(start >= 0, "kernel-worker.ts still has the vv-import-tree handler");
  ok(/safeEntryPath/.test(handler), "vv-import-tree guards its incoming paths (the mount() SDK path)");
  ok(
    /dirs[\s\S]{0,400}inside\(|inside\([\s\S]{0,400}mkdirp/.test(handler),
    "…including the explicit `dirs` list, which is joined the same way",
  );
}

console.log(failed ? `\nFAIL: ${failed} check(s)` : "\nOK: every import vector refuses escape and admits ordinary archives");
process.exit(failed ? 1 : 0);
